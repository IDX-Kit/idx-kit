import { ApiError } from "@idx-kit/client";
import { engineClient, logFailure, PageFailure, searchProblem } from "./engine.ts";
import { writeLog } from "./log.ts";

export const inquiryFields = ["name", "email", "message"] as const;
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
    for (const issue of problem.errors ?? []) {
      const field = inquiryFields.find(
        (name) =>
          issue.pointer ===
          (name === "message" ? "/message" : `/visitor/${name}`),
      );
      if (field) form.errors[field] = "Check this field.";
    }
    // Unrecognized fields must still leave a useful, safe correction prompt.
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
    const key = body.get("idempotencyKey");
    if (typeof key === "string") form.key = key;
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
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(form.key)) {
      form.key = crypto.randomUUID();
      form.message = "Check this field.";
      writeLog({
        event: "demo_inquiry_rejected",
        errorType: "InvalidFormKey",
        upstreamStatus: null,
        requestId: null,
      });
      return { form, status: 400 };
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
    return { form, status: 303, receipt: receipt.data };
  } catch (error) {
    logFailure(error, engine?.context());
    const status = inquiryFailure(error, form, engine?.context().retryAfter ?? null);
    return { form, status };
  }
}
