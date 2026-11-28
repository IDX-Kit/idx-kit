# IDX Kit

IDX Kit is an early, free, self-hostable listings engine and API for real
estate agents, teams, and brokerages. It uses the RESO data standard. To show
real listings, you need a data license and feed credentials from your MLS.

## Install

- **Your own server (Node).** Follow the [installer guide](docs/feed-sync.md)
  to prepare PostgreSQL and authorize your site. Then
  [run the API as a service and sync on a timer](docs/feed-sync.md#run-on-your-own-server).
- **Cloudflare.** Follow the [installer guide](docs/feed-sync.md) to prepare
  PostgreSQL and authorize your site. Then
  [deploy the API with Hyperdrive](docs/feed-sync.md#serve-the-engine-api-on-workers)
  and [schedule feed sync](docs/feed-sync.md#keep-a-feed-current-on-workers).

## Try the synthetic demo

Follow the [local quick start](docs/demo-setup.md) to browse invented listings,
open a property page, and send an inquiry that returns a receipt. The
server-rendered demo uses the public API through the TypeScript client.
The [hosted demo guide](docs/demo-online.md) covers the private Workers deployment.

## Documentation

- [API contract](openapi/v1/openapi.yaml) and [API rules](docs/api-rules.md)
- [TypeScript client installation and release recovery](docs/releases/README.md)
- [Scraping limits and reporting](docs/scraping.md)
- [Repository instructions](AGENTS.md) and [fixture provenance](fixtures/RIGHTS.md)

IDX Kit is source available under FSL-1.1-ALv2. See [the license](LICENSE.md)
for permitted uses and the transition to Apache 2.0.

Bug reports, questions, and ideas are welcome. Read the
[contribution policy](CONTRIBUTING.md) before opening an issue. Report security
vulnerabilities privately using the [security policy](SECURITY.md).
