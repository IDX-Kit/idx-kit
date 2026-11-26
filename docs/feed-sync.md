# Operate a listing feed

Use the repository's pinned Node version. Run `npm ci` and all commands below
from the repository root on your Node host.

## Set up the database

On an empty PostgreSQL server, create a migration login and a database it owns.
As a PostgreSQL role that can create logins, create the HTTP runtime login
before running the migrations.

```sql runtime-role
CREATE ROLE idx_runtime LOGIN;
```

Set its password interactively with `\password idx_runtime` in `psql`.

Run `npm run demo:db:migrate` with `DATABASE_URL` set to the migration role's
connection string. As a PostgreSQL role that can create logins, create the
separate writer login and set its password interactively in `psql`.

```sql
CREATE ROLE idx_listing_writer LOGIN NOINHERIT;
\password idx_listing_writer
```

Apply the writer grants as the database owner after migrations. Run this again
after upgrading an existing writer setup.

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/engine/setup/listing-writer.sql
```

As the migration role, add the feed and authorize the site that may display it.
Use a stable feed ID and the freshness window and disclosures approved for
that feed. This invented example uses a one-hour window and starts expired.
The API serves none of the feed until the first complete incremental run.
For an existing site, use its ID and add only the license row.

```sql ci
INSERT INTO idx.feeds (id, refreshed_at, expires_at, display_blocks, rules_version)
VALUES ('feed_example', statement_timestamp() - interval '2 hours',
  statement_timestamp() - interval '1 hour',
  '[{"id":"example_feed","text":"Invented listing feed","placement":"pageFooter","prominence":"normal"}]', '1');
INSERT INTO idx.sites (id) VALUES ('site_example');
INSERT INTO idx.data_licenses (site_id, feed_id) VALUES ('site_example', 'feed_example');
```

See the [demo quick start](demo-setup.md#create-the-database-load-listings-and-make-a-site-key)
for creating a site key. Use your site ID and the scopes your site needs.

## Set the environment

- `LISTING_WRITER_DATABASE_URL` is the direct PostgreSQL connection string for `idx_listing_writer`.
- `IDX_SYNC_FEED_FILE` is the path to a YAML file with the feed ID, the RESO
  Property resource URL, an explicit `synthetic` boolean, and the approved
  disclosures. Use HTTPS. Synthetic feeds can also use HTTP on loopback.
  Optionally set `pageSize` to an integer from 1 to 200 to request smaller pages for both incremental sync and scans. The feed may ignore it.
- `IDX_SYNC_FEED_TOKEN` is the feed's bearer token. Only `incremental` and `scan` require it.

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
  approvedPageBlocks: []
  requiredListingBlockIds: [example_listing]
  requiredPageBlockIds: []
```

## Run and check the feed

`npm run --silent sync -- incremental` reads from the saved position and
renews the freshness window when it completes.

```json
{"feedId":"feed_example","code":"complete","nextStep":{"kind":"none"}}
```

`npm run --silent sync -- scan` repairs missed edits across the feed. It can
apply explicit withdrawals and preserves listings that are merely absent.

```json
{"feedId":"feed_example","code":"complete","nextStep":{"kind":"none"},"pagesRead":3,"recordsSeen":24,"listingsRemoved":0}
```

Enable removal by absence only when you know the feed's full list is complete.
Run `npm run --silent sync -- scan --remove-missing --max-removals N` with both
flags and a nonnegative whole-number limit. If the number of missing listings
exceeds the limit, the run removes none of them and reports `wouldRemove` and
`maxRemovals`. A limit of `0` prevents every removal by absence.

`npm run --silent sync -- status` reads saved state without calling the feed.
Before the first run, the dates reflect initial provisioning. Missing marks,
scan numbers, counts, and outcomes are `null`. A scan number is a decimal string.

```json
{"feedId":"feed_example","refreshedAt":"2026-11-03T15:00:00+00:00","expiresAt":"2026-11-03T16:00:00+00:00","completedMark":"2026-11-03T14:59:00.000001Z","incrementalInProgress":false,"scanNumber":"1","scanInProgress":false,"recordsSeen":24,"unreadableRecords":0,"lastOutcome":{"code":"complete","httpStatus":null,"nextStep":null,"retrySeconds":null,"savedAt":"2026-11-03T15:00:00+00:00"}}
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
When `outcomeSaved` is `false`, listing changes, position, and the refresh time
for a completed run are still saved with its pages, and `status` shows position
and freshness as usual alongside the previous `lastOutcome` because the record
of how the run ended, including any wait the feed requested, could not be saved.

Each invocation makes one attempt. After an interruption, run the same command
again to resume after the last saved page. If the feed rejects its continuation,
the runner clears it. Run the command again to continue from the last completed
incremental mark or to start a new scan.

## Keep a feed current on Workers

The optional sync Worker runs incremental sync on a schedule. Use the
database setup above to create the feed and grant access to the writer login.
Run repair scans with the Node command.

1. Create a separate Hyperdrive configuration using the direct PostgreSQL
   connection for `idx_listing_writer`. Disable query caching so each run
   reads the latest saved position and outcome. Replace the placeholder ID for
   `LISTING_WRITER_HYPERDRIVE` in your copy of
   [the sync config](../packages/engine/wrangler.sync.jsonc).
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

Open `idx-kit-listing-sync` in the Cloudflare Workflows dashboard to see
instances, step attempts and the run's result. Each result contains a code,
the next step and the number of pages applied. `waiting` means the saved
retry delay has yet to elapse. For `stopped`, check the prior run and fix
the cause, then start one fresh instance by hand.

```sh
npx wrangler workflows trigger idx-kit-listing-sync '{"resume":true}' \
  --config packages/engine/wrangler.sync.jsonc
```

To pause, deploy with an empty `triggers.crons` array and let active runs
finish. To resume the schedule, restore `*/30 * * * *` and redeploy. The saved
position carries over. [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/#remove-a-cron-trigger)

For a first load, start the feed expired. Each schedule can apply up to
pages per run times page size listings if the feed honors the requested page
size. The last page renews freshness and makes the feed available in the API.
A temporarily more frequent schedule can speed up the initial load.
Cloudflare lists 10 ms of processor time per step on the Free plan. Start
cautiously with `pageSize: 25` and measure representative pages on Workers to
choose the right size. [Cloudflare Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)
