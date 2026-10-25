#!/usr/bin/env node
/**
 * Render the performance benchmark comment from two `pnpm test:perf` logs.
 *
 * The perf suites only print observations, so this script turns them into a
 * comparison:
 *   - every known scenario is matched by its printed label and unit,
 *   - repeated rounds are reduced with the median (runner noise is high),
 *   - the PR value is compared with the base value and a direction-aware
 *     percentage is rendered (green = better, red = worse).
 *
 * Inputs come from flags or environment variables, so the same script works
 * locally and inside the workflow:
 *   BASE_LOG, HEAD_LOG, COMMENT_FILE, REPORT_FILE, BASE_LABEL, HEAD_LABEL,
 *   BASE_SHA, HEAD_SHA, BASE_STATUS, HEAD_STATUS, RUN_URL
 *
 * Usage:
 *   node scripts/perf-benchmark.mjs --base base.log --head head.log --print
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

/** Hidden marker the workflow uses to update its previous comment. */
const MARKER = '<!-- mica-js-perf-benchmark -->';

/** Changes inside this band are treated as runner noise. */
const NOISE_PERCENT = 3;

const LOG_TAIL_LINES = 30;
const LOG_TAIL_CHARS = 4000;

/**
 * One entry per line the perf suites print. `name` is the row label, `area`
 * groups rows into tables, and `pattern` captures the measured number. Rows are
 * rendered in this order, so the order below is the order of the report.
 */
const METRICS = [
  {
    id: 'compile',
    area: 'Compile',
    name: 'Compile circuit',
    unit: 'ms',
    direction: 'lower',
    pattern: /compile:\s*([\d.]+)\s*ms/,
  },
  {
    id: 'compile-batch',
    area: 'Compile',
    name: 'Compiled batch loop',
    unit: 'ns/tick',
    direction: 'lower',
    pattern: /batch:\s*([\d.]+)\s*ns\/tick/,
  },
  {
    id: 'create',
    area: 'Runtime',
    name: 'Circuit creation',
    unit: 'ms',
    direction: 'lower',
    pattern: /create:\s*([\d.]+)\s*ms/,
  },
  {
    id: 'batch',
    area: 'Runtime',
    name: 'Batch throughput',
    unit: 'M ticks/s',
    direction: 'higher',
    pattern: /batch:\s*([\d.]+)\s*M ticks\/s/,
  },
  {
    id: 'step',
    area: 'Runtime',
    name: 'Single-step cost',
    unit: 'ns/step',
    direction: 'lower',
    pattern: /step:\s*([\d.]+)\s*ns\/step/,
  },
  {
    id: 'unified-led',
    area: 'Devices',
    name: 'Unified LED',
    unit: 'M ticks/s',
    direction: 'higher',
    pattern: /unified LED:\s*([\d.]+)\s*M ticks\/s/,
  },
  {
    id: 'builtin-led',
    area: 'Devices',
    name: 'Built-in ideal-led',
    unit: 'M ticks/s',
    direction: 'higher',
    pattern: /built-in ideal-led:\s*([\d.]+)\s*M ticks\/s/,
  },
  {
    id: 'led-ratio',
    area: 'Devices',
    name: 'Unified / built-in LED ratio',
    unit: '×',
    direction: 'higher',
    pattern: /ratio:\s*([\d.]+)x\b/,
  },
  {
    id: 'button-led',
    area: 'Devices',
    name: 'Button + LED',
    unit: 'M ticks/s',
    direction: 'higher',
    pattern: /button \+ LED:\s*([\d.]+)\s*M ticks\/s/,
  },
  {
    id: 'benchmark',
    area: 'Benchmark example',
    name: 'Documented benchmark',
    unit: 'M ticks/s',
    direction: 'higher',
    pattern: /benchmark:\s*([\d.]+)\s*M ticks\/s/,
  },
  {
    id: 'legacy-scheduler',
    area: 'Teaching MCU',
    name: 'Legacy scheduler',
    unit: 'M inst/s',
    direction: 'higher',
    pattern: /legacy scheduler:\s*([\d.]+)\s*M inst\/s/,
  },
  {
    id: 'teaching-batch',
    area: 'Teaching MCU',
    name: 'Unified teaching batch (warm)',
    unit: 'M inst/s',
    direction: 'higher',
    pattern: /unified teaching batch:\s*([\d.]+)\s*M inst\/s/,
  },
  {
    id: 'teaching-cold',
    area: 'Teaching MCU',
    name: 'Unified teaching batch (cold)',
    unit: 'M inst/s',
    direction: 'higher',
    pattern: /unified teaching batch:.*?\bcold\s+([\d.]+)\s*M inst\/s/,
  },
  {
    id: 'm3-batch',
    area: 'Teaching MCU',
    name: 'Unified M3 batch (warm)',
    unit: 'M inst/s',
    direction: 'higher',
    pattern: /unified M3 batch:\s*([\d.]+)\s*M inst\/s/,
  },
  {
    id: 'm3-cold',
    area: 'Teaching MCU',
    name: 'Unified M3 batch (cold)',
    unit: 'M inst/s',
    direction: 'higher',
    pattern: /unified M3 batch:.*?\bcold\s+([\d.]+)\s*M inst\/s/,
  },
  {
    id: 'teaching-step',
    area: 'Teaching MCU',
    name: 'Unified teaching single-step',
    unit: 'M inst/s',
    direction: 'higher',
    pattern: /unified teaching single-step:\s*([\d.]+)\s*M inst\/s/,
  },
  {
    id: 'regions-on',
    area: 'Regions',
    name: 'Regions on',
    unit: 'M inst/s',
    direction: 'higher',
    pattern: /regions on\s*:\s*([\d.]+)\s*M inst\/s/,
  },
  {
    id: 'regions-off',
    area: 'Regions',
    name: 'Regions off',
    unit: 'M inst/s',
    direction: 'higher',
    pattern: /regions off:\s*([\d.]+)\s*M inst\/s/,
  },
];

const VERDICT_ICON = {
  improved: '🟢',
  regressed: '🔴',
  noise: '⚪',
  'not-measured': '➖',
};

const EMPTY = '—';

function readLog(path) {
  if (!path) return { text: '', error: 'no log path configured' };
  try {
    return { text: readFileSync(path, 'utf8'), error: null };
  } catch (error) {
    return { text: '', error: error instanceof Error ? error.message : String(error) };
  }
}

function parseLog(text) {
  const samples = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    for (const metric of METRICS) {
      const match = metric.pattern.exec(line);
      if (match === null) continue;
      const value = Number.parseFloat(match[1]);
      if (!Number.isFinite(value)) continue;
      if (!samples.has(metric.id)) samples.set(metric.id, []);
      samples.get(metric.id).push(value);
    }
  }
  return samples;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Compares one metric. `delta` is the plain relative change of the printed
 * value; `verdict` inverts it when lower is better, so "green" always means the
 * PR is faster or cheaper.
 */
function evaluate(base, head, direction) {
  if (base === null || head === null) return { delta: null, verdict: 'not-measured' };
  if (base === 0) return { delta: null, verdict: 'not-measured' };
  const delta = ((head - base) / Math.abs(base)) * 100;
  const improvement = direction === 'lower' ? -delta : delta;
  let verdict = 'noise';
  if (Math.abs(improvement) >= NOISE_PERCENT) {
    verdict = improvement > 0 ? 'improved' : 'regressed';
  }
  return { delta, verdict };
}

function formatNumber(value) {
  const absolute = Math.abs(value);
  if (absolute === 0) return '0';
  if (absolute >= 100) return value.toFixed(1).replace(/\.0$/, '');
  if (absolute >= 1) return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function formatValue(value, unit) {
  if (value === null) return EMPTY;
  return unit === '×' ? `${formatNumber(value)}×` : `${formatNumber(value)} ${unit}`;
}

function formatPercent(delta) {
  if (delta === null) return EMPTY;
  const rounded = Math.abs(delta) < 0.05 ? 0 : delta;
  return rounded === 0 ? '0%' : `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}%`;
}

function formatDelta(delta, verdict) {
  if (delta === null) return EMPTY;
  return `${VERDICT_ICON[verdict]} ${formatPercent(delta)}`;
}

function shortSha(sha) {
  return typeof sha === 'string' && sha.length > 0 ? sha.slice(0, 7) : '?';
}

function inlineCode(text) {
  return `\`${String(text ?? '').replaceAll('`', '')}\``;
}

function escapeHtml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function logTail(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const tail = lines.slice(-LOG_TAIL_LINES).join('\n');
  const clipped = tail.length > LOG_TAIL_CHARS ? tail.slice(-LOG_TAIL_CHARS) : tail;
  return clipped;
}

function failureBlock(title, text) {
  const tail = logTail(text);
  if (tail === '') return [];
  return [
    '',
    `<details><summary>${title}</summary>`,
    '',
    `<pre><code>${escapeHtml(tail)}</code></pre>`,
    '',
    '</details>',
  ];
}

function renderStatusAlert({ baseMetrics, headMetrics, baseStatus, headStatus, baseLogText }) {
  const lines = [];
  const headFailed = headMetrics === 0;
  const baseFailed = baseMetrics === 0;

  if (headFailed) {
    lines.push(
      '> [!CAUTION]',
      `> The PR branch produced no benchmark numbers (\`pnpm test:perf\` exited with code ${headStatus}), ` +
        'so the PR column below is empty.',
    );
    return lines;
  }

  if (baseFailed) {
    lines.push(
      '> [!NOTE]',
      '> The base revision produced no benchmark numbers — it either predates the `test:perf` ' +
        'harness or the run failed — so only PR numbers are shown.',
    );
    if (
      baseLogText.trim() !== '' &&
      /not present|no test:perf|command not found|none of the specified/i.test(baseLogText)
    ) {
      lines.push('> The base checkout does not expose a `test:perf` script.');
    }
  } else if (baseStatus !== 0) {
    lines.push(
      '> [!WARNING]',
      `> The base benchmark run exited with code ${baseStatus}; the numbers below come from the rounds that completed.`,
    );
  }

  if (headStatus !== 0) {
    lines.push(
      '> [!WARNING]',
      `> The PR benchmark run exited with code ${headStatus}; the numbers below come from the rounds that completed.`,
    );
  }

  return lines;
}

function renderSummary(metrics) {
  const comparable = metrics.filter((metric) => metric.base !== null && metric.head !== null);
  if (comparable.length === 0) {
    return metrics.some((metric) => metric.head !== null)
      ? '⚪ Baseline unavailable · showing PR numbers only'
      : '➖ No metrics measured';
  }

  const counts = { improved: 0, regressed: 0, noise: 0, 'not-measured': 0 };
  for (const metric of comparable) counts[metric.verdict] += 1;
  const parts = [
    `${VERDICT_ICON.improved} **${counts.improved} improved**`,
    `${VERDICT_ICON.regressed} **${counts.regressed} regressed**`,
    `${VERDICT_ICON.noise} **${counts.noise} within noise**`,
  ];
  if (counts['not-measured'] > 0) {
    parts.push(`${VERDICT_ICON['not-measured']} ${counts['not-measured']} not measured`);
  }
  return `${parts.join(' · ')} · noise band ±${NOISE_PERCENT}%`;
}

function renderTable(rows) {
  const lines = ['| Scenario | Base | PR | Change |', '| --- | ---: | ---: | ---: |'];
  for (const row of rows) {
    const marker = row.direction === 'lower' ? ' ↓' : '';
    lines.push(
      `| ${row.name}${marker} | ${formatValue(row.base, row.unit)} | ` +
        `${formatValue(row.head, row.unit)} | ${formatDelta(row.delta, row.verdict)} |`,
    );
  }
  return lines;
}

function renderComment(context) {
  const {
    metrics,
    baseLabel,
    headLabel,
    baseSha,
    headSha,
    baseStatus,
    headStatus,
    baseLogText,
    rounds,
    runUrl,
  } = context;

  const lines = [
    MARKER,
    '## ⚡ Simulator performance benchmark',
    '',
    `${inlineCode(baseLabel)} \`${shortSha(baseSha)}\` → ${inlineCode(headLabel)} \`${shortSha(headSha)}\``,
    '',
    renderSummary(metrics),
  ];

  const alerts = renderStatusAlert({
    baseMetrics: metrics.filter((metric) => metric.base !== null).length,
    headMetrics: metrics.filter((metric) => metric.head !== null).length,
    baseStatus,
    headStatus,
    baseLogText,
  });
  if (alerts.length > 0) lines.push('', ...alerts);

  const notable = metrics
    .filter((metric) => metric.verdict === 'improved' || metric.verdict === 'regressed')
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
    .slice(0, 5);
  if (notable.length > 0) {
    lines.push(
      '',
      notable
        .map(
          (metric) =>
            `${VERDICT_ICON[metric.verdict]} **${metric.name}** ${formatPercent(metric.delta)}`,
        )
        .join(' · '),
    );
  }

  const areas = new Map();
  for (const metric of metrics) {
    if (metric.base === null && metric.head === null) continue;
    if (!areas.has(metric.area)) areas.set(metric.area, []);
    areas.get(metric.area).push(metric);
  }

  for (const [area, rows] of areas) {
    lines.push('', `### ${area}`, '', ...renderTable(rows));
  }

  lines.push(
    '',
    '<details><summary>How these numbers are produced</summary>',
    '',
    '- `pnpm test:perf` (Vitest, resolved from source — no build step) in `packages/simulator`',
    `- ${rounds} alternating base/PR rounds; each cell is the median of the rounds`,
    '- Runner: `ubuntu-24.04`, Node 24; changes inside ±3% are treated as runner noise',
    '- Rows marked ↓ are time-per-operation metrics, where lower is better',
    '- 🟢 better · 🔴 worse · ⚪ within noise',
  );
  if (runUrl) lines.push('', `[Workflow run](${runUrl})`);
  lines.push('', '</details>');

  if (metrics.every((metric) => metric.head === null)) {
    lines.push(...failureBlock('PR log (last 30 lines)', context.headLogText));
  } else if (metrics.every((metric) => metric.base === null)) {
    lines.push(...failureBlock('Base log (last 30 lines)', baseLogText));
  }

  return `${lines.join('\n')}\n`;
}

const { values } = parseArgs({
  options: {
    base: { type: 'string' },
    head: { type: 'string' },
    comment: { type: 'string' },
    json: { type: 'string' },
    'base-label': { type: 'string' },
    'base-sha': { type: 'string' },
    'head-label': { type: 'string' },
    'head-sha': { type: 'string' },
    'base-status': { type: 'string' },
    'head-status': { type: 'string' },
    rounds: { type: 'string' },
    'run-url': { type: 'string' },
    print: { type: 'boolean', default: false },
  },
});

const env = process.env;
const baseLogPath = values.base ?? env.BASE_LOG;
const headLogPath = values.head ?? env.HEAD_LOG;
const commentPath = values.comment ?? env.COMMENT_FILE;
const reportPath = values.json ?? env.REPORT_FILE;
const baseStatus = Number.parseInt(values['base-status'] ?? env.BASE_STATUS ?? '0', 10);
const headStatus = Number.parseInt(values['head-status'] ?? env.HEAD_STATUS ?? '0', 10);
const rounds = values.rounds ?? env.ROUNDS ?? '3';

const baseLog = readLog(baseLogPath);
const headLog = readLog(headLogPath);
const baseSamples = parseLog(baseLog.text);
const headSamples = parseLog(headLog.text);

const metrics = METRICS.map((spec) => {
  const base = median(baseSamples.get(spec.id) ?? []);
  const head = median(headSamples.get(spec.id) ?? []);
  return {
    id: spec.id,
    area: spec.area,
    name: spec.name,
    unit: spec.unit,
    direction: spec.direction,
    samples: {
      base: (baseSamples.get(spec.id) ?? []).length,
      head: (headSamples.get(spec.id) ?? []).length,
    },
    base,
    head,
    ...evaluate(base, head, spec.direction),
  };
});

const comment = renderComment({
  metrics,
  baseLabel: values['base-label'] ?? env.BASE_LABEL ?? 'base',
  headLabel: values['head-label'] ?? env.HEAD_LABEL ?? 'pull request',
  baseSha: values['base-sha'] ?? env.BASE_SHA,
  headSha: values['head-sha'] ?? env.HEAD_SHA,
  baseStatus: Number.isFinite(baseStatus) ? baseStatus : 0,
  headStatus: Number.isFinite(headStatus) ? headStatus : 0,
  baseLogText: baseLog.text,
  headLogText: headLog.text,
  rounds,
  runUrl: values['run-url'] ?? env.RUN_URL,
});

if (commentPath) {
  writeFileSync(commentPath, comment);
  console.log(`perf comment written to ${commentPath}`);
} else {
  console.log(comment);
}

if (reportPath) {
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        base: {
          label: values['base-label'] ?? env.BASE_LABEL,
          sha: values['base-sha'] ?? env.BASE_SHA,
          status: baseStatus,
        },
        head: {
          label: values['head-label'] ?? env.HEAD_LABEL,
          sha: values['head-sha'] ?? env.HEAD_SHA,
          status: headStatus,
        },
        noisePercent: NOISE_PERCENT,
        rounds,
        metrics,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`perf report written to ${reportPath}`);
}

if (values.print) console.log(comment);

const measured = metrics.filter((metric) => metric.head !== null).length;
console.log(`parsed ${measured}/${METRICS.length} PR metrics`);
if (metrics.every((metric) => metric.head === null)) {
  console.log('::warning::no benchmark metrics found in the PR log');
  process.exitCode = 1;
}
