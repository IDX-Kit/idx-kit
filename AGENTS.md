# Repository instructions

## Code layout

- [`packages/engine`](packages/engine) contains the HTTP API, listing normalization,
  display rules, fixture connector, database migrations and runtime entry points.
- [`openapi/v1/openapi.yaml`](openapi/v1/openapi.yaml) defines the wire contract.
  [`packages/client`](packages/client) contains the generated TypeScript client and
  its package entry point.
- [`examples/demo-site`](examples/demo-site) is a server-rendered reference site.
  The engine never imports website code. The site calls only the public API through
  the client.
- [`fixtures`](fixtures) contains the invented listings and illustrations. Read
  [the fixture provenance](fixtures/RIGHTS.md) before adding data or media.

## Checks

All checks run on standard Ubuntu 24.04 GitHub-hosted runners. The
[CI workflow](.github/workflows/ci.yml) runs formatting, lint, dependency audit,
contract validation, client generation, type checks, runtime builds and tests.
The clean demo job follows the [quick start](docs/demo-setup.md) on its own runner
with a disposable PostgreSQL 18 cluster. Check CI on the commit you want verified.

Change the OpenAPI source first when the wire contract changes. Regenerate the
client with `npm run contract:generate`, which CI also runs and checks for drift.
Keep the [API rules](docs/api-rules.md) consistent with the implemented behavior.

## Add a test

- Put focused `*.test.ts` files in [`tests`](tests) for behavior tested with
  the Node test runner. Extend the appropriate suite under [`tests/api`](tests/api)
  for HTTP behavior and use its existing contract validator.
- Put browser journeys in [`tests/demo`](tests/demo). Use the shared
  [Playwright configuration](playwright.config.ts) with JavaScript disabled to
  verify server-rendered navigation and form submission.
- Use existing database, engine and site helpers. Add a new entry point to the
  CI workflow when the existing suite commands do not discover it.

## Code rules

- Reuse repository code first, then the language standard library and established
  dependencies. Use the existing HTTP and validation middleware and parameterized
  SQL. Make new code straightforward to read with plain names and one statement
  per line.
- Use only synthetic people, listings, images and credentials in examples and
  tests. Keep actual secrets, database connections and visitor data out of source,
  browser code and logs.
- Preserve the display and disclosure data that accompanies listing facts, and
  preserve existing API request and response behavior within the major version.
