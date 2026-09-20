// A1 表記のユーティリティ（列の変換・シート名の引用・範囲の組み立てと分解）。

export function colLetter(index0: number): string {
  let n = index0 + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function quoteSheet(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

export function rangeOf(sheet: string, a1: string): string {
  return `${quoteSheet(sheet)}!${a1}`;
}

export type ParsedRange = {
  sheet: string;
  startCol: number;
  startRow: number;
  endCol: number | null;
  endRow: number | null;
};

const SHEET_PREFIX = /^'((?:[^']|'')+)'!/;
const ROW_ONLY = /^(\d+):(\d+)$/;
const CELL_RANGE = /^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/;

export function parseRange(range: string): ParsedRange {
  const prefixMatch = SHEET_PREFIX.exec(range);
  if (!prefixMatch) throw new Error(`invalid range: ${range}`);
  const sheet = prefixMatch[1].replace(/''/g, "'");
  const rest = range.slice(prefixMatch[0].length);

  const rowOnly = ROW_ONLY.exec(rest);
  if (rowOnly) {
    return {
      sheet,
      startCol: 0,
      startRow: Number(rowOnly[1]) - 1,
      endCol: null,
      endRow: Number(rowOnly[2]) - 1,
    };
  }

  const cell = CELL_RANGE.exec(rest);
  if (!cell) throw new Error(`invalid range: ${range}`);
  const [, startColLetters, startRowDigits, endColLetters, endRowDigits] = cell;
  const startCol = colIndex(startColLetters);
  const startRow = startRowDigits ? Number(startRowDigits) - 1 : 0;

  if (endColLetters === undefined) {
    return { sheet, startCol, startRow, endCol: startCol, endRow: startRow };
  }
  const endCol = colIndex(endColLetters);
  const endRow = endRowDigits ? Number(endRowDigits) - 1 : null;
  return { sheet, startCol, startRow, endCol, endRow };
}
