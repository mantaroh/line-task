import type { ReactNode } from "react";

// 保存していない入力があるときは、戻る前に確認する
export function confirmBack(dirty: boolean, onBack: () => void): void {
  if (dirty && !window.confirm("保存していない変更があります。戻りますか？")) return;
  onBack();
}

// LINE の画面では右上に「×」（閉じる）が常にあるので、押す操作は画面下にまとめる
export function BottomBar({ onBack, children }: { onBack?: () => void; children?: ReactNode }) {
  return (
    <nav className="bottom-bar" aria-label="操作">
      <div className="bottom-bar-inner">
        {onBack ? (
          <button type="button" className="btn bottom-bar-back" onClick={onBack} aria-label="戻る">
            ← 戻る
          </button>
        ) : null}
        {children}
      </div>
    </nav>
  );
}
