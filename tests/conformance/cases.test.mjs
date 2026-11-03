import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAdapter, loadCases } from '@mica-js/conformance';

const cases = await loadCases(new URL('./', import.meta.url));
const adapter = await loadAdapter();
if (process.env.MICA_CONFORMANCE_REQUIRE_ADAPTER === '1') {
  assert(
    adapter,
    'No real implementation connected. Set MICA_CONFORMANCE_ADAPTER to an adapter module.',
  );
}

for (const item of cases) {
  test(
    item.name,
    {
      skip: adapter ? false : 'UNCONNECTED: compiler/runtime adapter not supplied',
    },
    async (t) => {
      await item.run(adapter, t);
    },
  );
}
