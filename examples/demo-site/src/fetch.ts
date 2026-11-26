import { astro, FetchState } from "astro/fetch";
import { writeLog } from "./server/log.ts";

export default {
  fetch: async (request: Request): Promise<Response> => {
    const response = await astro(new FetchState(request));
    // Astro's origin check can reject a POST before middleware sets no-store.
    if (
      request.method === "POST" &&
      response.status === 403 &&
      !response.headers.has("Cache-Control")
    ) {
      const requestId = crypto.randomUUID();
      writeLog({
        event: "demo_inquiry_rejected",
        errorType: "CrossSitePost",
        upstreamStatus: null,
        requestId,
      });
      response.headers.set("Request-Id", requestId);
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("Referrer-Policy", "no-referrer");
    }
    return response;
  },
};
