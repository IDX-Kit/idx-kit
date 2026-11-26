import engine from "@idx-kit/engine/src/runtime/worker.ts";
import { routeResendToLoopback } from "../api/email-fetch.ts";

declare const IDX_TEST_RESEND_URL: string;
routeResendToLoopback(IDX_TEST_RESEND_URL);

export default {
  fetch(...[request, env, context]: Parameters<typeof engine.fetch>) {
    return engine.fetch(request, env, {
      waitUntil(task) {
        console.error(JSON.stringify({ operation: "test.waitUntil" }));
        context.waitUntil(task);
      },
    });
  },
};
