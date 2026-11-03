import { loadAdapter } from '@mica-js/conformance';
import { domain as expressions } from './domains/expressions.mjs';
import { domain as electrical } from './domains/electrical.mjs';

const domains = { expressions, electrical };
const domain = domains[process.argv[2]];
const errorRecord = (error) => ({
  name: error?.name ?? 'Error',
  message: error?.message ?? String(error),
  stack: error?.stack,
});

try {
  if (!domain) throw new Error('Unknown generated-test domain');
  const adapter = await loadAdapter();
  if (!adapter) throw new Error('UNCONNECTED: MICA_CONFORMANCE_ADAPTER is not supplied');
  process.on('message', async ({ sample }) => {
    try {
      await domain.check(adapter, sample);
      process.send({ type: 'result', ok: true });
    } catch (error) {
      process.send({ type: 'result', ok: false, error: errorRecord(error) });
    }
  });
  process.send({ type: 'ready' });
} catch (error) {
  process.send({ type: 'initialization-error', error: errorRecord(error) });
  process.exitCode = 1;
  process.disconnect();
}
