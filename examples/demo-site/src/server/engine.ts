import type { DiscoveryResponse, ListingResponse } from '@idx-kit/client';

export class PageFailure extends Error {
  status: number;
  constructor(status = 502) {
    super('Listing request failed');
    this.status = status;
  }
}

// Imported only by server entry points. Neither configuration nor upstream errors are rendered.
export function engineClient() {
  const base = new URL(process.env.IDX_ENGINE_URL ?? '');
  const secret = process.env.IDX_SECRET_KEY;
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.pathname !== '/' || base.search || base.hash || !secret) throw new PageFailure();
  async function request(path: string, authorized: boolean) {
    try {
      const response = await fetch(new URL(path, base), {
        headers: authorized ? { Authorization: `Bearer ${secret}` } : {},
        cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) throw new PageFailure([404, 503].includes(response.status) ? response.status : 502);
      return await response.json();
    } catch (error) {
      throw error instanceof PageFailure ? error : new PageFailure();
    }
  }
  return {
    async discover() {
      const body: DiscoveryResponse = await request('/api', false);
      if (!body.data.supportedVersions.some(version => version.major === 'v1' &&
          version.capabilities.includes('listingDetail'))) throw new PageFailure();
    },
    async listing(id: string): Promise<ListingResponse> {
      if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new PageFailure(404);
      return request(`/api/v1/listings/${encodeURIComponent(id)}`, true);
    }
  };
}
