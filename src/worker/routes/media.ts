// タスクの動画・音声の API（docs/設計書_動画音声_20260917.md §4）。
// 本文は multipart にせず、そのまま R2 に流す。再生は署名つき URL（セッション無し）で行う。
import { Hono } from "hono";
import type { MediaKind } from "../../shared/types";
import { nowIso } from "../../shared/time";
import { requireSession } from "../auth";
import { randomId } from "../crypto";
import { logActivity } from "../db";
import type { AppEnv } from "../env";
import { badRequest, HttpError, notFound } from "../errors";
import { isJpeg, MAX_THUMB_BYTES } from "../images/validate";
import { parseRange } from "../media/range";
import { verifyMediaSignature } from "../media/sign";
import { SNIFF_BYTES, sniffMedia } from "../media/sniff";
import {
  countActiveMedia,
  deleteMedia,
  getActiveMedia,
  insertMedia,
  listMedia,
  markThumb,
  mediaKey,
} from "../media/store";
import { requireSpreadsheetId } from "../sheets/tasks";
import { requireTaskId, requireTaskOnSheet } from "./images";
import { assertNotArchived, requireMember } from "./projects";

export const MAX_MEDIA = 3;
export const MAX_MEDIA_BYTES = 30 * 1024 * 1024;
const MAX_DURATION_MS = 3_600_000;
// サムネイルは追加した直後に画面が送る。それ以降の差し替えは受け付けない
const THUMB_WINDOW_MS = 10 * 60 * 1000;

const lengthRequired = () => new HttpError(411, "length_required", "送信に失敗しました。もう一度試してください");
const mediaSizeError = () => new HttpError(400, "media_size", "30MB までです");
const mediaFormatError = () => new HttpError(400, "media_format", "この形式は付けられません");
const uploadFailed = () => new HttpError(400, "upload_failed", "送信に失敗しました。もう一度試してください");

function contentLength(header: string | undefined): number {
  if (header === undefined || !/^\d+$/.test(header.trim())) throw lengthRequired();
  const n = Number(header);
  if (!Number.isSafeInteger(n)) throw lengthRequired();
  return n;
}

function parseKind(v: string | undefined): MediaKind {
  if (v !== "video" && v !== "audio") throw badRequest("kind は video・audio のいずれかを指定してください");
  return v;
}

function parseDuration(v: string | undefined): number | null {
  if (v === undefined) return null;
  if (!/^\d+$/.test(v) || Number(v) > MAX_DURATION_MS) throw badRequest("duration_ms が正しくありません");
  return Number(v);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

// 先頭を読んで形式を決め、読んだ分を戻して R2 に流す。長さが Content-Length と違えば R2 の保存が失敗する
async function streamToR2(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream<Uint8Array>,
  length: number,
  kind: MediaKind,
): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  while (got < SNIFF_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.byteLength;
  }
  const head = concat(chunks);
  const contentType = sniffMedia(head.subarray(0, SNIFF_BYTES), kind);
  if (!contentType) {
    await reader.cancel().catch(() => {});
    throw mediaFormatError();
  }

  const { readable, writable } = new FixedLengthStream(length);
  const writer = writable.getWriter();
  const pump = (async () => {
    try {
      await writer.write(head);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
      }
      await writer.close();
    } catch (e) {
      await writer.abort(e).catch(() => {});
      await reader.cancel().catch(() => {});
      throw e;
    }
  })();
  try {
    await Promise.all([bucket.put(key, readable, { httpMetadata: { contentType } }), pump]);
  } catch {
    await bucket.delete(key).catch(() => {});
    throw uploadFailed();
  }
  return contentType;
}

const projectApp = new Hono<AppEnv>();

projectApp.use("*", requireSession);
projectApp.use("/:pid/*", requireMember);

projectApp.post("/:pid/tasks/:taskId/media", async (c) => {
  const kind = parseKind(c.req.query("kind"));
  const durationMs = parseDuration(c.req.query("duration_ms"));
  const taskId = requireTaskId(c.req.param("taskId"));
  const project = c.get("project");
  assertNotArchived(project);
  const sid = requireSpreadsheetId(project);
  // 本文を読む前に大きさで断る
  const length = contentLength(c.req.header("content-length"));
  if (length === 0 || length > MAX_MEDIA_BYTES) throw mediaSizeError();
  const body = c.req.raw.body;
  if (!body) throw mediaSizeError();

  await requireTaskOnSheet(c.get("deps").sheets, c.env.KV, sid, taskId);
  if ((await countActiveMedia(c.env.DB, project.id, taskId)) >= MAX_MEDIA) {
    throw new HttpError(409, "media_limit", "動画・音声は 3 つまでです");
  }

  const id = randomId(16);
  const key = mediaKey(project.id, id, "full");
  const contentType = await streamToR2(c.env.IMAGES, key, body, length, kind);

  const uid = c.get("user").lineUserId;
  const deps = c.get("deps");
  const now = nowIso(deps.now());
  try {
    await insertMedia(c.env.DB, { id, projectId: project.id, taskId, kind, contentType, size: length, durationMs, createdBy: uid }, now);
  } catch (e) {
    await c.env.IMAGES.delete(key).catch(() => {});
    throw e;
  }
  await logActivity(c.env.DB, project.id, uid, "task.media_add", { taskId, mediaId: id, kind }, now);

  const media = (await listMedia(c.env.DB, project.id, taskId, { secret: c.env.SESSION_SECRET, now: deps.now() })).find(
    (m) => m.id === id,
  );
  if (!media) throw new Error("saved media not found");
  return c.json(media, 201);
});

projectApp.put("/:pid/media/:mediaId/thumb", async (c) => {
  const project = c.get("project");
  const row = await getActiveMedia(c.env.DB, project.id, c.req.param("mediaId"));
  if (!row) throw notFound();
  assertNotArchived(project);
  if (row.created_by !== c.get("user").lineUserId) {
    throw new HttpError(403, "forbidden", "追加した人だけがサムネイルを付けられます");
  }
  const now = c.get("deps").now();
  if (row.has_thumb || now.getTime() - Date.parse(row.created_at) > THUMB_WINDOW_MS) {
    throw new HttpError(409, "thumb_locked", "サムネイルはもう付けられません");
  }
  const length = contentLength(c.req.header("content-length"));
  if (length > MAX_THUMB_BYTES) throw new HttpError(400, "image_size", "画像が大きすぎます");
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength > MAX_THUMB_BYTES) throw new HttpError(400, "image_size", "画像が大きすぎます");
  if (!isJpeg(bytes)) throw new HttpError(400, "image_format", "JPEG の画像を送ってください");
  await c.env.IMAGES.put(mediaKey(project.id, row.id, "thumb"), bytes, { httpMetadata: { contentType: "image/jpeg" } });
  await markThumb(c.env.DB, row);
  return c.body(null, 204);
});

projectApp.get("/:pid/tasks/:taskId/media", async (c) => {
  const taskId = requireTaskId(c.req.param("taskId"));
  return c.json(
    await listMedia(c.env.DB, c.get("project").id, taskId, { secret: c.env.SESSION_SECRET, now: c.get("deps").now() }),
  );
});

projectApp.delete("/:pid/media/:mediaId", async (c) => {
  const project = c.get("project");
  assertNotArchived(project);
  const row = await getActiveMedia(c.env.DB, project.id, c.req.param("mediaId"));
  if (!row) throw notFound();
  const uid = c.get("user").lineUserId;
  const now = nowIso(c.get("deps").now());
  await deleteMedia(c.env, row, now);
  await logActivity(c.env.DB, project.id, uid, "task.media_delete", { taskId: row.task_id, mediaId: row.id, kind: row.kind }, now);
  return c.body(null, 204);
});

export default projectApp;

// 署名つき URL での再生。<video src> から直接読むのでセッションは使わない。理由は返さず、合わなければ 404
export const mediaFileRoutes = new Hono<AppEnv>();

mediaFileRoutes.get("/:mediaId", async (c) => {
  const id = c.req.param("mediaId");
  const pid = c.req.query("p");
  const exp = c.req.query("exp");
  const sig = c.req.query("sig");
  const sizeQuery = c.req.query("size");
  if (!pid || !sig || !exp || !/^\d{1,12}$/.test(exp)) throw notFound();
  if (sizeQuery !== undefined && sizeQuery !== "thumb") throw notFound();
  const size = sizeQuery ?? "full";
  const ok = await verifyMediaSignature(c.env.SESSION_SECRET, { pid, id, size, exp: Number(exp), sig }, c.get("deps").now());
  if (!ok) throw notFound();
  const row = await getActiveMedia(c.env.DB, pid, id);
  if (!row || (size === "thumb" && !row.has_thumb)) throw notFound();

  const headers = new Headers({
    "Content-Disposition": "inline",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  });
  const key = mediaKey(pid, id, size);

  if (size === "thumb") {
    const object = await c.env.IMAGES.get(key);
    if (!object) throw notFound();
    headers.set("Content-Type", "image/jpeg");
    headers.set("Content-Length", String(object.size));
    return new Response(object.body, { headers });
  }

  headers.set("Content-Type", row.content_type);
  headers.set("Accept-Ranges", "bytes");
  const range = parseRange(c.req.header("range"), row.size);
  if (range.kind === "invalid") {
    headers.set("Content-Range", `bytes */${row.size}`);
    return new Response(null, { status: 416, headers });
  }
  if (range.kind === "full") {
    const object = await c.env.IMAGES.get(key);
    if (!object) throw notFound();
    headers.set("Content-Length", String(object.size));
    return new Response(object.body, { headers });
  }
  const object = await c.env.IMAGES.get(key, { range: { offset: range.offset, length: range.length } });
  if (!object) throw notFound();
  headers.set("Content-Length", String(range.length));
  headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${row.size}`);
  return new Response(object.body, { status: 206, headers });
});
