import { ApiError, createClient, OPERATIONS } from '@idx-kit/client';
import type { Ops, Problem, RequestOptions, SearchListingsQuery } from '@idx-kit/client';

export class PageFailure extends Error {
  status: number;
  reason: string;
  requestId: string | null;
  constructor(
    status = 502,
    reason = 'engine_request_failed',
    options?: { cause?: unknown; requestId?: string | null }
  ) {
    super(reason, { cause: options?.cause });
    this.name = 'PageFailure';
    this.status = status;
    this.reason = reason;
    this.requestId = options?.requestId ?? null;
  }
}

export function logFailure(error: unknown, upstream?: { status: number | null; requestId: string | null }) {
  const cause = error instanceof PageFailure ? error.cause : error;
  console.error(JSON.stringify({
    event: 'demo_request_failed',
    errorType: cause instanceof Error ? cause.name : 'PageFailure',
    reason: error instanceof PageFailure ? error.reason : 'render_failed',
    upstreamStatus: cause instanceof ApiError ? cause.status : upstream?.status ?? null,
    requestId: (error instanceof PageFailure ? error.requestId : null) ?? upstream?.requestId ?? null
  }));
}

// Imported only by server entry points. Configuration and upstream errors stay on the server.
export function engineClient() {
  const base = new URL(process.env.IDX_ENGINE_URL ?? '');
  const secret = process.env.IDX_SECRET_KEY;
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.pathname !== '/' || base.search || base.hash || !secret) {
    throw new PageFailure(502, 'invalid_engine_configuration');
  }
  let requestId: string | null = null;
  let upstreamStatus: number | null = null;
  const client = createClient<Ops>(OPERATIONS, {
    serverUrl: base.origin,
    timeout: 5000,
    onResponse(response) {
      requestId = response.headers.get('Request-Id');
      upstreamStatus = response.status;
    }
  });
  const options: RequestOptions = {
    headers: { Authorization: `Bearer ${secret}` },
    cache: 'no-store',
    redirect: 'error'
  };
  async function request<T>(call: () => Promise<T>): Promise<T> {
    requestId = null;
    upstreamStatus = null;
    try {
      return await call();
    } catch (cause) {
      const status = cause instanceof ApiError && [400, 404, 503].includes(cause.status) ? cause.status : 502;
      throw new PageFailure(status, 'engine_request_failed', { cause, requestId });
    }
  }
  return {
    context: () => ({ status: upstreamStatus, requestId }),
    async discover() {
      const body = await request(() => client.discoverServer({}, { cache: 'no-store', redirect: 'error' }));
      if (!body.data.supportedVersions.some(version => version.major === 'v1' &&
          version.capabilities.includes('listingDetail'))) {
        throw new PageFailure(502, 'unsupported_engine', { requestId });
      }
    },
    async listing(id: string) {
      if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new PageFailure(404, 'invalid_listing_id');
      return request(() => client.getListing({ path: { listingId: id } }, options));
    },
    async search(query: SearchListingsQuery) {
      return request(() => client.searchListings({ query }, options));
    }
  };
}

export function searchProblem(error: unknown): Partial<Problem> {
  const cause = error instanceof PageFailure ? error.cause : error;
  return cause instanceof ApiError && cause.body && typeof cause.body === 'object' ? cause.body : {};
}
