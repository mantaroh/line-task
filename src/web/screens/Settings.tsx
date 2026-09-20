import { useEffect, useState, type FormEvent } from "react";
import type { ActivityItem, ProjectDetail } from "../../shared/types";
import { api, ApiError } from "../api";
import { ActivityList } from "../components/ActivityList";
import { CopyButton } from "../components/CopyButton";
import { ErrorView } from "../components/ErrorView";
import { BottomBar } from "../components/BottomBar";
import { Header } from "../components/Header";
import { InviteSection } from "../components/InviteSection";
import { Loading } from "../components/Loading";
import { MemberList } from "../components/MemberList";
import { NotificationSection } from "../components/NotificationSection";
import { PartiesEditor } from "../components/PartiesEditor";
import { SheetSetup } from "../components/SheetSetup";
import { openExternal } from "../liff";

const ACTIVITY_PAGE = 50;

export function Settings({
  pid,
  lineUserId,
  canShare,
  serviceAccountEmail,
  onBack,
  onLeft,
}: {
  pid: string;
  lineUserId: string;
  canShare: boolean;
  serviceAccountEmail: string;
  onBack: () => void;
  onLeft: () => void;
}) {
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [name, setName] = useState("");
  const [parties, setParties] = useState<string[]>([]);
  const [activity, setActivity] = useState<ActivityItem[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const [reconnect, setReconnect] = useState(false);
  const [sheetSyncError, setSheetSyncError] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activityTick, setActivityTick] = useState(0);

  function applyProject(p: ProjectDetail) {
    setProject(p);
    setName(p.name);
    setParties(p.parties);
  }

  function onSheetBound() {
    setReconnect(false);
    api<ProjectDetail>("GET", `/api/projects/${pid}`).then(applyProject);
    setActivityTick((n) => n + 1);
  }

  useEffect(() => {
    let cancelled = false;
    api<ProjectDetail>("GET", `/api/projects/${pid}`)
      .then((p) => {
        if (!cancelled) applyProject(p);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [pid]);

  useEffect(() => {
    let cancelled = false;
    api<ActivityItem[]>("GET", `/api/projects/${pid}/activity`)
      .then((items) => {
        if (cancelled) return;
        setActivity(items);
        setHasMore(items.length === ACTIVITY_PAGE);
      })
      .catch(() => {
        if (!cancelled) setActivity([]);
      });
    return () => {
      cancelled = true;
    };
  }, [pid, activityTick]);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!project) return;
    const nextName = name.trim();
    const nextParties = parties.map((p) => p.trim());
    const body: { name?: string; parties?: string[] } = {};
    if (nextName !== project.name) body.name = nextName;
    if (JSON.stringify(nextParties) !== JSON.stringify(project.parties)) body.parties = nextParties;
    if (!body.name && !body.parties) return;
    setFormError(null);
    setBusy(true);
    try {
      const res = await api<ProjectDetail & { sheetSynced?: boolean }>("PATCH", `/api/projects/${pid}`, body);
      applyProject(res);
      if (res.sheetSynced === false) setSheetSyncError(true);
      else if (res.sheetSynced === true) setSheetSyncError(false);
      setActivityTick((n) => n + 1);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "エラーが発生しました");
    } finally {
      setBusy(false);
    }
  }

  async function onRemoveMember(uid: string) {
    setFormError(null);
    setBusy(true);
    try {
      await api<void>("DELETE", `/api/projects/${pid}/members/${encodeURIComponent(uid)}`);
      if (uid === lineUserId) {
        onLeft();
        return;
      }
      applyProject(await api<ProjectDetail>("GET", `/api/projects/${pid}`));
      setActivityTick((n) => n + 1);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "エラーが発生しました");
    } finally {
      setBusy(false);
    }
  }

  async function onArchive() {
    if (!window.confirm("アーカイブしますか？見るだけになります。")) return;
    setFormError(null);
    setBusy(true);
    try {
      applyProject(await api<ProjectDetail>("POST", `/api/projects/${pid}/archive`));
      setReconnect(false);
      setActivityTick((n) => n + 1);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "エラーが発生しました");
    } finally {
      setBusy(false);
    }
  }

  async function onUnarchive() {
    if (!window.confirm("アーカイブを戻しますか？")) return;
    setFormError(null);
    setBusy(true);
    try {
      applyProject(await api<ProjectDetail>("POST", `/api/projects/${pid}/unarchive`));
      setActivityTick((n) => n + 1);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "エラーが発生しました");
    } finally {
      setBusy(false);
    }
  }

  async function onMore() {
    if (!activity || activity.length === 0) return;
    setMoreBusy(true);
    try {
      const last = activity[activity.length - 1];
      const items = await api<ActivityItem[]>("GET", `/api/projects/${pid}/activity?before=${last.id}`);
      setActivity((prev) => (prev ? [...prev, ...items] : items));
      setHasMore(items.length === ACTIVITY_PAGE);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "エラーが発生しました");
    } finally {
      setMoreBusy(false);
    }
  }

  if (error) return <ErrorView error={error} />;
  if (!project) return <Loading />;

  const archived = project.archivedAt !== null;
  const connected = project.spreadsheetId !== null;

  return (
    <>
      <Header title="設定" />
      <main className="main">
        {archived ? <p className="banner">アーカイブ済み（見るだけ）</p> : null}
        {formError ? <p className="error">{formError}</p> : null}

        <NotificationSection
          pid={pid}
          parties={project.parties}
          archived={archived}
          onChanged={() => {
            // メンバー一覧の側だけ更新する（編集中の名前・関係者は残す）。失敗しても次に開いたときに直る
            api<ProjectDetail>("GET", `/api/projects/${pid}`).then(
              (p) => setProject((cur) => (cur ? { ...cur, members: p.members } : p)),
              () => {},
            );
          }}
        />

        <section className="settings-section">
          <h2>プロジェクト</h2>
          <form onSubmit={onSave}>
            <div className="field">
              <label htmlFor="project-name">名前</label>
              <input
                id="project-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={40}
                required
                disabled={archived || busy}
              />
            </div>
            <PartiesEditor parties={parties} onChange={setParties} disabled={archived || busy} />
            {sheetSyncError ? <p className="error">シートの関係者を更新できませんでした</p> : null}
            {!archived ? (
              <button type="submit" className="btn btn-primary" disabled={busy}>
                保存
              </button>
            ) : null}
          </form>
        </section>

        <section className="settings-section">
          <h2>URL</h2>
          <p className="muted">トークのノートに貼っておくと開きやすくなります</p>
          <CopyButton text={project.appUrl} label="このプロジェクトの URL をコピー" />
        </section>

        <section className="settings-section">
          <h2>シート</h2>
          {!connected ? (
            archived ? (
              <p className="muted">シートがまだつながっていません</p>
            ) : (
              <SheetSetup pid={pid} serviceAccountEmail={serviceAccountEmail} onBound={onSheetBound} />
            )
          ) : (
            <>
              {project.spreadsheetUrl ? (
                <div className="actions">
                  <button type="button" className="btn" onClick={() => openExternal(project.spreadsheetUrl!)}>
                    シートを開く
                  </button>
                  {!archived ? (
                    <button type="button" className="btn" onClick={() => setReconnect((v) => !v)}>
                      つなぎ替える
                    </button>
                  ) : null}
                </div>
              ) : null}
              {reconnect && !archived ? (
                <SheetSetup
                  pid={pid}
                  serviceAccountEmail={serviceAccountEmail}
                  onBound={onSheetBound}
                  onSkip={() => setReconnect(false)}
                />
              ) : null}
            </>
          )}
        </section>

        <section className="settings-section">
          <h2>招待</h2>
          <InviteSection
            pid={pid}
            projectName={project.name}
            archived={archived}
            canShare={canShare}
            onChanged={() => setActivityTick((n) => n + 1)}
          />
        </section>

        <section className="settings-section">
          <h2>メンバー</h2>
          <MemberList
            members={project.members}
            lineUserId={lineUserId}
            archived={archived}
            onRemove={onRemoveMember}
          />
        </section>

        <section className="settings-section">
          <h2>アーカイブ</h2>
          {archived ? (
            <button type="button" className="btn btn-primary" onClick={onUnarchive} disabled={busy}>
              戻す
            </button>
          ) : (
            <button type="button" className="btn" onClick={onArchive} disabled={busy}>
              アーカイブする
            </button>
          )}
        </section>

        <section className="activity-section">
          <h2>活動記録</h2>
          {activity ? (
            <ActivityList
              items={activity}
              onMore={hasMore ? onMore : undefined}
              moreBusy={moreBusy}
            />
          ) : (
            <Loading />
          )}
        </section>
      </main>
      <BottomBar onBack={onBack} />
    </>
  );
}
