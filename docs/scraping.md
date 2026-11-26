# Limit and report suspected scraping

## What the engine does for you

Each website key gets 60 listing requests per 60-second window by default,
shared by search and property detail. The engine returns `429` when the key
reaches its ceiling, as described in the [API rules](api-rules.md#listing-request-limit).
The engine sees only the website's key, so set per-visitor limits at the
website's edge.

## Limit visitors at your edge

In your website's Cloudflare dashboard, open **Security rules** and select
**Create rule** > **Rate limiting rules**. Name the rule `Limit listing pages`
and use **Edit expression** to match the demo site's search and property paths.
The rule leaves out crawlers Cloudflare has verified.

```text
not cf.client.bot and (
  http.request.uri.path eq "/search" or
  http.request.uri.path eq "/search/" or
  starts_with(http.request.uri.path, "/properties/")
)
```

Set **With the same characteristics** to **IP** so Cloudflare counts matching
requests by visitor IP address. Under **When rate exceeds**, enter 20 requests
in 10 seconds. Choose **Block** for **Then take action** and set **Duration** to
10 seconds. Select **Deploy** to apply the rule to your website.

Use these numbers as a starting point and tune them using traffic you observe.
Use the equivalent path, crawler and per-address settings if you run another
edge service.
[Create a rate limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/create-zone-dashboard/) ·
[Rate limiting options](https://developers.cloudflare.com/waf/rate-limiting-rules/#availability) ·
[Verified crawlers](https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/cf.client.bot/) ·
[URI path](https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/http.request.uri.path/) ·
[Path prefix matching](https://developers.cloudflare.com/ruleset-engine/rules-language/functions/#starts_with)

## See heavy use by a key

The engine writes a JSON request line with the internal `keyId` for admitted
and rate-limited listing requests. The line has a UTC `timestamp`, the response's
`requestId` and HTTP `status`. The `route` identifies search or property detail.
Here is an invented search request.

```json
{"method":"GET","route":"/api/v1/listings","status":200,"code":"ok","duration":12.4,"requestId":"00000000-0000-4000-8000-000000000001","timestamp":"2026-11-05T14:02:01.000Z","keyId":"key_example","engineRelease":"0.1.0"}
```

**Node.** Open your host's captured engine standard error logs for the UTC
period you want to check. If you export the messages for that period as plain
text to `engine.log`, count lines for each key by replacing `key_example`.

```sh
grep -F -c '"keyId":"key_example"' engine.log
```

For example, if your engine runs as a systemd service that writes to the journal,
replace `idx-kit.service` with your unit name and set the dates you want.

```sh
journalctl --unit=idx-kit.service --output=cat \
  --since='2026-11-05 14:00:00 UTC' --until='2026-11-05 15:00:00 UTC' |
  grep -F -c '"keyId":"key_example"'
```

**Workers.** Open the engine Worker in **Workers & Pages**, then go to
**Observability** > **Overview**. Select the time range and the **Count**
visualization. Add a filter on `$metadata.message` using **Includes** and the
literal text `"keyId":"key_example"`. Select **Run** and read the count in the
summary table. Replace the example ID to count another key. Note any sampling
when you report a count from retained logs.
[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) ·
[Query Builder](https://developers.cloudflare.com/workers/observability/query-builder/)

If you need to reduce traffic, tighten your edge rule or set a lower ceiling
for the key using the [SQL in the API rules](api-rules.md#listing-request-limit).
If you suspect a key was exposed, use the [key commands](../README.md#engine-and-secret-keys)
to revoke it or rotate it and update the website's server configuration.

## Report suspected scraping

Follow your data license for who to notify and by when. Include these details
in the report.

- The start and end of the period in UTC.
- The key's internal ID.
- Request counts compared with the usual counts over a similar period.
- A few sample request IDs.
- The paths or types of searches involved, using your website logs if needed.
- The action you took.

Keep secret keys, key hashes and visitor details out of the report. This page
is not legal advice.
