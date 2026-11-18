#!/usr/bin/env node
/**
 * CT107D 器件侧配对工具（不是融合整板基准）。它通过 legacy 整板联调对比 HEAD 与工作树
 * 的器件库源码；融合器件的正式性能基准是 `bench/perf.test.ts` + `bench/preview.test.ts`。
 *
 * CT107D 器件侧配对基准：固定当前引擎、原理图与两套固件，AB/BA 交替对比 HEAD 与工作树器件。
 * HEAD 用 `git ls-tree` + `git show <commit>:<path>` 导出 `examples/devices` 的统一包根；
 * worktree 复制当前 `examples/devices`。两侧在独立临时目录里逐个单器件项目构建，再把
 * ct107d 的 verify-firmware 指向该构建产物；仅器件源码不同，每次测量是独立子进程。
 * HEAD 与 worktree 可能处于迁移前后不同的 legacy 输入布局；prepareVariant 会按各自版本
 * 复制根 schematic/netlist 或 `legacy/source/`，并补齐 `legacy/device-package.mjs`。
 * 该脚本只支持已迁移成 `<id>/package.json` 统一布局的提交；旧 `src/devices` 布局会明确失败。
 * 输出：原始 stdout/stderr、JSON 中位数与轨迹对比；metrics 核验固定固件的 sha/字节数、名与 faults，
 * 以及 execution/clock/tick/warmup/window、原理图摘要和 dist 器件模块摘要。
 * 轨迹是 verify-firmware 过滤计时行后的 CLI 汇总输出（LED/数码管/话题），不是逐电气沿断言。
 *
 * 用法：node examples/ct107d/bench/device-only-paired.mjs [--rounds=3] [--out=DIR] [--keep-temp]
 * 前提：Node >= 22、已构建 packages/sdk/dist、EEPROM 固件已解压到 /tmp/ct107d-firmware。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const PROJECT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const DEVICES_PROJECT = join(PROJECT, '..', 'devices');
const DEVICE_SOURCE = DEVICES_PROJECT;
const LEGACY_SOURCE = join(PROJECT, 'legacy', 'source');
const SCHEMATIC = join(LEGACY_SOURCE, 'ct107d.sch');
const NETLIST = join(LEGACY_SOURCE, 'ct107d.netlist.json');
const LEGACY_PACKAGE = join(PROJECT, 'legacy', 'device-package.mjs');
const VERIFY_ENTRY = join(PROJECT, 'verify-firmware.mjs');
const PROJECT_MODULES = join(DEVICES_PROJECT, 'node_modules');
const DEVICE_PROJECT_FILES = [[join(DEVICES_PROJECT, 'package.json'), 'package.json']];

/**
 * The tracked HEAD may still use the pre-migration layout (root `ct107d.sch`) while the
 * worktree already has the legacy inputs under `legacy/source/`. Each variant therefore
 * gets the files its own `verify-firmware.mjs` expects, including `legacy/device-package.mjs`.
 */
export const HEAD_BOARD_LAYOUT = Object.freeze({
  schematic: 'ct107d.sch',
  boardFiles: [
    ['examples/ct107d/verify-firmware.mjs', 'verify-firmware.mjs'],
    ['examples/ct107d/ct107d.sch', 'ct107d.sch'],
    ['examples/ct107d/ct107d.netlist.json', 'ct107d.netlist.json'],
  ],
  legacyTree: 'examples/ct107d/legacy',
});

export const WORKTREE_BOARD_LAYOUT = Object.freeze({
  schematic: 'legacy/source/ct107d.sch',
  boardFiles: [['verify-firmware.mjs', 'verify-firmware.mjs']],
  legacyTree: 'legacy',
});

/**
 * Resolves the board layout of the git baseline. A HEAD taken before the legacy-input
 * migration has the root schematic/netlist and a `legacy/` helper tree; a later HEAD has
 * the v1 inputs under `legacy/source/`. The paired bench must not assume either one.
 */
export function headBoardLayout(commit) {
  if (!hasGitPath(commit, 'examples/ct107d/legacy/source/ct107d.sch')) return HEAD_BOARD_LAYOUT;
  return {
    schematic: 'legacy/source/ct107d.sch',
    boardFiles: [
      ['examples/ct107d/verify-firmware.mjs', 'verify-firmware.mjs'],
      ['examples/ct107d/legacy/source/ct107d.sch', 'legacy/source/ct107d.sch'],
      ['examples/ct107d/legacy/source/ct107d.netlist.json', 'legacy/source/ct107d.netlist.json'],
    ],
    legacyTree: 'examples/ct107d/legacy',
  };
}
const MAX_BUFFER = 64 * 1024 * 1024;
const EXECUTION = 'throughput';
const CLOCK_FREQUENCY = 11_059_200;

/** 固定固件、已知镜像摘要与测量参数；改这里等于换基准口径。 */
const CASES = [
  {
    id: 'eeprom',
    firmwarePath: '/tmp/ct107d-firmware/10.0 eeprom/Objects/project.hex',
    firmwareSha256: 'c18450f53571913647854cb3a5cd8a73be6014b499cfe5c02e1d663f1b8ec501',
    firmwareBytes: 4179,
    warmupMs: 120,
    windowMs: 200,
    stepMs: 2,
  },
  {
    id: 'preview',
    firmwarePath: join(PROJECT, 'assets', 'digital-display-dynamic.bin'),
    firmwareSha256: 'b15a9f9f4232a70d88d080e2f6336359c701777951685a93177e3264b829bd25',
    firmwareBytes: 2421,
    warmupMs: 512,
    windowMs: 1024,
    stepMs: 64,
  },
];

const USAGE = `用法：node examples/ct107d/bench/device-only-paired.mjs [选项]

  --rounds=<n>           配对轮数，正整数，默认 3
  --out=<dir>            结果目录；默认 test-results/ct107d-device-only-paired-<时间戳>
  --keep-temp            保留临时构建目录
  -h, --help             显示本帮助`;

const options = { rounds: 3, out: undefined, keepTemp: false };

function parseOptions(argv) {
  for (const argument of argv) {
    if (argument === '-h' || argument === '--help') {
      console.log(USAGE);
      process.exit(0);
    }
    const match = /^--(rounds|out)=(.+)$/.exec(argument);
    if (match === null) {
      if (argument === '--keep-temp') options.keepTemp = true;
      else throw new Error(`未知参数 ${argument}\n\n${USAGE}`);
    } else if (match[1] === 'rounds') {
      const rounds = Number(match[2]);
      if (!Number.isInteger(rounds) || rounds <= 0) throw new RangeError('--rounds 必须是正整数');
      options.rounds = rounds;
    } else options.out = resolve(match[2]);
  }
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const schematicDigestOf = (variant) => sha256(readFileSync(variant.schematic));
const round = (value, digits = 3) => Number(value.toFixed(digits));
const format = (value, digits = 3) => (Number.isFinite(value) ? value.toFixed(digits) : '-');

function stats(values, digits = 3) {
  const clean = values.filter((value) => Number.isFinite(value));
  if (clean.length === 0) return null;
  const sorted = [...clean].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return { count: clean.length, median: round(median, digits) };
}

function ratio(numerator, denominator) {
  if (
    typeof numerator !== 'number' ||
    typeof denominator !== 'number' ||
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator === 0
  )
    return null;
  return round(numerator / denominator);
}

function git(args, encoding = 'utf8') {
  const result = spawnSync('git', args, { cwd: PROJECT, encoding, maxBuffer: MAX_BUFFER });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')} 失败：${String(result.stderr).trim()}`);
  return result.stdout;
}

function gitStatus(path) {
  const output = git(['status', '--porcelain=v1', '--', `:/${path}`]).trim();
  return output === '' ? [] : output.split('\n');
}

const REPO_ROOT = realpathSync(git(['rev-parse', '--show-toplevel']).trim());
const DEVICE_REL = relative(REPO_ROOT, DEVICE_SOURCE).split(sep).join('/');
const HEAD_DEVICE_REL = 'examples/devices';
if (DEVICE_REL === '' || DEVICE_REL.startsWith('..'))
  throw new Error(`器件目录不在仓库内：${DEVICE_SOURCE}`);
const CHILD_ENV = {
  ...process.env,
  NO_COLOR: '1',
  PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
};

function execute(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: CHILD_ENV,
    maxBuffer: MAX_BUFFER,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const excluded = (path) =>
  path.split('/').some((part) => part === 'node_modules' || part === 'dist') ||
  path.endsWith('.d.ddl.ts');

/** 基线导出：列出提交中的器件文件后逐个 git show；跳过生成声明与构建产物。 */
function exportHeadDevices(commit, destination) {
  const prefix = `${HEAD_DEVICE_REL}/`;
  const files = git([
    'ls-tree',
    '-r',
    '--name-only',
    '--full-name',
    '-z',
    commit,
    '--',
    `:/${HEAD_DEVICE_REL}`,
  ])
    .split('\0')
    .filter((path) => path.startsWith(prefix) && !excluded(path.slice(prefix.length)));
  if (files.length === 0) throw new Error(`提交 ${commit} 中没有器件源码：${HEAD_DEVICE_REL}`);
  for (const path of files) {
    const target = join(destination, ...path.slice(prefix.length).split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, git(['show', `${commit}:${path}`], 'buffer'));
  }
}

function exportHeadFile(commit, path, destination, replacements = []) {
  let source = git(['show', `${commit}:${path}`], 'buffer').toString('utf8');
  for (const [from, to] of replacements) source = source.replaceAll(from, to);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, source);
}

function hasGitPath(commit, path) {
  try {
    git(['cat-file', '-e', `${commit}:${path}`]);
    return true;
  } catch {
    return false;
  }
}

/** Exports one tracked directory from a commit, preserving its relative layout. */
function exportHeadTree(commit, directory, destination) {
  const prefix = `${directory}/`;
  const files = git([
    'ls-tree',
    '-r',
    '--name-only',
    '--full-name',
    '-z',
    commit,
    '--',
    `:/${directory}`,
  ])
    .split('\0')
    .filter((path) => path.startsWith(prefix));
  if (files.length === 0) throw new Error(`提交 ${commit} 中没有目录：${directory}`);
  for (const path of files) {
    const target = join(destination, ...path.slice(prefix.length).split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, git(['show', `${commit}:${path}`], 'buffer'));
  }
}

export function prepareVariant(kind, commit, tempRoot) {
  const directory = join(tempRoot, kind);
  const devicesDirectory = join(directory, 'devices');
  const boardDirectory = join(directory, 'ct107d');
  const destination = devicesDirectory;
  const layout = kind === 'head' ? headBoardLayout(commit) : WORKTREE_BOARD_LAYOUT;
  mkdirSync(destination, { recursive: true });
  mkdirSync(boardDirectory, { recursive: true });
  if (kind === 'head') {
    exportHeadDevices(commit, destination);
    for (const [source, target] of layout.boardFiles) {
      if (!hasGitPath(commit, source))
        throw new Error(`提交 ${commit} 缺少 paired bench 输入：${source}`);
      exportHeadFile(commit, source, join(boardDirectory, target));
    }
    exportHeadTree(commit, layout.legacyTree, join(boardDirectory, 'legacy'));
  } else {
    cpSync(DEVICE_SOURCE, destination, {
      recursive: true,
      filter: (source) => !excluded(basename(source)),
    });
    for (const [source, target] of layout.boardFiles) {
      const from = join(PROJECT, source);
      if (!existsSync(from)) throw new Error(`工作树缺少 paired bench 输入：${from}`);
      const to = join(boardDirectory, target);
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to);
    }
    const legacy = join(PROJECT, layout.legacyTree);
    if (!existsSync(legacy)) throw new Error(`工作树缺少 paired bench legacy 目录：${legacy}`);
    cpSync(legacy, join(boardDirectory, 'legacy'), { recursive: true });
  }
  for (const [from, to] of DEVICE_PROJECT_FILES) cpSync(from, join(devicesDirectory, to));
  cpSync(join(REPO_ROOT, 'tsconfig.base.json'), join(devicesDirectory, 'tsconfig.base.json'));
  symlinkSync(
    PROJECT_MODULES,
    join(directory, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  return {
    id: kind,
    label: kind === 'head' ? 'HEAD' : 'worktree',
    directory,
    devicesDirectory,
    boardDirectory,
    schematic: join(boardDirectory, layout.schematic),
  };
}

function resolveMicaCli() {
  const found = [
    join(PROJECT, 'node_modules', '@mica-js', 'sdk', 'dist', 'build', 'cli.js'),
    join(REPO_ROOT, 'node_modules', '@mica-js', 'sdk', 'dist', 'build', 'cli.js'),
    join(REPO_ROOT, 'packages', 'sdk', 'dist', 'build', 'cli.js'),
  ].find(existsSync);
  if (found === undefined)
    throw new Error('找不到 mica CLI；请先运行 pnpm --filter @mica-js/sdk build');
  return realpathSync(found);
}

function deviceProjects(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        const manifest = JSON.parse(readFileSync(join(directory, name, 'package.json'), 'utf8'));
        return (
          typeof manifest.publisher === 'string' &&
          typeof manifest.name === 'string' &&
          typeof manifest.displayName === 'string'
        );
      } catch {
        return false;
      }
    })
    .sort();
}

function buildVariant(variant, micaCli, outDir) {
  const started = performance.now();
  const projects = deviceProjects(variant.devicesDirectory);
  if (projects.length === 0)
    throw new Error(`${variant.label} 不包含统一器件包；基准只支持统一包布局的提交`);
  const stdout = [];
  const stderr = [];
  let status = 0;
  for (const id of projects) {
    const result = execute(
      process.execPath,
      [micaCli, 'build', '--root', join(variant.devicesDirectory, id)],
      variant.directory,
    );
    stdout.push(`[${id}]\n${result.stdout}`);
    stderr.push(`[${id}]\n${result.stderr}`);
    if (result.status !== 0) {
      status = result.status;
      break;
    }
  }
  writeFileSync(join(outDir, `build-${variant.id}.stdout.txt`), stdout.join('\n'));
  writeFileSync(join(outDir, `build-${variant.id}.stderr.txt`), stderr.join('\n'));
  if (status !== 0)
    throw new Error(
      `${variant.label} mica build 失败（exit ${status}）；见 build-${variant.id}.stdout/stderr.txt` +
        (stderr.join('').trim() === '' ? '' : `\n${stderr.join('').trim()}`),
    );
  return { status, wallMs: round(performance.now() - started) };
}

/** 去掉含计时的头行；留下的板面汇总用于跨变体逐字比较。 */
function cliSummaryLines(stdout) {
  return stdout
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter(
      (line) =>
        !line.startsWith('=== ') &&
        !line.startsWith('  测量窗口 ') &&
        !line.startsWith('FIRMWARE_METRICS '),
    );
}

/** 核验 verify 输出的固定口径；任一项不符即说明基准输入或引擎被换过。 */
function assertMetrics(variant, caseDefinition, metrics) {
  const expected = {
    firmware: basename(caseDefinition.firmwarePath),
    firmwareSha256: caseDefinition.firmwareSha256,
    firmwareBytes: caseDefinition.firmwareBytes,
    execution: EXECUTION,
    clockFrequency: CLOCK_FREQUENCY,
    tickMs: caseDefinition.stepMs,
    warmUpMs: caseDefinition.warmupMs,
    windowStartMs: caseDefinition.warmupMs,
    windowEndMs: caseDefinition.warmupMs + caseDefinition.windowMs,
    simMs: caseDefinition.windowMs,
    faults: 0,
  };
  const mismatched = Object.entries(expected)
    .filter(([key, value]) => metrics[key] !== value)
    .map(([key]) => key);
  if (mismatched.length > 0)
    throw new Error(`${variant.label} ${caseDefinition.id} metrics 不符：${mismatched.join(', ')}`);
  const artifacts = metrics.artifacts ?? {};
  if (artifacts.schematicSha256 !== schematicDigestOf(variant))
    throw new Error(
      `${variant.label} ${caseDefinition.id} 原理图摘要不符：${artifacts.schematicSha256}`,
    );
  assertDistArtifacts(variant, caseDefinition, artifacts);
}

/** dist 器件模块摘要必须等于本次构建产物，确认对比的是同一引擎产出的 dist。 */
function assertDistArtifacts(variant, caseDefinition, artifacts) {
  const modules = artifacts.deviceModulesSha256;
  if (artifacts.source !== 'dist' || modules === null || typeof modules !== 'object')
    throw new Error(`${variant.label} ${caseDefinition.id} metrics 缺少 dist 摘要`);
  const ids = Object.keys(modules);
  const wrong = ids.filter((id) => {
    const path = join(variant.devicesDirectory, 'dist', id, 'model.js');
    return modules[id] !== sha256(readFileSync(path));
  });
  if (ids.length === 0 || wrong.length > 0)
    throw new Error(
      `${variant.label} ${caseDefinition.id} dist 器件摘要不符：${wrong.join(', ') || '空'}`,
    );
}

function runCase(variant, caseDefinition, outDir, roundIndex, seq) {
  const base = `round-${roundIndex}-seq-${seq}-${variant.id}-${caseDefinition.id}`;
  const raw = { stdout: `raw/${base}.stdout.txt`, stderr: `raw/${base}.stderr.txt` };
  const result = execute(
    process.execPath,
    [
      join(variant.boardDirectory, 'verify-firmware.mjs'),
      caseDefinition.firmwarePath,
      `--warmup-ms=${caseDefinition.warmupMs}`,
      `--ms=${caseDefinition.windowMs}`,
      `--step=${caseDefinition.stepMs}`,
      `--execution=${EXECUTION}`,
      `--clock=${CLOCK_FREQUENCY}`,
    ],
    variant.boardDirectory,
  );
  writeFileSync(join(outDir, raw.stdout), result.stdout);
  writeFileSync(join(outDir, raw.stderr), result.stderr);
  if (result.status !== 0)
    throw new Error(
      `${variant.label} ${caseDefinition.id} verify 失败（exit ${result.status}）；见 ${raw.stdout}` +
        (result.stderr.trim() === '' ? '' : `\n${result.stderr.trim()}`),
    );
  const metricLines = result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('FIRMWARE_METRICS '));
  if (metricLines.length !== 1)
    throw new Error(
      `${variant.label} ${caseDefinition.id} 应输出 1 行 FIRMWARE_METRICS，实际 ${metricLines.length} 行`,
    );
  const metrics = JSON.parse(metricLines[0].slice('FIRMWARE_METRICS '.length));
  assertMetrics(variant, caseDefinition, metrics);
  const trajectory = cliSummaryLines(result.stdout);
  return {
    metrics,
    trajectory: { lines: trajectory.length, sha256: sha256(trajectory.join('\n')) },
    raw,
  };
}

function writeTrajectoryDiff(caseDefinition, caseRuns, outDir) {
  const headRun = caseRuns.find((run) => run.variant === 'head');
  const worktreeRun = caseRuns.find((run) => run.variant === 'worktree');
  if (headRun === undefined || worktreeRun === undefined) return;
  const read = (run) => cliSummaryLines(readFileSync(join(outDir, run.raw.stdout), 'utf8'));
  const head = read(headRun),
    worktree = read(worktreeRun);
  const output = [
    `case: ${caseDefinition.id}`,
    `HEAD: round ${headRun.round}`,
    `worktree: round ${worktreeRun.round}`,
    '',
  ];
  for (
    let index = 0;
    index < Math.max(head.length, worktree.length) && output.length < 104;
    index += 1
  ) {
    if (head[index] !== worktree[index])
      output.push(
        `@@ ${index + 1} @@`,
        `-${head[index] ?? '<missing>'}`,
        `+${worktree[index] ?? '<missing>'}`,
      );
  }
  writeFileSync(join(outDir, `trajectory-diff-${caseDefinition.id}.txt`), `${output.join('\n')}\n`);
}

function compareTrajectories(runs, outDir) {
  const result = {};
  for (const caseDefinition of CASES) {
    const caseRuns = runs.filter((run) => run.case === caseDefinition.id);
    const shas = (variant) => [
      ...new Set(
        caseRuns.filter((run) => run.variant === variant).map((run) => run.trajectory.sha256),
      ),
    ];
    const headShas = shas('head'),
      worktreeShas = shas('worktree');
    const stable = headShas.length === 1 && worktreeShas.length === 1;
    const match = stable && headShas[0] === worktreeShas[0];
    result[caseDefinition.id] = { match, stable, runs: caseRuns.length, headShas, worktreeShas };
    if (!match) {
      result[caseDefinition.id].diff = `trajectory-diff-${caseDefinition.id}.txt`;
      writeTrajectoryDiff(caseDefinition, caseRuns, outDir);
    }
  }
  return result;
}

function summarize(runs) {
  const summary = {};
  for (const caseDefinition of CASES) {
    const values = (variant, key, digits = 3) =>
      stats(
        runs
          .filter((run) => run.case === caseDefinition.id && run.variant === variant)
          .map((run) => run.metrics[key]),
        digits,
      );
    const head = {
      cpuMs: values('head', 'cpuMs'),
      wallMs: values('head', 'elapsedWallMs'),
      realtime: values('head', 'realtimeRatio', 4),
    };
    const worktree = {
      cpuMs: values('worktree', 'cpuMs'),
      wallMs: values('worktree', 'elapsedWallMs'),
      realtime: values('worktree', 'realtimeRatio', 4),
    };
    summary[caseDefinition.id] = {
      head,
      worktree,
      medianRatios: {
        cpuMs: ratio(worktree.cpuMs?.median, head.cpuMs?.median),
        wallMs: ratio(worktree.wallMs?.median, head.wallMs?.median),
        realtime: ratio(worktree.realtime?.median, head.realtime?.median),
      },
    };
  }
  return summary;
}

function printSummary(summary, trajectories) {
  console.log(`\n# summary（${options.rounds} 轮中位；ratio = worktree / HEAD）`);
  for (const caseDefinition of CASES) {
    const { head, worktree, medianRatios } = summary[caseDefinition.id];
    console.log(
      `\n${caseDefinition.id} warm=${caseDefinition.warmupMs}ms window=${caseDefinition.windowMs}ms step=${caseDefinition.stepMs}ms`,
    );
    for (const [label, values] of [
      ['HEAD', head],
      ['worktree', worktree],
    ])
      console.log(
        `  ${label.padEnd(8)} cpu=${format(values.cpuMs?.median)} wall=${format(values.wallMs?.median)} rt=${format(values.realtime?.median, 4)}`,
      );
    console.log(
      `  ratio cpu=${format(medianRatios.cpuMs)}x wall=${format(medianRatios.wallMs)}x rt=${format(medianRatios.realtime)}x`,
    );
  }
  console.log('\n# trajectory（CLI 汇总输出，非逐沿断言）');
  for (const caseDefinition of CASES) {
    const entry = trajectories[caseDefinition.id];
    console.log(
      `  ${caseDefinition.id.padEnd(8)} ${entry.match ? 'match' : 'DIFF'} stable=${entry.stable ? 'yes' : 'no'} runs=${entry.runs}`,
    );
  }
}

function main() {
  parseOptions(process.argv.slice(2));
  if (Number(process.versions.node.split('.')[0]) < 22)
    throw new Error(`需要 Node >= 22，当前为 ${process.version}`);
  const required = [
    DEVICE_SOURCE,
    SCHEMATIC,
    NETLIST,
    LEGACY_PACKAGE,
    VERIFY_ENTRY,
    PROJECT_MODULES,
    ...CASES.map((definition) => definition.firmwarePath),
  ];
  for (const path of required) if (!existsSync(path)) throw new Error(`输入不存在：${path}`);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir =
    options.out ?? join(REPO_ROOT, 'test-results', `ct107d-device-only-paired-${timestamp}`);
  mkdirSync(join(outDir, 'raw'), { recursive: true });
  const micaCli = resolveMicaCli();
  const engine = {
    micaCli,
    micaCliSha256: sha256(readFileSync(micaCli)),
    packagesGitStatus: gitStatus('packages'),
  };
  const commit = git(['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  const runs = [],
    builds = {};
  const writeMetrics = (summary, trajectories) =>
    writeFileSync(
      join(outDir, 'metrics.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          node: process.version,
          options: { rounds: options.rounds },
          baseline: { commit },
          engine,
          cases: CASES,
          builds,
          runs,
          ...(summary === undefined ? {} : { summary }),
          ...(trajectories === undefined ? {} : { trajectories }),
        },
        null,
        2,
      )}\n`,
    );

  let tempRoot;
  try {
    console.log(`# CT107D device-only paired bench\n# baseline: HEAD -> ${commit}`);
    const packagesState =
      engine.packagesGitStatus.length === 0
        ? 'clean'
        : `${engine.packagesGitStatus.length} 项改动（见 metrics.json）`;
    console.log(`# engine: ${micaCli}\n# packages git status: ${packagesState}`);
    if (gitStatus(DEVICE_REL).length === 0)
      console.log('# warning: 工作树器件与基线一致，A/B 差异只会是噪声');
    tempRoot = mkdtempSync(join(tmpdir(), 'ct107d-device-only-paired-'));
    console.log(`\n[prepare] ${tempRoot}`);
    const head = prepareVariant('head', commit, tempRoot);
    const worktree = prepareVariant('worktree', commit, tempRoot);
    for (const variant of [head, worktree]) {
      builds[variant.id] = buildVariant(variant, micaCli, outDir);
      console.log(`[build] ${variant.label} ${builds[variant.id].wallMs} ms`);
    }
    writeMetrics();

    for (let roundIndex = 0; roundIndex < options.rounds; roundIndex += 1) {
      const order = roundIndex % 2 === 0 ? [head, worktree] : [worktree, head];
      console.log(`\npair ${roundIndex}: ${order.map((variant) => variant.label).join(' -> ')}`);
      for (const [seq, variant] of order.entries()) {
        for (const caseDefinition of CASES) {
          const result = runCase(variant, caseDefinition, outDir, roundIndex, seq);
          runs.push({
            round: roundIndex,
            seq,
            order: order.map((entry) => entry.id),
            variant: variant.id,
            case: caseDefinition.id,
            ...result,
          });
          writeMetrics();
          console.log(
            `  round ${roundIndex} seq ${seq} ${variant.label.padEnd(8)} ${caseDefinition.id.padEnd(8)} cpu=${format(result.metrics.cpuMs)} wall=${format(result.metrics.elapsedWallMs)} rt=${format(result.metrics.realtimeRatio, 4)} trajectory=${result.trajectory.sha256.slice(0, 12)}`,
          );
        }
      }
    }

    const summary = summarize(runs);
    const trajectories = compareTrajectories(runs, outDir);
    writeMetrics(summary, trajectories);
    printSummary(summary, trajectories);
    console.log(`\n# outputs: ${outDir}`);
    if (CASES.some((definition) => !trajectories[definition.id].match)) {
      console.error('错误：CLI 汇总轨迹与基线不一致。');
      process.exitCode = 1;
    }
  } catch (error) {
    writeFileSync(
      join(outDir, 'error.txt'),
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    throw error;
  } finally {
    if (tempRoot !== undefined) {
      if (options.keepTemp) console.error(`临时目录保留在：${tempRoot}`);
      else rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

const invoked =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  }
}
