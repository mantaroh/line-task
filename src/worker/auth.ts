// LINE の ID トークン検証と、HS256 の自前セッショントークンの発行・検証。
import type { MiddlewareHandler } from "hono";
import { base64url, base64urlDecode } from "./crypto";
import type { AppEnv } from "./env";
import { HttpError } from "./errors";

export type LineProfile = { sub: string; name: string; picture: string | null };
export type SessionUser = { lineUserId: string; displayName: string };

export async function verifyLineIdToken(idToken: string, channelId: string, fetchFn: typeof fetch): Promise<LineProfile> {
  const res = await fetchFn("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
  });
  if (res.status !== 200) throw new HttpError(401, "unauthorized", "LINE の認証に失敗しました");
  const body = (await res.json()) as { sub?: unknown; name?: unknown; picture?: unknown };
  if (typeof body.sub !== "string") throw new HttpError(401, "unauthorized", "LINE の認証に失敗しました");
  return {
    sub: body.sub,
    name: typeof body.name === "string" ? body.name : "",
    picture: typeof body.picture === "string" ? body.picture : null,
  };
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64json = (o: unknown) => base64url(enc.encode(JSON.stringify(o)));

// 空の鍵で署名できると誰でもセッションを偽造できるので、設定漏れは 500 にする
const MIN_SECRET_LENGTH = 16;

export async function hmacKey(secret: string | undefined) {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error("SESSION_SECRET is not set or too short");
  }
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signSession(user: SessionUser, secret: string, now: Date): Promise<string> {
  const head = b64json({ alg: "HS256", typ: "JWT" });
  const body = b64json({ sub: user.lineUserId, name: user.displayName, exp: Math.floor(now.getTime() / 1000) + 12 * 3600 });
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`${head}.${body}`));
  return `${head}.${body}.${base64url(new Uint8Array(sig))}`;
}

export async function verifySession(token: string, secret: string, now: Date): Promise<SessionUser | null> {
  const [head, body, sig] = token.split(".");
  if (!head || !body || !sig) return null;
  const key = await hmacKey(secret);
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", key, base64urlDecode(sig), enc.encode(`${head}.${body}`));
  } catch {
    return null;
  }
  if (!ok) return null;
  let p: { sub?: unknown; name?: unknown; exp?: unknown };
  try {
    p = JSON.parse(dec.decode(base64urlDecode(body)));
  } catch {
    return null;
  }
  if (typeof p.exp !== "number" || p.exp * 1000 <= now.getTime()) return null;
  if (typeof p.sub !== "string" || typeof p.name !== "string") return null;
  return { lineUserId: p.sub, displayName: p.name };
}

export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  const deps = c.get("deps");
  const user = token ? await verifySession(token, c.env.SESSION_SECRET, deps.now()) : null;
  if (!user) throw new HttpError(401, "unauthorized", "ログインし直してください");
  c.set("user", user);
  await next();
};
