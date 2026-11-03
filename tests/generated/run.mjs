import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as fc from 'fast-check';
import { domain as expressions } from './domains/expressions.mjs';
import { domain as electrical } from './domains/electrical.mjs';
import { Probe } from './isolation.mjs';

const domains = [expressions, electrical];
const seeds = Array.from({ length: 8 }, (_, index) => (0x4d494341 + index * 0x1f123bb5) | 0);
const profiles = {
  pr: { runs: 50, size: 3, seeds: seeds.slice(0, 1), budget: 30_000, timeout: 5_000 },
  daily: { runs: 2_000, size: 5, seeds: seeds.slice(0, 4), budget: 120_000, timeout: 5_000 },
  fuzz: { runs: 10_000, size: 7, seeds, budget: 300_000, timeout: 3_000 },
};
const regressions = fileURLToPath(new URL('./regressions/', import.meta.url));
const reportFile = fileURLToPath(
  new URL('../../test-results/generated/report.json', import.meta.url),
);
const active = new Set();

async function save(file, record) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function integer(value, name, minimum, maximum) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${name} must be an integer in [${minimum}, ${maximum}]`);
  }
  return result;
}

function errorRecord(error) {
  return {
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
    stack: error?.stack,
  };
}

async function withProbe(domain, timeout, execute) {
  const probe = new Probe(domain.name, timeout);
  active.add(probe);
  try {
    // Configuration failures are not semantic counterexamples to shrink.
    await probe.start();
    return await execute(probe);
  } finally {
    await probe.stop();
    active.delete(probe);
  }
}

function readRegression(record) {
  if (record.version !== 1 || !Object.hasOwn(record, 'sample')) {
    throw new Error('Expected a version 1 generated regression with a concrete sample');
  }
  const domain = domains.find((item) => item.name === record.domain);
  if (!domain) throw new Error(`Unknown regression domain: ${record.domain}`);
  return domain;
}

async function replay(file, timeout) {
  const record = JSON.parse(await readFile(file, 'utf8'));
  const domain = readRegression(record);
  await withProbe(domain, timeout ?? record.timeout ?? profiles.pr.timeout, (probe) =>
    probe.run(record.sample),
  );
  console.log(`PASS regression ${file}`);
}

async function campaign(domain, profile, seed, timeout, requireAdapter) {
  const pending = join(dirname(reportFile), `${domain.name}-${seed}.pending.json`);
  let lastFailure;
  return withProbe(domain, timeout, async (probe) => {
    const property = fc.asyncProperty(domain.arbitrary(profile.size), async (sample) => {
      try {
        await probe.run(sample);
      } catch (error) {
        lastFailure = {
          version: 1,
          domain: domain.name,
          seed,
          size: profile.size,
          runs: profile.runs,
          timeout,
          fastCheckVersion: fc.__version,
          sample,
          error: errorRecord(error),
          shrink: { completed: false },
        };
        // Preserve the latest known failing candidate even if CI kills shrinking.
        await save(pending, lastFailure);
        throw error;
      }
    });
    const result = await fc.check(property, {
      seed,
      numRuns: profile.runs,
      endOnFailure: false,
      interruptAfterTimeLimit: profile.budget,
      markInterruptAsFailure: true,
    });
    const summary = {
      domain: domain.name,
      seed,
      runs: result.numRuns,
      shrinks: result.numShrinks,
      status: result.failed ? 'failed' : 'passed',
    };
    if (result.failed) {
      if (!lastFailure) {
        throw new Error(
          `${domain.name}/${seed}: campaign budget exhausted without a semantic counterexample`,
        );
      }
      const record = {
        ...lastFailure,
        sample: result.counterexample?.[0] ?? lastFailure.sample,
        path: result.counterexamplePath,
        error: result.errorInstance ? errorRecord(result.errorInstance) : lastFailure.error,
        shrink: {
          completed: !result.interrupted && result.counterexample !== null,
          steps: result.numShrinks,
        },
      };
      const hash = createHash('sha256')
        .update(JSON.stringify(record.sample))
        .digest('hex')
        .slice(0, 16);
      const destination = join(regressions, `${domain.name}-${seed}-${hash}.json`);
      await save(destination, record);
      summary.regression = destination;
      console.error(`FAIL ${domain.name} seed=${seed} shrinks=${result.numShrinks}`);
      console.error(
        `Replay: node "${fileURLToPath(import.meta.url)}" --replay "${destination}"${requireAdapter ? ' --require-adapter' : ''}`,
      );
    } else {
      console.log(`PASS ${domain.name} seed=${seed} runs=${result.numRuns}`);
    }
    await rm(pending, { force: true });
    return summary;
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      profile: { type: 'string', default: 'pr' },
      domain: { type: 'string' },
      seed: { type: 'string' },
      runs: { type: 'string' },
      timeout: { type: 'string' },
      replay: { type: 'string' },
      'require-adapter': { type: 'boolean', default: false },
    },
  });
  const defaults = profiles[values.profile];
  if (!defaults) throw new Error(`Unknown profile: ${values.profile}`);
  const selected = values.domain ? domains.filter((item) => item.name === values.domain) : domains;
  if (!selected.length) throw new Error(`Unknown domain: ${values.domain}`);
  const profile = {
    ...defaults,
    runs: values.runs === undefined ? defaults.runs : integer(values.runs, 'runs', 1, 1_000_000),
    seeds:
      values.seed === undefined
        ? defaults.seeds
        : [integer(values.seed, 'seed', -2147483648, 2147483647)],
  };
  const timeout =
    values.timeout === undefined ? defaults.timeout : integer(values.timeout, 'timeout', 1, 60_000);
  if (!process.env.MICA_CONFORMANCE_ADAPTER) {
    const status =
      'UNCONNECTED: real ConformanceAdapter not supplied; no generated semantic checks ran';
    console.log(status);
    await save(reportFile, { status: 'unconnected', profile: values.profile, campaigns: [] });
    if (values['require-adapter'] || values.replay) process.exitCode = 1;
    return;
  }
  if (values.replay) {
    await replay(resolve(values.replay), values.timeout === undefined ? undefined : timeout);
    await save(reportFile, { status: 'passed', replay: resolve(values.replay) });
    return;
  }
  let entries;
  try {
    entries = await readdir(regressions);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    entries = [];
  }
  let failed = false;
  const replayResults = [];
  for (const file of entries.filter((name) => name.endsWith('.json')).sort()) {
    const path = join(regressions, file);
    const record = JSON.parse(await readFile(path, 'utf8'));
    const domain = readRegression(record);
    if (!selected.includes(domain)) continue;
    try {
      await replay(path, values.timeout === undefined ? undefined : timeout);
      replayResults.push({ file: path, status: 'passed' });
    } catch (error) {
      failed = true;
      replayResults.push({ file: path, status: 'failed', error: errorRecord(error) });
      console.error(`FAIL regression ${path}: ${error.message}`);
    }
  }
  const campaigns = [];
  for (const domain of selected) {
    for (const seed of profile.seeds) {
      try {
        const summary = await campaign(domain, profile, seed, timeout, values['require-adapter']);
        campaigns.push(summary);
        if (summary.status === 'failed') failed = true;
      } catch (error) {
        failed = true;
        campaigns.push({ domain: domain.name, seed, status: 'error', error: errorRecord(error) });
        console.error(error);
      }
    }
  }
  await save(reportFile, {
    status: failed ? 'failed' : 'passed',
    profile: values.profile,
    fastCheckVersion: fc.__version,
    regressions: replayResults,
    campaigns,
  });
  if (failed) process.exitCode = 1;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    Promise.all([...active].map((probe) => probe.stop())).finally(() => {
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  });
}

try {
  await main();
} catch (error) {
  console.error(error);
  await save(reportFile, { status: 'error', error: errorRecord(error) });
  process.exitCode = 1;
}
