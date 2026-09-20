import type { Member } from "../../shared/types";
import { Avatar, nameOrPlaceholder } from "./Avatar";

function formatAt(at: string): string {
  const m = at.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : at;
}

export function MemberList({
  members,
  lineUserId,
  archived,
  onRemove,
}: {
  members: Member[];
  lineUserId: string;
  archived: boolean;
  onRemove: (uid: string) => void;
}) {
  const last = members.length <= 1;

  return (
    <ul className="member-list">
      {members.map((m) => {
        const self = m.lineUserId === lineUserId;
        const showLeave = self && !last && !archived;
        const showRemove = !self && !archived;
        return (
          <li key={m.lineUserId} className="member-row">
            <Avatar name={m.displayName} pictureUrl={m.pictureUrl} />
            <div className="member-info">
              <div className="member-name">
                <span>{nameOrPlaceholder(m.displayName)}</span>
                <span className={m.party ? "badge badge-party" : "badge badge-party is-unset"}>
                  {m.party ? `${m.party}側` : "側：未設定"}
                </span>
              </div>
              <time className="muted" dateTime={m.joinedAt}>
                {formatAt(m.joinedAt)}
              </time>
            </div>
            {showLeave ? (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  if (window.confirm("このプロジェクトから抜けますか？")) onRemove(m.lineUserId);
                }}
              >
                抜ける
              </button>
            ) : null}
            {showRemove ? (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  if (window.confirm(`${nameOrPlaceholder(m.displayName)} を外しますか？`)) onRemove(m.lineUserId);
                }}
              >
                外す
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
