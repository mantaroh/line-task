import { Hono } from "hono";
import { requireSession } from "../auth";
import { listActivity } from "../db";
import type { AppEnv } from "../env";
import { badRequest } from "../errors";
import { requireMember } from "./projects";

const PAGE = 50;

const app = new Hono<AppEnv>();
app.use("*", requireSession);
app.use("/:pid/*", requireMember);

app.get("/:pid/activity", async (c) => {
  const beforeQ = c.req.query("before");
  let before: number | undefined;
  if (beforeQ) {
    const n = Number(beforeQ);
    if (!Number.isInteger(n)) throw badRequest("before が不正です");
    before = n;
  }
  const taskId = c.req.query("task") || undefined;
  return c.json(await listActivity(c.env.DB, c.get("project").id, { before, taskId, limit: PAGE }));
});

export default app;
