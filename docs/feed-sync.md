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

Use HTTPS. HTTP on loopback is for local synthetic feeds only. A deployed sync
Worker needs an HTTPS endpoint reachable from the public internet.

Compare your feed with this synthetic Property response. Translate feeds with a
different shape before using them.

```json
{
  "value": [
    {
      "ListingKey": "listing_example",
      "ModificationTimestamp": "2026-11-01T12:00:00.000001Z",
      "StandardStatus": "Active",
      "ListPrice": "425000.00",
      "BedroomsTotal": null,
      "Address": {
        "line1": "12 Example Lane",
        "city": "Example City",
        "region": "EX",
        "postalCode": "00000",
        "country": "US"
      },
      "InternetAddressDisplayYN": true,
      "InternetEntireListingDisplayYN": true,
      "Images": [{ "url": "/photos/example.jpg", "alt": "Front of house" }]
    }
  ],
  "@odata.nextLink": "?cursor=example_next"
}
```

Include every listing field shown except `Images` on displayable records. Send
`ListPrice`, `BedroomsTotal` and `Address` even when their values are `null`.

| Field | Rules beyond the example |
| --- | --- |
| `ListingKey` | Stable, nonempty string without NUL or unpaired surrogates. New keys allow up to 1,024 UTF-8 bytes and up to 2,048 bytes combined with the feed ID. |
| `ModificationTimestamp` | UTC ISO date and time ending in `Z`, with a nonzero year and up to six fractional digits. Incremental sync rejects revisions more than five minutes ahead of its clock. |
| `StandardStatus` | Active, Active Under Contract, Coming Soon, or Pending, ignoring case and surrounding spaces. Any other value or a missing status withdraws the listing. |
| `ListPrice` | A nonnegative decimal string in USD with up to 64 whole digits without leading zeros and up to 32 fractional digits. |
| `BedroomsTotal` | A nonnegative safe integer when known. |
| `Address` | All five fields are strings. `country` uses two uppercase letters. Each other field allows up to 1,024 UTF-8 bytes. |
| Display flags | JSON booleans. A `false` address flag hides address and photos. A `false` listing flag withdraws the listing. |
| `Images` | The engine checks the first 128 entries and skips invalid ones. Use HTTPS URLs without credentials or root-relative paths, up to 2,048 characters. Missing, null or blank `alt` becomes `Property photo`. Other alt text allows up to 1,024 UTF-8 bytes. |

Withdrawals still need a valid key and timestamp. Missing or invalid required
facts on displayable records cause rejection and can hide a stored listing.
Check [rejection counts in `sync -- status`](#run-and-check-the-feed).

Omit `@odata.nextLink` or set it to `null` on the last page. Links can be relative
or absolute. The connector refuses redirects. After a poll saves a position,
the next poll requests `$filter=ModificationTimestamp ge <mark>`.

Set `pageSize` to an integer from 1 to 200 to request `Prefer: odata.maxpagesize=N`
for polls and scans. The feed can ignore this preference and chooses the size
when it receives none.

| Page outcome | Cause and fix |
| --- | --- |
| `invalid_link` | The connector refused a continuation link. Keep continuations on the Property URL's origin and at or below its path. Even there, use URLs without credentials or fragments and paths without `%2f`, `%5c` or `%25`. |
| `invalid_page` | A response has more than 200 records, invalid JSON or page structure, or a continuation back to the same page. Reduce the record count or correct the response. |
| `page_too_large` | The response exceeds 8 MiB. Request smaller pages or ask the provider to reduce the response size. |

## Plan the first load on Workers

Use **Workers Paid** for scheduled incremental sync. Typical runs exceeded the
Free CPU allowance even at the smallest tested page size. See the
[hosted measurements](#measured-processor-time-on-workers).

Budget for the full first poll before [freshness renews](#run-and-check-the-feed).
By default, the Worker reads up to 10 pages per run every 30 minutes.
For 20,000 records at the maximum 200 records per page, allow 100 pages or
10 runs, about five hours on the default schedule if each run makes progress.
For a faster first load, [temporarily shorten the schedule](#monitor-and-pause-sync).

## Set up the database

Save the feed settings in a protected YAML file. Set the feed ID, the
[Property endpoint](#check-the-feed-format), the `synthetic` flag and the approved notices.
An invalid `propertyUrl` is refused as invalid sync settings before any
page is fetched: Node sync exits `1`, and the sync Worker's Workflow fails.

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

List the approved blocks in display order. For page notices, use the same
block shape in `disclosures.approvedPageBlocks`. If the file still uses
`requiredListingBlockIds` or `requiredPageBlockIds`, keep only the selected
blocks in the approved arrays and remove both ID lists.

Create a PostgreSQL database owned by a login that can create roles. Set
`DATABASE_URL` to that owner's direct connection string and `IDX_SYNC_FEED_FILE`
to the YAML file above. Set `IDX_SYNC_FRESHNESS_SECONDS` to the positive whole
number of seconds approved for the feed in your MLS agreement.
Then run:

```sh
npm run setup
```

Setup runs migrations, applies writer grants, and registers the feed by its
stable ID. Setup preserves the current expiration, saved sync position,
applied notices and listings. A changed window takes effect at the next
[freshness renewal](#run-and-check-the-feed).

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
updates the [API Worker](#serve-the-engine-api-on-workers) separately. Finish
the migrations and replace every running API instance before the new version
serves requests for the same keys. This preserves each key's listing request
limit. Let old sync runs finish before editing notices, since old versions
still write their own copy and can miss changes needed for the freshness
calculation. If old and new runs overlapped or you are unsure, run
`npm run --silent sync -- scan` on Node after the old runs finish to recompute
the oldest listing ingest time.
Repeat after `page_limit` until the scan exits `0` and prints `"code":"complete"`,
then check the [rejection counts](#run-and-check-the-feed).

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

### Rotate or revoke a site key

Use the owner's connection in `DATABASE_URL`. Replace `KEY_ID` with the ID
printed by the key command and choose the [scopes](api-rules.md#secret-keys-and-scopes)
the site needs.

```sh
npm run demo:key -- rotate KEY_ID listings:read /path/to/private/replacement.secret
npm run demo:key -- revoke KEY_ID
```

The key command writes a new secret once to a file with mode `0600`. Store the
file outside the repository and use the secret only on the website server.

## Set the environment

- `LISTING_WRITER_DATABASE_URL` is the direct PostgreSQL connection string for `idx_listing_writer`.
- `IDX_SYNC_FEED_FILE` points to the [feed YAML](#set-up-the-database).
- `IDX_SYNC_FEED_TOKEN` is required for `incremental` and `scan`. Set the token
  alone in protected configuration. Both runtimes add the `Bearer` prefix.

### Replace the feed token

When the token expires and the feed rejects it, sync stops making progress.
On Node, replace `IDX_SYNC_FEED_TOKEN` in the sync environment or service's
environment file before the next invocation. On Cloudflare, update the runtime
secret on the **sync** Worker under **Settings → Variables and Secrets** and
deploy the change. If you use a secrets file for deploys, update that copy too.
If sync shows `stopped`, [start a fresh instance with `resume`](#monitor-and-pause-sync).

## Run and check the feed

A new feed starts expired. `npm run --silent sync -- incremental` reads from
the saved position and renews freshness when a poll finishes with at least
one accepted record or the entire poll is empty.

A completed poll can advance the saved position using a valid key and timestamp
even when it rejects the listing facts. Give the correction a newer modification
time, and run a full scan if that time is older than the saved position.
A future-dated removal hides a listing only if its page has no trusted record
for the same listing. The stored revision stays in place.
The first poll or scan records the approved disclosures for the feed.
Incremental polls use those applied disclosures, even if the file has changed
or a poll was already running when a scan applied new ones.
An upgrade to rejection reporting replays a partial poll with earlier records
from its last completed mark and restarts an unfinished scan.

`npm run --silent sync -- scan` repairs missed edits across the feed. To update
notices, edit the approved disclosure blocks in the YAML file at
`$IDX_SYNC_FEED_FILE`, then run `npm run --silent sync -- scan`. The edits take
effect together for the feed and every stored listing when the scan's first
step commits. Upgraded scheduled polls can continue while the scan applies the
change.
A scan applies explicit withdrawals and preserves absent listings unless you
enable removal by absence. A scan can reach the last page and exit `4` with
`unreadable_keys` or `empty_scan`. Fix invalid `ListingKey` values for
`unreadable_keys`. For `empty_scan`, check the Property URL and confirm the
feed returns the expected records. Run a new scan after fixing the cause.

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
Set `RUNTIME_DATABASE_URL` in `engine.env` to the restricted `idx_runtime`
connection to keep the setup owner's privileges out of the API. Put the
[sync settings](#set-the-environment) in `sync.env` and give the service account
read access to the feed YAML.

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

Complete [database setup](#set-up-the-database) and [site authorization](#authorize-a-site).

1. Create a Hyperdrive configuration using the direct PostgreSQL host, port,
   database and TLS settings with the `idx_runtime` login. Disable query caching
   so withdrawals apply on the next request.
   [Disable Hyperdrive caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/#disable-caching)
2. Choose a Worker name that is still available. The default is `idx-kit-engine`. Set
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
   to optimize where it runs. [Cloudflare placement](https://developers.cloudflare.com/workers/configuration/placement/)
3. Add an HTTP service binding to the website Worker on the same Cloudflare
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

## Configure inquiry email and spam checks

On Node, put these settings in the engine's environment file. On Cloudflare,
add them as encrypted runtime secrets in the engine Worker's **Variables and
Secrets** settings. Leave them unset to keep the features off.

| Feature | Engine settings |
| --- | --- |
| Inquiry email | Set all three values together. `RESEND_API_KEY` needs permission to send email, `INQUIRY_EMAIL_FROM` must be on a verified domain, and `INQUIRY_EMAIL_TO` is one inbox for all sites served by this engine. |
| Inquiry spam check | Set `TURNSTILE_SECRET_KEY`. The website includes the visitor's challenge token in the `Turnstile-Token` header. |

The engine saves the inquiry and returns its receipt while email runs in the
background. A failed email leaves the inquiry saved. The engine sends email
only for a new inquiry. Find failures in the `inquiry.email` logs using the
inquiry ID or Request-Id. Node requires all three email settings at startup
if any are present. On Workers, a partial configuration logs an error for
each newly saved inquiry.

If the API returns `422 spam_check_failed`, refresh the widget so the visitor
can resubmit with a fresh token. Find failures in the `inquiry.spam_check` logs
using the Request-Id. The API can replay a saved receipt without a new token.

## Keep a feed current on Workers

The sync Worker runs incremental sync. Run repair scans with the Node command.
Complete [database setup](#set-up-the-database) and create a separate Hyperdrive
configuration using the direct connection for `idx_listing_writer`. Disable
query caching so runs read the latest saved position and outcome.
[Disable Hyperdrive caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/#disable-caching)

Choose **one** deployment method below.

### Deploy manually

1. Set the ID for `LISTING_WRITER_HYPERDRIVE` in your copy of
   [the sync config](../packages/engine/wrangler.sync.jsonc).
2. In that config's `vars`, set `IDX_SYNC_FEED_JSON` to a string with the JSON
   equivalent of the feed YAML. Optionally set `IDX_SYNC_PAGES_PER_RUN` to a
   string from `"1"` to `"20"` (default `"10"`). Put `IDX_SYNC_FEED_TOKEN` in a
   protected secrets file.
3. Deploy with the sync config and the protected secrets file.

   ```sh
   npx wrangler deploy --config packages/engine/wrangler.sync.jsonc \
     --secrets-file /path/to/protected/worker-secrets.json
   ```

### Deploy with Workers Builds

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

Cloudflare validates the cron expression at deploy time. Workers Builds runs
the same database setup as `npm run setup` and reapplies its configured window
on every build.

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
