// Cron（scheduled ハンドラー）が、30 日より前の access_log を消すことを確認する。
// LINE_MESSAGING_TOKEN が無いテスト環境では messaging が null になり、
// runNotifications は何もしないので、ここでは prune だけを見ればよい。
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index";
import { login, makeApp } from "./helpers";

const OLD_AT = "2000-01-01T00:00:00+09:00"; // 確実に 30 日より前
const RECENT_AT = "2026-09-15T10:00:00+09:00"; // 直近の日時（境界を跨がない範囲）

async function insertAccessLog(uid: string, at: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO access_log (at, line_user_id, project_id, view) VALUES (?, ?, NULL, 'home')`)
    .bind(at, uid)
    .run();
}

async function atsFor(uid: string): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT at FROM access_log WHERE line_user_id = ? ORDER BY at")
    .bind(uid)
    .all<{ at: string }>();
  return results.map((r) => r.at);
}

describe("scheduled", () => {
  it("30 日より前の access_log だけを消す", async () => {
    const app = makeApp();
    await login(app, "USCHED1", "A"); // access_log.line_user_id は users への外部キー

    await insertAccessLog("USCHED1", OLD_AT);
    await insertAccessLog("USCHED1", RECENT_AT);

    const controller = { scheduledTime: Date.now(), cron: "0 0 * * *", noRetry: () => {} };
    const ctx = createExecutionContext();

    await worker.scheduled!(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await atsFor("USCHED1")).toEqual([RECENT_AT]);
  });
});
