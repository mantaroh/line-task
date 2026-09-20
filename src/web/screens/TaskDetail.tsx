import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ActivityItem, EditableField, ProjectDetail, Task, TaskChanges, TaskField, TasksResponse } from "../../shared/types";
import { api, ApiError } from "../api";
import { ActivityList } from "../components/ActivityList";
import { ErrorView } from "../components/ErrorView";
import { BottomBar, confirmBack } from "../components/BottomBar";
import { CopyButton } from "../components/CopyButton";
import { Header } from "../components/Header";
import { Loading } from "../components/Loading";
import { TaskFilesSection } from "../components/TaskFiles";
import { TaskImages } from "../components/TaskImages";
import { TaskMediaSection } from "../components/TaskMedia";
import { diffChanges, TaskForm, toChanges, valuesFromTask, type TaskFormValues } from "../components/TaskForm";
import { taskLinkText } from "../taskLink";

function conflictTask(err: ApiError): Task | null {
  const raw = err.body.task;
  if (!raw || typeof raw !== "object") return null;
  if (!("ref" in raw) || typeof (raw as Task).ref !== "string") return null;
  return raw as Task;
}

export function TaskDetail({
  pid,
  taskRef,
  onBack,
  onRefChanged,
}: {
  pid: string;
  taskRef: string;
  onBack: () => void;
  onRefChanged: (ref: string) => void;
}) {
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [fields, setFields] = useState<TaskField[] | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [original, setOriginal] = useState<TaskFormValues | null>(null);
  const [values, setValues] = useState<TaskFormValues | null>(null);
  const [activity, setActivity] = useState<ActivityItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activityTick, setActivityTick] = useState(0);
  // この画面で ID を振って URL を差し替えたときは、読み直して入力途中の値を消さない
  const renamedRef = useRef<string | null>(null);

  function applyTask(next: Task) {
    const v = valuesFromTask(next);
    setTask(next);
    setValues(v);
    setOriginal(v);
  }

  useEffect(() => {
    if (renamedRef.current === taskRef) {
      renamedRef.current = null;
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [p, list] = await Promise.all([
          api<ProjectDetail>("GET", `/api/projects/${pid}`),
          api<TasksResponse>("GET", `/api/projects/${pid}/tasks?status=all`),
        ]);
        if (cancelled) return;
        const found = list.tasks.find((t) => t.ref === taskRef);
        if (!found) {
          setError(new ApiError(404, { error: "not_found", message: "見つからないか、参加していません" }));
          return;
        }
        setProject(p);
        setFields(list.fields);
        applyTask(found);
      } catch (e) {
        if (!cancelled) setError(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pid, taskRef]);

  useEffect(() => {
    if (!task?.id) {
      setActivity([]);
      return;
    }
    let cancelled = false;
    api<ActivityItem[]>("GET", `/api/projects/${pid}/activity?task=${encodeURIComponent(task.id)}`)
      .then((items) => {
        if (!cancelled) setActivity(items);
      })
      .catch(() => {
        if (!cancelled) setActivity([]);
      });
    return () => {
      cancelled = true;
    };
  }, [pid, task?.id, activityTick]);

  // keepEdits: 保存していない入力（ボタン操作の対象以外）を、保存後の値の上に残す
  async function patch(changes: TaskChanges, base: TaskChanges, keepEdits: TaskChanges = {}): Promise<boolean> {
    setBusy(true);
    setNotice(null);
    try {
      const ref = task?.ref ?? taskRef;
      const next = await api<Task>("PATCH", `/api/projects/${pid}/tasks/${encodeURIComponent(ref)}`, { changes, base });
      applyTask(next);
      if (Object.keys(keepEdits).length > 0) setValues({ ...valuesFromTask(next), ...keepEdits });
      setActivityTick((n) => n + 1);
      // ID の無い行に ID が振られたら、再読込しても開けるよう URL を差し替える
      if (next.ref !== taskRef) {
        renamedRef.current = next.ref;
        onRefChanged(next.ref);
      }
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === "conflict") {
        showConflict(e);
        return false;
      }
      setNotice(e instanceof ApiError ? e.message : "エラーが発生しました");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function showConflict(e: ApiError) {
    setNotice("ほかの人が変更しました");
    const t = conflictTask(e);
    if (t) applyTask(t);
    setActivityTick((n) => n + 1);
  }

  // 画像は ID に付けるので、ID の無い行は先に ID を振ってもらう（入力途中の値は送らずに画面に残す）
  async function ensureTaskId(): Promise<string | null> {
    if (task?.id) return task.id;
    if (!original || !values) return null;
    const keepEdits = diffChanges(values, original);
    // ID を振っている間は、ボタン操作や保存で同じ行に PATCH を重ねない
    setBusy(true);
    setNotice(null);
    try {
      const ref = task?.ref ?? taskRef;
      const next = await api<Task>("PATCH", `/api/projects/${pid}/tasks/${encodeURIComponent(ref)}`, {
        changes: {},
        base: { title: original.title },
      });
      applyTask(next);
      if (Object.keys(keepEdits).length > 0) setValues({ ...valuesFromTask(next), ...keepEdits });
      if (next.ref !== taskRef) {
        renamedRef.current = next.ref;
        onRefChanged(next.ref);
      }
      return next.id;
    } catch (e) {
      if (e instanceof ApiError && e.code === "conflict") {
        showConflict(e);
        return null;
      }
      throw e;
    } finally {
      setBusy(false);
    }
  }

  async function onQuick(field: EditableField, value: string) {
    if (!values || !original) return;
    // 比較の基準はシートから読んだ値。入力途中の値を送ると、誰も変えていないのに競合になる。
    const { [field]: _, ...keepEdits } = diffChanges(values, original);
    await patch({ [field]: value }, toChanges(original), keepEdits);
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!values || !original) return;
    const changes = diffChanges(values, original);
    if (Object.keys(changes).length === 0) return;
    await patch(changes, toChanges(original));
  }

  if (error) return <ErrorView error={error} />;
  if (!project || !fields || !task || !values || !original) return <Loading />;

  const archived = project.archivedAt !== null;
  const readonly = task.readonly || archived;
  const dirty = Object.keys(diffChanges(values, original)).length > 0;
  const others = project.parties.filter((p) => p !== values.ball);

  return (
    <>
      <Header title={task.id ?? "タスク"} />
      <main className="main main-wide">
        {readonly ? (
          <p className="error">
            {task.readonly ? "ID が重複しています。PC で直してください" : "アーカイブ済み（見るだけ）"}
          </p>
        ) : null}
        {notice ? <p className="error">{notice}</p> : null}

        {/* PC では入力欄を左、操作・添付・履歴を右に置く。スマホでは今までどおり上から並ぶ（styles.css の .task-detail） */}
        <div className="task-detail">
          <div className="task-detail-top">
            {!readonly ? (
              <div className="quick-actions">
                {others.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="btn btn-quick"
                    disabled={busy}
                    onClick={() => onQuick("ball", p)}
                  >
                    {p}にボールを渡す
                  </button>
                ))}
                <button type="button" className="btn btn-quick" disabled={busy} onClick={() => onQuick("status", "対応中")}>
                  対応中
                </button>
                <button type="button" className="btn btn-quick" disabled={busy} onClick={() => onQuick("status", "完了")}>
                  完了
                </button>
              </div>
            ) : null}

            {/* ID が重複した行はどちらが開くか決まらないので出さない。アーカイブ済みは ID を振れないので、ID がある行だけ */}
            {!task.readonly && (task.id || !archived) ? (
              <div className="task-link">
                <CopyButton
                  label="🔗 リンクをコピー"
                  disabled={busy}
                  text={async () => {
                    const id = await ensureTaskId();
                    return id ? taskLinkText(project.appUrl, id, task.title) : null;
                  }}
                />
              </div>
            ) : null}
          </div>

          <form id="task-form" className="task-detail-form" onSubmit={onSave}>
            <TaskForm
              values={values}
              onChange={(next) => setValues((prev) => (prev ? { ...prev, ...next } : prev))}
              fields={fields}
              parties={project.parties}
              assigneeSuggestions={project.members.map((m) => m.displayName)}
              disabled={readonly || busy}
              meta={{
                id: task.id,
                createdAt: task.createdAt,
                updatedAt: task.updatedAt,
                updatedBy: task.updatedBy,
              }}
            />
          </form>

          <div className="task-detail-bottom">
            <TaskImages
              pid={pid}
              taskId={task.id}
              archived={readonly}
              disabled={busy}
              ensureTaskId={ensureTaskId}
              onChanged={() => setActivityTick((n) => n + 1)}
            />

            <TaskMediaSection
              pid={pid}
              taskId={task.id}
              archived={readonly}
              disabled={busy}
              ensureTaskId={ensureTaskId}
              onChanged={() => setActivityTick((n) => n + 1)}
            />

            <TaskFilesSection
              pid={pid}
              taskId={task.id}
              archived={readonly}
              disabled={busy}
              ensureTaskId={ensureTaskId}
              onChanged={() => setActivityTick((n) => n + 1)}
            />

            <section className="activity-section">
              <h2>変更履歴</h2>
              {activity ? <ActivityList items={activity} /> : <Loading />}
            </section>
          </div>
        </div>
      </main>
      <BottomBar onBack={() => confirmBack(dirty, onBack)}>
        {!readonly ? (
          <button type="submit" form="task-form" className="btn btn-primary" disabled={busy || !dirty}>
            保存
          </button>
        ) : null}
      </BottomBar>
    </>
  );
}
