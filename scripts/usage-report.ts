// pnpm usage：ローカル or 本番の D1 を読み取り、利用者ごとの利用状況を表にして出す。
// 書き込み系の SQL は使わない。出力（表示名を含む）はファイルに保存しない。
import { execFileSync } from "child_process";
import fs from "fs";
import { buildQueries, formatTable, mergeRows, parseArgs, sinceIso } from "./usage-format.ts";

function readAccountId(): string {
  let text: string;
  try {
    text = fs.readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  } catch {
    throw new Error("wrangler.jsonc を読み込めませんでした");
  }
  const m = /"account_id"\s*:\s*"([^"]+)"/.exec(text);
  if (!m) {
    throw new Error("wrangler.jsonc から account_id を読み取れませんでした");
  }
  return m[1];
}

class WranglerError extends Error {
  stderr: string;
  constructor(stderr: string) {
    super("wrangler の実行に失敗しました");
    this.stderr = stderr;
  }
}

function runQuery(sql: string, local: boolean, accountId: string): unknown[] {
  const args = ["-s", "wrangler", "d1", "execute", "DB", local ? "--local" : "--remote", "--json", "--command", sql];
  let out: string;
  try {
    out = execFileSync("pnpm", args, {
      encoding: "utf8",
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
    });
  } catch (e) {
    const stderr = String((e as { stderr?: unknown }).stderr ?? (e as Error).message ?? e);
    throw new WranglerError(stderr);
  }
  const parsed = JSON.parse(out) as Array<{ results?: unknown[] }>;
  return parsed[0]?.results ?? [];
}

function main(): void {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  const since = sinceIso(new Date(), opts.days);
  const queries = buildQueries(opts, since);

  let accountId: string;
  let users: unknown[];
  let access: unknown[];
  let activity: unknown[];
  let notify: unknown[];
  try {
    accountId = readAccountId();
    users = runQuery(queries.users, opts.local, accountId);
    access = runQuery(queries.access, opts.local, accountId);
    activity = runQuery(queries.activity, opts.local, accountId);
    notify = runQuery(queries.notify, opts.local, accountId);
  } catch (e) {
    if (e instanceof WranglerError) {
      const lines = e.stderr.trim().split("\n").slice(-5).join("\n");
      console.error(lines || e.message);
      process.exit(1);
    }
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  // wrangler の --json が返す行の形は mergeRows 側の型で扱う
  const rows = mergeRows({
    users: users as Parameters<typeof mergeRows>[0]["users"],
    access: access as Parameters<typeof mergeRows>[0]["access"],
    activity: activity as Parameters<typeof mergeRows>[0]["activity"],
    notify: notify as Parameters<typeof mergeRows>[0]["notify"],
  });

  const target = opts.local ? "ローカル" : "本番";
  const project = opts.project ?? "すべて";
  console.log(`期間: ${since} 以降 / 対象: ${target} / プロジェクト: ${project}`);
  console.log(formatTable(rows));
}

main();
