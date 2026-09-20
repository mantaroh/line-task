import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createFakeSheetsClient, kvStore, memoryStore } from "../../src/worker/dev/fake-sheets";

describe("偽のシート", () => {
  it("追加・書き込み・読み取り", async () => {
    const store = memoryStore();
    const s = createFakeSheetsClient(store);
    await s.batchUpdate("sid", [
      { addSheet: { properties: { sheetId: 1001, title: "タスク" } } },
      {
        updateCells: {
          start: { sheetId: 1001, rowIndex: 0, columnIndex: 0 },
          rows: [
            {
              values: [
                { userEnteredValue: { stringValue: "ID" } },
                { userEnteredValue: { stringValue: "件名" } },
              ],
            },
          ],
          fields: "userEnteredValue",
        },
      },
    ]);
    await s.appendValues("sid", "'タスク'!A1", [["T-001", "'=1+1"]]);
    await s.batchUpdateValues("sid", [{ range: "'タスク'!B2", values: [["直した"]] }]);

    expect(await s.getValues("sid", "'タスク'!A1:Z")).toEqual([
      ["ID", "件名"],
      ["T-001", "直した"],
    ]);
    expect((await s.getSpreadsheet("sid")).sheets.map((x) => x.title)).toEqual([
      "シート1",
      "タスク",
    ]);
  });

  it("まだ無い ID は空のスプレッドシートとして扱う", async () => {
    const s = createFakeSheetsClient(memoryStore());
    const meta = await s.getSpreadsheet("new-id");
    expect(meta.sheets).toEqual([{ sheetId: 0, title: "シート1", hidden: false }]);
  });

  it("noaccess / readonly", async () => {
    const s = createFakeSheetsClient(memoryStore());
    await expect(s.getSpreadsheet("x-noaccess")).rejects.toMatchObject({ status: 403 });
    await expect(s.getValues("x-noaccess", "'シート1'!A1")).rejects.toMatchObject({
      status: 403,
    });
    await expect(s.getSpreadsheet("x-readonly")).resolves.toBeTruthy();
    await expect(s.getValues("x-readonly", "'シート1'!A1:Z")).resolves.toEqual([]);
    await expect(s.batchUpdate("x-readonly", [])).rejects.toMatchObject({ status: 403 });
    await expect(
      s.batchUpdateValues("x-readonly", [{ range: "'シート1'!A1", values: [["x"]] }]),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      s.appendValues("x-readonly", "'シート1'!A1", [["x"]]),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("getValues：存在しないシート名は 400", async () => {
    const s = createFakeSheetsClient(memoryStore());
    await expect(s.getValues("sid", "'無い'!A1:Z")).rejects.toMatchObject({ status: 400 });
  });

  it("getValues：末尾の空セル・空行は省かれる", async () => {
    const store = memoryStore();
    const s = createFakeSheetsClient(store);
    await s.batchUpdateValues("sid", [{ range: "'シート1'!A1", values: [["a", "b", ""]] }]);
    expect(await s.getValues("sid", "'シート1'!A1:Z10")).toEqual([["a", "b"]]);
  });

  it("addSheet：同じ sheetId・title は 400 で何も反映されない", async () => {
    const store = memoryStore();
    const s = createFakeSheetsClient(store);
    await s.batchUpdate("sid", [{ addSheet: { properties: { sheetId: 1, title: "タスク" } } }]);
    await expect(
      s.batchUpdate("sid", [
        { addSheet: { properties: { sheetId: 2, title: "別のシート" } } },
        { addSheet: { properties: { sheetId: 1, title: "重複" } } },
      ]),
    ).rejects.toMatchObject({ status: 400 });
    const meta = await s.getSpreadsheet("sid");
    expect(meta.sheets.map((x) => x.title)).toEqual(["シート1", "タスク"]);
  });

  it("updateSheetProperties：hidden を反映する", async () => {
    const store = memoryStore();
    const s = createFakeSheetsClient(store);
    await s.batchUpdate("sid", [
      { addSheet: { properties: { sheetId: 1, title: "_設定", hidden: false } } },
      { updateSheetProperties: { properties: { sheetId: 1, hidden: true }, fields: "hidden" } },
    ]);
    const meta = await s.getSpreadsheet("sid");
    expect(meta.sheets.find((x) => x.sheetId === 1)?.hidden).toBe(true);
  });

  it("updateCells：存在しない sheetId は 400 で何も反映されない", async () => {
    const store = memoryStore();
    const s = createFakeSheetsClient(store);
    await expect(
      s.batchUpdate("sid", [
        {
          updateCells: {
            start: { sheetId: 999, rowIndex: 0, columnIndex: 0 },
            rows: [{ values: [{ userEnteredValue: { stringValue: "x" } }] }],
            fields: "userEnteredValue",
          },
        },
      ]),
    ).rejects.toMatchObject({ status: 400 });
    const doc = await store.load("sid");
    expect(doc?.sheets.map((x) => x.title)).toEqual(["シート1"]);
    expect(doc?.requests).toEqual([]);
  });

  it("updateSheetProperties：存在しない sheetId は 400 で何も反映されない", async () => {
    const store = memoryStore();
    const s = createFakeSheetsClient(store);
    await s.batchUpdate("sid", [{ addSheet: { properties: { sheetId: 1, title: "タスク" } } }]);
    await expect(
      s.batchUpdate("sid", [
        { updateSheetProperties: { properties: { sheetId: 999, hidden: true }, fields: "hidden" } },
      ]),
    ).rejects.toMatchObject({ status: 400 });
    const meta = await s.getSpreadsheet("sid");
    expect(meta.sheets.find((x) => x.sheetId === 1)?.hidden).toBe(false);
  });

  it("同じバッチ内の addSheet で作った sheetId は updateCells の対象にできる", async () => {
    const store = memoryStore();
    const s = createFakeSheetsClient(store);
    await s.batchUpdate("sid", [
      { addSheet: { properties: { sheetId: 5, title: "タスク" } } },
      {
        updateCells: {
          start: { sheetId: 5, rowIndex: 0, columnIndex: 0 },
          rows: [{ values: [{ userEnteredValue: { stringValue: "ID" } }] }],
          fields: "userEnteredValue",
        },
      },
    ]);
    expect(await s.getValues("sid", "'タスク'!A1:Z")).toEqual([["ID"]]);
  });

  it("未知のリクエストは requests に積まれるだけ", async () => {
    const store = memoryStore();
    const s = createFakeSheetsClient(store);
    await s.batchUpdate("sid", [{ someFutureRequest: { foo: "bar" } }]);
    const doc = await store.load("sid");
    expect(doc?.requests).toEqual([{ someFutureRequest: { foo: "bar" } }]);
  });

  it("memoryStore は保存時・読み込み時に複製し、呼び出し側の変更が保存済みデータに影響しない", async () => {
    const store = memoryStore();
    await store.save("sid", {
      title: "t",
      sheets: [{ sheetId: 0, title: "シート1", hidden: false, grid: [] }],
      requests: [],
    });
    const loaded = await store.load("sid");
    loaded?.sheets.push({ sheetId: 9, title: "改ざん", hidden: false, grid: [] });
    const loadedAgain = await store.load("sid");
    expect(loadedAgain?.sheets.map((x) => x.title)).toEqual(["シート1"]);
    expect(store.docs.get("sid")?.sheets.map((x) => x.title)).toEqual(["シート1"]);
  });

  it("kvStore は KV に dev-sheet:<ID> で保存する", async () => {
    const store = kvStore(env.KV);
    const s = createFakeSheetsClient(store);
    await s.getSpreadsheet("kv-sid");
    const raw = await env.KV.get("dev-sheet:kv-sid");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed.sheets[0].title).toBe("シート1");
  });
});
