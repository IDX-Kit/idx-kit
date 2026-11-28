# Operate a listing feed

## Before you start

- Get a Property endpoint that matches the [feed format](#check-the-feed-format)
  and an MLS-issued bearer token. A username and password alone are insufficient.
  Sync stalls when it expires. See [how to replace it](#replace-the-feed-token).
- Have a direct PostgreSQL connection for an owner that can create roles, the
  freshness window approved in your MLS agreement, and the approved display notices.
- Install the repository's pinned Node version and run `npm ci` from the repository
  root. On Node, use a [service and timer](#run-on-your-own-server) for the
  loopback API and single-attempt sync. For scheduled sync on Cloudflare, use
  Workers Paid and [budget time for the first load](#plan-the-first-load-on-workers).

## Check the feed format

Use HTTPS. Synthetic feeds can also use HTTP on loopback. The connector expects
JSON with a `value` array and an optional `@odata.nextLink`. Omit the link or
set it to `null` on the last page. A relative or absolute link must point to a
different page on the Property URL's origin, at or below its path. The connector
refuses redirects. After a poll saves a mark, the next poll requests
`$filter=ModificationTimestamp ge <mark>`. Translate feeds with a different shape.

| Field | What to send |
| --- | --- |
| `ListingKey` | Stable, nonempty string such as `listing_example`, with no NUL or unpaired surrogates. For new keys, at most 1,024 UTF-8 bytes and at most 2,048 bytes combined with the feed ID. |
| `ModificationTimestamp` | ISO date and time in UTC with `Z`, such as `2026-11-01T12:00:00.000001Z`. Use a nonzero year and at most six fractional digits. Incremental sync rejects revisions more than five minutes ahead of its clock. |
| `StandardStatus` | Active, Active Under Contract, Coming Soon, or Pending, ignoring case and surrounding spaces. Any other value, including a missing status, withdraws the listing. |
| `ListPrice` | `null` or a nonnegative decimal string such as `"425000.00"`. Use up to 64 whole digits without leading zeros and up to 32 fractional digits. Prices are stored in USD. |
| `BedroomsTotal` | `null` or a nonnegative safe integer such as `3`. |
| `Address` | `null` or an object with string fields `line1`, `city`, `region`, `postalCode` and `country`. Each of the first four allows up to 1,024 UTF-8 bytes. Use two uppercase letters for `country`, such as `"US"`. |
| `InternetAddressDisplayYN`, `InternetEntireListingDisplayYN` | JSON booleans. A `false` address flag hides address and photos. A `false` listing flag withdraws the listing. |
| `Images` | Optional array of `{ "url": "/photos/example.jpg", "alt": "Front of house" }` objects. The engine checks the first 128 entries and skips invalid ones. Use HTTPS URLs without credentials or root-relative paths, up to 2,048 characters. Missing, null or blank `alt` becomes `Property photo`. Other alt text allows up to 1,024 UTF-8 bytes. |

A withdrawal needs a valid key and timestamp. For records eligible for display,
missing or invalid required facts cause rejection and can hide a stored listing.
Check [rejection counts in `sync -- status`](#run-and-check-the-feed).

Each response can contain up to 200 records and 8 MiB. Set `pageSize` to an integer
from 1 to 200 to request `Prefer: odata.maxpagesize=N` for polls and scans. With no
setting, the feed chooses the size. If sync reports `page_too_large`, request
smaller pages or ask the feed provider to reduce the response size.

## Plan the first load on Workers

Use **Workers Paid** for scheduled incremental sync. Typical runs exceeded the
Free CPU allowance even at the smallest tested page size. See the
[hosted measurements](#measured-processor-time-on-workers).

A new feed starts expired and becomes current when the first incremental
traversal finishes with at least one accepted record, or when an empty traversal
finishes. By default, the Worker reads up to 10 pages per run every 30 minutes.
For 20,000 records at the maximum 200 records per page, allow 100 pages or
10 runs, about five hours on the default schedule if each run makes progress.
For a faster first load, [temporarily shorten the schedule](#monitor-and-pause-sync).

## Set up the database

Create a PostgreSQL database owned by a login that can create roles. Set
`DATABASE_URL` to that owner's direct connection string, `IDX_SYNC_FEED_FILE`
to the YAML file described below, and `IDX_SYNC_FRESHNESS_SECONDS` to the
positive whole number of seconds approved for the feed in your MLS agreement.
Then run:

```sh
npm run setup
```

Setup runs migrations, applies writer grants, and registers the feed by its
stable ID. A new feed starts expired until its first successful renewal by
incremental sync. On an existing feed, changing the window takes effect on
the next successful renewal. Setup preserves the current expiration, saved
sync position, applied notices, and listings.

Setup creates logins without passwords, so they need a password to connect
when PostgreSQL requires password authentication, and `trust` authentication
allows any login role to connect without one.
For new logins, connect as the owner in `psql` and set the passwords
interactively. The client hashes the passwords before sending them to PostgreSQL.

```text
\password idx_runtime
\password idx_listing_writer
```

Use a feed of your own for real sync. After sync has been applied to the demo
feed, reseeding leaves synced notices on any listings it skips.

For an upgrade, run `npm run setup` from the new checkout, then switch all Node
polls and scans to it and redeploy any sync Worker. `npm run engine:deploy`
updates the [API Worker](#serve-the-engine-api-on-workers) separately. Let old
sync runs finish before editing notices, since old versions still write their
own copy and can miss changes needed for the freshness calculation. If old and
new runs overlapped or you are unsure, run `npm run --silent sync -- scan` on
Node after the old runs finish. Repeat after each `page_limit` until the scan
completes and recomputes the oldest listing ingest time.

## Authorize a site

With `DATABASE_URL` still set to the owner's connection, name the site and feed
it can display. Add `--new-site` when deliberately creating a site, and keep
using the site's existing key if it already has one. For a new key, choose the
scopes it needs and a protected path where the file does not already exist.
To serve listings on Node, follow [Run on your own server](#run-on-your-own-server).
For Cloudflare, follow [Serve the engine API on Workers](#serve-the-engine-api-on-workers).

```sh
npm run demo:key -- authorize site_example feed_example --new-site
npm run demo:key -- create site_example listings:read /path/to/private/site.secret
```

## Set the environment

- `LISTING_WRITER_DATABASE_URL` is the direct PostgreSQL connection string for `idx_listing_writer`.
- `IDX_SYNC_FEED_FILE` is the path to a YAML file with the feed ID, the RESO
  [Property endpoint](#check-the-feed-format), an explicit `synthetic` boolean,
  and the approved disclosures.
- `IDX_SYNC_FEED_TOKEN` is required for `incremental` and `scan`. Both runtimes
  add the `Bearer` prefix to the value in the `Authorization` header. Set the
  value to the token alone.

Keep the YAML and credentials in protected operator configuration. For example:

```yaml
feedId: feed_example
propertyUrl: https://listings.example.test/reso/Property
synthetic: true
disclosures:
  approvedFeedBlocks:
    - id: example_feed
      text: Invented listing feed
      placement: pageFooter
      prominence: normal
  approvedListingBlocks:
    - id: example_listing
      text: Invented listing attribution
      placement: adjacent
      prominence: normal
```

List only the blocks to display, in display order, with their placement and
prominence. Add `disclosures.approvedPageBlocks` with the same block shape for
page notices associated with listings. Omit it when there are none. If your
file uses `requiredListingBlockIds` and `requiredPageBlockIds`, keep only the
selected blocks in the approved arrays and remove both ID lists.

### Replace the feed token

When the token expires and the feed rejects it, sync stops making progress.
On Node, replace `IDX_SYNC_FEED_TOKEN` in the sync environment or service's
environment file before the next invocation. On Cloudflare, update the runtime
secret on the **sync** Worker under **Settings → Variables and Secrets** and
deploy the change. If you use a secrets file for deploys, update that copy too.
If sync shows `stopped`, [start a fresh instance with `resume`](#monitor-and-pause-sync).

## Run and check the feed

`npm run --silent sync -- incremental` reads from the saved position and
renews freshness after an empty traversal or a complete poll with at least one
accepted record. Only eligible revisions move the saved mark forward.
A future-dated removal hides a listing only if its page has no trusted record
for the same listing. The stored revision stays in place.
The first poll or scan records the approved disclosures for the feed.
Incremental polls use those applied disclosures, even if the file has changed
or a poll was already running when a scan applied new ones.
An upgrade to rejection reporting replays a partial poll with earlier records
from its last completed mark and restarts an unfinished scan.

```json
{"feedId":"feed_example","code":"complete","nextStep":{"kind":"none"},"counts":{"accepted":23,"rejected":1,"rejectedByCode":{"invalid_change":1}}}
```

`npm run --silent sync -- scan` repairs missed edits across the feed. To update
notices, edit the approved disclosure blocks in the YAML file at
`$IDX_SYNC_FEED_FILE`, then run `npm run --silent sync -- scan`. The edits take
effect together for the feed and every stored listing when the scan's first
step commits. Upgraded scheduled polls can continue while the scan applies the
change.
A scan can apply explicit withdrawals and preserves listings that are merely
absent unless removal by absence is enabled. Incremental sync renews the feed
freshness window.

```json
{"feedId":"feed_example","code":"complete","nextStep":{"kind":"none"},"pagesRead":3,"recordsSeen":24,"listingsRemoved":0,"counts":{"accepted":23,"rejected":1,"rejectedByCode":{"invalid_change":1}}}
```

The `counts` cover all saved pages in the traversal, including pages from
earlier calls. Accepted records include explicit withdrawals and valid
records already up to date. Each rejected record contributes to one code.

| Code | Meaning |
| --- | --- |
| `invalid_key` | The listing key is missing, unreadable, or too large. |
| `invalid_change` | The revision, listing facts, or disclosures failed validation. |
| `future_revision` | An incremental record's revision is more than five minutes ahead of the sync clock. |

When every record is rejected, the result explains that freshness stayed
unchanged. Start with the reported codes. For `invalid_change`, check the
[feed format](#check-the-feed-format). For `future_revision`, check both clocks.

Enable removal by absence only when you know the feed's full list is complete.
Run `npm run --silent sync -- scan --remove-missing --max-removals N` with both
flags and a nonnegative whole-number limit. If the number of missing listings
exceeds the limit, the run removes none of them and reports `wouldRemove` and
`maxRemovals`. A limit of `0` prevents every removal by absence.

`npm run --silent sync -- status` reads saved state without calling the feed.
Before the first run, the dates reflect initial provisioning. Missing marks,
scan numbers, counts, and outcomes are `null`. A scan number is a decimal string.
Check `expiresAt` against the current time and `lastOutcome` for the latest
saved incremental result, including retries or stops. See `lastRun.counts.rejected`
and `rejectedByCode` for refusals in the latest finished poll or scan. An
interrupted traversal leaves those counts in place until a traversal finishes.

```json
{"feedId":"feed_example","refreshedAt":"2026-11-03T15:00:00+00:00","expiresAt":"2026-11-03T16:00:00+00:00","completedMark":"2026-11-03T14:59:00.000001Z","incrementalInProgress":false,"scanNumber":"1","scanInProgress":false,"recordsSeen":24,"unreadableRecords":0,"lastOutcome":{"code":"complete","httpStatus":null,"nextStep":null,"retrySeconds":null,"savedAt":"2026-11-03T15:00:00+00:00"},"lastRun":{"kind":"scan","finishedAt":"2026-11-03T15:10:00+00:00","counts":{"accepted":23,"rejected":1,"rejectedByCode":{"invalid_change":1}}}}
```

| Exit | Meaning |
| --- | --- |
| `0` | Sync or scan completed, or status was read. Status also succeeds for a stale feed or failed last run. |
| `1` | Check the settings, database connection, or feed setup. |
| `2` | Correct the command or flags. |
| `3` | Try again later. A `waiting` result gives `secondsLeft` before an incremental request can be made. |
| `4` | Check the result and address the cause before running again. |

Usage and settings errors print a diagnostic to standard error. Once the
settings are valid, the command prints a JSON result even if it cannot connect
to the database or find the feed.
When `outcomeSaved` is `false`, `status` still shows the previous
`lastOutcome` because the latest incremental failure, including any wait
the feed requested, could not be saved. The final checkpoint and counts of
a completed traversal are saved together.

Node makes one attempt per invocation and reads up to 1,000 pages. After an
interruption or `page_limit`, run the same command again to resume after the last
saved page. If the feed rejects its continuation, the runner clears it. Run the
command again to continue from the last completed incremental mark or to start a
new scan.

## Run on your own server

`npm run demo:engine` runs the API in the foreground at `127.0.0.1:8787`.
A website hosted elsewhere cannot reach that loopback address directly. Give
its server a private route through a reverse proxy on the engine host, and
keep the site key on the website server.

On Ubuntu, use systemd to keep the API running and invoke sync on a timer.
Create an unprivileged `idxkit` service account. Use the actual checkout and
pinned Node binary paths in place of those below. Put these units in
`/etc/systemd/system` and keep both environment files root-owned with mode `0600`.
Set `RUNTIME_DATABASE_URL` in `engine.env` and the [sync settings](#set-the-environment)
in `sync.env`. Give the service account read access to the feed YAML.

`idx-kit-engine.service`

```ini
[Service]
User=idxkit
WorkingDirectory=/opt/idx-kit
EnvironmentFile=/etc/idx-kit/engine.env
ExecStart=/opt/node/bin/node packages/engine/src/runtime/node.ts
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

`idx-kit-sync.service`

```ini
[Service]
Type=oneshot
User=idxkit
WorkingDirectory=/opt/idx-kit
EnvironmentFile=/etc/idx-kit/sync.env
ExecStart=/opt/node/bin/node --no-warnings packages/engine/src/runtime/sync.ts incremental
```

`idx-kit-sync.timer`

```ini
[Timer]
OnActiveSec=1min
OnUnitInactiveSec=5min

[Install]
WantedBy=timers.target
```

The timer waits five minutes after the service finishes, so scheduled runs
do not overlap. This example assumes an approved one-hour freshness window.
Choose a delay that leaves ample time for a full poll and retries within your
approved window.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now idx-kit-engine.service idx-kit-sync.timer
```

With the same writer database and feed file settings, run
`npm run --silent sync -- status` and check `expiresAt` and `lastOutcome`.

## Serve the engine API on Workers

1. Follow [database setup](#set-up-the-database) to run `npm run setup` and set
   the `idx_runtime` password interactively with `\password idx_runtime` in
   `psql`.
2. Create a Hyperdrive configuration using the direct PostgreSQL host, port,
   database and TLS settings with the `idx_runtime` login. Disable query caching
   so withdrawals apply on the next request.
   [Hyperdrive setup](https://developers.cloudflare.com/hyperdrive/get-started/#manage-caching)
3. Choose a Worker name that is still available. The default is `idx-kit-engine`. Set
   `ENGINE_WORKER_NAME` to choose a different name. If you reuse an existing
   name, confirm the Worker has no routes or custom domains before and after
   the first deploy. In the Cloudflare dashboard, go to **Workers & Pages**,
   select the Worker, and open **Settings → Domains & Routes**.
   [Cloudflare routes](https://developers.cloudflare.com/workers/configuration/routing/routes/#set-up-a-route-in-the-dashboard)

   From the repository root, deploy with the Hyperdrive ID returned by Cloudflare.

   ```sh
   ENGINE_HYPERDRIVE_ID=your_hyperdrive_id npm run engine:deploy
   ```

   The command bundles the API and supplies the ID through a temporary config.
   It adds no public route, `workers.dev` address, or preview URL. Any route
   or custom domain already attached to a Worker of that name stays in place.
   The API uses Smart Placement, which needs traffic from multiple locations
   to optimize where it runs. The demo uses `aws:us-east-1` to stay near its
   database. [Cloudflare placement](https://developers.cloudflare.com/workers/configuration/placement/)
4. [Authorize the site for its feed and create its key](#authorize-a-site)
   using the database owner's connection.
5. Add an HTTP service binding to the website Worker on the same Cloudflare
   account. Use the deployed engine name in `service`.

   ```json
   {
     "services": [{ "binding": "IDX_ENGINE", "service": "idx-kit-engine" }]
   }
   ```

   In the website Worker's **Variables and Secrets** settings, add the key as
   an encrypted runtime secret named `IDX_SECRET_KEY`. Keep it out of build
   variables and browser code. Make the request from server code. The URL
   supplies the API path on a placeholder host, and the binding selects the
   engine Worker.
   [HTTP service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/)

   ```js
   const request = new Request("https://engine.example.invalid/api/v1/listings", {
     headers: { Authorization: `Bearer ${env.IDX_SECRET_KEY}` },
   });
   const response = await env.IDX_ENGINE.fetch(request);
   ```

Set these runtime secrets in the **engine** Worker's **Variables and Secrets**
settings to enable optional features. Leave them unset to keep the features off.

| Feature | Engine Worker runtime secrets |
| --- | --- |
| Inquiry email | Set `RESEND_API_KEY`, `INQUIRY_EMAIL_FROM` (verified sender) and `INQUIRY_EMAIL_TO` (one inbox for all sites served by this engine). |
| Inquiry spam check | Set `TURNSTILE_SECRET_KEY`. The website includes the visitor's challenge token in the `Turnstile-Token` header. |

## Keep a feed current on Workers

The sync Worker runs incremental sync. Run repair scans with the Node command.

1. Create a separate Hyperdrive configuration using the direct PostgreSQL
   connection for `idx_listing_writer`. Disable query caching so each run
   reads the latest saved position and outcome. Replace the placeholder ID for
   `LISTING_WRITER_HYPERDRIVE` in your copy of
   [the sync config](../packages/engine/wrangler.sync.jsonc).
   The `global_fetch_strictly_public` flag lets sync reach a feed served at a
   public URL by another Worker on the same account.
   [Hyperdrive setup](https://developers.cloudflare.com/hyperdrive/get-started/#manage-caching)
2. Add `IDX_SYNC_FEED_JSON` under `vars` in your protected Wrangler config.
   Set it to a string containing the JSON equivalent of the YAML above,
   including the feed ID, Property URL, synthetic flag and disclosures.
   Optionally add `IDX_SYNC_PAGES_PER_RUN` as a string from `"1"` to `"20"`.
   It defaults to 10 pages. Put the bearer token in a protected secrets file
   under the key `IDX_SYNC_FEED_TOKEN`.
3. Deploy with the sync config and the protected secrets file.

   ```sh
   npx wrangler deploy --config packages/engine/wrangler.sync.jsonc \
     --secrets-file /path/to/protected/worker-secrets.json
   ```

### Prepare and deploy from Workers Builds

Connect `idx-kit-sync` to the repository. Use the repository root, the pinned
Node version and the default dependency installation. Set the production branch
to `main` and turn off non-production branch builds before adding secrets.
Set the build command to `npm run sync:prepare` and the deploy command to
`npm run sync:deploy`.

| Setting | Where it belongs | Value |
| --- | --- | --- |
| `MIGRATION_DATABASE_URL` | Build secret | Direct PostgreSQL connection for the schema owner, with the required TLS settings. The owner must be able to create the runtime and writer roles. |
| `IDX_SYNC_FRESHNESS_SECONDS` | Build variable | The approved window in whole seconds, as used by `npm run setup`. |
| `IDX_SYNC_FEED_JSON` | Build variable | JSON equivalent of the YAML above. Use a feed URL without credentials. |
| `SYNC_HYPERDRIVE_ID` | Build variable | ID of the writer's Hyperdrive configuration. |
| `IDX_SYNC_PAGES_PER_RUN` | Optional build variable | Whole number from 1 to 20. Defaults to 10. |
| `IDX_SYNC_SCHEDULE` | Optional build variable | One [Cron Trigger expression](https://developers.cloudflare.com/workers/configuration/cron-triggers/#supported-cron-expressions) in UTC, or `off`. Defaults to `*/30 * * * *`. |
| `IDX_SYNC_CPU_MS` | Optional build variable | Whole number from 10 to 300000. Use a limit supported by your plan. |
| `IDX_SYNC_FEED_TOKEN` | Worker runtime secret | Feed bearer token. Add it as a **Secret** under the Worker's Variables and Secrets settings, outside the build. |

Cloudflare validates the cron expression at deploy time. Workers Builds uses the
same database setup as `npm run setup` and reapplies its configured window on
every build. Run setup locally first, then set the new login passwords with
`psql` as described above. Create the writer's
Hyperdrive configuration with its direct connection settings and query caching
off. Set `SYNC_HYPERDRIVE_ID` and the Worker runtime secret before deploying.
Authorize each site separately.

### Monitor and pause sync

Open `idx-kit-listing-sync` in the Cloudflare Workflows dashboard to see
instances, step attempts and the run's result. Each successful run returns a code,
the next step, the number of pages applied, and the traversal counts. Each
page step includes the counts in its result and log line. A step retried after
sync finishes runs a new poll and reports that poll. `waiting` means the saved
retry delay has yet to elapse. For `stopped`, check the prior run and fix
the cause, then start one fresh instance by hand. This clears the saved hold
before reading the next page. The Node `status` command shows `resumed` as the
last outcome until the next result is saved. If the Worker cannot save an
outcome, the dashboard shows a failed run and the next schedule can try
again from the saved position.

```sh
npx wrangler workflows trigger idx-kit-listing-sync '{"resume":true}' \
  --config packages/engine/wrangler.sync.jsonc
```

To pause, deploy with an empty `triggers.crons` array and let active runs
finish. To resume the schedule, restore `*/30 * * * *` and redeploy. The saved
position carries over. [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/#remove-a-cron-trigger)

Cloudflare says adding, changing or removing a Cron Trigger can take up to
15 minutes to take effect. In the hosted test, a new schedule first ran about
8 minutes after deployment. [Cloudflare Cron Trigger changes](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

For a faster first load, temporarily use a more frequent Cron Trigger. Edit
`triggers.crons` for manual deploys or set `IDX_SYNC_SCHEDULE` for Workers Builds.
After `sync -- status` shows a current `expiresAt`, restore your regular schedule.

### Measured processor time on Workers

On November 27, 2026, the stand-in feed Worker and sync Worker ran on
Cloudflare with 300 heavy invented listings. Cloudflare reports processor
time per Workflow run. These runs handled at most one page each.

| Listings per page | Typical | Range | Runs |
| --- | --- | --- | --- |
| No work to do | 22 ms | 20 to 40 ms | 4 |
| 1 | 22 ms | 8 to 40 ms | 7 |
| 25 | 30 ms | 17 to 58 ms | 8 |
| 50 | 48 ms | 43 to 73 ms | 6 |
| 100 | 65 ms | 41 to 75 ms | 3 |

Two runs of five 25-listing pages used 165 and 176 ms. Each page took
0.4 to 0.9 seconds of wall time and used about 9 to 10 database statements.
These are small samples from one test. Real feeds differ.

For Workflows on Workers Free, Cloudflare's limits page lists 10 ms of
processor time per step. Its pricing page lists 10 ms per invocation.
[Cloudflare Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/) · [Cloudflare Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/)

For runs with several pages, the reported total does not show how much
processor time any single step used. The one-page runs in the table are the
closest estimates of processor time for a page step.

The measured `pageSize` values up to 100 were well within the default Paid
limit. On Workers Paid, the observed runs completed with `IDX_SYNC_CPU_MS`
set to `10`. Sync behavior on Workers Free remains unverified.

The [stand-in feed Worker](../tests/workers/wrangler.stand-in-feed.jsonc) serves
invented listings for hosted sync tests. Its records come from the repository's
[synthetic fixtures](../fixtures/RIGHTS.md).
