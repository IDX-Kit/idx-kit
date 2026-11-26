import { expect, test } from "@playwright/test";
import { access, readFile, stat } from "node:fs/promises";
import pg from "pg";
import { execute, startNodeEngine } from "../api/runtime.ts";
import { registerSecret } from "../logs.ts";
import {
  fillInquiry,
  inquiryKeyField,
  restoreInquiryKey,
  submitInquiry,
} from "./inquiry-form.ts";
import { startNodeSite } from "./runtime.ts";

const directory = process.env.IDX_DEMO_DIR;
const property = "/properties/lst_demo_0001";
const receiptHeading = "Received by the demo engine; no message was sent";
// Invented values for the two synthetic submissions.
const visitor = {
  name: "Synthetic Setup Visitor",
  email: "setup-visitor@example.invalid",
  message: "This is an invented inquiry for the quick start.",
};
const retryMessage = "This invented inquiry was sent during the outage.";

async function rows() {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const result = await db.query(
      "SELECT id, received_at, context, message FROM idx.inquiries ORDER BY received_at",
    );
    return result.rows;
  } finally {
    await db.end();
  }
}

test.describe("clean demo quick start", () => {
  test.skip(!directory, "Run from the demo quick start.");

  test("public instructions are linked and reference existing paths and scripts", async () => {
    const root = new URL("../../", import.meta.url);
    const readme = await readFile(new URL("README.md", root), "utf8");
    const manifest = JSON.parse(
      await readFile(new URL("package.json", root), "utf8"),
    );
    for (const path of [
      "AGENTS.md",
      "docs/api-rules.md",
      "docs/demo-setup.md",
    ]) {
      expect(readme).toContain(`](${path})`);
      const document = new URL(path, root);
      const text = await readFile(document, "utf8");
      for (const [, link] of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
        await access(new URL(link, document));
      }
      for (const [, script] of text.matchAll(/`npm run ([\w:-]+)/g)) {
        expect(manifest.scripts).toHaveProperty(script);
      }
    }
  });

  test("no-JavaScript inquiry survives restart and a database outage can be retried", async ({
    browser,
    page,
  }, testInfo) => {
    test.setTimeout(60_000);
    expect(testInfo.project.use.javaScriptEnabled).toBe(false);
    console.log(`Chromium ${browser.version()}`);
    const keyPath = `${directory}/site.secret`;
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
    const secret = (await readFile(keyPath, "utf8")).trim();
    for (const value of [secret, ...Object.values(visitor), retryMessage]) {
      registerSecret(value);
    }

    const launchEngine = () => startNodeEngine("bash", ["-ec", "demo_engine"]);
    let engine = await launchEngine();
    try {
      const site = await startNodeSite(4321, "bash", ["-ec", "demo_site"]);
      try {
        await page.goto("/");
        await page
          .getByRole("link", { name: "Search Example Springs" })
          .click();
        await expect(page).toHaveURL(/\/search\?/);
        await page
          .locator('[data-listing="lst_demo_0001"]')
          .getByRole("link", { name: "Open property" })
          .click();
        await expect(page).toHaveURL(new RegExp(`${property}$`));

        await page.goto(property);
        const originalKey = await page.locator(inquiryKeyField).inputValue();
        await fillInquiry(page, visitor);
        expect((await submitInquiry(page, property)).status()).toBe(303);
        const heading = page.getByRole("heading", { name: receiptHeading });
        await expect(heading).toBeVisible();
        const receiptUrl = page.url();
        const original = await rows();
        expect(original).toHaveLength(1);
        expect(original[0].context).toEqual({ pagePath: property });
        const receiptId = new URL(receiptUrl).searchParams.get("receipt");
        expect(receiptId).toBe(original[0].id);
        const time = original[0].received_at.toISOString();
        await expect(page.locator("time")).toHaveAttribute("datetime", time);

        await engine.stop();
        await execute("bash", ["-ec", "demo_db_stop"]);
        await execute("bash", ["-ec", "demo_db_start"]);
        engine = await launchEngine();

        await page.reload();
        await expect(page).toHaveURL(receiptUrl);
        await expect(heading).toBeVisible();
        await expect(page.locator("time")).toHaveAttribute("datetime", time);
        await page.goto(property);
        // Submit the original form key as a browser with an older form would.
        await restoreInquiryKey(page, originalKey);
        await fillInquiry(page, visitor);
        expect((await submitInquiry(page, property)).status()).toBe(303);
        await expect(page).toHaveURL(receiptUrl);
        await expect(heading).toBeVisible();
        await expect(page.locator("time")).toHaveAttribute("datetime", time);
        expect(await rows()).toEqual(original);

        await page.getByRole("link", { name: "Send another inquiry" }).click();
        const retryKey = await page.locator(inquiryKeyField).inputValue();
        expect(retryKey).not.toBe(originalKey);
        await fillInquiry(page, visitor, retryMessage);
        await execute("bash", ["-ec", "demo_db_stop"]);
        expect((await submitInquiry(page, property)).status()).toBe(503);
        await expect(page.getByRole("alert")).toHaveText(
          "We can't confirm this was received.",
        );
        await expect(page.locator(inquiryKeyField)).toHaveValue(retryKey);
        await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
          visitor.name,
        );
        await expect(page.getByLabel("Email", { exact: true })).toHaveValue(
          visitor.email,
        );
        await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
          retryMessage,
        );

        await execute("bash", ["-ec", "demo_db_start"]);
        expect(await rows()).toEqual(original);
        expect((await submitInquiry(page, property, "Retry")).status()).toBe(303);
        await expect(heading).toBeVisible();
        const recovered = await rows();
        expect(recovered).toHaveLength(2);
        expect(recovered[0]).toEqual(original[0]);
        expect(recovered[1].message).toBe(retryMessage);
        const recoveredId = new URL(page.url()).searchParams.get("receipt");
        expect(recoveredId).toBe(recovered[1].id);
      } finally {
        await site.stop();
      }
    } finally {
      await engine.stop();
    }
  });
});
