// 送る前に端末で長さを測り、動画は最初のコマをサムネイルにする。取れなくても送信は止めない。
import type { MediaKind } from "../../shared/types";
import { fitWithin, THUMB_MAX } from "../images/resize";

const TIMEOUT_MS = 5000;
const THUMB_QUALITY = 0.7;
const THUMB_BYTES = 200 * 1024;

function withElement<T>(
  file: Blob,
  kind: MediaKind,
  run: (el: HTMLMediaElement, done: (v: T) => void) => void,
  fallback: T,
): Promise<T> {
  return new Promise<T>((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement(kind === "video" ? "video" : "audio");
    let finished = false;
    const done = (v: T) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      el.removeAttribute("src");
      el.load();
      URL.revokeObjectURL(url);
      resolve(v);
    };
    const timer = window.setTimeout(() => done(fallback), TIMEOUT_MS);
    el.preload = "metadata";
    el.muted = true;
    if (el instanceof HTMLVideoElement) el.playsInline = true;
    el.onerror = () => done(fallback);
    run(el, done);
    el.src = url;
  });
}

export function readDurationMs(file: Blob, kind: MediaKind): Promise<number | null> {
  return withElement<number | null>(
    file,
    kind,
    (el, done) => {
      el.onloadedmetadata = () => {
        const d = el.duration;
        done(Number.isFinite(d) && d >= 0 ? Math.min(Math.round(d * 1000), 3_600_000) : null);
      };
    },
    null,
  );
}

export function captureVideoThumb(file: Blob): Promise<Blob | null> {
  return withElement<Blob | null>(
    file,
    "video",
    (el, done) => {
      const video = el as HTMLVideoElement;
      video.preload = "auto";
      video.onloadeddata = () => {
        video.currentTime = Math.min(0.1, Number.isFinite(video.duration) ? video.duration / 2 : 0.1);
      };
      video.onseeked = () => {
        const size = fitWithin(video.videoWidth, video.videoHeight, THUMB_MAX);
        if (!size.width || !size.height) return done(null);
        const canvas = document.createElement("canvas");
        canvas.width = size.width;
        canvas.height = size.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return done(null);
        ctx.drawImage(video, 0, 0, size.width, size.height);
        canvas.toBlob((blob) => done(blob && blob.size <= THUMB_BYTES ? blob : null), "image/jpeg", THUMB_QUALITY);
      };
    },
    null,
  );
}
