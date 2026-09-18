export type MergeResult =
  | { kind: "clean"; text: string }
  | { kind: "conflict"; reason: "overlap" | "frontmatter" | "no_base" };

function splitLines(text: string): string[] {
  return text.split(/(?<=\n)/);
}

function frontmatterRegion(text: string): string | null {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return null;
  const rest = text.slice(text.startsWith("---\r\n") ? 5 : 4);
  const endLf = rest.indexOf("\n---");
  if (endLf === -1) return null;
  return text.slice(0, (text.startsWith("---\r\n") ? 5 : 4) + endLf + 4);
}

export function mergeMarkdown(base: string | null, local: string, remote: string): MergeResult {
  if (local === remote) return { kind: "clean", text: local };
  if (base === null) return { kind: "conflict", reason: "no_base" };
  if (local === base) return { kind: "clean", text: remote };
  if (remote === base) return { kind: "clean", text: local };

  const localFm = frontmatterRegion(local);
  const remoteFm = frontmatterRegion(remote);
  const baseFm = frontmatterRegion(base);
  if (localFm && remoteFm && baseFm && localFm !== baseFm && remoteFm !== baseFm && localFm !== remoteFm) {
    return { kind: "conflict", reason: "frontmatter" };
  }

  const baseLines = splitLines(base);
  const localLines = splitLines(local);
  const remoteLines = splitLines(remote);
  const merged = diff3(baseLines, localLines, remoteLines);
  if (!merged) return { kind: "conflict", reason: "overlap" };
  return { kind: "clean", text: merged.join("") };
}

function lcsMap(a: string[], b: string[]): Map<number, number> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  const map = new Map<number, number>();
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      map.set(i - 1, j - 1);
      i--;
      j--;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) i--;
    else j--;
  }
  return map;
}

function diff3(base: string[], local: string[], remote: string[]): string[] | null {
  const aMap = lcsMap(base, local);
  const bMap = lcsMap(base, remote);
  const out: string[] = [];
  let ia = 0;
  let ib = 0;
  let iBase = 0;
  const stable: number[] = [];
  for (let i = 0; i < base.length; i++) {
    if (aMap.has(i) && bMap.has(i)) stable.push(i);
  }
  stable.push(base.length);
  for (const i of stable) {
    const localIdx = i === base.length ? local.length : aMap.get(i)!;
    const remoteIdx = i === base.length ? remote.length : bMap.get(i)!;
    const baseSlice = base.slice(iBase, i);
    const localSlice = local.slice(ia, localIdx);
    const remoteSlice = remote.slice(ib, remoteIdx);
    if (slicesEqual(localSlice, remoteSlice)) {
      out.push(...localSlice);
    } else if (slicesEqual(localSlice, baseSlice)) {
      out.push(...remoteSlice);
    } else if (slicesEqual(remoteSlice, baseSlice)) {
      out.push(...localSlice);
    } else {
      return null;
    }
    if (i < base.length) out.push(base[i]!);
    ia = localIdx + (i < base.length ? 1 : 0);
    ib = remoteIdx + (i < base.length ? 1 : 0);
    iBase = i + 1;
  }
  return out;
}

function slicesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((line, idx) => line === b[idx]);
}
