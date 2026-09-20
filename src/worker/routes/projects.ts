import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { requireSession } from "../auth";
import { randomId } from "../crypto";
import {
  bindSheet,
  countActiveCreatedBy,
  createProject,
  getProjectForMember,
  getSheetBinding,
  listMembers,
  listProjectsForUser,
  logActivity,
  setArchived,
  updateProject,
  type ProjectRow,
} from "../db";
import type { AppEnv } from "../env";
import { badRequest, HttpError, notFound } from "../errors";
import { initializeSheet, parseSpreadsheetUrl, partiesCells } from "../sheets/init";
import { SheetsError } from "../sheets/client";
import { countTasks } from "../../shared/taskView";
import { nowIso, todayJst } from "../../shared/time";
import type { ProjectDetail, ProjectSummary } from "../../shared/types";
import { parseTasks, readTable } from "../sheets/tasks";

const MAX_PROJECTS_PER_USER = 20;

export const requireMember: MiddlewareHandler<AppEnv> = async (c, next) => {
  const pid = c.req.param("pid");
  if (!pid) throw notFound();
  const uid = c.get("user").lineUserId;
  const project = await getProjectForMember(c.env.DB, pid, uid);
  if (!project) throw notFound();
  c.set("project", project);
  await next();
};

export function assertNotArchived(p: ProjectRow): void {
  if (p.archived_at !== null) throw new HttpError(409, "archived", "アーカイブ済みのプロジェクトです");
}

export function validateName(v: unknown): string {
  if (typeof v !== "string") throw badRequest("名前を指定してください");
  const name = v.trim();
  if ([...name].length < 1 || [...name].length > 40) throw badRequest("名前は 1〜40 文字で入力してください");
  return name;
}

export function validateParties(v: unknown): string[] {
  if (!Array.isArray(v) || v.length < 2 || v.length > 5) {
    throw badRequest("関係者は 2〜5 件で指定してください");
  }
  const parties = v.map((item) => {
    if (typeof item !== "string") throw badRequest("関係者は文字列で指定してください");
    const t = item.trim();
    if ([...t].length < 1 || [...t].length > 12) throw badRequest("関係者は 1〜12 文字で入力してください");
    return t;
  });
  if (new Set(parties).size !== parties.length) throw badRequest("関係者が重複しています");
  return parties;
}

async function toDetail(db: D1Database, appUrlBase: string, row: ProjectRow): Promise<ProjectDetail> {
  // 関係者から消えた側は「未設定」として返す（/me と同じ扱い）
  const members = (await listMembers(db, row.id)).map((m) => ({
    ...m,
    party: m.party && row.parties.includes(m.party) ? m.party : null,
  }));
  return {
    id: row.id,
    name: row.name,
    parties: row.parties,
    spreadsheetId: row.spreadsheet_id,
    spreadsheetUrl: row.spreadsheet_id ? `https://docs.google.com/spreadsheets/d/${row.spreadsheet_id}/edit` : null,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    members,
    appUrl: `${appUrlBase}?p=${row.id}`,
  };
}

function toSummary(row: ProjectRow): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    archived: row.archived_at !== null,
    sheetConnected: row.spreadsheet_id !== null,
    counts: null,
  };
}

async function reload(c: { env: Env }, uid: string, pid: string): Promise<ProjectRow> {
  const row = await getProjectForMember(c.env.DB, pid, uid);
  if (!row) throw notFound();
  return row;
}

const app = new Hono<AppEnv>();

app.use("*", requireSession);
app.use("/:pid", requireMember);
app.use("/:pid/*", requireMember);

app.get("/", async (c) => {
  const uid = c.get("user").lineUserId;
  const rows = await listProjectsForUser(c.env.DB, uid);
  const deps = c.get("deps");
  const today = todayJst(deps.now());
  const counted = await Promise.allSettled(
    rows.map(async (row) => {
      if (!row.spreadsheet_id) return null;
      const table = await readTable(deps.sheets, c.env.KV, row.spreadsheet_id);
      return countTasks(parseTasks(table).tasks, today);
    }),
  );
  const body: ProjectSummary[] = rows.map((row, i) => {
    const r = counted[i];
    return { ...toSummary(row), counts: r.status === "fulfilled" ? r.value : null };
  });
  return c.json(body);
});

app.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const name = validateName(body?.name);
  const parties = validateParties(body?.parties);
  const uid = c.get("user").lineUserId;
  const count = await countActiveCreatedBy(c.env.DB, uid);
  if (count >= MAX_PROJECTS_PER_USER) {
    throw new HttpError(409, "project_limit", "作れるプロジェクトは 1 人 20 件までです");
  }
  const id = randomId(10);
  const now = nowIso(c.get("deps").now());
  await createProject(c.env.DB, { id, name, parties, createdBy: uid }, now);
  await logActivity(c.env.DB, id, uid, "project.create", { name, parties }, now);
  const row = await reload(c, uid, id);
  return c.json(await toDetail(c.env.DB, c.env.APP_URL_BASE, row), 201);
});

app.get("/:pid", async (c) => {
  const row = c.get("project");
  return c.json(await toDetail(c.env.DB, c.env.APP_URL_BASE, row));
});

app.patch("/:pid", async (c) => {
  const row = c.get("project");
  assertNotArchived(row);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || (body.name === undefined && body.parties === undefined)) {
    throw badRequest("name か parties のどちらかを指定してください");
  }
  const uid = c.get("user").lineUserId;
  const now = nowIso(c.get("deps").now());
  // 両方を検証してから記録する。片方が 400 のときに活動記録だけ残らないように。
  const patch: { name?: string; parties?: string[] } = {};
  if (body.name !== undefined) patch.name = validateName(body.name);
  if (body.parties !== undefined) patch.parties = validateParties(body.parties);
  const renamed = patch.name !== undefined && patch.name !== row.name;
  const partiesChanged = patch.parties !== undefined && JSON.stringify(patch.parties) !== JSON.stringify(row.parties);
  await updateProject(c.env.DB, row.id, patch);
  if (renamed) {
    await logActivity(c.env.DB, row.id, uid, "project.rename", { from: row.name, to: patch.name }, now);
  }
  if (partiesChanged) {
    await logActivity(c.env.DB, row.id, uid, "project.parties", { from: row.parties, to: patch.parties }, now);
  }
  const updated = await reload(c, uid, row.id);
  const detail = await toDetail(c.env.DB, c.env.APP_URL_BASE, updated);
  if (partiesChanged && updated.spreadsheet_id && patch.parties) {
    const deps = c.get("deps");
    try {
      await deps.sheets.batchUpdateValues(updated.spreadsheet_id, [partiesCells(patch.parties)]);
      return c.json({ ...detail, sheetSynced: true });
    } catch (e) {
      if (e instanceof SheetsError) return c.json({ ...detail, sheetSynced: false });
      throw e;
    }
  }
  return c.json(detail);
});

app.post("/:pid/sheet", async (c) => {
  const row = c.get("project");
  assertNotArchived(row);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const sid = parseSpreadsheetUrl(body?.url);
  if (!sid) throw new HttpError(400, "sheet_url", "スプレッドシートの URL を貼ってください");
  const binding = await getSheetBinding(c.env.DB, sid);
  if (binding && binding.project_id !== row.id) throw new HttpError(409, "sheet_in_use", "このシートは別のプロジェクトで使われています");
  const uid = c.get("user").lineUserId;
  const deps = c.get("deps");
  await initializeSheet(deps.sheets, sid, row.id, row.parties, deps.serviceAccountEmail);
  const now = nowIso(deps.now());
  await bindSheet(c.env.DB, row.id, sid, now);
  await logActivity(c.env.DB, row.id, uid, "project.sheet_bind", { from: row.spreadsheet_id, to: sid }, now);
  const updated = await reload(c, uid, row.id);
  return c.json(await toDetail(c.env.DB, c.env.APP_URL_BASE, updated));
});

app.post("/:pid/archive", async (c) => {
  const row = c.get("project");
  const uid = c.get("user").lineUserId;
  if (row.archived_at === null) {
    const now = nowIso(c.get("deps").now());
    await setArchived(c.env.DB, row.id, now);
    await logActivity(c.env.DB, row.id, uid, "project.archive", null, now);
  }
  const updated = await reload(c, uid, row.id);
  return c.json(await toDetail(c.env.DB, c.env.APP_URL_BASE, updated));
});

app.post("/:pid/unarchive", async (c) => {
  const row = c.get("project");
  const uid = c.get("user").lineUserId;
  if (row.archived_at !== null) {
    const count = await countActiveCreatedBy(c.env.DB, row.created_by);
    if (count >= MAX_PROJECTS_PER_USER) {
      throw new HttpError(409, "project_limit", "作れるプロジェクトは 1 人 20 件までです");
    }
    const now = nowIso(c.get("deps").now());
    await setArchived(c.env.DB, row.id, null);
    await logActivity(c.env.DB, row.id, uid, "project.unarchive", null, now);
  }
  const updated = await reload(c, uid, row.id);
  return c.json(await toDetail(c.env.DB, c.env.APP_URL_BASE, updated));
});

export default app;
