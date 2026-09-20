# line-task-board

LINE から開くタスク管理ツールです。タスクの実体は Google スプレッドシートに置き、LIFF アプリから読み書きします。

小さなチームで「誰にボールがあるか」を見失わないことを目的に作りました。シートをそのまま使うので、アプリを入れていない人も表を見れば状況が分かります。

## できること

- タスクの一覧と編集（件名・ボール・担当・状態・期限・発生元・次にやること・メモ）
- ボールごとの並び替え。自分の側が先頭に来る
- 招待リンクでのプロジェクト参加
- 期限の通知（前日・当日・3 日後）を LINE の個別プッシュで送る
- タスクへの画像・動画・音声・ファイルの添付
- 同時編集の競合検出

## 構成

| 層 | 使っているもの |
| --- | --- |
| 画面 | React 19 + Vite、LIFF SDK |
| サーバー | Cloudflare Workers + Hono |
| 保存先 | Google スプレッドシート（タスク本体）、D1（メンバー・通知・添付の情報）、R2（添付の中身）、KV（シートのキャッシュ） |
| 認証 | LINE Login の ID トークンを検証してセッションを発行 |
| 試験 | Vitest + @cloudflare/vitest-pool-workers（miniflare 上で実際に D1 と R2 を使う） |

タスクの本体をスプレッドシートに置いているのが一番の特徴です。DB に閉じ込めると、アプリを使わない人が状況を見られなくなるためです。

## 動かす

```bash
pnpm install
cp .dev.vars.example .dev.vars   # 開発用の値を入れる
pnpm dev
```

開発時は LIFF と Google Sheets と LINE Messaging API の偽物が動くので、外部サービスの登録なしで一通り触れます（`DEV_MOCKS=1`）。

```bash
pnpm test        # 試験（worker と画面）
pnpm typecheck   # 型
pnpm build       # 本番ビルド
```

## 自分の環境で動かす場合

`wrangler.jsonc` と `.env.production` の ID は、すべて伏せ字（`00000000...`、`1234567890-abcdefgh` など）に置き換えてあります。そのままでは本番にはデプロイできません。

動かすには、次を自分のものに差し替えてください。

| 場所 | 値 |
| --- | --- |
| `wrangler.jsonc` | Cloudflare のアカウント ID、D1 のデータベース ID、KV の名前空間 ID、R2 のバケット名、ルートのドメイン |
| `wrangler.jsonc` の `vars` | LINE Login のチャネル ID、LIFF の URL、公式アカウントの ID |
| `.env.production` | LIFF ID |

秘密の値（`SESSION_SECRET`・`GOOGLE_SA_KEY`・`LINE_MESSAGING_TOKEN`）は Worker の secret に入れます。リポジトリには含めません。

```bash
pnpm wrangler d1 migrations apply DB --remote
pnpm wrangler deploy
```

移行を当ててからデプロイしてください。逆にすると、テーブルが無い状態で一覧の API が呼ばれて 500 になります。

## ディレクトリ

```
src/worker/   Workers 側。routes/ が API、sheets/ がスプレッドシート、notify/ が通知
src/web/      画面側。screens/ が画面、components/ が部品
src/shared/   両方から使う型と関数
migrations/   D1 のスキーマ
test/         試験。worker/ は miniflare 上、web/ は node 上で動く
scripts/      スクリーンショット撮影と利用状況の集計
```
