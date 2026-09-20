// 自分の通知の設定と、公式アカウントとの友だちの状態。
import { Hono } from "hono";
import { nowIso } from "../../shared/time";
import type { LineFriendResponse, MemberSettings } from "../../shared/types";
import { requireSession } from "../auth";
import { getMemberSettings, updateMemberSettings, type ProjectRow } from "../db";
import type { AppEnv } from "../env";
import { badRequest, notFound } from "../errors";
import { MessagingError } from "../line/messaging";
import { setLineFriend } from "../usage/store";
import { assertNotArchived, requireMember } from "./projects";

// 関係者から消えた側は「すべて」として返す。
function normalize(s: MemberSettings, project: ProjectRow): MemberSettings {
  return { notify: s.notify, party: s.party !== null && project.parties.includes(s.party) ? s.party : null };
}

function parsePatch(body: unknown, parties: string[]): Partial<MemberSettings> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("notify か party のどちらかを指定してください");
  }
  const b = body as Record<string, unknown>;
  if (b.notify === undefined && b.party === undefined) {
    throw badRequest("notify か party のどちらかを指定してください");
  }
  const patch: Partial<MemberSettings> = {};
  if (b.notify !== undefined) {
    if (typeof b.notify !== "boolean") throw badRequest("notify は true か false で指定してください");
    patch.notify = b.notify;
  }
  if (b.party !== undefined) {
    if (b.party !== null && (typeof b.party !== "string" || !parties.includes(b.party))) {
      throw badRequest("自分の側は関係者のどれかを選んでください");
    }
    patch.party = b.party;
  }
  return patch;
}

const app = new Hono<AppEnv>();
app.use("*", requireSession);
app.use("/:pid/me", requireMember);

app.get("/:pid/me", async (c) => {
  const project = c.get("project");
  const settings = await getMemberSettings(c.env.DB, project.id, c.get("user").lineUserId);
  if (!settings) throw notFound();
  return c.json<MemberSettings>(normalize(settings, project));
});

app.patch("/:pid/me", async (c) => {
  const project = c.get("project");
  assertNotArchived(project);
  const body: unknown = await c.req.json().catch(() => undefined);
  const patch = parsePatch(body, project.parties);
  const uid = c.get("user").lineUserId;
  await updateMemberSettings(c.env.DB, project.id, uid, patch);
  const settings = await getMemberSettings(c.env.DB, project.id, uid);
  if (!settings) throw notFound();
  return c.json<MemberSettings>(normalize(settings, project));
});

export default app;

export const meRoutes = new Hono<AppEnv>();
meRoutes.use("*", requireSession);

meRoutes.get("/line-friend", async (c) => {
  const { messaging, lineOaBasicId } = c.get("deps");
  if (messaging === null || lineOaBasicId === null) {
    return c.json<LineFriendResponse>({ friend: null, addFriendUrl: null });
  }
  let friend: boolean | null;
  try {
    friend = await messaging.isFriend(c.get("user").lineUserId);
  } catch (err) {
    if (!(err instanceof MessagingError)) throw err;
    friend = null;
  }
  if (typeof friend === "boolean") {
    try {
      await setLineFriend(c.env.DB, c.get("user").lineUserId, friend, nowIso(c.get("deps").now()));
    } catch {
      console.warn("[usage] friend save failed");
    }
  }
  return c.json<LineFriendResponse>({ friend, addFriendUrl: `https://line.me/R/ti/p/${lineOaBasicId}` });
});
