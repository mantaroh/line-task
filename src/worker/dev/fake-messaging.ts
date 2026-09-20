// 開発・テスト用の Messaging API の偽物。LINE には何も送らない。
import { MessagingError, type MessagingClient } from "../line/messaging";

export type FakeMessaging = MessagingClient & {
  sent: { to: string; text: string; retryKey: string }[];
};

export function createFakeMessagingClient(
  opts: {
    friends?: (userId: string) => boolean; // 既定は全員 true
    limit?: number | null; // 既定は null
    used?: number; // 既定は 0
    failFor?: (userId: string) => boolean; // true の人への push は MessagingError(500)
  } = {},
): FakeMessaging {
  const sent: FakeMessaging["sent"] = [];
  return {
    sent,
    async pushText(to, text, retryKey) {
      if (sent.some((s) => s.retryKey === retryKey)) return "duplicate";
      if (opts.failFor?.(to)) throw new MessagingError(500, "Messaging API 500");
      // 本文や ID はログに出さない。
      console.log("[fake-messaging] push", { chars: text.length });
      sent.push({ to, text, retryKey });
      return "sent";
    },
    async getQuota() {
      return { limit: opts.limit ?? null, used: opts.used ?? 0 };
    },
    async isFriend(userId) {
      return opts.friends ? opts.friends(userId) : true;
    },
  };
}
