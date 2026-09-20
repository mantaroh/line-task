import { Hono } from "hono";
import { nowIso } from "../../shared/time";
import type { InvitePreview } from "../../shared/types";
import { requireSession } from "../auth";
import { randomId, randomToken, sha256Hex } from "../crypto";
import {
  addMember,
  createInvite,
  findInviteByHash,
  getProjectForMember,
  incrementInviteUse,
  listActiveInvites,
  logActivity,
  revokeInvite,
} from "../db";
import type { AppEnv } from "../env";
import { badRequest, HttpError, notFound } from "../errors";
import { assertNotArchived, requireMember } from "./projects";

const ALLOWED_DAYS = new Set([1, 7, 30]);

const GONE_MESSAGE: Record<Exclude<InvitePreview["status"], "valid">, string> = {
  expired: "この招待リンクは期限切れです",
  revoked: "この招待リンクは取り消されています",
  archived: "このプロジェクトはアーカイブされています",
};

function inviteStatus(
  row: { revoked_at: string | null; archived_at: string | null; expires_at: string },
  now: string,
): InvitePreview["status"] {
  if (row.revoked_at != null) return "revoked";
  if (row.archived_at != null) return "archived";
  if (row.expires_at <= now) return "expired";
  return "valid";
}

function parseDays(raw: unknown): number {
  if (raw === undefined) return 7;
  if (typeof raw === "number" && ALLOWED_DAYS.has(raw)) return raw;
  throw badRequest("有効期限は 1・7・30 日のいずれかです");
}

const projectInvites = new Hono<AppEnv>();
projectInvites.use("*", requireSession);
projectInvites.use("/:pid/*", requireMember);

projectInvites.post("/:pid/invites", async (c) => {
  const row = c.get("project");
  assertNotArchived(row);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const days = parseDays(body?.days);
  const uid = c.get("user").lineUserId;
  const nowDate = c.get("deps").now();
  const now = nowIso(nowDate);
  const expiresAt = nowIso(new Date(nowDate.getTime() + days * 86400000));
  const id = randomId(10);
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  await createInvite(c.env.DB, { id, tokenHash, projectId: row.id, createdBy: uid, expiresAt }, now);
  await logActivity(c.env.DB, row.id, uid, "invite.create", { inviteId: id, days }, now);
  return c.json({ id, url: `${c.env.APP_URL_BASE}?invite=${token}`, expiresAt }, 201);
});

projectInvites.get("/:pid/invites", async (c) => {
  const now = nowIso(c.get("deps").now());
  return c.json(await listActiveInvites(c.env.DB, c.get("project").id, now));
});

projectInvites.delete("/:pid/invites/:id", async (c) => {
  const row = c.get("project");
  const inviteId = c.req.param("id");
  const now = nowIso(c.get("deps").now());
  const ok = await revokeInvite(c.env.DB, row.id, inviteId, now);
  if (!ok) throw notFound();
  await logActivity(c.env.DB, row.id, c.get("user").lineUserId, "invite.revoke", { inviteId }, now);
  return c.body(null, 204);
});

export const inviteTokenRoutes = new Hono<AppEnv>();
inviteTokenRoutes.use("*", requireSession);

inviteTokenRoutes.get("/:token", async (c) => {
  const token = c.req.param("token");
  const row = await findInviteByHash(c.env.DB, await sha256Hex(token));
  if (!row) throw notFound();
  const uid = c.get("user").lineUserId;
  const now = nowIso(c.get("deps").now());
  const alreadyMember = (await getProjectForMember(c.env.DB, row.project_id, uid)) !== null;
  const preview: InvitePreview = {
    projectId: row.project_id,
    projectName: row.project_name,
    invitedBy: row.created_by_name,
    expiresAt: row.expires_at,
    status: inviteStatus(row, now),
    alreadyMember,
  };
  return c.json(preview);
});

inviteTokenRoutes.post("/:token/accept", async (c) => {
  const token = c.req.param("token");
  const row = await findInviteByHash(c.env.DB, await sha256Hex(token));
  if (!row) throw notFound();
  const now = nowIso(c.get("deps").now());
  const status = inviteStatus(row, now);
  if (status !== "valid") {
    throw new HttpError(410, `invite_${status}`, GONE_MESSAGE[status]);
  }
  const uid = c.get("user").lineUserId;
  const added = await addMember(c.env.DB, row.project_id, uid, row.id, now);
  if (added) {
    await incrementInviteUse(c.env.DB, row.id);
    await logActivity(c.env.DB, row.project_id, uid, "member.join", { inviteId: row.id }, now);
  }
  return c.json({ projectId: row.project_id });
});

export default projectInvites;
