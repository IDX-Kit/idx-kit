import { HttpProblem } from '../http/problem.ts';

const decimal = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const amount = (value: string) => value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
function compareAmounts(a: string, b: string) {
  const [ai, af = ''] = a.split('.'), [bi, bf = ''] = b.split('.');
  return ai.length - bi.length || ai.localeCompare(bi) || af.padEnd(bf.length, '0').localeCompare(bf.padEnd(af.length, '0'));
}
export interface SearchContext {
  site: string; city: string | null; minPrice: string | null; maxPrice: string | null;
  minBedrooms: number | null; sort: 'price' | '-price'; limit: number;
}
export interface SearchQuery { context: SearchContext; last: { price: string | null; id: string } | null }
const encode = (value: string) => btoa(String.fromCharCode(...new TextEncoder().encode(value)))
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
export const searchCursor = (context: SearchContext, last: NonNullable<SearchQuery['last']>) =>
  encode(JSON.stringify({ context, last }));

export function searchQuery(url: URL, site: string): SearchQuery {
  const invalid = () => { throw new HttpProblem(400, 'invalid_query', 'Use valid, unique search parameters.'); };
  try { decodeURIComponent(url.search); } catch { invalid(); }
  const params = url.searchParams;
  const allowed = ['city', 'minPrice', 'maxPrice', 'minBedrooms', 'sort', 'limit', 'after'];
  for (const name of params.keys()) if (!allowed.includes(name) || params.getAll(name).length !== 1) invalid();
  const city = params.get('city')?.trim().toLowerCase() ?? null;
  if (city !== null && (!city.length || Array.from(city).length > 100)) invalid();
  const price = (name: string) => {
    const value = params.get(name);
    if (value === null) return null;
    if (!decimal.test(value)) invalid();
    return amount(value);
  };
  const integer = (name: string, fallback: number | null, min: number, max: number) => {
    const value = params.get(name);
    if (value === null) return fallback;
    if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) invalid();
    return Number(value);
  };
  const minPrice = price('minPrice'), maxPrice = price('maxPrice');
  if (minPrice !== null && maxPrice !== null && compareAmounts(minPrice, maxPrice) > 0) invalid();
  const sort = params.get('sort') ?? 'price';
  if (sort !== 'price' && sort !== '-price') invalid();
  const context: SearchContext = { site, city, minPrice, maxPrice,
    minBedrooms: integer('minBedrooms', null, 0, 100), sort: sort as SearchContext['sort'],
    limit: Math.min(integer('limit', 20, 1, Number.MAX_SAFE_INTEGER)!, 50) };
  let last: SearchQuery['last'] = null;
  if (params.has('after')) {
    try {
      const token = params.get('after')!;
      if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error();
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
        Uint8Array.from(atob(token.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0)));
      if (encode(decoded) !== token) throw new Error();
      const cursor = JSON.parse(decoded);
      if (JSON.stringify(cursor.context) !== JSON.stringify(context) ||
        !cursor.last || typeof cursor.last.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cursor.last.id) ||
        !(cursor.last.price === null || typeof cursor.last.price === 'string' && decimal.test(cursor.last.price)) ||
        JSON.stringify(cursor) !== JSON.stringify({ context, last: { price: cursor.last.price, id: cursor.last.id } })) throw new Error();
      last = cursor.last;
    } catch { throw new HttpProblem(400, 'cursor_invalid', 'The cursor is invalid for this search. Restart the search.'); }
  }
  return { context, last };
}
