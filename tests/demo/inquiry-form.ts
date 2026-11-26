import type { Page } from "@playwright/test";

export const inquiryKeyField = '[name="idempotencyKey"]';

export async function fillInquiry(
  page: Page,
  visitor: { name: string; email: string; message: string },
  message = visitor.message,
) {
  await page.getByLabel("Name", { exact: true }).fill(visitor.name);
  await page.getByLabel("Email", { exact: true }).fill(visitor.email);
  await page.getByLabel("Message", { exact: true }).fill(message);
}

export async function submitInquiry(
  page: Page,
  path: string,
  action = "Send",
) {
  const posted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === path,
  );
  await page.getByRole("button", { name: action, exact: true }).click();
  return posted;
}

export async function restoreInquiryKey(page: Page, key: string) {
  await page.locator(inquiryKeyField).evaluate((input, value) => {
    (input as HTMLInputElement).value = value;
  }, key);
}
