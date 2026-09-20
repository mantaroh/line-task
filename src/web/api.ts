import type { ApiErrorBody, SessionResponse } from "../shared/types";

const SESSION_KEY = "ltb-session";

export class ApiError extends Error {
  status: number;
  code: string;
  body: ApiErrorBody;
  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = "ApiError";
    this.status = status;
    this.code = body.error;
    this.body = body;
  }
}

let idTokenProvider: (() => Promise<string>) | null = null;

export function setIdTokenProvider(fn: () => Promise<string>): void {
  idTokenProvider = fn;
}

async function toApiError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
  if (body && typeof body.error === "string" && typeof body.message === "string") {
    return new ApiError(res.status, body);
  }
  return new ApiError(res.status, { error: "http", message: "エラーが発生しました" });
}

async function readResponse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

async function postSession(idToken: string): Promise<SessionResponse> {
  const res = await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  const data = await readResponse<SessionResponse>(res);
  sessionStorage.setItem(SESSION_KEY, data.token);
  return data;
}

async function refreshSession(): Promise<string> {
  if (!idTokenProvider) throw new Error("idToken provider is not set");
  const sess = await postSession(await idTokenProvider());
  return sess.token;
}

async function send(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  token: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

export async function api<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  if (method === "POST" && path === "/api/session") {
    const idToken =
      body && typeof body === "object" && "idToken" in body ? (body as { idToken: unknown }).idToken : undefined;
    if (typeof idToken !== "string" || idToken.length === 0) {
      throw new ApiError(400, { error: "validation", message: "idToken を指定してください" });
    }
    return (await postSession(idToken)) as T;
  }

  return readResponse<T>(await authed((token) => send(method, path, token, body)));
}

// 認証付きで送り、401 ならセッションを取り直して 1 回だけ送り直す
async function authed(run: (token: string) => Promise<Response>): Promise<Response> {
  const token = sessionStorage.getItem(SESSION_KEY) ?? (await refreshSession());
  const res = await run(token);
  if (res.status !== 401) return res;
  return run(await refreshSession());
}

export async function apiBlob(path: string): Promise<Blob> {
  const res = await authed((token) => fetch(path, { headers: { Authorization: `Bearer ${token}` } }));
  if (!res.ok) throw await toApiError(res);
  return res.blob();
}

// Content-Type は付けない（multipart の境界はブラウザが決める）
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const res = await authed((token) =>
    fetch(path, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form }),
  );
  return readResponse<T>(res);
}

// 動画・音声のように大きなファイルは、進み具合を出すため XMLHttpRequest で送る（fetch では送信の進み具合が取れない）
function xhrSend(
  method: "POST" | "PUT",
  path: string,
  token: string,
  body: Blob,
  onProgress?: (ratio: number) => void,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, path);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("Content-Type", body.type || "application/octet-stream");
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
      };
    }
    xhr.onload = () => {
      const noBody = xhr.status === 204 || xhr.status === 304;
      resolve(
        new Response(noBody ? null : xhr.responseText, {
          status: xhr.status,
          headers: { "Content-Type": xhr.getResponseHeader("Content-Type") ?? "application/json" },
        }),
      );
    };
    const failed = () => reject(new ApiError(0, { error: "network", message: "送信に失敗しました。もう一度試してください" }));
    xhr.onerror = failed;
    xhr.onabort = failed;
    xhr.send(body);
  });
}

export async function apiSendFile<T>(
  method: "POST" | "PUT",
  path: string,
  body: Blob,
  onProgress?: (ratio: number) => void,
): Promise<T> {
  return readResponse<T>(await authed((token) => xhrSend(method, path, token, body, onProgress)));
}
