// ID・トークン・ハッシュ生成のユーティリティ。Web Crypto API のみを使う。
const ID_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";
const ID_CHARS_LENGTH = ID_CHARS.length; // 36
const REJECTION_LIMIT = 256 - (256 % ID_CHARS_LENGTH); // 252

export function randomId(length: number): string {
  const chars: string[] = [];
  const buf = new Uint8Array(1);
  while (chars.length < length) {
    crypto.getRandomValues(buf);
    const b = buf[0];
    if (b < REJECTION_LIMIT) {
      chars.push(ID_CHARS[b % ID_CHARS_LENGTH]);
    }
  }
  return chars.join("");
}

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(s: string): Uint8Array {
  const base64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (base64.length % 4)) % 4;
  const binary = atob(base64 + "=".repeat(padding));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
