import type { Problem } from '../../../client/src/generated.ts';

export class HttpProblem extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  constructor(status: number, code: string, detail: string) {
    super(code);
    this.status = status; this.code = code; this.detail = detail;
  }
}
export function problemResponse(error: unknown, requestId: string) {
  const { status, code, detail } = error instanceof HttpProblem ? error :
    new HttpProblem(500, 'internal_error', 'The request could not be completed.');
  const title = ({ 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
    405: 'Method Not Allowed', 503: 'Service Unavailable' } as Record<number, string>)[status] ?? 'Internal Server Error';
  const body: Problem = { type: 'about:blank', title, status, detail, code, requestId };
  const headers = new Headers({ 'Content-Type': 'application/problem+json', 'Cache-Control': 'no-store' });
  if (status === 401) headers.set('WWW-Authenticate', 'Bearer');
  if (status === 405) headers.set('Allow', 'GET');
  return Response.json(body, { status, headers });
}
