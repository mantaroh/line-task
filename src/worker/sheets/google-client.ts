// 本物の Google Sheets API v4 クライアント。SheetsClient を実装する。
import { SheetsError, type SheetMeta, type SheetsClient, type SheetsRequest, type SpreadsheetMeta } from "./client";

const BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type SpreadsheetResponse = {
  properties?: { title?: string };
  sheets?: {
    properties?: { sheetId?: number; title?: string; hidden?: boolean; gridProperties?: { columnCount?: number } };
  }[];
};

export function createGoogleSheetsClient(
  getToken: () => Promise<string>,
  fetchFn: typeof fetch,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): SheetsClient {
  async function call(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await getToken();
    const headers = { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` };
    const doFetch = () => fetchFn(url, { ...init, headers });

    let res = await doFetch();
    if (res.status === 429) {
      await sleep(1000);
      res = await doFetch();
    }
    if (res.status < 200 || res.status >= 300) {
      throw new SheetsError(res.status, `Sheets API ${res.status}`);
    }
    return res;
  }

  function post(url: string, body: unknown): Promise<Response> {
    return call(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

  return {
    async getSpreadsheet(id) {
      const url = `${BASE}/${encodeURIComponent(id)}?fields=properties.title,sheets.properties`;
      const res = await call(url);
      const json = (await res.json()) as SpreadsheetResponse;
      const sheets: SheetMeta[] = (json.sheets ?? []).map((s) => ({
        sheetId: s.properties?.sheetId ?? 0,
        title: s.properties?.title ?? "",
        hidden: s.properties?.hidden === true,
        columnCount: s.properties?.gridProperties?.columnCount,
      }));
      const meta: SpreadsheetMeta = { title: json.properties?.title ?? "", sheets };
      return meta;
    },

    async getValues(id, range) {
      const url = `${BASE}/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}`;
      const res = await call(url);
      const json = (await res.json()) as { values?: unknown[][] };
      return (json.values ?? []).map((row) => row.map(String));
    },

    async batchUpdateValues(id, data) {
      const url = `${BASE}/${encodeURIComponent(id)}/values:batchUpdate`;
      await post(url, { valueInputOption: "USER_ENTERED", data });
    },

    async appendValues(id, range, values) {
      const url = `${BASE}/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
      await post(url, { values });
    },

    async batchUpdate(id, requests: SheetsRequest[]) {
      const url = `${BASE}/${encodeURIComponent(id)}:batchUpdate`;
      await post(url, { requests });
    },
  };
}
