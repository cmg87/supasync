import {
  ProtocolError,
  canonicalizePath,
  createEnvelope,
  envelopeDigest,
  hashMarkdown,
  hashBytes,
  unencode,
  seqFromBigInt,
  seqToBigInt,
  seqZero,
  type CommitEnvelope,
  type CommitResult,
  type PullPage,
  type RevisionRecord,
  type SnapshotBegin,
  type SnapshotItem,
} from "@supasync/protocol";
import type { SyncApi } from "../types.ts";

type Entry = {
  entryId: string;
  path: string;
  pathKey: string;
  kind: "markdown" | "blob" | "folder";
  version: number;
  seq: string;
  deleted: boolean;
  textSha?: string;
  blobId?: string;
  conflictOf?: string;
};

type Receipt = { digest: string; outcome: CommitResult };

export class MemoryBackend implements SyncApi {
  readonly vaultId: string;
  serverEpoch = crypto.randomUUID();
  headSeq = 0n;
  namespaceSeq = 0n;
  replayFloor = 0n;
  private entries = new Map<string, Entry>();
  private revisions: RevisionRecord[] = [];
  private bodies = new Map<string, string>();
  private receipts = new Map<string, Receipt>();
  private binaries = new Map<string, Uint8Array>();
  private lock: Promise<void> = Promise.resolve();

  constructor(vaultId = crypto.randomUUID()) {
    this.vaultId = vaultId;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lock;
    let release: () => void = () => undefined;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async capabilities() {
    return {
      serverEpoch: this.serverEpoch,
      headSeq: seqFromBigInt(this.headSeq),
      namespaceSeq: seqFromBigInt(this.namespaceSeq),
      replayFloor: seqFromBigInt(this.replayFloor),
      protocolVersion: 3,
    };
  }

  async commit(
    envelope: CommitEnvelope,
    extras: { pathKey?: string; textSha256?: string } = {},
  ): Promise<CommitResult> {
    return this.withLock(async () => this.commitLocked(envelope, extras));
  }

  private async commitLocked(
    envelope: CommitEnvelope,
    extras: { pathKey?: string; textSha256?: string },
  ): Promise<CommitResult> {
    if (envelope.serverEpoch !== this.serverEpoch) {
      throw new ProtocolError("EPOCH_MISMATCH", "epoch mismatch");
    }
    const digest = await envelopeDigest(envelope);
    const receiptKey = envelope.operationId;
    const existing = this.receipts.get(receiptKey);
    if (existing) {
      if (existing.digest !== digest)
        throw new ProtocolError("ID_REUSE", "operation id reused");
      return existing.outcome;
    }

    const store = (outcome: CommitResult) => {
      this.receipts.set(receiptKey, { digest, outcome });
      return outcome;
    };

    if (envelope.type === "create") {
      const path = String(envelope.payload.path);
      const canon = canonicalizePath(path);
      const pathKey = extras.pathKey ?? canon.pathKey;
      const live = [...this.entries.values()].find(
        (e) => e.pathKey === pathKey && !e.deleted,
      );
      if (live) {
        return store({
          outcome: "conflict",
          operationId: envelope.operationId,
          current: this.revBySeq(live.seq),
          message: "PATH_COLLISION",
        });
      }
      if (this.entries.has(envelope.entryId!))
        throw new ProtocolError("ID_REUSE", "entry exists");
      const binary =
        typeof envelope.payload.bytes === "string"
          ? unencode(envelope.payload.bytes)
          : null;
      if (binary) this.binaries.set(envelope.operationId, binary);
      const text =
        typeof envelope.payload.text === "string" ? envelope.payload.text : "";
      const sha =
        envelope.payload.kind === "folder"
          ? undefined
          : binary
            ? await hashBytes(binary)
            : (extras.textSha256 ?? (await hashMarkdown(text)));
      if (!binary && sha) this.bodies.set(sha, text);
      const rec = this.append({
        entryId: envelope.entryId ?? crypto.randomUUID(),
        path: canon.display,
        pathKey,
        kind: (envelope.payload.kind as Entry["kind"]) ?? "markdown",
        version: 0,
        seq: seqZero(),
        deleted: false,
        textSha: sha,
        blobId: binary
          ? envelope.operationId
          : (envelope.payload.blob_id as string | undefined),
        conflictOf: envelope.payload.conflict_of as string | undefined,
        actor: envelope,
        namespace: true,
      });
      return store({
        outcome: "accepted",
        operationId: envelope.operationId,
        revision: rec,
      });
    }

    const entry = this.entries.get(envelope.entryId ?? "");
    if (!entry) throw new ProtocolError("NOT_FOUND", "entry not found");
    if (envelope.baseRevisionId !== String(entry.version)) {
      return store({
        outcome: "conflict",
        operationId: envelope.operationId,
        current: this.revBySeq(entry.seq),
        message: "BASE_CONFLICT",
      });
    }

    if (envelope.type === "update") {
      const binary =
        typeof envelope.payload.bytes === "string"
          ? unencode(envelope.payload.bytes)
          : null;
      if (binary) this.binaries.set(envelope.operationId, binary);
      const text = String(envelope.payload.text ?? "");
      const sha = extras.textSha256 ?? (await hashMarkdown(text));
      if (
        sha === entry.textSha &&
        (envelope.payload.path ?? entry.path) === entry.path
      ) {
        return store({
          outcome: "noop",
          operationId: envelope.operationId,
          revision: this.revBySeq(entry.seq),
        });
      }
      this.bodies.set(sha, text);
      const rec = this.append({
        ...entry,
        textSha: sha,
        blobId: binary ? envelope.operationId : undefined,
        kind: binary ? "blob" : "markdown",
        actor: envelope,
        namespace: false,
      });
      return store({
        outcome: "accepted",
        operationId: envelope.operationId,
        revision: rec,
      });
    }

    if (envelope.type === "delete") {
      if (entry.deleted) {
        return store({
          outcome: "noop",
          operationId: envelope.operationId,
          revision: this.revBySeq(entry.seq),
        });
      }
      const rec = this.append({
        ...entry,
        deleted: true,
        textSha: undefined,
        blobId: undefined,
        actor: envelope,
        namespace: true,
      });
      return store({
        outcome: "accepted",
        operationId: envelope.operationId,
        revision: rec,
      });
    }

    if (envelope.type === "rename") {
      const to = canonicalizePath(
        String(envelope.payload.path ?? envelope.payload.to_path),
      );
      if (entry.kind === "folder")
        for (const child of [...this.entries.values()])
          if (child.path.startsWith(entry.path + "/") && !child.deleted)
            this.append({
              ...child,
              path: to.display + child.path.slice(entry.path.length),
              pathKey: canonicalizePath(
                to.display + child.path.slice(entry.path.length),
              ).pathKey,
              actor: envelope,
              namespace: true,
            });
      const rec = this.append({
        ...entry,
        path: to.display,
        pathKey: to.pathKey,
        actor: envelope,
        namespace: true,
      });
      return store({
        outcome: "accepted",
        operationId: envelope.operationId,
        revision: rec,
      });
    }

    if (envelope.type === "restore_revision") {
      const text = String(
        envelope.payload.text ?? this.bodies.get(entry.textSha ?? "") ?? "",
      );
      const sha = await hashMarkdown(text);
      this.bodies.set(sha, text);
      const rec = this.append({
        ...entry,
        textSha: sha,
        actor: envelope,
        namespace: false,
      });
      return store({
        outcome: "accepted",
        operationId: envelope.operationId,
        revision: rec,
      });
    }

    throw new ProtocolError("UNAVAILABLE", `unknown type ${envelope.type}`);
  }

  async pullChanges(input: {
    vaultId: string;
    afterSeq: string;
    ceiling?: string;
    limit?: number;
  }): Promise<PullPage> {
    return this.withLock(async () => {
      const after = seqToBigInt(input.afterSeq);
      if (after < this.replayFloor)
        throw new ProtocolError("CURSOR_EXPIRED", "cursor expired");
      const ceiling = input.ceiling ? seqToBigInt(input.ceiling) : this.headSeq;
      const limit = input.limit ?? 100;
      const slice = this.revisions
        .filter(
          (r) => seqToBigInt(r.seq) > after && seqToBigInt(r.seq) <= ceiling,
        )
        .slice(0, limit);
      const next = slice.length
        ? seqToBigInt(slice[slice.length - 1]!.seq)
        : after;
      return {
        afterSeq: input.afterSeq,
        ceiling: seqFromBigInt(ceiling),
        nextCursor: seqFromBigInt(next),
        exhausted: next >= ceiling || slice.length === 0,
        replayFloor: seqFromBigInt(this.replayFloor),
        revisions: slice,
      };
    });
  }

  async beginSnapshot(): Promise<SnapshotBegin> {
    const items = [...this.entries.values()].filter((e) => !e.deleted);
    return {
      snapshotId: crypto.randomUUID(),
      headSeq: seqFromBigInt(this.headSeq),
      serverEpoch: this.serverEpoch,
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      itemCount: items.length,
    };
  }

  async listSnapshot(): Promise<{
    items: SnapshotItem[];
    nextCursor: string | null;
    exhausted: boolean;
  }> {
    const items: SnapshotItem[] = [...this.entries.values()]
      .filter((e) => !e.deleted)
      .map((e) => ({ entryId: e.entryId, revision: this.revBySeq(e.seq) }));
    return { items, nextCursor: null, exhausted: true };
  }

  async getBodies(_vaultId: string, sha256s: string[]) {
    return {
      bodies: sha256s
        .filter((sha) => this.bodies.has(sha))
        .map((sha) => ({
          sha256: sha,
          text: this.bodies.get(sha)!,
          byteLength: new TextEncoder().encode(this.bodies.get(sha)!).length,
        })),
    };
  }

  async readBlob(id: string) {
    const bytes = this.binaries.get(id);
    if (!bytes) throw new Error("Missing binary");
    return bytes.slice();
  }

  createEnvelope(
    partial: Omit<
      CommitEnvelope,
      "protocolVersion" | "serverEpoch" | "vaultId"
    >,
  ): CommitEnvelope {
    return createEnvelope({
      ...partial,
      serverEpoch: this.serverEpoch,
      vaultId: this.vaultId,
    });
  }

  private append(
    input: Entry & { actor: CommitEnvelope; namespace: boolean },
  ): RevisionRecord {
    this.headSeq += 1n;
    if (input.namespace) this.namespaceSeq += 1n;
    const seq = seqFromBigInt(this.headSeq);
    const version = (this.entries.get(input.entryId)?.version ?? 0) + 1;
    const rec: RevisionRecord = {
      vaultId: this.vaultId,
      seq,
      entryId: input.entryId,
      version,
      parentSeq: this.entries.get(input.entryId)?.seq ?? null,
      path: input.path,
      pathKey: input.pathKey,
      kind: input.kind,
      textSha256: input.deleted ? null : (input.textSha ?? null),
      content: input.textSha ? this.bodies.get(input.textSha) : null,
      blobId: input.deleted ? null : (input.blobId ?? null),
      tombstone: !!input.deleted,
      revision: String(version),
      clientId: input.actor.clientId,
      operationId: input.actor.operationId,
      serverTime: new Date().toISOString(),
      conflictOf: input.conflictOf ?? null,
      conflictOperationId: input.kind === "markdown" ? null : null,
    };
    this.revisions.push(rec);
    this.entries.set(input.entryId, {
      entryId: input.entryId,
      path: input.path,
      pathKey: input.pathKey,
      kind: input.kind,
      version,
      seq,
      deleted: !!input.deleted,
      textSha: rec.textSha256 ?? undefined,
      blobId: rec.blobId ?? undefined,
      conflictOf: input.conflictOf,
    });
    return rec;
  }

  private revBySeq(seq: string): RevisionRecord {
    return this.revisions.find((r) => r.seq === seq)!;
  }
}

export { seqZero };
