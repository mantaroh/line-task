import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ApiErrorBody, InvitePreview, InviteSummary, ProjectDetail } from "../../src/shared/types";
import { sha256Hex } from "../../src/worker/crypto";
import type { AppEnv } from "../../src/worker/env";
import { call, login, makeApp } from "./helpers";
import type { Hono } from "hono";

async function createProject(app: Hono<AppEnv>, token: string, name = "A社 部門"): Promise<ProjectDetail> {
  const res = await call(app, "POST", "/api/projects", token, { name, parties: ["a", "b"] });
  return res.json<ProjectDetail>();
}

describe("招待", () => {
  it("発行 → 別の人が中身を見る → 参加する", async () => {
    const app = makeApp();
    const a = await login(app, "UA", "A");
    const b = await login(app, "UB", "B");
    const p = await createProject(app, a);
    const created = await call(app, "POST", `/api/projects/${p.id}/invites`, a, { days: 7 });
    expect(created.status).toBe(201);
    const inv = await created.json<{ id: string; url: string; expiresAt: string }>();
    expect(inv.expiresAt).toBe("2026-09-22T10:00:00+09:00");
    expect(inv.url.startsWith("https://example.test/app?invite=")).toBe(true);
    const token = new URL(inv.url).searchParams.get("invite")!;
    const preview = await (await call(app, "GET", `/api/invites/${token}`, b)).json<InvitePreview>();
    expect(preview).toMatchObject({
      projectId: p.id,
      projectName: p.name,
      invitedBy: "A",
      status: "valid",
      alreadyMember: false,
      expiresAt: inv.expiresAt,
    });
    expect((await call(app, "POST", `/api/invites/${token}/accept`, b)).status).toBe(200);
    expect((await call(app, "GET", `/api/projects/${p.id}`, b)).status).toBe(200);
    const list = await (await call(app, "GET", `/api/projects/${p.id}/invites`, a)).json<InviteSummary[]>();
    expect(list[0].useCount).toBe(1);
    expect(list[0].id).toBe(inv.id);
    expect(JSON.stringify(list)).not.toContain(token);
    expect((await call(app, "POST", `/api/invites/${token}/accept`, b)).status).toBe(200);
    const listAgain = await (await call(app, "GET", `/api/projects/${p.id}/invites`, a)).json<InviteSummary[]>();
    expect(listAgain[0].useCount).toBe(1);
    const after = await (await call(app, "GET", `/api/invites/${token}`, b)).json<InvitePreview>();
    expect(after.alreadyMember).toBe(true);
  });

  it("D1 にはトークンを置かない", async () => {
    const app = makeApp();
    const a = await login(app, "IH", "H");
    const p = await createProject(app, a, "hash");
    const inv = await (await call(app, "POST", `/api/projects/${p.id}/invites`, a, { days: 7 })).json<{
      id: string;
      url: string;
    }>();
    const token = new URL(inv.url).searchParams.get("invite")!;
    const row = await env.DB.prepare("SELECT * FROM invites WHERE id = ?").bind(inv.id).first<Record<string, unknown>>();
    expect(row).not.toBeNull();
    expect(row!.token_hash).toBe(await sha256Hex(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("期限切れ・取り消し・アーカイブは参加できない", async () => {
    const app = makeApp();
    const a = await login(app, "IA", "A");
    const b = await login(app, "IB", "B");
    const c = await login(app, "IC", "C");
    const p = await createProject(app, a, "期限");

    const expiredInv = await (
      await call(app, "POST", `/api/projects/${p.id}/invites`, a, { days: 1 })
    ).json<{ url: string }>();
    const expiredToken = new URL(expiredInv.url).searchParams.get("invite")!;
    const expiredApp = makeApp({ now: () => new Date("2026-09-16T01:00:01Z") });
    const bLater = await login(expiredApp, "IB", "B");
    const expiredRes = await call(expiredApp, "POST", `/api/invites/${expiredToken}/accept`, bLater);
    expect(expiredRes.status).toBe(410);
    const expiredBody = await expiredRes.json<ApiErrorBody>();
    expect(expiredBody).toEqual({ error: "invite_expired", message: "この招待リンクは期限切れです" });

    const joinInv = await (await call(app, "POST", `/api/projects/${p.id}/invites`, a, { days: 7 })).json<{ url: string }>();
    const joinToken = new URL(joinInv.url).searchParams.get("invite")!;
    expect((await call(app, "POST", `/api/invites/${joinToken}/accept`, c)).status).toBe(200);

    const toRevoke = await (
      await call(app, "POST", `/api/projects/${p.id}/invites`, a, { days: 7 })
    ).json<{ id: string; url: string }>();
    const revokedToken = new URL(toRevoke.url).searchParams.get("invite")!;
    expect((await call(app, "DELETE", `/api/projects/${p.id}/invites/${toRevoke.id}`, c)).status).toBe(204);
    const revokedRes = await call(app, "POST", `/api/invites/${revokedToken}/accept`, b);
    expect(revokedRes.status).toBe(410);
    expect(await revokedRes.json<ApiErrorBody>()).toEqual({
      error: "invite_revoked",
      message: "この招待リンクは取り消されています",
    });

    const beforeArchive = await (
      await call(app, "POST", `/api/projects/${p.id}/invites`, a, { days: 7 })
    ).json<{ url: string }>();
    const archivedToken = new URL(beforeArchive.url).searchParams.get("invite")!;
    await call(app, "POST", `/api/projects/${p.id}/archive`, a);
    const createAfter = await call(app, "POST", `/api/projects/${p.id}/invites`, a, { days: 7 });
    expect(createAfter.status).toBe(409);
    expect((await createAfter.json<ApiErrorBody>()).error).toBe("archived");
    const archivedRes = await call(app, "POST", `/api/invites/${archivedToken}/accept`, b);
    expect(archivedRes.status).toBe(410);
    expect(await archivedRes.json<ApiErrorBody>()).toEqual({
      error: "invite_archived",
      message: "このプロジェクトはアーカイブされています",
    });
  });

  it("メンバーでない人は発行・一覧・取り消しができない（404）", async () => {
    const app = makeApp();
    const a = await login(app, "ID", "D");
    const b = await login(app, "IE", "E");
    const p = await createProject(app, a, "権限");
    const inv = await (await call(app, "POST", `/api/projects/${p.id}/invites`, a, { days: 7 })).json<{ id: string }>();
    expect((await call(app, "POST", `/api/projects/${p.id}/invites`, b, { days: 7 })).status).toBe(404);
    expect((await call(app, "GET", `/api/projects/${p.id}/invites`, b)).status).toBe(404);
    expect((await call(app, "DELETE", `/api/projects/${p.id}/invites/${inv.id}`, b)).status).toBe(404);
  });

  it("days は 1・7・30 以外 400", async () => {
    const app = makeApp();
    const a = await login(app, "IF", "F");
    const p = await createProject(app, a, "days");
    for (const days of [0, 2, 14, 8, -1, "7"]) {
      const res = await call(app, "POST", `/api/projects/${p.id}/invites`, a, { days });
      expect(res.status).toBe(400);
      expect((await res.json<ApiErrorBody>()).error).toBe("validation");
    }
    const missing = await call(app, "POST", `/api/projects/${p.id}/invites`, a, {});
    expect(missing.status).toBe(201);
    expect((await missing.json<{ expiresAt: string }>()).expiresAt).toBe("2026-09-22T10:00:00+09:00");
    expect((await call(app, "POST", `/api/projects/${p.id}/invites`, a, { days: 1 })).status).toBe(201);
    expect((await call(app, "POST", `/api/projects/${p.id}/invites`, a, { days: 30 })).status).toBe(201);
    expect((await call(app, "GET", "/api/invites/unknown-token", a)).status).toBe(404);
    expect((await call(app, "DELETE", `/api/projects/${p.id}/invites/zzzzzzzzzz`, a)).status).toBe(404);
  });
});
