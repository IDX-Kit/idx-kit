import { Resend } from "resend";
import type { InquiryInput } from "@idx-kit/client";
import type { ReceiptRow } from "../db/inquiries.ts";
import type { ListingRow } from "../db/read.ts";
import { logLine } from "../log.ts";

export interface InquiryEmailEnv {
  RESEND_API_KEY?: string;
  INQUIRY_EMAIL_FROM?: string;
  INQUIRY_EMAIL_TO?: string;
  RESEND_BASE_URL?: string;
}

export function inquiryEmailSettings(env: InquiryEmailEnv) {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.INQUIRY_EMAIL_FROM?.trim();
  const to = env.INQUIRY_EMAIL_TO?.trim();
  if (!apiKey && !from && !to) return { mode: "off" } as const;
  if (!apiKey || !from || !to) return { mode: "incomplete" } as const;
  return {
    mode: "enabled",
    apiKey,
    from,
    to,
    baseUrl: env.RESEND_BASE_URL,
  } as const;
}

export type InquiryEmailSettings = ReturnType<typeof inquiryEmailSettings>;

export async function sendInquiryEmail(
  settings: InquiryEmailSettings,
  input: InquiryInput,
  row: ReceiptRow,
  listing: ListingRow,
  requestId: string,
  log: (line: string) => void,
) {
  const fields = { operation: "inquiry.email", inquiryId: row.id, requestId };
  const fail = (errorType: string, upstreamStatus: number | null = null) =>
    log(logLine({ ...fields, outcome: "failure", errorType, upstreamStatus }));
  if (settings.mode === "off") return;
  if (settings.mode === "incomplete") {
    fail("ConfigurationError");
    return;
  }
  try {
    const address =
      listing.rules_version === "1" &&
      listing.expires_at.getTime() > Date.now() &&
      !listing.withheld_fields.includes("address")
        ? listing.address
        : null;
    const listingAddress = address
      ? [
          address.line1,
          address.city,
          address.region,
          address.postalCode,
          address.country,
        ].join(", ")
      : null;
    const text = [
      `Name: ${input.visitor.name}`,
      `Email: ${input.visitor.email}`,
      `Listing ID: ${listing.id}`,
      `Listing address: ${listingAddress ?? "Unavailable"}`,
      `Page path: ${input.context.pagePath}`,
      ...(input.context.landingPagePath
        ? [`Landing page path: ${input.context.landingPagePath}`]
        : []),
      `Received at: ${row.received_at.toISOString()}`,
      `Inquiry ID: ${row.id}`,
      "",
      "Message:",
      input.message,
    ].join("\n");
    const resend = new Resend(settings.apiKey, { baseUrl: settings.baseUrl });
    const signal = AbortSignal.timeout(3000);
    // The SDK forwards these fetch options along with the idempotency key.
    const options = {
      idempotencyKey: row.id,
      signal,
      redirect: "manual" as const,
    };
    const { data, error } = await resend.emails.send(
      {
        from: settings.from,
        to: settings.to,
        replyTo: input.visitor.email,
        subject: `New inquiry for ${listingAddress ?? listing.id}`,
        text,
      },
      options,
    );
    const status = error?.statusCode;
    if (
      typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 300 &&
      status <= 599
    ) {
      fail("EmailServiceError", status);
    } else if (signal.aborted) {
      fail("TimeoutError");
    } else if (typeof data?.id === "string" && !error) {
      log(logLine({ ...fields, outcome: "success" }));
    } else {
      fail(error?.statusCode === null ? "NetworkError" : "EmailServiceError");
    }
  } catch {
    // Provider messages and exception details can contain the email payload.
    fail("EmailSendError");
  }
}
