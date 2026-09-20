import { useEffect, useMemo, useState } from "react";
import { countTasks, filterTasks, groupByBall, type Tab } from "../../shared/taskView";
import type { ProjectDetail, TasksResponse } from "../../shared/types";
import { api, ApiError } from "../api";
import { ErrorView } from "../components/ErrorView";
import { BottomBar } from "../components/BottomBar";
import { Header } from "../components/Header";
import { Loading } from "../components/Loading";
import { Tabs } from "../components/Tabs";
import { TaskRow } from "../components/TaskRow";

export function Project({
  pid,
  lineUserId,
  tab,
  onBack,
  onTab,
  onSettings,
  onTask,
  onNew,
}: {
  pid: string;
  lineUserId: string;
  tab: Tab;
  onBack: () => void;
  onTab: (tab: Tab) => void;
  onSettings: () => void;
  onTask: (ref: string) => void;
  onNew: () => void;
}) {
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [tasksRes, setTasksRes] = useState<TasksResponse | null>(null);
  const [assignee, setAssignee] = useState<string>("");
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await api<ProjectDetail>("GET", `/api/projects/${pid}`);
        if (cancelled) return;
        setProject(p);
        if (!p.spreadsheetId) {
          setTasksRes(null);
          return;
        }
        const list = await api<TasksResponse>("GET", `/api/projects/${pid}/tasks?status=all`);
        if (!cancelled) setTasksRes(list);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.code === "sheet_not_connected") {
          setTasksRes(null);
          return;
        }
        setError(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pid]);

  const assignees = useMemo(() => {
    if (!tasksRes) return [];
    const names = new Set<string>();
    for (const t of tasksRes.tasks) {
      const a = t.assignee.trim();
      if (a) names.add(a);
    }
    return [...names].sort();
  }, [tasksRes]);

  if (error) return <ErrorView error={error} />;
  if (!project) return <Loading />;

  const archived = project.archivedAt !== null;
  const connected = project.spreadsheetId !== null;
  const counts = tasksRes ? countTasks(tasksRes.tasks, tasksRes.today) : { open: 0, overdue: 0 };
  const filtered =
    tasksRes && connected
      ? filterTasks(tasksRes.tasks, tab, assignee === "" ? null : assignee, tasksRes.today)
      : [];
  // 設定画面で選んだ「自分の側」のグループを一番上にする
  const myParty = project.members.find((m) => m.lineUserId === lineUserId)?.party ?? null;
  const groups = tasksRes ? groupByBall(filtered, tasksRes.parties, myParty) : [];

  return (
    <>
      <Header title={project.name} />
      <main className="main main-wide">
        {archived ? <p className="banner">アーカイブ済み（見るだけ）</p> : null}
        {!connected ? (
          <div className="actions">
            <p>シートがまだつながっていません</p>
            <button type="button" className="btn btn-primary" onClick={onSettings}>
              設定
            </button>
          </div>
        ) : !tasksRes ? (
          <Loading />
        ) : (
          <>
            <div className="list-controls">
              <Tabs
                tabs={[
                  { id: "open" as const, label: `未完了 ${counts.open}` },
                  { id: "overdue" as const, label: `期限切れ ${counts.overdue}` },
                  { id: "done" as const, label: "完了" },
                ]}
                value={tab}
                onChange={onTab}
              />
              <div className="field">
                <label htmlFor="assignee-filter">担当</label>
                <select
                  id="assignee-filter"
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                >
                  <option value="">全員</option>
                  {assignees.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {groups.length === 0 ? (
              <p className="muted">{tasksRes.tasks.length === 0 ? "タスクはまだありません" : "該当するタスクはありません"}</p>
            ) : (
              // PC ではボールごとの列にする（styles.css の .ball-groups）
              <div className="ball-groups">
                {groups.map((g) => (
                  <section key={g.ball} className="ball-group">
                    <h2 className="ball-heading">
                      {g.ball === "その他" ? "その他・ボール未設定" : `${g.ball}の番`}
                      {g.ball === myParty ? "・あなた" : ""}（{g.tasks.length}）
                    </h2>
                    <ul className="task-list">
                      {g.tasks.map((t) => (
                        <li key={t.ref}>
                          <TaskRow
                            task={t}
                            today={tasksRes.today}
                            imageCount={tasksRes.imageCounts?.[t.id ?? ""] ?? 0}
                            mediaCount={tasksRes.mediaCounts?.[t.id ?? ""]}
                            fileCount={tasksRes.fileCounts?.[t.id ?? ""] ?? 0}
                            onOpen={onTask}
                          />
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </>
        )}
      </main>
      <BottomBar onBack={onBack}>
        <button type="button" className="btn" onClick={onSettings} aria-label="設定">
          ⚙ 設定
        </button>
        {connected && !archived ? (
          <button type="button" className="btn btn-primary" onClick={onNew} aria-label="タスクの追加">
            ＋ 追加
          </button>
        ) : null}
      </BottomBar>
    </>
  );
}
