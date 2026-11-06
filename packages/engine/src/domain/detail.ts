import type { Display, DisplayBlock, ListingResponse } from '../../../client/src/generated.ts';
import type { ListingRow } from '../db/read.ts';
import { HttpProblem } from '../http/problem.ts';

export function listingDetail(row: ListingRow): ListingResponse {
  const rulesVersion = row.rules_version;
  if (rulesVersion !== '1') throw new HttpProblem(503, 'display_rules_unavailable', 'Listing display rules are temporarily unavailable.');
  const display = (blocks: DisplayBlock[], sourceUpdatedAt: string | null): Display => ({
    blocks, rulesVersion, siteChromeOutsideListingBody: true,
    freshness: { sourceUpdatedAt, ingestedAt: row.ingested_at.toISOString(),
      refreshedAt: row.refreshed_at.toISOString(), expiresAt: row.expires_at.toISOString() }
  });
  const withheld = (name: string) => row.withheld_fields.includes(name);
  return {
    data: {
      id: row.id, synthetic: row.synthetic,
      status: withheld('status') ? null : row.status,
      price: withheld('price') || row.price === null ? null : { amount: row.price, currency: row.currency! },
      address: withheld('address') ? null : row.address,
      bedrooms: withheld('bedrooms') || row.bedrooms === null ? null : Number(row.bedrooms),
      images: withheld('images') ? null : row.images,
      withheldFields: row.withheld_fields,
      display: display(row.display_blocks, row.source_updated_at?.toISOString() ?? null)
    },
    meta: {}, display: display([...row.feed_blocks, ...row.page_blocks], null)
  };
}
