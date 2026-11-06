# IDX Kit

IDX Kit is an early project to build a free, self-hostable listings engine and
API for real estate agents, teams and brokerages. It is designed around the
RESO data standard. Showing real listings requires your own data license from
your MLS.

## Status

This project is early. The engine serves discovery, its contract, authorized
synthetic listing detail and search with paging. Inquiries and the demo website
are not implemented.

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

The checks also start the engine and validate real HTTP responses and required
headers against the checked-in contract, with negative controls. They cover key
creation, revocation and rotation, display metadata, withholding, version and input
errors, search and paging, redacted logs and a stopped database. They do not cover
website rendering, inquiries, real feeds or deployment. All execution checks run in CI.

## Engine and secret keys

After migrating and seeding a dedicated database, use the migration connection
in `DATABASE_URL` to manage keys. Each command requires explicit scopes; the
supported scopes are `listings:read`, `inquiries:write` and `inquiries:read`.
Inquiry scopes reserve permissions for later endpoints. There is no key API.

```sh
npm run demo:key -- create site_demo_primary listings:read /absolute/private/listing.secret
npm run demo:key -- rotate KEY_ID listings:read /absolute/private/replacement.secret
npm run demo:key -- revoke KEY_ID
```

The command prints only a key ID. It generates 256 random bits, stores a SHA-256
hash and writes the value once to a new mode-0600 file. An existing path is never
overwritten. Rotation creates a key for the old key's Site and revokes the old
one in the same transaction. Protect the file and keep it outside the repository.

Set `RUNTIME_DATABASE_URL` to the restricted runtime role's connection and run
`npm run demo:engine`. It binds only to `127.0.0.1:8787`. Anonymous `GET /api`
reports the installed release and implemented capabilities; `GET
/api/v1/openapi.json` converts this checkout's contract to JSON. Send the file's
value as `Authorization: Bearer ...` from a server to read
`GET /api/v1/listings/lst_demo_0001`. Never put a key in browser code, a URL or
logs. Requests with a secret key and an Origin header are refused; no CORS
headers are sent. Listing responses are private and no-store. Unknown,
withdrawn and unlicensed listings share a generic 404; expired feeds fail closed.
Consumers must render permitted facts and both sets of required display blocks
together, keeping site branding outside the listing body. Fixtures are synthetic.

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
