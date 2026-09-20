import { Hono } from "hono";
import { nowIso } from "../../shared/time";
import { requireSession } from "../auth";
import { listMembers, logActivity, removeMemberUnlessLast } from "../db";
import type { AppEnv } from "../env";
import { HttpError, notFound } from "../errors";
import { requireMember } from "./projects";

const LAST_MEMBER = "最後の 1 人は抜けられません。使わないならアーカイブしてください";

const app = new Hono<AppEnv>();
app.use("*", requireSession);
app.use("/:pid/*", requireMember);

app.delete("/:pid/members/:uid", async (c) => {
  const pid = c.get("project").id;
  const uid = c.req.param("uid");
  const members = await listMembers(c.env.DB, pid);
  const target = members.find((m) => m.lineUserId === uid);
  if (!target) throw notFound();
  if (!(await removeMemberUnlessLast(c.env.DB, pid, uid))) {
    throw new HttpError(409, "last_member", LAST_MEMBER);
  }
  const actor = c.get("user").lineUserId;
  const now = nowIso(c.get("deps").now());
  if (uid === actor) {
    await logActivity(c.env.DB, pid, actor, "member.leave", null, now);
  } else {
    await logActivity(c.env.DB, pid, actor, "member.remove", { uid, name: target.displayName }, now);
  }
  return c.body(null, 204);
});

export default app;
