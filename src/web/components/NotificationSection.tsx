import { useEffect, useState } from "react";
import type { LineFriendResponse, MemberSettings } from "../../shared/types";
import { api, ApiError } from "../api";
import { openInLine } from "../liff";
import { Loading } from "./Loading";

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : fallback;
}

export function NotificationSection({
  pid,
  parties,
  archived,
  onChanged,
}: {
  pid: string;
  parties: string[];
  archived: boolean;
  onChanged?: () => void;
}) {
  const [settings, setSettings] = useState<MemberSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [friend, setFriend] = useState<LineFriendResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSettings(null);
    setLoadError(null);
    setSaveError(null);
    api<MemberSettings>("GET", `/api/projects/${pid}/me`)
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(errorMessage(e, "通知の設定を読み込めませんでした"));
      });
    return () => {
      cancelled = true;
    };
  }, [pid]);

  useEffect(() => {
    let cancelled = false;
    api<LineFriendResponse>("GET", "/api/me/line-friend")
      .then((f) => {
        if (!cancelled) setFriend(f);
      })
      .catch(() => {
        // 友だちの状態が分からないときは何も出さない
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(patch: Partial<MemberSettings>) {
    if (!settings) return;
    const prev = settings;
    setSettings({ ...prev, ...patch });
    setSaveError(null);
    setSaving(true);
    try {
      setSettings(await api<MemberSettings>("PATCH", `/api/projects/${pid}/me`, patch));
      if (patch.party !== undefined) onChanged?.();
    } catch (e) {
      setSettings(prev);
      setSaveError(errorMessage(e, "保存できませんでした"));
    } finally {
      setSaving(false);
    }
  }

  const disabled = archived || saving;
  const party = settings?.party && parties.includes(settings.party) ? settings.party : "";

  return (
    <section className="settings-section notify-section">
      <h2>通知</h2>
      {loadError ? (
        <p className="error">{loadError}</p>
      ) : !settings ? (
        <Loading />
      ) : (
        <>
          <label className="switch-row" htmlFor="notify-enabled">
            <span>期限の通知を LINE で受け取る</span>
            <input
              id="notify-enabled"
              type="checkbox"
              role="switch"
              className="switch"
              checked={settings.notify}
              aria-checked={settings.notify}
              disabled={disabled}
              onChange={(e) => save({ notify: e.target.checked })}
            />
          </label>
          <div className="field">
            <label htmlFor="notify-party">自分の側</label>
            <select
              id="notify-party"
              value={party}
              disabled={disabled}
              onChange={(e) => save({ party: e.target.value === "" ? null : e.target.value })}
            >
              <option value="">すべて</option>
              {parties.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <p className="hint notify-hint">一覧で自分の番が先頭に出ます。通知もこの側のタスクだけ届きます</p>
          </div>
          {saveError ? <p className="error">{saveError}</p> : null}
        </>
      )}
      {friend?.friend === false && friend.addFriendUrl ? (
        <div className="warning-box">
          <p>
            <span className="nowrap-chunk">公式アカウントを</span>
            <span className="nowrap-chunk">友だち追加すると届きます</span>
          </p>
          <button type="button" className="btn" onClick={() => openInLine(friend.addFriendUrl!)}>
            友だち追加
          </button>
        </div>
      ) : null}
    </section>
  );
}
