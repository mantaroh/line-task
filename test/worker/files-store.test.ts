import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  countActiveFiles,
  countFilesByTask,
  deleteFile,
  fileKey,
  getActiveFile,
  insertFile,
  listFiles,
} from "../../src/worker/files/store";

const NOW = "2026-09-15T10:00:00+09:00";
const LATER = "2026-09-15T11:00:00+09:00";
const SIGN = { secret: "test-secret-0123456789", now: new Date("2026-09-15T01:00:00Z") };

// D1 はテストファイル内のテストで分かれないので、テストごとに ID を変える
async function seed(pid: string, uid: string, picture: string | null = null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (line_user_id, display_name, picture_url, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(uid, `名前${uid}`, picture, NOW, NOW)
    .run();
  await env.DB.prepare(
    `INSERT INTO projects (id, name, parties, spreadsheet_id, next_task_no, created_by, created_at, archived_at)
     VALUES (?, ?, '[]', NULL, 1, ?, ?, NULL)`,
  )
    .bind(pid, `案件${pid}`, uid, NOW)
    .run();
}

function row(id: string, pid: string, uid: string, taskId = "T-001") {
  return {
    id,
    projectId: pid,
    taskId,
    name: "見積書.pdf",
    contentType: "application/pdf",
    size: 1234,
    createdBy: uid,
  };
}

describe("ファイルの保存", () => {
  it("キーの形", () => {
    expect(fileKey("p1", "abc")).toBe("projects/p1/files/abc");
  });

  it("入れると一覧に出て、署名つき URL が付く", async () => {
    const pid = "pfilesave0000001";
    await seed(pid, "FS1", "https://example.test/p.png");
    await insertFile(env.DB, row("filesave00000001", pid, "FS1"), NOW);

    const [file] = await listFiles(env.DB, pid, "T-001", SIGN);
    expect(file).toMatchObject({
      id: "filesave00000001",
      taskId: "T-001",
      name: "見積書.pdf",
      contentType: "application/pdf",
      size: 1234,
      createdBy: { lineUserId: "FS1", displayName: "名前FS1", pictureUrl: "https://example.test/p.png" },
      createdAt: NOW,
    });
    const url = new URL(file.url, "https://x.test");
    expect(url.pathname).toBe("/api/files/filesave00000001");
    expect(url.searchParams.get("p")).toBe(pid);
    expect(url.searchParams.get("sig")).toBeTruthy();
  });

  it("一覧は古い順、pictureUrl が無くても読める", async () => {
    const pid = "pfileorder000001";
    await seed(pid, "FO1");
    await insertFile(env.DB, row("fileorder0000002", pid, "FO1"), LATER);
    await insertFile(env.DB, row("fileorder0000001", pid, "FO1"), NOW);
    const list = await listFiles(env.DB, pid, "T-001", SIGN);
    expect(list.map((f) => f.id)).toEqual(["fileorder0000001", "fileorder0000002"]);
    expect(list[0].createdBy.pictureUrl).toBeNull();
  });

  it("件数を数える", async () => {
    const pid = "pfilecount000001";
    await seed(pid, "FC1");
    expect(await countFilesByTask(env.DB, pid)).toEqual({});
    expect(await countActiveFiles(env.DB, pid, "T-001")).toBe(0);
    await insertFile(env.DB, row("filecount0000001", pid, "FC1", "T-001"), NOW);
    await insertFile(env.DB, row("filecount0000002", pid, "FC1", "T-001"), NOW);
    await insertFile(env.DB, row("filecount0000003", pid, "FC1", "T-002"), NOW);
    expect(await countActiveFiles(env.DB, pid, "T-001")).toBe(2);
    expect(await countFilesByTask(env.DB, pid)).toEqual({ "T-001": 2, "T-002": 1 });
  });

  it("削除すると R2 から消え、D1 の行は deleted_at が入って残る", async () => {
    const pid = "pfiledel00000001";
    await seed(pid, "FD1");
    await insertFile(env.DB, row("filedel000000001", pid, "FD1"), NOW);
    await env.IMAGES.put(fileKey(pid, "filedel000000001"), new Uint8Array([1, 2, 3]));

    const found = await getActiveFile(env.DB, pid, "filedel000000001");
    expect(found).toMatchObject({ id: "filedel000000001", project_id: pid, file_name: "見積書.pdf", deleted_at: null });

    await deleteFile(env, found!, LATER);

    expect(await env.IMAGES.head(fileKey(pid, "filedel000000001"))).toBeNull();
    expect(await listFiles(env.DB, pid, "T-001", SIGN)).toEqual([]);
    expect(await getActiveFile(env.DB, pid, "filedel000000001")).toBeNull();
    const raw = await env.DB.prepare("SELECT deleted_at FROM task_files WHERE id = ?")
      .bind("filedel000000001")
      .first<{ deleted_at: string | null }>();
    expect(raw?.deleted_at).toBe(LATER);
  });

  it("別のプロジェクトの pid では見つからない", async () => {
    await seed("pfileother00001a", "FX1");
    await seed("pfileother00001b", "FX2");
    await insertFile(env.DB, row("fileother0000001", "pfileother00001a", "FX1"), NOW);
    expect(await getActiveFile(env.DB, "pfileother00001b", "fileother0000001")).toBeNull();
    expect(await listFiles(env.DB, "pfileother00001b", "T-001", SIGN)).toEqual([]);
    expect(await countFilesByTask(env.DB, "pfileother00001b")).toEqual({});
  });
});
