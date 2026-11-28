import type { SearchResponse } from "@idx-kit/client";
import type { searchListings } from "../db/search.ts";
import { listingData } from "./detail.ts";
import { searchCursor } from "./search-query.ts";
import type { SearchContext } from "./search-query.ts";
import { HttpProblem } from "../http/problem.ts";

export function listingSearch(
  { feeds, rows }: Awaited<ReturnType<typeof searchListings>>,
  context: SearchContext,
): SearchResponse {
  if (feeds.some((feed) => feed.expires_at.getTime() <= Date.now()))
    throw new HttpProblem(
      503,
      "feed_expired",
      "Listing data is temporarily unavailable.",
    );
  if (!feeds.length || feeds.some((feed) => feed.rules_version !== "1"))
    throw new HttpProblem(
      503,
      "display_rules_unavailable",
      "Listing display rules are temporarily unavailable.",
    );
  const page = rows.slice(0, context.limit);
  const last = page.at(-1);
  const hasMore = rows.length > context.limit;
  // Feed notices apply even to empty pages; listing page notices retain their order.
  const blocks = [
    ...feeds.flatMap((feed) => feed.display_blocks),
    ...page.flatMap((row) => row.page_blocks),
  ];
  const seen = new Set<string>();
  const unique = blocks.filter((block) => {
    const key = JSON.stringify(block);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const earliest = (name: "ingested_at" | "refreshed_at" | "expires_at") =>
    new Date(
      Math.min(...feeds.map((feed) => feed[name].getTime())),
    ).toISOString();
  return {
    data: page.map(listingData),
    meta: {
      page: {
        limit: context.limit,
        hasMore,
        nextCursor:
          hasMore && last
            ? searchCursor(context, { price: last.price, id: last.id })
            : null,
      },
    },
    display: {
      rulesVersion: "1",
      blocks: unique,
      siteChromeOutsideListingBody: true,
      freshness: {
        sourceUpdatedAt: null,
        ingestedAt: earliest("ingested_at"),
        refreshedAt: earliest("refreshed_at"),
        expiresAt: earliest("expires_at"),
      },
    },
  };
}
