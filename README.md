# IDX Kit

IDX Kit is an early project to build a free, self-hostable listings engine and
API for real estate agents, teams and brokerages. It is designed around the
RESO data standard. Showing real listings requires your own data license from
your MLS.

## Status

This project is early. The database schema and synthetic fixture loader are the
first building blocks. The HTTP engine and demo website are not implemented.

The first milestone is a demo with clearly fake listings. A visitor goes from
a guide page to search to a property page, then sends an inquiry. The demo
uses only the public API.

## Database development

Use Node 24.14.1 (see `.nvmrc`) and PostgreSQL 16. The npm workspace lockfile
pins the dependencies. The database commands are:

```sh
npm ci
npm run demo:db:migrate
npm run demo:seed
```

Set `DATABASE_URL` to a dedicated database owned by a migration role. Create a
separate role named `idx_runtime` before migrating. Revoke public schema creation
from `PUBLIC`; the runtime role must not inherit schema ownership or other roles.
The migration role owns the tables; `idx_runtime` receives only schema usage and
read access. Seeding uses the migration connection, never the runtime role.
Repeating the seed keeps public listing IDs and updates facts by feed/source key.
The fixtures contain 24 invented listings, including deliberately undisplayable
and expired records. See [fixture provenance](fixtures/RIGHTS.md).

[CI](.github/workflows/ci.yml) defines the disposable Linux runner setup, contract
lint, reproducible client generation, compatibility typecheck and database tests.
The tests require an empty dedicated database plus `RUNTIME_DATABASE_URL` for the
restricted role. The workflow creates its own loopback PostgreSQL 16 cluster on
port 55432 and stops that cluster when finished. The generated client comes only
from `openapi/v1/openapi.yaml`; regenerate it with `npm run contract:generate`.

These checks cover the database foundation. They do not cover HTTP behavior,
listing rendering, inquiries, real feeds or deployment.

## License

IDX Kit is source available under FSL-1.1-ALv2. Anyone may use, copy, change
and share it for any purpose except a Competing Use: making it available to
others in a commercial product or service that substitutes for it or offers
the same or substantially similar functionality. Running it for your own
business, or setting it up for a client, is allowed. Each version also becomes
available under Apache 2.0 two years after it is published. See
[LICENSE.md](LICENSE.md) for the full terms.

## Feedback and security

Bug reports, questions and ideas are welcome. Code contributions are not
accepted. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue.
Report security vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).
