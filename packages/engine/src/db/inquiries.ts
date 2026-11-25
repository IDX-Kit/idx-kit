import { randomUUID } from "node:crypto";
import type { InquiryInput } from "@idx-kit/client";
import { readQuery } from "./read.ts";
import type { Database } from "./read.ts";

export interface InquiryRow {
  id: string;
  received_at: Date;
  body_hash: string;
}
export function inquiryQueries(pool: Database) {
  return {
    async inquiryByKey(site: string, key: string) {
      return (
        await readQuery<InquiryRow>(
          pool,
          "SELECT id, received_at, body_hash FROM idx.inquiries WHERE site_id=$1 AND idempotency_key=$2",
          [site, key],
          "inquiry.replay",
        )
      )[0];
    },
    async inquiryReceipt(site: string, id: string) {
      return (
        await readQuery<InquiryRow>(
          pool,
          "SELECT id, received_at FROM idx.inquiries WHERE site_id=$1 AND id=$2",
          [site, id],
          "inquiry.receipt",
        )
      )[0];
    },
    async insertInquiry(
      site: string,
      key: string,
      hash: string,
      input: InquiryInput,
    ) {
      return (
        await readQuery<InquiryRow>(
          pool,
          `INSERT INTO idx.inquiries
          (id, site_id, listing_id, visitor_name, visitor_email, message, context, idempotency_key, body_hash)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (site_id, idempotency_key) DO NOTHING
          RETURNING id, received_at, body_hash`,
          [
            `inq_${randomUUID()}`,
            site,
            input.listingId,
            input.visitor.name,
            input.visitor.email,
            input.message,
            JSON.stringify(input.context),
            key,
            hash,
          ],
          "inquiry.insert",
        )
      )[0];
    },
  };
}
