// 期限の通知で、知らせるタスクを選び、1 日分の本文を組み立てる。副作用なし。

import { isClosed } from "../../shared/taskView";
import { isValidDate } from "../../shared/time";
import type { Task } from "../../shared/types";
import { sha256Hex } from "../crypto";
import { keyOf } from "../db";
import type { NotifyKind, NotifyTarget } from "./types";

export type NotifyItem = {
  lineUserId: string;
  projectId: string;
  projectName: string;
  kind: NotifyKind;
  taskKey: string;
  taskId: string | null;
  title: string;
  due: string;
};

// Messaging API のテキストの上限。コードポイントで数える。
export const MAX_TEXT = 5000;
export const MAX_TITLE = 40;

const LABELS: Record<NotifyKind, string> = {
  after3: "期限から 3 日",
  due: "今日が期限",
  before: "明日が期限",
};
const KIND_ORDER: Record<NotifyKind, number> = { after3: 0, due: 1, before: 2 };

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function kindFor(due: string, today: string): NotifyKind | null {
  if (due === addDays(today, 1)) return "before";
  if (due === today) return "due";
  if (due === addDays(today, -3)) return "after3";
  return null;
}

export function selectForTarget(target: NotifyTarget, tasks: Task[], today: string, logged: Set<string>): NotifyItem[] {
  // 関係者に無い値（消えた側）はすべて知らせる
  const party = target.party !== null && target.parties.includes(target.party) ? target.party : null;
  const items: NotifyItem[] = [];
  for (const task of tasks) {
    if (task.readonly || isClosed(task) || !isValidDate(task.due)) continue;
    const kind = kindFor(task.due, today);
    if (!kind) continue;
    if (party !== null && task.ball !== party) continue;
    const taskKey = task.id ?? task.ref;
    const key = keyOf({ lineUserId: target.lineUserId, projectId: target.projectId, taskKey, kind, due: task.due });
    if (logged.has(key)) continue;
    items.push({
      lineUserId: target.lineUserId,
      projectId: target.projectId,
      projectName: target.projectName,
      kind,
      taskKey,
      taskId: task.id,
      title: task.title,
      due: task.due,
    });
  }
  return items;
}

function idNumber(id: string): number {
  const m = id.match(/(\d+)(?!.*\d)/);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

function compareItems(a: NotifyItem, b: NotifyItem): number {
  const k = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (k !== 0) return k;
  if (a.taskId !== null && b.taskId !== null) {
    const n = idNumber(a.taskId) - idNumber(b.taskId);
    if (n !== 0 && !Number.isNaN(n)) return n;
    return a.taskId.localeCompare(b.taskId, "ja", { numeric: true });
  }
  if (a.taskId !== null) return -1;
  if (b.taskId !== null) return 1;
  return a.taskKey.localeCompare(b.taskKey, "ja", { numeric: true });
}

type Group = { projectId: string; projectName: string; items: NotifyItem[] };

// プロジェクト名の順に分け、その中を種類・ID の順に並べる。入力は変えない。
function groupItems(items: NotifyItem[]): Group[] {
  const map = new Map<string, Group>();
  for (const item of items) {
    let g = map.get(item.projectId);
    if (!g) {
      g = { projectId: item.projectId, projectName: item.projectName, items: [] };
      map.set(item.projectId, g);
    }
    g.items.push(item);
  }
  const groups = [...map.values()].sort(
    (a, b) => a.projectName.localeCompare(b.projectName, "ja") || a.projectId.localeCompare(b.projectId),
  );
  for (const g of groups) g.items.sort(compareItems);
  return groups;
}

// セル内の改行やタブで本文の形が崩れないよう、空白をまとめてから切る
function truncateTitle(title: string): string {
  const flat = title.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > MAX_TITLE ? `${chars.slice(0, MAX_TITLE).join("")}…` : flat;
}

function itemLines(item: NotifyItem, base: string): string[] {
  const p = encodeURIComponent(item.projectId);
  const idPart = item.taskId !== null ? `${item.taskId} ` : "";
  const url = item.taskId !== null ? `${base}?p=${p}&t=${encodeURIComponent(item.taskId)}` : `${base}?p=${p}`;
  return [`・${LABELS[item.kind]}：${idPart}${truncateTitle(item.title)}`, `  ${url}`];
}

function settingsUrl(base: string, projectId: string): string {
  return `${base}?p=${encodeURIComponent(projectId)}&view=settings`;
}

// 並べた items の先頭 count 件を載せた本文を作る
function render(groups: Group[], count: number, total: number, header: string, base: string): string {
  const lines = [header, ""];
  const shown: Group[] = [];
  let left = count;
  for (const g of groups) {
    if (left <= 0) break;
    const part = g.items.slice(0, left);
    left -= part.length;
    if (shown.length > 0) lines.push("");
    lines.push(`■ ${g.projectName}`);
    for (const item of part) lines.push(...itemLines(item, base));
    shown.push(g);
  }
  if (count < total) lines.push("", `ほか ${total - count} 件はアプリで確認してください`);
  lines.push("");
  if (shown.length === 1) {
    lines.push(`通知の設定：${settingsUrl(base, shown[0].projectId)}`);
  } else {
    lines.push("通知の設定");
    for (const g of shown) lines.push(`・${g.projectName}：${settingsUrl(base, g.projectId)}`);
  }
  return lines.join("\n");
}

const length = (s: string) => [...s].length;

export function formatDigest(items: NotifyItem[], today: string, appUrlBase: string): { text: string; included: NotifyItem[] } {
  if (items.length === 0) return { text: "", included: [] };
  const [, m, d] = today.split("-").map(Number);
  const header = `【LINE タスクボード】${m}/${d} のお知らせ`;
  const groups = groupItems(items);
  const sorted = groups.flatMap((g) => g.items);
  const total = sorted.length;

  const all = render(groups, total, total, header, appUrlBase);
  if (length(all) <= MAX_TEXT) return { text: all, included: sorted };

  // 載せる件数を増やすと本文は長くなるので、超える手前で止める
  let text = "";
  let count = 0;
  for (let k = 1; k < total; k++) {
    const t = render(groups, k, total, header, appUrlBase);
    if (length(t) > MAX_TEXT) break;
    text = t;
    count = k;
  }
  if (count === 0) return { text: "", included: [] };
  return { text, included: sorted.slice(0, count) };
}

// LINE の X-Line-Retry-Key。利用者と日付から決まる UUID（v4 の形）にする。
export async function retryKeyFor(lineUserId: string, today: string): Promise<string> {
  const h = (await sha256Hex(`${lineUserId}|${today}`)).slice(0, 32).split("");
  h[12] = "4";
  h[16] = "8";
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}
