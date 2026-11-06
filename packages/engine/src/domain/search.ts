import type { SearchResponse } from '../../../client/src/generated.ts';
import type { searchListings } from '../db/search.ts';
import { listingDetail } from './detail.ts';
import { searchCursor } from './search-query.ts';
import type { SearchContext } from './search-query.ts';
import { HttpProblem } from '../http/problem.ts';

export function listingSearch({ feeds, rows }: Awaited<ReturnType<typeof searchListings>>, context: SearchContext): SearchResponse {
  if ([...feeds, ...rows].some(row => row.expires_at.getTime() <= Date.now()))
    throw new HttpProblem(503, 'feed_expired', 'Listing data is temporarily unavailable.');
  if (!feeds.length || [...feeds, ...rows].some(row => row.rules_version !== '1'))
    throw new HttpProblem(503, 'display_rules_unavailable', 'Listing display rules are temporarily unavailable.');
  const listings = rows.slice(0, context.limit).map(listingDetail);
  const last = rows[Math.min(rows.length, context.limit) - 1];
  const hasMore = rows.length > context.limit;
  // Feed notices apply even to empty pages; listing page notices retain their order.
  const blocks = [...feeds.flatMap(feed => feed.display_blocks), ...listings.flatMap(item => item.display.blocks)];
  const unique = blocks.filter((block, index) => blocks.findIndex(value => JSON.stringify(value) === JSON.stringify(block)) === index);
  const earliest = (name: 'ingested_at' | 'refreshed_at' | 'expires_at') => new Date(Math.min(...feeds.map(feed => feed[name].getTime()))).toISOString();
  return {
    data: listings.map(item => item.data),
    meta: { page: { limit: context.limit, hasMore,
      nextCursor: hasMore ? searchCursor(context, { price: last.price, id: last.id }) : null } },
    display: { rulesVersion: '1', blocks: unique, siteChromeOutsideListingBody: true,
      freshness: { sourceUpdatedAt: null, ingestedAt: earliest('ingested_at'),
        refreshedAt: earliest('refreshed_at'), expiresAt: earliest('expires_at') } }
  };
}
