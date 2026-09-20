import { env } from "cloudflare:test";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActivityItem, ApiErrorBody, ProjectDetail, TaskMedia, TasksResponse } from "../../src/shared/types";
import { createFakeSheetsClient, memoryStore } from "../../src/worker/dev/fake-sheets";
import type { AppEnv } from "../../src/worker/env";
import { mediaKey } from "../../src/worker/media/store";
import { call, login, makeApp } from "./helpers";

// 2026-09-15T10:00:00+09:00（helpers の FIXED_NOW と同じ）
const NOW = new Date("2026-09-15T01:00:00Z");
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

function mp4(length = 64): Uint8Array {
  const b = new Uint8Array(length);
  b.set([0, 0, 0, 0x20, ...[..."ftypisom"].map((c) => c.charCodeAt(0))]);
  for (let i = 12; i < length; i++) b[i] = i % 251;
  return b;
}
function m4a(length = 40): Uint8Array {
  const b = new Uint8Array(length);
  b.set([0, 0, 0, 0x20, ...[..."ftypM4A "].map((c) => c.charCodeAt(0))]);
  return b;
}
const OGG = new Uint8Array([..."OggS"].map((c) => c.charCodeAt(0)).concat(Array(20).fill(1)));

function makeAppAt(store: ReturnType<typeof memoryStore>, now: Date = NOW) {
  return makeApp({ sheets: createFakeSheetsClient(store), now: () => now });
}

async function setupProject(app: Hono<AppEnv>, token: string) {
  const created = await (
    await call(app, "POST", "/api/projects", token, { name: "動画", parties: ["A社", "自社"] })
  ).json<ProjectDetail>();
  const res = await call(app, "POST", `/api/projects/${created.id}/sheet`, token, {
    url: `https://docs.google.com/spreadsheets/d/sidmedia${created.id}/edit`,
  });
  expect(res.status).toBe(200);
  const add = await call(app, "POST", `/api/projects/${created.id}/tasks`, token, { title: "一件目", ball: "A社" });
  expect(add.status).toBe(201);
  return created.id;
}

async function upload(
  app: Hono<AppEnv>,
  token: string,
  pid: string,
  taskId: string,
  body: Uint8Array,
  opts: { query?: string; contentLength?: string | null } = {},
) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" };
  const length = opts.contentLength === undefined ? String(body.byteLength) : opts.contentLength;
  if (length !== null) headers["Content-Length"] = length;
  return app.request(
    `/api/projects/${pid}/tasks/${taskId}/media${opts.query ?? "?kind=video&duration_ms=83000"}`,
    { method: "POST", headers, body },
    env,
  );
}

async function putThumb(app: Hono<AppEnv>, token: string, pid: string, id: string, body: Uint8Array = JPEG_BYTES) {
  return app.request(
    `/api/projects/${pid}/media/${id}/thumb`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/jpeg", "Content-Length": String(body.byteLength) },
      body,
    },
    env,
  );
}

async function list(app: Hono<AppEnv>, token: string, pid: string, taskId = "T-001") {
  const res = await call(app, "GET", `/api/projects/${pid}/tasks/${taskId}/media`, token);
  expect(res.status).toBe(200);
  return res.json<TaskMedia[]>();
}

async function errorCode(res: Response): Promise<string> {
  return (await res.json<ApiErrorBody>()).error;
}

async function r2Keys(pid: string): Promise<string[]> {
  const { objects } = await env.IMAGES.list({ prefix: `projects/${pid}/media/` });
  return objects.map((o) => o.key).sort();
}

async function joinViaInvite(app: Hono<AppEnv>, pid: string, owner: string, joiner: string): Promise<void> {
  const inv = await (await call(app, "POST", `/api/projects/${pid}/invites`, owner, { days: 7 })).json<{ url: string }>();
  const token = new URL(inv.url).searchParams.get("invite")!;
  expect((await call(app, "POST", `/api/invites/${token}/accept`, joiner)).status).toBe(200);
}

describe("動画・音声の追加と一覧", () => {
  it("追加すると 201 で TaskMedia を返し、R2 に形式つきで置き、活動記録に残す", async () => {
    const store = memoryStore();
    const app = makeAppAt(store);
    const token = await login(app, "MDA1", "A");
    const pid = await setupProject(app, token);
    const body = mp4();

    const res = await upload(app, token, pid, "T-001", body);
    expect(res.status).toBe(201);
    const m = await res.json<TaskMedia>();
    expect(m).toMatchObject({
      taskId: "T-001",
      kind: "video",
      contentType: "video/mp4",
      size: body.byteLength,
      durationMs: 83000,
      thumbUrl: null,
      createdBy: { lineUserId: "MDA1" },
    });
    expect(m.id).toMatch(/^[0-9a-z]{16}$/);
    expect(m.url).toMatch(new RegExp(`^/api/media/${m.id}\\?`));

    const obj = await env.IMAGES.get(mediaKey(pid, m.id, "full"));
    expect(obj?.httpMetadata?.contentType).toBe("video/mp4");
    expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(body);

    expect((await list(app, token, pid)).map((x) => x.id)).toEqual([m.id]);
    const acts = await (await call(app, "GET", `/api/projects/${pid}/activity`, token)).json<ActivityItem[]>();
    expect(acts.find((a) => a.action === "task.media_add")?.detail).toEqual({ taskId: "T-001", mediaId: m.id, kind: "video" });
  });

  it("音声は種類で形式を決め、長さは省ける", async () => {
    const store = memoryStore();
    const app = makeAppAt(store);
    const token = await login(app, "MDA2");
    const pid = await setupProject(app, token);
    const a = await upload(app, token, pid, "T-001", m4a(), { query: "?kind=audio" });
    expect(a.status).toBe(201);
    expect(await a.json<TaskMedia>()).toMatchObject({ kind: "audio", contentType: "audio/mp4", durationMs: null });
    const o = await upload(app, token, pid, "T-001", OGG, { query: "?kind=audio&duration_ms=0" });
    expect(await o.json<TaskMedia>()).toMatchObject({ contentType: "audio/ogg", durationMs: 0 });
  });

  it("タスク一覧に種類ごとの数が入る", async () => {
    const store = memoryStore();
    const app = makeAppAt(store);
    const token = await login(app, "MDA3");
    const pid = await setupProject(app, token);
    await upload(app, token, pid, "T-001", mp4());
    await upload(app, token, pid, "T-001", m4a(), { query: "?kind=audio" });
    await upload(app, token, pid, "T-001", m4a(), { query: "?kind=audio" });
    const res = await (await call(app, "GET", `/api/projects/${pid}/tasks`, token)).json<TasksResponse>();
    expect(res.mediaCounts).toEqual({ "T-001": { video: 1, audio: 2 } });
  });

  it("3 つまで。4 つ目は 409 media_limit で、R2 にも置かない", async () => {
    const store = memoryStore();
    const app = makeAppAt(store);
    const token = await login(app, "MDL1");
    const pid = await setupProject(app, token);
    for (let i = 0; i < 3; i++) expect((await upload(app, token, pid, "T-001", mp4())).status).toBe(201);
    const res = await upload(app, token, pid, "T-001", mp4());
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("media_limit");
    expect((await r2Keys(pid)).length).toBe(3);
  });

  it("形式が違う・種類と合わないものは 400 media_format で、R2 にも D1 にも残さない", async () => {
    const store = memoryStore();
    const app = makeAppAt(store);
    const token = await login(app, "MDF1");
    const pid = await setupProject(app, token);
    for (const [body, query] of [
      [JPEG_BYTES, "?kind=video"],
      [OGG, "?kind=video"],
      [new Uint8Array([0, 0, 0]), "?kind=video"],
    ] as const) {
      const res = await upload(app, token, pid, "T-001", body, { query });
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("media_format");
    }
    expect(await r2Keys(pid)).toEqual([]);
    expect(await list(app, token, pid)).toEqual([]);
  });

  it("大きさと長さの確認は本文を読む前に行う", async () => {
    const store = memoryStore();
    const app = makeAppAt(store);
    const token = await login(app, "MDS1");
    const pid = await setupProject(app, token);
    const big = await upload(app, token, pid, "T-001", mp4(), { contentLength: String(30 * 1024 * 1024 + 1) });
    expect(big.status).toBe(400);
    expect(await errorCode(big)).toBe("media_size");
    const zero = await upload(app, token, pid, "T-001", new Uint8Array(0), { contentLength: "0" });
    expect(zero.status).toBe(400);
    expect(await errorCode(zero)).toBe("media_size");
    const missing = await upload(app, token, pid, "T-001", mp4(), { contentLength: null });
    expect(missing.status).toBe(411);
    expect(await errorCode(missing)).toBe("length_required");
  });

  it.each(["?kind=image", "", "?kind=video&duration_ms=-1", "?kind=video&duration_ms=1.5", "?kind=video&duration_ms=3600001"])(
    "クエリ %s は 400 validation",
    async (query) => {
      const store = memoryStore();
      const app = makeAppAt(store);
      const token = await login(app, "MDQ1");
      const pid = await setupProject(app, token);
      const res = await upload(app, token, pid, "T-001", mp4(), { query });
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("validation");
    },
  );

  it("ID の無い行・無いタスク・メンバー以外・アーカイブ済み", async () => {
    const store = memoryStore();
    const app = makeAppAt(store);
    const token = await login(app, "MDP1");
    const other = await login(app, "MDP2");
    const pid = await setupProject(app, token);
    expect((await upload(app, token, pid, "row-2", mp4())).status).toBe(400);
    expect((await upload(app, token, pid, "T-999", mp4())).status).toBe(404);
    expect((await upload(app, other, pid, "T-001", mp4())).status).toBe(404);
    expect((await call(app, "GET", `/api/projects/${pid}/tasks/T-001/media`, other)).status).toBe(404);
    expect((await call(app, "POST", `/api/projects/${pid}/archive`, token)).status).toBe(200);
    const archived = await upload(app, token, pid, "T-001", mp4());
    expect(archived.status).toBe(409);
    expect(await errorCode(archived)).toBe("archived");
  });

  // ローカルの R2（miniflare）は、途中で切れた本文を受けると「Network connection lost」を uncaught として出す。
  // 応答と R2・D1 の状態は正しいので、その出力は無視してよい
  it("本文が Content-Length より短ければ 400 で、何も残さない", async () => {
    const store = memoryStore();
    const app = makeAppAt(store);
    const token = await login(app, "MDT1");
    const pid = await setupProject(app, token);
    const body = mp4(64);
    // 実際の本文より長い Content-Length を名乗る（途中で切れた送信）
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    });
    const res = await app.request(
      `/api/projects/${pid}/tasks/T-001/media?kind=video`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Length": "100" },
        body: stream,
        duplex: "half",
      } as RequestInit,
      env,
    );
    expect(res.status).toBe(400);
    expect(await r2Keys(pid)).toEqual([]);
    expect(await list(app, token, pid)).toEqual([]);
  });
});

describe("サムネイル", () => {
  it("追加した本人が 1 回だけ置ける。一覧に thumbUrl が出る", async () => {
    const store = memoryStore();
    const app = makeAppAt(store);
    const token = await login(app, "MTH1");
    const other = await login(app, "MTH2");
    const pid = await setupProject(app, token);
    await joinViaInvite(app, pid, token, other);
    const m = await (await upload(app, token, pid, "T-001", mp4())).json<TaskMedia>();

    const byOther = await putThumb(app, other, pid, m.id);
    expect(byOther.status).toBe(403);
    expect((await putThumb(app, token, pid, m.id)).status).toBe(204);
    const again = await putThumb(app, token, pid, m.id);
    expect(again.status).toBe(409);

    const [listed] = await list(app, token, pid);
    expect(listed.thumbUrl).toMatch(new RegExp(`^/api/media/${m.id}\\?.*size=thumb`));
    const thumb = await app.request(listed.thumbUrl!, {}, env);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await thumb.arrayBuffer())).toEqual(JPEG_BYTES);
  });

  it("JPEG でない・大きすぎる・10 分を過ぎたものは断る", async () => {
    const store = memoryStore();
    const app = makeAppAt(store);
    const token = await login(app, "MTH3");
    const pid = await setupProject(app, token);
    const m = await (await upload(app, token, pid, "T-001", mp4())).json<TaskMedia>();

    expect(await errorCode(await putThumb(app, token, pid, m.id, OGG))).toBe("image_format");
    const big = new Uint8Array(200 * 1024 + 1);
    big.set(JPEG_BYTES);
    expect(await errorCode(await putThumb(app, token, pid, m.id, big))).toBe("image_size");
    expect((await putThumb(app, token, pid, "nope", JPEG_BYTES)).status).toBe(404);

    const later = makeAppAt(store, new Date(NOW.getTime() + 11 * 60 * 1000));
    const late = await putThumb(later, token, pid, m.id);
    expect(late.status).toBe(409);
  });
});

describe("署名つき URL での再生", () => {
  async function prepared(uid: string) {
    const store = memoryStore();
    const app = makeAppAt(store);
    const token = await login(app, uid);
    const pid = await setupProject(app, token);
    const body = mp4(100);
    const m = await (await upload(app, token, pid, "T-001", body)).json<TaskMedia>();
    return { store, app, token, pid, body, m };
  }

  it("セッション無しで全体を返す。ヘッダーつき", async () => {
    const { app, body, m } = await prepared("MPL1");
    const res = await app.request(m.url, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-length")).toBe("100");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(body);
  });

  it("Range には 206 で範囲だけ返し、満たせなければ 416", async () => {
    const { app, body, m } = await prepared("MPL2");
    const part = await app.request(m.url, { headers: { Range: "bytes=10-19" } }, env);
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 10-19/100");
    expect(part.headers.get("content-length")).toBe("10");
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(body.slice(10, 20));

    const tail = await app.request(m.url, { headers: { Range: "bytes=-5" } }, env);
    expect(tail.headers.get("content-range")).toBe("bytes 95-99/100");

    const bad = await app.request(m.url, { headers: { Range: "bytes=100-" } }, env);
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe("bytes */100");
  });

  it("署名・期限・サムネイルの有無・削除のどれかが合わなければ 404", async () => {
    const { store, app, token, pid, m } = await prepared("MPL3");
    const u = new URL(m.url, "https://x.test");

    const tampered = new URL(u);
    tampered.searchParams.set("sig", "AAAA");
    expect((await app.request(tampered.pathname + tampered.search, {}, env)).status).toBe(404);

    const otherSize = new URL(u);
    otherSize.searchParams.set("size", "thumb");
    expect((await app.request(otherSize.pathname + otherSize.search, {}, env)).status).toBe(404);

    const noSig = new URL(u);
    noSig.searchParams.delete("sig");
    expect((await app.request(noSig.pathname + noSig.search, {}, env)).status).toBe(404);

    const expired = makeAppAt(store, new Date(NOW.getTime() + 2 * 3600 * 1000));
    expect((await expired.request(m.url, {}, env)).status).toBe(404);

    // サムネイルが無ければ、正しい署名でも 404
    const [listed] = await list(app, token, pid);
    expect(listed.thumbUrl).toBeNull();

    expect((await call(app, "DELETE", `/api/projects/${pid}/media/${m.id}`, token)).status).toBe(204);
    expect((await app.request(m.url, {}, env)).status).toBe(404);
  });
});

describe("削除", () => {
  it("メンバーなら誰でも消せる。R2 から消え、一覧から消え、活動記録に残る", async () => {
    const store = memoryStore();
    const app = makeAppAt(store);
    const token = await login(app, "MDD1");
    const other = await login(app, "MDD2");
    const pid = await setupProject(app, token);
    await joinViaInvite(app, pid, token, other);
    const m = await (await upload(app, token, pid, "T-001", mp4())).json<TaskMedia>();
    await putThumb(app, token, pid, m.id);

    expect((await call(app, "DELETE", `/api/projects/${pid}/media/${m.id}`, other)).status).toBe(204);
    expect(await r2Keys(pid)).toEqual([]);
    expect(await list(app, token, pid)).toEqual([]);
    expect((await call(app, "DELETE", `/api/projects/${pid}/media/${m.id}`, other)).status).toBe(404);
    const acts = await (await call(app, "GET", `/api/projects/${pid}/activity`, token)).json<ActivityItem[]>();
    expect(acts.find((a) => a.action === "task.media_delete")?.detail).toEqual({ taskId: "T-001", mediaId: m.id, kind: "video" });
  });

  it("アーカイブ済みは 409", async () => {
    const store = memoryStore();
    const app = makeAppAt(store);
    const token = await login(app, "MDD3");
    const pid = await setupProject(app, token);
    const m = await (await upload(app, token, pid, "T-001", mp4())).json<TaskMedia>();
    await call(app, "POST", `/api/projects/${pid}/archive`, token);
    expect((await call(app, "DELETE", `/api/projects/${pid}/media/${m.id}`, token)).status).toBe(409);
    // アーカイブ済みでも見られる
    const [listed] = await list(app, token, pid);
    expect((await app.request(listed.url, {}, env)).status).toBe(200);
  });
});
