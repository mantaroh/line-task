// LIFF の ID トークンの期限判定。liff.getIDToken() は起動時のトークンを返し続けるので、
// 期限が切れていたらログインし直す（liff.ts）。
const MARGIN_MS = 60_000;

export function isIdTokenFresh(exp: number | undefined, nowMs: number): boolean {
  return typeof exp === "number" && exp * 1000 > nowMs + MARGIN_MS;
}

// ログインし直しが短時間に繰り返される（再読込しても古いトークンのまま）のを防ぐ
export function shouldRetryRelogin(lastAt: string | null, nowMs: number): boolean {
  return lastAt === null || nowMs - Number(lastAt) > MARGIN_MS;
}
