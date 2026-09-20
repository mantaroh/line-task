import { env } from "cloudflare:test";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type {
  ActivityItem,
  ApiErrorBody,
  ProjectDetail,
  Task,
  TaskImage,
  TasksResponse,
} from "../../src/shared/types";
import { createFakeSheetsClient, memoryStore } from "../../src/worker/dev/fake-sheets";
import type { AppEnv } from "../../src/worker/env";
import { imageKey } from "../../src/worker/images/store";
import { call, login, makeApp } from "./helpers";

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeAppWithSheets() {
  const store = memoryStore();
  const app = makeApp({ sheets: createFakeSheetsClient(store) });
  return { app, store };
}

async function setupProject(app: Hono<AppEnv>, token: string) {
  const created = await (
    await call(app, "POST", "/api/projects", token, { name: "画像", parties: ["A社", "自社"] })
  ).json<ProjectDetail>();
  const spreadsheetId = `sidimg${created.id}`;
  const res = await call(app, "POST", `/api/projects/${created.id}/sheet`, token, {
    url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
  });
  expect(res.status).toBe(200);
  const add = await call(app, "POST", `/api/projects/${created.id}/tasks`, token, { title: "一件目", ball: "A社" });
  expect(add.status).toBe(201);
  return { pid: created.id, spreadsheetId };
}

async function upload(
  app: Hono<AppEnv>,
  token: string,
  pid: string,
  taskId: string,
  parts?: Partial<Record<string, string | File>>,
) {
  const f = new FormData();
  const base = {
    image: new File([JPEG_BYTES], "a.jpg", { type: "image/jpeg" }),
    thumb: new File([JPEG_BYTES], "t.jpg", { type: "image/jpeg" }),
    width: "1200",
    height: "900",
    ...parts,
  };
  for (const [k, v] of Object.entries(base)) if (v !== undefined) f.append(k, v);
  // ブラウザは FormData の本文に Content-Length を付けて送るので、テストでも付ける
  const encoded = new Response(f);
  const bytes = new Uint8Array(await encoded.arrayBuffer());
  return app.request(
    `/api/projects/${pid}/tasks/${taskId}/images`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": encoded.headers.get("content-type")!,
        "Content-Length": String(bytes.byteLength),
      },
      body: bytes,
    },
    env,
  );
}

async function joinViaInvite(app: Hono<AppEnv>, pid: string, owner: string, joiner: string): Promise<void> {
  const inv = await (await call(app, "POST", `/api/projects/${pid}/invites`, owner, { days: 7 })).json<{ url: string }>();
  const token = new URL(inv.url).searchParams.get("invite")!;
  const res = await call(app, "POST", `/api/invites/${token}/accept`, joiner);
  expect(res.status).toBe(200);
}

async function activity(app: Hono<AppEnv>, pid: string, token: string) {
  return (await call(app, "GET", `/api/projects/${pid}/activity`, token)).json<ActivityItem[]>();
}

async function errorCode(res: Response): Promise<string> {
  return (await res.json<ApiErrorBody>()).error;
}

describe("画像 API", () => {
  it("追加すると 201 で TaskImage を返し、一覧に 1 件、活動記録に task.image_add", async () => {
    const { app } = makeAppWithSheets();
    const token = await login(app, "IMGA1", "A");
    const { pid } = await setupProject(app, token);

    const res = await upload(app, token, pid, "T-001");
    expect(res.status).toBe(201);
    const img = await res.json<TaskImage>();
    expect(img.taskId).toBe("T-001");
    expect(img.width).toBe(1200);
    expect(img.height).toBe(900);
    expect(img.createdBy.lineUserId).toBe("IMGA1");
    expect(img.id).toMatch(/^[0-9a-z]{16}$/);

    const list = await call(app, "GET", `/api/projects/${pid}/tasks/T-001/images`, token);
    expect(list.status).toBe(200);
    expect((await list.json<TaskImage[]>()).map((i) => i.id)).toEqual([img.id]);

    const acts = await activity(app, pid, token);
    const add = acts.find((a) => a.action === "task.image_add");
    expect(add?.detail).toEqual({ taskId: "T-001", imageId: img.id });
  });

  it("GET images/:id は JPEG とヘッダーを返す。size=thumb も同じ形、size=big は 400", async () => {
    const { app } = makeAppWithSheets();
    const token = await login(app, "IMGG1");
    const { pid } = await setupProject(app, token);
    const img = await (await upload(app, token, pid, "T-001")).json<TaskImage>();

    for (const q of ["", "?size=thumb", "?size=full"]) {
      const res = await call(app, "GET", `/api/projects/${pid}/images/${img.id}${q}`, token);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/jpeg");
      expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
      expect(res.headers.get("content-length")).toBe(String(JPEG_BYTES.byteLength));
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG_BYTES);
    }

    const bad = await call(app, "GET", `/api/projects/${pid}/images/${img.id}?size=big`, token);
    expect(bad.status).toBe(400);
  });

  it("R2 に中身が無ければ 404", async () => {
    const { app } = makeAppWithSheets();
    const token = await login(app, "IMGR2");
    const { pid } = await setupProject(app, token);
    const img = await (await upload(app, token, pid, "T-001")).json<TaskImage>();
    await env.IMAGES.delete(imageKey(pid, img.id, "full"));
    const res = await call(app, "GET", `/api/projects/${pid}/images/${img.id}`, token);
    expect(res.status).toBe(404);
  });

  it("6 枚目は 409 image_limit。1 枚消すとまた追加できる", async () => {
    const { app } = makeAppWithSheets();
    const token = await login(app, "IMGL1");
    const { pid } = await setupProject(app, token);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await upload(app, token, pid, "T-001");
      expect(r.status).toBe(201);
      ids.push((await r.json<TaskImage>()).id);
    }
    const sixth = await upload(app, token, pid, "T-001");
    expect(sixth.status).toBe(409);
    const body = await sixth.json<ApiErrorBody>();
    expect(body.error).toBe("image_limit");
    expect(body.message).toBe("画像は 5 枚までです");

    expect((await call(app, "DELETE", `/api/projects/${pid}/images/${ids[0]}`, token)).status).toBe(204);
    expect((await upload(app, token, pid, "T-001")).status).toBe(201);
  });

  it("row-3 への追加は 400 validation、シートに無い T-999 は 404", async () => {
    const { app } = makeAppWithSheets();
    const token = await login(app, "IMGV1");
    const { pid } = await setupProject(app, token);
    const row = await upload(app, token, pid, "row-3");
    expect(row.status).toBe(400);
    const body = await row.json<ApiErrorBody>();
    expect(body.error).toBe("validation");
    expect(body.message).toBe("先にタスクを保存してください");

    expect((await upload(app, token, pid, "T-999")).status).toBe(404);
    expect((await upload(app, token, pid, "A-1")).status).toBe(404);
    expect((await call(app, "GET", `/api/projects/${pid}/tasks/row-3/images`, token)).status).toBe(400);
  });

  it("手で書いた A-1 のような ID でも、シートにあれば追加できる", async () => {
    const { app, store } = makeAppWithSheets();
    const token = await login(app, "IMGV2");
    const { pid, spreadsheetId } = await setupProject(app, token);
    const grid = store.docs.get(spreadsheetId)!.sheets.find((s) => s.title === "タスク")!.grid;
    grid[2] = ["A-1", "手で足した", "自社", "", "未着手"];

    const res = await upload(app, token, pid, "A-1");
    expect(res.status).toBe(201);
    expect((await res.json<TaskImage>()).taskId).toBe("A-1");
    const list = await (await call(app, "GET", `/api/projects/${pid}/tasks/A-1/images`, token)).json<TaskImage[]>();
    expect(list).toHaveLength(1);
  });

  it("キャッシュに無い ID は、シートを読み直して見つかれば 201", async () => {
    const { app, store } = makeAppWithSheets();
    const token = await login(app, "IMGC1");
    const { pid, spreadsheetId } = await setupProject(app, token);
    // ID の無い状態の表をキャッシュに載せてから、シートに直接 ID を書く
    const warm = await (await call(app, "GET", `/api/projects/${pid}/tasks?status=all`, token)).json<TasksResponse>();
    expect(warm.tasks.some((t) => t.id === "T-050")).toBe(false);
    const grid = store.docs.get(spreadsheetId)!.sheets.find((s) => s.title === "タスク")!.grid;
    grid[2] = ["T-050", "あとから足した", "自社", "", "未着手"];

    expect((await upload(app, token, pid, "T-050")).status).toBe(201);
  });

  it("PNG は 400 image_format、width 0 は 400 validation、壊れた本文は 400 image_format、大きい Content-Length は 400 image_size", async () => {
    const { app } = makeAppWithSheets();
    const token = await login(app, "IMGF1");
    const { pid } = await setupProject(app, token);
    const png = await upload(app, token, pid, "T-001", {
      image: new File([PNG_BYTES], "a.png", { type: "image/png" }),
    });
    expect(png.status).toBe(400);
    expect(await errorCode(png)).toBe("image_format");

    const zero = await upload(app, token, pid, "T-001", { width: "0" });
    expect(zero.status).toBe(400);
    expect(await errorCode(zero)).toBe("validation");

    const broken = await app.request(
      `/api/projects/${pid}/tasks/T-001/images`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "multipart/form-data; boundary=x",
          "Content-Length": "10",
        },
        body: "not a form",
      },
      env,
    );
    expect(broken.status).toBe(400);
    expect(await errorCode(broken)).toBe("image_format");

    const big = await app.request(
      `/api/projects/${pid}/tasks/T-001/images`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "multipart/form-data; boundary=x",
          "Content-Length": "3000000",
        },
        body: "x",
      },
      env,
    );
    expect(big.status).toBe(400);
    expect(await errorCode(big)).toBe("image_size");

    const notNumber = await app.request(
      `/api/projects/${pid}/tasks/T-001/images`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "multipart/form-data; boundary=x",
          "Content-Length": "abc",
        },
        body: "x",
      },
      env,
    );
    expect(notNumber.status).toBe(411);
    const notNumberBody = await notNumber.json<ApiErrorBody>();
    expect(notNumberBody.error).toBe("length_required");
    expect(notNumberBody.message).toBe("送信に失敗しました。もう一度試してください");

    const list = await (await call(app, "GET", `/api/projects/${pid}/tasks/T-001/images`, token)).json<TaskImage[]>();
    expect(list).toEqual([]);
  });

  it("Content-Length の無い本文は 411 length_required で、読まずに返す", async () => {
    const { app } = makeAppWithSheets();
    const token = await login(app, "IMGL1");
    const { pid } = await setupProject(app, token);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("--x--\r\n"));
        controller.close();
      },
    });
    const req = new Request(`http://localhost/api/projects/${pid}/tasks/T-001/images`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "multipart/form-data; boundary=x" },
      body: stream,
    });
    expect(req.headers.get("content-length")).toBeNull();
    const res = await app.request(req, undefined, env);
    expect(res.status).toBe(411);
    const body = await res.json<ApiErrorBody>();
    expect(body.error).toBe("length_required");
    expect(body.message).toBe("送信に失敗しました。もう一度試してください");
  });

  it("メンバーでない人は追加・一覧・取得・削除がすべて 404", async () => {
    const { app } = makeAppWithSheets();
    const owner = await login(app, "IMGN1");
    const other = await login(app, "IMGN2");
    const { pid } = await setupProject(app, owner);
    const img = await (await upload(app, owner, pid, "T-001")).json<TaskImage>();

    expect((await upload(app, other, pid, "T-001")).status).toBe(404);
    expect((await call(app, "GET", `/api/projects/${pid}/tasks/T-001/images`, other)).status).toBe(404);
    expect((await call(app, "GET", `/api/projects/${pid}/images/${img.id}`, other)).status).toBe(404);
    expect((await call(app, "DELETE", `/api/projects/${pid}/images/${img.id}`, other)).status).toBe(404);
    expect((await call(app, "GET", `/api/projects/${pid}/images/${img.id}`, owner)).status).toBe(200);
  });

  it("招待で入ったメンバーは他人の画像を削除できる。活動記録・取得 404・R2 から消える", async () => {
    const { app } = makeAppWithSheets();
    const owner = await login(app, "IMGD1");
    const member = await login(app, "IMGD2");
    const { pid } = await setupProject(app, owner);
    await joinViaInvite(app, pid, owner, member);
    const img = await (await upload(app, owner, pid, "T-001")).json<TaskImage>();

    const del = await call(app, "DELETE", `/api/projects/${pid}/images/${img.id}`, member);
    expect(del.status).toBe(204);

    const acts = await activity(app, pid, owner);
    const d = acts.find((a) => a.action === "task.image_delete");
    expect(d?.detail).toEqual({ taskId: "T-001", imageId: img.id });
    expect(d?.actor.lineUserId).toBe("IMGD2");

    expect((await call(app, "GET", `/api/projects/${pid}/images/${img.id}`, owner)).status).toBe(404);
    expect(await env.IMAGES.get(imageKey(pid, img.id, "full"))).toBeNull();
    expect(await env.IMAGES.get(imageKey(pid, img.id, "thumb"))).toBeNull();
    expect((await call(app, "DELETE", `/api/projects/${pid}/images/${img.id}`, owner)).status).toBe(404);
  });

  it("アーカイブ済みは追加・削除が 409 archived、一覧と取得は 200", async () => {
    const { app } = makeAppWithSheets();
    const token = await login(app, "IMGAR1");
    const { pid } = await setupProject(app, token);
    const img = await (await upload(app, token, pid, "T-001")).json<TaskImage>();
    expect((await call(app, "POST", `/api/projects/${pid}/archive`, token)).status).toBe(200);

    const add = await upload(app, token, pid, "T-001");
    expect(add.status).toBe(409);
    expect(await errorCode(add)).toBe("archived");
    const del = await call(app, "DELETE", `/api/projects/${pid}/images/${img.id}`, token);
    expect(del.status).toBe(409);
    expect(await errorCode(del)).toBe("archived");

    expect((await call(app, "GET", `/api/projects/${pid}/tasks/T-001/images`, token)).status).toBe(200);
    expect((await call(app, "GET", `/api/projects/${pid}/images/${img.id}`, token)).status).toBe(200);
  });

  it("別プロジェクトの pid で画像 ID を指定すると 404", async () => {
    const { app } = makeAppWithSheets();
    const token = await login(app, "IMGX1");
    const a = await setupProject(app, token);
    const b = await setupProject(app, token);
    const img = await (await upload(app, token, a.pid, "T-001")).json<TaskImage>();

    expect((await call(app, "GET", `/api/projects/${b.pid}/images/${img.id}`, token)).status).toBe(404);
    expect((await call(app, "DELETE", `/api/projects/${b.pid}/images/${img.id}`, token)).status).toBe(404);
    expect((await call(app, "GET", `/api/projects/${a.pid}/images/${img.id}`, token)).status).toBe(200);
  });

  it("GET tasks の imageCounts に枚数が入る", async () => {
    const { app } = makeAppWithSheets();
    const token = await login(app, "IMGC1");
    const { pid } = await setupProject(app, token);
    await upload(app, token, pid, "T-001");
    await upload(app, token, pid, "T-001");
    const body = await (await call(app, "GET", `/api/projects/${pid}/tasks`, token)).json<TasksResponse>();
    expect(body.imageCounts).toEqual({ "T-001": 2 });
  });

  it("ID の無い行に空の changes で PATCH すると ID が振られた Task が返る", async () => {
    const { app, store } = makeAppWithSheets();
    const token = await login(app, "IMGP1");
    const { pid, spreadsheetId } = await setupProject(app, token);
    const grid = store.docs.get(spreadsheetId)!.sheets.find((s) => s.title === "タスク")!.grid;
    grid[2] = ["", "PC で足した", "自社", "", "未着手"];

    const res = await call(app, "PATCH", `/api/projects/${pid}/tasks/row-3`, token, {
      changes: {},
      base: { title: "PC で足した" },
    });
    expect(res.status).toBe(200);
    const task = await res.json<Task>();
    expect(task.id).toBe("T-002");
    expect(task.title).toBe("PC で足した");

    expect((await upload(app, token, pid, "T-002")).status).toBe(201);
  });
});
