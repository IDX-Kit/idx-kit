import { test, expect } from "@playwright/test";
import type { Page, Response as BrowserResponse } from "@playwright/test";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import pg from "pg";
import { execute, keyCommand, startEngine } from "../api/runtime.ts";
import { registerSecret } from "../logs.ts";
import {
  fillInquiry,
  inquiryKeyField,
  restoreInquiryKey,
  submitInquiry,
} from "./inquiry-form.ts";
import { startSite } from "./runtime.ts";
import { workerRuntime } from "../workers/runtime.ts";

const property = "/properties/lst_demo_0001";
// Invented visitor values and fault details, with no real person or property.
const visitor = {
  name: 'Synthetic <b>Visitor</b> & "friend"',
  email: "synthetic-visitor@example.invalid",
  message: 'Synthetic inquiry </textarea><script>bad()</script> & "quote"',
};
const received = "Received by the demo engine; no message was sent";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let secret: string;
let keyId: string;
let directory: string;
let db: pg.Client;
let engine: Awaited<ReturnType<typeof startEngine>>;
let site: Awaited<ReturnType<typeof startSite>>;
let faultSite: Awaited<ReturnType<typeof startSite>>;
let fault: number | "network" | "timeout" | "lost" = 500;
let receiptLookupTimesOut = false;
let malformedErrors = false;
let code = "invalid_input";
let posts = 0;
let upstreamId: string | null = null;
let lostReceipt: { id: string; receivedAt: string } | undefined;
let upstreamReads: Response[] | undefined;
const faultOrigin = "http://127.0.0.1:4322";
const stub = createServer(async (req, res) => {
  if (req.method !== "POST") {
    const path = req.url === "/" ? "/api" : req.url;
    if (receiptLookupTimesOut && path?.startsWith("/api/v1/inquiries/")) {
      return;
    }
    const upstream = await fetch(`http://127.0.0.1:8787${path}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    upstreamReads?.push(upstream);
    const retryAfter = upstream.headers.get("Retry-After");
    // fetch decodes the body; do not forward its wire encoding or length.
    res.writeHead(upstream.status, {
      "Content-Type": "application/json",
      "Request-Id": upstream.headers.get("Request-Id") ?? "",
      ...(retryAfter === null ? {} : { "Retry-After": retryAfter }),
    });
    res.end(await upstream.text());
    return;
  }
  posts++;
  let body = "";
  for await (const chunk of req) body += chunk;
  if (fault === "lost" || fault === 201) {
    const upstream = await fetch("http://127.0.0.1:8787/api/v1/inquiries", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "Idempotency-Key": String(req.headers["idempotency-key"]),
      },
      body,
    });
    const result = await upstream.json();
    lostReceipt = result.data;
    if (fault === 201) {
      res.writeHead(upstream.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }
    req.socket.destroy();
    return;
  }
  if (fault === "network") {
    req.socket.destroy();
    return;
  }
  if (fault === "timeout") {
    // The client must time out without retrying. Close is managed by suite cleanup.
    return;
  }
  upstreamId = crypto.randomUUID();
  res.writeHead(fault, {
    "Content-Type": "application/problem+json",
    "Request-Id": upstreamId,
    ...([409, 429].includes(fault) ? { "Retry-After": "17" } : {}),
  });
  const issue = { pointer: "/visitor/email", detail: visitor.message };
  res.end(
    JSON.stringify({
      type: "about:blank",
      title: "Synthetic failure",
      status: fault,
      code,
      requestId: upstreamId,
      detail: Object.values(visitor).join(" "),
      errors: malformedErrors ? issue : [issue],
    }),
  );
});

async function key(page: Page) {
  return page.locator(inquiryKeyField).inputValue();
}
async function retained(
  page: Page,
  expectedKey: string,
  message = visitor.message,
) {
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    visitor.name,
  );
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue(
    visitor.email,
  );
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
    message,
  );
  expect(await key(page)).toBe(expectedKey);
  await expect(page.locator("script, form b")).toHaveCount(0);
}
async function headers(response: BrowserResponse | null) {
  expect(response).not.toBeNull();
  const values = await response!.allHeaders();
  expect(values["cache-control"]).toBe("no-store");
  expect(values["referrer-policy"]).toBe("no-referrer");
  expect(JSON.stringify(values)).not.toContain(secret);
  expect(response!.url() + (await response!.text())).not.toContain(secret);
}
async function rows() {
  return (await db.query("SELECT * FROM idx.inquiries ORDER BY received_at"))
    .rows;
}

test.describe("no-JavaScript inquiry forms and durable receipts", () => {
  test.beforeAll(async () => {
    directory = await mkdtemp(`${tmpdir()}/idx-inquiry-`);
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    await execute("npm", ["run", "--silent", "demo:seed"]);
    const key = await keyCommand(
      directory,
      "create",
      "site_demo_primary",
      "listings:read,inquiries:write,inquiries:read",
    );
    secret = key.secret;
    keyId = key.id;
    // The final CI log scan also rejects visitor data, including injected upstream details.
    for (const value of Object.values(visitor)) registerSecret(value);
    engine = await startEngine();
    site = await startSite(secret);
    stub.listen(8788, "127.0.0.1");
    await once(stub, "listening");
    faultSite = await startSite(secret, "http://127.0.0.1:8788", 4322);
  });
  test.beforeEach(async () => {
    await db.query("DELETE FROM idx.inquiries");
    posts = 0;
    code = "invalid_input";
    lostReceipt = undefined;
    receiptLookupTimesOut = false;
    malformedErrors = false;
  });
  test.afterAll(async () => {
    await faultSite?.stop();
    stub.closeAllConnections();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
    await site?.stop();
    await engine?.stop();
    await db?.end();
    await rm(directory, { recursive: true, force: true });
  });

  test("spent listing budget limits both pages once and an open inquiry still submits", async ({
    context,
    page,
  }) => {
    const listingPage = await context.newPage();
    expect((await page.goto(property))?.status()).toBe(200);
    await fillInquiry(page, visitor);
    const paths = [
      ["/search", "/api/v1/listings"],
      [property, "/api/v1/listings/lst_demo_0001"],
    ];
    const reads: Response[] = [];
    upstreamReads = reads;
    try {
      const spent = await db.query(
        `UPDATE idx.listing_request_windows AS w
        SET window_start = clock_timestamp(), request_count = k.listing_request_limit
        FROM idx.site_secret_keys AS k
        WHERE w.key_id = k.id AND w.key_id = $1`,
        [keyId],
      );
      expect(spent.rowCount).toBe(1);
      for (const [path, upstreamPath] of paths) {
        reads.length = 0;
        const response = await listingPage.goto(faultOrigin + path);
        expect(response?.status()).toBe(429);
        expect(reads).toHaveLength(1);
        const [upstream] = reads;
        expect(upstream.status).toBe(429);
        expect(new URL(upstream.url).pathname).toBe(upstreamPath);
        const retryAfter = upstream.headers.get("Retry-After");
        expect(retryAfter).toMatch(/^(?:[1-9]|[1-5]\d|60)$/);
        const values = await response!.allHeaders();
        expect(values["retry-after"]).toBe(retryAfter);
        expect(values["cache-control"]).toBe("no-store");
        expect(values).not.toHaveProperty("refresh");
        await expect(listingPage.locator("main")).toHaveText(
          "Too many listing requests. Please wait and try again.",
        );
        await expect(
          listingPage.locator(
            '[data-listing], script, meta[http-equiv="refresh"]',
          ),
        ).toHaveCount(0);
      }
      expect((await submitInquiry(page, property)).status()).toBe(303);
      await expect(page.getByRole("heading", { name: received })).toBeVisible();
      expect(await rows()).toHaveLength(1);
    } finally {
      upstreamReads = undefined;
      await db.query(
        "UPDATE idx.listing_request_windows SET window_start = clock_timestamp() - interval '61 seconds' WHERE key_id = $1",
        [keyId],
      );
    }
    for (const [path] of paths) {
      expect((await listingPage.goto(faultOrigin + path))?.status()).toBe(200);
      await expect(listingPage.locator("[data-listing]").first()).toBeVisible();
    }
  });

  test("direct entry, reload, send, receipt reload and send another inquiry", async ({
    page,
  }) => {
    const requests: string[] = [];
    page.on("request", (r) =>
      requests.push(r.url() + JSON.stringify(r.headers())),
    );
    await headers(await page.goto(property));
    const first = await key(page);
    expect(first).toMatch(uuid);
    await headers(await page.reload());
    const second = await key(page);
    expect(second).toMatch(uuid);
    expect(second).not.toBe(first);
    expect(await rows()).toHaveLength(0);
    const inquiry = page.getByRole("region", { name: "Send an inquiry" });
    await expect(inquiry.locator("form")).toBeVisible();
    await expect(
      inquiry.getByText("Example Springs Demo Brokerage (fictional)", {
        exact: true,
      }),
    ).toBeVisible();
    expect(await inquiry.evaluate((n) => n.closest("article"))).toBeNull();
    await fillInquiry(page, visitor);
    expect((await submitInquiry(page, property)).status()).toBe(303);
    await expect(page.getByRole("heading", { name: received })).toBeVisible();
    const [row] = await rows();
    expect(row.visitor_name).toBe(visitor.name);
    expect(row.visitor_email).toBe(visitor.email);
    expect(row.message).toBe(visitor.message);
    expect(row.context).toEqual({ pagePath: property });
    expect(row.idempotency_key).toBe(JSON.stringify(second));
    const time = await page.locator("time").getAttribute("datetime");
    expect(time).toBe(row.received_at.toISOString());
    expect(new URL(page.url()).searchParams.get("receipt")).toBe(row.id);
    await headers(await page.reload());
    await expect(page.getByRole("heading", { name: received })).toBeVisible();
    expect(await page.locator("time").getAttribute("datetime")).toBe(time);
    expect(await rows()).toHaveLength(1);
    await page.getByRole("link", { name: "Send another inquiry" }).click();
    for (const field of ["Name", "Email", "Message"])
      await expect(page.getByLabel(field, { exact: true })).toHaveValue("");
    const third = await key(page);
    expect(third).toMatch(uuid);
    expect(third).not.toBe(second);
    await fillInquiry(page, visitor, "Synthetic second inquiry");
    await submitInquiry(page, property);
    await expect(page.getByRole("heading", { name: received })).toBeVisible();
    expect(await rows()).toHaveLength(2);
    for (const value of [secret, ...Object.values(visitor)])
      expect(requests.join("")).not.toContain(value);
  });

  test("a 4,000-character multiline message reaches the real engine", async ({
    page,
  }) => {
    const message = `${"a".repeat(1999)}\n${"b".repeat(2000)}`;
    await page.goto(property);
    await fillInquiry(page, visitor, message);
    expect((await submitInquiry(page, property)).status()).toBe(303);
    await expect(page.getByRole("heading", { name: received })).toBeVisible();
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0].message).toBe(message);
  });

  test("Back to a sent form replays unchanged and requires a fresh Send after a mismatch", async ({
    page,
  }) => {
    await page.goto(property);
    const originalKey = await key(page);
    await fillInquiry(page, visitor);
    await submitInquiry(page, property);
    await expect(page.getByRole("heading", { name: received })).toBeVisible();
    const original = (await rows())[0];
    const receiptUrl = page.url();
    // no-store may make Back revalidate. Restore the old rendered key as a stale tab would.
    await page.goBack();
    if (!(await page.locator(inquiryKeyField).count()))
      await page.goto(property);
    await restoreInquiryKey(page, originalKey);
    await fillInquiry(page, visitor);
    await submitInquiry(page, property);
    await expect(page).toHaveURL(receiptUrl);
    expect(await rows()).toHaveLength(1);
    await page.goBack();
    if (!(await page.locator(inquiryKeyField).count()))
      await page.goto(property);
    await restoreInquiryKey(page, originalKey);
    const changed = "Synthetic changed message";
    await fillInquiry(page, visitor, changed);
    expect((await submitInquiry(page, property)).status()).toBe(422);
    await expect(page.getByRole("alert")).toHaveText(
      "Your message has changed. Please send it again.",
    );
    const fresh = await key(page);
    expect(fresh).toMatch(uuid);
    expect(fresh).not.toBe(originalKey);
    await retained(page, fresh, changed);
    expect(await rows()).toEqual([original]);
    await submitInquiry(page, property);
    await expect(page.getByRole("heading", { name: received })).toBeVisible();
    expect(await rows()).toHaveLength(2);
  });

  test("lost response after commit retries the same key to the original receipt", async ({
    page,
  }) => {
    const message = `\n${visitor.message}\n\nSynthetic second paragraph\n`;
    fault = "lost";
    await page.goto(faultOrigin + property);
    const originalKey = await key(page);
    await fillInquiry(page, visitor, message);
    await submitInquiry(page, property);
    await expect(page.getByRole("alert")).toHaveText(
      "We can't confirm this was received.",
    );
    await retained(page, originalKey, message);
    expect(posts).toBe(1);
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0].message).toBe(message);
    const expected = lostReceipt;
    // Pass the retry through to the real engine, returning its retained receipt.
    fault = 201;
    await submitInquiry(page, property, "Retry");
    await expect(page.getByRole("heading", { name: received })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("receipt")).toBe(expected?.id);
    expect(await page.locator("time").getAttribute("datetime")).toBe(
      expected?.receivedAt,
    );
    expect(posts).toBe(2);
    expect(await rows()).toEqual(stored);
  });

  test("a receipt lookup timeout recovers without another send", async ({
    page,
  }) => {
    fault = 201;
    receiptLookupTimesOut = true;
    await page.goto(faultOrigin + property);
    await fillInquiry(page, visitor);
    const failedLookup = page.waitForResponse(
      (r) => r.request().method() === "GET" && r.url().includes("?receipt="),
    );
    expect((await submitInquiry(page, property)).status()).toBe(303);
    const failure = await failedLookup;
    expect(failure.status()).toBe(503);
    await headers(failure);
    await expect(page.getByRole("alert")).toHaveText(
      "We couldn't load the inquiry receipt. Try loading it again without sending another inquiry.",
    );
    const stored = await rows();
    expect(stored).toHaveLength(1);
    const receiptId = new URL(failure.url()).searchParams.get("receipt");
    expect(receiptId).toBe(stored[0].id);

    receiptLookupTimesOut = false;
    await page.getByRole("link", { name: "Retry receipt lookup" }).click();
    await expect(page.getByRole("heading", { name: received })).toBeVisible();
    await expect(page).toHaveURL(failure.url());
    await expect(page.locator("time")).toHaveAttribute(
      "datetime",
      stored[0].received_at.toISOString(),
    );
    expect(posts).toBe(1);
    expect(await rows()).toEqual(stored);
  });

  for (const failure of [
    400,
    422,
    "malformed validation",
    401,
    403,
    404,
    409,
    429,
    500,
    503,
    "network",
    "timeout",
    "mismatch",
  ] as const)
    test(`safe guidance and retained values for ${failure}`, async ({
      page,
    }) => {
      const malformed = failure === "malformed validation";
      malformedErrors = malformed;
      fault = failure === "mismatch" || malformed ? 422 : failure;
      code = failure === "mismatch" ? "idempotency_mismatch" : "invalid_input";
      await headers(await page.goto(faultOrigin + property));
      const originalKey = await key(page);
      await fillInquiry(page, visitor);
      const response = await submitInquiry(page, property);
      if (malformed) expect(response.status()).toBe(422);
      await headers(response);
      const newKey = await key(page);
      if (failure === "mismatch") {
        expect(newKey).toMatch(uuid);
        expect(newKey).not.toBe(originalKey);
      } else expect(newKey).toBe(originalKey);
      await retained(page, newKey);
      const expected =
        failure === "mismatch"
          ? "Your message has changed. Please send it again."
          : failure === 400 || failure === 422 || malformed
            ? "Check this field."
            : failure === 401 || failure === 403
              ? "This form isn't available right now."
              : failure === 404
                ? "This listing is no longer available."
                : failure === 409 || failure === 429
                  ? "Please wait, then retry."
                  : "We can't confirm this was received.";
      if (failure === 400 || failure === 422) {
        await expect(page.locator("#inquiry-email-error")).toHaveText(expected);
        await expect(page.getByLabel("Email", { exact: true })).toHaveAttribute(
          "aria-describedby",
          "inquiry-email-error",
        );
      } else await expect(page.getByRole("alert")).toHaveText(expected);
      const retry = [409, 429, 500, 503, "network", "timeout"].includes(
        failure,
      );
      await expect(
        page.getByRole("button", { name: "Retry", exact: true }),
      ).toHaveCount(retry ? 1 : 0);
      if (failure === 401 || failure === 403 || failure === 404)
        await expect(
          page.getByRole("button", { name: "Send", exact: true }),
        ).toHaveCount(0);
      if (failure === 404)
        await expect(
          page.getByRole("link", { name: "Back to search" }),
        ).toHaveAttribute("href", "/search");
      if (failure === 409 || failure === 429)
        await expect(page.locator("[data-retry-after]")).toHaveText(
          "Retry after 17 seconds.",
        );
      expect(posts).toBe(1);
      expect(await rows()).toHaveLength(0);
      await expect(page.getByRole("heading", { name: received })).toHaveCount(
        0,
      );
      if (typeof fault === "number") {
        await expect
          .poll(() => faultSite.logs())
          .toContain(`"requestId":"${upstreamId}"`);
        expect(faultSite.logs()).toContain(`"upstreamStatus":${fault}`);
      } else {
        // The service-binding bridge turns its dropped HTTP connection into 500.
        // The Node run observes the direct transport TypeError instead.
        const expectedType =
          failure === "timeout"
            ? "TimeoutError"
            : workerRuntime
              ? "ApiError"
              : "TypeError";
        await expect
          .poll(() => faultSite.logs().trim().split("\n").at(-1))
          .toContain(`"errorType":"${expectedType}"`);
        const last = JSON.parse(faultSite.logs().trim().split("\n").at(-1)!);
        expect(last.requestId).toBeNull();
        expect(last.upstreamStatus).toBe(
          failure === "network" && workerRuntime ? 500 : null,
        );
      }
      for (const value of [secret, ...Object.values(visitor)])
        expect(faultSite.logs()).not.toContain(value);
    });

  test("honeypot and cross-site posts never reach the engine", async ({
    page,
    request,
  }) => {
    await page.goto(faultOrigin + property);
    await fillInquiry(page, visitor);
    await page.locator('[name="website"]').evaluate((n) => {
      (n as HTMLInputElement).value = "Synthetic bot";
    });
    expect((await submitInquiry(page, property)).status()).toBe(403);
    await expect(page.getByRole("heading", { name: received })).toHaveCount(0);
    const crossSiteHeaders = {
      Origin: "https://foreign.example.invalid",
      "Sec-Fetch-Site": "cross-site",
    };
    const crossSiteLogs = () =>
      faultSite.logs().match(/"errorType":"CrossSitePost"/g) ?? [];
    const previousRejections = crossSiteLogs().length;
    const search = await request.post(faultOrigin + "/search", {
      headers: crossSiteHeaders,
      form: { city: "Example Springs" },
    });
    expect(search.status()).toBe(403);
    expect(await search.text()).toBe(
      "Cross-site POST form submissions are forbidden",
    );
    const searchHeaders = search.headers();
    expect(searchHeaders["cache-control"]).toBeUndefined();
    expect(searchHeaders["referrer-policy"]).toBeUndefined();
    expect(searchHeaders["request-id"]).toBeUndefined();

    const crossSite = await request.post(faultOrigin + property, {
      headers: crossSiteHeaders,
      form: { ...visitor, idempotencyKey: crypto.randomUUID(), website: "" },
    });
    expect(crossSite.status()).toBe(403);
    const rejectedHeaders = crossSite.headers();
    expect(rejectedHeaders["cache-control"]).toBe("no-store");
    expect(rejectedHeaders["referrer-policy"]).toBe("no-referrer");
    const requestId = rejectedHeaders["request-id"];
    expect(requestId).toMatch(uuid);
    const rejection = JSON.stringify({
      event: "demo_inquiry_rejected",
      errorType: "CrossSitePost",
      upstreamStatus: null,
      requestId,
    });
    await expect.poll(() => faultSite.logs()).toContain(rejection);
    expect(crossSiteLogs()).toHaveLength(previousRejections + 1);
    expect(posts).toBe(0);
    expect(await rows()).toHaveLength(0);
  });
});
