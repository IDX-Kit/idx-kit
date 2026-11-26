import { test, expect } from "@playwright/test";
import type { Page, Response as BrowserResponse } from "@playwright/test";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import pg from "pg";
import { execute, keyCommand, startEngine } from "../api/runtime.ts";
import { registerSecret } from "../logs.ts";
import { startSite } from "./runtime.ts";

const origin = "http://127.0.0.1:4321";
const property = "/properties/lst_demo_0001";
// Invented visitor values and fault details, with no real person or property.
const visitor = {
  name: 'Synthetic <b>Visitor</b> & "friend"',
  email: "synthetic-visitor@example.invalid",
  message: 'Synthetic inquiry </textarea><script>bad()</script> & "quote"',
};
const received = "Received by the demo engine; no message was sent";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let secret: string;
let directory: string;
let db: pg.Client;
let engine: Awaited<ReturnType<typeof startEngine>>;
let site: Awaited<ReturnType<typeof startSite>>;
let faultSite: Awaited<ReturnType<typeof startSite>>;
let fault: number | "network" | "timeout" | "lost" = 500;
let code = "invalid_input";
let posts = 0;
let upstreamId: string | null = null;
let lostReceipt: { id: string; receivedAt: string } | undefined;
const faultOrigin = "http://127.0.0.1:4322";
const stub = createServer(async (req, res) => {
  if (req.method !== "POST") {
    const upstream = await fetch(`http://127.0.0.1:8787${req.url}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    res.writeHead(upstream.status, Object.fromEntries(upstream.headers));
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
  res.end(JSON.stringify({
    type: "about:blank", title: "Synthetic failure", status: fault,
    code, requestId: upstreamId,
    detail: Object.values(visitor).join(" "),
    errors: [{ pointer: "/visitor/email", detail: visitor.message }],
  }));
});

async function fill(page: Page, message = visitor.message) {
  await page.getByLabel("Name", { exact: true }).fill(visitor.name);
  await page.getByLabel("Email", { exact: true }).fill(visitor.email);
  await page.getByLabel("Message", { exact: true }).fill(message);
}
async function key(page: Page) {
  return page.locator('[name="idempotencyKey"]').inputValue();
}
async function retained(page: Page, expectedKey: string, message = visitor.message) {
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(visitor.name);
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue(visitor.email);
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(message);
  expect(await key(page)).toBe(expectedKey);
  await expect(page.locator("script, form b")).toHaveCount(0);
}
async function send(page: Page, action = "Send") {
  const response = page.waitForResponse((r) =>
    r.request().method() === "POST" && r.url().includes(property),
  );
  await page.getByRole("button", { name: action, exact: true }).click();
  return response;
}
async function headers(response: BrowserResponse | null) {
  expect(response).not.toBeNull();
  const values = await response!.allHeaders();
  expect(values["cache-control"]).toBe("no-store");
  expect(values["referrer-policy"]).toBe("no-referrer");
  expect(JSON.stringify(values)).not.toContain(secret);
}
async function rows() {
  return (await db.query("SELECT * FROM idx.inquiries ORDER BY received_at")).rows;
}

test.describe.serial("no-JavaScript inquiry forms and durable receipts", () => {
  test.beforeAll(async () => {
    directory = await mkdtemp(`${tmpdir()}/idx-inquiry-`);
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    await execute("npm", ["run", "--silent", "demo:seed"]);
    secret = (await keyCommand(directory, "create", "site_demo_primary",
      "listings:read,inquiries:write,inquiries:read")).secret;
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

  test("direct entry, reload, send, receipt reload and send another inquiry", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url() + JSON.stringify(r.headers())));
    await headers(await page.goto(property));
    const first = await key(page);
    expect(first).toMatch(uuid);
    await headers(await page.reload());
    const second = await key(page);
    expect(second).toMatch(uuid);
    expect(second).not.toBe(first);
    expect(await rows()).toHaveLength(0);
    expect(await page.locator("form").evaluate((n) => n.closest("article"))).toBeNull();
    await fill(page);
    expect((await send(page)).status()).toBe(303);
    await expect(page.getByRole("heading", { name: received })).toBeVisible();
    const [row] = await rows();
    expect(row.visitor_name).toBe(visitor.name);
    expect(row.visitor_email).toBe(visitor.email);
    expect(row.message).toBe(visitor.message);
    expect(row.context).toEqual({ pagePath: property });
    expect(row.idempotency_key).toBe(second);
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
    await fill(page, "Synthetic second inquiry");
    await send(page);
    await expect(page.getByRole("heading", { name: received })).toBeVisible();
    expect(await rows()).toHaveLength(2);
    for (const value of [secret, ...Object.values(visitor)])
      expect(requests.join("")).not.toContain(value);
  });

  test("Back to a sent form replays unchanged and requires a fresh Send after a mismatch", async ({ page }) => {
    await page.goto(property);
    const originalKey = await key(page);
    await fill(page);
    await send(page);
    await expect(page.getByRole("heading", { name: received })).toBeVisible();
    const original = (await rows())[0];
    const receiptUrl = page.url();
    // no-store may make Back revalidate. Restore the old rendered key as a stale tab would.
    await page.goBack();
    if (!(await page.locator('[name="idempotencyKey"]').count()))
      await page.goto(property);
    await page.locator('[name="idempotencyKey"]').evaluate((n, value) => {
      (n as HTMLInputElement).value = value;
    }, originalKey);
    await fill(page);
    await send(page);
    await expect(page).toHaveURL(receiptUrl);
    expect(await rows()).toHaveLength(1);
    await page.goBack();
    if (!(await page.locator('[name="idempotencyKey"]').count()))
      await page.goto(property);
    await page.locator('[name="idempotencyKey"]').evaluate((n, value) => {
      (n as HTMLInputElement).value = value;
    }, originalKey);
    const changed = "Synthetic changed message";
    await fill(page, changed);
    expect((await send(page)).status()).toBe(422);
    await expect(page.getByRole("alert")).toHaveText("Your message has changed. Please send it again.");
    const fresh = await key(page);
    expect(fresh).toMatch(uuid);
    expect(fresh).not.toBe(originalKey);
    await retained(page, fresh, changed);
    expect(await rows()).toEqual([original]);
    await send(page);
    await expect(page.getByRole("heading", { name: received })).toBeVisible();
    expect(await rows()).toHaveLength(2);
  });

  test("lost response after commit retries the same key to the original receipt", async ({ page }) => {
    fault = "lost";
    await page.goto(faultOrigin + property);
    const originalKey = await key(page);
    await fill(page);
    await send(page);
    await expect(page.getByRole("alert")).toHaveText("We can't confirm this was received.");
    await retained(page, originalKey);
    expect(posts).toBe(1);
    expect(await rows()).toHaveLength(1);
    const expected = lostReceipt;
    // Pass the retry through to the real engine, returning its retained receipt.
    fault = 201;
    await send(page, "Retry");
    await expect(page.getByRole("heading", { name: received })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("receipt")).toBe(expected?.id);
    expect(await page.locator("time").getAttribute("datetime")).toBe(expected?.receivedAt);
    expect(posts).toBe(2);
    expect(await rows()).toHaveLength(1);
  });

  for (const failure of [400, 422, 401, 403, 404, 409, 429, 500, 503, "network", "timeout", "mismatch"] as const)
    test(`safe guidance and retained values for ${failure}`, async ({ page }) => {
      fault = failure === "mismatch" ? 422 : failure;
      code = failure === "mismatch" ? "idempotency_mismatch" : "invalid_input";
      await headers(await page.goto(faultOrigin + property));
      const originalKey = await key(page);
      await fill(page);
      const response = await send(page);
      await headers(response);
      const newKey = await key(page);
      if (failure === "mismatch") {
        expect(newKey).toMatch(uuid);
        expect(newKey).not.toBe(originalKey);
      } else expect(newKey).toBe(originalKey);
      await retained(page, newKey);
      const expected = failure === "mismatch"
        ? "Your message has changed. Please send it again."
        : failure === 400 || failure === 422 ? "Check this field."
        : failure === 401 || failure === 403 ? "This form isn't available right now."
        : failure === 404 ? "This listing is no longer available."
        : failure === 409 || failure === 429 ? "Please wait, then retry."
        : "We can't confirm this was received.";
      if (failure === 400 || failure === 422) {
        await expect(page.locator("#inquiry-email-error")).toHaveText(expected);
        await expect(page.getByLabel("Email", { exact: true })).toHaveAttribute("aria-describedby", "inquiry-email-error");
      } else await expect(page.getByRole("alert")).toHaveText(expected);
      const retry = [409, 429, 500, 503, "network", "timeout"].includes(failure);
      await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(retry ? 1 : 0);
      if (failure === 401 || failure === 403 || failure === 404)
        await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
      if (failure === 404) await expect(page.getByRole("link", { name: "Back to search" })).toHaveAttribute("href", "/search");
      if (failure === 409 || failure === 429) await expect(page.locator("[data-retry-after]")).toHaveText("Retry-After: 17");
      expect(posts).toBe(1);
      expect(await rows()).toHaveLength(0);
      await expect(page.getByRole("heading", { name: received })).toHaveCount(0);
      if (typeof failure === "number" || failure === "mismatch") {
        await expect.poll(() => faultSite.logs()).toContain(`"requestId":"${upstreamId}"`);
        expect(faultSite.logs()).toContain(`"upstreamStatus":${fault}`);
      } else {
        await expect.poll(() => faultSite.logs()).toContain(failure === "timeout" ? '"errorType":"TimeoutError"' : '"errorType":"TypeError"');
      }
      for (const value of [secret, ...Object.values(visitor)]) expect(faultSite.logs()).not.toContain(value);
    });

  test("honeypot and cross-site posts never reach the engine", async ({ page, request }) => {
    await page.goto(faultOrigin + property);
    await fill(page);
    await page.locator('[name="website"]').evaluate((n) => { (n as HTMLInputElement).value = "Synthetic bot"; });
    expect((await send(page)).status()).toBe(403);
    await expect(page.getByRole("heading", { name: received })).toHaveCount(0);
    const crossSite = await request.post(faultOrigin + property, {
      headers: { Origin: "https://foreign.example.invalid", "Sec-Fetch-Site": "cross-site" },
      form: { ...visitor, idempotencyKey: crypto.randomUUID(), website: "" },
    });
    expect(crossSite.status()).toBe(403);
    expect(posts).toBe(0);
    expect(await rows()).toHaveLength(0);
  });
});
