import { Hono } from "hono";
import type { DiscoveryResponse } from "@idx-kit/client/src/generated.ts";
import type { Repository } from "../db/read.ts";
import { listingDetail } from "../domain/detail.ts";
import { listingSearch } from "../domain/search.ts";
import { searchQuery } from "../domain/search-query.ts";
import { hashSecret } from "../domain/keys.ts";
import { HttpProblem, problemResponse } from "./problem.ts";

export function createApp(
  db: Repository,
  contract: unknown,
  release: string,
  log: (line: string) => void,
) {
  const app = new Hono<{
    Variables: { requestId: string; code: string; route: string };
  }>();
  app.use("*", async (c, next) => {
    const started = performance.now();
    c.set("requestId", crypto.randomUUID());
    c.set("code", "ok");
    c.set("route", "/api/*");
    await next();
    c.header("Request-Id", c.get("requestId"));
    if (!c.res.headers.has("Cache-Control"))
      c.header("Cache-Control", "no-store");
    const method = [
      "GET",
      "HEAD",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ].includes(c.req.method)
      ? c.req.method
      : "OTHER";
    log(
      JSON.stringify({
        method,
        route: c.get("route"),
        status: c.res.status,
        code: c.get("code"),
        duration: Math.round((performance.now() - started) * 1000) / 1000,
        requestId: c.get("requestId"),
        engineRelease: release,
      }),
    );
  });
  app.onError((error, c) => {
    c.set("code", error instanceof HttpProblem ? error.code : "internal_error");
    return problemResponse(error, c.get("requestId"));
  });
  app.all("*", async (c) => {
    const url = new URL(c.req.url);
    const path = url.pathname;
    const detail = /^\/api\/v1\/listings\/([^/]+)$/.exec(path);
    const search = path === "/api/v1/listings";
    const known =
      path === "/api" || path === "/api/v1/openapi.json" || search || detail;
    if (known) c.set("route", detail ? "/api/v1/listings/{listingId}" : path);
    if (
      c.req.header("Origin") !== undefined &&
      /^Bearer\s/i.test(c.req.header("Authorization") ?? "")
    )
      throw new HttpProblem(
        403,
        "origin_forbidden",
        "Secret keys cannot be used with an Origin header.",
      );
    if (!known) {
      if (/^\/api\/(listings|inquiries)(\/|$)/.test(path))
        throw new HttpProblem(
          400,
          "api_version_required",
          "Use an explicit API version.",
        );
      if (/^\/api\/v[0-9]+(\/|$)/.test(path) && !/^\/api\/v1(\/|$)/.test(path))
        throw new HttpProblem(
          404,
          "api_version_unsupported",
          "This API version is not supported.",
        );
      throw new HttpProblem(404, "not_found", "The resource was not found.");
    }
    if (c.req.method !== "GET")
      throw new HttpProblem(
        405,
        "method_not_allowed",
        "Use GET on this resource.",
      );
    if (
      new TextEncoder().encode(url.search.slice(1)).byteLength > 2048 ||
      (!search && url.searchParams.size)
    )
      throw new HttpProblem(
        400,
        "invalid_query",
        "The query string is not supported.",
      );
    if (path === "/api") {
      const body: DiscoveryResponse = {
        data: {
          engineVersion: release,
          supportedVersions: [
            {
              major: "v1",
              contractVersion: "1.0.0",
              capabilities: [
                "listingSearch",
                "listingDetail",
                "displayRulesV1",
              ],
            },
          ],
        },
        meta: {},
      };
      return Response.json(body);
    }
    if (path === "/api/v1/openapi.json") return Response.json(contract);
    const token = /^Bearer ([^\s,]+)$/i.exec(
      c.req.header("Authorization") ?? "",
    )?.[1];
    const key = token ? await db.key(await hashSecret(token)) : undefined;
    if (!key)
      throw new HttpProblem(
        401,
        "unauthorized",
        "A valid secret key is required.",
      );
    if (!key.scopes.includes("listings:read"))
      throw new HttpProblem(
        403,
        "insufficient_scope",
        "The key does not grant this operation.",
      );
    if (search) {
      const query = searchQuery(url, key.site_id);
      const body = listingSearch(await db.search(query), query.context);
      const cursor = body.meta.page.nextCursor;
      if (
        cursor !== null &&
        query.bytes + (query.bytes ? 1 : 0) + "after=".length + cursor.length >
          2048
      )
        throw new HttpProblem(
          500,
          "internal_error",
          "The request could not be completed.",
        );
      return Response.json(body, {
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    const id = detail![1];
    const row = /^[A-Za-z0-9_-]+$/.test(id)
      ? await db.listing(key.site_id, id)
      : undefined;
    if (!row)
      throw new HttpProblem(404, "not_found", "The resource was not found.");
    if (row.expires_at.getTime() <= Date.now())
      throw new HttpProblem(
        503,
        "feed_expired",
        "Listing data is temporarily unavailable.",
      );
    return Response.json(listingDetail(row), {
      headers: { "Cache-Control": "private, no-store" },
    });
  });
  return app;
}
