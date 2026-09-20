import { useEffect, useState } from "react";
import type { InviteSummary } from "../../shared/types";
import { api, ApiError } from "../api";
import { shareMessage } from "../liff";
import { CopyButton } from "./CopyButton";

const DAYS = [1, 7, 30] as const;
type Days = (typeof DAYS)[number];

function formatAt(at: string): string {
  const m = at.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : at;
}

export function InviteSection({
  pid,
  projectName,
  archived,
  canShare,
  onChanged,
}: {
  pid: string;
  projectName: string;
  archived: boolean;
  canShare: boolean;
  onChanged?: () => void;
}) {
  const [days, setDays] = useState<Days>(7);
  const [invites, setInvites] = useState<InviteSummary[] | null>(null);
  const [issued, setIssued] = useState<{ id: string; url: string } | null>(null);
  const [showShare, setShowShare] = useState(canShare);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setInvites(await api<InviteSummary[]>("GET", `/api/projects/${pid}/invites`));
  }

  useEffect(() => {
    let cancelled = false;
    api<InviteSummary[]>("GET", `/api/projects/${pid}/invites`)
      .then((list) => {
        if (!cancelled) setInvites(list);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : "エラーが発生しました");
      });
    return () => {
      cancelled = true;
    };
  }, [pid]);

  async function onIssue() {
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ id: string; url: string; expiresAt: string }>(
        "POST",
        `/api/projects/${pid}/invites`,
        { days },
      );
      setIssued({ id: res.id, url: res.url });
      setShowShare(canShare);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "エラーが発生しました");
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(id: string) {
    setError(null);
    setBusy(true);
    try {
      await api<void>("DELETE", `/api/projects/${pid}/invites/${id}`);
      if (issued?.id === id) setIssued(null);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "エラーが発生しました");
    } finally {
      setBusy(false);
    }
  }

  async function onShare() {
    if (!issued) return;
    const ok = await shareMessage(`『${projectName}』に招待します\n${issued.url}`);
    if (!ok) setShowShare(false);
  }

  return (
    <div>
      {!archived ? (
        <>
          <div className="field">
            <label htmlFor="invite-days">有効期限</label>
            <select
              id="invite-days"
              value={days}
              onChange={(e) => setDays(Number(e.target.value) as Days)}
              disabled={busy}
            >
              {DAYS.map((d) => (
                <option key={d} value={d}>
                  {d}日
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <button type="button" className="btn btn-primary" onClick={onIssue} disabled={busy}>
              発行
            </button>
          </div>
        </>
      ) : null}

      {issued && !archived ? (
        <div className="invite-issued">
          <input type="text" readOnly value={issued.url} aria-label="招待 URL" className="invite-url" />
          <div className="actions">
            {showShare ? (
              <button type="button" className="btn" onClick={onShare}>
                LINE で送る
              </button>
            ) : null}
            <CopyButton text={issued.url} />
          </div>
        </div>
      ) : null}

      {error ? <p className="error">{error}</p> : null}

      {invites === null ? (
        <p className="muted">読み込み中…</p>
      ) : invites.length === 0 ? (
        <p className="muted">有効な招待はありません</p>
      ) : (
        <ul className="invite-list">
          {invites.map((inv) => (
            <li key={inv.id} className="invite-row">
              <div className="invite-info">
                <div>{inv.createdBy.displayName}</div>
                <div className="muted">
                  期限 {formatAt(inv.expiresAt)} ・{inv.useCount} 回
                </div>
              </div>
              {!archived ? (
                <button type="button" className="btn" onClick={() => onRevoke(inv.id)} disabled={busy}>
                  取り消す
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
