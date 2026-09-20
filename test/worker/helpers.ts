import { env } from "cloudflare:test";
import type { Hono } from "hono";
import type { LineProfile } from "../../src/worker/auth";
import type { Deps } from "../../src/worker/deps";
import { createFakeMessagingClient } from "../../src/worker/dev/fake-messaging";
import { createFakeSheetsClient, memoryStore } from "../../src/worker/dev/fake-sheets";
import type { AppEnv } from "../../src/worker/env";
import { HttpError } from "../../src/worker/errors";
import { createApp } from "../../src/worker/index";
import type { SessionResponse } from "../../src/shared/types";

// 2026-09-15T10:00:00+09:00
const FIXED_NOW = new Date("2026-09-15T01:00:00Z");

async function testVerifyIdToken(idToken: string): Promise<LineProfile> {
  const m = idToken.match(/^tok:([^:]+):(.+)$/);
  if (!m) throw new HttpError(401, "unauthorized", "LINE の認証に失敗しました");
  return { sub: m[1], name: m[2], picture: null };
}

export function testDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    verifyIdToken: testVerifyIdToken,
    serviceAccountEmail: "sa@test.iam.gserviceaccount.com",
    now: () => FIXED_NOW,
    sheets: createFakeSheetsClient(memoryStore()),
    messaging: createFakeMessagingClient(),
    lineOaBasicId: "@test-oa",
    ...overrides,
  };
}

export function makeApp(overrides: Partial<Deps> = {}): Hono<AppEnv> {
  return createApp(() => testDeps(overrides));
}

export async function call(
  app: Hono<AppEnv>,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return app.request(path, init, env);
}

export async function login(app: Hono<AppEnv>, uid: string, name: string = uid): Promise<string> {
  const res = await call(app, "POST", "/api/session", undefined, { idToken: `tok:${uid}:${name}` });
  const body = await res.json<SessionResponse>();
  return body.token;
}
