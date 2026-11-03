import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
      const item = await loadMarkdownCase(url, { layer });
      item.name = relative(fileURLToPath(rootURL), item.file).split(sep).join('/');
      cases.push(item);
    }
  }
  return cases;
}

export function summarize(cases, outcomes = []) {
  const known = new Set(cases.map((item) => item.name));
  const results = new Map();
  for (const outcome of outcomes) {
    assert(known.has(outcome.name), `unknown execution result: ${outcome.name}`);
    assert(!results.has(outcome.name), `duplicate execution result: ${outcome.name}`);
    assert(
      ['passed', 'failed', 'skipped'].includes(outcome.status),
      `invalid execution status: ${outcome.status}`,
    );
    results.set(outcome.name, outcome.status);
  }
  const execution = { passed: 0, failed: 0, skipped: 0, notRun: 0 };
  for (const item of cases) execution[results.get(item.name) ?? 'notRun']++;
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
