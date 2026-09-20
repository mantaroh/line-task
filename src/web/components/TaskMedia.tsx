import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { TaskMedia as MediaItem } from "../../shared/types";
import { api, ApiError, apiSendFile } from "../api";
import { formatDuration, MAX_MEDIA, mediaKindOf, mediaSizeMessage } from "../media/format";
import { captureVideoThumb, readDurationMs } from "../media/probe";

const LIMIT_MESSAGE = "動画・音声は 3 つまでです";
const PLAY_ERROR = "この端末では再生できません。PC で開いてください";

function listPath(pid: string, taskId: string): string {
  return `/api/projects/${pid}/tasks/${encodeURIComponent(taskId)}/media`;
}

function errorMessage(e: unknown): string {
  return e instanceof ApiError ? e.message : "エラーが発生しました";
}

function MediaPlayer({
  pid,
  item,
  archived,
  onClose,
  onDeleted,
  refreshUrl,
}: {
  pid: string;
  item: MediaItem;
  archived: boolean;
  onClose: () => void;
  onDeleted: () => void;
  // 署名の期限切れに備えて、一覧を取り直して新しい URL をもらう
  refreshUrl: () => Promise<string | null>;
}) {
  const [src, setSrc] = useState(item.url);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const retried = useRef(false);
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // 押してすぐ再生する。止められたら（iPhone の音つき自動再生など）プレーヤーの ▶ で再生してもらう
  useEffect(() => {
    mediaRef.current?.play().catch(() => {});
  }, [src]);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function onMediaError() {
    if (retried.current) {
      setError(PLAY_ERROR);
      return;
    }
    retried.current = true;
    const next = await refreshUrl().catch(() => null);
    if (next && next !== src) setSrc(next);
    else setError(PLAY_ERROR);
  }

  async function onDelete() {
    const label = item.kind === "video" ? "動画" : "音声";
    if (!window.confirm(`この${label}を削除しますか？`)) return;
    setBusy(true);
    setError(null);
    try {
      await api<void>("DELETE", `/api/projects/${pid}/media/${encodeURIComponent(item.id)}`);
      onDeleted();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div
      className="image-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={item.kind === "video" ? "動画の再生" : "音声の再生"}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="image-viewer-body media-player-body">
        {item.kind === "video" ? (
          <video
            ref={mediaRef}
            src={src}
            poster={item.thumbUrl ?? undefined}
            controls
            playsInline
            autoPlay
            preload="auto"
            onError={onMediaError}
          />
        ) : (
          <div className="media-audio">
            <span className="media-audio-icon" aria-hidden="true">
              🎤
            </span>
            <audio ref={mediaRef} src={src} controls autoPlay preload="auto" onError={onMediaError} />
          </div>
        )}
        {error ? <p className="image-viewer-note">{error}</p> : null}
      </div>
      <div className="image-viewer-actions">
        {!archived ? (
          <button type="button" className="btn image-viewer-delete" onClick={onDelete} disabled={busy}>
            削除
          </button>
        ) : null}
        <button type="button" className="btn" ref={closeRef} onClick={onClose}>
          閉じる
        </button>
      </div>
    </div>
  );
}

export function TaskMediaSection({
  pid,
  taskId,
  archived,
  disabled = false,
  ensureTaskId,
  onChanged,
}: {
  pid: string;
  taskId: string | null;
  archived: boolean;
  // 親の画面がタスクを保存している間は追加させない
  disabled?: boolean;
  ensureTaskId: () => Promise<string | null>;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [progress, setProgress] = useState<{ current: number; total: number; percent: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [playing, setPlaying] = useState<MediaItem | null>(null);

  useEffect(() => {
    if (!taskId) {
      setItems([]);
      return;
    }
    let cancelled = false;
    setListError(null);
    api<MediaItem[]>("GET", listPath(pid, taskId))
      .then((list) => {
        if (!cancelled) setItems(list);
      })
      .catch(() => {
        if (!cancelled) setListError("動画・音声を読み込めませんでした");
      });
    return () => {
      cancelled = true;
    };
  }, [pid, taskId, reloadTick]);

  const full = items.length >= MAX_MEDIA;
  const addDisabled = busy || disabled || full;

  async function uploadOne(id: string, file: File, index: number, total: number): Promise<void> {
    const kind = mediaKindOf(file);
    if (!kind) throw new Error("この形式は付けられません");
    const tooBig = mediaSizeMessage(file.size);
    if (tooBig) throw new Error(tooBig);

    setProgress({ current: index + 1, total, percent: 0 });
    const durationMs = await readDurationMs(file, kind);
    // サムネイル作りは送信と並べて行う（待たせない）
    const thumbPromise = kind === "video" ? captureVideoThumb(file) : Promise.resolve(null);
    const q = new URLSearchParams({ kind });
    if (durationMs !== null) q.set("duration_ms", String(durationMs));
    const saved = await apiSendFile<MediaItem>("POST", `${listPath(pid, id)}?${q}`, file, (ratio) =>
      setProgress({ current: index + 1, total, percent: Math.round(ratio * 100) }),
    );
    setItems((prev) => (prev.some((m) => m.id === saved.id) ? prev : [...prev, saved]));
    const thumb = await thumbPromise;
    if (thumb) {
      // サムネイルが置けなくても 🎬 で出すので、失敗は無視する
      await apiSendFile<void>("PUT", `/api/projects/${pid}/media/${encodeURIComponent(saved.id)}/thumb`, thumb).catch(
        () => {},
      );
    }
  }

  async function onSelect(e: ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (files.length === 0) return;
    setErrors([]);
    setBusy(true);
    const errs: string[] = [];
    let added = 0;
    try {
      const id = taskId ?? (await ensureTaskId());
      if (!id) {
        setErrors(["先にタスクを保存してください"]);
        return;
      }
      const room = Math.max(0, MAX_MEDIA - items.length);
      const targets = files.slice(0, room);
      if (files.length > room) {
        errs.push(LIMIT_MESSAGE);
        setErrors([...errs]);
      }
      for (const [index, file] of targets.entries()) {
        try {
          await uploadOne(id, file, index, targets.length);
          added += 1;
        } catch (err) {
          errs.push(`${file.name}：${err instanceof Error ? err.message : "エラーが発生しました"}`);
          setErrors([...errs]);
        }
      }
    } catch (err) {
      setErrors([errorMessage(err)]);
    } finally {
      setProgress(null);
      setBusy(false);
      if (added > 0) {
        setReloadTick((n) => n + 1);
        onChanged();
      }
    }
  }

  async function refreshUrl(item: MediaItem): Promise<string | null> {
    if (!taskId) return null;
    const list = await api<MediaItem[]>("GET", listPath(pid, taskId));
    setItems(list);
    return list.find((m) => m.id === item.id)?.url ?? null;
  }

  function onDeleted() {
    setPlaying(null);
    setReloadTick((n) => n + 1);
    onChanged();
  }

  return (
    <section className="media-section">
      <h2>
        動画・音声（{items.length}/{MAX_MEDIA}）
      </h2>
      {listError ? <p className="error">{listError}</p> : null}
      {items.length > 0 ? (
        <ul className="image-grid">
          {items.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                className="image-thumb media-thumb"
                onClick={() => setPlaying(m)}
                aria-label={m.kind === "video" ? "動画を再生" : "音声を再生"}
              >
                {m.thumbUrl ? (
                  <img src={m.thumbUrl} alt="" loading="lazy" />
                ) : (
                  <span className="media-thumb-icon" aria-hidden="true">
                    {m.kind === "video" ? "🎬" : "🎤"}
                  </span>
                )}
                {m.kind === "video" ? (
                  <span className="media-thumb-play" aria-hidden="true">
                    ▶
                  </span>
                ) : null}
                {m.durationMs !== null ? <span className="media-thumb-duration">{formatDuration(m.durationMs)}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {!archived ? (
        <>
          <label className={`btn image-add${addDisabled ? " is-disabled" : ""}`} aria-disabled={addDisabled}>
            ＋ 動画・音声を追加
            <input type="file" accept="video/*,audio/*" multiple hidden disabled={addDisabled} onChange={onSelect} />
          </label>
          {progress ? (
            <p className="hint" role="status">
              送信中 {progress.percent}%{progress.total > 1 ? `（${progress.current}/${progress.total}）` : ""}
            </p>
          ) : null}
          {full && !errors.includes(LIMIT_MESSAGE) ? <p className="hint">{LIMIT_MESSAGE}</p> : null}
        </>
      ) : null}
      {errors.length > 0 ? (
        <ul className="image-errors">
          {errors.map((msg, i) => (
            <li key={i} className="error">
              {msg}
            </li>
          ))}
        </ul>
      ) : null}
      {playing ? (
        <MediaPlayer
          key={playing.id}
          pid={pid}
          item={playing}
          archived={archived}
          onClose={() => setPlaying(null)}
          onDeleted={onDeleted}
          refreshUrl={() => refreshUrl(playing)}
        />
      ) : null}
    </section>
  );
}
