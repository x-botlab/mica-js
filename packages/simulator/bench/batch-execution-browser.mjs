/**
 * Chromium acceptance run for the batch-execution fixture. Vite bundles the published
 * simulator dist and the shared environment-neutral fixture into a production page; a
 * local headless Chromium then runs the same 5-warmup / 25-sample paired loop. The
 * browser package is discovered under ~/.cache/ms-playwright or supplied with
 * --chromium=<path> / CHROMIUM_BIN.
 *
 *   node packages/simulator/bench/batch-execution-browser.mjs
 *   node packages/simulator/bench/batch-execution-browser.mjs --require-batch --require-targets
 */
import { once } from 'node:events';
import { createServer } from 'node:http';
import {
  access,
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { arch, cpus, homedir, platform, release, totalmem } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fillDeviceSource, normalizeConfig } from './batch-execution-fixture.mjs';

const fixturePath = fileURLToPath(new URL('./batch-execution-fixture.mjs', import.meta.url));
const defaultSdkPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));

const defaults = {
  samples: 25,
  warmup: 5,
  iterations: 65_536,
  tickPs: 10,
  execution: 'throughput',
  sdk: defaultSdkPath,
  baselineSdk: undefined,
  baselineSha: '8a36ed4',
  chromium: undefined,
  requireBatch: false,
  requireTargets: false,
  controlsOnly: false,
  requireBaseline: false,
  smoke: false,
  timeoutMs: 180_000,
};

const usage =
  'Usage: node packages/simulator/bench/batch-execution-browser.mjs ' +
  '[--samples=25] [--warmup=5] [--iterations=65536] [--tick-ps=10] ' +
  '[--sdk=packages/simulator/dist/index.js] [--baseline-sdk=<dist/index.js>] ' +
  '[--baseline-sha=8a36ed4] [--chromium=<chrome>] ' +
  '[--execution=throughput|precise] [--timeout-ms=180000] [--require-batch] ' +
  '[--require-targets] [--controls-only] [--require-baseline] [--smoke]\n' +
  'Bundles the published dist with Vite, optionally in a second independent bundle for ' +
  'the baseline SDK, runs the shared 65,536-byte fill fixture in headless Chromium, and ' +
  'prints JSON. Only runUntil is timed and timed runs install no probes. --controls-only ' +
  'is an optional diagnostic mode that omits the active variant and gates only the two ' +
  'no-candidate overhead controls; the default four-way mixed run is unchanged.';

export function parseArgs(args) {
  const options = { ...defaults };
  const seen = new Set();
  for (const argument of args) {
    if (argument === '--help') return null;
    if (
      argument === '--require-batch' ||
      argument === '--require-targets' ||
      argument === '--controls-only' ||
      argument === '--require-baseline' ||
      argument === '--smoke'
    ) {
      const name = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      if (seen.has(name)) throw new Error(`Duplicate option: ${argument}`);
      seen.add(name);
      options[name] = true;
      continue;
    }
    const match =
      /^--(samples|warmup|iterations|tick-ps|execution|sdk|baseline-sdk|baseline-sha|chromium|timeout-ms)=(.+)$/.exec(
        argument,
      );
    if (!match) throw new Error(`Unknown or malformed argument: ${argument}`);
    const [, rawName, value] = match;
    const name =
      rawName === 'tick-ps'
        ? 'tickPs'
        : rawName === 'timeout-ms'
          ? 'timeoutMs'
          : rawName.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (seen.has(name)) throw new Error(`Duplicate option: --${rawName}`);
    seen.add(name);
    if (
      name === 'sdk' ||
      name === 'baselineSdk' ||
      name === 'baselineSha' ||
      name === 'chromium' ||
      name === 'execution'
    ) {
      if (value.length === 0) throw new Error(`Option --${rawName} requires a value`);
      options[name] = value;
      continue;
    }
    if (!/^\d+$/.test(value))
      throw new Error(`Option --${rawName} requires a non-negative integer`);
    options[name] = Number(value);
  }
  if (options.smoke) {
    if (!seen.has('iterations')) options.iterations = 256;
    if (!seen.has('samples')) options.samples = 3;
    if (!seen.has('warmup')) options.warmup = 1;
  }
  if (!Number.isSafeInteger(options.samples) || options.samples < 1 || options.samples > 200)
    throw new RangeError('samples must be in [1,200]');
  if (!Number.isSafeInteger(options.warmup) || options.warmup < 0 || options.warmup > 50)
    throw new RangeError('warmup must be in [0,50]');
  if (
    !Number.isSafeInteger(options.iterations) ||
    options.iterations < 2 ||
    options.iterations > 1_000_000
  )
    throw new RangeError('iterations must be in [2,1000000]');
  if (!Number.isSafeInteger(options.tickPs) || options.tickPs < 1 || options.tickPs > 1_000_000_000)
    throw new RangeError('tick-ps must be in [1,1000000000]');
  if (options.execution !== 'throughput' && options.execution !== 'precise')
    throw new RangeError('execution must be throughput or precise');
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1_000 ||
    options.timeoutMs > 900_000
  )
    throw new RangeError('timeout-ms must be in [1000,900000]');
  options.sdk = resolve(options.sdk);
  if (options.baselineSdk !== undefined) options.baselineSdk = resolve(options.baselineSdk);
  if (options.chromium !== undefined) options.chromium = resolve(options.chromium);
  if (options.requireBaseline && options.baselineSdk === undefined)
    throw new RangeError('--require-baseline requires --baseline-sdk');
  if (options.controlsOnly && options.requireTargets && options.baselineSdk === undefined)
    throw new RangeError(
      '--controls-only --require-targets requires --baseline-sdk for both controls',
    );
  return options;
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

function sleep(durationMs) {
  return new Promise((resolveSleep) => globalThis.setTimeout(resolveSleep, durationMs));
}

async function isExecutable(path) {
  try {
    await access(path);
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

export async function findChromium(explicit, preferHeadless = false) {
  if (explicit !== undefined) {
    if (!(await isExecutable(explicit))) throw new Error(`Chromium is not executable: ${explicit}`);
    return explicit;
  }
  if (process.env.CHROMIUM_BIN) {
    const candidate = resolve(process.env.CHROMIUM_BIN);
    if (!(await isExecutable(candidate)))
      throw new Error(`CHROMIUM_BIN is not executable: ${candidate}`);
    return candidate;
  }
  const root = join(homedir(), '.cache', 'ms-playwright');
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    throw new Error(
      `No Playwright Chromium cache at ${root}; pass --chromium=<path> or set CHROMIUM_BIN`,
    );
  }
  const candidates = [];
  for (const entry of entries) {
    const chromium = /^chromium-(\d+)$/.exec(entry.name);
    const headless = /^chromium_headless_shell-(\d+)$/.exec(entry.name);
    if (chromium)
      candidates.push({
        version: Number(chromium[1]),
        rank: preferHeadless ? 1 : 2,
        path: join(root, entry.name, 'chrome-linux64', 'chrome'),
      });
    else if (headless)
      candidates.push({
        version: Number(headless[1]),
        rank: preferHeadless ? 2 : 1,
        path: join(root, entry.name, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
      });
  }
  candidates.sort((left, right) => right.version - left.version || right.rank - left.rank);
  for (const candidate of candidates) if (await isExecutable(candidate.path)) return candidate.path;
  throw new Error(
    `No executable Chromium under ${root}; pass --chromium=<path> or set CHROMIUM_BIN`,
  );
}

function contentType(path) {
  switch (extname(path)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.map':
      return 'application/json; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

export async function serveDirectory(directory) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const path = resolve(directory, `.${pathname}`);
      if (path !== directory && !path.startsWith(`${directory}${sep}`)) {
        response.writeHead(403).end();
        return;
      }
      const body = await readFile(path);
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': contentType(path),
        // Cross-origin isolation enables Chrome's high-resolution performance.now()
        // (5 us instead of the default 100 us clamping) for sub-3% paired ratios.
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('HTTP benchmark server did not expose a TCP port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

function distResolutionRecorder(resolvedPackages) {
  return {
    name: 'batch-execution-dist-resolution',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!source.startsWith('@mica-js/')) return null;
      const resolved = await this.resolve(source, importer, {
        ...options,
        skipSelf: true,
      });
      if (resolved === null) return null;
      const id = resolved.id.split('?')[0];
      if (id.includes('/src/') || id.endsWith('.ts'))
        throw new Error(`browser bundle resolved source instead of dist: ${source} -> ${id}`);
      resolvedPackages.add(id);
      return resolved;
    },
  };
}

async function collectFiles(directory) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const info = await stat(path);
        files.push({ path: path.slice(directory.length + 1), bytes: info.size });
      }
    }
  }
  await visit(directory);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

function workspaceRootForSdk(sdk) {
  return resolve(dirname(sdk), '../../..');
}

async function buildSdkBundle({ sdk, name, root }) {
  const vite = await import('vite');
  const entryPath = join(root, `sdk-${name}.mjs`);
  await writeFile(entryPath, `export * as sdk from '@mica-js/simulator';\n`, 'utf8');
  const outDir = join(root, `bundle-${name}`);
  const resolvedPackages = new Set();
  await vite.build({
    root,
    configFile: false,
    logLevel: 'error',
    publicDir: false,
    resolve: {
      alias: [{ find: /^@mica-js\/simulator$/, replacement: sdk }],
      conditions: ['import', 'module', 'browser', 'default'],
    },
    plugins: [distResolutionRecorder(resolvedPackages)],
    build: {
      outDir,
      emptyOutDir: true,
      target: 'es2022',
      minify: true,
      lib: {
        entry: entryPath,
        formats: ['es'],
        fileName: () => `${name}.js`,
      },
    },
  });
  const workspaceRoot = workspaceRootForSdk(sdk);
  const absolute = [...resolvedPackages]
    .filter((id) => !id.startsWith('\0'))
    .map((id) => id.split('?')[0]);
  const outside = absolute.filter((id) => !id.startsWith(`${workspaceRoot}${sep}`));
  if (outside.length !== 0)
    throw new Error(
      `bundle ${name} resolved packages outside its workspace ${workspaceRoot}:\n` +
        outside.join('\n'),
    );
  const resolved = absolute.map((id) => id.slice(workspaceRoot.length + 1)).sort();
  if (!resolved.includes('packages/compiler/dist/index.js'))
    throw new Error(
      `bundle ${name} did not resolve the workspace compiler dist under ${workspaceRoot}`,
    );
  const files = await collectFiles(outDir);
  return Object.freeze({
    name,
    sdk,
    workspaceRoot,
    entry: `bundle-${name}/${name}.js`,
    files,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    resolvedPackages: Object.freeze(resolved),
  });
}

function controllerSource({ candidate, baseline }) {
  const baselineImport = baseline
    ? `import { sdk as baselineSdk } from './${baseline.entry}';\n`
    : '';
  const baselineArgument = baseline ? 'baselineSdk,\n    ' : '';
  const modules = baseline
    ? `{ candidate: '${candidate.entry}', baseline: '${baseline.entry}' }`
    : `{ candidate: '${candidate.entry}' }`;
  return `import { model, settings } from './model.mjs';
import { runCandidateAcceptance } from './batch-execution-fixture.mjs';
import { sdk as candidateSdk } from './${candidate.entry}';
${baselineImport}
const execute = async () => {
  const result = runCandidateAcceptance({
    sdk: candidateSdk,
    ${baselineArgument}model,
    configInput: settings.config,
    warmup: settings.warmup,
    samples: settings.samples,
    execution: settings.execution,
    requireBatch: settings.requireBatch,
    controlsOnly: settings.controlsOnly,
  });
  return {
    ...result,
    modules: ${modules},
    browser: {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency ?? null,
      deviceMemory: navigator.deviceMemory ?? null,
      crossOriginIsolated: globalThis.crossOriginIsolated ?? null,
    },
  };
};

globalThis.__BATCH_EXECUTION_PROMISE__ = execute().then(
  (result) => {
    globalThis.__BATCH_EXECUTION_RESULT__ = result;
    return result;
  },
  (cause) => {
    globalThis.__BATCH_EXECUTION_ERROR__ = cause?.stack ?? String(cause);
    throw cause;
  },
);
`;
}

async function buildSite({ model, settings, sdk, baselineSdk, root }) {
  const candidate = await buildSdkBundle({ sdk, name: 'candidate', root });
  const baseline =
    baselineSdk === undefined
      ? undefined
      : await buildSdkBundle({ sdk: baselineSdk, name: 'baseline', root });
  const controller = 'controller.mjs';
  await copyFile(fixturePath, join(root, 'batch-execution-fixture.mjs'));
  await writeFile(
    join(root, 'model.mjs'),
    `export const model = ${JSON.stringify(model)};\n` +
      `export const settings = ${JSON.stringify(settings)};\n`,
    'utf8',
  );
  await writeFile(join(root, controller), controllerSource({ candidate, baseline }), 'utf8');
  await writeFile(
    join(root, 'index.html'),
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>batch-execution benchmark</title>
    <script>
      addEventListener('error', (event) => {
        globalThis.__BATCH_EXECUTION_ERROR__ =
          (event.error && event.error.stack) || event.message || 'window error';
      });
      addEventListener('unhandledrejection', (event) => {
        const reason = event.reason;
        globalThis.__BATCH_EXECUTION_ERROR__ = (reason && reason.stack) || String(reason);
      });
    </script>
  </head>
  <body><script type="module" src="/${controller}"></script></body>
</html>
`,
    'utf8',
  );
  const siteFiles = [
    {
      path: 'batch-execution-fixture.mjs',
      bytes: (await stat(join(root, 'batch-execution-fixture.mjs'))).size,
    },
    { path: controller, bytes: (await stat(join(root, controller))).size },
    { path: 'index.html', bytes: (await stat(join(root, 'index.html'))).size },
    { path: 'model.mjs', bytes: (await stat(join(root, 'model.mjs'))).size },
    ...candidate.files.map((file) => ({
      path: `${candidate.entry.split('/')[0]}/${file.path}`,
      bytes: file.bytes,
    })),
    ...(baseline?.files ?? []).map((file) => ({
      path: `${baseline.entry.split('/')[0]}/${file.path}`,
      bytes: file.bytes,
    })),
  ].sort((left, right) => left.path.localeCompare(right.path));
  return {
    outDir: root,
    entry: controller,
    candidate,
    baseline,
    files: siteFiles,
    totalBytes: siteFiles.reduce((sum, file) => sum + file.bytes, 0),
  };
}

class CdpSession {
  constructor(webSocket) {
    this.webSocket = webSocket;
    this.nextId = 1;
    this.pending = new Map();
    webSocket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id === undefined) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    });
    webSocket.addEventListener('close', () => {
      for (const waiter of this.pending.values())
        waiter.reject(new Error('Chromium DevTools connection closed'));
      this.pending.clear();
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
      this.webSocket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    this.webSocket.close();
  }
}

async function openWebSocket(url) {
  const webSocket = new globalThis.WebSocket(url);
  await new Promise((resolveOpen, rejectOpen) => {
    webSocket.addEventListener('open', resolveOpen, { once: true });
    webSocket.addEventListener(
      'error',
      () => rejectOpen(new Error(`Could not connect to Chromium DevTools at ${url}`)),
      { once: true },
    );
  });
  return new CdpSession(webSocket);
}

async function fetchJson(url) {
  const response = await globalThis.fetch(url);
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return response.json();
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), sleep(2_000)]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([once(child, 'exit'), sleep(2_000)]);
  }
}

async function runBrowser(options, config, model) {
  const { spawn } = await import('node:child_process');
  if (options.baselineSdk !== undefined && options.baselineSdk === options.sdk)
    throw new Error('--baseline-sdk must be an independent build, not the candidate SDK path');
  const chromium = await findChromium(options.chromium);
  const root = await mkdtemp(join('/tmp/opencode', 'issue313-batch-browser-'));
  const profile = join(root, 'profile');
  const settings = {
    config: { iterations: config.iterations, tickPs: config.tickPs },
    warmup: options.warmup,
    samples: options.samples,
    execution: options.execution,
    requireBatch: options.requireBatch,
    controlsOnly: options.controlsOnly,
  };
  let server;
  let child;
  let session;
  let stderr = '';
  let primaryError;
  let cleanupError;
  let resultValue;
  try {
    const bundle = await buildSite({
      model,
      settings,
      sdk: options.sdk,
      baselineSdk: options.baselineSdk,
      root,
    });
    server = await serveDirectory(bundle.outDir);
    const args = [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--mute-audio',
      '--window-size=800,600',
      '--remote-allow-origins=*',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      `${server.origin}/`,
    ];
    if (!/headless[-_]shell/.test(chromium)) args.unshift('--headless=new');
    child = spawn(chromium, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
    });
    const portFile = join(profile, 'DevToolsActivePort');
    const launchDeadline = Date.now() + 15_000;
    let portText;
    while (Date.now() < launchDeadline) {
      try {
        portText = await readFile(portFile, 'utf8');
        break;
      } catch {
        if (child.exitCode !== null)
          throw new Error(`Chromium exited with code ${child.exitCode}\n${stderr}`);
        await sleep(50);
      }
    }
    if (portText === undefined)
      throw new Error(`Chromium did not expose DevToolsActivePort\n${stderr}`);
    const [port] = portText.trim().split('\n');
    const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
    const targetDeadline = Date.now() + 15_000;
    let target;
    while (Date.now() < targetDeadline) {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      target = targets.find(
        (candidate) => candidate.type === 'page' && String(candidate.url).startsWith(server.origin),
      );
      if (target) break;
      await sleep(50);
    }
    if (!target) throw new Error(`Chromium did not open the benchmark page\n${stderr}`);
    session = await openWebSocket(target.webSocketDebuggerUrl);
    const deadline = Date.now() + options.timeoutMs;
    let result;
    while (Date.now() < deadline) {
      let evaluated;
      try {
        evaluated = await session.send('Runtime.evaluate', {
          expression:
            '({ result: globalThis.__BATCH_EXECUTION_RESULT__ ?? null, ' +
            'error: globalThis.__BATCH_EXECUTION_ERROR__ ?? null, ready: document.readyState })',
          returnByValue: true,
        });
      } catch (cause) {
        // The page context can be replaced while the document finishes loading.
        if (/execution context|Cannot find context|context was destroyed/i.test(String(cause))) {
          await sleep(100);
          continue;
        }
        throw cause;
      }
      const value = evaluated?.result?.value;
      if (value?.error !== undefined && value.error !== null)
        throw new Error(`Browser benchmark failed: ${value.error}`);
      if (value?.result !== null && value?.result !== undefined) {
        result = value.result;
        break;
      }
      await sleep(100);
    }
    if (result === undefined)
      throw new Error(`Browser benchmark timed out after ${options.timeoutMs} ms\n${stderr}`);
    resultValue = {
      result,
      chromium,
      bundle: {
        entry: bundle.entry,
        files: bundle.files,
        totalBytes: bundle.totalBytes,
        candidate: bundle.candidate,
        baseline: bundle.baseline ?? null,
        sdk: options.sdk,
        baselineSdk: options.baselineSdk ?? null,
      },
      browser: version,
    };
  } catch (cause) {
    primaryError = cause;
  } finally {
    session?.close();
    if (child) await stopChild(child);
    if (server) await server.close();
    try {
      // Chromium can still be removing profile files while the process exits. Retry the
      // transient ENOTEMPTY/EBUSY window without extending the benchmark itself.
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    } catch (cause) {
      cleanupError = cause;
    }
  }
  if (primaryError !== undefined) {
    if (cleanupError !== undefined && primaryError instanceof Error)
      primaryError.message += ` (browser cleanup also failed: ${cleanupError?.message ?? cleanupError})`;
    throw primaryError;
  }
  if (cleanupError !== undefined) throw cleanupError;
  return resultValue;
}

async function hostEnvironment(options, chromium, browserVersion) {
  const processors = cpus();
  return Object.freeze({
    collectedAt: new Date().toISOString(),
    node: process.version,
    v8: process.versions.v8,
    platform: platform(),
    arch: arch(),
    release: release(),
    cpuModel: processors[0]?.model ?? 'unknown',
    cpuCount: processors.length,
    totalMemoryBytes: totalmem(),
    command: Object.freeze([...process.argv]),
    cwd: process.cwd(),
    baselineSha: options.baselineSha,
    execution: options.execution,
    warmup: options.warmup,
    samples: options.samples,
    mode: options.controlsOnly ? 'controls-only' : 'mixed',
    controlsOnly: options.controlsOnly === true,
    requireBaseline: options.requireBaseline === true,
    chromium,
    browserVersion,
    sdk: { path: options.sdk, sha256: await sha256(options.sdk) },
    baselineSdk:
      options.baselineSdk === undefined
        ? null
        : { path: options.baselineSdk, sha256: await sha256(options.baselineSdk) },
    probePolicy:
      'Correctness, real EventQueue push/pop counts and prepareBatch admissions use one ' +
      'untimed run per variant; new-board create-to-complete and warmed timings run without ' +
      'probes; the cold label does not represent process or browser startup.',
  });
}

export async function runBrowserBenchmark(options) {
  const config = normalizeConfig(options);
  const { compileDDL } = await import('@mica-js/ddl');
  const model = await compileDDL(fillDeviceSource(config));
  const run = await runBrowser(options, config, model);
  const failures = [];
  if (options.controlsOnly && options.requireTargets && options.baselineSdk === undefined)
    failures.push('--controls-only --require-targets requires --baseline-sdk for both controls');
  if (options.requireTargets) {
    if (run.result.acceptance === null) failures.push('--require-targets needs batch support');
    else if (run.result.acceptance.passed !== true)
      failures.push(
        options.controlsOnly
          ? 'controls-only thresholds were not met; inspect acceptance.checks'
          : 'acceptance thresholds were not met; inspect acceptance.checks',
      );
  }
  return Object.freeze({
    kind: 'batch-execution-benchmark-browser',
    mode: run.result.mode,
    controlsOnly: run.result.controlsOnly,
    speedOrWakeChecked: run.result.speedOrWakeChecked,
    environment: await hostEnvironment(options, run.chromium, run.browser),
    fixture: Object.freeze({
      source: fillDeviceSource(config),
      ...config,
    }),
    bundle: run.bundle,
    support: run.result.support,
    browser: run.result.browser,
    variants: run.result.variants,
    samples: run.result.samples,
    acceptance: run.result.acceptance,
    failures: Object.freeze(failures),
  });
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options === null) {
      console.log(usage);
    } else {
      const result = await runBrowserBenchmark(options);
      console.log(JSON.stringify(result, null, 2));
      if (result.failures.length) {
        console.error(result.failures.join('\n'));
        process.exitCode = 1;
      }
    }
  } catch (cause) {
    console.error(cause?.stack ?? String(cause));
    process.exitCode = 1;
  }
}
