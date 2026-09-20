import type { ActivityItem } from "../../shared/types";
import { nameOrPlaceholder } from "./Avatar";

function asRecord(detail: unknown): Record<string, unknown> {
  if (detail && typeof detail === "object" && !Array.isArray(detail)) return detail as Record<string, unknown>;
  return {};
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) return null;
  return v;
}

function formatChanges(changes: unknown): string | null {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return null;
  const parts: string[] = [];
  for (const [field, pair] of Object.entries(changes)) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    parts.push(`${field} を ${String(pair[0])} → ${String(pair[1])} に変更`);
  }
  return parts.length > 0 ? parts.join("、") : null;
}

function actionLabel(action: string, detail: unknown): string {
  const d = asRecord(detail);
  switch (action) {
    case "task.create": {
      const id = asString(d.taskId);
      const title = asString(d.title);
      if (id && title) return `${id}「${title}」を追加`;
      if (id) return `${id} を追加`;
      return "タスクを追加";
    }
    case "task.update": {
      const id = asString(d.taskId) ?? "タスク";
      const changes = formatChanges(d.changes);
      return changes ? `${id} の ${changes}` : `${id} を更新`;
    }
    case "task.image_add": {
      const id = asString(d.taskId);
      return id ? `${id} に画像を追加` : "画像を追加";
    }
    case "task.image_delete": {
      const id = asString(d.taskId);
      return id ? `${id} の画像を削除` : "画像を削除";
    }
    case "task.media_add":
    case "task.media_delete": {
      const id = asString(d.taskId);
      const label = d.kind === "audio" ? "音声" : "動画";
      if (action === "task.media_add") return id ? `${id} に${label}を追加` : `${label}を追加`;
      return id ? `${id} の${label}を削除` : `${label}を削除`;
    }
    case "task.file_add":
    case "task.file_delete": {
      const id = asString(d.taskId);
      const name = asString(d.name);
      const what = name ? `ファイル「${name}」` : "ファイル";
      if (action === "task.file_add") return id ? `${id} に${what}を追加` : `${what}を追加`;
      return id ? `${id} の${what}を削除` : `${what}を削除`;
    }
    case "project.create":
      return "プロジェクトを作成";
    case "project.rename": {
      const from = asString(d.from);
      const to = asString(d.to);
      return from && to ? `名前を ${from} → ${to} に変更` : "名前を変更";
    }
    case "project.parties": {
      const from = asStringArray(d.from);
      const to = asStringArray(d.to);
      return from && to ? `関係者を ${from.join("、")} → ${to.join("、")} に変更` : "関係者を変更";
    }
    case "project.archive":
      return "アーカイブした";
    case "project.unarchive":
      return "アーカイブを戻した";
    case "project.sheet_bind":
      return "シートをつないだ";
    case "invite.create": {
      const days = typeof d.days === "number" ? d.days : null;
      return days != null ? `招待を発行（${days}日）` : "招待を発行";
    }
    case "invite.revoke":
      return "招待を取り消した";
    case "member.join":
      return "招待から参加";
    case "member.leave":
      return "抜けた";
    case "member.remove": {
      const name = asString(d.name);
      return name ? `${name} を外した` : "外した";
    }
    case "sheet.warning": {
      const id = asString(d.taskId);
      return id ? `ID ${id} が重複しています` : "シートの警告";
    }
    default:
      return action;
  }
}

function formatAt(at: string): string {
  const m = at.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : at;
}

export function ActivityList({
  items,
  onMore,
  moreBusy,
}: {
  items: ActivityItem[];
  onMore?: () => void;
  moreBusy?: boolean;
}) {
  if (items.length === 0) {
    return <p className="muted">変更履歴はまだありません</p>;
  }
  return (
    <>
      <ul className="activity-list">
        {items.map((item) => (
          <li key={item.id} className="activity-item">
            <span className="activity-actor">{nameOrPlaceholder(item.actor.displayName)}</span>
            <span>{actionLabel(item.action, item.detail)}</span>
            <time className="muted" dateTime={item.at}>
              {formatAt(item.at)}
            </time>
          </li>
        ))}
      </ul>
      {onMore ? (
        <button type="button" className="btn activity-more" onClick={onMore} disabled={moreBusy}>
          もっと見る
        </button>
      ) : null}
    </>
  );
}
