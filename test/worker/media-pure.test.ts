import { describe, expect, it } from "vitest";
import { parseRange } from "../../src/worker/media/range";
import { signExpiry, signMediaPath, signPath, verifyMediaSignature, verifySignature } from "../../src/worker/media/sign";
import { sniffMedia } from "../../src/worker/media/sniff";

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const head = (...parts: (number[] | string)[]) => {
  const bytes = parts.flatMap((p) => (typeof p === "string" ? ascii(p) : p));
  const out = new Uint8Array(Math.max(12, bytes.length));
  out.set(bytes);
  return out;
};

describe("形式の判定", () => {
  it("ftyp は種類で決める。動画の qt は mov", () => {
    expect(sniffMedia(head([0, 0, 0, 0x20], "ftypisom"), "video")).toBe("video/mp4");
    expect(sniffMedia(head([0, 0, 0, 0x14], "ftypqt  "), "video")).toBe("video/quicktime");
    expect(sniffMedia(head([0, 0, 0, 0x20], "ftypM4A "), "audio")).toBe("audio/mp4");
  });

  it("webm は種類のまま", () => {
    expect(sniffMedia(head([0x1a, 0x45, 0xdf, 0xa3]), "video")).toBe("video/webm");
    expect(sniffMedia(head([0x1a, 0x45, 0xdf, 0xa3]), "audio")).toBe("audio/webm");
  });

  it("音声だけの形式", () => {
    expect(sniffMedia(head("RIFF", [1, 2, 3, 4], "WAVE"), "audio")).toBe("audio/wav");
    expect(sniffMedia(head("OggS"), "audio")).toBe("audio/ogg");
    expect(sniffMedia(head([0xff, 0xf1]), "audio")).toBe("audio/aac");
    expect(sniffMedia(head([0xff, 0xf9]), "audio")).toBe("audio/aac");
    expect(sniffMedia(head("ID3"), "audio")).toBe("audio/mpeg");
    expect(sniffMedia(head([0xff, 0xfb]), "audio")).toBe("audio/mpeg");
    expect(sniffMedia(head([0xff, 0xe3]), "audio")).toBe("audio/mpeg");
  });

  it("種類と合わない・知らない形式・短すぎるものは null", () => {
    expect(sniffMedia(head("OggS"), "video")).toBeNull();
    expect(sniffMedia(head("ID3"), "video")).toBeNull();
    expect(sniffMedia(head("RIFF", [1, 2, 3, 4], "AVI "), "audio")).toBeNull();
    expect(sniffMedia(head([0xff, 0xd8, 0xff]), "video")).toBeNull();
    expect(sniffMedia(head([0xff, 0x00]), "audio")).toBeNull();
    expect(sniffMedia(new Uint8Array(ascii("ftyp")), "video")).toBeNull();
  });
});

describe("Range の解釈", () => {
  it("無い・複数の範囲・bytes 以外は全体", () => {
    expect(parseRange(undefined, 100)).toEqual({ kind: "full" });
    expect(parseRange("bytes=0-1,5-9", 100)).toEqual({ kind: "full" });
    expect(parseRange("items=0-1", 100)).toEqual({ kind: "full" });
  });

  it("範囲を返す。終わりは全体の長さで切る", () => {
    expect(parseRange("bytes=0-1", 100)).toEqual({ kind: "partial", offset: 0, length: 2 });
    expect(parseRange("bytes=10-", 100)).toEqual({ kind: "partial", offset: 10, length: 90 });
    expect(parseRange("bytes=90-500", 100)).toEqual({ kind: "partial", offset: 90, length: 10 });
    expect(parseRange("bytes=-10", 100)).toEqual({ kind: "partial", offset: 90, length: 10 });
    expect(parseRange("bytes=-500", 100)).toEqual({ kind: "partial", offset: 0, length: 100 });
  });

  it("満たせない範囲は invalid", () => {
    expect(parseRange("bytes=100-", 100)).toEqual({ kind: "invalid" });
    expect(parseRange("bytes=5-1", 100)).toEqual({ kind: "invalid" });
    expect(parseRange("bytes=-0", 100)).toEqual({ kind: "invalid" });
    expect(parseRange("bytes=abc", 100)).toEqual({ kind: "invalid" });
    expect(parseRange("bytes=-", 100)).toEqual({ kind: "invalid" });
  });
});

describe("署名つき URL", () => {
  const SECRET = "test-secret-0123456789";
  const now = new Date("2026-09-15T01:20:00Z");

  it("期限は 1 時間単位にそろえ、1〜2 時間先", () => {
    const exp = signExpiry(now);
    expect(exp).toBe(Date.parse("2026-09-15T03:00:00Z") / 1000);
    expect(signExpiry(new Date("2026-09-15T01:59:59Z"))).toBe(exp);
  });

  it("発行した URL は確かめられ、どれか 1 つでも違えば通らない", async () => {
    const exp = signExpiry(now);
    const path = await signMediaPath(SECRET, { pid: "p1", id: "m1", size: "full", exp });
    const url = new URL(path, "https://x.test");
    expect(url.pathname).toBe("/api/media/m1");
    expect(url.searchParams.get("size")).toBeNull();
    const base = { pid: "p1", id: "m1", size: "full" as const, exp, sig: url.searchParams.get("sig")! };
    expect(url.searchParams.get("p")).toBe("p1");
    expect(Number(url.searchParams.get("exp"))).toBe(exp);
    expect(await verifyMediaSignature(SECRET, base, now)).toBe(true);
    expect(await verifyMediaSignature(SECRET, { ...base, pid: "p2" }, now)).toBe(false);
    expect(await verifyMediaSignature(SECRET, { ...base, id: "m2" }, now)).toBe(false);
    expect(await verifyMediaSignature(SECRET, { ...base, size: "thumb" }, now)).toBe(false);
    expect(await verifyMediaSignature(SECRET, { ...base, exp: exp + 3600 }, now)).toBe(false);
    expect(await verifyMediaSignature(SECRET, { ...base, sig: "AAAA" }, now)).toBe(false);
    expect(await verifyMediaSignature(SECRET, { ...base, sig: "!!" }, now)).toBe(false);
    expect(await verifyMediaSignature("other-secret-0123456789", base, now)).toBe(false);
    // 期限を過ぎたら通らない
    expect(await verifyMediaSignature(SECRET, base, new Date(exp * 1000))).toBe(false);
  });

  it("サムネイルは size=thumb が付く", async () => {
    const path = await signMediaPath(SECRET, { pid: "p1", id: "m1", size: "thumb", exp: signExpiry(now) });
    expect(new URL(path, "https://x.test").searchParams.get("size")).toBe("thumb");
  });
});

describe("ファイルの署名つき URL", () => {
  const SECRET = "test-secret-0123456789";
  const now = new Date("2026-09-15T01:20:00Z");

  it("/api/files に向き、動画の署名とは混ざらない", async () => {
    const exp = signExpiry(now);
    const path = await signPath(SECRET, { kind: "file", pid: "p1", id: "f1", size: "full", exp });
    const url = new URL(path, "https://x.test");
    expect(url.pathname).toBe("/api/files/f1");
    expect(url.searchParams.get("p")).toBe("p1");
    expect(url.searchParams.get("size")).toBeNull();

    const sig = url.searchParams.get("sig")!;
    const base = { kind: "file" as const, pid: "p1", id: "f1", size: "full" as const, exp, sig };
    expect(await verifySignature(SECRET, base, now)).toBe(true);
    // 同じ pid・ID でも、動画として確かめると通らない
    expect(await verifySignature(SECRET, { ...base, kind: "media" }, now)).toBe(false);
    expect(await verifyMediaSignature(SECRET, { pid: "p1", id: "f1", size: "full", exp, sig }, now)).toBe(false);
    // 動画として発行した署名も、ファイルとしては通らない
    const mediaPath = await signMediaPath(SECRET, { pid: "p1", id: "f1", size: "full", exp });
    const mediaSig = new URL(mediaPath, "https://x.test").searchParams.get("sig")!;
    expect(await verifySignature(SECRET, { ...base, sig: mediaSig }, now)).toBe(false);
  });
});
