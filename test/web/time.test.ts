import { describe, expect, it } from "vitest";
import { isValidDate, normalizeDate, nowIso, sheetDateTime, todayJst } from "../../src/shared/time";

const utc = new Date("2026-09-15T15:30:05Z"); // JST 2026-09-16 00:30:05

describe("time", () => {
  it("JST で日付が変わる", () => {
    expect(todayJst(utc)).toBe("2026-09-16");
    expect(nowIso(utc)).toBe("2026-09-16T00:30:05+09:00");
    expect(sheetDateTime(utc)).toBe("2026-09-16 00:30");
  });
  it("日付の正規化", () => {
    expect(normalizeDate("2026/9/5")).toBe("2026-09-05");
    expect(normalizeDate(" 2026-09-05 ")).toBe("2026-09-05");
    expect(normalizeDate("来週")).toBe("来週");
  });
  it("日付の妥当性", () => {
    expect(isValidDate("2026-02-29")).toBe(false);
    expect(isValidDate("2028-02-29")).toBe(true);
    expect(isValidDate("2026-9-5")).toBe(false);
  });
});
