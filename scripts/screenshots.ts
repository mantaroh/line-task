import { spawn, execSync } from "child_process";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { chromium } from "playwright-core";

const PORT = 5173;
const BASE_URL = `http://localhost:${PORT}/`;
const SCREENSHOT_DIR = path.resolve("docs/screenshots");

// ディレクトリ作成
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

function waitPort(port: number, timeout = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const req = http.get(`http://localhost:${port}/`, (res) => {
        clearInterval(interval);
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - start > timeout) {
          clearInterval(interval);
          reject(new Error(`Timeout waiting for port ${port}`));
        }
      });
    }, 200);
  });
}

// 確認のダイアログが出るかもしれない操作。出たら受け付け、出なければそのまま進む（受け付けの処理を残さない）
async function clickAcceptingDialog(page: import("playwright-core").Page, selector: string): Promise<void> {
  const accept = (dialog: import("playwright-core").Dialog) => {
    dialog.accept().catch(() => {});
  };
  page.on("dialog", accept);
  try {
    await page.click(selector);
  } finally {
    page.off("dialog", accept);
  }
}

async function main() {
  // D1データベースのマイグレーション（状態クリアのため）
  console.log("Initializing database and clearing state...");
  try {
    if (fs.existsSync(".wrangler/state")) {
      fs.rmSync(".wrangler/state", { recursive: true, force: true });
    }
    // migrations apply
    execSync("yes | pnpm db:migrate:local", { stdio: "inherit" });
  } catch (e) {
    console.error("Migration failed:", e);
  }

  // サーバーの起動
  console.log("Starting Vite dev server...");
  const devServer = spawn("pnpm", ["dev"], {
    stdio: "inherit",
    shell: true,
    detached: true,
  });

  // プロセス終了時にサーバーを落とす
  // shell 経由で起動しているので、プロセスグループごと止める（vite が残らないように）
  const killServer = () => {
    try {
      if (devServer.pid) process.kill(-devServer.pid, "SIGTERM");
    } catch {}
  };
  process.on("exit", killServer);
  process.on("SIGINT", killServer);
  process.on("SIGTERM", killServer);

  try {
    await waitPort(PORT, 15000);
    console.log("Vite dev server is ready.");

    console.log("Launching browser...");
    const browser = await chromium.launch({
      channel: "chrome",
      executablePath: "/usr/bin/google-chrome",
      headless: true,
    });

    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
    });

    const page = await context.newPage();

    // 01: 初回のお知らせ
    console.log("01: First notification...");
    await page.addInitScript(() => {
      localStorage.setItem("ltb-dev-user", "dev-alice");
      sessionStorage.removeItem("ltb-session");
    });
    await page.goto(BASE_URL);
    await page.waitForSelector(".notice");
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "01-初回のお知らせ.png") });

    // 02: ホーム（空）
    console.log("02: Home empty...");
    await page.click('button:has-text("閉じる")');
    await page.waitForSelector('button:has-text("新しいプロジェクト")');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "02-ホーム（空）.png") });

    // 03: 新規作成 1 段目
    console.log("03: New project screen...");
    await page.click('button:has-text("新しいプロジェクト")');
    await page.waitForSelector("#project-name");
    await page.fill("#project-name", "A社 部門");
    await page.fill('input[aria-label="関係者 1"]', "A社");
    await page.fill('input[aria-label="関係者 2"]', "自社");
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "03-新規作成1段目.png") });

    // 04: シートの用意
    console.log("04: Sheet Setup screen...");
    await page.click('button[type="submit"]:has-text("作成")');
    await page.waitForSelector('input[aria-label="スプレッドシートの URL"]');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "04-シートの用意.png") });

    // 05: シートの共有エラー
    console.log("05: Sheet setup error...");
    await page.fill('input[aria-label="スプレッドシートの URL"]', "https://docs.google.com/spreadsheets/d/dev-noaccess/edit");
    await page.click('button[type="submit"]:has-text("つなぐ")');
    await page.waitForSelector(".error");
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "05-シートの共有エラー.png") });

    // 06: 一覧 (dev-sheet-demoをつなぎ、3+1件のタスクを登録して「未完了」タブ表示)
    console.log("06: Connecting sheet and adding tasks...");
    await page.fill('input[aria-label="スプレッドシートの URL"]', "https://docs.google.com/spreadsheets/d/dev-sheet-demo/edit");
    await page.click('button[type="submit"]:has-text("つなぐ")');
    await page.waitForSelector('button[aria-label="タスクの追加"]'); // 一覧画面への遷移待ち

    // タスクを4つ追加する
    const tasks = [
      { title: "外部サービスの連携用アカウント", ball: "A社", assignee: "担当B", due: "2026-09-19", status: "対応中" },
      { title: "手順書の整備", ball: "A社", assignee: "", due: "", status: "未着手" },
      { title: "redirect_uri を回答", ball: "自社", assignee: "自社", due: "2026-09-15", status: "対応中" },
      { title: "完了済みのデモタスク", ball: "A社", assignee: "", due: "", status: "完了" },
    ];

    // プロジェクトIDの取得
    const urlObj = new URL(page.url());
    const projectId = urlObj.searchParams.get("p")!;

    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      await page.click('button[aria-label="タスクの追加"]');
      await page.waitForSelector("#task-title");
      await page.fill("#task-title", t.title);
      await page.click(`button:has-text("${t.ball}")`);
      if (t.assignee) {
        await page.fill("#task-assignee", t.assignee);
      }
      if (t.due) {
        await page.fill("#task-due", t.due);
      }
      await page.click('button[type="submit"]:has-text("追加")');
      await page.waitForSelector('button[aria-label="タスクの追加"]');

      // もし status が 未着手 以外なら詳細画面に入って変更する
      if (t.status !== "未着手") {
        await page.click(`text=${t.title}`);
        await page.waitForSelector('button:has-text("保存")');
        await page.click(`button:has-text("${t.status}")`);
        // 戻る
        await page.click('button[aria-label="戻る"]');
        await page.waitForSelector('button[aria-label="タスクの追加"]');
      }
    }

    // 「未完了」タブであることを確認
    await page.click('button[role="tab"]:has-text("未完了")');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "06-一覧.png") });

    // 07: 期限切れタブ
    console.log("07: Overdue tab...");
    await page.click('button[role="tab"]:has-text("期限切れ")');
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "07-期限切れタブ.png") });

    // 08: タスクの詳細 (redirect_uri を回答)
    console.log("08: Task detail...");
    await page.click('button[role="tab"]:has-text("未完了")');
    await page.click("text=redirect_uri を回答");
    await page.waitForSelector('button:has-text("保存")');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "08-タスクの詳細.png") });

    // 23: リンクをコピーして、件名と URL が入っているか確かめる
    console.log("23: Copy task link...");
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE_URL });
    await page.click('button:has-text("リンクをコピー")');
    await page.waitForSelector('button:has-text("コピーした")');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    if (!/^【T-\d+】redirect_uri を回答\n.+[?&]t=T-\d+$/.test(copied)) throw new Error(`コピーした内容が違う: ${copied}`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "23-リンクをコピー.png") });

    // 28・29: メモを編集ボタンで書き、リンクを外部（開発では新しいタブ）で開く
    console.log("28: Memo editor...");
    await page.click('.memo-field button:has-text("編集")');
    await page.fill("#task-memo", "先方の回答待ち。来週まで\n資料: 設定手順\nhttps://example.com/faq");
    // 「来週まで」を選んで太字にする
    await page.evaluate(() => {
      const el = document.querySelector<HTMLTextAreaElement>("#task-memo")!;
      const start = el.value.indexOf("来週まで");
      el.setSelectionRange(start, start + "来週まで".length);
    });
    await page.click('.memo-toolbar button[aria-label="太字"]');
    // 2・3 行目を箇条書きにする
    await page.evaluate(() => {
      const el = document.querySelector<HTMLTextAreaElement>("#task-memo")!;
      el.setSelectionRange(el.value.indexOf("資料"), el.value.length);
    });
    await page.click('.memo-toolbar button[aria-label="箇条書き"]');
    // 「設定手順」にリンクを付ける
    await page.evaluate(() => {
      const el = document.querySelector<HTMLTextAreaElement>("#task-memo")!;
      const start = el.value.indexOf("設定手順");
      el.setSelectionRange(start, start + "設定手順".length);
    });
    await page.click('.memo-toolbar button[aria-label="リンク"]');
    await page.fill('input[aria-label="リンクの URL"]', "https://example.com/setup");
    await page.click('.memo-link-form button:has-text("追加")');
    const memo = await page.inputValue("#task-memo");
    const expectedMemo = "先方の回答待ち。**来週まで**\n- 資料: [設定手順](https://example.com/setup)\n- https://example.com/faq";
    if (memo !== expectedMemo) throw new Error(`メモの書式が違う: ${JSON.stringify(memo)}`);
    await page.locator(".memo-field").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "28-メモの編集.png") });

    console.log("29: Memo view...");
    await page.click('.memo-field button:has-text("完了")');
    const memoSaved = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().includes("/tasks/"));
    await page.click('button[type="submit"]:has-text("保存")');
    if ((await memoSaved).status() !== 200) throw new Error("メモを保存できなかった");
    await page.waitForSelector('.memo-view a:has-text("設定手順")');
    await page.locator(".memo-field").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "29-メモの表示.png") });
    const [popup] = await Promise.all([
      page.context().waitForEvent("page"),
      page.click('.memo-view a:has-text("設定手順")'),
    ]);
    if (!popup.url().startsWith("https://example.com/setup")) throw new Error(`開いた URL が違う: ${popup.url()}`);
    await popup.close();
    if (!page.url().startsWith(BASE_URL)) throw new Error("アプリの画面が移動した");
    await page.evaluate(() => window.scrollTo(0, 0));

    // 09: 競合 (Bobが先に裏で更新した状態でAliceが保存して競合を発生させる)
    console.log("09: Simulating conflict...");
    // Alice側で件名編集
    await page.fill("#task-title", "redirect_uri を回答 (Aliceが編集中)");

    // Aliceの別ブラウザを立ち上げて同じタスクを更新する
    const contextAlice2 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const pageAlice2 = await contextAlice2.newPage();
    await pageAlice2.addInitScript(() => {
      localStorage.setItem("ltb-dev-user", "dev-alice");
      sessionStorage.removeItem("ltb-session");
    });
    await pageAlice2.goto(`${BASE_URL}?p=${projectId}`);
    await pageAlice2.waitForSelector(".task-row");
    await pageAlice2.click("text=redirect_uri を回答");
    await pageAlice2.waitForSelector('button:has-text("保存")');
    await pageAlice2.fill("#task-title", "redirect_uri を回答 (他端末による変更)");
    await pageAlice2.click('button[type="submit"]:has-text("保存")');
    await pageAlice2.waitForTimeout(1000);
    await pageAlice2.close();
    await contextAlice2.close();

    // Aliceの画面で「保存」ボタンをクリック
    await page.click('button[type="submit"]:has-text("保存")');
    await page.waitForSelector('.error:has-text("ほかの人が変更しました")');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "09-競合.png") });

    // 戻って詳細を開き直す（リセットのため）。未保存の確認は「戻る」を選ぶ
    await clickAcceptingDialog(page, 'button[aria-label="戻る"]');
    await page.waitForSelector('button[aria-label="タスクの追加"]');

    // 10: タスクの追加
    console.log("10: Add task screen...");
    await page.click('button[aria-label="タスクの追加"]');
    await page.waitForSelector("#task-title");
    await page.fill("#task-title", "追加のテストタスク");
    await page.click('button:has-text("A社")');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "10-タスクの追加.png") });

    // キャンセルして戻る。未保存の確認は「戻る」を選ぶ
    await clickAcceptingDialog(page, 'button[aria-label="戻る"]');
    await page.waitForSelector('button[aria-label="タスクの追加"]');

    // 11: 設定
    console.log("11: Settings screen...");
    await page.click('button[aria-label="設定"]');
    await page.waitForSelector('button:has-text("発行")');
    // 通知の「自分の側」をA社にしてから撮る
    const partySaved = page.waitForResponse(
      (r) => r.url().endsWith(`/api/projects/${projectId}/me`) && r.request().method() === "PATCH",
    );
    await page.selectOption("#notify-party", "A社");
    await partySaved;
    await page.waitForSelector("#notify-party:enabled");
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "11-設定.png") });

    // 22: 自分の側（A社）が一覧の先頭に来る。撮ったら設定に戻る
    console.log("22: Own party first...");
    await page.click('button[aria-label="戻る"]');
    await page.waitForSelector(".ball-heading");
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "22-自分の番が先頭.png") });
    await page.click('button[aria-label="設定"]');
    await page.waitForSelector('button:has-text("発行")');

    // 12: 招待の発行直後
    console.log("12: Invite issued...");
    // 招待の発行ボタンをクリック
    await page.click('.settings-section:has-text("招待") button:has-text("発行")');
    await page.waitForSelector('input[aria-label="招待 URL"]');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "12-招待の発行直後.png") });

    const inviteUrl = await page.inputValue('input[aria-label="招待 URL"]');

    // 13: 招待（Bob）
    console.log("13: Bob accepting invite...");
    const contextBob2 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const pageBob2 = await contextBob2.newPage();
    await pageBob2.addInitScript(() => {
      localStorage.setItem("ltb-dev-user", "dev-bob");
      sessionStorage.removeItem("ltb-session");
    });
    await pageBob2.goto(inviteUrl);
    await pageBob2.waitForSelector('button:has-text("参加する")');
    await pageBob2.screenshot({ path: path.join(SCREENSHOT_DIR, "13-招待（Bob）.png") });
    await pageBob2.click('button:has-text("参加する")');
    await pageBob2.waitForSelector('button[aria-label="タスクの追加"]'); // 参加完了
    await pageBob2.close();
    await contextBob2.close();

    // 14: 招待（取り消し済み）
    console.log("14: Revoked invite (Carol)...");
    // Alice側で招待を取り消す
    await page.click('.invite-list button:has-text("取り消す")');
    await page.waitForTimeout(500); // 反映待ち

    // Carolで同じ招待リンクを開く
    const contextCarol = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const pageCarol = await contextCarol.newPage();
    await pageCarol.addInitScript(() => {
      localStorage.setItem("ltb-dev-user", "dev-carol");
      sessionStorage.removeItem("ltb-session");
    });
    await pageCarol.goto(inviteUrl);
    await pageCarol.waitForSelector('text=取り消されています');
    await pageCarol.screenshot({ path: path.join(SCREENSHOT_DIR, "14-招待（取り消し済み）.png") });
    await pageCarol.close();
    await contextCarol.close();

    // 15: メンバーと活動記録
    console.log("15: Members and activity list...");
    // Aliceの設定画面に戻り、リロード（あるいは戻って開き直す）してBobが追加されたことを確認
    await page.click('button[aria-label="戻る"]');
    await page.waitForSelector('button[aria-label="タスクの追加"]');
    await page.click('button[aria-label="設定"]');
    await page.waitForSelector('.activity-section');
    await page.locator('.activity-section').scrollIntoViewIfNeeded();
    await page.waitForTimeout(500); // スクロール安定待ち
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "15-メンバーと活動記録.png") });

    // 16: アーカイブ済みの一覧
    console.log("16: Archived project in list...");
    // ダイアログをオートアセプトする設定
    page.once("dialog", async (dialog) => {
      await dialog.accept();
    });
    await page.click('button:has-text("アーカイブする")');
    await page.waitForSelector('button:has-text("戻す")'); // アーカイブ完了
    // 戻ってホームへ
    await page.click('button[aria-label="戻る"]'); // 設定からプロジェクト画面
    await page.waitForSelector('button[aria-label="設定"]');
    await page.click('button[aria-label="戻る"]'); // プロジェクト画面からホーム
    await page.waitForSelector('button:has-text("新しいプロジェクト")');

    // アコーディオンを開く
    await page.evaluate(() => {
      document.querySelector("details.archived")?.setAttribute("open", "true");
    });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "16-アーカイブ済みの一覧.png") });

    // 17: ホーム（プロジェクトあり）。シート未接続のプロジェクトを足し、戻すと 2 件並ぶ
    console.log("17: Home with projects...");
    await page.click('button:has-text("新しいプロジェクト")');
    await page.waitForSelector("#project-name");
    await page.fill("#project-name", "社内の宿題");
    await page.fill('input[aria-label="関係者 1"]', "社内");
    await page.fill('input[aria-label="関係者 2"]', "自社");
    await page.click('button[type="submit"]:has-text("作成")');
    await page.click('button:has-text("あとでつなぐ")');
    await page.waitForSelector('button[aria-label="戻る"]');
    await page.click('button[aria-label="戻る"]');
    await page.waitForSelector(".project-card");
    await page.evaluate(() => {
      document.querySelector("details.archived")?.setAttribute("open", "true");
    });
    await page.click(".project-card:has-text('A社 部門')");
    await page.click('button[aria-label="設定"]');
    page.once("dialog", async (dialog) => {
      await dialog.accept();
    });
    await page.click('button:has-text("戻す")');
    await page.waitForSelector('button:has-text("アーカイブする")');
    await page.click('button[aria-label="戻る"]');
    await page.waitForSelector('button[aria-label="設定"]');
    await page.click('button[aria-label="戻る"]');
    await page.waitForSelector(".project-card");
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "17-ホーム（プロジェクトあり）.png") });

    // 18: 通知の設定。開発用の偽物は全員友だちなので、友だちでない状態に差し替えて注意書きを出す
    console.log("18: Notification settings...");
    await page.route("**/api/me/line-friend", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ friend: false, addFriendUrl: "https://line.me/R/ti/p/@dev-oa" }),
      }),
    );
    await page.click(".project-card:has-text('A社 部門')");
    await page.click('button[aria-label="設定"]');
    await page.waitForSelector("#notify-party");
    await page.reload();
    await page.waitForSelector(".notify-section .warning-box");
    await page.waitForSelector("#notify-party");
    await page.locator(".notify-section").screenshot({ path: path.join(SCREENSHOT_DIR, "18-通知の設定.png") });
    await page.unroute("**/api/me/line-friend");

    // 19 は予約済み（別の画面で使う）

    // 20: タスクの画像。A社 部門 は 17 で戻してあるので追加できる
    console.log("20: Task images...");
    const imageA = await page.screenshot();
    await page.click('button[aria-label="戻る"]');
    await page.waitForSelector(".task-row");
    const imageB = await page.screenshot();
    await page.click("text=外部サービスの連携用アカウント");
    await page.waitForSelector(".images-section");
    await page.setInputFiles('.images-section input[type="file"]', [
      { name: "settings.png", mimeType: "image/png", buffer: imageA },
      { name: "list.png", mimeType: "image/png", buffer: imageB },
    ]);
    await page.waitForFunction(() => document.querySelector(".images-section h2")?.textContent === "画像（2）");
    await page.waitForFunction(() => document.querySelectorAll(".image-thumb img").length === 2);
    await page.waitForFunction(() =>
      [...document.querySelectorAll<HTMLImageElement>(".image-thumb img")].every((img) => img.complete),
    );
    await page.evaluate(() => {
      document.querySelector(".images-section")?.scrollIntoView({ block: "center" });
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "20-タスクの画像.png") });

    // 21: 画像の拡大表示
    console.log("21: Image viewer...");
    await page.click(".image-thumb >> nth=0");
    await page.waitForSelector('[role="dialog"] img');
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('[role="dialog"] img');
      return !!img && img.complete && img.naturalWidth > 0;
    });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "21-画像の拡大表示.png") });
    await page.click('[role="dialog"] button:has-text("閉じる")');

    // 24: 動画と音声を付ける（ffmpeg で数秒のファイルを作る）
    console.log("24: Task media...");
    const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), "ltb-media-"));
    const videoPath = path.join(mediaDir, "clip.mp4");
    const audioPath = path.join(mediaDir, "memo.m4a");
    execSync(
      `ffmpeg -loglevel error -y -f lavfi -i testsrc=size=640x360:rate=30 -f lavfi -i sine=frequency=440 -t 3 -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart "${videoPath}"`,
    );
    execSync(`ffmpeg -loglevel error -y -f lavfi -i sine=frequency=660 -t 5 -c:a aac "${audioPath}"`);
    await page.setInputFiles('.media-section input[type="file"]', [videoPath, audioPath]);
    await page.waitForSelector(".media-section .media-thumb >> nth=1");
    // サムネイルが付いた一覧に取り直されるのを待つ
    await page.waitForSelector(".media-section .media-thumb img");
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>(".media-section .media-thumb img");
      return !!img && img.complete && img.naturalWidth > 0;
    });
    await page.locator(".media-section").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "24-動画と音声.png") });

    // 25: 押すとすぐ再生する（Range で読みながら）
    console.log("25: Media player...");
    await page.click(".media-section .media-thumb >> nth=0");
    await page.waitForFunction(() => {
      const v = document.querySelector<HTMLVideoElement>('[role="dialog"] video');
      return !!v && v.readyState >= 2 && v.currentTime > 0.3;
    });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "25-動画の再生.png") });
    await page.click('[role="dialog"] button:has-text("閉じる")');
    await page.click(".media-section .media-thumb >> nth=1");
    await page.waitForFunction(() => {
      const a = document.querySelector<HTMLAudioElement>('[role="dialog"] audio');
      return !!a && a.readyState >= 2;
    });
    await page.click('[role="dialog"] button:has-text("閉じる")');
    fs.rmSync(mediaDir, { recursive: true, force: true });

    // 30: ファイルを付ける（26〜29 は PC 版の画面・メモの画面ですでに使っているので 30 から）
    console.log("30: Task files...");
    const pdfBuffer = Buffer.from("%PDF-1.7\n% 動作確認用のダミー\n", "utf8");
    await page.setInputFiles('.files-section input[type="file"]', [
      { name: "見積書.pdf", mimeType: "application/pdf", buffer: pdfBuffer },
      { name: "一覧.csv", mimeType: "text/csv", buffer: Buffer.from("id,name\n1,A社\n", "utf8") },
    ]);
    await page.waitForFunction(() => document.querySelector(".files-section h2")?.textContent === "ファイル（2/5）");
    await page.evaluate(() => {
      document.querySelector(".files-section")?.scrollIntoView({ block: "center" });
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "30-タスクのファイル.png") });

    // 26・27: PC の幅。詳細（左に入力欄、右に添付と履歴）と一覧（ボールごとの列）
    console.log("26: PC layout...");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForSelector(".task-detail-bottom .media-thumb img");
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "26-PCのタスク詳細.png") });
    await clickAcceptingDialog(page, 'button[aria-label="戻る"]');
    await page.waitForSelector(".ball-groups");
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "27-PCの一覧.png") });
    await page.setViewportSize({ width: 390, height: 844 });

    console.log("All screenshots captured successfully.");
    await browser.close();
  } catch (err) {
    console.error("Screenshot capture failed:", err);
    process.exitCode = 1;
  } finally {
    killServer();
    // サーバープロセスのキルを確実にする
    try {
      if (devServer.pid) process.kill(-devServer.pid, "SIGKILL");
    } catch {}
  }
}

main().finally(() => process.exit());
