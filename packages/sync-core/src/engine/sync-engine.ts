import { encode, unencode } from "@supasync/protocol";
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
  OutboxRow,
  SyncApi,
  VaultAdapter,
} from "../types.ts";

const REJECTED_OUTBOX_CACHE_PREFIX = "rejected-outbox:";
const UNSUPPORTED_INTENT_CACHE_PREFIX = "unsupported-intent:";
const UNSUPPORTED_REVISION_CACHE_PREFIX = "unsupported-revision:";

function pathError(error: unknown): string {
  return error instanceof ProtocolError
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
}

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
  private structuralEcho = new Set<string>();

  matchesStructuralEcho(
    type: "delete" | "rename",
    path: string,
    to = "",
  ): boolean {
    const key = `${type}:${path}:${to}`;
    if (!this.structuralEcho.has(key)) return false;
    this.structuralEcho.delete(key);
    return true;
  }
  private async removeRemote(path: string) {
    const keys = (await this.opts.vault.list())
      .filter((r) => r.path === path || r.path.startsWith(path + "/"))
      .map((r) => `delete:${r.path}:`);
    keys.push(`delete:${path}:`);
    for (const key of keys) this.structuralEcho.add(key);
    try {
      await this.opts.vault.remove(path);
    } finally {
      for (const key of keys) this.structuralEcho.delete(key);
    }
  }
  private async renameRemote(from: string, to: string) {
    const key = `rename:${from}:${to}`;
    this.structuralEcho.add(key);
    try {
      await this.opts.vault.rename(from, to);
    } finally {
      this.structuralEcho.delete(key);
    }
  }

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
    const portableItems = [] as typeof page.items;
    for (const item of page.items) {
      if (await this.acceptRemotePath(item.revision, report))
        portableItems.push(item);
    }
    if (localFiles.length === 0) {
      for (const item of portableItems) {
        await this.applyRevision(item.revision, report, true);
      }
    } else {
      for (const item of portableItems) {
        const local = localFiles.find(
          (file) => {
            try {
              return (
                canonicalizePath(file.path).pathKey === item.revision.pathKey
              );
            } catch {
              return false;
            }
          },
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
            await this.applyRevision(item.revision, report, true);
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
    const byPath = new Map<string, ManifestRow>();
    for (const row of manifest.values()) {
      if (row.deleted) continue;
      try {
        byPath.set(canonicalizePath(row.path).display, row);
      } catch {
        // A local-only unsupported rename may be corrected by a later event.
      }
    }
    const pending = await this.opts.store.listOutbox();
    const pendingPaths = new Set<string>();
    for (const row of pending) {
      const path = (row.envelope as CommitEnvelope).payload.path;
      if (typeof path !== "string") continue;
      try {
        pendingPaths.add(canonicalizePath(path).display);
      } catch {
        // Invalid legacy requests are recovered before push, not used for matching.
      }
    }
    const pendingIds = new Set(
      pending.map((p) => (p.envelope as CommitEnvelope).entryId),
    );
    const events =
      (await this.opts.store.getCache<Array<{ type: string; to?: string }>>(
        "filesystem-events",
      )) ?? [];
    if (listed.length === 0) return; // An empty listing alone is never proof of deletion.
    for (const stat of listed.sort(
      (a, b) => a.path.split("/").length - b.path.split("/").length,
    )) {
      if (stat.kind === "folder" && (!stat.path || stat.path === "/")) continue;
      if (isExcluded(stat.path, this.opts.vault.configDir())) continue;
      let canon: ReturnType<typeof canonicalizePath>;
      try {
        canon = canonicalizePath(stat.path);
      } catch (error) {
        report.errors.push(`${stat.path || "<root>"}: ${pathError(error)}`);
        continue;
      }
      if (pendingPaths.has(canon.display)) continue;
      if (
        events.some(
          (e) =>
            e.type === "rename" &&
            e.to &&
            (stat.path === e.to || stat.path.startsWith(e.to + "/")),
        )
      )
        continue;
      if (stat.kind === "folder") {
        if (!byPath.has(canon.display)) {
          const meta = await this.opts.store.getMeta();
          const operationId = crypto.randomUUID();
          await this.opts.store.putOutbox({
            operationId,
            envelope: this.envelope(meta, {
              operationId,
              type: "create",
              entryId: crypto.randomUUID(),
              payload: { path: canon.display, kind: "folder" },
            }),
            extras: {},
            status: "queued",
            sentHash: null,
          });
          pendingPaths.add(canon.display);
        }
        continue;
      }
      if (stat.kind !== "file") continue;
      const limit = isMarkdownPath(stat.path)
        ? DEFAULT_LIMITS.maxTextBytes
        : DEFAULT_LIMITS.maxBlobBytes;
      if (stat.byteLength > limit) {
        report.errors.push(`File exceeds supported size limit: ${stat.path}`);
        continue;
      }
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
      const captured = await this.capture(stat.path);
      if (captured.text !== null) {
        const text = captured.text;
        const sha = await hashMarkdown(text);
        if (sha !== row.baseHash) {
          await this.enqueueUpdate(row, text, sha);
        }
      } else {
        const bytes = await this.opts.vault.readBytes(stat.path);
        const sha = await hashBytes(bytes);
        if (sha !== row.baseHash) {
          await this.enqueueBlobUpdate(row, bytes, sha);
        }
      }
    }
    // Only explicit, persisted deletion events may remove remote entries.
  }

  private async enqueueCreate(
    path: string,
    _report: SyncReport,
  ): Promise<void> {
    const meta = await this.opts.store.getMeta();
    const canon = canonicalizePath(path);
    const entryId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const captured = await this.capture(path);
    const sha = await hashBytes(captured.bytes);
    const envelope = this.envelope(meta, {
      operationId,
      type: "create",
      entryId,
      payload: {
        path: canon.display,
        ...(captured.text !== null
          ? { kind: "markdown", text: captured.text }
          : { kind: "blob", bytes: encode(captured.bytes) }),
      },
    });
    await this.opts.store.putOutbox({
      operationId,
      envelope,
      extras: {},
      status: "queued",
      sentHash: sha,
    });
    await this.opts.store.putManifest({
      entryId,
      path: canon.display,
      kind: captured.text !== null ? "markdown" : "blob",
      remoteSeq: "0",
      remoteHash: null,
      localHash: sha,
      baseSeq: "0",
      baseHash: null,
      deleted: false,
      blobId: null,
    });
  }

  private async capture(
    path: string,
  ): Promise<{ bytes: Uint8Array; text: string | null }> {
    const bytes = await this.opts.vault.readBytes(path);
    let text: string | null = null;
    try {
      const value = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
      if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) text = value;
    } catch {}
    if (isMarkdownPath(path) && text === null)
      throw new Error(
        "Markdown must be valid UTF-8 without NUL bytes: " + path,
      );
    if (
      bytes.length >
      (text === null
        ? DEFAULT_LIMITS.maxBlobBytes
        : DEFAULT_LIMITS.maxTextBytes)
    )
      throw new Error("File exceeds supported size limit: " + path);
    return { bytes, text };
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
      baseRevisionId: row.baseSeq === seqZero() ? undefined : row.baseSeq,
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
    const meta = await this.opts.store.getMeta();
    const operationId = crypto.randomUUID();
    const envelope = this.envelope(meta, {
      operationId,
      type: "update",
      entryId: row.entryId,
      baseRevisionId: row.baseSeq,
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
      baseRevisionId: row.baseSeq,
      payload:
        row.kind === "folder"
          ? {
              treeBase: Object.fromEntries(
                [...(await this.opts.store.getManifest()).values()]
                  .filter(
                    (x) =>
                      !x.deleted &&
                      (x.entryId === row.entryId ||
                        x.path.startsWith(row.path + "/")),
                  )
                  .map((x) => [x.entryId, x.baseSeq]),
              ),
            }
          : {},
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
        if (await this.acceptRemotePath(rev, report))
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

  private async acceptRemotePath(
    rev: RevisionRecord,
    report: SyncReport,
  ): Promise<boolean> {
    try {
      canonicalizePath(rev.path);
      return true;
    } catch (error) {
      const key = `${UNSUPPORTED_REVISION_CACHE_PREFIX}${rev.seq}`;
      if ((await this.opts.store.getCache(key)) === null) {
        await this.opts.store.putCache(key, {
          reason: "unsupported-remote-path",
          error: pathError(error),
          revision: rev,
        });
      }
      report.errors.push(
        `Quarantined unsupported remote path at revision ${rev.seq}: ${rev.path}`,
      );
      return false;
    }
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
    if (row && BigInt(row.remoteSeq) >= BigInt(rev.seq)) return;
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
    if (
      rev.kind !== "folder" &&
      rev.path !== row.path &&
      (await this.opts.vault.exists(rev.path))
    )
      throw new Error(
        "Local rename destination is occupied; preserve both paths before retrying",
      );
    if (rev.path !== row.path && (await this.opts.vault.exists(row.path))) {
      const fromPath = row.path;
      await this.opts.store.putIntent({
        path: rev.path,
        fromPath,
        beforeHash: row.localHash,
        afterHash: row.localHash,
        seq: rev.seq,
        entryId: rev.entryId,
      });
      if (rev.kind === "folder" && (await this.opts.vault.exists(rev.path))) {
        const remaining = (await this.opts.vault.list()).filter(
          (f) => f.kind === "file" && f.path.startsWith(row.path + "/"),
        );
        if (!remaining.length) await this.removeRemote(row.path);
      } else await this.renameRemote(row.path, rev.path);
      if (rev.kind === "folder") {
        for (const child of manifest.values())
          if (child.path.startsWith(`${row.path}/`))
            await this.opts.store.putManifest({
              ...child,
              path: rev.path + child.path.slice(row.path.length),
            });
      }
      row.path = rev.path;
      await this.opts.store.putManifest(row);
      await this.opts.store.deleteIntent(rev.path);
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
            baseSeq: rev.revision,
            baseHash: rev.textSha256,
          },
          merged.text,
          await hashMarkdown(merged.text),
        );
      } else {
        await this.preserveConflict(rev, localText, report);
        await this.applyRevision(rev, report, false);
      }
    }
  }

  private async applyRevision(
    rev: RevisionRecord,
    report: SyncReport,
    bootstrap: boolean,
  ): Promise<void> {
    if (
      !bootstrap &&
      rev.kind !== "folder" &&
      !(await this.opts.store.getManifest()).has(rev.entryId) &&
      (await this.opts.vault.exists(rev.path))
    ) {
      const bytes = await this.opts.vault.readBytes(rev.path);
      if ((await hashBytes(bytes)) !== rev.textSha256)
        await this.preserveBinary(rev, bytes, report);
    }
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
        const original = (await this.opts.vault.exists(rev.path))
          ? await this.opts.vault.readBytes(rev.path)
          : null;
        const before = original ? await hashBytes(original) : null;
        const after = await hashBytes(bytes);
        if (after !== rev.textSha256) throw new Error("HASH_MISMATCH");
        const row = (await this.opts.store.getManifest()).get(rev.entryId);
        if (
          original &&
          before !== after &&
          before !== row?.localHash &&
          before !== row?.baseHash
        )
          await this.preserveBinary(rev, original, report);
        await this.opts.store.putIntent({
          path: rev.path,
          beforeHash: before,
          afterHash: after,
          seq: rev.seq,
          entryId: rev.entryId,
        });
        const echo = `delete:${rev.path}:`;
        this.structuralEcho.add(echo);
        try {
          await this.opts.vault.writeBytes(rev.path, bytes);
        } finally {
          this.structuralEcho.delete(echo);
        }
        await this.remember(rev, after);
        await this.opts.store.deleteIntent(rev.path);
        report.applied++;
        return;
      }
    }
    void bootstrap;
  }

  private async applyText(
    path: string,
    text: string,
    rev: RevisionRecord,
    report: SyncReport,
  ): Promise<void> {
    const original = (await this.opts.vault.exists(path))
      ? await this.opts.vault.readText(path)
      : null;
    const before = original === null ? null : await hashMarkdown(original);
    const after = await hashMarkdown(text);
    const row = (await this.opts.store.getManifest()).get(rev.entryId);
    if (
      original !== null &&
      before !== after &&
      before !== row?.localHash &&
      before !== row?.baseHash
    )
      await this.preserveConflict(rev, original, report);
    await this.opts.store.putIntent({
      path,
      beforeHash: before,
      afterHash: after,
      seq: rev.seq,
      entryId: rev.entryId,
    });
    await this.opts.vault.writeText(path, text, original);
    await this.remember(rev, after);
    await this.opts.store.deleteIntent(path);
    report.applied++;
  }

  private async applyDelete(
    path: string,
    rev: RevisionRecord,
    report: SyncReport,
  ): Promise<void> {
    // Child journal events run first. Never recursively remove untracked local work.
    if (
      rev.kind === "folder" &&
      (await this.opts.vault.list()).some((f) => f.path.startsWith(path + "/"))
    )
      return;
    if (rev.kind !== "folder" && (await this.opts.vault.exists(path))) {
      const current = await this.opts.vault.readBytes(path);
      const row = (await this.opts.store.getManifest()).get(rev.entryId);
      if ((await hashBytes(current)) !== row?.localHash)
        await this.preserveBinary(rev, current, report);
    }
    await this.opts.store.putIntent({
      path,
      beforeHash: null,
      afterHash: null,
      seq: rev.seq,
      entryId: rev.entryId,
    });
    if (await this.opts.vault.exists(path)) await this.removeRemote(path);
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
    await this.opts.vault.writeText(copyPath, localText);
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
    const envelope = this.envelope(meta, {
      operationId: op,
      type: "create",
      entryId: crypto.randomUUID(),
      payload: { path: copyPath, kind: "blob", bytes: encode(bytes) },
    });
    await this.opts.store.putOutbox({
      operationId: op,
      envelope,
      extras: {},
      status: "queued",
      sentHash: await hashBytes(bytes),
    });
    await this.opts.vault.writeBytes(copyPath, bytes);
    report.conflicts++;
  }

  private async pushOutbox(report: SyncReport): Promise<number> {
    const rows = await this.opts.store.listOutbox();
    let pushed = 0;
    for (const row of rows) {
      if (row.status === "done") continue;
      if (this.isLegacyRootFolderCreate(row)) {
        await this.recoverLegacyRootFolderCreate(row, report);
        continue;
      }
      await this.opts.store.putOutbox({ ...row, status: "in_flight" });
      try {
        const result = await this.opts.api.commit(
          row.envelope as CommitEnvelope,
          row.extras,
        );
        if (result.outcome === "conflict") {
          const conflicts =
            (await this.opts.store.getCache<unknown[]>("conflicts")) ?? [];
          await this.opts.store.putCache("conflicts", [
            ...conflicts,
            {
              envelope: row.envelope,
              reason: result.message,
              current: result.current,
            },
          ]);
          // Preserve the captured payload, even if the source was edited or removed after send.
          const env = row.envelope as CommitEnvelope;
          if (
            typeof env.payload.text === "string" ||
            typeof env.payload.bytes === "string"
          ) {
            const target =
              result.current ??
              ({
                path: String(env.payload.path ?? "Recovered.md"),
                entryId: env.entryId!,
              } as RevisionRecord);
            if (typeof env.payload.text === "string")
              await this.preserveConflict(target, env.payload.text, report);
            else
              await this.preserveBinary(
                target,
                unencode(env.payload.bytes as string),
                report,
              );
          }
          report.errors.push(result.message ?? "BASE_CONFLICT");
          if (result.current) {
            const local = (await this.opts.store.getManifest()).get(
              result.current.entryId,
            );
            if (local && (env.type === "rename" || env.type === "delete"))
              await this.opts.store.putManifest({ ...local, remoteSeq: "0" });
            await this.reconcileRevision(result.current, report);
          }
          if (
            env.type === "create" &&
            env.entryId &&
            result.current?.entryId !== env.entryId
          )
            await this.opts.store.deleteManifest(env.entryId);
        } else if (result.revision) {
          await this.reconcileRevision(result.revision, report);
          pushed++;
        }
        await this.opts.store.deleteOutbox(row.operationId);
      } catch (error) {
        if (await this.retireRejectedUnsupportedPath(row, error, report))
          continue;
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

  private async retireRejectedUnsupportedPath(
    row: OutboxRow,
    error: unknown,
    report: SyncReport,
  ): Promise<boolean> {
    if (!(error instanceof ProtocolError) || error.code !== "INVALID_PATH")
      return false;
    const env = row.envelope as CommitEnvelope;
    const path = env.payload.path;
    if (typeof path !== "string") return false;
    try {
      canonicalizePath(path);
      return false;
    } catch {}
    const key = `${REJECTED_OUTBOX_CACHE_PREFIX}${row.operationId}`;
    try {
      if ((await this.opts.store.getCache(key)) === null) {
        await this.opts.store.putCache(key, {
          reason: "unsupported-path-request",
          error: pathError(error),
          outbox: row,
        });
      }
      await this.opts.store.deleteOutbox(row.operationId);
      if (env.type === "create" && env.entryId) {
        const manifest = (await this.opts.store.getManifest()).get(env.entryId);
        if (manifest?.remoteSeq === seqZero())
          await this.opts.store.deleteManifest(env.entryId);
      }
      report.errors.push(`Retired unsupported queued path: ${path}`);
      return true;
    } catch (recoveryError) {
      report.errors.push(
        `Unsupported-path queue recovery failed: ${path}: ${pathError(
          recoveryError,
        )}`,
      );
      return false;
    }
  }

  private isLegacyRootFolderCreate(row: OutboxRow): boolean {
    const env = row.envelope as Partial<CommitEnvelope>;
    if (
      env.vaultId !== this.opts.vaultId ||
      env.type !== "create" ||
      !env.payload ||
      env.payload.kind !== "folder" ||
      (env.payload.path !== "/" && env.payload.path !== "")
    )
      return false;
    return Object.keys(env.payload).every(
      (key) => key === "path" || key === "kind",
    );
  }

  private async recoverLegacyRootFolderCreate(
    row: OutboxRow,
    report: SyncReport,
  ): Promise<void> {
    const key = `${REJECTED_OUTBOX_CACHE_PREFIX}${row.operationId}`;
    try {
      const archived = await this.opts.store.getCache(key);
      if (archived === null) {
        await this.opts.store.putCache(key, {
          reason: "invalid-root-folder-create",
          outbox: row,
        });
      }
      await this.opts.store.deleteOutbox(row.operationId);
    } catch (error) {
      report.errors.push(
        `Root-folder queue recovery failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async recoverIntents(report: SyncReport): Promise<void> {
    for (const intent of await this.opts.store.listIntents()) {
      try {
        canonicalizePath(intent.path);
      } catch (error) {
        const key = `${UNSUPPORTED_INTENT_CACHE_PREFIX}${intent.entryId}:${intent.seq}`;
        if ((await this.opts.store.getCache(key)) === null) {
          await this.opts.store.putCache(key, {
            reason: "unsupported-apply-path",
            error: pathError(error),
            intent,
          });
        }
        await this.opts.store.deleteIntent(intent.path);
        report.errors.push(`Retired unsupported apply intent: ${intent.path}`);
        continue;
      }
      if (intent.fromPath) {
        if (
          !(await this.opts.vault.exists(intent.fromPath)) &&
          (await this.opts.vault.exists(intent.path))
        ) {
          for (const row of (await this.opts.store.getManifest()).values()) {
            if (
              row.path === intent.fromPath ||
              row.path.startsWith(intent.fromPath + "/")
            )
              await this.opts.store.putManifest({
                ...row,
                path: intent.path + row.path.slice(intent.fromPath.length),
              });
          }
          await this.opts.store.deleteIntent(intent.path);
        }
        continue;
      }
      const exists = await this.opts.vault.exists(intent.path);
      const current = exists
        ? await hashBytes(await this.opts.vault.readBytes(intent.path))
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
      baseSeq: rev.revision,
      baseHash: rev.textSha256,
      deleted: rev.tombstone,
      blobId: rev.blobId,
    });
  }

  async deleteLocal(path: string): Promise<boolean> {
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
    if (rows.some((row) => pending.has(row.entryId))) return false;
    const root = rows.find((row) => row.path === path);
    if (root) await this.enqueueDelete(root);
    else for (const row of rows) await this.enqueueDelete(row);
    return true;
  }

  async renameLocal(from: string, to: string): Promise<boolean> {
    const meta = await this.opts.store.getMeta();
    const original = [...(await this.opts.store.getManifest()).values()];
    let canonicalTo: string;
    try {
      canonicalTo = canonicalizePath(to).display;
    } catch {
      for (const row of original) {
        if (
          !row.deleted &&
          (row.path === from || row.path.startsWith(`${from}/`))
        )
          await this.opts.store.putManifest({
            ...row,
            path: to + row.path.slice(from.length),
          });
      }
      return true;
    }
    const pending = new Set(
      (await this.opts.store.listOutbox()).map(
        (x) => (x.envelope as CommitEnvelope).entryId,
      ),
    );
    if (
      original.some(
        (row) =>
          !row.deleted &&
          (row.path === from || row.path.startsWith(from + "/")) &&
          pending.has(row.entryId),
      )
    )
      return false;
    for (const row of original) {
      if (
        row.deleted ||
        (row.path !== from && !row.path.startsWith(`${from}/`))
      )
        continue;
      const path = canonicalizePath(
        canonicalTo + row.path.slice(from.length),
      ).display;
      if (row.path === from) {
        const operationId = crypto.randomUUID();
        await this.opts.store.putOutbox({
          operationId,
          envelope: this.envelope(meta, {
            operationId,
            type: "rename",
            entryId: row.entryId,
            baseRevisionId: row.baseSeq,
            payload: {
              path,
              kind: row.kind,
              ...(row.kind === "folder"
                ? {
                    treeBase: Object.fromEntries(
                      original
                        .filter(
                          (x) =>
                            !x.deleted &&
                            (x.entryId === row.entryId ||
                              x.path.startsWith(from + "/")),
                        )
                        .map((x) => [x.entryId, x.baseSeq]),
                    ),
                  }
                : {}),
            },
          }),
          extras: {},
          status: "queued",
          sentHash: row.localHash,
        });
      }
      await this.opts.store.putManifest({ ...row, path });
    }
    return true;
  }

  private envelope(
    meta: { clientId: string; serverEpoch: string | null },
    partial: Omit<
      CommitEnvelope,
      "protocolVersion" | "serverEpoch" | "vaultId" | "clientId"
    >,
  ): CommitEnvelope {
    return createEnvelope({
      ...partial,
      serverEpoch: meta.serverEpoch ?? "",
      vaultId: this.opts.vaultId,
      clientId: meta.clientId,
    });
  }
}
