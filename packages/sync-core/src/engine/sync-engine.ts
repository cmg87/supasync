import { encode, unencode } from "@supasync/crypto";
import {
  DEFAULT_LIMITS,
  ProtocolError,
  canonicalizePath,
  createEnvelope,
  hashBytes,
  hashMarkdown,
  isMarkdownPath,
  seqZero,
  type CommitEnvelope,
  type RevisionRecord,
} from "@supasync/protocol";
import { isExcluded } from "../exclusions.ts";
import { mergeMarkdown } from "../merge/three-way.ts";
import { conflictCopyPath } from "../reconcile/conflict-path.ts";
import type {
  LocalStore,
  ManifestRow,
  SyncApi,
  VaultAdapter,
} from "../types.ts";

export type EngineOptions = {
  api: SyncApi;
  vault: VaultAdapter;
  store: LocalStore;
  vaultId: string;
  paused?: boolean;
  fetch?: typeof fetch;
};

export type SyncReport = {
  pulled: number;
  pushed: number;
  conflicts: number;
  applied: number;
  errors: string[];
};

export class SyncEngine {
  private paused: boolean;
  private expectedEcho = new Set<string>();

  constructor(private readonly opts: EngineOptions) {
    this.paused = opts.paused ?? false;
  }

  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }

  async cycle(): Promise<SyncReport> {
    const report: SyncReport = {
      pulled: 0,
      pushed: 0,
      conflicts: 0,
      applied: 0,
      errors: [],
    };
    if (this.paused) return report;
    await this.recoverIntents(report);
    const caps = await this.opts.api.capabilities(this.opts.vaultId);
    const meta = await this.opts.store.getMeta();
    meta.vaultId = this.opts.vaultId;
    if (meta.serverEpoch && meta.serverEpoch !== caps.serverEpoch) {
      report.errors.push("EPOCH_MISMATCH");
      return report;
    }
    meta.serverEpoch = caps.serverEpoch;
    await this.opts.store.putMeta(meta);

    if (meta.receivedCursor === seqZero() && meta.appliedCursor === seqZero()) {
      await this.bootstrapIfNeeded(caps.headSeq, report);
    }

    await this.captureLocalChanges(report);
    report.pulled += await this.pullAndApply(undefined, report);
    report.pushed += await this.pushOutbox(report);
    report.pulled += await this.pullAndApply(undefined, report);
    const latest = await this.opts.store.getMeta();
    if (latest.appliedCursor !== seqZero()) {
      await this.opts.api.ackApplied({
        vaultId: this.opts.vaultId,
        clientId: latest.clientId,
        clientGeneration: latest.generation,
        appliedSeq: latest.appliedCursor,
      });
    }
    return report;
  }

  private async bootstrapIfNeeded(
    headSeq: string,
    report: SyncReport,
  ): Promise<void> {
    const listed = await this.opts.vault.list();
    const localFiles = listed.filter(
      (row) =>
        row.kind === "file" &&
        !isExcluded(row.path, this.opts.vault.configDir()),
    );
    const snap = await this.opts.api.beginSnapshot({
      vaultId: this.opts.vaultId,
      clientId: (await this.opts.store.getMeta()).clientId,
      clientGeneration: (await this.opts.store.getMeta()).generation,
    });
    const page = {
      items: [] as Array<{ entryId: string; revision: RevisionRecord }>,
    };
    let cursor: string | undefined;
    for (;;) {
      const chunk = await this.opts.api.listSnapshot({
        snapshotId: snap.snapshotId,
        afterEntryId: cursor,
      });
      page.items.push(...chunk.items);
      if (chunk.exhausted) break;
      if (!chunk.nextCursor || chunk.nextCursor === cursor)
        throw new Error("Snapshot cursor did not advance");
      cursor = chunk.nextCursor;
    }
    page.items.sort(
      (a, b) =>
        a.revision.path.split("/").length - b.revision.path.split("/").length,
    );
    if (localFiles.length === 0) {
      for (const item of page.items) {
        await this.applyRevision(item.revision, report, true);
      }
    } else {
      for (const item of page.items) {
        const local = localFiles.find(
          (file) =>
            canonicalizePath(file.path).pathKey === item.revision.pathKey,
        );
        if (!local) {
          await this.applyRevision(item.revision, report, true);
          continue;
        }
        if (item.revision.kind === "markdown") {
          const text = await this.opts.vault.readText(local.path);
          const sha = await hashMarkdown(text);
          if (sha === item.revision.textSha256) {
            await this.remember(item.revision, sha);
          } else {
            await this.preserveConflict(item.revision, text, report);
          }
        } else if (item.revision.kind === "blob") {
          const bytes = await this.opts.vault.readBytes(local.path);
          if ((await hashBytes(bytes)) !== item.revision.textSha256)
            await this.preserveBinary(item.revision, bytes, report);
          await this.applyRevision(item.revision, report, true);
        }
      }
    }
    const meta = await this.opts.store.getMeta();
    meta.receivedCursor = snap.headSeq;
    meta.appliedCursor = snap.headSeq;
    await this.opts.store.putMeta(meta);
    void headSeq;
  }

  private async captureLocalChanges(report: SyncReport): Promise<void> {
    const listed = await this.opts.vault.list();
    const manifest = await this.opts.store.getManifest();
    const byPath = new Map(
      [...manifest.values()]
        .filter((row) => !row.deleted)
        .map((row) => [row.path, row]),
    );
    const pending = await this.opts.store.listOutbox();
    const pendingPaths = new Set(
      pending.map((p) => (p.envelope as CommitEnvelope).payload.path),
    );
    const pendingIds = new Set(
      pending.map((p) => (p.envelope as CommitEnvelope).entryId),
    );
    if (listed.length === 0) return; // An empty listing alone is never proof of deletion.
    for (const stat of listed.sort(
      (a, b) => a.path.split("/").length - b.path.split("/").length,
    )) {
      if (pendingPaths.has(stat.path)) continue;
      if (
        stat.kind === "folder" &&
        this.opts.api.readBlob &&
        !isExcluded(stat.path, this.opts.vault.configDir())
      ) {
        if (!byPath.has(stat.path)) {
          const meta = await this.opts.store.getMeta();
          const operationId = crypto.randomUUID();
          await this.opts.store.putOutbox({
            operationId,
            envelope: this.envelope(meta, {
              operationId,
              type: "create",
              entryId: crypto.randomUUID(),
              payload: { path: stat.path, kind: "folder" },
            }),
            extras: {},
            status: "queued",
            sentHash: null,
          });
        }
        continue;
      }
      if (
        stat.kind !== "file" ||
        isExcluded(stat.path, this.opts.vault.configDir())
      )
        continue;
      const limit = isMarkdownPath(stat.path)
        ? DEFAULT_LIMITS.maxTextBytes
        : DEFAULT_LIMITS.maxBlobBytes;
      if (stat.byteLength > limit) {
        report.errors.push(`File exceeds supported size limit: ${stat.path}`);
        continue;
      }
      const canon = canonicalizePath(stat.path);
      const row =
        byPath.get(canon.display) ??
        [...byPath.values()].find(
          (item) => canonicalizePath(item.path).pathKey === canon.pathKey,
        );
      if (row && pendingIds.has(row.entryId)) continue;
      if (!row) {
        await this.enqueueCreate(stat.path, report);
        continue;
      }
      if (isMarkdownPath(stat.path)) {
        const text = await this.opts.vault.readText(stat.path);
        const sha = await hashMarkdown(text);
        if (sha !== row.localHash) {
          await this.enqueueUpdate(row, text, sha);
        }
      } else {
        const bytes = await this.opts.vault.readBytes(stat.path);
        const sha = await hashBytes(bytes);
        if (sha !== row.localHash) {
          await this.enqueueBlobUpdate(row, bytes, sha);
        }
      }
    }
    for (const row of [...byPath.values()].sort(
      (a, b) => b.path.split("/").length - a.path.split("/").length,
    )) {
      if (pendingIds.has(row.entryId)) continue;
      if (!(await this.opts.vault.exists(row.path))) {
        await this.enqueueDelete(row);
      }
    }
  }

  private async enqueueCreate(
    path: string,
    _report: SyncReport,
  ): Promise<void> {
    const meta = await this.opts.store.getMeta();
    const canon = canonicalizePath(path);
    const entryId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    if (isMarkdownPath(path)) {
      const text = await this.opts.vault.readText(path);
      const sha = await hashMarkdown(text);
      const envelope = this.envelope(meta, {
        operationId,
        type: "create",
        entryId,
        payload: { path: canon.display, kind: "markdown", text },
      });
      await this.opts.store.putOutbox({
        operationId,
        envelope,
        extras: { pathKey: canon.pathKey, textSha256: sha },
        status: "queued",
        sentHash: sha,
      });
      await this.opts.store.putManifest({
        entryId,
        path: canon.display,
        kind: "markdown",
        remoteSeq: seqZero(),
        remoteHash: null,
        localHash: sha,
        baseSeq: seqZero(),
        baseHash: null,
        deleted: false,
        blobId: null,
      });
    } else {
      const bytes = await this.opts.vault.readBytes(path);
      const sha = await hashBytes(bytes);
      if (this.opts.api.readBlob) {
        const envelope = this.envelope(meta, {
          operationId,
          type: "create",
          entryId,
          payload: { path: canon.display, kind: "blob", bytes: encode(bytes) },
        });
        await this.opts.store.putOutbox({
          operationId,
          envelope,
          extras: {},
          status: "queued",
          sentHash: sha,
        });
        return;
      }
      const blob = await this.opts.api.beginBlobUpload({
        vaultId: this.opts.vaultId,
        expectedSha256: sha,
        expectedLength: bytes.byteLength,
      });
      if (blob.transfer && typeof blob.transfer === "object") {
        const transfer = blob.transfer as {
          url: string;
          method: string;
          headers: Record<string, string>;
        };
        if (transfer.url.startsWith("memory://")) {
          // in-memory tests skip bytes
        } else {
          const response = await (this.opts.fetch ?? fetch)(transfer.url, {
            method: transfer.method,
            headers: transfer.headers,
            body: bytes as unknown as BlobPart,
          });
          if (!response.ok)
            throw new ProtocolError(
              "RETRYABLE_TRANSPORT",
              `Attachment upload failed (HTTP ${response.status})`,
            );
        }
      }
      await this.opts.api.finalizeBlob({
        vaultId: this.opts.vaultId,
        blobId: String(blob.blobId),
      });
      const envelope = this.envelope(meta, {
        operationId,
        type: "create",
        entryId,
        payload: { path: canon.display, kind: "blob", blob_id: blob.blobId },
      });
      await this.opts.store.putOutbox({
        operationId,
        envelope,
        extras: { pathKey: canon.pathKey },
        status: "queued",
        sentHash: sha,
      });
    }
  }

  private async enqueueUpdate(
    row: ManifestRow,
    text: string,
    sha: string,
  ): Promise<void> {
    const meta = await this.opts.store.getMeta();
    const operationId = crypto.randomUUID();
    const envelope = this.envelope(meta, {
      operationId,
      type: "update",
      entryId: row.entryId,
      baseRevisionId: row.remoteSeq === seqZero() ? undefined : row.remoteSeq,
      payload: { path: row.path, text },
    });
    await this.opts.store.putOutbox({
      operationId,
      envelope,
      extras: { pathKey: canonicalizePath(row.path).pathKey, textSha256: sha },
      status: "queued",
      sentHash: sha,
    });
    await this.opts.store.putManifest({ ...row, localHash: sha });
  }

  private async enqueueBlobUpdate(
    row: ManifestRow,
    bytes: Uint8Array,
    sha: string,
  ): Promise<void> {
    if (this.opts.api.readBlob) {
      const meta = await this.opts.store.getMeta();
      const operationId = crypto.randomUUID();
      const envelope = this.envelope(meta, {
        operationId,
        type: "update",
        entryId: row.entryId,
        baseRevisionId: row.remoteSeq,
        payload: { path: row.path, kind: "blob", bytes: encode(bytes) },
      });
      await this.opts.store.putOutbox({
        operationId,
        envelope,
        extras: {},
        status: "queued",
        sentHash: sha,
      });
      await this.opts.store.putManifest({ ...row, localHash: sha });
      return;
    }
    const blob = await this.opts.api.beginBlobUpload({
      vaultId: this.opts.vaultId,
      expectedSha256: sha,
      expectedLength: bytes.byteLength,
    });
    await this.opts.api.finalizeBlob({
      vaultId: this.opts.vaultId,
      blobId: String(blob.blobId),
    });
    const meta = await this.opts.store.getMeta();
    const operationId = crypto.randomUUID();
    const envelope = this.envelope(meta, {
      operationId,
      type: "update",
      entryId: row.entryId,
      baseRevisionId: row.remoteSeq,
      payload: { blob_id: blob.blobId },
    });
    await this.opts.store.putOutbox({
      operationId,
      envelope,
      extras: {},
      status: "queued",
      sentHash: sha,
    });
    await this.opts.store.putManifest({
      ...row,
      localHash: sha,
      blobId: String(blob.blobId),
    });
  }

  private async enqueueDelete(row: ManifestRow): Promise<void> {
    if (row.remoteSeq === seqZero()) {
      await this.opts.store.deleteManifest(row.entryId);
      return;
    }
    const meta = await this.opts.store.getMeta();
    const operationId = crypto.randomUUID();
    const envelope = this.envelope(meta, {
      operationId,
      type: "delete",
      entryId: row.entryId,
      baseRevisionId: row.remoteSeq,
      payload: {},
    });
    await this.opts.store.putOutbox({
      operationId,
      envelope,
      extras: {},
      status: "queued",
      sentHash: null,
    });
    await this.opts.store.putManifest({
      ...row,
      deleted: true,
      localHash: null,
    });
  }

  private async pullAndApply(
    ceiling: string | undefined,
    report: SyncReport,
  ): Promise<number> {
    const meta = await this.opts.store.getMeta();
    let after = meta.appliedCursor;
    let count = 0;
    let fixedCeiling = ceiling;
    for (;;) {
      const page = await this.opts.api.pullChanges({
        vaultId: this.opts.vaultId,
        afterSeq: after,
        ceiling: fixedCeiling,
        limit: 100,
      });
      fixedCeiling = page.ceiling;
      meta.receivedCursor = page.nextCursor;
      await this.opts.store.putMeta(meta);
      for (const rev of page.revisions) {
        await this.reconcileRevision(rev, report);
        count++;
      }
      after = page.nextCursor;
      meta.appliedCursor = after;
      await this.opts.store.putMeta(meta);
      if (page.exhausted) break;
    }
    return count;
  }

  private async reconcileRevision(
    rev: RevisionRecord,
    report: SyncReport,
  ): Promise<void> {
    const manifest = await this.opts.store.getManifest();
    const row = manifest.get(rev.entryId);
    // Files can change after the capture scan (including while a request is in flight).
    // Recheck bytes at the point of reconciliation before replacing or removing them.
    if (
      row &&
      row.kind !== "folder" &&
      (await this.opts.vault.exists(row.path))
    ) {
      row.localHash = await hashBytes(
        await this.opts.vault.readBytes(row.path),
      );
      await this.opts.store.putManifest(row);
    }
    if (rev.tombstone) {
      if (row && row.localHash && row.localHash !== row.baseHash) {
        if (row.kind === "blob")
          await this.preserveBinary(
            rev,
            await this.opts.vault.readBytes(row.path),
            report,
          );
        else
          await this.preserveConflict(
            rev,
            await this.opts.vault.readText(row.path),
            report,
          );
      }
      if (row && (await this.opts.vault.exists(row.path))) {
        await this.applyDelete(row.path, rev, report);
      }
      await this.remember(rev, null);
      return;
    }
    if (!row) {
      await this.applyRevision(rev, report, false);
      return;
    }
    if (rev.path !== row.path && (await this.opts.vault.exists(rev.path)))
      throw new Error(
        "Local rename destination is occupied; preserve both paths before retrying",
      );
    if (rev.path !== row.path && (await this.opts.vault.exists(row.path))) {
      await this.opts.vault.rename(row.path, rev.path);
      if (rev.kind === "folder") {
        for (const child of manifest.values())
          if (child.path.startsWith(`${row.path}/`))
            await this.opts.store.putManifest({
              ...child,
              path: rev.path + child.path.slice(row.path.length),
            });
      }
      row.path = rev.path;
    }
    if (rev.textSha256 === row.localHash && rev.path === row.path) {
      await this.remember(rev, row.localHash);
      return;
    }
    const localChanged = row.localHash !== row.baseHash;
    const remoteChanged =
      rev.textSha256 !== row.baseHash || rev.path !== row.path;
    if (!localChanged && remoteChanged) {
      await this.applyRevision(rev, report, false);
      return;
    }
    if (localChanged && !remoteChanged) {
      return;
    }
    if (localChanged && remoteChanged) {
      if (rev.kind !== "markdown") {
        const bytes = await this.opts.vault.readBytes(row.path);
        await this.preserveBinary(rev, bytes, report);
        await this.applyRevision(rev, report, false);
        return;
      }
      const localText = await this.opts.vault.readText(row.path);
      const remoteBodies = rev.textSha256
        ? await this.opts.api.getBodies(this.opts.vaultId, [rev.textSha256])
        : { bodies: [] };
      const remoteText = remoteBodies.bodies[0]?.text ?? "";
      const baseText = row.baseHash
        ? ((await this.opts.api.getBodies(this.opts.vaultId, [row.baseHash]))
            .bodies[0]?.text ?? null)
        : null;
      const merged = mergeMarkdown(baseText, localText, remoteText);
      if (merged.kind === "clean") {
        await this.applyText(rev.path, merged.text, rev, report);
        await this.enqueueUpdate(
          {
            ...row,
            remoteSeq: rev.seq,
            remoteHash: rev.textSha256,
            baseSeq: rev.seq,
            baseHash: rev.textSha256,
          },
          merged.text,
          await hashMarkdown(merged.text),
        );
      } else {
        await this.applyRevision(rev, report, false);
        await this.preserveConflict(rev, localText, report);
      }
    }
  }

  private async applyRevision(
    rev: RevisionRecord,
    report: SyncReport,
    bootstrap: boolean,
  ): Promise<void> {
    if (rev.kind === "folder") {
      await this.opts.vault.mkdir(rev.path);
      await this.remember(rev, null);
      report.applied++;
      return;
    }
    if (rev.kind === "markdown" && rev.textSha256) {
      const bodies = await this.opts.api.getBodies(this.opts.vaultId, [
        rev.textSha256,
      ]);
      const text = bodies.bodies[0]?.text;
      if (text == null) throw new ProtocolError("NOT_FOUND", "missing body");
      await this.applyText(rev.path, text, rev, report);
      return;
    }
    if (rev.kind === "blob" && rev.blobId) {
      if (this.opts.api.readBlob) {
        const bytes = await this.opts.api.readBlob(rev.blobId);
        const before = (await this.opts.vault.exists(rev.path))
          ? await hashBytes(await this.opts.vault.readBytes(rev.path))
          : null;
        const after = await hashBytes(bytes);
        await this.opts.store.putIntent({
          path: rev.path,
          beforeHash: before,
          afterHash: after,
          seq: rev.seq,
          entryId: rev.entryId,
        });
        await this.opts.vault.writeBytes(rev.path, bytes);
        await this.remember(rev, after);
        await this.opts.store.deleteIntent(rev.path);
        report.applied++;
        return;
      }
      const dl = await this.opts.api.getBlobDownload({
        vaultId: this.opts.vaultId,
        blobId: rev.blobId,
      });
      if (dl.transfer.url.startsWith("memory://")) {
        await this.remember(rev, dl.verifiedSha256);
        return;
      }
      const res = await (this.opts.fetch ?? fetch)(dl.transfer.url, {
        method: dl.transfer.method,
        headers: dl.transfer.headers,
      });
      if (!res.ok)
        throw new ProtocolError(
          "RETRYABLE_TRANSPORT",
          `Attachment download failed (HTTP ${res.status})`,
        );
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (
        bytes.byteLength !== dl.verifiedLength ||
        (await hashBytes(bytes)) !== dl.verifiedSha256
      ) {
        throw new ProtocolError(
          "HASH_MISMATCH",
          "Downloaded attachment failed integrity verification",
        );
      }
      await this.opts.vault.writeBytes(rev.path, bytes);
      await this.remember(rev, dl.verifiedSha256);
      report.applied++;
    }
    void bootstrap;
  }

  private async applyText(
    path: string,
    text: string,
    rev: RevisionRecord,
    report: SyncReport,
  ): Promise<void> {
    const before = (await this.opts.vault.exists(path))
      ? await hashMarkdown(await this.opts.vault.readText(path))
      : null;
    const after = await hashMarkdown(text);
    await this.opts.store.putIntent({
      path,
      beforeHash: before,
      afterHash: after,
      seq: rev.seq,
      entryId: rev.entryId,
    });
    this.expectedEcho.add(`${path}:${before}:${after}`);
    await this.opts.vault.writeText(path, text);
    await this.remember(rev, after);
    await this.opts.store.deleteIntent(path);
    report.applied++;
  }

  private async applyDelete(
    path: string,
    rev: RevisionRecord,
    report: SyncReport,
  ): Promise<void> {
    await this.opts.store.putIntent({
      path,
      beforeHash: null,
      afterHash: null,
      seq: rev.seq,
      entryId: rev.entryId,
    });
    if (await this.opts.vault.exists(path)) await this.opts.vault.remove(path);
    await this.opts.store.deleteIntent(path);
    report.applied++;
  }

  private async preserveConflict(
    rev: RevisionRecord,
    localText: string,
    report: SyncReport,
  ): Promise<void> {
    const meta = await this.opts.store.getMeta();
    const op = crypto.randomUUID();
    const copyPath = conflictCopyPath(rev.path, meta.label, op);
    await this.opts.vault.writeText(copyPath, localText);
    const sha = await hashMarkdown(localText);
    const envelope = this.envelope(meta, {
      operationId: op,
      type: "create",
      entryId: crypto.randomUUID(),
      payload: {
        path: copyPath,
        kind: "markdown",
        text: localText,
        conflict_of: rev.entryId,
        conflict_operation_id: op,
      },
    });
    await this.opts.store.putOutbox({
      operationId: op,
      envelope,
      extras: { pathKey: canonicalizePath(copyPath).pathKey, textSha256: sha },
      status: "queued",
      sentHash: sha,
    });
    report.conflicts++;
  }

  private async preserveBinary(
    rev: RevisionRecord,
    bytes: Uint8Array,
    report: SyncReport,
  ): Promise<void> {
    const meta = await this.opts.store.getMeta();
    const op = crypto.randomUUID();
    const copyPath = conflictCopyPath(rev.path, meta.label, op);
    await this.opts.vault.writeBytes(copyPath, bytes);
    report.conflicts++;
  }

  private async pushOutbox(report: SyncReport): Promise<number> {
    const rows = await this.opts.store.listOutbox();
    let pushed = 0;
    for (const row of rows) {
      if (row.status === "done") continue;
      await this.opts.store.putOutbox({ ...row, status: "in_flight" });
      try {
        const result = await this.opts.api.commit(
          row.envelope as CommitEnvelope,
          row.extras,
        );
        if (result.outcome === "conflict") {
          report.errors.push(result.message ?? "BASE_CONFLICT");
          if (result.current)
            await this.reconcileRevision(result.current, report);
        } else if (result.revision) {
          const sha = row.sentHash;
          await this.remember(result.revision, sha);
          pushed++;
        }
        await this.opts.store.deleteOutbox(row.operationId);
      } catch (error) {
        const latest =
          (await this.opts.store.listOutbox()).find(
            (p) => p.operationId === row.operationId,
          ) ?? row;
        await this.opts.store.putOutbox({ ...latest, status: "queued" });
        report.errors.push(
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return pushed;
  }

  private async recoverIntents(report: SyncReport): Promise<void> {
    for (const intent of await this.opts.store.listIntents()) {
      const exists = await this.opts.vault.exists(intent.path);
      const current =
        exists && isMarkdownPath(intent.path)
          ? await hashMarkdown(await this.opts.vault.readText(intent.path))
          : null;
      if (current === intent.afterHash) {
        await this.opts.store.deleteIntent(intent.path);
      } else if (current === intent.beforeHash && intent.afterHash) {
        report.errors.push(`replay-needed:${intent.path}`);
      } else {
        report.errors.push(`apply-conflict:${intent.path}`);
      }
    }
  }

  private async remember(
    rev: RevisionRecord,
    localHash: string | null,
  ): Promise<void> {
    await this.opts.store.putManifest({
      entryId: rev.entryId,
      path: rev.path,
      kind: rev.kind,
      remoteSeq: rev.seq,
      remoteHash: rev.textSha256,
      localHash: localHash ?? rev.textSha256,
      baseSeq: rev.seq,
      baseHash: rev.textSha256,
      deleted: rev.tombstone,
      blobId: rev.blobId,
    });
  }

  async deleteLocal(path: string): Promise<void> {
    // Called only for an explicit deletion event, never merely for an empty scan.
    const pending = new Set(
      (await this.opts.store.listOutbox()).map(
        (r) => (r.envelope as CommitEnvelope).entryId,
      ),
    );
    const rows = [...(await this.opts.store.getManifest()).values()]
      .filter(
        (r) => !r.deleted && (r.path === path || r.path.startsWith(`${path}/`)),
      )
      .sort((a, b) => b.path.split("/").length - a.path.split("/").length);
    for (const row of rows)
      if (!pending.has(row.entryId)) await this.enqueueDelete(row);
  }

  async renameLocal(from: string, to: string): Promise<void> {
    const meta = await this.opts.store.getMeta();
    for (const row of (await this.opts.store.getManifest()).values()) {
      if (
        row.deleted ||
        (row.path !== from && !row.path.startsWith(`${from}/`))
      )
        continue;
      const path = to + row.path.slice(from.length);
      if (row.path === from) {
        const operationId = crypto.randomUUID();
        await this.opts.store.putOutbox({
          operationId,
          envelope: this.envelope(meta, {
            operationId,
            type: "rename",
            entryId: row.entryId,
            baseRevisionId: row.remoteSeq,
            payload: { path, kind: row.kind },
          }),
          extras: {},
          status: "queued",
          sentHash: row.localHash,
        });
      }
      await this.opts.store.putManifest({ ...row, path });
    }
  }

  matchesEcho(
    path: string,
    fromHash: string | null,
    toHash: string | null,
  ): boolean {
    const key = `${path}:${fromHash}:${toHash}`;
    if (this.expectedEcho.has(key)) {
      this.expectedEcho.delete(key);
      return true;
    }
    return false;
  }

  private envelope(
    meta: { clientId: string; generation: number; serverEpoch: string | null },
    partial: Omit<
      CommitEnvelope,
      | "protocolVersion"
      | "serverEpoch"
      | "vaultId"
      | "clientId"
      | "clientGeneration"
    >,
  ): CommitEnvelope {
    return createEnvelope({
      ...partial,
      serverEpoch: meta.serverEpoch ?? "",
      vaultId: this.opts.vaultId,
      clientId: meta.clientId,
      clientGeneration: meta.generation,
    });
  }
}
