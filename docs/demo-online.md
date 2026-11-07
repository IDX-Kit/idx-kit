# Private demo on Workers Builds

These settings use Workers Free and Neon Free. The listings and illustrations are synthetic. Only the operator connects services and deploys; CI uses disposable PostgreSQL 18 and Wrangler dry runs, with no service credentials.

Connect each Worker to this repository with the following settings. Worker names match their Wrangler configs. Root directory is the repository root (`/`) for both. Use production branch **main**, and turn **non-production branch builds off** before adding any build secrets. Node comes from `.nvmrc`. Keep Cloudflare's build token inside Cloudflare; do not add any GitHub environment, secret or deploy workflow.

| Setting | Engine | Site |
| --- | --- | --- |
| Worker name | `idx-kit-demo-engine` | `idx-kit-demo-site` |
| Build command | `npm run demo:prepare` | `npm run workers:check` |
| Deploy command | `npm run demo:deploy:engine` | `npm run demo:deploy:site` |
| Watch paths (include) | `packages/engine/**`, `packages/client/**`, `openapi/**`, `fixtures/**`, `scripts/**`, `package.json`, `package-lock.json`, `.nvmrc` | `examples/demo-site/**`, `packages/client/**`, `openapi/**`, `scripts/**`, `package.json`, `package-lock.json`, `.nvmrc` |

Keep the default dependency installation (`npm ci` with the committed lockfile). The engine build creates the restricted login, migrates, seeds and registers the key, then checks an authenticated API search using that login. Repeating a build preserves the data and key. `npm run demo:key -- sync-demo` repeats only key registration; `npm run demo:check` repeats only the listing check. The engine deploy command bundles the contract and substitutes the Hyperdrive id in a temporary config. The site deploy command builds Astro for Workers and runs Wrangler with its generated config, including the `demo.idxkit.com` custom domain.

| Name | Where it belongs | Value |
| --- | --- | --- |
| `MIGRATION_DATABASE_URL` | Engine production build trigger, secret | Neon owner role's **direct** PostgreSQL connection, including database and required TLS options. This role must be able to create/manage `idx_runtime` and own the schema. |
| `RUNTIME_DATABASE_PASSWORD` | Engine production build trigger, secret | Random password, at least 32 characters; use a password generator. Store the identical password in Hyperdrive. |
| `IDX_SECRET_KEY` | Engine production build trigger, secret; also site Worker runtime secret | `idx_secret_` followed by base64url encoding of 32 random bytes (43 characters without padding). Generate securely, for example with `node -e 'console.log("idx_secret_" + require("node:crypto").randomBytes(32).toString("base64url"))'` in the operator's secure environment. Never commit or log the value. |
| `DEMO_HYPERDRIVE_ID` | Engine production build trigger, ordinary variable | Id returned when creating the Hyperdrive configuration. Keep this account-specific value out of the repository. |

The engine Worker has no secret. Its `HYPERDRIVE` binding supplies the restricted database connection. The site's `IDX_ENGINE` service binding calls the engine privately, and `IDX_SECRET_KEY` stays on the server. The engine's build secret and the site's runtime secret must match; a new key revokes every other active key for `site_demo_primary`. No hash or generated key value is printed by preparation. For password rotation, update both the engine build secret and Hyperdrive before rebuilding.

First-time order:

1. Confirm Access already covers **demo.idxkit.com** at the edge, with the intended private allow policy. This happens before any build. Both Workers disable workers.dev and preview URLs; the engine has no public route. CI checks these settings. There is no deploy-time Access guard.
2. Connect the engine production trigger with its three build secrets, leaving `DEMO_HYPERDRIVE_ID` unset. Run its first build. Preparation creates `idx_runtime` with login and no elevated privileges or other role membership, runs migrations and fixture seed, registers the key with only `listings:read`, and checks the seeded listings. The deploy step then stops with **Missing DEMO_HYPERDRIVE_ID** by design.
3. Create one Hyperdrive configuration named **idx-kit-demo**: use the owner connection's direct host, port, database and TLS settings, change the user to **idx_runtime**, and use `RUNTIME_DATABASE_PASSWORD`. Do not use the owner login or Neon's pooled host. Turn **query caching off**, so withdrawals apply on the next request. Set the resulting id as `DEMO_HYPERDRIVE_ID` on the engine production trigger. The engine is placed in `aws:us-east-1`, next to the demo database.
4. Retry the engine build. Its password setup keeps the runtime login equal to the Hyperdrive password. Its deploy command uses the supplied id without changing the committed placeholder.
5. Set the site's Worker runtime secret `IDX_SECRET_KEY`, then connect its production trigger with the site settings above and run its first build. Wrangler attaches the custom domain already covered by Access. Do not put this secret on the site's build trigger.
6. Confirm Workers Builds checks passed on the reviewed, merged full `main` commit and record their links. Later reviewed merges rebuild the affected Workers through these production triggers.

References: [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/), [Wrangler deploy options](https://developers.cloudflare.com/workers/wrangler/commands/workers/), [Hyperdrive configuration](https://developers.cloudflare.com/hyperdrive/configuration/), [query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/). Wrangler has no deploy flag to replace a Hyperdrive binding's id; it belongs in the config, which is why the engine command generates a temporary one.
