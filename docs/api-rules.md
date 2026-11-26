# IDX Kit API rules

The [OpenAPI contract](../openapi/v1/openapi.yaml) defines v1 paths, headers,
and schemas. Generate wire types and the TypeScript client from that file.
Keep hand-written database and domain types at the engine boundary.

## Versions and discovery

Start with anonymous `GET /api`. It returns the engine release identifier and
the supported versions, each with a path major, contract version, and capability
names. Check the major and the capabilities your integration uses. The engine
release identifier is for diagnostics.

The engine advertises `v1` with contract version `1.0.0` and the capabilities
`listingSearch`, `listingDetail`, `displayRulesV1`, `inquiryCreate`, and
`inquiryReceipt`. Anonymous `GET /api/v1/openapi.json` serves the installed
engine's contract as a JSON document.

Include the major in each business path. An unversioned business request returns
`400 api_version_required`. An unsupported major returns `404 api_version_unsupported`.
Keep existing paths, inputs, field meanings, limits, and retry guarantees
compatible within a major. Increment the contract minor for compatible additions
and the patch for corrections that preserve behavior. Use a new major for
breaking changes. New mandatory display semantics require a new major or an
explicit opt-in that preserves current rendering for other clients.

## Names and values

- JSON field names and capabilities use camelCase. Resource paths are plural.
  Machine error codes use snake_case.
- Treat resource IDs as opaque, URL-safe strings. Retain returned IDs for links
  within the same engine. A listing ID identifies a source record.
- Timestamps use RFC 3339 UTC with a trailing `Z`. Counts use safe JSON integers.
  A known bedroom count is a nonnegative integer.
- Money has `amount` and `currency`. Keep `amount` as a nonnegative decimal string
  in major units with optional fractional digits. Format it with the supplied
  currency and preserve its precision. Country and currency accept open uppercase
  ISO 3166-1 alpha-2 and ISO 4217 alphabetic codes, respectively.
- Accept unfamiliar response members and withheld field names. Render unfamiliar
  listing statuses with a neutral label. Send only documented request fields and
  values.

## HTTP and search

Success bodies use `data` and `meta`. Listing detail and search also include
page-level `display`, and each listing has its own `display`. The contract
document is returned as raw JSON.

Use `GET /api/v1/listings` with these query parameters. Encode values as
percent-encoded UTF-8. The filters combine with AND.

| Parameter | Meaning |
| --- | --- |
| `city` | Trimmed, case-insensitive exact match up to 100 characters. |
| `minPrice`, `maxPrice` | Inclusive USD bounds using decimal major units. |
| `minBedrooms` | Inclusive integer minimum from 0 to 100. |
| `sort` | `price` (default) or `-price`. ID ascending breaks ties. Null prices sort last in both directions. |
| `limit` | Positive safe integer, default 20. The engine caps the page at 50. |
| `after` | The previous page's opaque `meta.page.nextCursor`. |

Numeric filters exclude records where the filtered value is null. Unsupported
or repeated parameters, invalid values, and inverted price bounds return 400.
The encoded query excluding the `after` pair and its separator is limited to
2,048 bytes. The cursor is limited to 4,096 bytes and the encoded `after` pair
to 4,102 bytes.

Pass the cursor unchanged with the same Site, normalized filters, sort, and
effective page size. Restart at the first page on `400 cursor_invalid`. Each
page can reflect intervening changes and checks current visibility. Stop when
`nextCursor` is null and `hasMore` is false.

## Secret keys and scopes

Send `Authorization: Bearer <secret key>` from server code. Use HTTPS outside
loopback development. Keep keys out of browser code, URLs, and logs. A request
carrying a bearer credential and an `Origin` header is refused. The API sends no
CORS headers.

| Scope | Operations |
| --- | --- |
| `listings:read` | Search and read listing detail. |
| `inquiries:write` | Create an inquiry or replay its creation response. |
| `inquiries:read` | Read receipts for the key's Site. |

The engine resolves the Site from the key. Its data licenses govern which
listings it may read. Create, rotate, and revoke keys through the
[operator commands](../README.md#engine-and-secret-keys). Rotation replaces a
key for the same Site and revokes the original.

## Errors and Request-Id

Errors use `application/problem+json` with `type`, `title`, `status`, `detail`,
`code`, and `requestId`. The body status matches the HTTP status. Use `code`
for decisions, falling back to HTTP status for unfamiliar codes. Optional
`errors` entries can identify a field, query parameter, or header.

| Status | Meaning |
| --- | --- |
| 400 | Invalid query, request syntax, or required version or header. |
| 401 | Missing, invalid, or revoked key. Includes `WWW-Authenticate: Bearer`. |
| 403 | Insufficient scope or forbidden use with `Origin`. |
| 404 | Unknown path, unsupported major, or unavailable record. |
| 405 | Unsupported method. `Allow` gives the supported method. |
| 413 / 415 | Inquiry body too large or unsupported content type. |
| 422 | Invalid inquiry fields, changed retry body, or failed spam check. |
| 500 / 503 | Unexpected failure or temporary service unavailability. |

Every response includes a fresh server-generated `Request-Id`, including errors
and inquiry replays. The problem body's `requestId` matches the header. Record
the ID with the operation and status to correlate failures in server logs.
Exclude credentials, query values, and inquiry details from logs.

## Display rules and withdrawals

Render listing facts together with their listing and page display blocks. Use
the order, placement, and prominence supplied, escape block text as plain text,
and keep site branding and inquiry controls outside the listing body. Render
page disclosures on an empty search too. Preserve the informational-use
disclaimer when a closed listing appears. Suppress the listing display if any
required rules version, placement, or prominence is unfamiliar.

Each listing includes `status`, `price`, `address`, `bedrooms`, and `images`.
A null named in `withheldFields` is withheld. Other null facts are unknown.
Render either as unavailable and keep withheld facts out of descriptions,
media, and metadata. Handle any number of images or display blocks.

The engine omits withdrawn and unlicensed listings from search and returns the
same generic 404 for their detail as for a missing listing. Feed expiration
can prevent a read with 503. Treat `refreshedAt` as the feed's refresh time and
`expiresAt` as the visibility deadline. `sourceUpdatedAt` can be unknown.
Apply new visibility on the next request. Honor `Cache-Control: private, no-store`
on listing reads and `no-store` on discovery, contract, receipts, and errors.

## Inquiries and receipts

Send JSON to `POST /api/v1/inquiries` with a 16 KiB body limit. Include the
listing ID, visitor name and email, message, and `context.pagePath`.
`context.landingPagePath` is optional. Use allowlisted site paths and configured,
nonpersonal attribution tokens. Keep visitor values in the request body.

Generate a lowercase UUIDv4 per submission and send it with double quotes in
`Idempotency-Key`. After the inquiry commits, the engine returns 201 and a
`Location` for `GET /api/v1/inquiries/{inquiryId}`. A receipt contains `id`
and `receivedAt` and confirms durable acceptance. Delivery is separate.
A missing receipt or one owned by another Site returns the same generic 404.

After a lost response or temporary failure, keep the form values and retry
with the same key and logical JSON body. The engine returns the same receipt
and Location while the row exists. The Site and key identify the action even
after a secret key rotation. Reusing the key with a changed body returns
`422 idempotency_mismatch`. Ask the visitor to submit a new action with a new key
if they want to send the changed message.

When the engine's spam check is enabled, send a fresh `Turnstile-Token` for a
new inquiry. Handle `422 spam_check_failed` by refreshing the challenge and
allowing another submission. An unavailable check returns 503. A matching
stored inquiry can replay without a token.
