import type { DeliveryKind, PayloadType } from '@mica-js/core/canvas';

/** A widget implementation and the data that describes it. */
export interface WidgetModule {
  /** Ports and properties described by the widget definition. */
  readonly definition: WidgetDefinition;
  /** Widget implementation module source, passed through verbatim; the loader does not inspect it. */
  readonly code: string;
}

export interface WidgetDefinition {
  readonly properties: Readonly<Record<string, PropertyDefinition>>;
  readonly ports: Readonly<Record<string, PortDefinition>>;
  readonly displayName?: string;
  readonly description?: string;
}

/** Property descriptor from the shared descriptor contract (#7); fields pass through untouched. */
export interface PropertyDefinition {
  readonly type: string;
  readonly default?: unknown;
  readonly [key: string]: unknown;
}

export interface PortDefinition {
  readonly title?: string;
  readonly description?: string;
  readonly direction: 'input' | 'output';
  readonly type: PayloadType;
  /**
   * How publishes become deliveries (RFC 0017). Omitted means the payload type decides:
   * `boolean` / `number` / `vec2d` / `vec3d` are `level`, the text and byte payloads are `message`.
   * The field is orthogonal to `type`, so any combination is valid.
   */
  readonly delivery?: DeliveryKind;
}

export interface WidgetProvider {
  /** Resolves a module; an unknown reference returns `undefined`, a broken one throws. */
  resolve(ref: string): Promise<WidgetModule | undefined>;
}
