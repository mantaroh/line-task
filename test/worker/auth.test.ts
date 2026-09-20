import { describe, expect, it } from "vitest";
import { signSession, verifyLineIdToken, verifySession } from "../../src/worker/auth";
import { isDevMocksEnabled } from "../../src/worker/deps";
import { fakeVerifyIdToken } from "../../src/worker/dev/fake-line";
import type { SessionResponse } from "../../src/shared/types";
import { call, login, makeApp } from "./helpers";

describe("認証", () => {
  it("ID トークンでセッションを作り、users に保存する", async () => {
    const app = makeApp();
    const res = await call(app, "POST", "/api/session", undefined, { idToken: "tok:U1:A社の担当B" });
    expect(res.status).toBe(200);
    const body = await res.json<SessionResponse>();
    expect(body.user).toEqual({ lineUserId: "U1", displayName: "A社の担当B", pictureUrl: null });
    expect(body.isNew).toBe(true);
    const again = await (
      await call(app, "POST", "/api/session", undefined, { idToken: "tok:U1:担当B" })
    ).json<SessionResponse>();
    expect(again.isNew).toBe(false);
    expect(again.user.displayName).toBe("担当B"); // 表示名は毎回更新
  });

  it("検証に失敗したら 401", async () => {
    const res = await call(makeApp(), "POST", "/api/session", undefined, { idToken: "bad" });
    expect(res.status).toBe(401);
  });

  it("セッションなし・改ざん・期限切れは 401", async () => {
    const app = makeApp();
    expect((await call(app, "GET", "/api/config")).status).toBe(401);
    const token = await login(app, "U1");
    expect((await call(app, "GET", "/api/config", token + "x")).status).toBe(401);
    const late = makeApp({ now: () => new Date("2026-09-15T13:00:01Z") }); // 発行から 12 時間と 1 秒後
    expect((await call(late, "GET", "/api/config", token)).status).toBe(401);
  });

  it("LINE の verify API に正しいパラメータを送る", async () => {
    const calls: Request[] = [];
    const fetchFn = (async (input: RequestInfo, init?: RequestInit) => {
      calls.push(new Request(input, init));
      return Response.json({ sub: "U9", name: "n", picture: "https://p" });
    }) as typeof fetch;
    const p = await verifyLineIdToken("idt", "ch1", fetchFn);
    expect(p).toEqual({ sub: "U9", name: "n", picture: "https://p" });
    expect(calls[0].url).toBe("https://api.line.me/oauth2/v2.1/verify");
    expect(await calls[0].text()).toBe("id_token=idt&client_id=ch1");
  });

  it("DEV_MOCKS はホストが localhost のときだけ効く", () => {
    expect(isDevMocksEnabled({ DEV_MOCKS: "1" }, "http://localhost:5173/api/session")).toBe(true);
    expect(isDevMocksEnabled({ DEV_MOCKS: "1" }, "http://127.0.0.1:5173/api/session")).toBe(true);
    expect(isDevMocksEnabled({ DEV_MOCKS: "1" }, "https://line-task-board.example.workers.dev/api/session")).toBe(
      false,
    );
    expect(isDevMocksEnabled({ DEV_MOCKS: undefined }, "http://localhost/")).toBe(false);
  });

  it("開発用の LINE 検証はダミーの 3 人だけ通す", async () => {
    expect(await fakeVerifyIdToken("dev:dev-bob")).toEqual({ sub: "dev-bob", name: "Bob", picture: null });
    await expect(fakeVerifyIdToken("dev:someone")).rejects.toThrow();
  });
  it("SESSION_SECRET が空・短すぎるときは署名も検証もしない", async () => {
    const now = new Date("2026-09-16T00:00:00Z");
    const user = { lineUserId: "U1", displayName: "A" };
    await expect(signSession(user, "", now)).rejects.toThrow("SESSION_SECRET");
    await expect(signSession(user, "short", now)).rejects.toThrow("SESSION_SECRET");
    const token = await signSession(user, "x".repeat(16), now);
    await expect(verifySession(token, "", now)).rejects.toThrow("SESSION_SECRET");
  });
});
