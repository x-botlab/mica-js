import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { findChromium, serveDirectory } from './batch-execution-browser.mjs';
import { acceptance } from './observable-batch-acceptance.mjs';

const simulatorPath = new URL('../dist/index.js', import.meta.url);
const modelPath = new URL('../../sdk/dist/model.js', import.meta.url);
const acceptancePath = new URL('./observable-batch-acceptance.mjs', import.meta.url);
const exec = promisify(execFile);
const args = process.argv.slice(2);
const smoke = args.includes('--smoke');
const options = {
  size: smoke ? 64 : 8192,
  warmup: smoke ? 1 : 7,
  samples: smoke ? 3 : 24,
  memory: args.find((argument) => argument.startsWith('--memory='))?.slice('--memory='.length),
};

async function nodeResult() {
  const simulator = await import(simulatorPath);
  const model = await import(modelPath);
  return {
    ...acceptance(simulator, model, options),
    engine: process.version,
    ...(options.memory ? { peakRssKiB: process.resourceUsage().maxRSS } : {}),
  };
}

async function browserResult() {
  const chromium = await findChromium(undefined, true);
  const root = await mkdtemp(join(tmpdir(), 'mica-observable-batch-'));
  let server;
  try {
    await writeFile(
      join(root, 'index.html'),
      '<!doctype html><html><head><meta charset="utf-8"></head><body><pre></pre><script type="module" src="./entry.mjs"></script></body></html>',
    );
    const file = (url) => JSON.stringify(fileURLToPath(url));
    await writeFile(
      join(root, 'entry.mjs'),
      `
      import * as simulator from ${file(simulatorPath)};
      import * as model from ${file(modelPath)};
      import { acceptance } from ${file(acceptancePath)};
      const result = document.querySelector('pre');
      try {
        result.textContent = JSON.stringify({
          ...acceptance(simulator, model, ${JSON.stringify(options)}),
          engine: navigator.userAgent,
          crossOriginIsolated,
        });
      } catch (error) {
        result.textContent = JSON.stringify({ error: String(error.stack ?? error) });
      }
    `,
    );
    const vite = await import('vite');
    const dist = join(root, 'dist');
    await vite.build({ root, configFile: false, logLevel: 'error', build: { outDir: dist } });
    server = await serveDirectory(dist);
    const chromeArgs = [
      '--no-sandbox',
      '--disable-gpu',
      '--no-proxy-server',
      '--disable-background-networking',
      '--enable-logging=stderr',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--dump-dom',
      `--user-data-dir=${join(root, 'profile')}`,
      server.origin,
    ];
    if (!/headless[-_]shell/.test(chromium)) chromeArgs.unshift('--headless=new');
    const measured = options.memory !== undefined && process.platform === 'linux';
    const { stdout, stderr } = measured
      ? await exec('/usr/bin/time', ['-f', 'mica-peak-rss-kib=%M', chromium, ...chromeArgs], {
          timeout: 45_000,
        })
      : await exec(chromium, chromeArgs, { timeout: 45_000 });
    const data = stdout.match(/<pre>([\s\S]*?)<\/pre>/)?.[1];
    if (!data)
      throw new Error(
        `Chromium did not produce the comparison result\n${stdout.slice(0, 400)}\n${stderr.slice(-4_000)}`,
      );
    const result = JSON.parse(
      data.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'),
    );
    if (result.error) throw new Error(result.error);
    if (!result.crossOriginIsolated)
      throw new Error('Chromium benchmark requires cross-origin isolation');
    if (measured) {
      const peak = Number(stderr.match(/mica-peak-rss-kib=(\d+)/)?.[1]);
      if (!(peak > 0)) throw new Error('GNU time did not report peak RSS');
      result.peakRssKiB = peak;
    }
    return result;
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

console.log(
  JSON.stringify(await (args.includes('--browser') ? browserResult() : nodeResult()), null, 2),
);
