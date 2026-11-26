import { Hono } from "hono";
import { Buffer } from "node:buffer";
import { bodyLimit } from "hono/body-limit";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import { zValidator } from "@hono/zod-validator";
import type { DiscoveryResponse } from "@idx-kit/client";
import type { Repository } from "../db/read.ts";
import {
  createInquiry,
  inquiryHeaders,
  inquirySchema,
  invalidInquiry,
  receipt,
} from "../domain/inquiry.ts";
import { listingDetail } from "../domain/detail.ts";
import { sendInquiryEmail } from "../domain/inquiry-email.ts";
import type { InquiryEmailSettings } from "../domain/inquiry-email.ts";
import { listingSearch } from "../domain/search.ts";
import {
  searchQuery,
  searchSchema,
  invalidQuery,
  invalidCursor,
  SEARCH_TERMS_MAX_BYTES,
  CURSOR_MAX_BYTES,
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
  email?: {
    settings: InquiryEmailSettings;
    waitUntil?: (task: Promise<void>) => void;
  },
) {
  const app = new Hono<AppEnv>();
  // A zero limit rejects every supplied ID, so the middleware always generates one.
  app.use(requestId({ headerName: "Request-Id", limitLength: 0 }));
  app.use("*", async (c, next) => {
    const started = performance.now();
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
        : error instanceof HTTPException && error.status === 400
          ? new HttpProblem(400, "invalid_json", "Use a valid JSON body.")
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
        : c.get("route").startsWith("/api/v1/inquiries")
          ? { operation: "inquiry.request" }
          : {
              message: error.message,
              ...(problem instanceof HttpProblem ||
              error instanceof HTTPException
                ? {}
                : { stack: error.stack }),
            }),
    });
    const response = problemResponse(problem, c.get("requestId"));
    if (response.status === 405 && c.get("route") === "/api/v1/inquiries")
      response.headers.set("Allow", "POST");
    return response;
  });
  for (const path of [
    "/api",
    "/api/v1/openapi.json",
    "/api/v1/listings",
    "/api/v1/listings/:listingId",
    "/api/v1/inquiries",
    "/api/v1/inquiries/:inquiryId",
  ]) {
    app.use(path, async (c, next) => {
      c.set(
        "route",
        path
          .replace(":listingId", "{listingId}")
          .replace(":inquiryId", "{inquiryId}"),
      );
      await next();
    });
  }
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
  app.use("*", async (c, next) => {
    const route = c.get("route");
    if (route !== "/api/*") {
      const allowed = route === "/api/v1/inquiries" ? "POST" : "GET";
      if (c.req.method !== allowed)
        throw new HttpProblem(
          405,
          "method_not_allowed",
          `Use ${allowed} on this resource.`,
        );
      const url = new URL(c.req.url);
      // Preserve raw encoding while Node parses each parameter's name.
      const pairs = url.search.slice(1).split("&");
      const terms = pairs
        .filter((pair) => !new URLSearchParams(pair).has("after"))
        .join("&");
      if (
        Buffer.byteLength(terms) > SEARCH_TERMS_MAX_BYTES ||
        (route !== "/api/v1/listings" && url.searchParams.size)
      )
        throw new HttpProblem(
          400,
          "invalid_query",
          "The query string is not supported.",
        );
      const cursors = pairs.filter((pair) =>
        new URLSearchParams(pair).has("after"),
      );
      // Count any extra percent encoding against the same cursor allowance.
      if (
        cursors.length === 1 &&
        Buffer.byteLength(cursors[0]) > "after=".length + CURSOR_MAX_BYTES
      )
        throw invalidCursor();
    }
    await next();
  });
  app.get("/api", () => {
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
              "inquiryCreate",
              "inquiryReceipt",
            ],
          },
        ],
      },
      meta: {},
    };
    return Response.json(body);
  });
  app.get("/api/v1/openapi.json", () => Response.json(contract));
  const authorize = (scope: string) =>
    bearerAuth<AppEnv>({
      // Malformed bearer headers have the same 401 problem as missing or invalid keys.
      invalidAuthenticationHeader: {
        message: new Response(null, { status: 401 }),
      },
      async verifyToken(token, c) {
        const key = await db.key(await hashSecret(token));
        if (!key) return false;
        if (!key.scopes.includes(scope))
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
    authorize("listings:read"),
    async (c, next) => {
      const url = new URL(c.req.url);
      try {
        decodeURIComponent(url.search);
      } catch {
        throw invalidQuery();
      }
      // Hono omits empty names from its parsed query object.
      if (url.searchParams.has("")) throw invalidQuery();
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
  app.get(
    "/api/v1/listings/:listingId",
    authorize("listings:read"),
    async (c) => {
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
    },
  );
  app.post(
    "/api/v1/inquiries",
    authorize("inquiries:write"),
    bodyLimit({
      maxSize: 16 * 1024,
      onError: () => {
        throw new HttpProblem(
          413,
          "body_too_large",
          "The inquiry body is too large.",
        );
      },
    }),
    async (c, next) => {
      if (
        !/^application\/json(?:;|$)/i.test(c.req.header("Content-Type") ?? "")
      )
        throw new HttpProblem(
          415,
          "unsupported_media_type",
          "Use application/json.",
        );
      await next();
    },
    zValidator("header", inquiryHeaders, (result) => {
      if (!result.success)
        throw new HttpProblem(
          400,
          "invalid_idempotency_key",
          "Use a quoted UUIDv4 Idempotency-Key.",
        );
    }),
    zValidator("json", inquirySchema, (result) => {
      if (!result.success) throw invalidInquiry(result.error.issues);
    }),
    async (c) => {
      const input = c.req.valid("json");
      const { row, listing } = await createInquiry(
        db,
        c.get("site"),
        c.req.valid("header")["idempotency-key"],
        input,
      );
      if (listing && email && email.settings.mode !== "off") {
        const task = sendInquiryEmail(
          email.settings,
          input,
          row,
          listing,
          c.get("requestId"),
          log,
        );
        email.waitUntil?.(task);
      }
      return Response.json(receipt(row), {
        status: 201,
        headers: {
          Location: `/api/v1/inquiries/${row.id}`,
          "Cache-Control": "no-store",
        },
      });
    },
  );
  app.get(
    "/api/v1/inquiries/:inquiryId",
    authorize("inquiries:read"),
    async (c) => {
      const row = await db.inquiryReceipt(
        c.get("site"),
        c.req.param("inquiryId"),
      );
      if (!row)
        throw new HttpProblem(404, "not_found", "The resource was not found.");
      return Response.json(receipt(row), {
        headers: { "Cache-Control": "no-store" },
      });
    },
  );
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
