import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { z } from "zod";
import type { InquiryInput, ReceiptResponse } from "@idx-kit/client";
import type { Repository } from "../db/read.ts";
import type { InquiryRow, ReceiptRow } from "../db/inquiries.ts";
import { HttpProblem } from "../http/problem.ts";

const sitePath = z
  .string()
  .min(1)
  .max(256)
  .regex(/^\/[A-Za-z0-9/_-]*$/);
const token = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_-]+$/);
export const inquirySchema = z.strictObject({
  listingId: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_-]+$/),
  visitor: z.strictObject({
    name: z.string().min(1).max(100),
    email: z.email().min(3).max(254),
  }),
  message: z.string().min(1).max(4000),
  context: z.strictObject({
    pagePath: sitePath,
    landingPagePath: sitePath.optional(),
    campaign: token.optional(),
    source: token.optional(),
    medium: token.optional(),
  }),
});
export const inquiryHeaders = z.object({
  "idempotency-key": z
    .string()
    .regex(
      /^"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"$/,
    ),
});
export function invalidInquiry(issues: z.core.$ZodIssue[]) {
  const problem = new HttpProblem(
    422,
    "invalid_input",
    "Check the inquiry fields.",
  );
  problem.errors = issues.map((issue) => ({
    pointer:
      "/" +
      issue.path
        .map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1"))
        .join("/"),
    detail: "Use a valid value for this field.",
  }));
  return problem;
}
export function receipt(row: ReceiptRow): ReceiptResponse {
  return {
    data: { id: row.id, receivedAt: row.received_at.toISOString() },
    meta: {},
  };
}
export async function createInquiry(
  db: Repository,
  site: string,
  key: string,
  input: InquiryInput,
) {
  const hash = createHash("sha256").update(canonicalize(input)!).digest("hex");
  const compare = (row: InquiryRow) => {
    if (row.body_hash !== hash)
      throw new HttpProblem(
        422,
        "idempotency_mismatch",
        "This action has different inquiry fields.",
      );
    return row;
  };
  const existing = await db.inquiryByKey(site, key);
  if (existing) return { row: compare(existing) };
  const listing = await db.listing(site, input.listingId);
  if (!listing)
    throw new HttpProblem(404, "not_found", "The resource was not found.");
  const inserted = await db.insertInquiry(site, key, hash, input);
  if (inserted) return { row: inserted, listing };
  // A new statement gets a fresh Read Committed snapshot after the insert waits.
  const committed = await db.inquiryByKey(site, key);
  if (committed) return { row: compare(committed) };
  throw new HttpProblem(
    503,
    "service_unavailable",
    "Retry the same action when the service is available.",
  );
}
