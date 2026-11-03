import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize, loadCases } from '@mica-js/conformance';

const flags = new Set(process.argv.slice(2));
const allowed = ['--report', '--require-adapter'];
for (const flag of flags) {
  if (!allowed.includes(flag)) throw new Error(`Unknown option: ${flag}`);
}
const cases = await loadCases(new URL('./', import.meta.url));
const printReport = (outcomes = []) => {
  console.log(
    JSON.stringify(
      {
        ...summarize(cases, outcomes),
        implementationConfigured: Boolean(process.env.MICA_CONFORMANCE_ADAPTER),
      },
      null,
      2,
    ),
  );
};
if (flags.has('--report')) {
  printReport();
} else {
  const temporary = await mkdtemp(join(tmpdir(), 'mica-conformance-outcomes-'));
  try {
    const destination = join(temporary, 'outcomes.jsonl');
    const reporter = new URL('../../packages/conformance/src/reporter.mjs', import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        '--test',
        '--test-reporter=spec',
        `--test-reporter=${reporter}`,
        '--test-reporter-destination=stdout',
        `--test-reporter-destination=${destination}`,
        fileURLToPath(new URL('./cases.test.mjs', import.meta.url)),
      ],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          MICA_CONFORMANCE_REQUIRE_ADAPTER: flags.has('--require-adapter') ? '1' : '0',
        },
      },
    );
    if (result.error) throw result.error;
    const names = new Set(cases.map((item) => item.id));
    const outcomes = (await readFile(destination, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((item) => names.has(item.name))
      .map((item) => ({ id: item.name, status: item.status }));
    printReport(outcomes);
    process.exitCode = result.status ?? 1;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
