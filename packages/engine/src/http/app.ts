import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import { zValidator } from "@hono/zod-validator";
import type { DiscoveryResponse } from "@idx-kit/client";
import type { Repository } from "../db/read.ts";
import { listingDetail } from "../domain/detail.ts";
import { listingSearch } from "../domain/search.ts";
import {
  searchQuery,
  searchSchema,
  invalidQuery,
} from "../domain/search-query.ts";
import { hashSecret } from "../domain/keys.ts";
import { failureFields, logLine } from "../log.ts";
import { HttpProblem, problemResponse } from "./problem.ts";

type AppEnv = {
  Variables: {
    requestId: string;
    code: string;
    route: string;
    site: string;
    failure: Record<string, unknown>;
  };
};

export function createApp(
  db: Repository,
  contract: unknown,
  release: string,
  log: (line: string) => void = console.error,
) {
  const app = new Hono<AppEnv>();
  // A zero limit rejects every supplied ID, so the middleware always generates one.
  app.use(requestId({ headerName: "Request-Id", limitLength: 0 }));
  app.use("*", async (c, next) => {
    const started = performance.now();
    c.set("code", "ok");
    c.set("route", "/api/*");
    await next();
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
      logLine({
        method,
        route: c.get("route"),
        status: c.res.status,
        code: c.get("code"),
        duration: Math.round((performance.now() - started) * 1000) / 1000,
        requestId: c.get("requestId"),
        engineRelease: release,
        ...c.get("failure"),
      }),
    );
  });
  app.onError((error, c) => {
    const problem =
      error instanceof HTTPException && error.status === 401
        ? new HttpProblem(
            401,
            "unauthorized",
            "A valid secret key is required.",
          )
        : error;
    c.set(
      "code",
      problem instanceof HttpProblem ? problem.code : "internal_error",
    );
    const cause =
      problem instanceof HttpProblem && problem.cause ? problem.cause : error;
    c.set("failure", {
      ...failureFields(cause),
      ...(problem instanceof HttpProblem && problem.operation
        ? { operation: problem.operation }
        : {
            message: error.message,
            ...(problem instanceof HttpProblem || error instanceof HTTPException
              ? {}
              : { stack: error.stack }),
          }),
    });
    return problemResponse(problem, c.get("requestId"));
  });
  app.use("*", async (c, next) => {
    if (
      c.req.header("Origin") !== undefined &&
      /^Bearer\s/i.test(c.req.header("Authorization") ?? "")
    )
      throw new HttpProblem(
        403,
        "origin_forbidden",
        "Secret keys cannot be used with an Origin header.",
      );
    await next();
  });
  for (const path of [
    "/api",
    "/api/v1/openapi.json",
    "/api/v1/listings",
    "/api/v1/listings/:listingId",
  ]) {
    app.use(path, async (c, next) => {
      c.set("route", path.replace(":listingId", "{listingId}"));
      if (c.req.method !== "GET")
        throw new HttpProblem(
          405,
          "method_not_allowed",
          "Use GET on this resource.",
        );
      const url = new URL(c.req.url);
      if (
        new TextEncoder().encode(url.search.slice(1)).byteLength > 2048 ||
        (path !== "/api/v1/listings" && url.searchParams.size)
      )
        throw new HttpProblem(
          400,
          "invalid_query",
          "The query string is not supported.",
        );
      await next();
    });
  }
  app.get("/api", () => {
    const body: DiscoveryResponse = {
      data: {
        engineVersion: release,
        supportedVersions: [
          {
            major: "v1",
            contractVersion: "1.0.0",
            capabilities: ["listingSearch", "listingDetail", "displayRulesV1"],
          },
        ],
      },
      meta: {},
    };
    return Response.json(body);
  });
  app.get("/api/v1/openapi.json", () => Response.json(contract));
  const authorize = bearerAuth<AppEnv>({
    // Malformed bearer headers have the same 401 problem as missing or invalid keys.
    invalidAuthenticationHeader: {
      message: new Response(null, { status: 401 }),
    },
    async verifyToken(token, c) {
      const key = await db.key(await hashSecret(token));
      if (!key) return false;
      if (!key.scopes.includes("listings:read"))
        throw new HttpProblem(
          403,
          "insufficient_scope",
          "The key does not grant this operation.",
        );
      c.set("site", key.site_id);
      return true;
    },
  });
  app.get(
    "/api/v1/listings",
    authorize,
    async (c, next) => {
      try {
        decodeURIComponent(new URL(c.req.url).search);
      } catch {
        throw invalidQuery();
      }
      await next();
    },
    zValidator("query", searchSchema, (result) => {
      if (!result.success) throw invalidQuery();
    }),
    async (c) => {
      const query = searchQuery(c.req.valid("query"), c.get("site"));
      const body = listingSearch(await db.search(query), query.context);
      return Response.json(body, {
        headers: { "Cache-Control": "private, no-store" },
      });
    },
  );
  app.get("/api/v1/listings/:listingId", authorize, async (c) => {
    const id = c.req.param("listingId");
    const row = /^[A-Za-z0-9_-]+$/.test(id)
      ? await db.listing(c.get("site"), id)
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
  app.notFound((c) => {
    const [, root, version] = c.req.path.split("/");
    if (root === "api" && ["listings", "inquiries"].includes(version))
      throw new HttpProblem(
        400,
        "api_version_required",
        "Use an explicit API version.",
      );
    if (root === "api" && /^v[0-9]+$/.test(version) && version !== "v1")
      throw new HttpProblem(
        404,
        "api_version_unsupported",
        "This API version is not supported.",
      );
    throw new HttpProblem(404, "not_found", "The resource was not found.");
  });
  return app;
}
