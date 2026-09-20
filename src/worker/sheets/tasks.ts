import { isValidDate, normalizeDate, nowIso, sheetDateTime } from "../../shared/time";
import {
  EDITABLE_FIELDS,
  FIELD_HEADERS,
  FIELD_LIMITS,
  HEADER_ORDER,
  REQUIRED_FIELDS,
  TASK_STATUSES,
  type EditableField,
  type Task,
  type TaskChanges,
  type TaskField,
} from "../../shared/types";
import type { SessionUser } from "../auth";
import { logActivity, nextTaskNo, type ProjectRow } from "../db";
import { badRequest, HttpError, notFound } from "../errors";
import { colLetter, rangeOf } from "./a1";
import type { SheetsClient } from "./client";
import { TASK_SHEET } from "./init";

export type TaskTable = { headers: string[]; rows: string[][] };
export type ColumnMap = Partial<Record<TaskField, number>>;
export type TaskCtx = {
  sheets: SheetsClient;
  kv: KVNamespace;
  db: D1Database;
  project: ProjectRow;
  user: SessionUser;
  now: Date;
};

const CACHE_TTL_SEC = 60;
const WARN_TTL_SEC = 86400;

function cacheKey(sid: string): string {
  return `tasks:${sid}`;
}

function formatTaskId(n: number): string {
  return `T-${String(n).padStart(3, "0")}`;
}

// シートにある T-数字 の ID の一番大きい番号の次。シートで ID を手で書いた場合や、ID の入ったシートをつないだ場合に備える
export function nextNoAfterSheet(tasks: Pick<Task, "id">[]): number {
  let max = 0;
  for (const t of tasks) {
    // 桁の大きすぎる ID は打ち間違いとみて見ない（番号が扱える範囲を超えないように）
    const m = t.id ? /^T-(\d{1,6})$/.exec(t.id) : null;
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

export function mapColumns(headers: string[]): ColumnMap {
  const map: ColumnMap = {};
  const trimmed = headers.map((h) => h.trim());
  for (const field of HEADER_ORDER) {
    const i = trimmed.indexOf(FIELD_HEADERS[field]);
    if (i !== -1) map[field] = i;
  }
  return map;
}

function cellAt(row: string[], cols: ColumnMap, field: TaskField): string {
  const i = cols[field];
  if (i === undefined) return "";
  return (row[i] ?? "").trim();
}

export function parseTasks(table: TaskTable): { tasks: Task[]; fields: TaskField[]; duplicates: string[] } {
  const cols = mapColumns(table.headers);
  const fields = HEADER_ORDER.filter((f) => cols[f] !== undefined);
  const seen = new Set<string>();
  const duplicateSet = new Set<string>();
  const duplicates: string[] = [];
  const tasks: Task[] = [];

  table.rows.forEach((row, idx) => {
    const sheetRow = idx + 2;
    const idRaw = cellAt(row, cols, "id");
    const title = cellAt(row, cols, "title");
    if (idRaw === "" && title === "") return;

    let readonly = false;
    let ref: string;
    if (idRaw === "") {
      ref = `row-${sheetRow}`;
    } else if (seen.has(idRaw)) {
      readonly = true;
      ref = `row-${sheetRow}`;
      if (!duplicateSet.has(idRaw)) {
        duplicateSet.add(idRaw);
        duplicates.push(idRaw);
      }
    } else {
      seen.add(idRaw);
      ref = idRaw;
    }

    tasks.push({
      ref,
      row: sheetRow,
      id: idRaw === "" ? null : idRaw,
      readonly,
      title,
      ball: cellAt(row, cols, "ball"),
      assignee: cellAt(row, cols, "assignee"),
      status: cellAt(row, cols, "status"),
      due: normalizeDate(cellAt(row, cols, "due")),
      source: cellAt(row, cols, "source"),
      next: cellAt(row, cols, "next"),
      memo: cellAt(row, cols, "memo"),
      createdAt: cellAt(row, cols, "createdAt"),
      updatedAt: cellAt(row, cols, "updatedAt"),
      updatedBy: cellAt(row, cols, "updatedBy"),
    });
  });

  return { tasks, fields, duplicates };
}

export async function readTable(
  sheets: SheetsClient,
  kv: KVNamespace,
  sid: string,
  opts?: { fresh?: boolean },
): Promise<TaskTable> {
  const key = cacheKey(sid);
  if (!opts?.fresh) {
    const cached = await kv.get<TaskTable>(key, "json");
    if (cached) return cached;
  }
  const values = await sheets.getValues(sid, rangeOf(TASK_SHEET, "A1:Z"));
  const table: TaskTable = { headers: values[0] ?? [], rows: values.slice(1) };
  await kv.put(key, JSON.stringify(table), { expirationTtl: CACHE_TTL_SEC });
  return table;
}

export async function invalidate(kv: KVNamespace, sid: string): Promise<void> {
  await kv.delete(cacheKey(sid));
}

export function toCellInput(v: string): string {
  return /^[=+\-@]/.test(v) ? `'${v}` : v;
}

export function requireSpreadsheetId(project: ProjectRow): string {
  if (!project.spreadsheet_id) {
    throw new HttpError(409, "sheet_not_connected", "シートがまだつながっていません");
  }
  return project.spreadsheet_id;
}

export function requireTaskColumns(headers: string[]): ColumnMap {
  const cols = mapColumns(headers);
  if (REQUIRED_FIELDS.some((f) => cols[f] === undefined)) {
    throw new HttpError(409, "sheet_headers", "シートの見出し（ID・件名・ボール・状態）が見つかりません");
  }
  return cols;
}

export function validateTaskInput(input: TaskChanges, parties: string[], mode: "create" | "update"): TaskChanges {
  const out: TaskChanges = {};
  const has = (field: EditableField) => input[field] !== undefined;

  if (mode === "create" || has("title")) {
    const title = (input.title ?? "").trim();
    if ([...title].length < 1 || [...title].length > FIELD_LIMITS.title) {
      throw badRequest("件名は 1〜100 文字で入力してください");
    }
    out.title = title;
  }

  if (mode === "create" || has("ball")) {
    const ball = (input.ball ?? "").trim();
    if ([...ball].length < 1 || [...ball].length > FIELD_LIMITS.ball) {
      throw badRequest("ボールは 1〜12 文字で入力してください");
    }
    if (!parties.includes(ball)) throw badRequest("ボールは関係者から選んでください");
    out.ball = ball;
  }

  if (mode === "update" && has("status")) {
    if (!(TASK_STATUSES as readonly string[]).includes(input.status ?? "")) {
      throw badRequest("状態が不正です");
    }
    out.status = input.status;
  }

  if (has("due")) {
    const due = (input.due ?? "").trim();
    if (due === "") {
      out.due = "";
    } else {
      const normalized = normalizeDate(due);
      if (!isValidDate(normalized)) throw badRequest("期限が不正です");
      out.due = normalized;
    }
  }

  for (const field of ["assignee", "source", "next", "memo"] as const) {
    if (!has(field)) continue;
    const v = (input[field] ?? "").trim();
    if ([...v].length > FIELD_LIMITS[field]) {
      throw badRequest(`${FIELD_HEADERS[field]}は ${FIELD_LIMITS[field]} 文字以内で入力してください`);
    }
    out[field] = v;
  }

  return out;
}

function conflict(task: Task): HttpError {
  return new HttpError(409, "conflict", "ほかの人が変更しました。読み直します", { task });
}

function currentField(task: Task, field: EditableField): string {
  const v = task[field] ?? "";
  return field === "due" ? normalizeDate(v) : v.trim();
}

function baseField(base: TaskChanges, field: EditableField): string {
  const v = base[field] ?? "";
  return field === "due" ? normalizeDate(v) : v.trim();
}

async function warnDuplicate(ctx: TaskCtx, taskId: string): Promise<void> {
  const key = `warned:${ctx.project.id}:${taskId}`;
  if (await ctx.kv.get(key)) return;
  await ctx.kv.put(key, "1", { expirationTtl: WARN_TTL_SEC });
  await logActivity(
    ctx.db,
    ctx.project.id,
    ctx.user.lineUserId,
    "sheet.warning",
    { kind: "duplicate_id", taskId },
    nowIso(ctx.now),
  );
}

export async function createTask(ctx: TaskCtx, input: TaskChanges): Promise<Task> {
  const sid = requireSpreadsheetId(ctx.project);
  const table = await readTable(ctx.sheets, ctx.kv, sid, { fresh: true });
  requireTaskColumns(table.headers);
  const n = await nextTaskNo(ctx.db, ctx.project.id, nextNoAfterSheet(parseTasks(table).tasks));
  const id = formatTaskId(n);
  const nowText = sheetDateTime(ctx.now);
  const valuesByField: Record<TaskField, string> = {
    id,
    title: input.title ?? "",
    ball: input.ball ?? "",
    assignee: input.assignee ?? "",
    status: "未着手",
    due: input.due ?? "",
    source: input.source ?? "",
    next: input.next ?? "",
    memo: input.memo ?? "",
    createdAt: nowText,
    updatedAt: nowText,
    updatedBy: ctx.user.displayName,
  };
  const rowValues = table.headers.map((h) => {
    const field = HEADER_ORDER.find((f) => FIELD_HEADERS[f] === h.trim());
    return field ? toCellInput(valuesByField[field]) : "";
  });
  await ctx.sheets.appendValues(sid, rangeOf(TASK_SHEET, "A1"), [rowValues]);
  await invalidate(ctx.kv, sid);
  await logActivity(ctx.db, ctx.project.id, ctx.user.lineUserId, "task.create", { taskId: id, title: valuesByField.title }, nowIso(ctx.now));
  return {
    ref: id,
    row: table.rows.length + 2,
    id,
    readonly: false,
    title: valuesByField.title,
    ball: valuesByField.ball,
    assignee: valuesByField.assignee,
    status: valuesByField.status,
    due: valuesByField.due,
    source: valuesByField.source,
    next: valuesByField.next,
    memo: valuesByField.memo,
    createdAt: valuesByField.createdAt,
    updatedAt: valuesByField.updatedAt,
    updatedBy: valuesByField.updatedBy,
  };
}

export async function updateTask(ctx: TaskCtx, ref: string, changes: TaskChanges, base: TaskChanges): Promise<Task> {
  const sid = requireSpreadsheetId(ctx.project);
  const table = await readTable(ctx.sheets, ctx.kv, sid, { fresh: true });
  const cols = requireTaskColumns(table.headers);
  const parsed = parseTasks(table);

  const rowRef = /^row-(\d+)$/.exec(ref);
  let task: Task | undefined;
  if (rowRef) {
    const rowNum = Number(rowRef[1]);
    task = parsed.tasks.find((t) => t.row === rowNum);
    if (!task) throw notFound();
  } else {
    task = parsed.tasks.find((t) => t.ref === ref);
    if (!task) throw notFound();
  }

  if (task.readonly) {
    await warnDuplicate(ctx, task.id ?? ref);
    throw new HttpError(409, "duplicate_id", "ID が重複しています。PC で直してください");
  }

  if (rowRef) {
    const titleNow = task.title.trim();
    const expected = (base.title ?? "").trim();
    if (expected !== titleNow || task.id !== null) throw conflict(task);
  }

  for (const field of EDITABLE_FIELDS) {
    if (changes[field] === undefined) continue;
    if (currentField(task, field) !== baseField(base, field)) throw conflict(task);
  }

  const writes: { range: string; values: string[][] }[] = [];
  const activityChanges: Record<string, [string, string]> = {};
  const next: Task = { ...task };

  const writeField = (field: TaskField, value: string) => {
    const col = cols[field];
    if (col === undefined) return;
    writes.push({ range: rangeOf(TASK_SHEET, `${colLetter(col)}${task.row}`), values: [[toCellInput(value)]] });
  };

  for (const field of EDITABLE_FIELDS) {
    if (changes[field] === undefined) continue;
    const from = currentField(task, field);
    const to = field === "due" ? normalizeDate(changes[field]!) : changes[field]!.trim();
    if (from === to) continue;
    writeField(field, to);
    next[field] = to;
    activityChanges[FIELD_HEADERS[field]] = [from, to];
  }

  if (task.id === null) {
    const id = formatTaskId(await nextTaskNo(ctx.db, ctx.project.id, nextNoAfterSheet(parsed.tasks)));
    writeField("id", id);
    next.id = id;
    next.ref = id;
  }

  if (writes.length === 0) return next;

  const nowText = sheetDateTime(ctx.now);
  writeField("updatedAt", nowText);
  writeField("updatedBy", ctx.user.displayName);
  next.updatedAt = nowText;
  next.updatedBy = ctx.user.displayName;

  await ctx.sheets.batchUpdateValues(sid, writes);
  await invalidate(ctx.kv, sid);
  await logActivity(
    ctx.db,
    ctx.project.id,
    ctx.user.lineUserId,
    "task.update",
    { taskId: next.id, changes: activityChanges },
    nowIso(ctx.now),
  );
  return next;
}
