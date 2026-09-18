const SEQ_RE = /^[0-9]+$/;

export type Seq = string;

export function seqFromBigInt(value: bigint): Seq {
  if (value < 0n) {
    throw new RangeError("sequence must be non-negative");
  }
  return value.toString(10);
}

export function seqToBigInt(seq: Seq): bigint {
  if (typeof seq !== "string" || !SEQ_RE.test(seq)) {
    throw new RangeError(`invalid sequence cursor: ${String(seq)}`);
  }
  return BigInt(seq);
}

export function compareSeq(a: Seq, b: Seq): number {
  const left = seqToBigInt(a);
  const right = seqToBigInt(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function maxSeq(a: Seq, b: Seq): Seq {
  return compareSeq(a, b) >= 0 ? a : b;
}

export function seqZero(): Seq {
  return "0";
}
