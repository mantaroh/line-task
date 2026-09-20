import liff from "@line/liff";
import { isIdTokenFresh, shouldRetryRelogin } from "./idToken";

const DEV_USER_KEY = "ltb-dev-user";
const DEV_NAMES: Record<string, string> = {
  "dev-alice": "Alice",
  "dev-bob": "Bob",
  "dev-carol": "Carol",
};

export type LiffSession = { idToken: string; canShare: boolean };

function devUser(): string {
  return localStorage.getItem(DEV_USER_KEY) ?? "dev-alice";
}

type LiffWithMock = typeof liff & {
  init: (config: { liffId: string; mock?: boolean }) => Promise<void>;
  $mock: {
    set: (data: Record<string, unknown> | ((prev: Record<string, unknown>) => Record<string, unknown>)) => void;
  };
};

let ready: Promise<LiffSession> | null = null;

export function initLiff(): Promise<LiffSession> {
  if (!ready) ready = doInit();
  return ready;
}

async function doInit(): Promise<LiffSession> {
  if (import.meta.env.DEV) {
    const { LiffMockPlugin } = await import("@line/liff-mock");
    const mockLiff = liff as LiffWithMock;
    mockLiff.use(new LiffMockPlugin());
    await mockLiff.init({ liffId: "dev", mock: true });
    mockLiff.login();
    const user = devUser();
    mockLiff.$mock.set((p) => ({
      ...p,
      getIDToken: `dev:${user}`,
      getProfile: {
        userId: user,
        displayName: DEV_NAMES[user] ?? user,
        pictureUrl: undefined,
        statusMessage: "",
      },
    }));
  } else {
    const liffId = import.meta.env.VITE_LIFF_ID;
    if (!liffId) throw new Error("VITE_LIFF_ID がありません");
    await liff.init({ liffId });
    if (!liff.isLoggedIn()) {
      liff.login();
      return new Promise<LiffSession>(() => {});
    }
  }
  return { idToken: await getIdToken(), canShare: liff.isApiAvailable("shareTargetPicker") };
}

const RELOGIN_KEY = "ltb-relogin-at";

export async function getIdToken(): Promise<string> {
  const token = liff.getIDToken();
  if (!token) throw new Error("ID token を取得できませんでした");
  if (import.meta.env.DEV) return token;
  if (isIdTokenFresh(liff.getDecodedIDToken()?.exp, Date.now())) return token;
  return relogin();
}

function relogin(): Promise<never> {
  if (!shouldRetryRelogin(sessionStorage.getItem(RELOGIN_KEY), Date.now())) {
    throw new Error("LINE のログインが切れました。アプリを開き直してください");
  }
  sessionStorage.setItem(RELOGIN_KEY, String(Date.now()));
  if (liff.isInClient()) {
    // LIFF ブラウザでは liff.login() が使えないので、開き直して liff.init からやり直す
    location.reload();
  } else {
    liff.logout();
    liff.login({ redirectUri: location.href });
  }
  return new Promise<never>(() => {});
}

export async function shareMessage(text: string): Promise<boolean> {
  try {
    if (!liff.isApiAvailable("shareTargetPicker")) return false;
    const result = await liff.shareTargetPicker([{ type: "text", text }]);
    return Boolean(result);
  } catch {
    return false;
  }
}

// LINE の中では外部ブラウザで開く。PC などのブラウザでは新しいタブで開く
export function openExternal(url: string): void {
  if (import.meta.env.DEV || !liff.isInClient()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  liff.openWindow({ url, external: true });
}

export function openInLine(url: string): void {
  if (import.meta.env.DEV) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  liff.openWindow({ url, external: false });
}
