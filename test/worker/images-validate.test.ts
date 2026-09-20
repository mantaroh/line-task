import { describe, expect, it } from "vitest";
import { isJpeg, MAX_IMAGE_BYTES, MAX_THUMB_BYTES, parseUpload } from "../../src/worker/images/validate";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const file = (bytes: Uint8Array, type = "image/jpeg") => new File([bytes], "a.jpg", { type });
function form(parts: Record<string, string | File>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(parts)) f.append(k, v);
  return f;
}

describe("画像の入力の確認", () => {
  it("JPEG の判定", () => {
    expect(isJpeg(JPEG)).toBe(true);
    expect(isJpeg(PNG)).toBe(false);
    expect(isJpeg(new Uint8Array([0xff, 0xd8]))).toBe(false);
  });

  it("正しい入力を読む", async () => {
    const r = await parseUpload(form({ image: file(JPEG), thumb: file(JPEG), width: "1200", height: "900" }));
    expect(r.width).toBe(1200);
    expect(r.height).toBe(900);
    expect(new Uint8Array(r.image)).toEqual(JPEG);
    expect(new Uint8Array(r.thumb)).toEqual(JPEG);
  });

  it("上限ちょうどは通る", async () => {
    const max = new Uint8Array(MAX_IMAGE_BYTES);
    max.set(JPEG);
    const maxThumb = new Uint8Array(MAX_THUMB_BYTES);
    maxThumb.set(JPEG);
    const r = await parseUpload(form({ image: file(max), thumb: file(maxThumb), width: "1600", height: "1" }));
    expect(r.image.byteLength).toBe(MAX_IMAGE_BYTES);
    expect(r.width).toBe(1600);
  });

  it.each([
    [{ thumb: file(JPEG), width: "1", height: "1" }, "image_format"],
    [{ image: file(JPEG), width: "1", height: "1" }, "image_format"],
    [{ image: file(PNG), thumb: file(JPEG), width: "1", height: "1" }, "image_format"],
    [{ image: file(JPEG), thumb: file(PNG), width: "1", height: "1" }, "image_format"],
    [{ image: file(JPEG, "image/png"), thumb: file(JPEG), width: "1", height: "1" }, "image_format"],
    [{ image: file(new Uint8Array()), thumb: file(JPEG), width: "1", height: "1" }, "image_format"],
    [{ image: "text", thumb: file(JPEG), width: "1", height: "1" }, "image_format"],
    [{ image: file(JPEG), thumb: file(JPEG), width: "0", height: "1" }, "validation"],
    [{ image: file(JPEG), thumb: file(JPEG), width: "1601", height: "1" }, "validation"],
    [{ image: file(JPEG), thumb: file(JPEG), width: "1.5", height: "1" }, "validation"],
    [{ image: file(JPEG), thumb: file(JPEG), width: "1" }, "validation"],
    [{ image: file(JPEG), thumb: file(JPEG), width: "1", height: "" }, "validation"],
    [{ image: file(JPEG), thumb: file(JPEG), width: "1e3", height: "1" }, "validation"],
    [{ image: file(JPEG), thumb: file(JPEG), width: " 1", height: "1" }, "validation"],
  ])("不正な入力 %j は %s", async (parts, code) => {
    await expect(parseUpload(form(parts as Record<string, string | File>))).rejects.toMatchObject({ status: 400, code });
  });

  it("エラーの文言", async () => {
    await expect(parseUpload(form({ thumb: file(JPEG), width: "1", height: "1" }))).rejects.toThrow(
      "JPEG の画像を送ってください",
    );
    await expect(parseUpload(form({ image: file(JPEG), thumb: file(JPEG), width: "0", height: "1" }))).rejects.toThrow(
      "画像の大きさが正しくありません",
    );
  });

  it("大きすぎる本体は、中身を丸ごと読まずに image_size にする", async () => {
    // arrayBuffer() を呼ぶと失敗する File。slice(0, 3) は新しい File を返すので読める
    class NoReadFile extends File {
      override arrayBuffer(): Promise<ArrayBuffer> {
        throw new Error("読んではいけない");
      }
    }
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    big.set(JPEG);
    const image = new NoReadFile([big], "a.jpg", { type: "image/jpeg" });
    expect(() => image.arrayBuffer()).toThrow("読んではいけない");
    const bigThumb = new Uint8Array(MAX_THUMB_BYTES + 1);
    bigThumb.set(JPEG);
    const thumb = new NoReadFile([bigThumb], "t.jpg", { type: "image/jpeg" });
    const fake = (parts: Record<string, File | string>) =>
      ({ get: (k: string) => parts[k] ?? null }) as unknown as FormData;

    await expect(parseUpload(fake({ image, thumb: file(JPEG), width: "1", height: "1" }))).rejects.toMatchObject({
      status: 400,
      code: "image_size",
    });
    await expect(parseUpload(fake({ image: file(JPEG), thumb, width: "1", height: "1" }))).rejects.toMatchObject({
      status: 400,
      code: "image_size",
    });
  });

  it("大きすぎる", async () => {
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    big.set(JPEG);
    await expect(
      parseUpload(form({ image: file(big), thumb: file(JPEG), width: "1", height: "1" })),
    ).rejects.toMatchObject({ status: 400, code: "image_size", message: "画像が大きすぎます" });
    const bigThumb = new Uint8Array(MAX_THUMB_BYTES + 1);
    bigThumb.set(JPEG);
    await expect(
      parseUpload(form({ image: file(JPEG), thumb: file(bigThumb), width: "1", height: "1" })),
    ).rejects.toMatchObject({ status: 400, code: "image_size" });
  });
});
