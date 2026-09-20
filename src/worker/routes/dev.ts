// 開発用の API。DEV_MOCKS=1 かつ localhost / 127.0.0.1 のときだけ使える。それ以外は 404。
import { Hono } from "hono";
import { isDevMocksEnabled } from "../deps";
import type { AppEnv } from "../env";
import { HttpError } from "../errors";
import { runNotifications } from "../notify/run";

const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  if (!isDevMocksEnabled(c.env, c.req.url)) throw new HttpError(404, "not_found", "見つかりません");
  await next();
});

// Cron と同じ処理をその場で動かす
app.post("/notifications/run", async (c) => {
  return c.json(await runNotifications(c.env, c.get("deps")));
});

export default app;
