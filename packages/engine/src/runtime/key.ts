import { randomBytes, randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import pg from "pg";
import { hashSecret, scopes } from "../domain/keys.ts";
import { logFailure } from "../log.ts";

const [action, subject, grants, path, ...extra] = process.argv.slice(2);
const requested = grants?.split(",") ?? [];
const creating = action === "create" || action === "rotate";
const authorizing = action === "authorize";
const newSite = path === "--new-site";
if (action === "sync-demo") {
  const { runDemo } = await import("./demo.ts");
  await runDemo("key");
} else if (
  !process.env.DATABASE_URL ||
  !subject ||
  extra.length ||
  (authorizing &&
    (!subject.trim() || !grants?.trim() || (path !== undefined && !newSite))) ||
  (!creating && !authorizing && (action !== "revoke" || grants || path)) ||
  (creating &&
    (!path ||
      !requested.length ||
      requested.some((scope) => !scopes.some((allowed) => allowed === scope))))
) {
  logFailure(
    "key.input",
    new Error(
      "Usage: demo:key create <site> <scopes> <new-file> | rotate <key-id> <scopes> <new-file> | revoke <key-id> | authorize <site> <feed> [--new-site]. DATABASE_URL is required.",
    ),
  );
  process.exitCode = 1;
} else {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  let createdFile = false;
  try {
    await db.connect();
    await db.query("BEGIN");
    let site = subject;
    let listingRequestLimit: number | undefined;
    if (authorizing) {
      if (newSite)
        await db.query(
          "INSERT INTO idx.sites (id) VALUES ($1) ON CONFLICT DO NOTHING",
          [site],
        );
      const target = await db.query(
        "SELECT 1 FROM idx.sites s CROSS JOIN idx.feeds f WHERE s.id=$1 AND f.id=$2",
        [site, grants],
      );
      if (!target.rowCount) throw new Error("Unknown site or feed");
      await db.query(
        "INSERT INTO idx.data_licenses (site_id, feed_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [site, grants],
      );
    } else if (action !== "create") {
      const old = (
        await db.query<{ site_id: string; listing_request_limit: number }>(
          "SELECT site_id, listing_request_limit FROM idx.site_secret_keys WHERE id = $1 AND revoked_at IS NULL FOR UPDATE",
          [subject],
        )
      ).rows[0];
      if (!old) throw new Error("Key unavailable");
      site = old.site_id;
      listingRequestLimit = old.listing_request_limit;
      await db.query(
        "UPDATE idx.site_secret_keys SET revoked_at = now() WHERE id = $1",
        [subject],
      );
    }
    let id = subject;
    if (creating) {
      const secret = "idx_secret_" + randomBytes(32).toString("base64url");
      id = "key_" + randomUUID();
      const values = [
        id,
        site,
        await hashSecret(secret),
        [...new Set(requested)],
      ];
      if (listingRequestLimit === undefined)
        await db.query(
          "INSERT INTO idx.site_secret_keys (id, site_id, secret_hash, scopes) VALUES ($1,$2,$3,$4)",
          values,
        );
      else
        await db.query(
          "INSERT INTO idx.site_secret_keys (id, site_id, secret_hash, scopes, listing_request_limit) VALUES ($1,$2,$3,$4,$5)",
          [...values, listingRequestLimit],
        );
      const file = await open(path!, "wx", 0o600);
      createdFile = true;
      try {
        await file.chmod(0o600);
        await file.writeFile(secret + "\n");
      } finally {
        await file.close();
      }
    }
    await db.query("COMMIT");
    process.stdout.write(authorizing ? "Site authorized.\n" : id + "\n");
  } catch (error) {
    logFailure("key.operation", error);
    await db
      .query("ROLLBACK")
      .catch((cause: unknown) => logFailure("key.rollback", cause));
    if (createdFile)
      await unlink(path!).catch((cause: unknown) =>
        logFailure("key.cleanup", cause),
      );
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}
