import assert from "node:assert/strict";
import type { InquiryInput } from "@idx-kit/client";
import { validateResponse } from "./contract.ts";

const path = "/api/v1/inquiries";

export async function postInquiry(
  secret: string,
  key: string,
  body: InquiryInput,
  status: number,
  { headers, signal }: { headers?: Record<string, string>; signal?: AbortSignal } = {},
) {
  const response = await fetch(`http://127.0.0.1:8787${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });
  assert.equal(response.status, status);
  const content = await response.json();
  validateResponse(path, response, content, false, "post");
  return { response, content };
}
