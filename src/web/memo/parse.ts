// メモの簡単な書式（リンク・太字・箇条書き）を分ける。シートには文字のまま入るので、記号は Markdown に合わせる。
// 表示は React の要素で組み立てる（HTML として描かない）。

export type Inline =
  | { type: "text"; text: string }
  | { type: "bold"; children: Inline[] }
  | { type: "link"; text: string; href: string };

export type Block = { type: "paragraph"; lines: Inline[][] } | { type: "list"; items: Inline[][] };

// 開くのは http・https だけ。それ以外（javascript: など）はリンクにしない
export function safeHref(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
}

const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/y;
const URL_START = /https?:\/\//y;
// URL の後ろに付きやすい句読点・閉じかっこは URL に含めない
const URL_TAIL = /[.,;:!?。、，．）」』)\]]+$/;

function pushText(out: Inline[], text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last?.type === "text") last.text += text;
  else out.push({ type: "text", text });
}

export function parseInline(src: string, allowBold = true): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] === "[") {
      LINK.lastIndex = i;
      const m = LINK.exec(src);
      if (m) {
        const href = safeHref(m[2]);
        if (href) out.push({ type: "link", text: m[1], href });
        else pushText(out, m[0]);
        i += m[0].length;
        continue;
      }
    }
    // 開く ** の直後と閉じる ** の直前が空白なら太字にしない（Markdown と同じ）
    if (allowBold && src.startsWith("**", i) && /\S/.test(src[i + 2] ?? "")) {
      let end = src.indexOf("**", i + 3);
      while (end !== -1 && /\s/.test(src[end - 1])) end = src.indexOf("**", end + 1);
      if (end !== -1) {
        out.push({ type: "bold", children: parseInline(src.slice(i + 2, end), false) });
        i = end + 2;
        continue;
      }
    }
    URL_START.lastIndex = i;
    if (URL_START.test(src)) {
      // URL に使える ASCII の文字だけを続ける（全角の句読点などで止める）
      const rest = src.slice(i).match(/^[A-Za-z0-9\-._~:/?#@!$&*+,;=%()]+/)![0];
      const url = rest.replace(URL_TAIL, "");
      const href = safeHref(url);
      if (href) {
        out.push({ type: "link", text: url, href });
        i += url.length;
        continue;
      }
    }
    pushText(out, src[i]);
    i += 1;
  }
  return out;
}

// 「・」は空白なしでも箇条書きにする
const LIST_ITEM = /^\s*(?:[-*]\s+|・\s*)(.*)$/;

export function parseMemo(src: string): Block[] {
  const blocks: Block[] = [];
  for (const line of src.replace(/\r\n?/g, "\n").split("\n")) {
    const last = blocks[blocks.length - 1];
    if (line.trim() === "") {
      if (last) blocks.push({ type: "paragraph", lines: [] });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      if (last?.type === "list") last.items.push(parseInline(item[1]));
      else blocks.push({ type: "list", items: [parseInline(item[1])] });
    } else if (last?.type === "paragraph") {
      last.lines.push(parseInline(line));
    } else {
      blocks.push({ type: "paragraph", lines: [parseInline(line)] });
    }
  }
  // 空行で作った空の段落は捨てる
  return blocks.filter((b) => b.type === "list" || b.lines.length > 0);
}
