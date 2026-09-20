import { useEffect, useState, type ChangeEvent } from "react";
import type { TaskFile } from "../../shared/types";
import { api, ApiError, apiSendFile } from "../api";
import { FILE_ACCEPT, fileFormatMessage, fileIcon, fileSizeMessage, formatFileSize, MAX_FILES } from "../files/format";
import { openExternal } from "../liff";

const LIMIT_MESSAGE = "ファイルは 5 つまでです";

function listPath(pid: string, taskId: string): string {
  return `/api/projects/${pid}/tasks/${encodeURIComponent(taskId)}/files`;
}

function errorMessage(e: unknown): string {
  return e instanceof ApiError ? e.message : "エラーが発生しました";
}

// LIFF の openWindow は絶対 URL でないと開けない端末があるので、ここで絶対化する
function toAbsoluteUrl(url: string): string {
  return new URL(url, location.origin).toString();
}

export function TaskFilesSection({
  pid,
  taskId,
  archived,
  disabled,
  ensureTaskId,
  onChanged,
}: {
  pid: string;
  taskId: string | null;
  archived: boolean;
  disabled: boolean;
  ensureTaskId: () => Promise<string | null>;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<TaskFile[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number; percent: number } | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!taskId) {
      setItems([]);
      return;
    }
    let cancelled = false;
    setListError(null);
    api<TaskFile[]>("GET", listPath(pid, taskId))
      .then((list) => {
        if (!cancelled) setItems(list);
      })
      .catch(() => {
        if (!cancelled) setListError("ファイルを読み込めませんでした");
      });
    return () => {
      cancelled = true;
    };
  }, [pid, taskId, reloadTick]);

  const full = items.length >= MAX_FILES;
  const addDisabled = busy || disabled || full;

  async function uploadOne(id: string, file: File, index: number, total: number): Promise<void> {
    const badFormat = fileFormatMessage(file.name);
    if (badFormat) throw new Error(badFormat);
    const tooBig = fileSizeMessage(file.size);
    if (tooBig) throw new Error(tooBig);

    setProgress({ current: index + 1, total, percent: 0 });
    const q = new URLSearchParams({ name: file.name });
    const saved = await apiSendFile<TaskFile>("POST", `${listPath(pid, id)}?${q}`, file, (ratio) =>
      setProgress({ current: index + 1, total, percent: Math.round(ratio * 100) }),
    );
    setItems((prev) => (prev.some((f) => f.id === saved.id) ? prev : [...prev, saved]));
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
      const room = Math.max(0, MAX_FILES - items.length);
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

  async function onDelete(file: TaskFile) {
    if (!window.confirm(`${file.name} を削除しますか？`)) return;
    setBusy(true);
    setErrors([]);
    try {
      await api<void>("DELETE", `/api/projects/${pid}/files/${encodeURIComponent(file.id)}`);
      setReloadTick((n) => n + 1);
      onChanged();
    } catch (e) {
      setErrors([errorMessage(e)]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="files-section">
      <h2>
        ファイル（{items.length}/{MAX_FILES}）
      </h2>
      {listError ? <p className="error">{listError}</p> : null}
      {items.length > 0 ? (
        <ul className="file-list">
          {items.map((f) => (
            <li key={f.id} className="file-row">
              <button type="button" className="file-open tap" onClick={() => openExternal(toAbsoluteUrl(f.url))}>
                <span className="file-icon" aria-hidden="true">
                  {fileIcon(f.name)}
                </span>
                <span className="file-name">{f.name}</span>
                <span className="file-size muted">{formatFileSize(f.size)}</span>
              </button>
              {!archived ? (
                <button
                  type="button"
                  className="btn file-delete"
                  onClick={() => onDelete(f)}
                  disabled={busy || disabled}
                  aria-label={`${f.name} を削除`}
                >
                  🗑
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {!archived ? (
        <>
          <label className={`btn image-add${addDisabled ? " is-disabled" : ""}`} aria-disabled={addDisabled}>
            ＋ ファイルを追加
            <input type="file" accept={FILE_ACCEPT} multiple hidden disabled={addDisabled} onChange={onSelect} />
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
    </section>
  );
}
