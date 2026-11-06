import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { z } from "zod";
import { HttpProblem } from "../http/problem.ts";

const decimal = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const amount = (value: string) =>
  value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
function compareAmounts(a: string, b: string) {
  const [ai, af = ""] = a.split("."),
    [bi, bf = ""] = b.split(".");
  return (
    ai.length - bi.length ||
    ai.localeCompare(bi) ||
    af.padEnd(bf.length, "0").localeCompare(bf.padEnd(af.length, "0"))
  );
}
export interface SearchContext {
  site: string;
  city: string | null;
  minPrice: string | null;
  maxPrice: string | null;
  minBedrooms: number | null;
  sort: "price" | "-price";
  limit: number;
}
export interface SearchQuery {
  context: SearchContext;
  last: { price: string | null; id: string } | null;
}
const priceSchema = z
  .string()
  .regex(decimal)
  .transform(amount)
  .optional()
  .transform((value) => value ?? null);
const integerSchema = z
  .string()
  .regex(/^[0-9]+$/)
  .transform(Number)
  .pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER));
export const searchSchema = z
  .strictObject({
    city: z
      .string()
      .trim()
      .toLowerCase()
      .min(1)
      .refine((value) => Array.from(value).length <= 100)
      .optional()
      .transform((value) => value ?? null),
    minPrice: priceSchema,
    maxPrice: priceSchema,
    minBedrooms: integerSchema
      .pipe(z.number().max(100))
      .optional()
      .transform((value) => value ?? null),
    sort: z.enum(["price", "-price"]).default("price"),
    limit: integerSchema
      .pipe(z.number().min(1))
      .default(20)
      .transform((value) => Math.min(value, 50)),
    after: z.string().optional(),
  })
  .refine(
    (query) =>
      query.minPrice === null ||
      query.maxPrice === null ||
      compareAmounts(query.minPrice, query.maxPrice) <= 0,
  );

export const invalidQuery = () =>
  new HttpProblem(400, "invalid_query", "Use valid, unique search parameters.");

export function searchCursor(
  context: SearchContext,
  last: NonNullable<SearchQuery["last"]>,
) {
  // Bind the context and position together. This checksum is not a signature.
  const hash = createHash("sha256")
    .update(JSON.stringify([context, last.price, last.id]))
    .digest()
    .subarray(0, 16)
    .toString("base64url");
  return Buffer.from(JSON.stringify([last.price, last.id, hash])).toString(
    "base64url",
  );
}
const cursorSchema = z.tuple([
  z.string().regex(decimal).nullable(),
  z.string().regex(/^[A-Za-z0-9_-]+$/),
  z.string().length(22),
]);

export function searchQuery(
  query: z.output<typeof searchSchema>,
  site: string,
): SearchQuery {
  const { after, ...filters } = query;
  const context: SearchContext = { site, ...filters };
  let last: SearchQuery["last"] = null;
  if (after !== undefined) {
    try {
      const [price, id] = cursorSchema.parse(
        JSON.parse(Buffer.from(after, "base64url").toString("utf8")),
      );
      last = { price, id };
      if (searchCursor(context, last) !== after)
        throw new Error("Cursor checksum mismatch");
    } catch {
      throw new HttpProblem(
        400,
        "cursor_invalid",
        "The cursor is invalid for this search. Restart the search.",
      );
    }
  }
  return { context, last };
}
