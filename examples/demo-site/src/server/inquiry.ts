import { ApiError } from "@idx-kit/client";
import { z } from "astro/zod";
import {
  engineClient,
  logFailure,
  PageFailure,
  searchProblem,
} from "./engine.ts";
import { writeLog } from "./log.ts";

export const inquiryFields = ["name", "email", "message"] as const;
const validationIssues = z.array(
  z.object({
    detail: z.string(),
    pointer: z.string().optional(),
    parameter: z.string().optional(),
    header: z.string().optional(),
  }),
);
export type InquiryField = (typeof inquiryFields)[number];
export function emptyInquiry() {
  return {
    key: crypto.randomUUID() as string,
    values: { name: "", email: "", message: "" },
    errors: {} as Partial<Record<InquiryField, string>>,
    message: "",
    retry: false,
    unavailable: false,
    missing: false,
    retryAfter: null as string | null,
  };
}
export type InquiryForm = ReturnType<typeof emptyInquiry>;

export function inquiryFailure(
  error: unknown,
  form: InquiryForm,
  retryAfter: string | null,
) {
  const cause = error instanceof PageFailure ? error.cause : error;
  const status = cause instanceof ApiError ? cause.status : 503;
  const problem = searchProblem(error);
  if (status === 422 && problem.code === "idempotency_mismatch") {
    form.key = crypto.randomUUID();
    form.message = "Your message has changed. Please send it again.";
  } else if (status === 400 || status === 422) {
    const issues = validationIssues.safeParse(problem.errors);
    for (const issue of issues.data ?? []) {
      const field = inquiryFields.find(
        (name) =>
          issue.pointer ===
          (name === "message" ? "/message" : `/visitor/${name}`),
      );
      if (field) form.errors[field] = "Check this field.";
    }
    // Malformed errors and unrecognized fields still need a safe prompt.
    if (!Object.keys(form.errors).length) form.message = "Check this field.";
  } else if (status === 401 || status === 403) {
    form.message = "This form isn't available right now.";
    form.unavailable = true;
  } else if (status === 404) {
    form.message = "This listing is no longer available.";
    form.missing = true;
  } else if (status === 409 || status === 429) {
    form.message = "Please wait, then retry.";
    form.retry = true;
    // Only a valid HTTP Retry-After value is visitor guidance, never raw details.
    if (
      retryAfter !== null &&
      (/^\d{1,10}$/.test(retryAfter) ||
        /^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retryAfter))
    )
      form.retryAfter = retryAfter;
  } else {
    form.message = "We can't confirm this was received.";
    form.retry = true;
  }
  return status;
}

export async function sendInquiry(request: Request, listingId: string) {
  const form = emptyInquiry();
  let engine: ReturnType<typeof engineClient> | undefined;
  try {
    // Astro's checkOrigin protects form content types before this page runs.
    const body = await request.formData();
    for (const field of inquiryFields) {
      const value = body.get(field);
      form.values[field] = typeof value === "string" ? value : "";
    }
    // Form encoding sends CRLF, while the textarea counts each newline as LF.
    form.values.message = form.values.message.replace(/\r\n?/g, "\n");
    const key = body.get("idempotencyKey");
    form.key = typeof key === "string" ? key : "";
    if (body.get("website")) {
      writeLog({
        event: "demo_inquiry_rejected",
        errorType: "Honeypot",
        upstreamStatus: null,
        requestId: null,
      });
      form.message = "This form isn't available right now.";
      form.unavailable = true;
      return { form, status: 403 };
    }
    engine = engineClient();
    const receipt = await engine.createInquiry(
      {
        listingId,
        visitor: { name: form.values.name, email: form.values.email },
        message: form.values.message,
        context: { pagePath: `/properties/${listingId}` },
      },
      form.key,
    );
    if (receipt.data) return { receipt: receipt.data };
    return { form, status: 303 };
  } catch (error) {
    logFailure(error, engine?.context());
    const status = inquiryFailure(
      error,
      form,
      engine?.context().retryAfter ?? null,
    );
    return { form, status };
  }
}
