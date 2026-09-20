import { env } from "cloudflare:test";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActivityItem, ProjectDetail } from "../../src/shared/types";
import { logActivity } from "../../src/worker/db";
import type { AppEnv } from "../../src/worker/env";
import { call, login, makeApp } from "./helpers";

async function createProject(app: Hono<AppEnv>, token: string): Promise<ProjectDetail> {
  return (await call(app, "POST", "/api/projects", token, { name: "活動", parties: ["a", "b"] })).json<ProjectDetail>();
}

describe("活動記録", () => {
  it("新しい順に 50 件ずつ返り、before と task で絞れる。actor に表示名が入る", async () => {
    const app = makeApp();
    const a = await login(app, "AA", "A");
    const p = await createProject(app, a);
    const now = "2026-09-15T10:00:00+09:00";
    for (let i = 0; i < 59; i++) {
      const detail = i < 3 ? { taskId: "T-001", n: i } : { n: i };
      await logActivity(env.DB, p.id, "AA", i < 3 ? "task.create" : "task.update", detail, now);
    }

    const page1Res = await call(app, "GET", `/api/projects/${p.id}/activity`, a);
    expect(page1Res.status).toBe(200);
    const page1 = await page1Res.json<ActivityItem[]>();
    expect(page1).toHaveLength(50);
    expect(page1[0].id).toBeGreaterThan(page1[49].id);
    expect(page1[0].actor).toEqual({ lineUserId: "AA", displayName: "A", pictureUrl: null });
    expect(page1.every((item) => item.actor.displayName === "A")).toBe(true);

    const page2 = await (
      await call(app, "GET", `/api/projects/${p.id}/activity?before=${page1[49].id}`, a)
    ).json<ActivityItem[]>();
    expect(page2).toHaveLength(10);
    expect(page2[0].id).toBeLessThan(page1[49].id);
    expect(page2.every((item) => item.id < page1[49].id)).toBe(true);

    const ids = [...page1, ...page2].map((item) => item.id);
    expect(new Set(ids).size).toBe(60);

    const byTask = await (await call(app, "GET", `/api/projects/${p.id}/activity?task=T-001`, a)).json<ActivityItem[]>();
    expect(byTask).toHaveLength(3);
    expect(byTask.every((item) => (item.detail as { taskId: string }).taskId === "T-001")).toBe(true);
    expect(byTask[0].actor.displayName).toBe("A");
  });

  it("メンバーでなければ 404", async () => {
    const app = makeApp();
    const a = await login(app, "AB", "B");
    const c = await login(app, "AC", "C");
    const p = await createProject(app, a);
    expect((await call(app, "GET", `/api/projects/${p.id}/activity`, c)).status).toBe(404);
  });
});
