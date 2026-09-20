// 公開用リポジトリに出すツリーを作る。
//
// 本番の識別子と、試験データに入っている取引先名・個人名を伏せ字に置き換える。
// 実物の値はこのファイルに書かない。publish-map.json（追跡しない）から読む。
//
//   pnpm publish:public              作って検証して試験まで走らせる
//   pnpm publish:public --skip-test  試験を飛ばす
//
// push はしない。最後に実行すべきコマンドを出して止まる。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

type PublishMap = {
  remote: string;
  exclude: string[];
  // 公開ツリーでの差し替え。{ "README.public.md": "README.md" } のように書く。
  // 差し替え元は公開ツリーから消える
  rename?: Record<string, string>;
  // 長いものから順に置き換える。短い値が長い値の一部を壊さないようにするため
  replace: [from: string, to: string][];
};

const OUT_DIR = path.resolve(".publish");
const MAP_FILE = path.resolve("publish-map.json");
const SKIP_EXT = new Set([".png", ".ico", ".jpg", ".jpeg", ".gif", ".webp", ".woff", ".woff2"]);

function run(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function die(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function readMap(): PublishMap {
  if (!fs.existsSync(MAP_FILE)) {
    die(
      `${path.basename(MAP_FILE)} がありません。\n` +
        `  publish-map.example.json をコピーして、実物の値を入れてください。\n` +
        `  このファイルは追跡しません（実物の値が入るため）。`,
    );
  }
  const map = JSON.parse(fs.readFileSync(MAP_FILE, "utf8")) as PublishMap;
  if (!map.remote || !Array.isArray(map.replace) || map.replace.length === 0) {
    die(`${path.basename(MAP_FILE)} の中身が足りません（remote と replace が要ります）。`);
  }
  const empty = map.replace.filter(([from]) => from.trim() === "");
  if (empty.length > 0) die(`replace に空の置換元があります。雛形のままの行が残っていませんか。`);
  return map;
}

// 追跡しているファイルだけを取り出す。未追跡の作業ファイルは入らない
function exportTree(): void {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tar = execFileSync("git", ["archive", "HEAD"], { maxBuffer: 256 * 1024 * 1024 });
  const tmp = path.join(OUT_DIR, ".export.tar");
  fs.writeFileSync(tmp, tar);
  run("tar", ["-xf", tmp, "-C", OUT_DIR]);
  fs.rmSync(tmp);
}

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

function replaceAll(map: PublishMap): number {
  let changed = 0;
  for (const file of walk(OUT_DIR)) {
    if (SKIP_EXT.has(path.extname(file).toLowerCase())) continue;
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const before = text;
    for (const [from, to] of map.replace) text = text.split(from).join(to);
    if (text !== before) {
      fs.writeFileSync(file, text);
      changed += 1;
    }
  }
  return changed;
}

// 置換漏れがあれば止める。ここが最後の砦
function verify(map: PublishMap): void {
  const leaks: string[] = [];
  for (const file of walk(OUT_DIR)) {
    if (SKIP_EXT.has(path.extname(file).toLowerCase())) continue;
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const [from] of map.replace) {
      if (text.includes(from)) leaks.push(`${path.relative(OUT_DIR, file)}: ${from}`);
    }
  }
  if (leaks.length > 0) {
    console.error("\n✗ 実物の値が残っています。公開できません。");
    for (const leak of leaks.slice(0, 20)) console.error(`  ${leak}`);
    if (leaks.length > 20) console.error(`  … ほか ${leaks.length - 20} 件`);
    process.exit(1);
  }
}

// verify() は対応表に載っている値しか探せない。対応表に書き忘れた識別子は素通りする。
// そこで「それらしい形」を機械的に拾って、人の目に掛ける。落とさずに警告だけ出す。
const SUSPECT: { label: string; re: RegExp; ok: RegExp }[] = [
  { label: "32 桁の 16 進（アカウント ID など）", re: /\b[0-9a-f]{32}\b/g, ok: /^(0{32}|1{32})$/ },
  {
    label: "UUID（データベース ID など）",
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
    ok: /^0{8}-0{4}-0{4}-0{4}-0{12}$/,
  },
  {
    label: "メールアドレス",
    re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
    ok: /@(example\.\w+|test\.\w+|p\.iam\.|line-task-board-dev\.)/,
  },
  {
    label: "ホスト名",
    re: /https?:\/\/([a-z0-9.-]+)/gi,
    ok: /^(localhost|127\.0\.0\.1|.*\.?example\.(com|test|invalid)|.*\.?line\.me|.*\.?googleapis\.com|.*\.?google\.com|.*\.?github\.com|.*\.?cloudflare\.com|.*\.?schemastore\.org|.*\.?w3\.org|.*\.?scheduled\.invalid|.*\.?x\.test)$/i,
  },
];

function scanSuspects(): void {
  const hits = new Map<string, Set<string>>();
  for (const file of walk(OUT_DIR)) {
    if (SKIP_EXT.has(path.extname(file).toLowerCase())) continue;
    if (file.endsWith("pnpm-lock.yaml") || file.endsWith("worker-configuration.d.ts")) continue;
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const { label, re, ok } of SUSPECT) {
      for (const m of text.matchAll(re)) {
        const value = m[1] ?? m[0];
        if (ok.test(value)) continue;
        const key = `${label}: ${value}`;
        (hits.get(key) ?? hits.set(key, new Set()).get(key)!).add(path.relative(OUT_DIR, file));
      }
    }
  }
  if (hits.size === 0) {
    console.log("  それらしい文字列: なし");
    return;
  }
  console.log(`\n⚠ 対応表に無い、それらしい文字列が ${hits.size} 件あります。目で確かめてください。`);
  for (const [key, files] of [...hits].slice(0, 25)) {
    const where = [...files].slice(0, 3).join(", ");
    console.log(`  ${key}  （${where}${files.size > 3 ? ` ほか ${files.size - 3} 件` : ""}）`);
  }
  if (hits.size > 25) console.log(`  … ほか ${hits.size - 25} 件`);
}

function runTests(): void {
  const link = path.join(OUT_DIR, "node_modules");
  fs.symlinkSync(path.resolve("node_modules"), link, "dir");
  try {
    console.log("試験を走らせています…");
    const out = run("npx", ["vitest", "run"], OUT_DIR);
    const summary = out
      .split("\n")
      .filter((l) => /Test Files|Tests\s+\d/.test(l))
      .join("\n");
    console.log(summary || out.slice(-400));
  } catch (e) {
    console.error("\n✗ 洗ったツリーで試験が落ちました。置換で壊れていないか確かめてください。");
    const err = e as { stdout?: string };
    if (err.stdout) console.error(err.stdout.slice(-2000));
    process.exit(1);
  } finally {
    fs.rmSync(link, { force: true });
  }
}

function main(): void {
  const skipTest = process.argv.includes("--skip-test");
  const map = readMap();

  if (run("git", ["status", "--porcelain"]).trim() !== "") {
    die("作業ツリーに変更が残っています。コミットしてから実行してください。");
  }

  exportTree();
  for (const rel of map.exclude) {
    fs.rmSync(path.join(OUT_DIR, rel), { recursive: true, force: true });
  }
  for (const [from, to] of Object.entries(map.rename ?? {})) {
    const src = path.join(OUT_DIR, from);
    if (!fs.existsSync(src)) die(`rename の元 ${from} が見つかりません。追跡されていますか。`);
    fs.rmSync(path.join(OUT_DIR, to), { force: true });
    fs.renameSync(src, path.join(OUT_DIR, to));
  }
  const changed = replaceAll(map);
  verify(map);

  const files = walk(OUT_DIR).length;
  console.log(`\n公開ツリー: ${OUT_DIR}`);
  console.log(`  ファイル ${files} 件、置換したファイル ${changed} 件`);
  console.log(`  除外: ${map.exclude.join(", ") || "なし"}`);
  console.log(`  実物の値の残り: なし`);
  scanSuspects();

  if (!skipTest) runTests();

  const head = run("git", ["rev-parse", "--short", "HEAD"]).trim();
  console.log(`\n中身を確かめてから、次を実行してください（push は承認を取ってから）。\n`);
  console.log(`  cd ${OUT_DIR}`);
  console.log(`  git init -b main && git add -A`);
  console.log(`  git commit -m "<日本語のメッセージ>"`);
  console.log(`  git remote add origin ${map.remote}`);
  console.log(`  git push -u origin main --force\n`);
  console.log(`手元の HEAD は ${head} です。公開ツリーは履歴を持ちません（毎回 1 コミット）。`);
}

main();
