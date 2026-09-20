import { ApiError } from "../api";

export function ErrorView({ error }: { error: unknown }) {
  const message =
    error instanceof ApiError && error.status === 404
      ? "見つからないか、参加していません"
      : error instanceof ApiError || error instanceof Error
        ? error.message
        : "エラーが発生しました";
  return (
    <div className="error-view" role="alert">
      <p>{message}</p>
    </div>
  );
}
