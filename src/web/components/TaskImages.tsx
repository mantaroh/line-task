import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { TaskImage } from "../../shared/types";
import { api, apiBlob, ApiError, apiUpload } from "../api";
import { ImageReadError, prepareImage } from "../images/resize";

const MAX_IMAGES = 5;
const LIMIT_MESSAGE = "画像は 5 枚までです";
const THUMB_PARALLEL = 5;

function uploadErrorMessage(e: unknown): string {
  if (e instanceof ImageReadError) return e.message;
  if (e instanceof ApiError) return e.message;
  return "エラーが発生しました";
}

function ImageViewer({
  pid,
  image,
  archived,
  onClose,
  onDeleted,
}: {
  pid: string;
  image: TaskImage;
  archived: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    apiBlob(`/api/projects/${pid}/images/${encodeURIComponent(image.id)}`)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setError("画像を読み込めませんでした");
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [pid, image.id]);

  // 親の再描画のたびに閉じる処理が変わっても、フォーカスは開いたときの 1 回だけ移す
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function onDelete() {
    if (!window.confirm("この画像を削除しますか？")) return;
    setBusy(true);
    setError(null);
    try {
      await api<void>("DELETE", `/api/projects/${pid}/images/${encodeURIComponent(image.id)}`);
      onDeleted();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "エラーが発生しました");
      setBusy(false);
    }
  }

  return (
    <div
      className="image-viewer"
      role="dialog"
      aria-modal="true"
      aria-label="画像の拡大表示"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="image-viewer-body"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {url ? <img src={url} alt="タスクの画像" /> : error ? null : <p className="image-viewer-note">読み込み中…</p>}
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

export function TaskImages({
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
  const [images, setImages] = useState<TaskImage[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [viewing, setViewing] = useState<TaskImage | null>(null);

  // 画像 ID → object URL。一覧から消えたものと、区画が消えたときに解放する
  const urlsRef = useRef(new Map<string, string>());
  const loadingRef = useRef(new Set<string>());
  const currentIdsRef = useRef(new Set<string>());
  const mountedRef = useRef(true);

  useEffect(() => {
    if (!taskId) {
      setImages([]);
      return;
    }
    let cancelled = false;
    setListError(null);
    api<TaskImage[]>("GET", `/api/projects/${pid}/tasks/${encodeURIComponent(taskId)}/images`)
      .then((list) => {
        if (!cancelled) setImages(list);
      })
      .catch(() => {
        if (!cancelled) setListError("画像を読み込めませんでした");
      });
    return () => {
      cancelled = true;
    };
  }, [pid, taskId, reloadTick]);

  useEffect(() => {
    mountedRef.current = true;
    const urls = urlsRef.current;
    return () => {
      mountedRef.current = false;
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  useEffect(() => {
    const urls = urlsRef.current;
    const loading = loadingRef.current;
    const ids = new Set(images.map((i) => i.id));
    currentIdsRef.current = ids;
    for (const [id, url] of urls) {
      if (!ids.has(id)) {
        URL.revokeObjectURL(url);
        urls.delete(id);
      }
    }
    const queue = images.filter((i) => !urls.has(i.id) && !loading.has(i.id));
    const publish = () => setThumbs(Object.fromEntries(urls));
    publish();
    if (queue.length === 0) return;
    for (const i of queue) loading.add(i.id);

    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const id = next.id;
        try {
          const blob = await apiBlob(`/api/projects/${pid}/images/${encodeURIComponent(id)}?size=thumb`);
          const url = URL.createObjectURL(blob);
          if (!mountedRef.current || !currentIdsRef.current.has(id)) {
            URL.revokeObjectURL(url);
          } else {
            urls.set(id, url);
            publish();
          }
        } catch {
          // 読めなかったサムネイルは枠だけ出す
        } finally {
          loading.delete(id);
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(THUMB_PARALLEL, queue.length) }, worker));
  }, [pid, images]);

  const full = images.length >= MAX_IMAGES;
  const addDisabled = busy || disabled || full;

  async function onSelect(e: ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const files = Array.from(input.files ?? []);
    // 同じファイルをもう一度選べるように空にする
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
      const room = Math.max(0, MAX_IMAGES - images.length);
      const targets = files.slice(0, room);
      if (files.length > room) {
        errs.push(LIMIT_MESSAGE);
        setErrors([...errs]);
      }
      for (const [index, file] of targets.entries()) {
        setProgress({ current: index + 1, total: targets.length });
        try {
          const prepared = await prepareImage(file);
          const form = new FormData();
          form.append("image", prepared.image, "image.jpg");
          form.append("thumb", prepared.thumb, "thumb.jpg");
          form.append("width", String(prepared.width));
          form.append("height", String(prepared.height));
          const saved = await apiUpload<TaskImage>(
            `/api/projects/${pid}/tasks/${encodeURIComponent(id)}/images`,
            form,
          );
          added += 1;
          setImages((prev) => (prev.some((i) => i.id === saved.id) ? prev : [...prev, saved]));
        } catch (err) {
          errs.push(`${file.name}：${uploadErrorMessage(err)}`);
          setErrors([...errs]);
        }
      }
    } catch (err) {
      setErrors([uploadErrorMessage(err)]);
    } finally {
      setProgress(null);
      setBusy(false);
      if (added > 0) {
        setReloadTick((n) => n + 1);
        onChanged();
      }
    }
  }

  function onDeleted() {
    setViewing(null);
    setReloadTick((n) => n + 1);
    onChanged();
  }

  return (
    <section className="images-section">
      <h2>画像（{images.length}）</h2>
      {listError ? <p className="error">{listError}</p> : null}
      {images.length > 0 ? (
        <ul className="image-grid">
          {images.map((img) => (
            <li key={img.id}>
              <button type="button" className="image-thumb" onClick={() => setViewing(img)} aria-label="画像を拡大">
                {thumbs[img.id] ? <img src={thumbs[img.id]} alt="" /> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {!archived ? (
        <>
          <label className={`btn image-add${addDisabled ? " is-disabled" : ""}`} aria-disabled={addDisabled}>
            ＋ 画像を追加
            <input type="file" accept="image/*" multiple hidden disabled={addDisabled} onChange={onSelect} />
          </label>
          {progress ? (
            <p className="hint" role="status">
              {progress.current}/{progress.total} を送信中
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
      {viewing ? (
        <ImageViewer
          pid={pid}
          image={viewing}
          archived={archived}
          onClose={() => setViewing(null)}
          onDeleted={onDeleted}
        />
      ) : null}
    </section>
  );
}
