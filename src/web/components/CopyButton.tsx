import { useState } from "react";

type Text = string | (() => Promise<string | null>);

// 非同期で文字列を作る場合も、押した操作の中でコピーを始める（iOS は await の後だと拒否するため）
async function writeClipboard(text: string | null, pending: Promise<string | null>): Promise<string | null> {
  if (text !== null) {
    await navigator.clipboard.writeText(text);
    return text;
  }
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
    const blob = pending.then((t) => {
      if (t === null) throw new Error("no text");
      return new Blob([t], { type: "text/plain" });
    });
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
    return pending;
  }
  const t = await pending;
  if (t !== null) await navigator.clipboard.writeText(t);
  return t;
}

export function CopyButton({
  text,
  label = "コピー",
  disabled = false,
}: {
  text: Text;
  label?: string;
  disabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);

  async function onClick() {
    setFallback(null);
    // 文字列を作る処理（ID の割り当てなど）は 1 回だけ呼ぶ
    const pending = typeof text === "string" ? Promise.resolve(text) : text();
    try {
      const done = await writeClipboard(typeof text === "string" ? text : null, pending);
      if (done === null) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
      // LINE の中ではコピーが拒否されることがある。長押しでコピーできるように出す
      const t = await pending.catch(() => null);
      if (t !== null) setFallback(t);
    }
  }

  return (
    <div className="copy-button">
      <button type="button" className="btn" disabled={disabled} onClick={onClick}>
        {copied ? "コピーした" : label}
      </button>
      {fallback !== null ? (
        <>
          <p className="hint">コピーできませんでした。下を長押ししてコピーしてください</p>
          <textarea
            className="copy-fallback"
            readOnly
            value={fallback}
            rows={fallback.split("\n").length}
            onFocus={(e) => e.currentTarget.select()}
          />
        </>
      ) : null}
    </div>
  );
}
