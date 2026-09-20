export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export const notFound = () => new HttpError(404, "not_found", "見つかりません");
export const badRequest = (message: string) => new HttpError(400, "validation", message);
