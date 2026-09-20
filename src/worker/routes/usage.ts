// 画面ごとのアクセスの記録。どのタスクを見たか・画面の中の操作は記録しない。
import { Hono } from "hono";
import { nowIso } from "../../shared/time";
import { PROJECT_USAGE_VIEWS, USAGE_VIEWS, type UsageView } from "../../shared/types";
import { requireSession } from "../auth";
import { getProjectForMember } from "../db";
import type { AppEnv } from "../env";
import { badRequest, notFound } from "../errors";
import { recordAccess } from "../usage/store";

const VALIDATION_MESSAGE = "記録の内容が正しくありません";

function parseBody(body: unknown): { view: UsageView; pid: string | null } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest(VALIDATION_MESSAGE);
  }
  const b = body as Record<string, unknown>;
  const view = b.view;
  if (typeof view !== "string" || !(USAGE_VIEWS as readonly string[]).includes(view)) {
    throw badRequest(VALIDATION_MESSAGE);
  }
  const needsPid = (PROJECT_USAGE_VIEWS as readonly string[]).includes(view);
  if (needsPid) {
    if (typeof b.pid !== "string" || b.pid === "") throw badRequest(VALIDATION_MESSAGE);
    return { view: view as UsageView, pid: b.pid };
  }
  if (b.pid !== undefined) throw badRequest(VALIDATION_MESSAGE);
  return { view: view as UsageView, pid: null };
}

const app = new Hono<AppEnv>();
app.use("*", requireSession);

app.post("/", async (c) => {
  const body: unknown = await c.req.json().catch(() => undefined);
  const { view, pid } = parseBody(body);
  const uid = c.get("user").lineUserId;
  if (pid !== null) {
    const project = await getProjectForMember(c.env.DB, pid, uid);
    if (!project) throw notFound();
  }
  await recordAccess(c.env.DB, { lineUserId: uid, projectId: pid, view }, nowIso(c.get("deps").now()));
  return c.body(null, 204);
});

export default app;
