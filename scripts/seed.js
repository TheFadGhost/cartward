import { seed } from '../src/services/seed.mjs';

const fresh = process.argv.includes('--fresh');
const result = await seed({ fresh });
if (!result.seeded) {
  console.log(`[seed] skipped: ${result.reason}. Run again with --fresh to rebuild.`);
}
