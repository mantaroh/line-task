import { useEffect, useState, type FormEvent } from "react";
import type { ProjectDetail, Task, TaskChanges, TaskField, TasksResponse } from "../../shared/types";
import { api, ApiError } from "../api";
import { ErrorView } from "../components/ErrorView";
import { BottomBar, confirmBack } from "../components/BottomBar";
import { Header } from "../components/Header";
import { Loading } from "../components/Loading";
import { CREATE_FIELDS, emptyValues, TaskForm, type TaskFormValues } from "../components/TaskForm";

export function TaskNew({
  pid,
  onBack,
  onCreated,
}: {
  pid: string;
  onBack: () => void;
  onCreated: () => void;
}) {
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [fields, setFields] = useState<TaskField[] | null>(null);
  const [values, setValues] = useState<TaskFormValues>(emptyValues);
  const [error, setError] = useState<unknown>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [p, list] = await Promise.all([
          api<ProjectDetail>("GET", `/api/projects/${pid}`),
          api<TasksResponse>("GET", `/api/projects/${pid}/tasks?status=all`),
        ]);
        if (cancelled) return;
        setProject(p);
        setFields(list.fields);
      } catch (e) {
        if (!cancelled) setError(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pid]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const title = values.title.trim();
    const ball = values.ball.trim();
    if (!title) {
      setFormError("件名を入力してください");
      return;
    }
    if (!ball) {
      setFormError("ボールを選んでください");
      return;
    }
    const body: TaskChanges = { title, ball };
    if (values.assignee.trim()) body.assignee = values.assignee.trim();
    if (values.due) body.due = values.due;
    if (values.source.trim()) body.source = values.source.trim();
    if (values.next.trim()) body.next = values.next.trim();
    setBusy(true);
    try {
      await api<Task>("POST", `/api/projects/${pid}/tasks`, body);
      onCreated();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "エラーが発生しました");
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorView error={error} />;
  if (!project || !fields) return <Loading />;

  const initial = emptyValues();
  const dirty = (Object.keys(initial) as (keyof TaskFormValues)[]).some((k) => values[k] !== initial[k]);
  const visible = CREATE_FIELDS.filter((f) => f === "title" || f === "ball" || fields.includes(f));

  return (
    <>
      <Header title="タスクの追加" />
      <main className="main">
        <form id="task-form" onSubmit={onSubmit}>
          <TaskForm
            values={values}
            onChange={(patch) => setValues((prev) => ({ ...prev, ...patch }))}
            fields={visible}
            parties={project.parties}
            assigneeSuggestions={project.members.map((m) => m.displayName)}
            disabled={busy}
          />
          {formError ? <p className="error">{formError}</p> : null}
        </form>
      </main>
      <BottomBar onBack={() => confirmBack(dirty, onBack)}>
        <button type="submit" form="task-form" className="btn btn-primary" disabled={busy}>
          追加
        </button>
      </BottomBar>
    </>
  );
}
