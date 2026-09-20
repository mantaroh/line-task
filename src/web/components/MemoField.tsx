import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { openExternal } from "../liff";
import { applyBold, applyLink, applyList, type Edited } from "../memo/edit";
import { parseMemo, safeHref, type Inline } from "../memo/parse";

function renderInline(parts: Inline[], keyPrefix: string): ReactNode[] {
  return parts.map((p, i) => {
    const key = `${keyPrefix}-${i}`;
    if (p.type === "text") return <span key={key}>{p.text}</span>;
    if (p.type === "bold") return <strong key={key}>{renderInline(p.children, key)}</strong>;
    const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
      // LINE の中のブラウザで開かず、外部ブラウザで開く
      e.preventDefault();
      openExternal(p.href);
    };
    return (
      <a key={key} href={p.href} target="_blank" rel="noopener noreferrer" onClick={onClick}>
        {p.text}
      </a>
    );
  });
}

export function MemoView({ value }: { value: string }) {
  const blocks = parseMemo(value);
  if (blocks.length === 0) return <p className="memo-empty">未入力</p>;
  return (
    <div className="memo-view">
      {blocks.map((b, i) =>
        b.type === "list" ? (
          <ul key={i}>
            {b.items.map((item, j) => (
              <li key={j}>{renderInline(item, `${i}-${j}`)}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>
            {b.lines.map((line, j) => (
              <span key={j}>
                {j > 0 ? <br /> : null}
                {renderInline(line, `${i}-${j}`)}
              </span>
            ))}
          </p>
        ),
      )}
    </div>
  );
}

export function MemoField({
  id,
  label,
  value,
  maxLength,
  disabled = false,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  maxLength: number;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const pendingSelection = useRef<{ start: number; end: number } | null>(null);
  // リンクの URL を入力している間も、押したときの選択範囲を覚えておく
  const savedSelection = useRef<{ start: number; end: number }>({ start: 0, end: 0 });

  useEffect(() => {
    if (disabled) {
      setEditing(false);
      setLinkUrl(null);
    }
  }, [disabled]);

  useEffect(() => {
    const el = areaRef.current;
    const sel = pendingSelection.current;
    if (!el || !sel) return;
    pendingSelection.current = null;
    el.focus();
    el.setSelectionRange(sel.start, sel.end);
  });

  function selection() {
    const el = areaRef.current;
    return el ? { start: el.selectionStart, end: el.selectionEnd } : { start: value.length, end: value.length };
  }

  function apply(edited: Edited) {
    if (edited.value.length > maxLength) {
      setHint(`メモは ${maxLength} 文字までです`);
      return;
    }
    setHint(null);
    pendingSelection.current = { start: edited.start, end: edited.end };
    onChange(edited.value);
  }

  function onLinkAdd() {
    const href = safeHref((linkUrl ?? "").trim());
    if (!href) {
      setHint("http:// か https:// で始まる URL を入れてください");
      return;
    }
    const { start, end } = savedSelection.current;
    setLinkUrl(null);
    apply(applyLink(value, start, end, (linkUrl ?? "").trim()));
  }

  return (
    <div className="field memo-field">
      <div className="memo-head">
        {editing ? <label htmlFor={id}>{label}</label> : <span>{label}</span>}
        {!disabled ? (
          <button
            type="button"
            className="btn memo-toggle"
            onClick={() => {
              setEditing((v) => !v);
              setLinkUrl(null);
              setHint(null);
            }}
          >
            {editing ? "完了" : "✏️ 編集"}
          </button>
        ) : null}
      </div>
      {editing ? (
        <>
          <div className="memo-toolbar" role="toolbar" aria-label="メモの書式">
            <button
              type="button"
              className="btn"
              aria-label="太字"
              onClick={() => {
                const s = selection();
                apply(applyBold(value, s.start, s.end));
              }}
            >
              <strong>B</strong>
            </button>
            <button
              type="button"
              className="btn"
              aria-label="箇条書き"
              onClick={() => {
                const s = selection();
                apply(applyList(value, s.start, s.end));
              }}
            >
              • 箇条書き
            </button>
            <button
              type="button"
              className="btn"
              aria-label="リンク"
              onClick={() => {
                savedSelection.current = selection();
                setHint(null);
                setLinkUrl((v) => (v === null ? "https://" : null));
              }}
            >
              🔗 リンク
            </button>
          </div>
          {linkUrl !== null ? (
            <div className="memo-link-form">
              <input
                type="url"
                inputMode="url"
                aria-label="リンクの URL"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    // フォーム全体を送らない
                    e.preventDefault();
                    onLinkAdd();
                  }
                }}
                autoFocus
              />
              <button type="button" className="btn" onClick={onLinkAdd}>
                追加
              </button>
            </div>
          ) : null}
          <textarea
            id={id}
            ref={areaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            maxLength={maxLength}
            rows={6}
          />
          <p className="hint">選んだ文字に書式を付けられます。保存は下の「保存」で行います</p>
          {hint ? <p className="error">{hint}</p> : null}
        </>
      ) : (
        <MemoView value={value} />
      )}
    </div>
  );
}
