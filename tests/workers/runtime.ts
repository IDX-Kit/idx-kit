import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { captureLog } from "../logs.ts";

export const workerRuntime = process.env.IDX_RUNTIME === "worker";
export async function startWorker(config: string, port: number) {
  const connection = process.env.RUNTIME_DATABASE_URL!;
  assert.equal(new URL(connection).username, "idx_runtime");
  const child = spawn(
    process.execPath,
    [
      "node_modules/wrangler/bin/wrangler.js",
      "dev",
      "--config",
      config,
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      "0",
      "--log-level",
      "error",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: connection,
        WRANGLER_SEND_METRICS: "false",
        NO_COLOR: "1",
      },
    },
  );
  let output = "";
  const capture = (chunk: Buffer) => {
    output += chunk.toString();
    captureLog(`worker-${port}`, chunk.toString());
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const exited = once(child, "exit");
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    await exited;
  };
  let readyId: string | null = null;
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) break;
    const response = await fetch(
      `http://127.0.0.1:${port}${port === 8787 ? "/api" : "/"}`,
    ).catch(() => null);
    if (response?.ok) {
      readyId = response.headers.get("Request-Id");
      return {
        // Wrangler adds terminal prefixes. Keep only the application's JSON records.
        logs: () =>
          output
            .split("\n")
            .flatMap((line) => {
              const plain = stripVTControlCharacters(line);
              const json = plain.slice(plain.indexOf("{"));
              try {
                const record = JSON.parse(json);
                return readyId !== null && record.requestId === readyId
                  ? []
                  : [json];
              } catch {
                return [];
              }
            })
            .join("\n"),
        stop,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await stop();
  throw new Error(
    `Local Worker on ${port} did not start; inspect captured Worker logs.`,
  );
}

export async function startWorkerSite(
  secret: string,
  base: string,
  port: number,
) {
  const directory = await mkdtemp(`${tmpdir()}/idx-worker-site-`);
  const path = resolve("examples/demo-site/dist-worker/server/wrangler.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  config.main = resolve(dirname(path), config.main);
  if (config.assets)
    config.assets.directory = resolve(dirname(path), config.assets.directory);
  // A unique local name lets a wrong-key site run beside the journey site.
  config.name = `idx-kit-test-site-${port}`;
  let upstream: Awaited<ReturnType<typeof startWorker>> | undefined;
  let site: Awaited<ReturnType<typeof startWorker>> | undefined;
  try {
    if (base !== "http://127.0.0.1:8787") {
      assert.equal(base, "http://127.0.0.1:8788");
      const proxy = `${directory}/upstream.json`;
      await writeFile(
        proxy,
        JSON.stringify({
          name: "idx-kit-test-upstream",
          main: resolve("tests/workers/upstream.mjs"),
          compatibility_date: "2026-11-06",
          workers_dev: false,
          preview_urls: false,
        }),
      );
      upstream = await startWorker(proxy, 8789);
      config.services = [
        { binding: "IDX_ENGINE", service: "idx-kit-test-upstream" },
      ];
    }
    await writeFile(`${directory}/wrangler.json`, JSON.stringify(config));
    await writeFile(`${directory}/.dev.vars`, `IDX_SECRET_KEY=${secret}\n`, {
      mode: 0o600,
    });
    site = await startWorker(`${directory}/wrangler.json`, port);
    const running = site;
    return {
      logs: running.logs,
      async stop() {
        await running.stop();
        await upstream?.stop();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await site?.stop();
    await upstream?.stop();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
