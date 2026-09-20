import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api";
import type { ProjectDetail } from "../../shared/types";
import { CopyButton } from "./CopyButton";

export function SheetSetup({
  pid,
  serviceAccountEmail,
  onBound,
  onSkip,
}: {
  pid: string;
  serviceAccountEmail: string;
  onBound: () => void;
  onSkip?: () => void;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api<ProjectDetail>("POST", `/api/projects/${pid}/sheet`, { url });
      onBound();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "エラーが発生しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <ol className="steps">
        <li>自分のドライブで空のスプレッドシートを作る</li>
        <li>
          サービスアカウント（<span className="email">{serviceAccountEmail}</span>）に編集者で共有
          <div className="sa-row">
            <CopyButton text={serviceAccountEmail} />
          </div>
        </li>
        <li>
          URL を貼る
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://docs.google.com/spreadsheets/d/…"
            required
            aria-label="スプレッドシートの URL"
          />
        </li>
      </ol>
      {error ? <p className="error">{error}</p> : null}
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          つなぐ
        </button>
        {onSkip ? (
          <button type="button" className="btn" onClick={onSkip} disabled={busy}>
            あとでつなぐ
          </button>
        ) : null}
      </div>
    </form>
  );
}
