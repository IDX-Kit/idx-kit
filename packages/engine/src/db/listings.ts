import type pg from 'pg';
import type { NormalizedListing } from '../domain/normalize.ts';

// Every connector writes through this boundary. Source identity never enters the public facts.
export async function upsertListing(client: pg.Client, listing: NormalizedListing) {
  const mapping = await client.query<{ listing_id: string }>(
    'SELECT listing_id FROM idx.source_mappings WHERE feed_id = $1 AND source_key = $2',
    [listing.feedId, listing.sourceKey]);
  const id = mapping.rows[0]?.listing_id ?? listing.publicId;
  const facts = listing.facts;
  await client.query(`INSERT INTO idx.listings
    (id, synthetic, status, price, currency, address, bedrooms, images, withheld_fields,
     entire_listing_display, display_blocks, page_blocks, source_updated_at, ingested_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (id) DO UPDATE SET
      synthetic=EXCLUDED.synthetic, status=EXCLUDED.status, price=EXCLUDED.price,
      currency=EXCLUDED.currency, address=EXCLUDED.address, bedrooms=EXCLUDED.bedrooms,
      images=EXCLUDED.images, withheld_fields=EXCLUDED.withheld_fields,
      entire_listing_display=EXCLUDED.entire_listing_display, display_blocks=EXCLUDED.display_blocks,
      page_blocks=EXCLUDED.page_blocks, source_updated_at=EXCLUDED.source_updated_at,
      ingested_at=EXCLUDED.ingested_at`,
  [id, facts.synthetic, facts.status, facts.price?.amount ?? null, facts.price?.currency ?? null,
    facts.address === null ? null : JSON.stringify(facts.address), facts.bedrooms,
    facts.images === null ? null : JSON.stringify(facts.images), facts.withheldFields,
    listing.entireListingDisplay, JSON.stringify(listing.blocks), JSON.stringify(listing.pageBlocks),
    listing.sourceUpdatedAt, listing.ingestedAt]);
  await client.query(`INSERT INTO idx.source_mappings (feed_id, source_key, listing_id)
    VALUES ($1,$2,$3) ON CONFLICT (feed_id, source_key) DO NOTHING`, [listing.feedId, listing.sourceKey, id]);
}
