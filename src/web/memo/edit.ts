// メモの書式ボタン。入力欄の文字と選択範囲を受け取り、書き換えた文字と新しい選択範囲を返す。
export type Edited = { value: string; start: number; end: number };

const BOLD_PLACEHOLDER = "太字";

export function applyBold(value: string, start: number, end: number): Edited {
  if (value.slice(start - 2, start) === "**" && value.slice(end, end + 2) === "**" && end > start) {
    return { value: value.slice(0, start - 2) + value.slice(start, end) + value.slice(end + 2), start: start - 2, end: end - 2 };
  }
  const inner = end > start ? value.slice(start, end) : BOLD_PLACEHOLDER;
  return {
    value: `${value.slice(0, start)}**${inner}**${value.slice(end)}`,
    start: start + 2,
    end: start + 2 + inner.length,
  };
}

const LIST_PREFIX = /^\s*(?:[-*]\s+|・\s*)/;

export function applyList(value: string, start: number, end: number): Edited {
  const from = value.lastIndexOf("\n", start - 1) + 1;
  const nl = value.indexOf("\n", end > start ? end - 1 : end);
  const to = nl === -1 ? value.length : nl;
  const lines = value.slice(from, to).split("\n");
  const filled = lines.filter((l) => l.trim() !== "");
  const allListed = filled.length > 0 && filled.every((l) => LIST_PREFIX.test(l));
  const next = lines
    .map((l) => (l.trim() === "" ? l : allListed ? l.replace(LIST_PREFIX, "") : `- ${l}`))
    .join("\n");
  return { value: value.slice(0, from) + next + value.slice(to), start: from, end: from + next.length };
}

export function applyLink(value: string, start: number, end: number, url: string): Edited {
  const label = value.slice(start, end).replace(/[[\]\n]/g, "").trim();
  const text = label ? `[${label}](${url})` : url;
  const pos = start + text.length;
  return { value: value.slice(0, start) + text + value.slice(end), start: pos, end: pos };
}
