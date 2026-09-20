// DEV_MOCKS 用の偽の LINE 認証。localhost / 127.0.0.1 でのみ使われる（createDeps 側で制御）。
import type { LineProfile } from "../auth";
import { HttpError } from "../errors";

const DEV_USERS: Record<string, string> = {
  "dev-alice": "Alice",
  "dev-bob": "Bob",
  "dev-carol": "Carol",
};

export async function fakeVerifyIdToken(idToken: string): Promise<LineProfile> {
  const m = idToken.match(/^dev:(.+)$/);
  const uid = m?.[1];
  const name = uid ? DEV_USERS[uid] : undefined;
  if (!uid || !name) throw new HttpError(401, "unauthorized", "LINE の認証に失敗しました");
  return { sub: uid, name, picture: null };
}
