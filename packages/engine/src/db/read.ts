import type pg from 'pg';
import type { DisplayBlock, Listing } from '../../../client/src/generated.ts';
import { HttpProblem } from '../http/problem.ts';

export interface ListingRow {
  id: string; synthetic: boolean; status: string | null; price: string | null; currency: string | null;
  address: Listing['address']; bedrooms: string | null; images: Listing['images']; withheld_fields: string[];
  display_blocks: DisplayBlock[]; page_blocks: DisplayBlock[]; feed_blocks: DisplayBlock[];
  source_updated_at: Date | null; ingested_at: Date; refreshed_at: Date; expires_at: Date; rules_version: string;
}
export function repository(pool: pg.Pool) {
  async function query<T extends pg.QueryResultRow>(sql: string, values: string[]) {
    try { return (await pool.query<T>(sql, values)).rows; }
    catch { throw new HttpProblem(503, 'service_unavailable', 'The service is temporarily unavailable.'); }
  }
  return {
    async key(hash: string) {
      return (await query<{ site_id: string; scopes: string[] }>(
        'SELECT site_id, scopes FROM idx.site_secret_keys WHERE secret_hash = $1 AND revoked_at IS NULL', [hash]))[0];
    },
    async listing(site: string, id: string) {
      return (await query<ListingRow>(`SELECT l.id, l.synthetic, l.status, l.price::text, l.currency,
        l.address, l.bedrooms::text, l.images, l.withheld_fields, l.display_blocks, l.page_blocks,
        l.source_updated_at, l.ingested_at, f.refreshed_at, f.expires_at, f.rules_version,
        f.display_blocks AS feed_blocks
        FROM idx.listings l JOIN idx.source_mappings m ON m.listing_id = l.id
        JOIN idx.feeds f ON f.id = m.feed_id
        JOIN idx.data_licenses d ON d.feed_id = f.id AND d.site_id = $1
        WHERE l.id = $2 AND l.entire_listing_display`, [site, id]))[0];
    }
  };
}
export type Repository = ReturnType<typeof repository>;
