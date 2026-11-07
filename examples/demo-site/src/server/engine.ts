import { writeLog } from "./log.ts";
import { ApiError, createClient, OPERATIONS } from "@idx-kit/client";
import type {
  Ops,
  Problem,
  RequestOptions,
  SearchListingsQuery,
} from "@idx-kit/client";

const bindings = import.meta.env?.IDX_WORKER
  ? (await import("cloudflare:workers")).env
  : undefined;

export class PageFailure extends Error {
  status: number;
  reason: string;
  requestId: string | null;
  path: string | null;
  logged = false;
  constructor(
    status = 502,
    reason = "engine_request_failed",
    options?: { cause?: unknown; requestId?: string | null; path?: string },
  ) {
    super(reason, { cause: options?.cause });
    this.name = "PageFailure";
    this.status = status;
    this.reason = reason;
    this.requestId = options?.requestId ?? null;
    this.path = options?.path ?? null;
  }
}

export function logFailure(
  error: unknown,
  upstream?: {
    status: number | null;
    requestId: string | null;
    path?: string | null;
  },
) {
  const cause = error instanceof PageFailure ? error.cause : error;
  if (error instanceof PageFailure && error.logged) return;
  const status =
    cause instanceof ApiError ? cause.status : (upstream?.status ?? null);
  writeLog({
    event: "demo_request_failed",
    category:
      status === 401 || status === 403
        ? "key_problem"
        : status === null || status >= 500
          ? "engine_outage"
          : "request_problem",
    errorType: cause instanceof Error ? cause.name : "PageFailure",
    reason: error instanceof PageFailure ? error.reason : "render_failed",
    upstreamStatus: status,
    requestId:
      (error instanceof PageFailure ? error.requestId : null) ??
      upstream?.requestId ??
      null,
    path:
      (error instanceof PageFailure ? error.path : null) ??
      upstream?.path ??
      null,
    message: cause instanceof Error ? cause.message : "Request failed",
  });
  if (error instanceof PageFailure) error.logged = true;
}

// Imported only by server entry points. Configuration and upstream errors stay on the server.
export function engineClient() {
  const binding = bindings?.IDX_ENGINE;
  const base = new URL(binding ? "https://engine.internal" : process.env.IDX_ENGINE_URL ?? "");
  const secret = bindings ? bindings.IDX_SECRET_KEY : process.env.IDX_SECRET_KEY;
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    !secret
  ) {
    throw new PageFailure(502, "invalid_engine_configuration");
  }
  let requestId: string | null = null;
  let upstreamStatus: number | null = null;
  let path: string | null = null;
  const client = createClient<Ops>(OPERATIONS, {
    serverUrl: base.origin,
    timeout: 5000,
    fetch: binding ? (input, init) => binding.fetch(input, init) : fetch,
    onResponse(response) {
      requestId = response.headers.get("Request-Id");
      upstreamStatus = response.status;
    },
  });
  const options: RequestOptions = {
    headers: { Authorization: `Bearer ${secret}` },
    cache: "no-store",
    redirect: "error",
  };
  async function request<T>(
    requestPath: string,
    call: () => Promise<T>,
  ): Promise<T> {
    path = requestPath;
    requestId = null;
    upstreamStatus = null;
    try {
      return await call();
    } catch (cause) {
      const status =
        cause instanceof ApiError && [400, 404, 503].includes(cause.status)
          ? cause.status
          : 502;
      const error = new PageFailure(status, "engine_request_failed", {
        cause,
        requestId,
        path: requestPath,
      });
      logFailure(error);
      throw error;
    }
  }
  return {
    context: () => ({ status: upstreamStatus, requestId, path }),
    async discover() {
      const body = await request("/api", () =>
        client.discoverServer({}, { cache: "no-store", redirect: "error" }),
      );
      if (
        !body.data.supportedVersions.some(
          (version) =>
            version.major === "v1" &&
            version.capabilities.includes("listingDetail"),
        )
      ) {
        throw new PageFailure(502, "unsupported_engine", {
          requestId,
          path: "/api",
        });
      }
    },
    async listing(id: string) {
      if (!/^[A-Za-z0-9_-]+$/.test(id))
        throw new PageFailure(404, "invalid_listing_id");
      return request("/api/v1/listings/{listingId}", () =>
        client.getListing({ path: { listingId: id } }, options),
      );
    },
    async search(query: SearchListingsQuery) {
      return request("/api/v1/listings", () =>
        client.searchListings({ query }, options),
      );
    },
  };
}

export function searchProblem(error: unknown): Partial<Problem> {
  const cause = error instanceof PageFailure ? error.cause : error;
  return cause instanceof ApiError &&
    cause.body &&
    typeof cause.body === "object"
    ? cause.body
    : {};
}
