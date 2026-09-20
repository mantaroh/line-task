import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { base64urlDecode } from "../../src/worker/crypto";
import { getAccessToken, parseServiceAccountKey, signGoogleJwt, type ServiceAccountKey } from "../../src/worker/google";
import { createGoogleSheetsClient } from "../../src/worker/sheets/google-client";
import { SheetsError } from "../../src/worker/sheets/client";

async function testKey(): Promise<ServiceAccountKey> {
  const kp = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8)).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
  (globalThis as unknown as { __pub: CryptoKey }).__pub = kp.publicKey;
  return { client_email: "sa@p.iam.gserviceaccount.com", private_key: pem };
}

describe("サービスアカウントの認証", () => {
  beforeEach(async () => {
    await env.KV.delete("google:token");
  });

  it("JWT の中身と署名", async () => {
    const key = await testKey();
    const jwt = await signGoogleJwt(key, new Date("2026-09-15T00:00:00Z"));
    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(new TextDecoder().decode(base64urlDecode(h)))).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(new TextDecoder().decode(base64urlDecode(p)))).toEqual({
      iss: "sa@p.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1789430400,
      exp: 1789434000,
    });
    expect(
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        (globalThis as unknown as { __pub: CryptoKey }).__pub,
        base64urlDecode(s),
        new TextEncoder().encode(`${h}.${p}`),
      ),
    ).toBe(true);
  });

  it("アクセストークンは KV に置き、2 回目は交換しない", async () => {
    const key = await testKey();
    const calls: Request[] = [];
    const fetchFn = (async (input: RequestInfo, init?: RequestInit) => {
      calls.push(new Request(input, init));
      return Response.json({ access_token: "tok-1" });
    }) as typeof fetch;
    const now = new Date("2026-09-15T00:00:00Z");

    const first = await getAccessToken(key, env.KV, fetchFn, now);
    expect(first).toBe("tok-1");
    const second = await getAccessToken(key, env.KV, fetchFn, now);
    expect(second).toBe("tok-1");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
    const bodyText = await calls[0].text();
    const params = new URLSearchParams(bodyText);
    expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(params.get("assertion")).toBeTruthy();
  });

  it("トークン交換に失敗したらエラーになる（本文やキーは含めない）", async () => {
    const key = await testKey();
    const fetchFn = (async () => new Response("secret-body", { status: 401 })) as typeof fetch;
    await expect(getAccessToken(key, env.KV, fetchFn, new Date())).rejects.toThrow("Google token exchange failed: 401");
  });

  it("parseServiceAccountKey は形が違えばエラーにする", () => {
    expect(() => parseServiceAccountKey("")).toThrow();
    expect(() => parseServiceAccountKey("not json")).toThrow();
    expect(() => parseServiceAccountKey(JSON.stringify({ client_email: "a@b" }))).toThrow();
    expect(() => parseServiceAccountKey(JSON.stringify({ private_key: "x" }))).toThrow();
    expect(parseServiceAccountKey(JSON.stringify({ client_email: "a@b", private_key: "x" }))).toEqual({
      client_email: "a@b",
      private_key: "x",
    });
  });
});

describe("本物の Sheets クライアント", () => {
  function tokenOf(): Promise<string> {
    return Promise.resolve("tok");
  }

  it("429 は 1 回だけ再試行する（成功するケース）", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      if (calls === 1) return new Response("", { status: 429 });
      return Response.json({ values: [["x"]] });
    }) as typeof fetch;
    const sleepCalls: number[] = [];
    const sleep = async (ms: number) => {
      sleepCalls.push(ms);
    };
    const client = createGoogleSheetsClient(tokenOf, fetchFn, sleep);

    const values = await client.getValues("sid", "'タスク'!A1:B2");

    expect(values).toEqual([["x"]]);
    expect(calls).toBe(2);
    expect(sleepCalls).toEqual([1000]);
  });

  it("429 が 2 回続いたら SheetsError(429) になる", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response("", { status: 429 });
    }) as typeof fetch;
    const sleepCalls: number[] = [];
    const sleep = async (ms: number) => {
      sleepCalls.push(ms);
    };
    const client = createGoogleSheetsClient(tokenOf, fetchFn, sleep);

    await expect(client.getValues("sid", "A1")).rejects.toMatchObject({ status: 429 });
    expect(calls).toBe(2);
    expect(sleepCalls).toEqual([1000]);
  });

  it("429 以外のエラーは再試行しない", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response("forbidden-body", { status: 403 });
    }) as typeof fetch;
    const sleep = async () => {
      throw new Error("sleep should not be called");
    };
    const client = createGoogleSheetsClient(tokenOf, fetchFn, sleep);

    const err = await client.getValues("sid", "A1").catch((e) => e);
    expect(err).toBeInstanceOf(SheetsError);
    expect((err as SheetsError).status).toBe(403);
    expect((err as SheetsError).message).not.toContain("forbidden-body");
    expect(calls).toBe(1);
  });

  it("values:batchUpdate のリクエストの形", async () => {
    const calls: Request[] = [];
    const fetchFn = (async (input: RequestInfo, init?: RequestInit) => {
      calls.push(new Request(input, init));
      return Response.json({});
    }) as typeof fetch;
    const client = createGoogleSheetsClient(tokenOf, fetchFn);

    await client.batchUpdateValues("sid", [{ range: "'タスク'!B2", values: [["x"]] }]);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://sheets.googleapis.com/v4/spreadsheets/sid/values:batchUpdate");
    expect(calls[0].headers.get("Authorization")).toBe("Bearer tok");
    expect(await calls[0].json()).toEqual({
      valueInputOption: "USER_ENTERED",
      data: [{ range: "'タスク'!B2", values: [["x"]] }],
    });
  });

  it("getSpreadsheet は properties.title・sheets.properties を組み立てる", async () => {
    const calls: Request[] = [];
    const fetchFn = (async (input: RequestInfo, init?: RequestInit) => {
      calls.push(new Request(input, init));
      return Response.json({
        properties: { title: "無題" },
        sheets: [
          { properties: { sheetId: 0, title: "タスク" } },
          { properties: { sheetId: 1, title: "_設定", hidden: true } },
        ],
      });
    }) as typeof fetch;
    const client = createGoogleSheetsClient(tokenOf, fetchFn);

    const meta = await client.getSpreadsheet("sp id");

    expect(calls[0].url).toBe(
      "https://sheets.googleapis.com/v4/spreadsheets/sp%20id?fields=properties.title,sheets.properties",
    );
    expect(meta).toEqual({
      title: "無題",
      sheets: [
        { sheetId: 0, title: "タスク", hidden: false },
        { sheetId: 1, title: "_設定", hidden: true },
      ],
    });
  });

  it("appendValues・batchUpdate の URL とメソッド", async () => {
    const calls: Request[] = [];
    const fetchFn = (async (input: RequestInfo, init?: RequestInit) => {
      calls.push(new Request(input, init));
      return Response.json({});
    }) as typeof fetch;
    const client = createGoogleSheetsClient(tokenOf, fetchFn);

    await client.appendValues("sid", "'タスク'!A1", [["a", "b"]]);
    await client.batchUpdate("sid", [{ addSheet: { properties: { sheetId: 2, title: "x" } } }]);

    expect(calls[0].url).toBe(
      "https://sheets.googleapis.com/v4/spreadsheets/sid/values/'%E3%82%BF%E3%82%B9%E3%82%AF'!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS",
    );
    expect(calls[0].method).toBe("POST");
    expect(await calls[0].json()).toEqual({ values: [["a", "b"]] });

    expect(calls[1].url).toBe("https://sheets.googleapis.com/v4/spreadsheets/sid:batchUpdate");
    expect(await calls[1].json()).toEqual({ requests: [{ addSheet: { properties: { sheetId: 2, title: "x" } } }] });
  });
});
