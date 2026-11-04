import { validateDeviceIR, type DeviceIR, type ValueTypeIR } from '@mica-js/device-model';

export interface DeviceTypeScriptOptions {
  /** Public SDK device subpath used by the generated type-only imports. */
  readonly deviceModule?: string;
  /** Prefix for generated public interfaces; defaults to the device name. */
  readonly name?: string;
}

/** Generates a type-only ESM module describing the JavaScript device boundary. */
export function generateDeviceTypeScript(
  input: DeviceIR,
  options: DeviceTypeScriptOptions = {},
): string {
  const model = validateDeviceIR(input);
  const prefix = options.name ?? model.name;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix))
    throw new TypeError('The projection name must be an ASCII TypeScript identifier.');
  const quote = (value: string) => JSON.stringify(value);
  const named = new Map(
    model.declarations
      .filter((decl) => decl.kind === 'record' || decl.kind === 'enum')
      .map((decl) => [decl.name, `${prefix}_${decl.name}`]),
  );
  const type = (value: ValueTypeIR, inputBytes = false): string => {
    switch (value.kind) {
      case 'number':
      case 'string':
        return value.kind;
      case 'bool':
        return 'boolean';
      case 'bytes':
        return inputBytes ? 'Uint8Array' : 'ReadonlyBytes';
      case 'optional':
        return `${type(value.inner, inputBytes)} | null`;
      case 'enum':
        return (
          named.get(value.name) ??
          (value.name === 'Logic'
            ? '"low" | "high" | "unknown"'
            : value.name === 'SampleStatus'
              ? '"valid" | "floating"'
              : '"drop_new" | "drop_oldest" | "error"')
        );
      case 'record':
        return named.get(value.name)!;
      default:
        throw new TypeError(
          `Type '${value.kind}' cannot be projected through the device JavaScript boundary.`,
        );
    }
  };
  const lines = [
    `import type { BorrowedBytes, ChannelMessage, DeviceAdapter, DeviceBatch, DeviceContext, DeviceFactory, InputChannel, InputNotification, Notification, ReadonlyBytes } from ${quote(options.deviceModule ?? '@mica-js/simulator/device')};`,
    '',
  ];
  for (const decl of model.declarations) {
    if (decl.kind === 'enum')
      lines.push(
        `export type ${named.get(decl.name)} = ${decl.members.map(quote).join(' | ')};`,
        '',
      );
    if (decl.kind === 'record') {
      lines.push(`export interface ${named.get(decl.name)} {`);
      for (const field of decl.fields)
        lines.push(
          `  readonly ${quote(field.name)}: ${field.type === 'bool' ? 'boolean' : 'number'};`,
        );
      lines.push('}', '');
    }
  }
  lines.push(`export interface ${prefix}Props {`);
  for (const decl of model.declarations)
    if (decl.kind === 'property') lines.push(`  readonly ${quote(decl.name)}: ${type(decl.type)};`);
  lines.push('}', '', `export interface ${prefix}PropertyInput {`);
  for (const decl of model.declarations)
    if (decl.kind === 'property')
      lines.push(
        `  readonly ${quote(decl.name)}${decl.default ? '?' : ''}: ${type(decl.type, true)};`,
      );
  lines.push('}', '', `export interface ${prefix}Inputs {`);
  for (const decl of model.declarations) {
    if (decl.kind === 'channel' && decl.direction === 'input')
      lines.push(`  readonly ${quote(decl.name)}: InputChannel<${type(decl.type, true)}>;`);
    if (decl.kind === 'notification' && decl.direction === 'input')
      lines.push(`  readonly ${quote(decl.name)}: InputNotification;`);
  }
  lines.push('}', '', `export interface ${prefix}Memory {`);
  for (const decl of model.declarations)
    if (decl.kind === 'memory' && decl.public)
      lines.push(`  readonly ${quote(decl.name)}: BorrowedBytes;`);
  lines.push('}', '', `export interface ${prefix}Outputs {`);
  for (const decl of model.declarations) {
    if (decl.kind === 'channel' && decl.direction === 'output')
      lines.push(`  readonly ${quote(decl.name)}: readonly ChannelMessage<${type(decl.type)}>[];`);
    if (decl.kind === 'notification' && decl.direction === 'output')
      lines.push(`  readonly ${quote(decl.name)}: Notification | null;`);
  }
  lines.push(
    '}',
    '',
    `export type ${prefix}Context = DeviceContext<${prefix}Props, ${prefix}Inputs, ${prefix}Memory>;`,
    `export type ${prefix}Batch = DeviceBatch<${prefix}Outputs>;`,
    `export type ${prefix}Adapter = DeviceAdapter<${prefix}Batch>;`,
    `export type ${prefix}Factory = DeviceFactory<${prefix}Context, ${prefix}Batch>;`,
    '',
  );
  return lines.join('\n');
}

export const generateDeviceTypes = generateDeviceTypeScript;
