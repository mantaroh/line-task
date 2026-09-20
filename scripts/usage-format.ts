// pnpm usage（scripts/usage-report.ts）が使う、引数の読み取り・SQL の組み立て・表の整形。
// D1 への読み取りは usage-report.ts 側で行う。ここには副作用のある処理を書かない。

export type UsageOptions = { days: number; project: string | null; local: boolean };

const PROJECT_ID_RE = /^[0-9a-z]{10}$/;

export function parseArgs(argv: string[]): UsageOptions {
  let days = 30;
  let project: string | null = null;
  let local = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--days") {
      const value = argv[++i];
      if (value === undefined || !/^\d+$/.test(value)) {
        throw new Error(`--days の値が不正です: ${value ?? ""}`);
      }
      const n = Number(value);
      if (n < 1 || n > 30) {
        throw new Error(`--days は 1〜30 で指定してください: ${value}`);
      }
      days = n;
    } else if (arg === "--project") {
      const value = argv[++i];
      if (value === undefined || !PROJECT_ID_RE.test(value)) {
        throw new Error(`--project の値が不正です: ${value ?? ""}`);
      }
      project = value;
    } else if (arg === "--local") {
      local = true;
    } else {
      throw new Error(`不明なオプションです: ${arg}`);
    }
  }

  return { days, project, local };
}

// JST（+09:00）で now から days 日前の日時を返す。タイムゾーン変換はせず、
// UTC のエポック値に 9 時間分を足してから引き算し、その結果を JST の壁時計として読む。
export function sinceIso(now: Date, days: number): string {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000 - days * 24 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const mo = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  const h = String(jst.getUTCHours()).padStart(2, "0");
  const mi = String(jst.getUTCMinutes()).padStart(2, "0");
  const s = String(jst.getUTCSeconds()).padStart(2, "0");
  return `${y}-${mo}-${d}T${h}:${mi}:${s}+09:00`;
}

export type UsageQueries = { users: string; access: string; activity: string; notify: string };

// since と project は検証済みの値だけをシングルクォートで囲んで埋め込む。
// 4 つの SELECT は line_user_id を "id" という別名で返し、mergeRows で突き合わせる。
export function buildQueries(opts: UsageOptions, since: string): UsageQueries {
  const sinceLit = `'${since}'`;
  const projectCond = opts.project ? ` AND project_id = '${opts.project}'` : "";
  const memberCond = opts.project ? ` WHERE m.project_id = '${opts.project}'` : "";

  // --project が無ければ、所属先の無い利用者も出す（LEFT JOIN）。
  // --project があれば、そのメンバーだけを出す（従来どおりの JOIN + WHERE）。
  const usersJoin = opts.project
    ? `JOIN members m ON m.line_user_id = u.line_user_id JOIN projects p ON p.id = m.project_id`
    : `LEFT JOIN members m ON m.line_user_id = u.line_user_id LEFT JOIN projects p ON p.id = m.project_id`;
  const users =
    `SELECT u.line_user_id AS id, u.display_name AS name, u.last_seen_at AS lastSeen, u.line_friend AS friend, ` +
    `GROUP_CONCAT(p.name, '、') AS projects ` +
    `FROM users u ${usersJoin}` +
    `${memberCond} GROUP BY u.line_user_id`;

  const access =
    `SELECT line_user_id AS id, COUNT(DISTINCT substr(at, 1, 10)) AS activeDays, ` +
    `SUM(CASE WHEN view = 'project' THEN 1 ELSE 0 END) AS list, ` +
    `SUM(CASE WHEN view = 'task' THEN 1 ELSE 0 END) AS detail, ` +
    `SUM(CASE WHEN view = 'settings' THEN 1 ELSE 0 END) AS settings ` +
    `FROM access_log WHERE at >= ${sinceLit}${projectCond} GROUP BY line_user_id`;

  const activity = `SELECT actor AS id, COUNT(*) AS actions FROM activity WHERE at >= ${sinceLit}${projectCond} GROUP BY actor`;

  const notify =
    `SELECT line_user_id AS id, COUNT(DISTINCT substr(sent_at, 1, 10)) AS notifyDays ` +
    `FROM notification_log WHERE sent_at >= ${sinceLit}${projectCond} GROUP BY line_user_id`;

  return { users, access, activity, notify };
}

export type UsageRow = {
  name: string;
  projects: string;
  lastSeen: string | null;
  activeDays: number;
  list: number;
  detail: number;
  settings: number;
  actions: number;
  notifyDays: number;
  friend: boolean | null;
};

type UsersRow = { id: string; name: string; lastSeen: string | null; friend: number | null; projects: string };
type AccessRow = { id: string; activeDays: number; list: number; detail: number; settings: number };
type ActivityRow = { id: string; actions: number };
type NotifyRow = { id: string; notifyDays: number };

export function mergeRows(result: {
  users: UsersRow[];
  access: AccessRow[];
  activity: ActivityRow[];
  notify: NotifyRow[];
}): UsageRow[] {
  const accessById = new Map(result.access.map((r) => [r.id, r]));
  const activityById = new Map(result.activity.map((r) => [r.id, r]));
  const notifyById = new Map(result.notify.map((r) => [r.id, r]));

  const rows: UsageRow[] = result.users.map((u) => {
    const a = accessById.get(u.id);
    const act = activityById.get(u.id);
    const n = notifyById.get(u.id);
    return {
      name: u.name ?? "",
      projects: u.projects ?? "",
      lastSeen: u.lastSeen ?? null,
      activeDays: a?.activeDays ?? 0,
      list: a?.list ?? 0,
      detail: a?.detail ?? 0,
      settings: a?.settings ?? 0,
      actions: act?.actions ?? 0,
      notifyDays: n?.notifyDays ?? 0,
      friend: u.friend === 1 ? true : u.friend === 0 ? false : null,
    };
  });

  rows.sort((x, y) => {
    if (x.lastSeen === null && y.lastSeen === null) return x.name.localeCompare(y.name, "ja");
    if (x.lastSeen === null) return 1;
    if (y.lastSeen === null) return -1;
    if (x.lastSeen !== y.lastSeen) return x.lastSeen > y.lastSeen ? -1 : 1;
    return x.name.localeCompare(y.name, "ja");
  });

  return rows;
}

// 全角文字を幅 2、それ以外を幅 1 として数える（East Asian Width の簡易判定）。
function charWidth(cp: number): number {
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
  ) {
    return 2;
  }
  return 1;
}

function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += charWidth(ch.codePointAt(0)!);
  }
  return w;
}

function padDisplay(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - displayWidth(s)));
}

// 制御文字（エスケープシーケンスなど）を取り除く。幅の計算やターミナルの表示が崩れるのを防ぐ。
function stripControl(s: string): string {
  return s.replace(/\p{Cc}/gu, "");
}

function formatLastSeen(iso: string | null): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return "—";
  const [, , mo, d, h, mi] = m;
  return `${Number(mo)}/${Number(d)} ${h}:${mi}`;
}

const HEADERS = ["利用者", "プロジェクト", "最終利用", "利用日数", "一覧", "詳細", "設定", "操作", "通知", "友だち"];

export function formatTable(rows: UsageRow[]): string {
  const cells = rows.map((r) =>
    [
      r.name === "" ? "（名前なし）" : r.name,
      r.projects === "" ? "—" : r.projects,
      formatLastSeen(r.lastSeen),
      String(r.activeDays),
      String(r.list),
      String(r.detail),
      String(r.settings),
      String(r.actions),
      String(r.notifyDays),
      r.friend === true ? "済" : r.friend === false ? "未" : "?",
    ].map(stripControl),
  );

  const widths = HEADERS.map((h, i) => Math.max(displayWidth(h), ...cells.map((c) => displayWidth(c[i]))));

  const lines = [
    HEADERS.map((h, i) => padDisplay(h, widths[i])).join("  "),
    widths.map((w) => "─".repeat(w)).join("  "),
    ...cells.map((c) => c.map((v, i) => padDisplay(v, widths[i])).join("  ")),
  ];

  return lines.join("\n");
}
