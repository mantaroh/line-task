// Google Sheets を叩くクライアントのインターフェース。本物（Task 6）・偽物（fake-sheets.ts）が実装する。

// columnCount は本物の API だけが返す（偽シートでは undefined）。
export type SheetMeta = { sheetId: number; title: string; hidden: boolean; columnCount?: number };
export type SpreadsheetMeta = { title: string; sheets: SheetMeta[] };
export type SheetsRequest = Record<string, unknown>;

export interface SheetsClient {
  getSpreadsheet(id: string): Promise<SpreadsheetMeta>;
  getValues(id: string, range: string): Promise<string[][]>;
  batchUpdateValues(id: string, data: { range: string; values: string[][] }[]): Promise<void>;
  appendValues(id: string, range: string, values: string[][]): Promise<void>;
  batchUpdate(id: string, requests: SheetsRequest[]): Promise<void>;
}

export class SheetsError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
