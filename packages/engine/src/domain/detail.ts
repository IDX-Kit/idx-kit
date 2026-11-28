import type { Display, DisplayBlock, ListingResponse } from "@idx-kit/client";
import type { ListingRow } from "../db/read.ts";
import { HttpProblem } from "../http/problem.ts";

type ListingDataRow = Omit<ListingRow, "feed_blocks">;

function listingDisplay(
  row: ListingDataRow,
  blocks: DisplayBlock[],
  sourceUpdatedAt: string | null,
): Display {
  const rulesVersion = row.rules_version;
  if (rulesVersion !== "1")
    throw new HttpProblem(
      503,
      "display_rules_unavailable",
      "Listing display rules are temporarily unavailable.",
    );
  return {
    blocks,
    rulesVersion,
    siteChromeOutsideListingBody: true,
    freshness: {
      sourceUpdatedAt,
      ingestedAt: row.ingested_at.toISOString(),
      refreshedAt: row.refreshed_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
    },
  };
}

export function listingData(row: ListingDataRow): ListingResponse["data"] {
  const withheldFields = row.withheld_fields;
  let images = row.images;
  if (withheldFields.includes("address")) {
    images = withheldFields.includes("images") ? null : [];
  }
  return {
    id: row.id,
    synthetic: row.synthetic,
    status: row.status,
    price:
      row.price === null
        ? null
        : { amount: row.price, currency: row.currency! },
    address: row.address,
    bedrooms: row.bedrooms === null ? null : Number(row.bedrooms),
    images,
    withheldFields,
    display: listingDisplay(
      row,
      row.display_blocks,
      row.source_updated_at?.toISOString() ?? null,
    ),
  };
}

export function listingDetail(row: ListingRow): ListingResponse {
  return {
    data: listingData(row),
    meta: {},
    display: listingDisplay(
      row,
      [...row.feed_blocks, ...row.page_blocks],
      null,
    ),
  };
}
