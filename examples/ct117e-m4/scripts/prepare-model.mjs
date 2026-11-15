import { readFile, writeFile } from 'node:fs/promises';
import { compileDDL } from '@mica-js/sdk/ddl';

// Only functions and their constants are needed by the local BlockIR expander. The SDK
// independently compiles the full model.ddl into the artifact's exported device model.
const directory = new URL('../src/devices/ct117e-m4/', import.meta.url);
const model = await compileDDL(await readFile(new URL('model.ddl', directory), 'utf8'), {
  uri: 'mica:devices/ct117e-m4/model.ddl',
});
const hot = {
  ...model,
  declarations: model.declarations.filter((entry) => ['function', 'const'].includes(entry.kind)),
};

function expression(value) {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    return Object.is(value, -0) ? '-0' : String(value);
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (value instanceof Uint8Array) return `new Uint8Array(${expression([...value])})`;
  if (Array.isArray(value)) return `[${value.map(expression).join(',')}]`;
  if (typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([key]) => key !== 'source')
      .map(([key, item]) => `${JSON.stringify(key)}:${expression(item)}`)
      .join(',')}}`;
  throw new TypeError(`Unsupported IR value: ${typeof value}`);
}

const output = `// Generated from model.ddl by scripts/prepare-model.mjs; do not edit.\nimport type { DeviceIR } from '@mica-js/sdk/model';\nconst model: DeviceIR = ${expression(hot)};\nexport default model;\n`;
const target = new URL('hot-model.ts', directory);
if ((await readFile(target, 'utf8').catch(() => undefined)) !== output)
  await writeFile(target, output);
