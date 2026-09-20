import { env } from "cloudflare:test";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActivityItem, ApiErrorBody, ProjectDetail, TaskFile, TasksResponse } from "../../src/shared/types";
import { createFakeSheetsClient, memoryStore } from "../../src/worker/dev/fake-sheets";
import type { AppEnv } from "../../src/worker/env";
import { fileKey } from "../../src/worker/files/store";
import { call, login, makeApp } from "./helpers";

// 2026-09-15T10:00:00+09:00（helpers の FIXED_NOW と同じ）
const NOW = new Date("2026-09-15T01:00:00Z");

// 文字列は UTF-8 に直す（charCodeAt だと日本語が下位 8 ビットに潰れて制御文字になる）
const utf8 = (s: string) => new TextEncoder().encode(s);
function pdf(length = 64): Uint8Array {
  const b = new Uint8Array(length);
  b.set(utf8("%PDF-1.7"));
  for (let i = 8; i < length; i++) b[i] = 0x41;
  return b;
}
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0, 0, 0, 0]);
const CSV = utf8("id,name\n1,A社\n");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function makeAppAt(store: ReturnType<typeof memoryStore>, now: Date = NOW) {
  return makeApp({ sheets: createFakeSheetsClient(store), now: () => now });
}

async function setupProject(app: Hono<AppEnv>, token: string) {
  const created = await (
    await call(app, "POST", "/api/projects", token, { name: "資料", parties: ["A社", "自社"] })
  ).json<ProjectDetail>();
  const res = await call(app, "POST", `/api/projects/${created.id}/sheet`, token, {
    url: `https://docs.google.com/spreadsheets/d/sidfiles${created.id}/edit`,
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
  opts: { name?: string; contentLength?: string | null } = {},
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/octet-stream",
  };
  const length = opts.contentLength === undefined ? String(body.byteLength) : opts.contentLength;
  if (length !== null) headers["Content-Length"] = length;
  const q = opts.name === undefined ? "?name=%E8%A6%8B%E7%A9%8D%E6%9B%B8.pdf" : `?name=${encodeURIComponent(opts.name)}`;
  return app.request(`/api/projects/${pid}/tasks/${taskId}/files${q}`, { method: "POST", headers, body }, env);
}

async function list(app: Hono<AppEnv>, token: string, pid: string, taskId = "T-001") {
  const res = await call(app, "GET", `/api/projects/${pid}/tasks/${taskId}/files`, token);
  expect(res.status).toBe(200);
  return res.json<TaskFile[]>();
}

async function errorCode(res: Response): Promise<string> {
  return (await res.json<ApiErrorBody>()).error;
}

async function r2Keys(pid: string): Promise<string[]> {
  const { objects } = await env.IMAGES.list({ prefix: `projects/${pid}/files/` });
  return objects.map((o) => o.key).sort();
}

describe("ファイルの追加と一覧", () => {
  it("追加すると 201 で TaskFile を返し、R2 に形式つきで置き、活動記録に残す", async () => {
    const app = makeAppAt(memoryStore());
    const token = await login(app, "FA01", "A");
    const pid = await setupProject(app, token);
    const body = pdf();

    const res = await upload(app, token, pid, "T-001", body);
    expect(res.status).toBe(201);
    const f = await res.json<TaskFile>();
    expect(f).toMatchObject({
      taskId: "T-001",
      name: "見積書.pdf",
      contentType: "application/pdf",
      size: body.byteLength,
      createdBy: { lineUserId: "FA01" },
    });
    expect(f.id).toMatch(/^[0-9a-z]{16}$/);
    expect(f.url).toMatch(new RegExp(`^/api/files/${f.id}\\?`));

    const obj = await env.IMAGES.get(fileKey(pid, f.id));
    expect(obj?.httpMetadata?.contentType).toBe("application/pdf");
    expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(body);

    expect((await list(app, token, pid)).map((x) => x.id)).toEqual([f.id]);
    const acts = await (await call(app, "GET", `/api/projects/${pid}/activity`, token)).json<ActivityItem[]>();
    expect(acts.find((a) => a.action === "task.file_add")?.detail).toEqual({
      taskId: "T-001",
      fileId: f.id,
      name: "見積書.pdf",
    });
  });

  it("zip 系とテキストも拡張子で形式が決まる", async () => {
    const app = makeAppAt(memoryStore());
    const token = await login(app, "FA02");
    const pid = await setupProject(app, token);
    const x = await upload(app, token, pid, "T-001", ZIP, { name: "一覧.xlsx" });
    expect(await x.json<TaskFile>()).toMatchObject({
      name: "一覧.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const c = await upload(app, token, pid, "T-001", CSV, { name: "data.csv" });
    expect(await c.json<TaskFile>()).toMatchObject({ contentType: "text/csv" });
  });

  it("5 件まで。6 件目は 409 file_limit で、R2 にも置かない", async () => {
    const app = makeAppAt(memoryStore());
    const token = await login(app, "FA03");
    const pid = await setupProject(app, token);
    for (let i = 0; i < 5; i++) expect((await upload(app, token, pid, "T-001", pdf())).status).toBe(201);
    const res = await upload(app, token, pid, "T-001", pdf());
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("file_limit");
    expect((await r2Keys(pid)).length).toBe(5);
  });

  it("拡張子が許可外・中身と合わないものは 400 file_format で、何も残さない", async () => {
    const app = makeAppAt(memoryStore());
    const token = await login(app, "FA04");
    const pid = await setupProject(app, token);
    for (const [body, name] of [
      [pdf(), "run.exe"],
      [pdf(), "見積書"],
      [PNG, "memo.txt"],
      [CSV, "見積書.pdf"],
    ] as const) {
      const res = await upload(app, token, pid, "T-001", body, { name });
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("file_format");
    }
    expect(await r2Keys(pid)).toEqual([]);
    expect(await list(app, token, pid)).toEqual([]);
  });

  it("名前と大きさの確認は本文を読む前に行う", async () => {
    const app = makeAppAt(memoryStore());
    const token = await login(app, "FA05");
    const pid = await setupProject(app, token);

    const big = await upload(app, token, pid, "T-001", pdf(), { contentLength: String(10 * 1024 * 1024 + 1) });
    expect(big.status).toBe(400);
    expect(await errorCode(big)).toBe("file_size");

    const zero = await upload(app, token, pid, "T-001", new Uint8Array(0), { contentLength: "0" });
    expect(await errorCode(zero)).toBe("file_size");

    const missing = await upload(app, token, pid, "T-001", pdf(), { contentLength: null });
    expect(missing.status).toBe(411);
    expect(await errorCode(missing)).toBe("length_required");

    const long = await upload(app, token, pid, "T-001", pdf(), { name: `${"あ".repeat(300)}.pdf` });
    expect(long.status).toBe(400);
    expect(await errorCode(long)).toBe("file_name");

    const empty = await app.request(
      `/api/projects/${pid}/tasks/T-001/files`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Length": String(pdf().byteLength) },
        body: pdf(),
      },
      env,
    );
    expect(await errorCode(empty)).toBe("file_name");
    expect(await r2Keys(pid)).toEqual([]);
  });

  it("名前はパス区切りと制御文字を落として保存する", async () => {
    const app = makeAppAt(memoryStore());
    const token = await login(app, "FA06");
    const pid = await setupProject(app, token);
    const res = await upload(app, token, pid, "T-001", pdf(), { name: "../../etc/見積.pdf" });
    expect(res.status).toBe(201);
    expect((await res.json<TaskFile>()).name).toBe("....etc見積.pdf");
  });

  it("ID の無い行・無いタスク・メンバー以外・アーカイブ済み", async () => {
    const app = makeAppAt(memoryStore());
    const token = await login(app, "FA07");
    const other = await login(app, "FA08");
    const pid = await setupProject(app, token);
    expect((await upload(app, token, pid, "row-2", pdf())).status).toBe(400);
    expect((await upload(app, token, pid, "T-999", pdf())).status).toBe(404);
    expect((await upload(app, other, pid, "T-001", pdf())).status).toBe(404);
    expect((await call(app, "GET", `/api/projects/${pid}/tasks/T-001/files`, other)).status).toBe(404);
    expect((await call(app, "POST", `/api/projects/${pid}/archive`, token)).status).toBe(200);
    const archived = await upload(app, token, pid, "T-001", pdf());
    expect(archived.status).toBe(409);
    expect(await errorCode(archived)).toBe("archived");
  });

  it("タスク一覧に件数が入る", async () => {
    const app = makeAppAt(memoryStore());
    const token = await login(app, "FA09");
    const pid = await setupProject(app, token);
    await upload(app, token, pid, "T-001", pdf());
    await upload(app, token, pid, "T-001", ZIP, { name: "一覧.xlsx" });
    const res = await (await call(app, "GET", `/api/projects/${pid}/tasks`, token)).json<TasksResponse>();
    expect(res.fileCounts).toEqual({ "T-001": 2 });
  });
});

describe("署名つき URL での取り出し", () => {
  async function prepared(uid: string, body: Uint8Array, name: string) {
    const store = memoryStore();
    const app = makeAppAt(store);
    const token = await login(app, uid);
    const pid = await setupProject(app, token);
    const f = await (await upload(app, token, pid, "T-001", body, { name })).json<TaskFile>();
    return { store, app, token, pid, body, f };
  }

  it("PDF はセッション無しで inline で返す", async () => {
    const { app, body, f } = await prepared("FG01", pdf(100), "見積書.pdf");
    const res = await app.request(f.url, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-length")).toBe("100");
    expect(res.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''%E8%A6%8B%E7%A9%8D%E6%9B%B8.pdf");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(body);
  });

  it("PDF 以外は attachment で、sandbox を付ける", async () => {
    const { app, f } = await prepared("FG02", ZIP, "一覧.xlsx");
    const res = await app.request(f.url, {}, env);
    expect(res.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''%E4%B8%80%E8%A6%A7.xlsx");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });

  it("署名・期限・削除のどれかが合わなければ 404", async () => {
    const { store, app, token, pid, f } = await prepared("FG03", pdf(), "見積書.pdf");
    const u = new URL(f.url, "https://x.test");

    const tampered = new URL(u);
    tampered.searchParams.set("sig", "AAAA");
    expect((await app.request(tampered.pathname + tampered.search, {}, env)).status).toBe(404);

    const noSig = new URL(u);
    noSig.searchParams.delete("sig");
    expect((await app.request(noSig.pathname + noSig.search, {}, env)).status).toBe(404);

    // 動画のサムネイル用の size は受け付けない
    const withSize = new URL(u);
    withSize.searchParams.set("size", "thumb");
    expect((await app.request(withSize.pathname + withSize.search, {}, env)).status).toBe(404);

    const expired = makeAppAt(store, new Date(NOW.getTime() + 2 * 3600 * 1000));
    expect((await expired.request(f.url, {}, env)).status).toBe(404);

    expect((await call(app, "DELETE", `/api/projects/${pid}/files/${f.id}`, token)).status).toBe(204);
    expect((await app.request(f.url, {}, env)).status).toBe(404);
  });

  it("Range は無視して全体を返す", async () => {
    const { app, body, f } = await prepared("FG04", pdf(100), "見積書.pdf");
    const res = await app.request(f.url, { headers: { Range: "bytes=10-19" } }, env);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(body);
  });
});

describe("ファイルの削除", () => {
  async function joinViaInvite(app: Hono<AppEnv>, pid: string, owner: string, joiner: string): Promise<void> {
    const inv = await (await call(app, "POST", `/api/projects/${pid}/invites`, owner, { days: 7 })).json<{ url: string }>();
    const token = new URL(inv.url).searchParams.get("invite")!;
    expect((await call(app, "POST", `/api/invites/${token}/accept`, joiner)).status).toBe(200);
  }

  it("メンバーなら誰でも消せる。R2 から消え、一覧から消え、活動記録に残る", async () => {
    const app = makeAppAt(memoryStore());
    const token = await login(app, "FD01");
    const other = await login(app, "FD02");
    const pid = await setupProject(app, token);
    await joinViaInvite(app, pid, token, other);
    const f = await (await upload(app, token, pid, "T-001", pdf())).json<TaskFile>();

    expect((await call(app, "DELETE", `/api/projects/${pid}/files/${f.id}`, other)).status).toBe(204);
    expect(await r2Keys(pid)).toEqual([]);
    expect(await list(app, token, pid)).toEqual([]);
    expect((await call(app, "DELETE", `/api/projects/${pid}/files/${f.id}`, other)).status).toBe(404);

    const acts = await (await call(app, "GET", `/api/projects/${pid}/activity`, token)).json<ActivityItem[]>();
    expect(acts.find((a) => a.action === "task.file_delete")?.detail).toEqual({
      taskId: "T-001",
      fileId: f.id,
      name: "見積書.pdf",
    });
  });

  it("アーカイブ済みは 409。ただし取り出しはできる", async () => {
    const app = makeAppAt(memoryStore());
    const token = await login(app, "FD03");
    const pid = await setupProject(app, token);
    const f = await (await upload(app, token, pid, "T-001", pdf())).json<TaskFile>();
    await call(app, "POST", `/api/projects/${pid}/archive`, token);
    expect((await call(app, "DELETE", `/api/projects/${pid}/files/${f.id}`, token)).status).toBe(409);
    const [listed] = await list(app, token, pid);
    expect((await app.request(listed.url, {}, env)).status).toBe(200);
  });
});
