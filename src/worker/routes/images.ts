// タスクの画像の API。シートには何も書かず、D1 と R2 だけを使う。
import { Hono } from "hono";
import { nowIso } from "../../shared/time";
import { requireSession } from "../auth";
import { randomId } from "../crypto";
import { logActivity } from "../db";
import type { AppEnv } from "../env";
import { badRequest, HttpError, notFound } from "../errors";
import {
  countActiveImages,
  deleteImage,
  getActiveImage,
  getImageObject,
  listImages,
  saveImage,
  type ImageSize,
} from "../images/store";
import { MAX_IMAGES, parseUpload } from "../images/validate";
import type { SheetsClient } from "../sheets/client";
import { parseTasks, readTable, requireSpreadsheetId } from "../sheets/tasks";
import { assertNotArchived, requireMember } from "./projects";
import { mapTaskSheetsError } from "./tasks";

// 本体 2MB + サムネイル 200KB に form の余白を足した上限。これを超える本文は読まない
const MAX_BODY_BYTES = 2_621_440;
// ID の無い行（row-*）は画像を付けられない。それ以外の形はシートにあるかどうかで決める
const TASK_ID = /^(?!row-)[^/]{1,64}$/;

const app = new Hono<AppEnv>();

app.use("*", requireSession);
app.use("/:pid/*", requireMember);

export function requireTaskId(taskId: string): string {
  if (!TASK_ID.test(taskId)) throw badRequest("先にタスクを保存してください");
  return taskId;
}

// シートにそのタスク（ID が重複していない行）があるか。動画・音声の追加でも使う
export async function requireTaskOnSheet(sheets: SheetsClient, kv: KVNamespace, sid: string, taskId: string): Promise<void> {
  const hasTask = async (fresh: boolean) =>
    parseTasks(await readTable(sheets, kv, sid, { fresh })).tasks.some((t) => t.id === taskId && !t.readonly);
  let exists = false;
  try {
    // キャッシュが古くて見つからないこともあるので、無ければ 1 回だけシートを読み直す
    exists = (await hasTask(false)) || (await hasTask(true));
  } catch (e) {
    mapTaskSheetsError(e);
  }
  if (!exists) throw notFound();
}

async function readForm(req: { header: (name: string) => string | undefined; formData: () => Promise<FormData> }) {
  const length = req.header("content-length");
  // 大きさの分からない本文は読まない
  if (length === undefined || !/^\d+$/.test(length.trim()) || !Number.isSafeInteger(Number(length))) {
    throw new HttpError(411, "length_required", "送信に失敗しました。もう一度試してください");
  }
  if (Number(length) > MAX_BODY_BYTES) {
    throw new HttpError(400, "image_size", "画像が大きすぎます");
  }
  try {
    return await req.formData();
  } catch {
    throw new HttpError(400, "image_format", "JPEG の画像を送ってください");
  }
}

app.post("/:pid/tasks/:taskId/images", async (c) => {
  const taskId = requireTaskId(c.req.param("taskId"));
  const project = c.get("project");
  assertNotArchived(project);
  const sid = requireSpreadsheetId(project);

  await requireTaskOnSheet(c.get("deps").sheets, c.env.KV, sid, taskId);

  if ((await countActiveImages(c.env.DB, project.id, taskId)) >= MAX_IMAGES) {
    throw new HttpError(409, "image_limit", "画像は 5 枚までです");
  }

  const input = await parseUpload(await readForm(c.req));
  const id = randomId(16);
  const uid = c.get("user").lineUserId;
  const now = nowIso(c.get("deps").now());
  await saveImage(c.env, { id, projectId: project.id, taskId, createdBy: uid, ...input }, now);
  await logActivity(c.env.DB, project.id, uid, "task.image_add", { taskId, imageId: id }, now);

  const image = (await listImages(c.env.DB, project.id, taskId)).find((i) => i.id === id);
  if (!image) throw new Error("saved image not found");
  return c.json(image, 201);
});

app.get("/:pid/tasks/:taskId/images", async (c) => {
  const taskId = requireTaskId(c.req.param("taskId"));
  return c.json(await listImages(c.env.DB, c.get("project").id, taskId));
});

app.get("/:pid/images/:imageId", async (c) => {
  const q = c.req.query("size");
  if (q !== undefined && q !== "thumb" && q !== "full") {
    throw badRequest("size は thumb・full のいずれかを指定してください");
  }
  const size: ImageSize = q ?? "full";
  const pid = c.get("project").id;
  const row = await getActiveImage(c.env.DB, pid, c.req.param("imageId"));
  if (!row) throw notFound();
  const object = await getImageObject(c.env.IMAGES, pid, row.id, size);
  if (!object) throw notFound();
  return new Response(object.body, {
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(object.size),
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

app.delete("/:pid/images/:imageId", async (c) => {
  const project = c.get("project");
  assertNotArchived(project);
  const row = await getActiveImage(c.env.DB, project.id, c.req.param("imageId"));
  if (!row) throw notFound();
  const uid = c.get("user").lineUserId;
  const now = nowIso(c.get("deps").now());
  await deleteImage(c.env, row, now);
  await logActivity(c.env.DB, project.id, uid, "task.image_delete", { taskId: row.task_id, imageId: row.id }, now);
  return c.body(null, 204);
});

export default app;
