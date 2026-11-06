import { randomBytes, randomUUID } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import pg from 'pg';
import { hashSecret, scopes } from '../domain/keys.ts';

const [action, subject, grants, path, ...extra] = process.argv.slice(2);
const requested = grants?.split(',') ?? [];
const creating = action === 'create' || action === 'rotate';
if (!process.env.DATABASE_URL || !subject || extra.length ||
    (!creating && (action !== 'revoke' || grants || path)) ||
    (creating && (!path || !requested.length || requested.some(scope => !scopes.some(allowed => allowed === scope))))) {
  process.stderr.write('Usage: demo:key create <site> <scopes> <new-file> | rotate <key-id> <scopes> <new-file> | revoke <key-id>\n');
  process.exitCode = 1;
} else {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  let createdFile = false;
  try {
    await db.connect();
    await db.query('BEGIN');
    let site = subject;
    if (action !== 'create') {
      const old = (await db.query<{ site_id: string }>(
        'SELECT site_id FROM idx.site_secret_keys WHERE id = $1 AND revoked_at IS NULL FOR UPDATE', [subject])).rows[0];
      if (!old) throw new Error('Key unavailable');
      site = old.site_id;
      await db.query('UPDATE idx.site_secret_keys SET revoked_at = now() WHERE id = $1', [subject]);
    }
    let id = subject;
    if (creating) {
      const secret = 'idx_secret_' + randomBytes(32).toString('base64url');
      id = 'key_' + randomUUID();
      await db.query('INSERT INTO idx.site_secret_keys (id, site_id, secret_hash, scopes) VALUES ($1,$2,$3,$4)',
        [id, site, await hashSecret(secret), [...new Set(requested)]]);
      const file = await open(path!, 'wx', 0o600);
      createdFile = true;
      try { await file.chmod(0o600); await file.writeFile(secret + '\n'); } finally { await file.close(); }
    }
    await db.query('COMMIT');
    process.stdout.write(id + '\n');
  } catch {
    await db.query('ROLLBACK').catch(() => {});
    if (createdFile) await unlink(path!).catch(() => {});
    process.stderr.write('Key operation failed. Check the Site, key, scopes and unused output path.\n');
    process.exitCode = 1;
  } finally { await db.end(); }
}
