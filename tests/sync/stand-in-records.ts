import {
  listingPageLimit,
  revisionKey,
} from "@idx-kit/engine/src/db/listings.ts";
import { timestampSchema } from "@idx-kit/engine/src/domain/normalize.ts";

interface Page {
  value: unknown[];
  "@odata.nextLink"?: string;
}

export interface FeedRecords {
  length: number;
  revision?: string;
  slice(start: number, end: number): unknown[];
}

export const propertyPath = "/feed/Property";
export const initialRevision = "2026-11-03T00:00:00.000001Z";
export const sourceKey = (n: number) =>
  `Synthetic volume ${String(n).padStart(6, "0")}`;

export function page(records: unknown[], nextLink?: string): Page {
  return { value: records, "@odata.nextLink": nextLink };
}

export function pageRecords(
  records: FeedRecords,
  url: URL,
  prefer: string | null | undefined,
) {
  const filter = url.searchParams.get("$filter");
  if (records.revision !== undefined && filter !== null) {
    const mark = /^ModificationTimestamp ge (.+)$/.exec(filter)?.[1];
    const parsed = timestampSchema.safeParse(mark);
    const key = parsed.success ? revisionKey(parsed.data) : null;
    // These records are immutable, so a completed revision has no new changes.
    if (key === null || records.revision <= key) return page([]);
  }
  const start = Number(url.searchParams.get("cursor"));
  if (!Number.isSafeInteger(start) || start < 0) return page([]);
  const size = prefer?.match(/^odata\.maxpagesize=([1-9]\d*)$/)?.[1];
  const limit = size
    ? Math.min(Number(size), listingPageLimit)
    : listingPageLimit;
  const end = Math.min(start + limit, records.length);
  if (start >= end) return page([]);
  const next = new URLSearchParams({ cursor: String(end) });
  if (records.revision !== undefined && filter !== null)
    next.set("$filter", filter);
  return page(
    records.slice(start, end),
    end < records.length ? `?${next}` : undefined,
  );
}

export function heavyRecords(source: object, count: number) {
  const heavySource = {
    ...source,
    PublicRemarks:
      "Invented property remarks for the page cost measurement. ".repeat(80),
    Images: Array.from({ length: 40 }, (_, index) => ({
      alt: `Invented property photo ${index + 1}`,
      url: `https://images.example.test/property/${index + 1}.jpg`,
    })),
  };
  return {
    length: count,
    revision: initialRevision,
    slice(start: number, end: number) {
      return Array.from({ length: end - start }, (_, index) => ({
        ...heavySource,
        ListingKey: sourceKey(start + index + 1),
        ModificationTimestamp: initialRevision,
      }));
    },
  };
}
