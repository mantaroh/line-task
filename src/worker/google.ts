// Google サービスアカウントの認証（JWT 署名・アクセストークン交換・KV へのキャッシュ）。
import { base64url } from "./crypto";

export type ServiceAccountKey = { client_email: string; private_key: string };

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKEN_KV_KEY = "google:token";
const TOKEN_TTL_SECONDS = 3000; // 50 分

export function parseServiceAccountKey(json: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("GOOGLE_SA_KEY is not set or invalid");
  }
  const p = parsed as { client_email?: unknown; private_key?: unknown };
  if (typeof p.client_email !== "string" || typeof p.private_key !== "string") {
    throw new Error("GOOGLE_SA_KEY is not set or invalid");
  }
  return { client_email: p.client_email, private_key: p.private_key };
}

function pemToPkcs8(pem: string): Uint8Array {
  const b64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export async function signGoogleJwt(key: ServiceAccountKey, now: Date): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + 3600;
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp };
  const enc = new TextEncoder();
  const encHeader = base64url(enc.encode(JSON.stringify(header)));
  const encPayload = base64url(enc.encode(JSON.stringify(payload)));
  const signingInput = `${encHeader}.${encPayload}`;

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(key.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, enc.encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

export async function getAccessToken(
  key: ServiceAccountKey,
  kv: KVNamespace,
  fetchFn: typeof fetch,
  now: Date,
): Promise<string> {
  const cached = await kv.get(TOKEN_KV_KEY);
  if (cached) return cached;

  const jwt = await signGoogleJwt(key, now);
  const res = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (res.status !== 200) throw new Error(`Google token exchange failed: ${res.status}`);
  const body = (await res.json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string") throw new Error(`Google token exchange failed: ${res.status}`);

  await kv.put(TOKEN_KV_KEY, body.access_token, { expirationTtl: TOKEN_TTL_SECONDS });
  return body.access_token;
}
