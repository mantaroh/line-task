// Range ヘッダーの解釈。1 つの範囲だけに応え、複数の範囲は全体を返す（RFC 9110 で許される）。
export type RangeResult = { kind: "full" } | { kind: "partial"; offset: number; length: number } | { kind: "invalid" };

export function parseRange(header: string | undefined | null, size: number): RangeResult {
  if (!header) return { kind: "full" };
  const m = header.trim().match(/^bytes=(.*)$/);
  if (!m || m[1].includes(",")) return { kind: "full" };
  const r = m[1].trim().match(/^(\d*)-(\d*)$/);
  if (!r || (r[1] === "" && r[2] === "")) return { kind: "invalid" };
  if (r[1] === "") {
    const suffix = Number(r[2]);
    if (suffix === 0 || size === 0) return { kind: "invalid" };
    const length = Math.min(suffix, size);
    return { kind: "partial", offset: size - length, length };
  }
  const start = Number(r[1]);
  const end = r[2] === "" ? size - 1 : Math.min(Number(r[2]), size - 1);
  if (start >= size || end < start) return { kind: "invalid" };
  return { kind: "partial", offset: start, length: end - start + 1 };
}
