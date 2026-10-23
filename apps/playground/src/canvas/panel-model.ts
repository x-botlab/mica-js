import type { CanvasBindingTarget, CanvasWidgetInstance, PayloadType } from '@mica-js/core/canvas';
import type { PortDefinition, PropertyDefinition } from '@mica-js/widget';

export interface DemoTarget {
  readonly symbol: string;
  readonly port: string;
  readonly direction: 'input' | 'output';
  readonly type: PayloadType;
}

/**
 * Endpoints the playground can offer. A real host would read these from the bound schematic; the
 * demo has no schematic, and `createWidgetHost` skips reference checks without a catalog.
 */
export const DEMO_TARGETS = [
  { symbol: 'demo-mcu', port: 'display', direction: 'output', type: 'string' },
  { symbol: 'demo-mcu', port: 'display2', direction: 'output', type: 'string' },
  { symbol: 'demo-mcu', port: 'key', direction: 'input', type: 'boolean' },
  { symbol: 'demo-mcu', port: 'led', direction: 'input', type: 'boolean' },
] as const satisfies readonly DemoTarget[];

export interface TargetOption {
  /** `<symbol>:<port>`; the empty string is the "unbound" choice. */
  readonly value: string;
  readonly label: string;
  /** True when the document binds an endpoint the candidate list does not offer. */
  readonly current: boolean;
}

/**
 * Targets one port can bind: the direction must be complementary (a widget input reads what the
 * schematic outputs) and the payload type must match exactly, because payload types are nominal.
 */
export function compatibleTargets(port: PortDefinition): readonly DemoTarget[] {
  const wanted = port.direction === 'input' ? 'output' : 'input';
  return DEMO_TARGETS.filter((target) => target.direction === wanted && target.type === port.type);
}

export function targetValue(target: CanvasBindingTarget): string {
  return `${target.symbol}:${target.port}`;
}

export function parseTargetValue(value: string): CanvasBindingTarget | undefined {
  const index = value.indexOf(':');
  if (index <= 0 || index === value.length - 1) {
    return undefined;
  }
  return { symbol: value.slice(0, index), port: value.slice(index + 1) };
}

export function describeTarget(target: CanvasBindingTarget): string {
  return `${target.symbol}.${target.port}`;
}

/** Binding the document currently declares for `port`, if any. */
export function bindingTargetOf(
  instance: CanvasWidgetInstance | undefined,
  portKey: string,
): CanvasBindingTarget | undefined {
  return instance?.bindings?.[portKey];
}

/**
 * Choices for one port's `<select>`: "unbound" first, then every compatible candidate. A binding
 * the candidate list does not know (a placeholder endpoint in the `.cnv`, say) is appended with a
 * "current" label, so an existing binding never renders as blank.
 */
export function bindingOptions(
  instance: CanvasWidgetInstance | undefined,
  portKey: string,
  port: PortDefinition,
): readonly TargetOption[] {
  const candidates = compatibleTargets(port);
  const options: TargetOption[] = [{ value: '', label: '未绑定', current: false }];
  for (const target of candidates) {
    options.push({
      value: targetValue(target),
      label: `${describeTarget(target)} · ${target.direction} · ${target.type}`,
      current: false,
    });
  }

  const current = bindingTargetOf(instance, portKey);
  if (
    current !== undefined &&
    !candidates.some((target) => targetValue(target) === targetValue(current))
  ) {
    options.push({
      value: targetValue(current),
      label: `${describeTarget(current)} · 当前`,
      current: true,
    });
  }
  return options;
}

/** Value a property editor starts from: the document override, else the definition default. */
export function propertyInitialValue(
  instance: CanvasWidgetInstance | undefined,
  propertyKey: string,
  descriptor: PropertyDefinition | undefined,
): unknown {
  const properties = instance?.properties;
  return properties !== undefined && Object.hasOwn(properties, propertyKey)
    ? properties[propertyKey]
    : descriptor?.default;
}

/** Whether the document sets this property explicitly, rather than relying on its default. */
export function isPropertyOverridden(
  instance: CanvasWidgetInstance | undefined,
  propertyKey: string,
): boolean {
  return instance?.properties !== undefined && Object.hasOwn(instance.properties, propertyKey);
}

/** The `{ src, mode }` value of an `image` / `binary` property, or `undefined` when malformed. */
export function assetRefOf(
  value: unknown,
): { readonly src: string; readonly mode: 'file' | 'inline' | 'store' } | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as { src?: unknown; mode?: unknown };
  if (typeof candidate.src !== 'string') {
    return undefined;
  }
  if (candidate.mode !== 'file' && candidate.mode !== 'inline' && candidate.mode !== 'store') {
    return undefined;
  }
  return { src: candidate.src, mode: candidate.mode };
}

/**
 * Messages a rejected command should show: every error-level diagnostic of a `SchematicError`,
 * otherwise the exception's own message. `SchematicError` is duck-typed here so the panel model
 * stays independent of the core package at runtime.
 */
export function commandErrorMessages(error: unknown): readonly string[] {
  if (typeof error === 'object' && error !== null) {
    const diagnostics = (error as { diagnostics?: unknown }).diagnostics;
    if (Array.isArray(diagnostics)) {
      const messages = diagnostics
        .filter(
          (diagnostic): diagnostic is { severity: string; message: string } =>
            typeof diagnostic === 'object' &&
            diagnostic !== null &&
            typeof (diagnostic as { message?: unknown }).message === 'string',
        )
        .filter((diagnostic) => diagnostic.severity === 'error')
        .map((diagnostic) => diagnostic.message);
      if (messages.length > 0) {
        return messages;
      }
    }
  }
  return error instanceof Error ? [error.message] : [String(error)];
}
