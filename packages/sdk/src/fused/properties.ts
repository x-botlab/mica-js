/**
 * Instance property resolution of the headless runtime (RFC 0020 / RFC 0026).
 *
 * Every declared property is resolved from the document override or the manifest default before a
 * model factory runs: resources become independent byte snapshots, firmware becomes a parsed
 * read-only image, and scalar values are checked against the descriptor constraints. The same
 * resolution feeds the board (IR-declared plain properties) and the model snapshot.
 */
import type {
  DevicePropertyDescriptor,
  FirmwareAddressSpace,
  FirmwareFileReference,
  FirmwareImage,
  FirmwareProjectReference,
  PropertyValue,
  ResourceReference,
} from '@mica-js/document/fused';
import type { ValueTypeIR } from '@mica-js/device-model';
import { PreparationError, problem } from './diagnostics.js';
import type { PreparationProblem } from './diagnostics.js';
import {
  binFirmwareImage,
  firmwareFormatOf,
  isDecodedFormat,
  readonlyBytes,
  type FirmwareFormat,
  type FirmwareProjectSource,
} from './firmware.js';
import { isPackagePath, type VerifiedPackage } from './package.js';

/** Property value handed to the simulator board; IR properties only. */
export type BoardPropertyValue = number | boolean | string | null | Uint8Array;

/** One external resource read the host must answer (RFC 0020 `file` and `store` modes). */
export interface ResourceRequest {
  readonly instanceId: string;
  readonly property: string;
  readonly reference: ResourceReference;
}

/** Explicit resolver of `file` and `store` property resources. */
export type ResourceResolver = (request: ResourceRequest) => Promise<Uint8Array>;

export interface PropertyResolution {
  /** Independent read-only snapshot handed to the model factory. */
  readonly props: Readonly<Record<string, unknown>>;
  /** IR-declared plain properties handed to the board. */
  readonly boardProps: Readonly<Record<string, BoardPropertyValue>>;
}

export interface PropertyResolutionInput {
  readonly instanceId: string;
  /** Device package the instance locks; `package` references resolve inside it. */
  readonly package: VerifiedPackage;
  readonly descriptors: Readonly<Record<string, DevicePropertyDescriptor>>;
  readonly overrides: Readonly<Record<string, PropertyValue>>;
  /** Property declarations of the model IR, keyed by name. */
  readonly irProperties: ReadonlyMap<string, ValueTypeIR>;
  readonly resolveResource?: ResourceResolver;
  readonly projects?: FirmwareProjectSource;
  /** JSON Pointer of the instance properties, used for preparational diagnostics. */
  readonly pointer: readonly string[];
}

/**
 * Resolves every declared property of one instance.
 *
 * @throws {PreparationError} listing every property that cannot be prepared.
 */
export async function resolveInstanceProperties(
  input: PropertyResolutionInput,
): Promise<PropertyResolution> {
  const problems: PreparationProblem[] = [];
  const props: Record<string, unknown> = {};
  // `binary` / `image` reach the model as read-only snapshots and the core as plain bytes.
  const boardBytes = new Map<string, Uint8Array>();
  const descriptors = input.descriptors;

  for (const key of Object.keys(input.overrides)) {
    if (!Object.hasOwn(descriptors, key)) {
      problems.push(
        problem(
          'schema/invalid-value',
          `Instance ${input.instanceId} sets the undeclared property "${key}".`,
          pointerOf(input.pointer, key),
        ),
      );
    }
  }

  for (const [name, descriptor] of Object.entries(descriptors)) {
    const pointer = pointerOf(input.pointer, name);
    const raw: PropertyValue | undefined = Object.hasOwn(input.overrides, name)
      ? input.overrides[name]
      : descriptor.default;
    if (raw === undefined) {
      problems.push(
        problem(
          'schema/missing-field',
          `Property "${name}" of ${input.instanceId} has neither a default nor an instance value.`,
          pointer,
        ),
      );
      continue;
    }
    if (raw === null) {
      if (descriptor.nullable !== true) {
        problems.push(
          problem(
            'schema/invalid-value',
            `Property "${name}" of ${input.instanceId} is not nullable.`,
            pointer,
          ),
        );
        continue;
      }
      props[name] = null;
      continue;
    }
    if (descriptor.type === 'firmware') {
      const image = await resolveFirmware(input, name, descriptor, raw, problems, pointer);
      if (image !== undefined) {
        props[name] = image;
      }
      continue;
    }
    if (descriptor.type === 'image' || descriptor.type === 'binary') {
      const bytes = await resolveBytes(input, name, descriptor, raw, problems, pointer);
      if (bytes !== undefined) {
        props[name] = readonlyBytes(bytes);
        boardBytes.set(name, bytes);
      }
      continue;
    }
    const scalar = checkScalar(descriptor, raw, problems, pointer, input.instanceId);
    if (scalar !== undefined) {
      props[name] = scalar;
    }
  }

  const boardProps: Record<string, BoardPropertyValue> = {};
  for (const [name, type] of input.irProperties) {
    const pointer = pointerOf(input.pointer, name);
    const descriptor = descriptors[name];
    if (descriptor === undefined) {
      problems.push(
        problem(
          'model/invalid-interface',
          `The model IR declares the property "${name}" but the manifest does not.`,
          pointer,
        ),
      );
      continue;
    }
    if (descriptor.type === 'firmware') {
      problems.push(
        problem(
          'model/invalid-interface',
          `Property "${name}" is a firmware property and must not be declared by the model IR.`,
          pointer,
        ),
      );
      continue;
    }
    const kind = type.kind === 'optional' ? type.inner.kind : type.kind;
    const optional = type.kind === 'optional';
    const compatible =
      (kind === 'number' && (descriptor.type === 'number' || descriptor.type === 'integer')) ||
      (kind === 'bool' && descriptor.type === 'boolean') ||
      (kind === 'string' && (descriptor.type === 'string' || descriptor.type === 'color')) ||
      (kind === 'enum' && descriptor.type === 'enum') ||
      (kind === 'bytes' && (descriptor.type === 'image' || descriptor.type === 'binary'));
    if (!compatible) {
      problems.push(
        problem(
          'model/invalid-interface',
          `Property "${name}" is ${descriptor.type} in the manifest but ${kind} in the model IR.`,
          pointer,
        ),
      );
      continue;
    }
    if (optional !== (descriptor.nullable === true)) {
      problems.push(
        problem(
          'model/invalid-interface',
          `Property "${name}" must be declared ${optional ? 'nullable' : 'non-nullable'} in the manifest.`,
          pointer,
        ),
      );
      continue;
    }
    if (!Object.hasOwn(props, name)) {
      continue;
    }
    const value = props[name];
    if (value === null) {
      boardProps[name] = value;
      continue;
    }
    if (kind === 'bytes') {
      const bytes = boardBytes.get(name);
      if (bytes === undefined) {
        problems.push(
          problem(
            'model/invalid-interface',
            `Property "${name}" is a byte property the manifest value does not provide.`,
            pointer,
          ),
        );
        continue;
      }
      boardProps[name] = bytes.slice();
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
      boardProps[name] = value;
      continue;
    }
    problems.push(
      problem(
        'model/invalid-interface',
        `Property "${name}" is not a plain value the core can consume.`,
        pointer,
      ),
    );
  }

  if (problems.length > 0) {
    throw new PreparationError(problems);
  }
  return {
    props: Object.freeze(props),
    boardProps: Object.freeze(boardProps),
  };
}

function pointerOf(base: readonly string[], key: string): string {
  const encoded = [...base, key].map((segment) => segment.replace(/~/g, '~0').replace(/\//g, '~1'));
  return `/${encoded.join('/')}`;
}

function checkScalar(
  descriptor: DevicePropertyDescriptor,
  raw: PropertyValue,
  problems: PreparationProblem[],
  pointer: string,
  instanceId: string,
): string | number | boolean | undefined {
  const reject = (expected: string): undefined => {
    problems.push(
      problem(
        'schema/invalid-value',
        `Property "${descriptor.type}" of ${instanceId} must be ${expected}.`,
        pointer,
      ),
    );
    return undefined;
  };
  switch (descriptor.type) {
    case 'string': {
      if (typeof raw !== 'string') {
        return reject('a string');
      }
      if (descriptor.maxLength !== undefined && [...raw].length > descriptor.maxLength) {
        return reject(`at most ${descriptor.maxLength} characters`);
      }
      return raw;
    }
    case 'color': {
      if (typeof raw !== 'string') {
        return reject('a color string');
      }
      // RFC 0009: `alpha` also accepts 6 digits, which the editor normalizes to `#RRGGBBAA`.
      const pattern =
        descriptor.alpha === true ? /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/ : /^#[0-9A-Fa-f]{6}$/;
      return pattern.test(raw)
        ? raw
        : reject(descriptor.alpha === true ? '#RRGGBB or #RRGGBBAA' : '#RRGGBB');
    }
    case 'integer': {
      if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
        return reject('a safe integer');
      }
      return inBounds(descriptor, raw) ?? reject(bounds(descriptor));
    }
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return reject('a finite number');
      }
      if (descriptor.exclusiveMin !== undefined && !(raw > descriptor.exclusiveMin)) {
        return reject(`greater than ${descriptor.exclusiveMin}`);
      }
      return inBounds(descriptor, raw) ?? reject(bounds(descriptor));
    }
    case 'boolean':
      return typeof raw === 'boolean' ? raw : reject('a boolean');
    case 'enum': {
      const options = descriptor.options ?? [];
      if (typeof raw !== 'string' || !options.some((option) => option.value === raw)) {
        return reject(
          options.length === 0
            ? 'one of the declared options'
            : `one of ${options.map((option) => JSON.stringify(option.value)).join(', ')}`,
        );
      }
      return raw;
    }
    default:
      return reject(descriptor.type);
  }
}

function inBounds(descriptor: DevicePropertyDescriptor, value: number): number | undefined {
  if (descriptor.min !== undefined && value < descriptor.min) {
    return undefined;
  }
  if (descriptor.max !== undefined && value > descriptor.max) {
    return undefined;
  }
  return value;
}

function bounds(descriptor: DevicePropertyDescriptor): string {
  const parts: string[] = [];
  if (descriptor.min !== undefined) {
    parts.push(`>= ${descriptor.min}`);
  }
  if (descriptor.max !== undefined) {
    parts.push(`<= ${descriptor.max}`);
  }
  return parts.length === 0 ? 'in range' : parts.join(' and ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isResourceReference(value: unknown): value is ResourceReference {
  return (
    isRecord(value) &&
    typeof value['src'] === 'string' &&
    typeof value['mode'] === 'string' &&
    ['file', 'package', 'inline', 'store'].includes(value['mode'])
  );
}

function isFirmwareReference(
  value: unknown,
): value is FirmwareFileReference | FirmwareProjectReference {
  if (!isRecord(value)) {
    return false;
  }
  const mode = value['mode'];
  if (mode === 'project') {
    return typeof value['projectId'] === 'string';
  }
  if (mode === 'file' || mode === 'package') {
    return typeof value['src'] === 'string';
  }
  return false;
}

function fileNameOf(src: string): string | undefined {
  const parts = src.split('/');
  return parts[parts.length - 1];
}

async function readResourceBytes(
  input: PropertyResolutionInput,
  name: string,
  descriptor: DevicePropertyDescriptor,
  reference: ResourceReference,
  problems: PreparationProblem[],
  pointer: string,
): Promise<Uint8Array | undefined> {
  const maxBytes = descriptor.maxBytes;
  const fail = (code: string, message: string): undefined => {
    problems.push(problem(code, message, pointer));
    return undefined;
  };
  let bytes: Uint8Array;
  switch (reference.mode) {
    case 'package': {
      if (!isPackagePath(reference.src)) {
        return fail(
          'package/invalid-path',
          `Property "${name}" references the non-normalized package path "${reference.src}".`,
        );
      }
      try {
        bytes = await input.package.read(reference.src, maxBytes);
      } catch (cause) {
        problems.push(...asProblems(cause, 'package/not-found'));
        return undefined;
      }
      break;
    }
    case 'inline': {
      try {
        bytes = decodeBase64(reference.src);
      } catch (cause) {
        return fail(
          'schema/invalid-value',
          `Property "${name}" is not valid base64: ${messageOf(cause)}`,
        );
      }
      break;
    }
    case 'file':
    case 'store': {
      const resolver = input.resolveResource;
      if (resolver === undefined) {
        return fail(
          'runtime/prepare-failed',
          `Property "${name}" uses a "${reference.mode}" resource but the runtime was created without a resolveResource function.`,
        );
      }
      let resolved: Uint8Array;
      try {
        resolved = await resolver({
          instanceId: input.instanceId,
          property: name,
          reference,
        });
      } catch (cause) {
        return fail(
          'package/not-found',
          `Property "${name}" could not read "${reference.src}": ${messageOf(cause)}`,
        );
      }
      if (!(resolved instanceof Uint8Array)) {
        return fail(
          'package/not-found',
          `The resolveResource function returned no bytes for property "${name}".`,
        );
      }
      bytes = resolved.slice();
      break;
    }
    default:
      return fail(
        'schema/invalid-value',
        `Property "${name}" uses the unknown resource mode "${String(reference.mode)}".`,
      );
  }
  if (maxBytes !== undefined && bytes.length > maxBytes) {
    return fail(
      'package/resource-limit',
      `Property "${name}" is ${bytes.length} bytes, above the declared limit of ${maxBytes}.`,
    );
  }
  return bytes.slice();
}

async function resolveBytes(
  input: PropertyResolutionInput,
  name: string,
  descriptor: DevicePropertyDescriptor,
  raw: PropertyValue,
  problems: PreparationProblem[],
  pointer: string,
): Promise<Uint8Array | undefined> {
  if (isResourceReference(raw)) {
    return readResourceBytes(input, name, descriptor, raw, problems, pointer);
  }
  problems.push(
    problem(
      'schema/invalid-type',
      `Property "${name}" of ${input.instanceId} must be a resource reference ({"src": ..., "mode": ...}).`,
      pointer,
    ),
  );
  return undefined;
}

async function resolveFirmware(
  input: PropertyResolutionInput,
  name: string,
  descriptor: DevicePropertyDescriptor,
  raw: PropertyValue,
  problems: PreparationProblem[],
  pointer: string,
): Promise<FirmwareImage | undefined> {
  const fail = (code: string, message: string): undefined => {
    problems.push(problem(code, message, pointer));
    return undefined;
  };
  if (!isFirmwareReference(raw)) {
    return fail(
      'schema/invalid-type',
      `Property "${name}" of ${input.instanceId} must be a firmware reference.`,
    );
  }
  const maxBytes = descriptor.maxBytes;
  const spaces = descriptor.addressSpaces ?? {};
  const formatOverride =
    raw.mode === 'project' ? undefined : firmwareFormatOf(fileNameOf(raw.src) ?? '');
  let bytes: Uint8Array | undefined;
  let format: FirmwareFormat | undefined = formatOverride;

  if (raw.mode === 'project') {
    const projects = input.projects;
    if (projects === undefined) {
      return fail(
        'runtime/prepare-failed',
        `Property "${name}" references project "${raw.projectId}" but the runtime was created without a firmware project source.`,
      );
    }
    let artifact: { format?: unknown; data?: unknown };
    try {
      artifact = await projects.resolve(raw.projectId);
    } catch (cause) {
      return fail(
        'firmware/project-resolve-failed',
        `Cannot resolve firmware project "${raw.projectId}": ${messageOf(cause)}`,
      );
    }
    if (artifact.format !== 'bin' && artifact.format !== 'hex' && artifact.format !== 'elf') {
      return fail(
        'firmware/project-resolve-failed',
        `Firmware project "${raw.projectId}" returned the unknown format ${JSON.stringify(artifact.format)}.`,
      );
    }
    if (!(artifact.data instanceof Uint8Array)) {
      return fail(
        'firmware/project-resolve-failed',
        `Firmware project "${raw.projectId}" returned no artifact bytes.`,
      );
    }
    format = artifact.format;
    bytes = artifact.data.slice();
  } else if (raw.mode === 'file' || raw.mode === 'package') {
    if (formatOverride === undefined) {
      return fail(
        'firmware/unknown-format',
        `Property "${name}" names "${raw.src}" whose extension is not a known firmware format.`,
      );
    }
    if (raw.mode === 'package' && !isPackagePath(raw.src)) {
      return fail(
        'package/invalid-path',
        `Property "${name}" references the non-normalized package path "${raw.src}".`,
      );
    }
    if (raw.mode === 'package') {
      try {
        bytes = await input.package.read(raw.src, maxBytes);
      } catch (cause) {
        problems.push(...asProblems(cause, 'package/not-found'));
        return undefined;
      }
    } else {
      const resolver = input.resolveResource;
      if (resolver === undefined) {
        return fail(
          'runtime/prepare-failed',
          `Property "${name}" uses a "file" firmware but the runtime was created without a resolveResource function.`,
        );
      }
      try {
        const resolved = await resolver({
          instanceId: input.instanceId,
          property: name,
          reference: { src: raw.src, mode: 'file' },
        });
        if (!(resolved instanceof Uint8Array)) {
          return fail(
            'package/not-found',
            `The resolveResource function returned no bytes for firmware "${raw.src}".`,
          );
        }
        bytes = resolved.slice();
      } catch (cause) {
        return fail(
          'package/not-found',
          `Firmware "${raw.src}" could not be read: ${messageOf(cause)}`,
        );
      }
    }
  } else {
    return fail(
      'firmware/unknown-format',
      `Property "${name}" uses "${String(raw.mode)}" firmware, which has no reliable file name.`,
    );
  }

  if (bytes === undefined || format === undefined) {
    return undefined;
  }
  if (maxBytes !== undefined && bytes.length > maxBytes) {
    return fail(
      'package/resource-limit',
      `Property "${name}" is ${bytes.length} bytes, above the declared limit of ${maxBytes}.`,
    );
  }

  const spaceId = raw.addressSpace ?? descriptor.addressSpace;
  const space: FirmwareAddressSpace | undefined =
    spaceId === undefined ? undefined : spaces[spaceId];
  if (spaceId === undefined || space === undefined) {
    return fail(
      'schema/invalid-value',
      `Property "${name}" selects the unknown address space ${JSON.stringify(spaceId)}.`,
    );
  }
  if (format !== 'bin' && raw.loadAddress !== undefined) {
    return fail(
      'schema/invalid-value',
      `Property "${name}" sets loadAddress, which only BIN firmware supports.`,
    );
  }
  if (format === 'elf' && raw.addressSpace !== undefined) {
    return fail(
      'schema/invalid-value',
      `Property "${name}" sets addressSpace, which ELF firmware does not support.`,
    );
  }
  if (!isDecodedFormat(format)) {
    return fail(
      'firmware/unsupported-format',
      `${format.toUpperCase()} firmware of property "${name}" is not decoded by this runtime yet; provide a BIN source.`,
    );
  }
  const address = raw.loadAddress ?? descriptor.loadAddress;
  if (address === undefined) {
    return fail(
      'firmware/out-of-range',
      `Property "${name}" has no load address for its BIN firmware.`,
    );
  }
  try {
    return binFirmwareImage(bytes, spaceId, space, address);
  } catch (cause) {
    return fail('firmware/out-of-range', `Property "${name}": ${messageOf(cause)}`);
  }
}

function asProblems(cause: unknown, fallbackCode: string): PreparationProblem[] {
  if (cause instanceof PreparationError) {
    return [...cause.problems];
  }
  return [problem(fallbackCode, messageOf(cause))];
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function decodeBase64(text: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new TypeError('not base64 text');
  }
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
