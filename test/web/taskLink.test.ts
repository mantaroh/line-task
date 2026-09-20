import { describe, expect, it } from "vitest";
import { taskLinkText } from "../../src/web/taskLink";

const APP = "https://liff.line.me/1234567890-abcdefgh?p=abc";

describe("taskLinkText", () => {
  it("件名と、タスクを開く URL を 2 行にする", () => {
    expect(taskLinkText(APP, "T-012", "redirect_uri を回答")).toBe(
      "【T-012】redirect_uri を回答\nhttps://liff.line.me/1234567890-abcdefgh?p=abc&t=T-012",
    );
  });

  it("件名の改行や前後の空白は 1 行にまとめる", () => {
    expect(taskLinkText(APP, "T-1", "  見積\n  の確認 ")).toBe(`【T-1】見積 の確認\n${APP}&t=T-1`);
  });

  it("件名が空なら URL だけ", () => {
    expect(taskLinkText(APP, "T-1", "  ")).toBe(`${APP}&t=T-1`);
  });

  it("URL に ? が無ければ ? でつなぎ、ID はエンコードする", () => {
    expect(taskLinkText("https://example.com/", "T 1&x", "件名")).toBe("【T 1&x】件名\nhttps://example.com/?t=T%201%26x");
  });
});
