import { describe, expect, it } from "vitest";
import { base64url, base64urlDecode, randomId, randomToken, sha256Hex } from "../../src/worker/crypto";

describe("crypto", () => {
  it("randomId は指定した長さの英数字", () => {
    const id = randomId(10);
    expect(id).toMatch(/^[0-9a-z]{10}$/);
    expect(randomId(10)).not.toBe(randomId(10));
  });

  it("randomToken は 43 文字の base64url", () => {
    const token = randomToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("sha256Hex", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("base64url と base64urlDecode は互いに逆", () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 255, 254, 253, 10, 20, 30]);
    expect(base64urlDecode(base64url(bytes))).toEqual(bytes);
  });
});
