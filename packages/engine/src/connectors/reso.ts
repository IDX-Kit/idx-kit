import { z } from "zod";
import { listingPageLimit } from "../db/listings.ts";
import type { ListingChange } from "../db/listings.ts";

const pageSchema = z.object({
  value: z.array(z.unknown()).max(listingPageLimit),
  "@odata.nextLink": z.string().min(1).nullish(),
});

const recordSchema = z.object({
  ListingKey: z.unknown().optional(),
  ModificationTimestamp: z.unknown().optional(),
  StandardStatus: z.unknown().optional(),
  ListPrice: z.unknown().optional(),
  BedroomsTotal: z.unknown().optional(),
  Address: z.unknown().optional(),
  Images: z.unknown().optional(),
  InternetAddressDisplayYN: z.unknown().optional(),
  InternetEntireListingDisplayYN: z.unknown().optional(),
});

type Upsert = Extract<ListingChange, { kind: "upsert" }>;
type ListingMetadata = Omit<Upsert["listing"], "source" | "sourceUpdatedAt">;

export function mapResoRecord(value: unknown, metadata: ListingMetadata) {
  const record = recordSchema.safeParse(value);
  const { ListingKey, ModificationTimestamp, ...source } = record.success
    ? record.data
    : {};
  const change: Upsert = {
    kind: "upsert",
    sourceKey: typeof ListingKey === "string" ? ListingKey : "",
    revision:
      typeof ModificationTimestamp === "string" ? ModificationTimestamp : "",
    listing: {
      ...metadata,
      sourceUpdatedAt:
        typeof ModificationTimestamp === "string" ? ModificationTimestamp : null,
      // The writer checks the facts and hides records it cannot normalize.
      source: source as Upsert["listing"]["source"],
    },
  };
  return change;
}

type FetchFailure =
  | "invalid_link"
  | "fetch_failed"
  | "fetch_timeout"
  | "http_error"
  | "invalid_page"
  | "continuation_rejected";

type PageResult =
  | { code: "page"; records: unknown[]; nextLink: string | null }
  | { code: FetchFailure };

function safeAddress(url: URL) {
  // Reject encoded path separators and nested escapes before comparing paths.
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    !url.username &&
    !url.password &&
    !url.hash &&
    !/%(?:2f|5c|25)/i.test(url.pathname)
  );
}

function continuation(base: URL, link: string, from: URL) {
  const target = URL.parse(link, from);
  const prefix = base.pathname.endsWith("/")
    ? base.pathname
    : `${base.pathname}/`;
  if (
    target &&
    safeAddress(target) &&
    target.origin === base.origin &&
    (target.pathname === base.pathname || target.pathname.startsWith(prefix))
  ) {
    return target;
  }
  return null;
}

export class ResoConnector {
  private readonly base: URL | null;

  constructor(
    baseAddress: string,
    private readonly token: string,
    private readonly timeoutMs = 30_000,
  ) {
    this.base = URL.parse(baseAddress);
  }

  async readPage(
    completedMark: string | null,
    nextLink: string | null,
  ): Promise<PageResult> {
    if (!this.base || !safeAddress(this.base)) return { code: "invalid_link" };
    const url = nextLink === null
      ? new URL(this.base)
      : continuation(this.base, nextLink, this.base);
    if (!url) return { code: "invalid_link" };
    if (nextLink === null && completedMark !== null) {
      url.searchParams.append(
        "$filter",
        `ModificationTimestamp ge ${completedMark}`,
      );
    }

    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.token}` },
        redirect: "manual",
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (nextLink !== null && [400, 410].includes(response.status)) {
          return { code: "continuation_rejected" };
        }
        return { code: "http_error" };
      }
      const page = pageSchema.safeParse(await response.json());
      if (!page.success) return { code: "invalid_page" };
      const link = page.data["@odata.nextLink"];
      const target = link ? continuation(this.base, link, url) : null;
      if (link && !target) return { code: "invalid_link" };
      return {
        code: "page",
        records: page.data.value,
        nextLink: target?.href ?? null,
      };
    } catch (error) {
      if (signal.aborted) return { code: "fetch_timeout" };
      if (error instanceof SyntaxError) return { code: "invalid_page" };
      return { code: "fetch_failed" };
    }
  }
}
