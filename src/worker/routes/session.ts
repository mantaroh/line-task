import { Hono } from "hono";
import { signSession, requireSession } from "../auth";
import { upsertUser } from "../db";
import type { AppEnv } from "../env";
import { badRequest } from "../errors";
import { isDevMocksEnabled } from "../deps";
import { nowIso } from "../../shared/time";
import type { ConfigResponse, SessionResponse } from "../../shared/types";

const app = new Hono<AppEnv>();

app.post("/api/session", async (c) => {
  const body = await c.req.json().catch(() => null);
  const idToken = body && typeof body === "object" ? (body as Record<string, unknown>).idToken : undefined;
  if (typeof idToken !== "string" || idToken.length === 0) {
    throw badRequest("idToken を指定してください");
  }
  const deps = c.get("deps");
  const profile = await deps.verifyIdToken(idToken);
  const now = deps.now();
  const pictureUrl = profile.picture ?? null;
  const { isNew } = await upsertUser(
    c.env.DB,
    { lineUserId: profile.sub, displayName: profile.name, pictureUrl },
    nowIso(now),
  );
  const token = await signSession({ lineUserId: profile.sub, displayName: profile.name }, c.env.SESSION_SECRET, now);
  const res: SessionResponse = {
    token,
    user: { lineUserId: profile.sub, displayName: profile.name, pictureUrl },
    isNew,
  };
  return c.json(res);
});

app.get("/api/config", requireSession, (c) => {
  const deps = c.get("deps");
  const res: ConfigResponse = {
    serviceAccountEmail: deps.serviceAccountEmail,
    appUrlBase: c.env.APP_URL_BASE,
    devMocks: isDevMocksEnabled(c.env, c.req.url),
  };
  return c.json(res);
});

export default app;
