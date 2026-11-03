import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadMarkdownCase } from './markdown.mjs';
export const layers = ['static', 'semantics', 'host', 'jit', 'devices', 'consistency'];

async function discover(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) files.push(...(await discover(url)));
    else if (entry.name.endsWith('.case.md')) files.push(url);
  }
  return files;
}

export async function loadCases(rootURL) {
  assert(
    rootURL instanceof URL && rootURL.protocol === 'file:' && rootURL.pathname.endsWith('/'),
    'loadCases requires a directory file URL',
  );
  const cases = [];
  for (const layer of layers) {
    for (const url of await discover(new URL(`${layer}/`, rootURL))) {
      cases.push(await loadMarkdownCase(url, { layer }));
    }
  }
  const ids = new Set();
  for (const item of cases) {
    assert(!ids.has(item.id), `duplicate case: ${item.id}`);
    ids.add(item.id);
  }
  return cases;
}

export function summarize(cases, outcomes = []) {
  const known = new Set(cases.map((item) => item.id));
  const results = new Map();
  for (const outcome of outcomes) {
    assert(known.has(outcome.id), `unknown execution result: ${outcome.id}`);
    assert(!results.has(outcome.id), `duplicate execution result: ${outcome.id}`);
    assert(
      ['passed', 'failed', 'skipped'].includes(outcome.status),
      `invalid execution status: ${outcome.status}`,
    );
    results.set(outcome.id, outcome.status);
  }
  const execution = { passed: 0, failed: 0, skipped: 0, notRun: 0 };
  for (const item of cases) execution[results.get(item.id) ?? 'notRun']++;
  return {
    authoredCases: cases.length,
    execution,
    layers: Object.fromEntries(
      layers.map((layer) => [layer, cases.filter((item) => item.layer === layer).length]),
    ),
  };
}

export async function loadAdapter(value = process.env.MICA_CONFORMANCE_ADAPTER) {
  if (!value) return null;
  const url = value.startsWith('file:') ? new URL(value) : pathToFileURL(resolve(value));
  const module = await import(url.href);
  const adapter = module.default;
  assert(adapter && typeof adapter === 'object', 'adapter module must export default object');
  for (const name of [
    'compileDDL',
    'createDeviceLibrary',
    'createBoard',
    'createDeviceBuilder',
    'createJitBlockBuilder',
  ]) {
    assert.equal(
      typeof adapter[name],
      'function',
      `adapter.${name} must forward to the real implementation`,
    );
  }
  return adapter;
}
