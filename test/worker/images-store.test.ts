import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  countActiveImages,
  countImagesByTask,
  deleteImage,
  getActiveImage,
  getImageObject,
  imageKey,
  listImages,
  saveImage,
} from "../../src/worker/images/store";

const NOW = "2026-09-15T10:00:00+09:00";
const LATER = "2026-09-15T11:00:00+09:00";
const FULL = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);
const THUMB = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9]);

// D1 はファイル内のテストで分かれないので、テストごとに ID を変える
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

function upload(id: string, pid: string, uid: string, taskId = "T-001") {
  return {
    id,
    projectId: pid,
    taskId,
    createdBy: uid,
    image: FULL.slice().buffer,
    thumb: THUMB.slice().buffer,
    width: 1200,
    height: 900,
  };
}

describe("画像の保存", () => {
  it("キーの形", () => {
    expect(imageKey("p1", "abc", "full")).toBe("projects/p1/abc.jpg");
    expect(imageKey("p1", "abc", "thumb")).toBe("projects/p1/abc.thumb.jpg");
  });

  it("保存すると R2 と D1 に入り、一覧に出る", async () => {
    await seed("pimgsave00000001", "IS1", "https://example.test/p.png");
    await saveImage(env, upload("imgsave000000001", "pimgsave00000001", "IS1"), NOW);

    const full = await env.IMAGES.get("projects/pimgsave00000001/imgsave000000001.jpg");
    const thumb = await env.IMAGES.get("projects/pimgsave00000001/imgsave000000001.thumb.jpg");
    expect(full?.httpMetadata?.contentType).toBe("image/jpeg");
    expect(thumb?.httpMetadata?.contentType).toBe("image/jpeg");
    expect(new Uint8Array(await full!.arrayBuffer())).toEqual(FULL);
    expect(new Uint8Array(await thumb!.arrayBuffer())).toEqual(THUMB);

    expect(await listImages(env.DB, "pimgsave00000001", "T-001")).toEqual([
      {
        id: "imgsave000000001",
        taskId: "T-001",
        width: 1200,
        height: 900,
        size: FULL.byteLength,
        createdBy: { lineUserId: "IS1", displayName: "名前IS1", pictureUrl: "https://example.test/p.png" },
        createdAt: NOW,
      },
    ]);
    const obj = await getImageObject(env.IMAGES, "pimgsave00000001", "imgsave000000001", "thumb");
    expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(THUMB);
    expect(await getImageObject(env.IMAGES, "pimgsave00000001", "nothing000000000", "full")).toBeNull();
  });

  it("一覧は古い順、pictureUrl が無くても読める", async () => {
    await seed("pimgorder0000001", "IO1");
    await saveImage(env, upload("imgorder00000002", "pimgorder0000001", "IO1"), LATER);
    await saveImage(env, upload("imgorder00000001", "pimgorder0000001", "IO1"), NOW);
    await saveImage(env, upload("imgorder00000003", "pimgorder0000001", "IO1"), LATER);
    const list = await listImages(env.DB, "pimgorder0000001", "T-001");
    expect(list.map((i) => i.id)).toEqual(["imgorder00000001", "imgorder00000002", "imgorder00000003"]);
    expect(list[0].createdBy).toEqual({ lineUserId: "IO1", displayName: "名前IO1", pictureUrl: null });
  });

  it("枚数を数える", async () => {
    await seed("pimgcount0000001", "IC1");
    const pid = "pimgcount0000001";
    expect(await countImagesByTask(env.DB, pid)).toEqual({});
    expect(await countActiveImages(env.DB, pid, "T-001")).toBe(0);
    await saveImage(env, upload("imgcount00000001", pid, "IC1", "T-001"), NOW);
    await saveImage(env, upload("imgcount00000002", pid, "IC1", "T-001"), NOW);
    await saveImage(env, upload("imgcount00000003", pid, "IC1", "T-002"), NOW);
    expect(await countActiveImages(env.DB, pid, "T-001")).toBe(2);
    expect(await countActiveImages(env.DB, pid, "T-002")).toBe(1);
    expect(await countImagesByTask(env.DB, pid)).toEqual({ "T-001": 2, "T-002": 1 });
  });

  it("削除すると R2 から消え、D1 の行は deleted_at が入って残る", async () => {
    const pid = "pimgdel000000001";
    await seed(pid, "ID1");
    await saveImage(env, upload("imgdel0000000001", pid, "ID1"), NOW);
    await saveImage(env, upload("imgdel0000000002", pid, "ID1"), NOW);
    const row = await getActiveImage(env.DB, pid, "imgdel0000000001");
    expect(row).toMatchObject({
      id: "imgdel0000000001",
      project_id: pid,
      task_id: "T-001",
      size: FULL.byteLength,
      width: 1200,
      height: 900,
      created_by: "ID1",
      created_at: NOW,
      deleted_at: null,
    });

    await deleteImage(env, row!, LATER);

    expect(await env.IMAGES.get(`projects/${pid}/imgdel0000000001.jpg`)).toBeNull();
    expect(await env.IMAGES.get(`projects/${pid}/imgdel0000000001.thumb.jpg`)).toBeNull();
    expect(await env.IMAGES.head(`projects/${pid}/imgdel0000000002.jpg`)).not.toBeNull();
    expect((await listImages(env.DB, pid, "T-001")).map((i) => i.id)).toEqual(["imgdel0000000002"]);
    expect(await countActiveImages(env.DB, pid, "T-001")).toBe(1);
    expect(await countImagesByTask(env.DB, pid)).toEqual({ "T-001": 1 });
    expect(await getActiveImage(env.DB, pid, "imgdel0000000001")).toBeNull();
    const raw = await env.DB.prepare("SELECT deleted_at FROM task_images WHERE id = ?")
      .bind("imgdel0000000001")
      .first<{ deleted_at: string | null }>();
    expect(raw?.deleted_at).toBe(LATER);
  });

  it("別のプロジェクトの pid では見つからない", async () => {
    await seed("pimgother000001a", "IX1");
    await seed("pimgother000001b", "IX2");
    await saveImage(env, upload("imgother00000001", "pimgother000001a", "IX1"), NOW);
    expect(await getActiveImage(env.DB, "pimgother000001b", "imgother00000001")).toBeNull();
    expect(await getActiveImage(env.DB, "pimgother000001a", "imgother00000001")).not.toBeNull();
    expect(await listImages(env.DB, "pimgother000001b", "T-001")).toEqual([]);
    expect(await countImagesByTask(env.DB, "pimgother000001b")).toEqual({});
  });

  it("D1 への書き込みに失敗したら、置いた R2 のオブジェクトを消して投げ直す", async () => {
    const pid = "pimgfail00000001";
    await seed(pid, "IF1");
    let failed = false;
    const db = {
      prepare(query: string) {
        const stmt = env.DB.prepare(query);
        if (!query.includes("INSERT INTO task_images")) return stmt;
        return {
          bind() {
            return {
              async run() {
                failed = true;
                throw new Error("D1 down");
              },
            };
          },
        };
      },
      batch: (stmts: D1PreparedStatement[]) => env.DB.batch(stmts),
    } as unknown as D1Database;

    await expect(saveImage({ DB: db, IMAGES: env.IMAGES }, upload("imgfail000000001", pid, "IF1"), NOW)).rejects.toThrow(
      "D1 down",
    );
    expect(failed).toBe(true);
    expect(await env.IMAGES.head(`projects/${pid}/imgfail000000001.jpg`)).toBeNull();
    expect(await env.IMAGES.head(`projects/${pid}/imgfail000000001.thumb.jpg`)).toBeNull();
    expect(await countActiveImages(env.DB, pid, "T-001")).toBe(0);
  });

  it("R2 への保存に失敗したら D1 に書かず、置いた分を消して投げ直す", async () => {
    const pid = "pimgr2fail000001";
    await seed(pid, "IR1");
    const deleted: unknown[] = [];
    const bucket = {
      put(key: string, value: ArrayBuffer, opts?: R2PutOptions) {
        if (key.endsWith(".thumb.jpg")) return Promise.reject(new Error("R2 down"));
        return env.IMAGES.put(key, value, opts);
      },
      delete: (keys: string | string[]) => {
        deleted.push(keys);
        return env.IMAGES.delete(keys);
      },
    } as unknown as R2Bucket;

    await expect(saveImage({ DB: env.DB, IMAGES: bucket }, upload("imgr2fail0000001", pid, "IR1"), NOW)).rejects.toThrow(
      "R2 down",
    );
    expect(deleted).toEqual([[`projects/${pid}/imgr2fail0000001.jpg`, `projects/${pid}/imgr2fail0000001.thumb.jpg`]]);
    expect(await env.IMAGES.head(`projects/${pid}/imgr2fail0000001.jpg`)).toBeNull();
    expect(await countActiveImages(env.DB, pid, "T-001")).toBe(0);
  });
});
