import { describe, expect, it } from "vitest";
import { isIdTokenFresh, shouldRetryRelogin } from "../../src/web/idToken";

const now = Date.UTC(2026, 8, 16, 12, 0, 0);

describe("isIdTokenFresh", () => {
  it("有効期限まで 60 秒以上あれば使える", () => {
    expect(isIdTokenFresh(now / 1000 + 61, now)).toBe(true);
  });
  it("60 秒以内に切れる・切れているなら使わない", () => {
    expect(isIdTokenFresh(now / 1000 + 60, now)).toBe(false);
    expect(isIdTokenFresh(now / 1000 - 1, now)).toBe(false);
  });
  it("exp が読めなければ使わない", () => {
    expect(isIdTokenFresh(undefined, now)).toBe(false);
  });
});

describe("shouldRetryRelogin", () => {
  it("前回のログインし直しから 60 秒以内なら繰り返さない", () => {
    expect(shouldRetryRelogin(null, now)).toBe(true);
    expect(shouldRetryRelogin(String(now - 61_000), now)).toBe(true);
    expect(shouldRetryRelogin(String(now - 10_000), now)).toBe(false);
  });
});
