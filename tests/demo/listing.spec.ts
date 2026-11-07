import { startWorkerSite, workerRuntime } from "../workers/runtime.ts";
import { captureLog } from "../logs.ts";
import { test, expect } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import pg from "pg";
import { execute, keyCommand, startEngine } from "../api/runtime.ts";
import type { ListingResponse, SearchResponse } from "@idx-kit/client";
import { FixtureConnector } from "@idx-kit/engine/src/connectors/fixture.ts";
import { seed } from "@idx-kit/engine/src/db/seed.ts";

const origin = "http://127.0.0.1:4321";
const property = "/properties/lst_demo_0001";
let directory: string,
  secret: string,
  engine: Awaited<ReturnType<typeof startEngine>> | undefined;
let site: Awaited<ReturnType<typeof startSite>>;
let db: pg.Client;
async function startSite(base = "http://127.0.0.1:8787", port = 4321) {
  if (workerRuntime) return startWorkerSite(secret, base, port);
  const child = spawn(process.execPath, ["start.mjs"], {
    cwd: "examples/demo-site",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      IDX_ENGINE_URL: base,
      IDX_SECRET_KEY: secret,
      HOST: "127.0.0.1",
      PORT: String(port),
    },
  });
  let logs = "";
  child.stdout.on("data", (chunk) => {
    logs += chunk;
    captureLog("site", String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    logs += chunk;
    captureLog("site", String(chunk));
  });
  const exited = once(child, "exit");
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) break;
    if (
      await fetch(`http://127.0.0.1:${port}/`).then(
        (r) => r.ok,
        () => false,
      )
    ) {
      return {
        logs: () => logs,
        async stop() {
          child.kill("SIGTERM");
          await exited;
        },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await exited;
  }
  throw new Error("Site did not start: " + logs);
}
async function raw(
  request: APIRequestContext,
  path: string,
  status = 200,
  base = origin,
) {
  const response = await request.get(base + path);
  expect(response.status()).toBe(status);
  expect(response.headers()["cache-control"]).toBe("no-store");
  const body = await response.text();
  expect(body + JSON.stringify(response.headers())).not.toContain(secret);
  expect(body).not.toMatch(/<script\b/i);
  return body;
}
test.describe.serial("SSR property pages through the public engine", () => {
  test.beforeAll(async () => {
    directory = await mkdtemp(`${tmpdir()}/idx18-`);
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    await execute("npm", ["run", "--silent", "demo:seed"]);
    secret = (
      await keyCommand(
        directory,
        "create",
        "site_demo_primary",
        "listings:read",
      )
    ).secret;
    engine = await startEngine();
    site = await startSite();
  });
  test.afterAll(async () => {
    await site?.stop();
    await engine?.stop();
    await db?.end();
    await rm(directory, { recursive: true, force: true });
  });

  test("raw HTML includes facts, original illustration, ordered disclosures and feed time", async ({
    request,
    page,
  }) => {
    const html = await raw(request, property);
    for (const text of [
      "active",
      "$425,000.00",
      "101 Imaginary Lantern Lane",
      "Invented synthetic house illustration; no real property",
      "/media/synthetic-house-001.svg",
      "Synthetic Example Brokerage. Invented listing attribution.",
      "Original synthetic data for IDX Kit. These properties do not exist.",
      "2026-11-01T00:00:00.000Z",
    ])
      expect(html).toContain(text);
    await page.goto(property);
    await expect(page.locator('[data-fact="bedrooms"]')).toHaveText("1");
    expect(
      await page
        .locator("[data-block]")
        .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-block"))),
    ).toEqual(["synthetic_broker", "synthetic_notice"]);
    await expect(
      page.locator('[data-placement="afterListing"] [data-block]'),
    ).toHaveText("Synthetic Example Brokerage. Invented listing attribution.");
    await expect(page.locator("article header")).toHaveCount(0);
    await expect(page.locator("header")).toHaveText(
      "IDX Kit demoSynthetic properties for demonstration.",
    );
    for (const n of ["001", "002", "003"])
      expect(await raw(request, `/media/synthetic-house-${n}.svg`)).toContain(
        ">SYNTHETIC</text>",
      );
    await raw(request, "/missing-page", 404);
    await raw(request, "/media/missing.svg", 404);
  });

  test("null facts and a withheld address remain neutral in raw HTML and every context", async ({
    request,
    page,
  }) => {
    const fixtures = JSON.parse(
      await readFile("fixtures/listings.json", "utf8"),
    );
    const hidden = fixtures[1].source.Address;
    const html = await raw(request, "/properties/lst_demo_0002");
    expect(html).not.toContain(hidden.line1);
    expect(html).not.toContain("Hidden Stardust");
    await page.goto("/properties/lst_demo_0002");
    for (const fact of ["address", "bedrooms"])
      await expect(page.locator(`[data-fact="${fact}"]`)).toHaveText(
        "Not available",
      );
    expect(await page.title()).not.toContain(hidden.line1);
    expect(
      await page
        .locator("meta, img")
        .evaluateAll((nodes) => nodes.map((n) => n.outerHTML).join("")),
    ).not.toContain(hidden.line1);
    await raw(request, "/properties/lst_demo_0004");
    await page.goto("/properties/lst_demo_0004");
    await expect(page.locator('[data-fact="price"]')).toHaveText(
      "Not available",
    );
    await db.query(
      "UPDATE idx.listings SET status=NULL, price=NULL, currency=NULL, address=NULL, bedrooms=NULL, images=NULL WHERE id='lst_demo_0001'",
    );
    try {
      await raw(request, property);
      await page.goto(property);
      for (const fact of ["status", "price", "address", "bedrooms"])
        await expect(page.locator(`[data-fact="${fact}"]`)).toHaveText(
          "Not available",
        );
      await expect(page.locator("[data-images] > p")).toHaveText(
        "Not available",
      );
    } finally {
      await execute("npm", ["run", "--silent", "demo:seed"]);
    }
  });

  test("closed listing has the exact disclaimer and attribution without valuation presentation", async ({
    request,
    page,
  }) => {
    const fixtures = JSON.parse(
      await readFile("fixtures/listings.json", "utf8"),
    );
    const record = fixtures[2];
    const html = await raw(request, "/properties/lst_demo_0003");
    expect(html).toContain(record.pageBlocks[0].text);
    expect(html).toContain(record.blocks[0].text);
    await page.goto("/properties/lst_demo_0003");
    await expect(
      page.locator('footer [data-block="closed_information"]'),
    ).toHaveText(record.pageBlocks[0].text);
    // The complete page text is accounted for by chrome, permitted facts, freshness and disclosures.
    const text = (await page.locator("body").innerText())
      .replace(/\s+/g, " ")
      .trim();
    expect(text).toBe(
      [
        "Skip to content IDX Kit demo Synthetic properties for demonstration. Property Status closed Price $425,000.00",
        "Address 103 Make Believe Meadow Way, Example Springs, NC, 00000, US Bedrooms 3",
        record.blocks[0].text,
        "Feed refreshed: Oct 31, 2026, 8:00:00 PM EDT",
        "Original synthetic data for IDX Kit. These properties do not exist.",
        record.pageBlocks[0].text,
      ].join(" "),
    );
  });

  test("missing, withdrawn, wrong-Site, expired and newly withdrawn listings fail closed", async ({
    request,
  }) => {
    for (const id of ["unknown", "lst_demo_0006", "lst_demo_0024"]) {
      expect(await raw(request, `/properties/${id}`, 404)).toContain(
        "Listing not found",
      );
    }
    // Give this Site access to the expired feed only for the expiration check.
    await db.query(
      "INSERT INTO idx.data_licenses VALUES ('site_demo_primary','feed_demo_expired')",
    );
    try {
      expect(await raw(request, "/properties/lst_demo_0023", 503)).toContain(
        "Listing temporarily unavailable",
      );
    } finally {
      await db.query(
        "DELETE FROM idx.data_licenses WHERE site_id='site_demo_primary' AND feed_id='feed_demo_expired'",
      );
    }
    await raw(request, property);
    await db.query(
      "UPDATE idx.listings SET entire_listing_display=false WHERE id='lst_demo_0001'",
    );
    try {
      await raw(request, property, 404);
    } finally {
      await db.query(
        "UPDATE idx.listings SET entire_listing_display=true WHERE id='lst_demo_0001'",
      );
    }
  });

  test("both display contexts preserve placement, order, escaping, icons and prominence", async ({
    page,
    request,
  }) => {
    const block = (id: string, placement: string, prominence: string) => ({
      id,
      placement,
      prominence,
      text: `Synthetic <b>${id}</b> & notice`,
      image: {
        url: "/media/synthetic-house-001.svg",
        alt: `Synthetic ${id} icon`,
      },
    });
    const listingBlocks = [
      block("a", "adjacent", "medianListingText"),
      block("b", "afterListing", "largestListingText"),
      block("c", "pageFooter", "normal"),
    ];
    const pageBlocks = [
      block("d", "adjacent", "normal"),
      block("e", "afterListing", "medianListingText"),
      block("f", "pageFooter", "largestListingText"),
    ];
    await db.query(
      "UPDATE idx.listings SET display_blocks=$1, page_blocks=$2, status='future-status' WHERE id='lst_demo_0001'",
      [JSON.stringify(listingBlocks), JSON.stringify(pageBlocks)],
    );
    try {
      const html = await raw(request, property);
      expect(html).toContain("&lt;b&gt;a&lt;/b&gt; &amp; notice");
      await page.goto(property);
      await expect(page.locator('[data-fact="status"]')).toHaveText(
        "future-status",
      );
      await expect(page.locator("[data-block] b")).toHaveCount(0);
      for (const placement of ["adjacent", "afterListing", "pageFooter"]) {
        const expected = [...listingBlocks, ...pageBlocks].filter(
          (b) => b.placement === placement,
        );
        const blocks = page
          .locator(`[data-placement="${placement}"] [data-block]`)
          .filter({ has: page.locator("img") });
        expect(
          await blocks.evaluateAll((nodes) =>
            nodes.map((n) => n.getAttribute("data-block")),
          ),
        ).toEqual(expected.map((b) => b.id));
        for (const b of expected) {
          await expect(page.locator(`[data-block="${b.id}"]`)).toHaveClass(
            b.prominence,
          );
          await expect(
            page.locator(`[data-block="${b.id}"] img`),
          ).toHaveAttribute("alt", b.image.alt);
        }
      }
      const sizes = await page
        .locator("article h1, article dt, article dd, [data-block]")
        .evaluateAll((nodes) =>
          nodes.map((n) => ({
            largest: n.classList.contains("largestListingText"),
            size: parseFloat(getComputedStyle(n).fontSize),
          })),
        );
      for (const item of sizes.filter((s) => s.largest))
        expect(item.size).toBe(Math.max(...sizes.map((s) => s.size)));
    } finally {
      await execute("npm", ["run", "--silent", "demo:seed"]);
    }
  });

  test("unknown rules or placement or prominence in either context suppress all listing facts", async ({
    request,
  }) => {
    for (const column of ["display_blocks", "page_blocks"]) {
      for (const field of ["placement", "prominence"]) {
        const block = {
          id: "future",
          text: "Do not render this disclosure alone",
          placement: "adjacent",
          prominence: "normal",
          [field]: "future",
        };
        await db.query(
          `UPDATE idx.listings SET ${column}=$1 WHERE id='lst_demo_0001'`,
          [JSON.stringify([block])],
        );
        try {
          const html = await raw(request, property, 503);
          expect(html).not.toContain("101 Imaginary");
          expect(html).not.toContain(block.text);
        } finally {
          await execute("npm", ["run", "--silent", "demo:seed"]);
        }
      }
    }
    await db.query(
      "UPDATE idx.feeds SET rules_version='future' WHERE id='feed_demo_primary'",
    );
    try {
      expect(await raw(request, property, 503)).not.toContain("101 Imaginary");
    } finally {
      await execute("npm", ["run", "--silent", "demo:seed"]);
    }
  });

  for (const width of [1280, 375])
    test(`no-JS landmarks, readable text and keyboard focus at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const browserRequests: string[] = [];
      page.on("request", (r) =>
        browserRequests.push(r.url() + JSON.stringify(r.headers())),
      );
      await page.goto(property);
      await expect(page.getByRole("main")).toBeVisible();
      await expect(page.getByRole("banner")).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "Property",
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      expect(
        await page
          .locator("article p, article dd")
          .evaluateAll((nodes) =>
            nodes.every((n) => parseFloat(getComputedStyle(n).fontSize) >= 16),
          ),
      ).toBe(true);
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("link", { name: "Skip to content" }),
      ).toBeFocused();
      expect(
        await page
          .locator(":focus")
          .evaluate((n) => getComputedStyle(n).outlineStyle),
      ).toBe("solid");
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("link", { name: "IDX Kit demo", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(origin + "/guides/example-springs");
      expect(browserRequests.join("")).not.toContain(secret);
      expect(browserRequests.every((r) => r.startsWith(origin + "/"))).toBe(
        true,
      );
    });

  test("startup refuses missing v1 or listingDetail and renderer refuses future page rules", async ({
    request,
  }) => {
    const sample: ListingResponse = await fetch(
      "http://127.0.0.1:8787/api/v1/listings/lst_demo_0001",
      {
        headers: { Authorization: `Bearer ${secret}` },
      },
    ).then((r) => r.json());
    let versions: unknown[] = [];
    const stub = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          req.url === "/api"
            ? { data: { supportedVersions: versions }, meta: {} }
            : sample,
        ),
      );
    });
    stub.listen(8788, "127.0.0.1");
    await once(stub, "listening");
    try {
      for (const value of [[], [{ major: "v1", capabilities: [] }]]) {
        versions = value;
        const result = await execute(process.execPath, ["start.mjs"], {
          cwd: "examples/demo-site",
          env: {
            ...process.env,
            IDX_ENGINE_URL: "http://127.0.0.1:8788",
            IDX_SECRET_KEY: secret,
          },
          timeout: 10_000,
        }).then(
          () => {
            throw new Error("Unsupported engine was accepted");
          },
          (error) => error,
        );
        expect(result.code).toBe(1);
        captureLog("site", result.stderr);
        expect(result.stderr).toContain(
          "requires a reachable engine with API v1 and listingDetail",
        );
        expect(result.stderr).not.toContain(secret);
      }
      versions = [{ major: "v1", capabilities: ["listingDetail"] }];
      const futureSite = await startSite("http://127.0.0.1:8788", 4322);
      try {
        for (const display of [sample.display, sample.data.display]) {
          Object.assign(display, { rulesVersion: "future" });
          expect(
            await raw(request, property, 503, "http://127.0.0.1:4322"),
          ).not.toContain("101 Imaginary");
          Object.assign(display, { rulesVersion: "1" });
        }
      } finally {
        await futureSite.stop();
        expect(futureSite.logs()).not.toContain(secret);
      }
    } finally {
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  });

  test("guide, filters, both price orders, complete paging, Back and property entry work without JavaScript", async ({
    page,
    request,
  }) => {
    const fixtures = await new FixtureConnector().read();
    // Original synthetic records, expanded only for traversal beyond the default page size.
    for (let i = 0; i < 30; i++) {
      const record = structuredClone(fixtures.listings[0]);
      record.publicId = `lst_search_demo_${String(i).padStart(4, "0")}`;
      record.source.ListingKey = `Synthetic browser traversal ${i}`;
      record.source.ListPrice = `${360000 + i * 1000}.00`;
      record.source.BedroomsTotal = 3;
      fixtures.listings.push(record);
    }
    await seed(db, fixtures);
    const expected = fixtures.listings
      .filter(
        ({ feedId, source: s }) =>
          feedId === "feed_demo_primary" &&
          s.InternetEntireListingDisplayYN &&
          s.InternetAddressDisplayYN &&
          s.Address?.city === "Example Springs" &&
          s.ListPrice !== null &&
          Number(s.ListPrice) >= 350000 &&
          Number(s.ListPrice) <= 450000 &&
          s.BedroomsTotal !== null &&
          s.BedroomsTotal >= 3,
      )
      .map((record) => record.publicId)
      .sort();
    const urls: string[] = [];
    page.on("request", (r) => urls.push(r.url() + JSON.stringify(r.headers())));
    try {
      const root = await request.get(origin, { maxRedirects: 0 });
      expect(root.status()).toBe(302);
      expect(root.headers()["location"]).toBe("/guides/example-springs");
      expect(root.headers()["cache-control"]).toBe("no-store");
      expect(await raw(request, "/guides/example-springs")).toContain(
        "Synthetic site content",
      );
      await page.goto("/");
      await page.getByRole("link", { name: "Search Example Springs" }).click();
      await expect(page.getByLabel("City", { exact: true })).toHaveValue(
        "Example Springs",
      );
      await page.getByLabel("Minimum price").fill("350000");
      await page.getByLabel("Maximum price").fill("450000");
      await page.getByLabel("Minimum bedrooms").fill("3");
      const browse = async (sort: string) => {
        await page.getByLabel("Price order").selectOption(sort);
        await page.getByRole("button", { name: "Search", exact: true }).click();
        const ids: string[] = [];
        const prices: number[] = [];
        let pages = 0;
        while (true) {
          expect(++pages).toBeLessThan(5);
          ids.push(
            ...(await page
              .locator("[data-listing]")
              .evaluateAll((nodes) =>
                nodes.map((n) => n.getAttribute("data-listing")!),
              )),
          );
          const amounts = await page
            .locator('[data-fact="price"]')
            .allTextContents();
          prices.push(
            ...amounts.map((text) => Number(text.replace(/[$,]/g, ""))),
          );
          expect(
            prices.every((price) => price >= 350000 && price <= 450000),
          ).toBe(true);
          expect(
            (
              await page.locator('[data-fact="bedrooms"]').allTextContents()
            ).every((text) => Number(text) >= 3),
          ).toBe(true);
          const html = await raw(
            request,
            new URL(page.url()).pathname + new URL(page.url()).search,
          );
          expect(html).toContain("synthetic_notice");
          await expect(page.getByLabel("Minimum price")).toHaveValue("350000");
          const next = page.getByRole("link", { name: "Next", exact: true });
          if (!(await next.count())) break;
          const nextUrl = new URL((await next.getAttribute("href"))!, origin);
          for (const [name, value] of Object.entries({
            city: "Example Springs",
            minPrice: "350000",
            maxPrice: "450000",
            minBedrooms: "3",
            sort,
          })) {
            expect(nextUrl.searchParams.get(name)).toBe(value);
          }
          expect(nextUrl.searchParams.get("after")).toBeTruthy();
          const earlier = page.url();
          await next.click();
          await page.goBack();
          expect(page.url()).toBe(earlier);
          await page.getByRole("link", { name: "Next", exact: true }).click();
        }
        expect(pages).toBeGreaterThan(1);
        expect([...ids].sort()).toEqual(expected);
        expect(new Set(ids).size).toBe(ids.length);
        return prices;
      };
      const ascending = await browse("price");
      expect(ascending).toEqual([...ascending].sort((a, b) => a - b));
      expect(await browse("-price")).toEqual([...ascending].reverse());
      const link = page
        .getByRole("link", { name: "Open property", exact: true })
        .first();
      const destination = await link.getAttribute("href");
      await link.click();
      expect(new URL(page.url()).pathname).toBe(destination);
      await expect(
        page.getByRole("heading", { name: "Property", exact: true }),
      ).toBeVisible();
      expect(urls.join("")).not.toContain(secret);
      expect(urls.every((url) => url.startsWith(origin + "/"))).toBe(true);
    } finally {
      await db.query(
        "DELETE FROM idx.source_mappings WHERE listing_id LIKE 'lst_search_demo_%'",
      );
      await db.query(
        "DELETE FROM idx.listings WHERE id LIKE 'lst_search_demo_%'",
      );
      await execute("npm", ["run", "--silent", "demo:seed"]);
    }
  });

  test("results HTML contains permitted facts, every disclosure, closed notice and exact decimal prices", async ({
    request,
    page,
  }) => {
    const body = await raw(request, "/search");
    for (const text of [
      "synthetic_broker",
      "synthetic_notice",
      "closed_information",
      "101 Imaginary Lantern Lane",
      "/media/synthetic-house-001.svg",
      "$425,000.00",
      "Not available",
    ])
      expect(body).toContain(text);
    for (const text of [
      "102 Hidden Stardust Way",
      "Hidden Stardust",
      "lst_demo_0006",
      "lst_demo_0023",
      "lst_demo_0024",
    ])
      expect(body).not.toContain(text);
    await page.goto("/search");
    await expect(
      page.locator('[data-listing="lst_demo_0002"] [data-fact="address"]'),
    ).toHaveText("Not available");
    await expect(
      page.locator(
        'footer[aria-label="Search disclosures"] [data-block="closed_information"]',
      ),
    ).toHaveText(
      "Synthetic sale data is for informational use only, not a market analysis or appraisal.",
    );
    await page.getByRole("link", { name: "Next", exact: true }).click();
    await expect(
      page.locator('[data-listing="lst_demo_0004"] [data-fact="price"]'),
    ).toHaveText("Not available");
    const sample: SearchResponse = await fetch(
      "http://127.0.0.1:8787/api/v1/listings",
      {
        headers: { Authorization: `Bearer ${secret}` },
      },
    ).then((r) => r.json());
    for (const listing of sample.data) {
      expect(body).toContain(`data-listing="${listing.id}"`);
      if (listing.address) expect(body).toContain(listing.address.line1);
      for (const image of listing.images ?? []) {
        expect(body).toContain(image.url);
        expect(body).toContain(image.alt);
      }
      for (const block of listing.display.blocks)
        expect(body).toContain(block.text);
    }
    for (const block of sample.display.blocks)
      expect(body).toContain(block.text);
    try {
      for (const [amount, formatted] of [
        ["425000.19", "$425,000.19"],
        ["9007199254740993.19", "$9,007,199,254,740,993.19"],
      ]) {
        await db.query(
          "UPDATE idx.listings SET price=$1 WHERE id='lst_demo_0001'",
          [amount],
        );
        expect(await raw(request, property)).toContain(formatted);
        expect(await raw(request, "/search?sort=-price")).toContain(formatted);
      }
      await db.query(
        "UPDATE idx.listings SET status='future-status' WHERE id='lst_demo_0001'",
      );
      expect(await raw(request, "/search?sort=-price")).toContain(
        "future-status",
      );
    } finally {
      await execute("npm", ["run", "--silent", "demo:seed"]);
    }
  });

  test("search renders listing and page blocks at each placement, including page blocks with no matches", async ({
    page,
  }) => {
    const blocks = ["adjacent", "afterListing", "pageFooter"].map(
      (placement, i) => ({
        id: `synthetic_page_${i}`,
        text: `Synthetic <b>${placement}</b> disclosure`,
        placement,
        prominence: "largestListingText",
        image: {
          url: "/media/synthetic-house-001.svg",
          alt: "Synthetic disclosure icon",
        },
      }),
    );
    const inline = blocks.map((block) => ({
      ...block,
      id: block.id.replace("page", "listing"),
    }));
    await db.query(
      "UPDATE idx.feeds SET display_blocks=$1 WHERE id='feed_demo_primary'",
      [JSON.stringify(blocks)],
    );
    await db.query(
      "UPDATE idx.listings SET display_blocks=$1 WHERE id='lst_demo_0001'",
      [JSON.stringify(inline)],
    );
    try {
      for (const query of ["", "?city=NoSuchSyntheticCity"]) {
        await page.goto("/search" + query);
        const results = page.getByRole("region", { name: "Search results" });
        for (const block of blocks) {
          const notice = results.locator(
            `:scope > [data-placement="${block.placement}"] [data-block="${block.id}"], :scope > footer [data-placement="${block.placement}"] [data-block="${block.id}"]`,
          );
          await expect(notice).toHaveText(block.text);
          await expect(notice).toHaveClass(block.prominence);
          await expect(notice.locator("img")).toHaveAttribute(
            "alt",
            block.image.alt,
          );
        }
        if (!query)
          for (const block of inline) {
            await expect(
              page.locator(
                `[data-listing="lst_demo_0001"] [data-placement="${block.placement}"] [data-block="${block.id}"]`,
              ),
            ).toHaveText(block.text);
          }
        await expect(page.locator("[data-block] b")).toHaveCount(0);
      }
    } finally {
      await execute("npm", ["run", "--silent", "demo:seed"]);
    }
  });

  test("no matches retains page disclosures; field and cursor errors give usable recovery", async ({
    request,
    page,
  }) => {
    const empty = await raw(
      request,
      "/search?city=No%20Such%20Synthetic%20City",
    );
    expect(empty).toContain("No matching properties.");
    expect(empty).toContain(
      "Original synthetic data for IDX Kit. These properties do not exist.",
    );
    expect(empty).not.toContain("data-listing=");
    for (const [query, field, message] of [
      [
        "minPrice=450000&maxPrice=350000",
        "maxPrice",
        "Maximum price must be at least the minimum price.",
      ],
      [
        "minPrice=words",
        "minPrice",
        "Enter a whole US dollar amount, using digits only.",
      ],
    ]) {
      expect(await raw(request, "/search?" + query, 400)).toContain(message);
      await page.goto("/search?" + query);
      await expect(page.locator("#" + field)).toHaveAttribute(
        "aria-describedby",
        field + "-error",
      );
      await expect(page.locator("#" + field + "-error")).toHaveText(message);
      await expect(page.locator("[data-listing]")).toHaveCount(0);
    }
    const query =
      "city=Example+Springs&minPrice=350000&maxPrice=450000&minBedrooms=3&sort=-price";
    expect(
      await raw(request, "/search?" + query + "&after=tampered", 400),
    ).toContain("The results changed.");
    await page.goto("/search?" + query + "&after=tampered");
    await page
      .getByRole("link", { name: "Start again with the same filters" })
      .click();
    expect(new URL(page.url()).searchParams.has("after")).toBe(false);
    await expect(page.getByLabel("Maximum price")).toHaveValue("450000");
    await expect(page.getByLabel("Minimum bedrooms")).toHaveValue("3");
    await expect(page.getByLabel("Price order")).toHaveValue("-price");
    expect(site.logs()).toMatch(
      /"errorType":"ApiError","reason":"engine_request_failed","upstreamStatus":400,"requestId":"[0-9a-f-]{36}"/,
    );
    expect(site.logs()).not.toContain(secret);
  });

  test("search validates disclosures before rendering any facts and reuses expired-data errors", async ({
    request,
  }) => {
    for (const [table, column, id] of [
      ["listings", "display_blocks", "lst_demo_0001"],
      ["feeds", "display_blocks", "feed_demo_primary"],
    ]) {
      for (const field of ["placement", "prominence"]) {
        const block = {
          id: "future",
          text: "Synthetic unsupported disclosure",
          placement: "adjacent",
          prominence: "normal",
          [field]: "future",
        };
        await db.query(`UPDATE idx.${table} SET ${column}=$1 WHERE id=$2`, [
          JSON.stringify([block]),
          id,
        ]);
        try {
          expect(await raw(request, "/search", 503)).not.toContain(
            "data-listing=",
          );
        } finally {
          await execute("npm", ["run", "--silent", "demo:seed"]);
        }
      }
    }
    await db.query(
      "UPDATE idx.feeds SET refreshed_at='2000-01-01', expires_at='2000-01-02' WHERE id='feed_demo_primary'",
    );
    try {
      expect(await raw(request, "/search", 503)).toContain(
        "Listing temporarily unavailable",
      );
    } finally {
      await execute("npm", ["run", "--silent", "demo:seed"]);
    }
  });

  for (const width of [1280, 375])
    test(`search form labels and keyboard access at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/search");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      for (const label of [
        "City",
        "Minimum price (whole US dollars)",
        "Maximum price (whole US dollars)",
        "Minimum bedrooms",
        "Price order",
      ]) {
        await expect(page.getByLabel(label, { exact: true })).toBeVisible();
      }
      for (let i = 0; i < 2; i++) await page.keyboard.press("Tab");
      for (const id of [
        "city",
        "minPrice",
        "maxPrice",
        "minBedrooms",
        "sort",
      ]) {
        await page.keyboard.press("Tab");
        await expect(page.locator("#" + id)).toBeFocused();
        expect(
          await page
            .locator(":focus")
            .evaluate((n) => getComputedStyle(n).outlineStyle),
        ).toBe("solid");
      }
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("button", { name: "Search", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.locator("[data-listing]").first()).toBeVisible();
    });

  test("wrong server key logs the engine status and request ID and shows a generic page", async ({
    request,
  }) => {
    const saved = secret;
    secret = "idx_secret_synthetic_wrong_key";
    const wrong = await startSite("http://127.0.0.1:8787", 4322);
    secret = saved;
    try {
      expect(
        await raw(request, property, 502, "http://127.0.0.1:4322"),
      ).toContain("Unable to load this listing");
      expect(
        await raw(request, "/search", 502, "http://127.0.0.1:4322"),
      ).toContain("Unable to load these results");
      await expect
        .poll(() => wrong.logs())
        .toContain('"category":"key_problem"');
      expect(wrong.logs()).toMatch(
        /"upstreamStatus":401,"requestId":"[0-9a-f-]{36}"/,
      );
      expect(wrong.logs()).toContain('"path":"/api/v1/listings/{listingId}"');
    } finally {
      await wrong.stop();
    }
  });

  test("stopped engine gives safe error pages and captured site logs contain no key", async ({
    request,
  }) => {
    const logStart = site.logs().length;
    await engine!.stop();
    engine = undefined;
    const html = await raw(request, property, 502);
    expect(html).toContain("Unable to load this listing");
    expect(await raw(request, "/search", 502)).toContain(
      "Unable to load these results",
    );
    for (const value of [
      "127.0.0.1",
      "http://",
      "ECONNREFUSED",
      "Error:",
      " at ",
      "postgres",
      "Authorization",
    ])
      expect(html).not.toContain(value);
    const failures = () => site.logs().slice(logStart);
    await expect.poll(failures).toContain('"category":"engine_outage"');
    // A stopped local service binding can throw or return a proxy 503.
    await expect
      .poll(failures)
      .toMatch(
        workerRuntime
          ? /"errorType":"(Error|ApiError)"/
          : /"errorType":"(TypeError|TimeoutError)"/,
      );
    expect(failures()).toMatch(
      workerRuntime ? /"upstreamStatus":(null|503)/ : /"upstreamStatus":null/,
    );
    expect(site.logs()).not.toContain(secret);
  });
});
