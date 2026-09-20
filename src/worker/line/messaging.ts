// LINE Messaging API のクライアント。push・残り通数・友だちの確認だけを扱う。
// エラーの本文は読まない（ID や本文が混ざる可能性があるため）。

const BASE = "https://api.line.me/v2/bot";
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type Quota = { limit: number | null; used: number }; // limit が null なら上限なし
export type PushResult = "sent" | "duplicate"; // duplicate は同じ Retry Key で送信済み（409）

export class MessagingError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface MessagingClient {
  pushText(to: string, text: string, retryKey: string): Promise<PushResult>;
  getQuota(): Promise<Quota>;
  isFriend(userId: string): Promise<boolean>; // 200 → true、404 → false、それ以外は MessagingError
}

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function fail(status: number): MessagingError {
  return new MessagingError(status, `Messaging API ${status}`);
}

// 読まない応答の本文は捨てて、接続を早く返す
async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // 捨てるのに失敗しても結果は変わらない
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function createMessagingClient(
  token: string,
  fetchFn: typeof fetch,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): MessagingClient {
  const auth = { Authorization: `Bearer ${token}` };

  // タイムアウトや通信の失敗も MessagingError（状態コード 0）にそろえる
  async function send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new MessagingError(0, "Messaging API request failed");
    }
  }

  async function getJson<T>(url: string): Promise<T> {
    const res = await send(url, { headers: auth });
    if (!res.ok) {
      await discard(res);
      throw fail(res.status);
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new MessagingError(res.status, "Messaging API invalid JSON");
    }
  }

  return {
    async pushText(to, text, retryKey) {
      const doFetch = () =>
        send(`${BASE}/message/push`, {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json", "X-Line-Retry-Key": retryKey },
          body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
        });
      let res = await doFetch();
      if (isRetryable(res.status)) {
        await discard(res);
        await sleep(1000);
        res = await doFetch();
      }
      await discard(res);
      if (res.status === 409) return "duplicate";
      if (!res.ok) throw fail(res.status);
      return "sent";
    },

    async getQuota() {
      const quota = await getJson<{ type?: string; value?: number }>(`${BASE}/message/quota`);
      const consumption = await getJson<{ totalUsage?: number }>(`${BASE}/message/quota/consumption`);
      const limit = quota.type === "limited" && typeof quota.value === "number" ? quota.value : null;
      return { limit, used: consumption.totalUsage ?? 0 };
    },

    async isFriend(userId) {
      const res = await send(`${BASE}/profile/${encodeURIComponent(userId)}`, { headers: auth });
      await discard(res);
      if (res.status === 404) return false;
      if (!res.ok) throw fail(res.status);
      return true;
    },
  };
}
