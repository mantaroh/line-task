import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/worker/index";

describe("土台", () => {
  it("移行が当たっている", async () => {
    const r = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all<{ name: string }>();
    expect(r.results.map((x) => x.name)).toEqual(
      expect.arrayContaining(["activity", "invites", "members", "projects", "sheet_bindings", "users"]),
    );
  });

  it("/api の未定義は JSON の 404", async () => {
    const res = await createApp().request("/api/nope", {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found", message: "見つかりません" });
  });
});
