import { describe, expect, it } from "vitest";
import {
  buildQueries,
  formatTable,
  mergeRows,
  parseArgs,
  sinceIso,
  type UsageRow,
} from "../../scripts/usage-format.ts";

describe("parseArgs", () => {
  it("既定値", () => {
    expect(parseArgs([])).toEqual({ days: 30, project: null, local: false });
  });

  it("--days を指定する", () => {
    expect(parseArgs(["--days", "7"])).toEqual({ days: 7, project: null, local: false });
  });

  it("--project を指定する", () => {
    expect(parseArgs(["--project", "abcdefghij"])).toEqual({
      days: 30,
      project: "abcdefghij",
      local: false,
    });
  });

  it("--local を指定する", () => {
    expect(parseArgs(["--local"])).toEqual({ days: 30, project: null, local: true });
  });

  it("複数指定できる", () => {
    expect(parseArgs(["--local", "--days", "7", "--project", "abcdefghij"])).toEqual({
      days: 7,
      project: "abcdefghij",
      local: true,
    });
  });

  it("--days 0 は不正", () => {
    expect(() => parseArgs(["--days", "0"])).toThrow(Error);
  });

  it("--days 31 は不正", () => {
    expect(() => parseArgs(["--days", "31"])).toThrow(Error);
  });

  it("--days が数字でなければ不正", () => {
    expect(() => parseArgs(["--days", "x"])).toThrow(Error);
  });

  it("--project の形式が不正なら例外", () => {
    expect(() => parseArgs(["--project", "a' OR 1=1"])).toThrow(Error);
  });

  it("未知のオプションは例外", () => {
    expect(() => parseArgs(["--foo"])).toThrow(Error);
  });
});

describe("sinceIso", () => {
  it("JST の +09:00 付きで、指定日数前を返す", () => {
    expect(sinceIso(new Date("2026-09-17T01:00:00Z"), 30)).toBe("2026-08-18T10:00:00+09:00");
  });
});

describe("buildQueries", () => {
  const since = "2026-08-18T10:00:00+09:00";

  it("--project なしなら project_id の絞り込みが無い", () => {
    const queries = buildQueries({ days: 30, project: null, local: false }, since);
    for (const sql of Object.values(queries)) {
      expect(sql).not.toContain("project_id = '");
    }
  });

  it("--project なしなら users は LEFT JOIN で所属の無い利用者も含む", () => {
    const queries = buildQueries({ days: 30, project: null, local: false }, since);
    expect(queries.users).toContain("LEFT JOIN members");
    expect(queries.users).toContain("LEFT JOIN projects");
  });

  it("--project ありなら users は所属メンバーだけの JOIN のまま", () => {
    const queries = buildQueries({ days: 30, project: "abcdefghij", local: false }, since);
    expect(queries.users).not.toContain("LEFT JOIN");
    expect(queries.users).toContain("JOIN members");
    expect(queries.users).toContain("JOIN projects");
  });

  it("--project ありなら 4 つとも対象プロジェクトで絞り込む", () => {
    const queries = buildQueries({ days: 30, project: "abcdefghij", local: false }, since);
    for (const sql of Object.values(queries)) {
      expect(sql).toContain("'abcdefghij'");
    }
  });

  it("4 つとも SELECT だけで、書き込み系のキーワードを含まない", () => {
    const queries = buildQueries({ days: 30, project: null, local: false }, since);
    for (const sql of Object.values(queries)) {
      expect(sql.trim().toUpperCase().startsWith("SELECT")).toBe(true);
      expect(sql.toUpperCase()).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    }
  });

  it("since を絞り込みに使う", () => {
    const queries = buildQueries({ days: 30, project: null, local: false }, since);
    expect(queries.access).toContain(`'${since}'`);
    expect(queries.activity).toContain(`'${since}'`);
    expect(queries.notify).toContain(`'${since}'`);
  });
});

describe("mergeRows", () => {
  it("アクセスが無い人は 0 になる", () => {
    const rows = mergeRows({
      users: [
        {
          id: "u1",
          name: "太郎",
          projects: "プロジェクトA",
          lastSeen: "2026-09-10T09:00:00+09:00",
          friend: 1,
        },
      ],
      access: [],
      activity: [],
      notify: [],
    });
    expect(rows).toEqual<UsageRow[]>([
      {
        name: "太郎",
        projects: "プロジェクトA",
        lastSeen: "2026-09-10T09:00:00+09:00",
        activeDays: 0,
        list: 0,
        detail: 0,
        settings: 0,
        actions: 0,
        notifyDays: 0,
        friend: true,
      },
    ]);
  });

  it("友だちの状態を変換する（1→true・0→false・null→null）", () => {
    const rows = mergeRows({
      users: [
        { id: "u1", name: "A", projects: "P", lastSeen: null, friend: 1 },
        { id: "u2", name: "B", projects: "P", lastSeen: null, friend: 0 },
        { id: "u3", name: "C", projects: "P", lastSeen: null, friend: null },
      ],
      access: [],
      activity: [],
      notify: [],
    });
    expect(rows.map((r) => r.friend)).toEqual([true, false, null]);
  });

  it("最終利用の新しい順、null は最後", () => {
    const rows = mergeRows({
      users: [
        { id: "u1", name: "古い", projects: "P", lastSeen: "2026-09-01T00:00:00+09:00", friend: null },
        { id: "u2", name: "新しい", projects: "P", lastSeen: "2026-09-10T00:00:00+09:00", friend: null },
        { id: "u3", name: "未利用", projects: "P", lastSeen: null, friend: null },
      ],
      access: [],
      activity: [],
      notify: [],
    });
    expect(rows.map((r) => r.name)).toEqual(["新しい", "古い", "未利用"]);
  });

  it("access・activity・notify を利用者ごとに集計する", () => {
    const rows = mergeRows({
      users: [{ id: "u1", name: "A", projects: "P", lastSeen: null, friend: null }],
      access: [{ id: "u1", activeDays: 3, list: 5, detail: 2, settings: 1 }],
      activity: [{ id: "u1", actions: 4 }],
      notify: [{ id: "u1", notifyDays: 2 }],
    });
    expect(rows[0]).toMatchObject({
      activeDays: 3,
      list: 5,
      detail: 2,
      settings: 1,
      actions: 4,
      notifyDays: 2,
    });
  });
});

describe("formatTable", () => {
  it("見出し行と区切りを出す", () => {
    const table = formatTable([]);
    const lines = table.split("\n");
    expect(lines[0]).toContain("利用者");
    expect(lines[0]).toContain("最終利用");
    expect(lines[1]).toMatch(/^[-─]+(\s{2}[-─]+)*$/);
  });

  it("名前が空なら（名前なし）にする", () => {
    const table = formatTable([makeRow({ name: "" })]);
    expect(table).toContain("（名前なし）");
  });

  it("最終利用が無ければ「—」", () => {
    const table = formatTable([makeRow({ lastSeen: null })]);
    expect(table).toContain("—");
  });

  it("最終利用を M/D HH:mm で出す", () => {
    const table = formatTable([makeRow({ lastSeen: "2026-09-17T10:52:03+09:00" })]);
    expect(table).toContain("9/17 10:52");
  });

  it("友だちの表示（済・未・?）", () => {
    const table = formatTable([
      makeRow({ name: "a", friend: true }),
      makeRow({ name: "b", friend: false }),
      makeRow({ name: "c", friend: null }),
    ]);
    const lines = table.split("\n").slice(2);
    expect(lines[0]).toContain("済");
    expect(lines[1]).toContain("未");
    expect(lines[2]).toContain("?");
  });

  it("所属が無ければ「—」", () => {
    const table = formatTable([makeRow({ projects: "" })]);
    expect(table).toContain("—");
  });

  it("制御文字を取り除く（ANSI エスケープを含む名前でも表示が崩れない）", () => {
    const esc = String.fromCharCode(27);
    const table = formatTable([makeRow({ name: `${esc}[31m赤${esc}[0m` })]);
    expect(table.includes(esc)).toBe(false);
    expect(table).toContain("[31m");
    const lines = table.split("\n");
    const widths = lines.map(displayWidthForTest);
    expect(new Set(widths).size).toBe(1);
  });

  it("全角の名前でも列がそろう（各行の表示幅が同じ）", () => {
    const table = formatTable([
      makeRow({ name: "あいうえお太郎", projects: "全角プロジェクト名" }),
      makeRow({ name: "bob", projects: "p" }),
    ]);
    const lines = table.split("\n");
    const widths = lines.map(displayWidthForTest);
    expect(new Set(widths).size).toBe(1);
  });
});

function makeRow(overrides: Partial<UsageRow>): UsageRow {
  return {
    name: "利用者",
    projects: "プロジェクト",
    lastSeen: "2026-09-10T09:00:00+09:00",
    activeDays: 1,
    list: 1,
    detail: 1,
    settings: 1,
    actions: 1,
    notifyDays: 1,
    friend: null,
    ...overrides,
  };
}

// テスト用に独立して幅を数える（実装のロジックを二重チェックするため、実装からは import しない）
function displayWidthForTest(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const wide =
      cp >= 0x1100 &&
      ((cp >= 0x1100 && cp <= 0x115f) ||
        cp === 0x2329 ||
        cp === 0x232a ||
        (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
        (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe30 && cp <= 0xfe6f) ||
        (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6) ||
        (cp >= 0x20000 && cp <= 0x3fffd));
    w += wide ? 2 : 1;
  }
  return w;
}
