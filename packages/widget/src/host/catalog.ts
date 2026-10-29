import { parsePayloadType } from '@mica-js/core/canvas';
import type { CanvasBindingCatalog, CanvasPortDescriptor } from '@mica-js/core/canvas';
import type { SchematicDocument } from '@mica-js/core/schematic';
import type { DeviceTopic } from '@mica-js/simulator';
import type { WidgetDefinition } from '../types';

/** What the binding validator needs to know about one widget definition. */
type CatalogWidgetDefinition = NonNullable<ReturnType<CanvasBindingCatalog['widgetDefinition']>>;

/** `symbol` + `port` pair as one map key; neither part can contain a NUL. */
function portKey(symbol: string, port: string): string {
  return `${symbol}\u0000${port}`;
}

/**
 * Catalog the host assembles itself (RFC 0018).
 *
 * Widget ports and properties come from the definitions `widgetProvider.resolve` returned, the
 * device side from `deviceHost.getTopics()` and the schematic the runtime loaded. A host with an
 * explicit `WidgetHostOptions.catalog` skips this one entirely.
 */
export class HostBindingCatalog implements CanvasBindingCatalog {
  readonly #definitions = new Map<string, CatalogWidgetDefinition>();
  #schematics = new Set<string>();
  #symbols = new Set<string>();
  #ports = new Map<string, CanvasPortDescriptor>();

  /** Whether the provider answered for `ref`; until it does, that widget stays unchecked. */
  knows(ref: string): boolean {
    return this.#definitions.has(ref);
  }

  /** Records one definition, so the synchronous validation no longer needs the provider. */
  recordDefinition(ref: string, definition: WidgetDefinition): void {
    this.#definitions.set(ref, {
      ports: definition.ports,
      propertyKeys: Object.keys(definition.properties),
    });
  }

  /**
   * Replaces the device side after a schematic load.
   *
   * `schematics` holds every path that identifies the loaded schematic (the reference the document
   * wrote and the absolute URI it resolved to); `topics` are the endpoints the running devices
   * report. A symbol the runtime does not report an endpoint for still counts as present when the
   * schematic lists it.
   */
  setDeviceFacts(options: {
    readonly schematics: readonly (string | undefined)[];
    readonly schematic: SchematicDocument | undefined;
    readonly topics: readonly DeviceTopic[];
  }): void {
    this.#schematics = new Set(
      options.schematics.filter((path): path is string => path !== undefined && path !== ''),
    );
    this.#symbols = new Set(options.schematic?.sheet.symbols.map((symbol) => symbol.id) ?? []);
    this.#ports = new Map();
    for (const topic of options.topics) {
      this.#symbols.add(topic.symbol);
      const type = parsePayloadType(topic.type);
      if (type === undefined) continue;
      this.#ports.set(portKey(topic.symbol, topic.port), {
        direction: topic.direction,
        type,
      });
    }
  }

  widgetDefinition(ref: string): CatalogWidgetDefinition | undefined {
    return this.#definitions.get(ref);
  }

  hasSchematic(path: string): boolean {
    return this.#schematics.has(path);
  }

  hasSymbol(symbolId: string): boolean {
    return this.#symbols.has(symbolId);
  }

  symbolPort(symbolId: string, port: string): CanvasPortDescriptor | undefined {
    return this.#ports.get(portKey(symbolId, port));
  }
}
