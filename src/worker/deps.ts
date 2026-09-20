// リクエストごとの依存（認証検証・サービスアカウント・時計・Sheets クライアント・Messaging API）を組み立てる。
import { verifyLineIdToken, type LineProfile } from "./auth";
import { createFakeSheetsClient, kvStore } from "./dev/fake-sheets";
import { fakeVerifyIdToken } from "./dev/fake-line";
import { createFakeMessagingClient } from "./dev/fake-messaging";
import { getAccessToken, parseServiceAccountKey } from "./google";
import { createMessagingClient, type MessagingClient } from "./line/messaging";
import { createGoogleSheetsClient } from "./sheets/google-client";
import type { SheetsClient } from "./sheets/client";

export type Deps = {
  verifyIdToken: (idToken: string) => Promise<LineProfile>;
  serviceAccountEmail: string;
  now: () => Date;
  sheets: SheetsClient;
  messaging: MessagingClient | null; // 未設定なら null
  lineOaBasicId: string | null; // "@example" の形。未設定・形が違えば null
};

const OA_BASIC_ID = /^@[0-9a-z]+$/;

export function isDevMocksEnabled(env: { DEV_MOCKS?: string }, url: string): boolean {
  if (env.DEV_MOCKS !== "1") return false;
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1";
}

export function createDeps(env: Env, url: string): Deps {
  if (isDevMocksEnabled(env, url)) {
    return {
      verifyIdToken: fakeVerifyIdToken,
      serviceAccountEmail: "dev-sheets@line-task-board-dev.iam.gserviceaccount.com",
      now: () => new Date(),
      sheets: createFakeSheetsClient(kvStore(env.KV)),
      messaging: createFakeMessagingClient(),
      lineOaBasicId: "@dev-oa",
    };
  }
  // fetch を unbound のまま渡すと呼び出し時に this が外れて落ちるため、ラップして渡す。
  const fetchFn: typeof fetch = (input, init) => fetch(input, init);
  const getToken = () => getAccessToken(parseServiceAccountKey(env.GOOGLE_SA_KEY), env.KV, fetchFn, new Date());
  return {
    verifyIdToken: (idToken) => verifyLineIdToken(idToken, env.LINE_CHANNEL_ID, fetch),
    serviceAccountEmail: (() => {
      try {
        return parseServiceAccountKey(env.GOOGLE_SA_KEY).client_email;
      } catch {
        return "";
      }
    })(),
    now: () => new Date(),
    sheets: createGoogleSheetsClient(getToken, fetchFn),
    messaging: env.LINE_MESSAGING_TOKEN ? createMessagingClient(env.LINE_MESSAGING_TOKEN, fetchFn) : null,
    lineOaBasicId: env.LINE_OA_BASIC_ID && OA_BASIC_ID.test(env.LINE_OA_BASIC_ID) ? env.LINE_OA_BASIC_ID : null,
  };
}
