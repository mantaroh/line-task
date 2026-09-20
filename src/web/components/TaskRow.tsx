import { dueTone } from "../../shared/taskView";
import type { Task } from "../../shared/types";

function formatDue(due: string): string {
  if (!due) return "期限なし";
  const m = due.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return due;
  return `${Number(m[2])}/${Number(m[3])}`;
}

export function TaskRow({
  task,
  today,
  imageCount = 0,
  mediaCount,
  fileCount = 0,
  onOpen,
}: {
  task: Task;
  today: string;
  imageCount?: number;
  mediaCount?: { video: number; audio: number };
  fileCount?: number;
  onOpen: (ref: string) => void;
}) {
  const tone = dueTone(task, today);
  const overdue = tone === "overdue";
  return (
    <button
      type="button"
      className={overdue ? "task-row task-card is-overdue tap" : "task-row task-card tap"}
      onClick={() => onOpen(task.ref)}
    >
      <span className="task-card-title">{task.title}</span>
      <span className="task-card-meta">
        <span className={`badge badge-due is-${tone}`}>
          {formatDue(task.due)}
          {overdue ? " 期限切れ" : ""}
        </span>
        {task.status ? <span className="badge badge-status">{task.status}</span> : null}
        {task.assignee ? <span className="task-card-assignee">担当: {task.assignee}</span> : null}
        {imageCount > 0 ? <span className="task-card-images">📷{imageCount}</span> : null}
        {mediaCount?.video ? <span className="task-card-images">🎬{mediaCount.video}</span> : null}
        {mediaCount?.audio ? <span className="task-card-images">🎤{mediaCount.audio}</span> : null}
        {fileCount > 0 ? <span className="task-card-images">📎{fileCount}</span> : null}
        <span className="task-card-id">{task.id ?? "IDなし"}</span>
      </span>
    </button>
  );
}
