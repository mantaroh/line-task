import { Hono } from "hono";
import { isClosed } from "../../shared/taskView";
import { todayJst } from "../../shared/time";
import { EDITABLE_FIELDS, type EditableField, type TaskChanges, type TasksResponse } from "../../shared/types";
import { requireSession } from "../auth";
import type { AppEnv } from "../env";
import { badRequest, HttpError } from "../errors";
import { countFilesByTask } from "../files/store";
import { countImagesByTask } from "../images/store";
import { countMediaByTask } from "../media/store";
import { SheetsError } from "../sheets/client";
import {
  createTask,
  parseTasks,
  readTable,
  requireSpreadsheetId,
  requireTaskColumns,
  updateTask,
  validateTaskInput,
  type TaskCtx,
} from "../sheets/tasks";
import { assertNotArchived, requireMember } from "./projects";

const app = new Hono<AppEnv>();

app.use("*", requireSession);
app.use("/:pid/*", requireMember);

export function mapTaskSheetsError(e: unknown): never {
  if (e instanceof SheetsError && e.status === 429) {
    throw new HttpError(503, "rate_limited", "混み合っています。少し待ってからやり直してください");
  }
  throw e;
}

function taskCtx(c: { env: Env; get: <K extends keyof AppEnv["Variables"]>(k: K) => AppEnv["Variables"][K] }): TaskCtx {
  const deps = c.get("deps");
  return {
    sheets: deps.sheets,
    kv: c.env.KV,
    db: c.env.DB,
    project: c.get("project"),
    user: c.get("user"),
    now: deps.now(),
  };
}

function readChanges(raw: unknown): TaskChanges {
  if (!raw || typeof raw !== "object") throw badRequest("入力が不正です");
  const o = raw as Record<string, unknown>;
  const out: TaskChanges = {};
  for (const field of EDITABLE_FIELDS) {
    if (o[field] === undefined) continue;
    if (typeof o[field] !== "string") throw badRequest("入力が不正です");
    out[field as EditableField] = o[field];
  }
  return out;
}

app.get("/:pid/tasks", async (c) => {
  const status = c.req.query("status") ?? "all";
  if (status !== "open" && status !== "done" && status !== "all") {
    throw badRequest("status は open・done・all のいずれかを指定してください");
  }
  const project = c.get("project");
  const sid = requireSpreadsheetId(project);
  try {
    const table = await readTable(c.get("deps").sheets, c.env.KV, sid);
    requireTaskColumns(table.headers);
    let { tasks, fields } = parseTasks(table);
    if (status === "open") tasks = tasks.filter((t) => !isClosed(t));
    if (status === "done") tasks = tasks.filter((t) => isClosed(t));
    const body: TasksResponse = {
      tasks,
      fields,
      parties: project.parties,
      today: todayJst(c.get("deps").now()),
      imageCounts: await countImagesByTask(c.env.DB, project.id),
      mediaCounts: await countMediaByTask(c.env.DB, project.id),
      fileCounts: await countFilesByTask(c.env.DB, project.id),
    };
    return c.json(body);
  } catch (e) {
    mapTaskSheetsError(e);
  }
});

app.post("/:pid/tasks", async (c) => {
  const project = c.get("project");
  assertNotArchived(project);
  requireSpreadsheetId(project);
  const input = validateTaskInput(readChanges(await c.req.json().catch(() => null)), project.parties, "create");
  try {
    const task = await createTask(taskCtx(c), input);
    return c.json(task, 201);
  } catch (e) {
    mapTaskSheetsError(e);
  }
});

app.patch("/:pid/tasks/:ref", async (c) => {
  const project = c.get("project");
  assertNotArchived(project);
  requireSpreadsheetId(project);
  const raw = await c.req.json().catch(() => null);
  if (!raw || typeof raw !== "object") throw badRequest("入力が不正です");
  const body = raw as { changes?: unknown; base?: unknown };
  const changes = validateTaskInput(readChanges(body.changes), project.parties, "update");
  const base = readChanges(body.base);
  try {
    const task = await updateTask(taskCtx(c), c.req.param("ref"), changes, base);
    return c.json(task);
  } catch (e) {
    mapTaskSheetsError(e);
  }
});

export default app;
