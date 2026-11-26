import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import pg from "pg";
import { ResoConnector } from "@idx-kit/engine/src/connectors/reso.ts";
import { listenOnLoopback } from "../api/loopback-server.ts";

interface Page {
  value: unknown[];
  "@odata.nextLink"?: string;
}

type Reply =
  | Page
  | { status: number; location?: string; retryAfter?: string }
  | "disconnect"
  | "invalid_json"
  | "stall";

export const propertyPath = "/feed/Property";

export async function connectWriter(t: TestContext) {
  assert.ok(process.env.LISTING_WRITER_DATABASE_URL);
  const client = new pg.Client({
    connectionString: process.env.LISTING_WRITER_DATABASE_URL,
  });
  await client.connect();
  t.after(() => client.end());
  return client;
}

export function countWriterStatements(t: TestContext, client: pg.Client) {
  const query = client.query.bind(client);
  const counter = t.mock.method(
    client,
    "query",
    (sql: string, values?: unknown[]) => query(sql, values),
  );
  return () => counter.mock.callCount();
}

export async function readOldestIngest(client: pg.Client, feedId: string) {
  const { rows } = await client.query<{
    stored: string | null;
    actual: string | null;
    conservative: boolean | null;
  }>(
    `SELECT oldest_listing_ingested_at::text AS stored, oldest.ingested_at::text AS actual,
      COALESCE(oldest_listing_ingested_at, refreshed_at) <= oldest.ingested_at AS conservative
    FROM idx.feeds f CROSS JOIN LATERAL (
      SELECT min(l.ingested_at) AS ingested_at FROM idx.source_mappings m
      JOIN idx.listings l ON l.id = m.listing_id
      WHERE m.feed_id = f.id AND l.entire_listing_display
    ) oldest WHERE f.id = $1`,
    [feedId],
  );
  return rows[0];
}

export function page(records: unknown[], nextLink?: string): Page {
  return { value: records, "@odata.nextLink": nextLink };
}

export async function standIn(
  t: TestContext,
  respond: (url: URL, requestNumber: number) => Reply | Promise<Reply>,
  timeoutMs?: number,
) {
  const token = "synthetic-feed-token";
  const calls: { path: string; query: string; authorized: boolean }[] = [];
  const server = await listenOnLoopback((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    calls.push({
      path: url.pathname,
      query: url.search,
      authorized: request.headers.authorization === `Bearer ${token}`,
    });
    async function reply() {
      const result = await respond(url, calls.length);
      if (result === "disconnect") {
        response.write('{"value":');
        setTimeout(() => response.destroy(), 25);
        return;
      }
      if (result === "stall") {
        response.write('{"value":');
        return;
      }
      if (result === "invalid_json") {
        response.end('{"value":');
        return;
      }
      if ("status" in result) {
        if (result.location) response.setHeader("Location", result.location);
        if (result.retryAfter !== undefined)
          response.setHeader("Retry-After", result.retryAfter);
        response.writeHead(result.status);
        response.end("synthetic response detail");
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(result));
    }
    void reply().catch(() => response.destroy());
  });
  t.after(() => server.close());
  return {
    connector: new ResoConnector(
      `${server.baseUrl}${propertyPath}`,
      token,
      timeoutMs,
    ),
    calls,
  };
}
