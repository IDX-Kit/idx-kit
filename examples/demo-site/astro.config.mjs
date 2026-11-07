import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import cloudflare from "@astrojs/cloudflare";

const worker = process.env.IDX_WORKER === "1";
export default defineConfig({
  output: "server",
  outDir: worker ? "./dist-worker" : "./dist",
  adapter: worker
    ? cloudflare({ imageService: "passthrough", remoteBindings: false })
    : node({ mode: "standalone" }),
  session: false,
  vite: { define: { "import.meta.env.IDX_WORKER": JSON.stringify(worker) } },
  devToolbar: { enabled: false },
});
