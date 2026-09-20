// シートをつなぐときの検証と、「タスク」「_設定」タブの初期化（設計書 §4-1〜§4-3）。
import { colLetter, rangeOf } from "./a1";
import { SheetsError, type SheetMeta, type SheetsClient, type SheetsRequest } from "./client";
import { HttpError } from "../errors";
import { FIELD_HEADERS, HEADER_ORDER, TASK_STATUSES, type TaskField } from "../../shared/types";

export const TASK_SHEET = "タスク";
export const CONFIG_SHEET = "_設定";
export const MARKER = "line-task-board";
// タスクの読み取りは A1:Z 固定なので、見出しは Z 列までに収める。
export const MAX_COLUMNS = 26;

const URL_RE = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)(?:\/|$)/;

export function parseSpreadsheetUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const m = URL_RE.exec(url);
  return m ? m[1] : null;
}

export type InitInput = {
  sheets: SheetMeta[];
  taskHeaders: string[] | null;
  projectId: string;
  parties: string[];
  reinit: boolean;
};

function inUse(): HttpError {
  return new HttpError(409, "sheet_in_use", "このシートは別のプロジェクトで使われています");
}

function readonlyError(): HttpError {
  return new HttpError(400, "sheet_readonly", "編集者で共有してください");
}

function mapSheetsError(saEmail: string) {
  return (e: unknown): never => {
    if (e instanceof SheetsError) {
      if (e.status === 403 || e.status === 404) {
        throw new HttpError(400, "sheet_no_access", `サービスアカウント（${saEmail}）に編集者で共有してください`);
      }
      if (e.status === 429) {
        throw new HttpError(503, "rate_limited", "混み合っています。少し待ってからやり直してください");
      }
    }
    throw e;
  };
}

export function buildInitRequests(input: InitInput): SheetsRequest[] {
  const { sheets, taskHeaders, projectId, parties, reinit } = input;
  const requests: SheetsRequest[] = [];
  const usedIds = new Set(sheets.map((s) => s.sheetId));

  function nextSheetId(): number {
    let id = 1001;
    while (usedIds.has(id)) id++;
    usedIds.add(id);
    return id;
  }

  const existingTask = sheets.find((s) => s.title === TASK_SHEET);
  const existingConfig = sheets.find((s) => s.title === CONFIG_SHEET);

  let taskSheetId: number;
  if (existingTask) {
    taskSheetId = existingTask.sheetId;
  } else {
    taskSheetId = nextSheetId();
    requests.push({
      addSheet: { properties: { sheetId: taskSheetId, title: TASK_SHEET, gridProperties: { frozenRowCount: 1 } } },
    });
  }

  let configSheetId: number;
  if (existingConfig) {
    configSheetId = existingConfig.sheetId;
    if (!existingConfig.hidden) {
      requests.push({
        updateSheetProperties: { properties: { sheetId: configSheetId, hidden: true }, fields: "hidden" },
      });
    }
  } else {
    configSheetId = nextSheetId();
    requests.push({
      addSheet: { properties: { sheetId: configSheetId, title: CONFIG_SHEET, hidden: true } },
    });
  }

  const existingHeaders = (taskHeaders ?? []).map((h) => h.trim());
  const missingFields: TaskField[] = HEADER_ORDER.filter((f) => !existingHeaders.includes(FIELD_HEADERS[f]));

  const totalColumns = existingHeaders.length + missingFields.length;
  if (totalColumns > MAX_COLUMNS) {
    throw new HttpError(400, "sheet_too_wide", "「タスク」タブの列が多すぎます。見出しを Z 列までに収めてください");
  }
  if (existingTask?.columnCount !== undefined && existingTask.columnCount < totalColumns) {
    requests.push({
      appendDimension: { sheetId: taskSheetId, dimension: "COLUMNS", length: totalColumns - existingTask.columnCount },
    });
  }

  if (missingFields.length > 0) {
    requests.push({
      updateCells: {
        start: { sheetId: taskSheetId, rowIndex: 0, columnIndex: existingHeaders.length },
        rows: [{ values: missingFields.map((f) => ({ userEnteredValue: { stringValue: FIELD_HEADERS[f] } })) }],
        fields: "userEnteredValue",
      },
    });
  }

  requests.push({
    updateSheetProperties: {
      properties: { sheetId: taskSheetId, gridProperties: { frozenRowCount: 1 } },
      fields: "gridProperties.frozenRowCount",
    },
  });

  const partyRows = Array.from({ length: 5 }, (_, i) => parties[i] ?? "");
  requests.push({
    updateCells: {
      start: { sheetId: configSheetId, rowIndex: 0, columnIndex: 0 },
      rows: [
        { values: [{ userEnteredValue: { stringValue: MARKER } }, { userEnteredValue: { stringValue: projectId } }] },
        { values: [{ userEnteredValue: { stringValue: "関係者" } }] },
        ...partyRows.map((p) => ({ values: [{ userEnteredValue: { stringValue: p } }] })),
      ],
      fields: "userEnteredValue",
    },
  });

  const finalHeaders = [...existingHeaders, ...missingFields.map((f) => FIELD_HEADERS[f])];
  const ballCol = finalHeaders.indexOf(FIELD_HEADERS.ball);
  const statusCol = finalHeaders.indexOf(FIELD_HEADERS.status);
  const dueCol = finalHeaders.indexOf(FIELD_HEADERS.due);
  const createdCol = finalHeaders.indexOf(FIELD_HEADERS.createdAt);
  const updatedCol = finalHeaders.indexOf(FIELD_HEADERS.updatedAt);

  const columnRange = (col: number) => ({
    sheetId: taskSheetId,
    startRowIndex: 1,
    startColumnIndex: col,
    endColumnIndex: col + 1,
  });

  if (ballCol !== -1) {
    requests.push({
      setDataValidation: {
        range: columnRange(ballCol),
        rule: {
          condition: { type: "ONE_OF_RANGE", values: [{ userEnteredValue: `=${rangeOf(CONFIG_SHEET, "$A$3:$A$7")}` }] },
          strict: true,
          showCustomUi: true,
        },
      },
    });
  }

  if (statusCol !== -1) {
    requests.push({
      setDataValidation: {
        range: columnRange(statusCol),
        rule: {
          condition: { type: "ONE_OF_LIST", values: TASK_STATUSES.map((v) => ({ userEnteredValue: v })) },
          strict: true,
          showCustomUi: true,
        },
      },
    });
  }

  if (dueCol !== -1) {
    requests.push({
      setDataValidation: {
        range: columnRange(dueCol),
        rule: { condition: { type: "DATE_IS_VALID" }, strict: true, showCustomUi: true },
      },
    });
    requests.push({
      repeatCell: {
        range: columnRange(dueCol),
        cell: { userEnteredFormat: { numberFormat: { type: "DATE", pattern: "yyyy-mm-dd" } } },
        fields: "userEnteredFormat.numberFormat",
      },
    });
  }

  if (createdCol !== -1) {
    requests.push({
      repeatCell: {
        range: columnRange(createdCol),
        cell: { userEnteredFormat: { numberFormat: { type: "DATE_TIME", pattern: "yyyy-mm-dd hh:mm" } } },
        fields: "userEnteredFormat.numberFormat",
      },
    });
  }

  if (updatedCol !== -1) {
    requests.push({
      repeatCell: {
        range: columnRange(updatedCol),
        cell: { userEnteredFormat: { numberFormat: { type: "DATE_TIME", pattern: "yyyy-mm-dd hh:mm" } } },
        fields: "userEnteredFormat.numberFormat",
      },
    });
  }

  if (!reinit && statusCol !== -1 && dueCol !== -1) {
    const totalCols = finalHeaders.length;
    const dueLetter = colLetter(dueCol);
    const statusLetter = colLetter(statusCol);
    requests.push({
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId: taskSheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: totalCols }],
          booleanRule: {
            condition: {
              type: "CUSTOM_FORMULA",
              values: [
                {
                  userEnteredValue: `=AND($${dueLetter}2<>"",$${dueLetter}2<TODAY(),$${statusLetter}2<>"完了",$${statusLetter}2<>"取り下げ")`,
                },
              ],
            },
            format: { backgroundColor: { red: 0.96, green: 0.8, blue: 0.8 } },
          },
        },
        index: 0,
      },
    });
    requests.push({
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId: taskSheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: totalCols }],
          booleanRule: {
            condition: {
              type: "CUSTOM_FORMULA",
              values: [{ userEnteredValue: `=OR($${statusLetter}2="完了",$${statusLetter}2="取り下げ")` }],
            },
            format: { textFormat: { foregroundColor: { red: 0.6, green: 0.6, blue: 0.6 } } },
          },
        },
        index: 1,
      },
    });
  }

  if (!reinit) {
    requests.push({
      addProtectedRange: {
        protectedRange: {
          range: { sheetId: taskSheetId, startRowIndex: 0, endRowIndex: 1 },
          description: "見出し（line-task-board が列を探すのに使います）",
          warningOnly: true,
        },
      },
    });
  }

  return requests;
}

// USER_ENTERED での書き込みは = + - @ で始まる文字を数式扱いするため、先頭に ' を付けて防ぐ。
function escapeUserEntered(v: string): string {
  return /^[=+\-@]/.test(v) ? `'${v}` : v;
}

export function partiesCells(parties: string[]): { range: string; values: string[][] } {
  const rows = Array.from({ length: 5 }, (_, i) => [escapeUserEntered(parties[i] ?? "")]);
  return { range: rangeOf(CONFIG_SHEET, "A3:A7"), values: rows };
}

export async function initializeSheet(
  sheets: SheetsClient,
  spreadsheetId: string,
  projectId: string,
  parties: string[],
  saEmail: string,
): Promise<void> {
  const meta = await sheets.getSpreadsheet(spreadsheetId).catch(mapSheetsError(saEmail));
  let reinit = false;
  if (meta.sheets.some((s) => s.title === CONFIG_SHEET)) {
    const [[a1, b1] = []] = await sheets.getValues(spreadsheetId, rangeOf(CONFIG_SHEET, "A1:B1")).catch(mapSheetsError(saEmail));
    if (a1 === MARKER && b1 && b1 !== projectId) throw inUse();
    reinit = a1 === MARKER && b1 === projectId;
  }
  const taskHeaders = meta.sheets.some((s) => s.title === TASK_SHEET)
    ? ((await sheets.getValues(spreadsheetId, rangeOf(TASK_SHEET, "1:1")).catch(mapSheetsError(saEmail)))[0] ?? [])
    : null;
  await sheets
    .batchUpdate(spreadsheetId, buildInitRequests({ sheets: meta.sheets, taskHeaders, projectId, parties, reinit }))
    .catch((e) => {
      if (e instanceof SheetsError && e.status === 403) throw readonlyError();
      return mapSheetsError(saEmail)(e);
    });
}
