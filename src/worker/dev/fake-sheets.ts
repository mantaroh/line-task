// DEV_MOCKS 用の偽の Google Sheets。localhost / 127.0.0.1 でのみ使われる（createDeps 側で制御）。
import { parseRange } from "../sheets/a1";
import { SheetsError, type SheetMeta, type SheetsClient, type SheetsRequest } from "../sheets/client";

export type FakeDoc = {
  title: string;
  sheets: (SheetMeta & { grid: string[][] })[];
  requests: SheetsRequest[];
};

export interface FakeStore {
  load(id: string): Promise<FakeDoc | null>;
  save(id: string, doc: FakeDoc): Promise<void>;
}

export function memoryStore(): FakeStore & { docs: Map<string, FakeDoc> } {
  const docs = new Map<string, FakeDoc>();
  return {
    docs,
    async load(id) {
      const doc = docs.get(id);
      return doc ? structuredClone(doc) : null;
    },
    async save(id, doc) {
      docs.set(id, structuredClone(doc));
    },
  };
}

const KV_PREFIX = "dev-sheet:";

export function kvStore(kv: KVNamespace): FakeStore {
  return {
    async load(id) {
      const doc = await kv.get<FakeDoc>(`${KV_PREFIX}${id}`, "json");
      return doc ?? null;
    },
    async save(id, doc) {
      await kv.put(`${KV_PREFIX}${id}`, JSON.stringify(doc));
    },
  };
}

function defaultDoc(): FakeDoc {
  return {
    title: "無題のスプレッドシート",
    sheets: [{ sheetId: 0, title: "シート1", hidden: false, grid: [] }],
    requests: [],
  };
}

async function loadOrCreate(store: FakeStore, id: string): Promise<FakeDoc> {
  const existing = await store.load(id);
  if (existing) return existing;
  const doc = defaultDoc();
  await store.save(id, doc);
  return doc;
}

function assertAccess(id: string, op: "read" | "write"): void {
  if (id.includes("noaccess")) throw new SheetsError(403, "スプレッドシートにアクセスできません");
  if (id.includes("readonly") && op === "write") {
    throw new SheetsError(403, "スプレッドシートは読み取り専用です");
  }
}

function ensureRow(grid: string[][], r: number): void {
  while (grid.length <= r) grid.push([]);
}

function ensureCol(row: string[], c: number): void {
  while (row.length <= c) row.push("");
}

function stripLeadingQuote(v: string): string {
  return v.startsWith("'") ? v.slice(1) : v;
}

function writeValues(grid: string[][], startCol: number, startRow: number, values: string[][]): void {
  values.forEach((row, ri) => {
    const r = startRow + ri;
    ensureRow(grid, r);
    row.forEach((val, ci) => {
      const c = startCol + ci;
      ensureCol(grid[r], c);
      grid[r][c] = stripLeadingQuote(val);
    });
  });
}

function lastNonEmptyRowIndex(grid: string[][]): number {
  for (let r = grid.length - 1; r >= 0; r--) {
    if (grid[r].some((c) => c !== "")) return r;
  }
  return -1;
}

function readGrid(
  grid: string[][],
  startCol: number,
  startRow: number,
  endCol: number | null,
  endRow: number | null,
): string[][] {
  const maxRow = endRow ?? grid.length - 1;
  const rows: string[][] = [];
  for (let r = startRow; r <= maxRow; r++) {
    const rowData = grid[r] ?? [];
    const maxCol = endCol ?? rowData.length - 1;
    const cells: string[] = [];
    for (let c = startCol; c <= maxCol; c++) cells.push(rowData[c] ?? "");
    rows.push(cells);
  }
  const trimmedRows = rows.map((row) => {
    let end = row.length;
    while (end > 0 && row[end - 1] === "") end--;
    return row.slice(0, end);
  });
  let end = trimmedRows.length;
  while (end > 0 && trimmedRows[end - 1].length === 0) end--;
  return trimmedRows.slice(0, end);
}

type AddSheetRequest = { addSheet: { properties: { sheetId: number; title: string; hidden?: boolean } } };
type UpdateCellsRequest = {
  updateCells: {
    start: { sheetId: number; rowIndex: number; columnIndex: number };
    rows: { values: { userEnteredValue?: { stringValue?: string } }[] }[];
  };
};
type UpdateSheetPropertiesRequest = {
  updateSheetProperties: { properties: { sheetId: number; hidden?: boolean } };
};

function isAddSheet(req: SheetsRequest): req is AddSheetRequest {
  return "addSheet" in req;
}
function isUpdateCells(req: SheetsRequest): req is UpdateCellsRequest {
  return "updateCells" in req;
}
function isUpdateSheetProperties(req: SheetsRequest): req is UpdateSheetPropertiesRequest {
  return "updateSheetProperties" in req;
}

function applyUpdateCells(doc: FakeDoc, req: UpdateCellsRequest["updateCells"]): void {
  const sheet = doc.sheets.find((s) => s.sheetId === req.start.sheetId);
  if (!sheet) return;
  req.rows.forEach((row, ri) => {
    const r = req.start.rowIndex + ri;
    ensureRow(sheet.grid, r);
    row.values.forEach((cell, ci) => {
      const c = req.start.columnIndex + ci;
      ensureCol(sheet.grid[r], c);
      sheet.grid[r][c] = cell.userEnteredValue?.stringValue ?? "";
    });
  });
}

export function createFakeSheetsClient(store: FakeStore): SheetsClient {
  return {
    async getSpreadsheet(id) {
      assertAccess(id, "read");
      const doc = await loadOrCreate(store, id);
      return {
        title: doc.title,
        sheets: doc.sheets.map(({ sheetId, title, hidden }) => ({ sheetId, title, hidden })),
      };
    },

    async getValues(id, range) {
      assertAccess(id, "read");
      const doc = await loadOrCreate(store, id);
      const { sheet, startCol, startRow, endCol, endRow } = parseRange(range);
      const s = doc.sheets.find((x) => x.title === sheet);
      if (!s) throw new SheetsError(400, `シートが見つかりません: ${sheet}`);
      return readGrid(s.grid, startCol, startRow, endCol, endRow);
    },

    async batchUpdateValues(id, data) {
      assertAccess(id, "write");
      const doc = await loadOrCreate(store, id);
      for (const { range, values } of data) {
        const { sheet, startCol, startRow } = parseRange(range);
        const s = doc.sheets.find((x) => x.title === sheet);
        if (!s) throw new SheetsError(400, `シートが見つかりません: ${sheet}`);
        writeValues(s.grid, startCol, startRow, values);
      }
      await store.save(id, doc);
    },

    async appendValues(id, range, values) {
      assertAccess(id, "write");
      const doc = await loadOrCreate(store, id);
      const { sheet } = parseRange(range);
      const s = doc.sheets.find((x) => x.title === sheet);
      if (!s) throw new SheetsError(400, `シートが見つかりません: ${sheet}`);
      writeValues(s.grid, 0, lastNonEmptyRowIndex(s.grid) + 1, values);
      await store.save(id, doc);
    },

    async batchUpdate(id, requests) {
      assertAccess(id, "write");
      const doc = await loadOrCreate(store, id);

      const seenTitles = new Set(doc.sheets.map((s) => s.title));
      const seenIds = new Set(doc.sheets.map((s) => s.sheetId));
      for (const req of requests) {
        if (isAddSheet(req)) {
          const { sheetId, title } = req.addSheet.properties;
          if (seenIds.has(sheetId) || seenTitles.has(title)) {
            throw new SheetsError(400, `シートが既に存在します: ${title}`);
          }
          seenIds.add(sheetId);
          seenTitles.add(title);
        } else if (isUpdateCells(req)) {
          const { sheetId } = req.updateCells.start;
          if (!seenIds.has(sheetId)) {
            throw new SheetsError(400, `シートが見つかりません: sheetId=${sheetId}`);
          }
        } else if (isUpdateSheetProperties(req)) {
          const { sheetId } = req.updateSheetProperties.properties;
          if (!seenIds.has(sheetId)) {
            throw new SheetsError(400, `シートが見つかりません: sheetId=${sheetId}`);
          }
        }
      }

      for (const req of requests) {
        doc.requests.push(req);
        if (isAddSheet(req)) {
          const { sheetId, title, hidden } = req.addSheet.properties;
          doc.sheets.push({ sheetId, title, hidden: !!hidden, grid: [] });
        } else if (isUpdateCells(req)) {
          applyUpdateCells(doc, req.updateCells);
        } else if (isUpdateSheetProperties(req)) {
          const { sheetId, hidden } = req.updateSheetProperties.properties;
          const sheet = doc.sheets.find((s) => s.sheetId === sheetId);
          if (sheet && typeof hidden === "boolean") sheet.hidden = hidden;
        }
      }
      await store.save(id, doc);
    },
  };
}
