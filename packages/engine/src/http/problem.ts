import type { Problem } from "@idx-kit/client";
import { STATUS_CODES } from "node:http";

export class HttpProblem extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly operation?: string;
  constructor(status: number, code: string, detail: string, options?: { cause: unknown; operation: string }) {
    super(code, options);
    this.name = "HttpProblem";
    this.operation = options?.operation;
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}
export function problemResponse(error: unknown, requestId: string) {
  const { status, code, detail } =
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
  };
  const headers = new Headers({
    "Content-Type": "application/problem+json",
    "Cache-Control": "no-store",
  });
  if (status === 401) headers.set("WWW-Authenticate", "Bearer");
  if (status === 405) headers.set("Allow", "GET");
  return Response.json(body, { status, headers });
}
