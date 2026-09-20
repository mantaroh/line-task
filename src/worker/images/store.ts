// タスクの画像の保存先。中身は R2、情報は D1 の task_images に置く。
import type { TaskImage } from "../../shared/types";
import type { UploadInput } from "./validate";

export type ImageSize = "full" | "thumb";
export type ImageRow = {
  id: string;
  project_id: string;
  task_id: string;
  size: number;
  width: number;
  height: number;
  created_by: string;
  created_at: string;
  deleted_at: string | null;
};
export type ImageEnv = { DB: D1Database; IMAGES: R2Bucket };

const JPEG_METADATA = { httpMetadata: { contentType: "image/jpeg" } };

export function imageKey(pid: string, imageId: string, size: ImageSize): string {
  return `projects/${pid}/${imageId}${size === "thumb" ? ".thumb" : ""}.jpg`;
}

export async function countActiveImages(db: D1Database, pid: string, taskId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM task_images WHERE project_id = ? AND task_id = ? AND deleted_at IS NULL`)
    .bind(pid, taskId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function saveImage(
  env: ImageEnv,
  input: { id: string; projectId: string; taskId: string; createdBy: string } & UploadInput,
  now: string,
): Promise<void> {
  const fullKey = imageKey(input.projectId, input.id, "full");
  const thumbKey = imageKey(input.projectId, input.id, "thumb");
  try {
    await env.IMAGES.put(fullKey, input.image, JPEG_METADATA);
    await env.IMAGES.put(thumbKey, input.thumb, JPEG_METADATA);
    await env.DB.prepare(
      `INSERT INTO task_images (id, project_id, task_id, size, width, height, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        input.id,
        input.projectId,
        input.taskId,
        input.image.byteLength,
        input.width,
        input.height,
        input.createdBy,
        now,
      )
      .run();
  } catch (e) {
    // 途中で失敗したら置いた分を消す。消すのに失敗しても元の例外を投げる
    try {
      await env.IMAGES.delete([fullKey, thumbKey]);
    } catch {
      // 無視する
    }
    throw e;
  }
}

type ListRow = {
  id: string;
  taskId: string;
  width: number;
  height: number;
  size: number;
  lineUserId: string;
  displayName: string;
  pictureUrl: string | null;
  createdAt: string;
};

export async function listImages(db: D1Database, pid: string, taskId: string): Promise<TaskImage[]> {
  const { results } = await db
    .prepare(
      `SELECT i.id, i.task_id AS taskId, i.width, i.height, i.size, i.created_at AS createdAt,
              u.line_user_id AS lineUserId, u.display_name AS displayName, u.picture_url AS pictureUrl
       FROM task_images i JOIN users u ON u.line_user_id = i.created_by
       WHERE i.project_id = ? AND i.task_id = ? AND i.deleted_at IS NULL
       ORDER BY i.created_at, i.rowid`,
    )
    .bind(pid, taskId)
    .all<ListRow>();
  return results.map((r) => ({
    id: r.id,
    taskId: r.taskId,
    width: r.width,
    height: r.height,
    size: r.size,
    createdBy: { lineUserId: r.lineUserId, displayName: r.displayName, pictureUrl: r.pictureUrl ?? null },
    createdAt: r.createdAt,
  }));
}

export async function getActiveImage(db: D1Database, pid: string, imageId: string): Promise<ImageRow | null> {
  return db
    .prepare(`SELECT * FROM task_images WHERE id = ? AND project_id = ? AND deleted_at IS NULL`)
    .bind(imageId, pid)
    .first<ImageRow>();
}

export async function getImageObject(
  bucket: R2Bucket,
  pid: string,
  imageId: string,
  size: ImageSize,
): Promise<R2ObjectBody | null> {
  return bucket.get(imageKey(pid, imageId, size));
}

export async function deleteImage(env: ImageEnv, row: ImageRow, now: string): Promise<void> {
  await env.IMAGES.delete([imageKey(row.project_id, row.id, "full"), imageKey(row.project_id, row.id, "thumb")]);
  await env.DB.prepare(`UPDATE task_images SET deleted_at = ? WHERE id = ? AND project_id = ?`)
    .bind(now, row.id, row.project_id)
    .run();
}

export async function countImagesByTask(db: D1Database, pid: string): Promise<Record<string, number>> {
  const { results } = await db
    .prepare(
      `SELECT task_id AS taskId, COUNT(*) AS n FROM task_images
       WHERE project_id = ? AND deleted_at IS NULL GROUP BY task_id`,
    )
    .bind(pid)
    .all<{ taskId: string; n: number }>();
  const counts: Record<string, number> = {};
  for (const r of results) counts[r.taskId] = r.n;
  return counts;
}
