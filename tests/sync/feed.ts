import type { TestContext } from "node:test";
import { ResoConnector } from "@idx-kit/engine/src/connectors/reso.ts";
import { listenOnLoopback } from "../api/loopback-server.ts";

interface Page {
  value: unknown[];
  "@odata.nextLink"?: string;
}

type Reply =
  | Page
  | { status: number; location?: string }
  | "disconnect"
  | "invalid_json"
  | "stall";

export const propertyPath = "/feed/Property";

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
