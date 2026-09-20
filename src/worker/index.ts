import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { nowIso } from "../shared/time";
import { createDeps, type Deps } from "./deps";
import type { AppEnv } from "./env";
import { HttpError } from "./errors";
import { runNotifications } from "./notify/run";
import activityRoutes from "./routes/activity";
import filesRoutes, { fileRoutes } from "./routes/files";
import imagesRoutes from "./routes/images";
import devRoutes from "./routes/dev";
import invitesRoutes, { inviteTokenRoutes } from "./routes/invites";
import mediaRoutes, { mediaFileRoutes } from "./routes/media";
import meProjectRoutes, { meRoutes } from "./routes/me";
import membersRoutes from "./routes/members";
import projectsRoutes from "./routes/projects";
import sessionRoutes from "./routes/session";
import tasksRoutes from "./routes/tasks";
import usageRoutes from "./routes/usage";
import { pruneAccessLog } from "./usage/store";

export function createApp(makeDeps?: (env: Env, url: string) => Deps) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("deps", (makeDeps ?? createDeps)(c.env, c.req.url));
    await next();
  });
  app.route("/", sessionRoutes);
  app.route("/api/projects", projectsRoutes);
  app.route("/api/projects", tasksRoutes);
  app.route("/api/projects", imagesRoutes);
  app.route("/api/projects", mediaRoutes);
  app.route("/api/projects", filesRoutes);
  app.route("/api/projects", invitesRoutes);
  app.route("/api/projects", membersRoutes);
  app.route("/api/projects", activityRoutes);
  app.route("/api/projects", meProjectRoutes);
  app.route("/api/me", meRoutes);
  app.route("/api/invites", inviteTokenRoutes);
  app.route("/api/usage", usageRoutes);
  app.route("/api/media", mediaFileRoutes);
  app.route("/api/files", fileRoutes);
  app.route("/api/dev", devRoutes);
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.code, message: err.message, ...err.body }, err.status as ContentfulStatusCode);
    }
    console.error(err);
    return c.json({ error: "internal", message: "エラーが発生しました" }, 500);
  });
  app.all("/api/*", () => {
    throw new HttpError(404, "not_found", "見つかりません");
  });
  return app;
}

const app = createApp();

export default {
  fetch: app.fetch,
  // Cron（毎日 9:00 JST）。ホストの無い実行なので、偽物が選ばれない URL で依存を作る。
  scheduled(_controller, env, ctx) {
    const deps = createDeps(env, "https://scheduled.invalid/");
    ctx.waitUntil(
      Promise.all([
        runNotifications(env, deps),
        pruneAccessLog(env.DB, nowIso(new Date(Date.now() - 30 * 86400000))).catch(() =>
          console.warn("[usage] prune failed"),
        ),
      ]),
    );
  },
} satisfies ExportedHandler<Env>;
