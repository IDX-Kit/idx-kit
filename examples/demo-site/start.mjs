import { engineClient } from './src/server/engine.ts';

try {
  await engineClient().discover();
} catch {
  console.error('Demo site requires a reachable engine with API v1 and listingDetail. Check server configuration.');
  process.exit(1);
}
await import('./dist/server/entry.mjs');
