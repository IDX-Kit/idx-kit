import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import listings from "../../fixtures/listings.json" with { type: "json" };
import {
  heavyRecords,
  pageRecords,
  propertyPath,
} from "../sync/stand-in-records.ts";

type Env = {
  Bindings: {
    IDX_STAND_IN_FEED_TOKEN?: string;
    IDX_STAND_IN_LISTING_COUNT?: string;
  };
};

const defaultCount = 300;
const app = new Hono<Env>({
  getPath: (request) => new URL(request.url).pathname,
});
app.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});
app.onError((error, c) => {
  if (error instanceof HTTPException) return error.getResponse();
  return c.body(null, 500);
});
app.all(
  propertyPath,
  async (c, next) => {
    if (c.req.raw.method !== "GET") {
      c.header("Allow", "GET");
      return c.body(null, 405);
    }
    await next();
  },
  bearerAuth<Env>({
    invalidAuthenticationHeader: {
      message: new Response(null, { status: 401 }),
    },
    verifyToken(token, c) {
      const secret = c.env.IDX_STAND_IN_FEED_TOKEN;
      if (!secret) return false;
      const expected = createHash("sha256").update(secret).digest();
      const supplied = createHash("sha256").update(token).digest();
      return timingSafeEqual(expected, supplied);
    },
  }),
  (c) => {
    const configured = Number(c.env.IDX_STAND_IN_LISTING_COUNT || defaultCount);
    const count =
      Number.isSafeInteger(configured) && configured >= 0
        ? configured
        : defaultCount;
    const records = heavyRecords(listings[0].source, count);
    return c.json(
      pageRecords(records, new URL(c.req.url), c.req.header("Prefer")),
    );
  },
);

export default app;
