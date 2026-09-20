// 動画・音声とファイルを、セッション無しの URL で直接読むための署名。鍵はセッションと同じ SESSION_SECRET を使い、
// 署名する文字列の先頭を種類で固定して、種類どうし・セッションの署名と混ざらないようにする。
import { hmacKey } from "../auth";
import { base64url, base64urlDecode } from "../crypto";

export type SignKind = "media" | "file";
export type MediaSize = "full" | "thumb";
export type SignInput = { kind: SignKind; pid: string; id: string; size: MediaSize; exp: number };
export type MediaSignInput = Omit<SignInput, "kind">;

const enc = new TextEncoder();
const HOUR = 3600;
const BASE_PATH: Record<SignKind, string> = { media: "/api/media", file: "/api/files" };

// 1 時間単位にそろえて、同じ時間帯は同じ URL にする（ブラウザのキャッシュを効かせる）。有効なのは 1〜2 時間
export function signExpiry(now: Date): number {
  return (Math.floor(now.getTime() / 1000 / HOUR) + 2) * HOUR;
}

function payload(i: SignInput): Uint8Array {
  return enc.encode(`${i.kind}:v1:${i.pid}:${i.id}:${i.size}:${i.exp}`);
}

export async function signPath(secret: string, i: SignInput): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), payload(i));
  const q = new URLSearchParams({ p: i.pid, exp: String(i.exp) });
  if (i.size === "thumb") q.set("size", "thumb");
  q.set("sig", base64url(new Uint8Array(sig)));
  return `${BASE_PATH[i.kind]}/${encodeURIComponent(i.id)}?${q}`;
}

export async function verifySignature(secret: string, i: SignInput & { sig: string }, now: Date): Promise<boolean> {
  if (i.exp * 1000 <= now.getTime()) return false;
  let sig: Uint8Array;
  try {
    sig = base64urlDecode(i.sig);
  } catch {
    return false;
  }
  try {
    return await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, payload(i));
  } catch {
    return false;
  }
}

export function signMediaPath(secret: string, i: MediaSignInput): Promise<string> {
  return signPath(secret, { kind: "media", ...i });
}

export function verifyMediaSignature(
  secret: string,
  i: MediaSignInput & { sig: string },
  now: Date,
): Promise<boolean> {
  return verifySignature(secret, { kind: "media", ...i }, now);
}
