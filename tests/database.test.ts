import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { FixtureConnector } from '../packages/engine/src/connectors/fixture.ts';
import { normalize } from '../packages/engine/src/domain/normalize.ts';
import { migrate } from '../packages/engine/src/db/migrate.ts';
import { seed } from '../packages/engine/src/db/seed.ts';

test('fresh PostgreSQL database and transactional fixture loading', async t => {
  assert.ok(process.env.DATABASE_URL, 'A disposable migration database is required');
  assert.ok(process.env.RUNTIME_DATABASE_URL, 'A restricted runtime connection is required');
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const runtime = new pg.Client({ connectionString: process.env.RUNTIME_DATABASE_URL });
  await db.connect();
  await runtime.connect();
  t.after(async () => { await runtime.end(); await db.end(); });
  const fixtures = await new FixtureConnector().read();
  const reset = () => db.query('TRUNCATE idx.feeds, idx.sites, idx.listings CASCADE');
  const snapshot = async () => (await db.query('SELECT * FROM idx.listings ORDER BY id')).rows;

  await t.test('migrations build from empty and can run twice', async () => {
    assert.equal((await db.query("SELECT to_regnamespace('idx') AS schema")).rows[0].schema, null);
    await migrate(db);
    await migrate(db);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM public.schema_migrations')).rows[0].count, 1);
    const owners = await db.query("SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'idx'");
    assert.deepEqual(owners.rows, [{ tableowner: 'idx_migration' }]);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM idx.listings')).rows[0].count, 0);
  });
  await t.test('runtime can read, but cannot create, drop or write tables', async () => {
    await runtime.query('SELECT * FROM idx.listings');
    for (const sql of ['CREATE TABLE idx.forbidden (id int)', 'CREATE TABLE public.forbidden (id int)',
      'DROP TABLE idx.listings', "INSERT INTO idx.sites VALUES ('forbidden')"]) {
      await assert.rejects(runtime.query(sql), { code: '42501' });
    }
  });
  await t.test('all 24 fixtures seed, reseed identically and update without changing public IDs', async () => {
    await reset();
    assert.equal(fixtures.listings.length, 24);
    await seed(db, fixtures);
    const original = await snapshot();
    assert.equal(original.length, 24);
    assert.deepEqual(original.map(row => row.id), fixtures.listings.map(record => record.publicId).sort());
    await seed(db, fixtures);
    assert.deepEqual(await snapshot(), original);
    const changed = structuredClone(fixtures);
    changed.listings[0].source.ListPrice = '123456.789';
    changed.listings[0].publicId = 'lst_candidate_changed';
    await seed(db, changed);
    const updated = await snapshot();
    assert.equal(updated.length, 24);
    assert.deepEqual(updated.map(row => row.id), original.map(row => row.id));
    assert.equal(updated[0].price, '123456.789');
    assert.equal((await db.query('SELECT count(*)::int AS count FROM idx.source_mappings')).rows[0].count, 24);
  });
  await t.test('every missing required source fact rolls back the entire seed', async () => {
    for (const fact of ['ListingKey', 'StandardStatus', 'ListPrice', 'BedroomsTotal', 'Address',
      'Images', 'InternetAddressDisplayYN', 'InternetEntireListingDisplayYN']) {
      await reset();
      const invalid = structuredClone(fixtures);
      Reflect.deleteProperty(invalid.listings.at(-1)!.source, fact);
      await assert.rejects(seed(db, invalid), /Missing required source fact/);
      for (const table of ['feeds', 'sites', 'data_licenses', 'listings', 'source_mappings']) {
        assert.equal((await db.query(`SELECT count(*)::int AS count FROM idx.${table}`)).rows[0].count, 0);
      }
    }
  });
  await t.test('a failed reseed also restores previously committed values', async () => {
    await seed(db, fixtures);
    const original = await snapshot();
    const invalid = structuredClone(fixtures);
    invalid.listings[0].source.ListPrice = '1.00';
    Reflect.deleteProperty(invalid.listings.at(-1)!.source, 'ListPrice');
    await assert.rejects(seed(db, invalid), /Missing required source fact/);
    assert.deepEqual(await snapshot(), original);
  });
  await t.test('explicit null is preserved for every nullable fact', async () => {
    await reset();
    const nullable = structuredClone(fixtures);
    Object.assign(nullable.listings[0].source,
      { StandardStatus: null, ListPrice: null, BedroomsTotal: null, Address: null, Images: null });
    await seed(db, nullable);
    const row = (await snapshot())[0];
    for (const fact of ['status', 'price', 'currency', 'bedrooms', 'address', 'images']) assert.equal(row[fact], null);
    assert.deepEqual(row.withheld_fields, []);
  });
  await t.test('exact source keys stay separate and are scoped by feed', async () => {
    await reset();
    const scoped = structuredClone(fixtures);
    scoped.listings[23].source.ListingKey = scoped.listings[0].source.ListingKey;
    scoped.listings[1].source.ListingKey = scoped.listings[0].source.ListingKey.trim();
    scoped.listings[2].source.ListingKey = scoped.listings[0].source.ListingKey.toLowerCase();
    await seed(db, scoped);
    const mappings = (await db.query('SELECT * FROM idx.source_mappings')).rows;
    for (const record of scoped.listings) assert.ok(mappings.some(row => row.feed_id === record.feedId &&
      row.source_key === record.source.ListingKey && row.listing_id === record.publicId));
    const columns = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'idx' AND table_name = 'listings'")).rows;
    assert.ok(!columns.some(row => ['source_key', 'ListingKey', 'ListPrice'].includes(row.column_name)));
    assert.ok(!Object.hasOwn(normalize(scoped.listings[0]).facts, 'ListingKey'));
  });
  await t.test('withholding, withdrawal, closed disclosures and isolated expired feed are data', async () => {
    await reset();
    await seed(db, fixtures);
    const rows = await snapshot();
    assert.equal(rows[1].address, null);
    assert.deepEqual(rows[1].withheld_fields, ['address']);
    assert.ok(!JSON.stringify(rows[1]).includes(fixtures.listings[1].source.Address!.line1));
    assert.equal(rows[2].status, 'closed');
    assert.equal(rows[2].page_blocks[0].id, 'closed_information');
    assert.equal(rows[5].entire_listing_display, false);
    assert.equal(rows[3].price, null);
    assert.equal(rows[0].price, rows[2].price);
    assert.ok(rows.every(row => row.synthetic && row.display_blocks[0].id === 'synthetic_broker'));
    assert.deepEqual((await db.query('SELECT * FROM idx.data_licenses ORDER BY site_id')).rows,
      [{ site_id: 'site_demo_other', feed_id: 'feed_demo_expired' },
        { site_id: 'site_demo_primary', feed_id: 'feed_demo_primary' }]);
    assert.deepEqual((await db.query('SELECT id FROM idx.feeds WHERE expires_at < now()')).rows,
      [{ id: 'feed_demo_expired' }]);
  });
  await t.test('Site key storage accepts only scoped hashes and retains revocation', async () => {
    const hash = createHash('sha256').update(randomBytes(32)).digest('hex');
    await db.query("INSERT INTO idx.site_secret_keys VALUES ('key_test', 'site_demo_primary', $1, ARRAY['listings:read'], NULL)", [hash]);
    await db.query("UPDATE idx.site_secret_keys SET revoked_at = now() WHERE id = 'key_test'");
    const row = (await runtime.query("SELECT * FROM idx.site_secret_keys WHERE id = 'key_test'")).rows[0];
    assert.equal(row.secret_hash, hash);
    assert.ok(row.revoked_at);
    await assert.rejects(db.query("INSERT INTO idx.site_secret_keys VALUES ('key_bad', 'site_demo_primary', 'unhashed', ARRAY['listings:read'], NULL)"), { code: '23514' });
    await assert.rejects(db.query("INSERT INTO idx.site_secret_keys VALUES ('key_bad', 'site_demo_primary', $1, ARRAY['admin'], NULL)", [hash]), { code: '23514' });
  });
});
