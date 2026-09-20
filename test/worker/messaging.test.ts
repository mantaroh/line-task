import { describe, expect, it } from "vitest";
import { createMessagingClient, MessagingError } from "../../src/worker/line/messaging";

function recorder(responses: Response[]) {
  const calls: Request[] = [];
  const fetchFn = (async (input: RequestInfo, init?: RequestInit) => {
    calls.push(new Request(input, init));
    return responses.shift() ?? new Response(null, { status: 500 });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe("MessagingClient", () => {
  it("push のリクエストの形", async () => {
    const { calls, fetchFn } = recorder([Response.json({})]);
    const m = createMessagingClient("tok", fetchFn, async () => {});
    expect(await m.pushText("U1", "こんにちは", "1b4e28ba-2fa1-41d2-883f-0016d3cca427")).toBe("sent");
    expect(calls[0].url).toBe("https://api.line.me/v2/bot/message/push");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.get("Authorization")).toBe("Bearer tok");
    expect(calls[0].headers.get("X-Line-Retry-Key")).toBe("1b4e28ba-2fa1-41d2-883f-0016d3cca427");
    expect(await calls[0].json()).toEqual({ to: "U1", messages: [{ type: "text", text: "こんにちは" }] });
  });
  it("409 は送信済み", async () => {
    const { fetchFn } = recorder([new Response("{}", { status: 409 })]);
    expect(await createMessagingClient("tok", fetchFn, async () => {}).pushText("U1", "x", "k")).toBe("duplicate");
  });
  it("429 は 1 回だけ待って再試行し、2 回目も失敗なら MessagingError", async () => {
    const waits: number[] = [];
    const ok = recorder([new Response(null, { status: 429 }), Response.json({})]);
    expect(await createMessagingClient("tok", ok.fetchFn, async (ms) => { waits.push(ms); }).pushText("U1", "x", "k")).toBe("sent");
    expect(waits).toEqual([1000]);
    const ng = recorder([new Response(null, { status: 503 }), new Response("secret-body", { status: 503 })]);
    const err = await createMessagingClient("tok", ng.fetchFn, async () => {}).pushText("U1", "x", "k").catch((e) => e);
    expect(err).toBeInstanceOf(MessagingError);
    expect(err.status).toBe(503);
    expect(String(err.message)).not.toContain("secret-body");
  });
  it("400 は再試行しない", async () => {
    const r = recorder([new Response(null, { status: 400 })]);
    await expect(createMessagingClient("tok", r.fetchFn, async () => {}).pushText("U1", "x", "k")).rejects.toMatchObject({ status: 400 });
    expect(r.calls).toHaveLength(1);
  });
  it("残り通数", async () => {
    const limited = recorder([Response.json({ type: "limited", value: 200 }), Response.json({ totalUsage: 150 })]);
    expect(await createMessagingClient("tok", limited.fetchFn).getQuota()).toEqual({ limit: 200, used: 150 });
    expect(limited.calls.map((c) => c.url)).toEqual([
      "https://api.line.me/v2/bot/message/quota",
      "https://api.line.me/v2/bot/message/quota/consumption",
    ]);
    const none = recorder([Response.json({ type: "none" }), Response.json({ totalUsage: 3 })]);
    expect(await createMessagingClient("tok", none.fetchFn).getQuota()).toEqual({ limit: null, used: 3 });
  });
  it("友だちの確認", async () => {
    const r = recorder([Response.json({ userId: "U1" }), new Response(null, { status: 404 }), new Response(null, { status: 401 })]);
    const m = createMessagingClient("tok", r.fetchFn, async () => {});
    expect(await m.isFriend("U1")).toBe(true);
    expect(await m.isFriend("U 2")).toBe(false);
    expect(r.calls[1].url).toBe("https://api.line.me/v2/bot/profile/U%202");
    await expect(m.isFriend("U3")).rejects.toMatchObject({ status: 401 });
  });
  it("通信に失敗したら状態コード 0 の MessagingError", async () => {
    const fetchFn = (async () => {
      throw new TypeError("network down U1");
    }) as typeof fetch;
    const m = createMessagingClient("tok", fetchFn, async () => {});
    const err = await m.isFriend("U1").catch((e) => e);
    expect(err).toBeInstanceOf(MessagingError);
    expect(err.status).toBe(0);
    expect(String(err.message)).not.toContain("U1");
    await expect(m.pushText("U1", "x", "k")).rejects.toMatchObject({ status: 0 });
    await expect(m.getQuota()).rejects.toMatchObject({ status: 0 });
  });
  it("時間切れも状態コード 0 の MessagingError", async () => {
    const fetchFn = ((_: RequestInfo, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof fetch;
    const m = createMessagingClient("tok", fetchFn, async () => {}, 10);
    await expect(m.isFriend("U1")).rejects.toMatchObject({ status: 0, message: "Messaging API request failed" });
  });
  it("すべてのリクエストに signal を付ける", async () => {
    const r = recorder([Response.json({ userId: "U1" })]);
    await createMessagingClient("tok", r.fetchFn).isFriend("U1");
    expect(r.calls[0].signal).toBeInstanceOf(AbortSignal);
  });
  it("読まない応答の本文は捨てる", async () => {
    const cancelled: string[] = [];
    const tracked = (label: string, status: number) =>
      new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(new TextEncoder().encode("secret-body"));
          },
          cancel() {
            cancelled.push(label);
          },
        }),
        { status },
      );
    const r = recorder([tracked("push-200", 200), tracked("retry-429", 429), tracked("after-500", 500), tracked("profile-404", 404)]);
    const m = createMessagingClient("tok", r.fetchFn, async () => {});
    expect(await m.pushText("U1", "x", "k")).toBe("sent");
    await expect(m.pushText("U1", "x", "k")).rejects.toMatchObject({ status: 500 });
    expect(await m.isFriend("U1")).toBe(false);
    expect(cancelled).toEqual(["push-200", "retry-429", "after-500", "profile-404"]);
  });
  it("残り通数の応答が JSON でなければ、本文を含まない MessagingError", async () => {
    const r = recorder([new Response("secret-body", { status: 200 })]);
    const err = await createMessagingClient("tok", r.fetchFn).getQuota().catch((e) => e);
    expect(err).toBeInstanceOf(MessagingError);
    expect(err.message).toBe("Messaging API invalid JSON");
    expect(String(err.message)).not.toContain("secret-body");
  });
});
