import { useEffect, useState } from "react";
import type { InvitePreview } from "../../shared/types";
import { api, ApiError } from "../api";
import { ErrorView } from "../components/ErrorView";
import { BottomBar } from "../components/BottomBar";
import { Header } from "../components/Header";
import { Loading } from "../components/Loading";

const STATUS_TEXT: Record<Exclude<InvitePreview["status"], "valid">, string> = {
  expired: "この招待リンクは期限切れです",
  revoked: "この招待リンクは取り消されています",
  archived: "このプロジェクトはアーカイブされています",
};

export function Invite({
  token,
  onOpen,
  onBack,
}: {
  token: string;
  onOpen: (pid: string) => void;
  onBack: () => void;
}) {
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<InvitePreview>("GET", `/api/invites/${encodeURIComponent(token)}`)
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function onAccept() {
    setAcceptError(null);
    setBusy(true);
    try {
      const res = await api<{ projectId: string }>("POST", `/api/invites/${encodeURIComponent(token)}/accept`);
      onOpen(res.projectId);
    } catch (e) {
      setAcceptError(e instanceof ApiError ? e.message : "エラーが発生しました");
    } finally {
      setBusy(false);
    }
  }

  if (error instanceof ApiError && error.status === 404) {
    return (
      <>
        <Header title="招待" />
        <main className="main">
          <p>招待リンクが見つかりません</p>
        </main>
        <BottomBar onBack={onBack} />
      </>
    );
  }
  if (error) return <ErrorView error={error} />;
  if (!preview) return <Loading />;

  if (preview.status !== "valid") {
    return (
      <>
        <Header title="招待" />
        <main className="main">
          <p>{STATUS_TEXT[preview.status]}</p>
        </main>
        <BottomBar onBack={onBack} />
      </>
    );
  }

  return (
    <>
      <Header title="招待" />
      <main className="main">
        <p>
          {preview.invitedBy}さんから『{preview.projectName}』に招待されています
        </p>
        {acceptError ? <p className="error">{acceptError}</p> : null}
        {preview.alreadyMember ? (
          <button type="button" className="btn btn-primary" onClick={() => onOpen(preview.projectId)}>
            開く
          </button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={onAccept} disabled={busy}>
            参加する
          </button>
        )}
      </main>
      <BottomBar onBack={onBack} />
    </>
  );
}
