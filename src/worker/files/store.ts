// タスクのファイル添付の保存先。中身は R2（画像と同じバケット）、情報は D1 の task_files に置く。
import type { TaskFile } from "../../shared/types";
import { signExpiry, signPath } from "../media/sign";

export type FileRow = {
  id: string;
  project_id: string;
  task_id: string;
  file_name: string;
  content_type: string;
  size: number;
  created_by: string;
  created_at: string;
  deleted_at: string | null;
};

export function fileKey(pid: string, id: string): string {
  return `projects/${pid}/files/${id}`;
}

export async function countActiveFiles(db: D1Database, pid: string, taskId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM task_files WHERE project_id = ? AND task_id = ? AND deleted_at IS NULL`)
    .bind(pid, taskId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function insertFile(
  db: D1Database,
  f: { id: string; projectId: string; taskId: string; name: string; contentType: string; size: number; createdBy: string },
  now: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO task_files (id, project_id, task_id, file_name, content_type, size, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(f.id, f.projectId, f.taskId, f.name, f.contentType, f.size, f.createdBy, now)
    .run();
}

type ListRow = FileRow & { displayName: string; pictureUrl: string | null };

export async function listFiles(
  db: D1Database,
  pid: string,
  taskId: string,
  sign: { secret: string; now: Date },
): Promise<TaskFile[]> {
  const { results } = await db
    .prepare(
      `SELECT f.*, u.display_name AS displayName, u.picture_url AS pictureUrl
       FROM task_files f JOIN users u ON u.line_user_id = f.created_by
       WHERE f.project_id = ? AND f.task_id = ? AND f.deleted_at IS NULL
       ORDER BY f.created_at, f.rowid`,
    )
    .bind(pid, taskId)
    .all<ListRow>();
  const exp = signExpiry(sign.now);
  return Promise.all(
    results.map(async (r) => ({
      id: r.id,
      taskId: r.task_id,
      name: r.file_name,
      contentType: r.content_type,
      size: r.size,
      url: await signPath(sign.secret, { kind: "file", pid, id: r.id, size: "full", exp }),
      createdBy: { lineUserId: r.created_by, displayName: r.displayName, pictureUrl: r.pictureUrl ?? null },
      createdAt: r.created_at,
    })),
  );
}

export async function getActiveFile(db: D1Database, pid: string, id: string): Promise<FileRow | null> {
  return db
    .prepare(`SELECT * FROM task_files WHERE id = ? AND project_id = ? AND deleted_at IS NULL`)
    .bind(id, pid)
    .first<FileRow>();
}

export async function deleteFile(
  env: { DB: D1Database; IMAGES: R2Bucket },
  row: FileRow,
  now: string,
): Promise<void> {
  await env.IMAGES.delete(fileKey(row.project_id, row.id));
  await env.DB.prepare(`UPDATE task_files SET deleted_at = ? WHERE id = ? AND project_id = ?`)
    .bind(now, row.id, row.project_id)
    .run();
}

export async function countFilesByTask(db: D1Database, pid: string): Promise<Record<string, number>> {
  const { results } = await db
    .prepare(
      `SELECT task_id AS taskId, COUNT(*) AS n FROM task_files
       WHERE project_id = ? AND deleted_at IS NULL GROUP BY task_id`,
    )
    .bind(pid)
    .all<{ taskId: string; n: number }>();
  return Object.fromEntries(results.map((r) => [r.taskId, r.n]));
}
