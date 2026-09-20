import { describe, expect, it } from "vitest";
import { fitWithin } from "../../src/web/images/resize";

describe("fitWithin", () => {
  it.each([
    [1200, 800, 1600, { width: 1200, height: 800 }],
    [4000, 3000, 1600, { width: 1600, height: 1200 }],
    [3000, 4000, 1600, { width: 1200, height: 1600 }],
    [4000, 3000, 320, { width: 320, height: 240 }],
    [5000, 1, 320, { width: 320, height: 1 }],
  ])("fitWithin(%i, %i, %i)", (w, h, max, expected) => {
    expect(fitWithin(w, h, max)).toEqual(expected);
  });
});
