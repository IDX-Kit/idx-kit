import type { Problem } from "@idx-kit/client";
import { STATUS_CODES } from "node:http";

export class HttpProblem extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly operation?: string;
  readonly allowedMethod?: string;
  readonly retryAfter?: number;
  errors?: Problem["errors"];
  constructor(
    status: number,
    code: string,
    detail: string,
    options?: {
      cause?: unknown;
      operation?: string;
      allowedMethod?: string;
      retryAfter?: number;
    },
  ) {
    super(code, options);
    this.name = "HttpProblem";
    this.operation = options?.operation;
    this.allowedMethod = options?.allowedMethod;
    this.retryAfter = options?.retryAfter;
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}
export function problemResponse(error: unknown, requestId: string) {
  const { status, code, detail, allowedMethod, retryAfter } =
    error instanceof HttpProblem
      ? error
      : new HttpProblem(
          500,
          "internal_error",
          "The request could not be completed.",
        );
  const title = STATUS_CODES[status] ?? STATUS_CODES[500]!;
  const body: Problem = {
    type: "about:blank",
    title,
    status,
    detail,
    code,
    requestId,
    ...(error instanceof HttpProblem && error.errors
      ? { errors: error.errors }
      : {}),
  };
  const headers = new Headers({
    "Content-Type": "application/problem+json",
    "Cache-Control": "no-store",
  });
  if (status === 401) headers.set("WWW-Authenticate", "Bearer");
  if (allowedMethod) headers.set("Allow", allowedMethod);
  if (retryAfter !== undefined) headers.set("Retry-After", String(retryAfter));
  return Response.json(body, { status, headers });
}
