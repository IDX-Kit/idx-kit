import { Resend, type Response as ResendResponse } from "resend";
import type { InquiryInput } from "@idx-kit/client";
import type { ReceiptRow } from "../db/inquiries.ts";
import type { ListingRow } from "../db/read.ts";
import { logLine } from "../log.ts";

export interface InquiryEmailEnv {
  RESEND_API_KEY?: unknown;
  INQUIRY_EMAIL_FROM?: unknown;
  INQUIRY_EMAIL_TO?: unknown;
}

export function inquiryEmailSettings({
  RESEND_API_KEY: key,
  INQUIRY_EMAIL_FROM: sender,
  INQUIRY_EMAIL_TO: recipient,
}: InquiryEmailEnv) {
  if (
    [key, sender, recipient].some(
      (value) => value !== undefined && typeof value !== "string",
    )
  )
    return { mode: "incomplete" } as const;
  const apiKey = typeof key === "string" ? key.trim() : "";
  const from = typeof sender === "string" ? sender.trim() : "";
  const to = typeof recipient === "string" ? recipient.trim() : "";
  if (!apiKey && !from && !to) return { mode: "off" } as const;
  if (!apiKey || !from || !to) return { mode: "incomplete" } as const;
  return { mode: "enabled", apiKey, from, to } as const;
}

export type InquiryEmailSettings = ReturnType<typeof inquiryEmailSettings>;

class InquiryResend extends Resend {
  // Keep the wire status even when an error body omits it or cannot be parsed.
  override async fetchRequest<T>(
    path: string,
    options?: RequestInit,
  ): Promise<ResendResponse<T>> {
    const response = await fetch(this.baseUrl + path, options).catch(
      () => null,
    );
    if (response?.ok)
      return { data: await response.json(), error: null, headers: null };
    await response?.body?.cancel().catch(() => {});
    return {
      data: null,
      error: {
        name: "application_error",
        message: "Email request failed.",
        statusCode: response?.status ?? null,
      },
      headers: null,
    };
  }
}

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
  const signal = AbortSignal.timeout(3000);
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
    const resend = new InquiryResend(settings.apiKey, {
      baseUrl: "https://api.resend.com",
    });
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
    if (status) {
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
    fail(signal.aborted ? "TimeoutError" : "EmailSendError");
  }
}
