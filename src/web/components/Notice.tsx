import type { ReactNode } from "react";

export function Notice({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div className="notice" role="status">
      <p>{children}</p>
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        閉じる
      </button>
    </div>
  );
}
