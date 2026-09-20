// 期限の通知を 1 日分まとめて送る。Cron と dev 用の起動口から呼ぶ。
// ログには件数だけを出す（表示名・件名・LINE ユーザー ID は出さない）。

import { nowIso, todayJst } from "../../shared/time";
import type { Task } from "../../shared/types";
import { insertNotificationLog, listLoggedKeys, listNotifyTargets, pruneNotificationLog } from "../db";
import type { Deps } from "../deps";
import { MessagingError } from "../line/messaging";
import { SheetsError } from "../sheets/client";
import { parseTasks, readTable } from "../sheets/tasks";
import { setLineFriend } from "../usage/store";
import { addDays, formatDigest, retryKeyFor, selectForTarget, type NotifyItem } from "./plan";
import type { NotifyTarget } from "./types";

export type RunResult = {
  recipients: number; // 知らせるものがあった人数
  sent: number; // push できた人数（duplicate を含む）
  items: number; // 記録したタスクの件数
  skipped: { notFriend: number; quota: number; error: number; sheet: number };
};

const LOG_KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function emptyResult(): RunResult {
  return { recipients: 0, sent: 0, items: 0, skipped: { notFriend: 0, quota: 0, error: 0, sheet: 0 } };
}

// ログに出すのは状態コードだけ（メッセージに ID などが入ることがあるため）
function statusOf(e: unknown): { status: number } | undefined {
  return e instanceof SheetsError || e instanceof MessagingError ? { status: e.status } : undefined;
}

function groupByProject(targets: NotifyTarget[]): Map<string, NotifyTarget[]> {
  const map = new Map<string, NotifyTarget[]>();
  for (const t of targets) {
    const list = map.get(t.projectId);
    if (list) list.push(t);
    else map.set(t.projectId, [t]);
  }
  return map;
}

async function remainingQuota(deps: Pick<Deps, "messaging">): Promise<number> {
  try {
    const { limit, used } = await deps.messaging!.getQuota();
    return limit === null ? Number.POSITIVE_INFINITY : limit - used;
  } catch {
    console.warn("[notify] quota unavailable");
    return Number.POSITIVE_INFINITY;
  }
}

export async function runNotifications(
  env: Pick<Env, "DB" | "KV" | "APP_URL_BASE">,
  deps: Pick<Deps, "sheets" | "messaging" | "now">,
): Promise<RunResult> {
  const result = emptyResult();
  const messaging = deps.messaging;
  if (!messaging) return result;

  const now = deps.now();
  const today = todayJst(now);
  const targets = await listNotifyTargets(env.DB);

  // プロジェクトごとにシートを 1 回だけ読む
  const tasksByProject = new Map<string, Task[]>();
  for (const [projectId, group] of groupByProject(targets)) {
    try {
      const table = await readTable(deps.sheets, env.KV, group[0].spreadsheetId, { fresh: true });
      tasksByProject.set(projectId, parseTasks(table).tasks);
    } catch (e) {
      result.skipped.sheet += group.length;
      console.warn("[notify] sheet skipped", statusOf(e));
    }
  }

  const logged = await listLoggedKeys(env.DB, addDays(today, -3));
  const itemsByUser = new Map<string, NotifyItem[]>();
  for (const target of targets) {
    const tasks = tasksByProject.get(target.projectId);
    if (!tasks) continue;
    const items = selectForTarget(target, tasks, today, logged);
    if (items.length === 0) continue;
    const list = itemsByUser.get(target.lineUserId);
    if (list) list.push(...items);
    else itemsByUser.set(target.lineUserId, items);
  }

  const digests: { userId: string; text: string; included: NotifyItem[] }[] = [];
  for (const userId of [...itemsByUser.keys()].sort()) {
    const { text, included } = formatDigest(itemsByUser.get(userId)!, today, env.APP_URL_BASE);
    if (included.length === 0) continue;
    digests.push({ userId, text, included });
  }
  result.recipients = digests.length;

  if (digests.length > 0) {
    const remaining = await remainingQuota(deps);
    const sentAt = nowIso(now);
    for (const { userId, text, included } of digests) {
      if (result.sent >= remaining) {
        result.skipped.quota++;
        continue;
      }
      try {
        const friend = await messaging.isFriend(userId);
        try {
          await setLineFriend(env.DB, userId, friend, sentAt);
        } catch {
          console.warn("[notify] friend save failed");
        }
        if (!friend) {
          result.skipped.notFriend++;
          continue;
        }
        await messaging.pushText(userId, text, await retryKeyFor(userId, today));
      } catch (e) {
        result.skipped.error++;
        console.warn("[notify] push failed", statusOf(e));
        continue;
      }
      // "sent" でも "duplicate" でも届いている。記録に失敗しても、届いた分として数えて次の人へ進む
      result.sent++;
      result.items += included.length;
      try {
        await insertNotificationLog(env.DB, included, sentAt);
      } catch {
        console.warn("[notify] log write failed");
      }
    }
    if (result.skipped.quota > 0) console.warn("[notify] quota short", { skipped: result.skipped.quota });
  }

  // 古い記録を消せなくても、送った結果は返す（次回の実行でまた消す）
  try {
    await pruneNotificationLog(env.DB, nowIso(new Date(now.getTime() - LOG_KEEP_DAYS * DAY_MS)));
  } catch {
    console.warn("[notify] prune failed");
  }
  console.log("[notify] done", result);
  return result;
}
