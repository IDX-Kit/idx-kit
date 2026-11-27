import { z } from "zod";
import { listingPageLimit } from "../db/listings.ts";
import type { ListingChange } from "../db/listings.ts";

const maxResponseBytes = 8 * 1024 * 1024;

const pageSchema = z.object({
  value: z.array(z.unknown()).max(listingPageLimit),
  "@odata.nextLink": z
    .string()
    .refine((link) => link.trim() !== "")
    .nullish(),
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
        typeof ModificationTimestamp === "string"
          ? ModificationTimestamp
          : null,
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
  | "page_too_large"
  | "continuation_rejected";

type PageResult =
  | { code: "page"; records: unknown[]; nextLink: string | null }
  | { code: FetchFailure; status?: number; afterSeconds?: number };

function retryAfterSeconds(response: Response) {
  if (response.status !== 429 && response.status !== 503) return;
  const header = response.headers.get("Retry-After");
  if (header !== null && /^\d+$/.test(header)) {
    return Math.min(86_400, Math.max(1, Number(header)));
  }
}

async function readPageText(response: Response) {
  const length = response.headers.get("Content-Length");
  if (
    length !== null &&
    /^\d+$/.test(length) &&
    Number(length) > maxResponseBytes
  ) {
    void response.body?.cancel().catch(() => {});
    return;
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  let buffer = new Uint8Array(0);
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return new TextDecoder().decode(buffer.subarray(0, size));
      const nextSize = size + value.byteLength;
      if (nextSize > maxResponseBytes) {
        void reader.cancel().catch(() => {});
        return;
      }
      if (nextSize > buffer.byteLength) {
        const capacity = Math.max(nextSize, buffer.byteLength * 2);
        const expanded = new Uint8Array(Math.min(capacity, maxResponseBytes));
        expanded.set(buffer);
        buffer = expanded;
      }
      buffer.set(value, size);
      size = nextSize;
    }
  } finally {
    reader.releaseLock();
  }
}

export function isResoAddress(url: URL) {
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  // Reject encoded path separators and nested escapes before comparing paths.
  return (
    (url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
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
    isResoAddress(target) &&
    target.origin === base.origin &&
    (target.pathname === base.pathname || target.pathname.startsWith(prefix))
  ) {
    return target;
  }
  return null;
}

export class ResoConnector {
  private readonly base: URL | null;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(
    baseAddress: string,
    token: string,
    timeoutMs = 30_000,
    pageSize?: number,
  ) {
    this.base = URL.parse(baseAddress);
    this.headers = { Authorization: `Bearer ${token}` };
    if (pageSize !== undefined) {
      this.headers.Prefer = `odata.maxpagesize=${pageSize}`;
    }
    this.timeoutMs = timeoutMs;
  }

  async readPage(
    completedMark: string | null,
    nextLink: string | null,
  ): Promise<PageResult> {
    if (!this.base || !isResoAddress(this.base))
      return { code: "invalid_link" };
    const url =
      nextLink === null
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
    let status: number | undefined;
    try {
      const response = await fetch(url, {
        headers: this.headers,
        redirect: "manual",
        signal,
      });
      status = response.status;
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (nextLink !== null && [400, 410].includes(status)) {
          return { code: "continuation_rejected", status };
        }
        return {
          code: "http_error",
          status,
          afterSeconds: retryAfterSeconds(response),
        };
      }
      const body = await readPageText(response);
      if (body === undefined) return { code: "page_too_large", status };
      const page = pageSchema.safeParse(JSON.parse(body));
      if (!page.success) return { code: "invalid_page", status };
      const link = page.data["@odata.nextLink"];
      const target = link ? continuation(this.base, link, url) : null;
      if (link && !target) return { code: "invalid_link", status };
      if (target?.pathname === url.pathname && target.search === url.search) {
        return { code: "invalid_page", status };
      }
      return {
        code: "page",
        records: page.data.value,
        nextLink: target?.href ?? null,
      };
    } catch (error) {
      if (signal.aborted) return { code: "fetch_timeout", status };
      if (error instanceof SyntaxError) return { code: "invalid_page", status };
      return { code: "fetch_failed", status };
    }
  }
}
