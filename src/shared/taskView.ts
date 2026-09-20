import { CLOSED_STATUSES, type Task } from "./types";

export function isClosed(t: Pick<Task, "status">): boolean {
  return CLOSED_STATUSES.includes(t.status);
}

export function isOverdue(t: Pick<Task, "status" | "due">, today: string): boolean {
  if (isClosed(t)) return false;
  if (!t.due) return false;
  return t.due < today;
}

export type DueTone = "overdue" | "soon" | "normal" | "none";

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// 一覧の期限バッジの色。soon は今日か明日が期限の未完了タスク
export function dueTone(t: Pick<Task, "status" | "due">, today: string): DueTone {
  if (!t.due) return "none";
  if (isClosed(t)) return "normal";
  if (t.due < today) return "overdue";
  if (t.due === today || t.due === nextDay(today)) return "soon";
  return "normal";
}

export function countTasks(tasks: Task[], today: string): { open: number; overdue: number } {
  let open = 0;
  let overdue = 0;
  for (const task of tasks) {
    if (!isClosed(task)) open += 1;
    if (isOverdue(task, today)) overdue += 1;
  }
  return { open, overdue };
}

export type Tab = "open" | "overdue" | "done";

export function filterTasks(tasks: Task[], tab: Tab, assignee: string | null, today: string): Task[] {
  const target = assignee === null ? null : assignee.trim();
  return tasks.filter((task) => {
    if (target !== null && task.assignee.trim() !== target) return false;
    if (tab === "overdue") return isOverdue(task, today);
    if (tab === "done") return isClosed(task);
    return !isClosed(task);
  });
}

function idNumber(id: string | null): number {
  if (id === null) return Number.POSITIVE_INFINITY;
  const n = Number(id.replace(/^T-/, ""));
  return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n;
}

function compareTasks(a: Task, b: Task): number {
  const dueA = a.due || null;
  const dueB = b.due || null;
  if (dueA === null && dueB !== null) return 1;
  if (dueA !== null && dueB === null) return -1;
  if (dueA !== null && dueB !== null && dueA !== dueB) return dueA < dueB ? -1 : 1;

  const idA = idNumber(a.id);
  const idB = idNumber(b.id);
  if (idA !== idB) return idA - idB;

  return a.row - b.row;
}

// first に自分の側を渡すと、そのグループを一番上にする（関係者に無ければ今の順のまま）
export function groupByBall(tasks: Task[], parties: string[], first: string | null = null): { ball: string; tasks: Task[] }[] {
  const OTHER = "その他";
  const groups = new Map<string, Task[]>();
  for (const party of parties) groups.set(party, []);
  groups.set(OTHER, []);

  for (const task of tasks) {
    const key = task.ball && parties.includes(task.ball) ? task.ball : OTHER;
    groups.get(key)!.push(task);
  }

  const order = first && parties.includes(first) ? [first, ...parties.filter((p) => p !== first)] : parties;
  return [...order, OTHER]
    .map((ball) => ({ ball, tasks: [...(groups.get(ball) ?? [])].sort(compareTasks) }))
    .filter((g) => g.tasks.length > 0);
}
