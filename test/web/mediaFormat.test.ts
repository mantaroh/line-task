import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration, MAX_MEDIA_BYTES, mediaKindOf, mediaSizeMessage } from "../../src/web/media/format";

describe("mediaKindOf", () => {
  it("MIME の先頭で決める", () => {
    expect(mediaKindOf({ type: "video/quicktime", name: "a.mov" })).toBe("video");
    expect(mediaKindOf({ type: "audio/x-m4a", name: "a.m4a" })).toBe("audio");
  });
  it("MIME が空・不明なら拡張子で決める", () => {
    expect(mediaKindOf({ type: "", name: "録音.M4A" })).toBe("audio");
    expect(mediaKindOf({ type: "application/octet-stream", name: "clip.mp4" })).toBe("video");
    for (const n of ["a.mp3", "a.wav", "a.ogg", "a.aac", "a.opus"]) expect(mediaKindOf({ type: "", name: n })).toBe("audio");
    for (const n of ["a.mov", "a.webm", "a.m4v"]) expect(mediaKindOf({ type: "", name: n })).toBe("video");
  });
  it("それ以外は null", () => {
    expect(mediaKindOf({ type: "image/jpeg", name: "a.jpg" })).toBeNull();
    expect(mediaKindOf({ type: "", name: "noext" })).toBeNull();
  });
});

describe("formatDuration", () => {
  it("分:秒、1 時間以上は時:分:秒", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(83_400)).toBe("1:23");
    expect(formatDuration(59_999)).toBe("0:59");
    expect(formatDuration(3_723_000)).toBe("1:02:03");
  });
  it("分からなければ空", () => {
    expect(formatDuration(null)).toBe("");
  });
});

describe("大きさ", () => {
  it("MB で出す", () => {
    expect(formatBytes(45 * 1024 * 1024)).toBe("45MB");
    expect(formatBytes(30.4 * 1024 * 1024)).toBe("30.4MB");
  });
  it("30MB を超えたら文言、以下なら null", () => {
    expect(mediaSizeMessage(MAX_MEDIA_BYTES)).toBeNull();
    expect(mediaSizeMessage(45 * 1024 * 1024)).toBe("30MB までです（このファイルは 45MB）");
  });
});
