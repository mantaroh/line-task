import { env } from "cloudflare:test";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ApiErrorBody, ProjectDetail } from "../../src/shared/types";
import type { AppEnv } from "../../src/worker/env";
import { removeMemberUnlessLast } from "../../src/worker/db";
import { call, login, makeApp } from "./helpers";

async function createProject(app: Hono<AppEnv>, token: string, name = "メンバー"): Promise<ProjectDetail> {
  return (await call(app, "POST", "/api/projects", token, { name, parties: ["a", "b"] })).json<ProjectDetail>();
}

async function joinViaInvite(app: Hono<AppEnv>, pid: string, owner: string, joiner: string): Promise<void> {
  const inv = await (await call(app, "POST", `/api/projects/${pid}/invites`, owner, { days: 7 })).json<{ url: string }>();
  const token = new URL(inv.url).searchParams.get("invite")!;
  const res = await call(app, "POST", `/api/invites/${token}/accept`, joiner);
  expect(res.status).toBe(200);
}

async function activity(pid: string) {
  const { results } = await env.DB.prepare("SELECT actor, action, detail FROM activity WHERE project_id = ? ORDER BY id")
    .bind(pid)
    .all<{ actor: string; action: string; detail: string | null }>();
  return results;
}

describe("メンバー", () => {
  it("外すと member.remove が残り、外された人はプロジェクトを見られない", async () => {
    const app = makeApp();
    const a = await login(app, "MA", "A");
    const b = await login(app, "MB", "B");
    const p = await createProject(app, a, "外す");
    await joinViaInvite(app, p.id, a, b);
    const res = await call(app, "DELETE", `/api/projects/${p.id}/members/MB`, a);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect((await call(app, "GET", `/api/projects/${p.id}`, b)).status).toBe(404);
    expect((await call(app, "GET", `/api/projects/${p.id}`, a)).status).toBe(200);
    const rows = await activity(p.id);
    const last = rows[rows.length - 1];
    expect(last.actor).toBe("MA");
    expect(last.action).toBe("member.remove");
    expect(JSON.parse(last.detail as string)).toEqual({ uid: "MB", name: "B" });
  });

  it("自分で抜けると member.leave が残る", async () => {
    const app = makeApp();
    const a = await login(app, "MC", "C");
    const b = await login(app, "MD", "D");
    const p = await createProject(app, a, "抜ける");
    await joinViaInvite(app, p.id, a, b);
    const res = await call(app, "DELETE", `/api/projects/${p.id}/members/MD`, b);
    expect(res.status).toBe(204);
    expect((await call(app, "GET", `/api/projects/${p.id}`, b)).status).toBe(404);
    const rows = await activity(p.id);
    const last = rows[rows.length - 1];
    expect(last.actor).toBe("MD");
    expect(last.action).toBe("member.leave");
  });

  it("最後の 1 人は 409 last_member（アーカイブ済みでも）", async () => {
    const app = makeApp();
    const a = await login(app, "ME", "E");
    const p = await createProject(app, a, "最後");
    const leave = await call(app, "DELETE", `/api/projects/${p.id}/members/ME`, a);
    expect(leave.status).toBe(409);
    expect(await leave.json<ApiErrorBody>()).toEqual({
      error: "last_member",
      message: "最後の 1 人は抜けられません。使わないならアーカイブしてください",
    });
    await call(app, "POST", `/api/projects/${p.id}/archive`, a);
    const leaveArchived = await call(app, "DELETE", `/api/projects/${p.id}/members/ME`, a);
    expect(leaveArchived.status).toBe(409);
    expect((await leaveArchived.json<ApiErrorBody>()).error).toBe("last_member");
    expect((await call(app, "GET", `/api/projects/${p.id}`, a)).status).toBe(200);
  });

  it("対象がメンバーでなければ 404", async () => {
    const app = makeApp();
    const a = await login(app, "MF", "F");
    const b = await login(app, "MG", "G");
    const p = await createProject(app, a, "不在");
    expect((await call(app, "DELETE", `/api/projects/${p.id}/members/NOBODY`, a)).status).toBe(404);
    expect((await call(app, "DELETE", `/api/projects/${p.id}/members/MF`, b)).status).toBe(404);
  });
  it("removeMemberUnlessLast は最後の 1 人を消さない（確認と削除が 1 文）", async () => {
    const app = makeApp();
    const a = await login(app, "MU1", "A");
    const b = await login(app, "MU2", "B");
    const p = await createProject(app, a, "同時");
    await joinViaInvite(app, p.id, a, b);
    expect(await removeMemberUnlessLast(env.DB, p.id, "MU1")).toBe(true);
    expect(await removeMemberUnlessLast(env.DB, p.id, "MU2")).toBe(false);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE project_id = ?").bind(p.id).first<{ n: number }>();
    expect(n?.n).toBe(1);
  });
});
