// タスクのファイル添付の API（docs/設計書_ファイル_20260920.md §4）。
// 本文は multipart にせず、そのまま R2 に流す。取り出しは署名つき URL（セッション無し）で行う。
import { Hono } from "hono";
import { nowIso } from "../../shared/time";
import { requireSession } from "../auth";
import { randomId } from "../crypto";
import { logActivity } from "../db";
import type { AppEnv } from "../env";
import { HttpError, notFound } from "../errors";
import {
  cleanFileName,
  contentTypeFor,
  isAllowedName,
  MAX_FILE_BYTES,
  MAX_FILES,
  SNIFF_BYTES,
} from "../files/validate";
import { countActiveFiles, deleteFile, fileKey, getActiveFile, insertFile, listFiles } from "../files/store";
import { verifySignature } from "../media/sign";
import { requireSpreadsheetId } from "../sheets/tasks";
import { requireTaskId, requireTaskOnSheet } from "./images";
import { assertNotArchived, requireMember } from "./projects";

const lengthRequired = () => new HttpError(411, "length_required", "送信に失敗しました。もう一度試してください");
const fileSizeError = () => new HttpError(400, "file_size", "10MB までです");
const fileNameError = () => new HttpError(400, "file_name", "ファイル名が正しくありません");
const fileFormatError = () => new HttpError(400, "file_format", "この形式は付けられません");
const uploadFailed = () => new HttpError(400, "upload_failed", "送信に失敗しました。もう一度試してください");

function contentLength(header: string | undefined): number {
  if (header === undefined || !/^\d+$/.test(header.trim())) throw lengthRequired();
  const n = Number(header);
  if (!Number.isSafeInteger(n)) throw lengthRequired();
  return n;
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
  name: string,
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
  const contentType = contentTypeFor(name, head.subarray(0, SNIFF_BYTES));
  if (!contentType) {
    await reader.cancel().catch(() => {});
    throw fileFormatError();
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

projectApp.post("/:pid/tasks/:taskId/files", async (c) => {
  const name = cleanFileName(c.req.query("name"));
  if (!name) throw fileNameError();
  const taskId = requireTaskId(c.req.param("taskId"));
  const project = c.get("project");
  assertNotArchived(project);
  const sid = requireSpreadsheetId(project);
  // 本文を読む前に、大きさと拡張子で断る
  const length = contentLength(c.req.header("content-length"));
  if (length === 0 || length > MAX_FILE_BYTES) throw fileSizeError();
  if (!isAllowedName(name)) throw fileFormatError();
  const body = c.req.raw.body;
  if (!body) throw fileSizeError();

  await requireTaskOnSheet(c.get("deps").sheets, c.env.KV, sid, taskId);
  if ((await countActiveFiles(c.env.DB, project.id, taskId)) >= MAX_FILES) {
    throw new HttpError(409, "file_limit", "ファイルは 5 つまでです");
  }

  const id = randomId(16);
  const key = fileKey(project.id, id);
  const contentType = await streamToR2(c.env.IMAGES, key, body, length, name);

  const uid = c.get("user").lineUserId;
  const deps = c.get("deps");
  const now = nowIso(deps.now());
  try {
    await insertFile(
      c.env.DB,
      { id, projectId: project.id, taskId, name, contentType, size: length, createdBy: uid },
      now,
    );
  } catch (e) {
    await c.env.IMAGES.delete(key).catch(() => {});
    throw e;
  }
  await logActivity(c.env.DB, project.id, uid, "task.file_add", { taskId, fileId: id, name }, now);

  const file = (await listFiles(c.env.DB, project.id, taskId, { secret: c.env.SESSION_SECRET, now: deps.now() })).find(
    (f) => f.id === id,
  );
  if (!file) throw new Error("saved file not found");
  return c.json(file, 201);
});

projectApp.get("/:pid/tasks/:taskId/files", async (c) => {
  const taskId = requireTaskId(c.req.param("taskId"));
  return c.json(
    await listFiles(c.env.DB, c.get("project").id, taskId, { secret: c.env.SESSION_SECRET, now: c.get("deps").now() }),
  );
});

projectApp.delete("/:pid/files/:fileId", async (c) => {
  const project = c.get("project");
  assertNotArchived(project);
  const row = await getActiveFile(c.env.DB, project.id, c.req.param("fileId"));
  if (!row) throw notFound();
  const uid = c.get("user").lineUserId;
  const now = nowIso(c.get("deps").now());
  await deleteFile(c.env, row, now);
  await logActivity(
    c.env.DB,
    project.id,
    uid,
    "task.file_delete",
    { taskId: row.task_id, fileId: row.id, name: row.file_name },
    now,
  );
  return c.body(null, 204);
});

export default projectApp;

// 署名つき URL での取り出し。外部ブラウザから直接読むのでセッションは使わない。理由は返さず、合わなければ 404
export const fileRoutes = new Hono<AppEnv>();

// RFC 5987 の attr-char に無い文字を残さない（encodeURIComponent は ' ( ) * ! を素通しする）
function encodeName(name: string): string {
  return encodeURIComponent(name).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function contentDisposition(name: string, contentType: string): string {
  const kind = contentType === "application/pdf" ? "inline" : "attachment";
  return `${kind}; filename*=UTF-8''${encodeName(name)}`;
}

fileRoutes.get("/:fileId", async (c) => {
  const id = c.req.param("fileId");
  const pid = c.req.query("p");
  const exp = c.req.query("exp");
  const sig = c.req.query("sig");
  if (!pid || !sig || !exp || !/^\d{1,12}$/.test(exp)) throw notFound();
  if (c.req.query("size") !== undefined) throw notFound();
  const ok = await verifySignature(
    c.env.SESSION_SECRET,
    { kind: "file", pid, id, size: "full", exp: Number(exp), sig },
    c.get("deps").now(),
  );
  if (!ok) throw notFound();
  const row = await getActiveFile(c.env.DB, pid, id);
  if (!row) throw notFound();

  const object = await c.env.IMAGES.get(fileKey(pid, id));
  if (!object) throw notFound();
  // PDF は sandbox を付けるとブラウザ内蔵の表示が動かない端末があるので、PDF だけ外す
  const csp = row.content_type === "application/pdf" ? "default-src 'none'" : "default-src 'none'; sandbox";
  return new Response(object.body, {
    headers: {
      "Content-Type": row.content_type,
      "Content-Length": String(object.size),
      "Content-Disposition": contentDisposition(row.file_name, row.content_type),
      "Content-Security-Policy": csp,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
