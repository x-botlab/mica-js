import {
  assertCanvasBindings,
  validateCanvasBindings,
  resolveDelivery,
  type CanvasBindingCatalog,
  type CanvasBindingTarget,
  type CanvasDocument,
  type CanvasPortDescriptor,
} from '@mica-js/document/canvas';
import { parseSchematic, type SchematicDocument } from '@mica-js/document/schematic';
import type { WidgetModule } from '@mica-js/widget';
import type {
  IDeviceDescription,
  IDeviceLibrary,
  IFileSystemProvider,
  IWidgetLibrary,
} from '../providers';

export interface ICanvasResources {
  readonly document: CanvasDocument;
  readonly schematic: SchematicDocument;
  readonly devices: readonly (IDeviceDescription & { readonly id: string })[];
  readonly widgets: ReadonlyMap<string, WidgetModule>;
  readonly assets: ReadonlyMap<string, Readonly<Record<string, Uint8Array>>>;
  readonly simulationAssets: Readonly<Record<string, Readonly<Record<string, Uint8Array>>>>;
}

const emptySchematic: SchematicDocument = {
  version: 1,
  sheet: { symbols: [], wires: [], junctions: [] },
};

export async function prepareCanvasResources(
  document: CanvasDocument,
  uri: string,
  files: IFileSystemProvider,
  deviceLibrary: IDeviceLibrary,
  widgetLibrary: IWidgetLibrary,
  projectRoot?: string,
): Promise<ICanvasResources> {
  const schematicUri =
    document.schematic === undefined
      ? undefined
      : new URL(document.schematic, projectRoot ?? uri).href;
  const schematic =
    schematicUri === undefined
      ? emptySchematic
      : parseSchematic(
          new TextDecoder('utf-8', { fatal: true }).decode(await files.read(schematicUri)),
        );
  const devices = await Promise.all(
    [...new Set(schematic.sheet.symbols.map((symbol) => symbol.device))]
      .filter((id) => !id.startsWith('builtin:'))
      .map(async (id) => {
        const value = await deviceLibrary.resolve(id);
        if (!value) throw new Error(`Device ${JSON.stringify(id)} was not found.`);
        return { id, ...value };
      }),
  );
  const widgets = new Map(
    await Promise.all(
      [...new Set(document.widgets.map((instance) => instance.widget))].map(async (id) => {
        const value = await widgetLibrary.resolve(id);
        if (!value) throw new Error(`Widget ${JSON.stringify(id)} was not found.`);
        return [id, value] as const;
      }),
    ),
  );
  const deviceMap = new Map(devices.map((device) => [device.id, device.definition]));
  const symbols = new Map(schematic.sheet.symbols.map((symbol) => [symbol.id, symbol]));
  assertCanvasBindings(document, {
    catalog: {
      widgetDefinition(id) {
        const definition = widgets.get(id)?.definition;
        return definition === undefined
          ? undefined
          : { ports: definition.ports, propertyKeys: Object.keys(definition.properties) };
      },
      hasSchematic: (path) => path === document.schematic && schematicUri !== undefined,
      hasSymbol: (id) => symbols.has(id),
      symbolPort(id, port): CanvasPortDescriptor | undefined {
        const symbol = symbols.get(id);
        const definition = symbol === undefined ? undefined : deviceMap.get(symbol.device);
        return definition?.ports?.[port];
      },
    },
  });
  const assets = new Map(
    await Promise.all(
      document.widgets.map(async (instance) => {
        const module = widgets.get(instance.widget)!;
        const props = {
          ...Object.fromEntries(
            Object.entries(module.definition.properties).map(([key, descriptor]) => [
              key,
              descriptor.default,
            ]),
          ),
          ...instance.properties,
        };
        return [instance.id, await prepareAssets(props, projectRoot ?? uri, files)] as const;
      }),
    ),
  );
  const simulationAssets = Object.fromEntries(
    await Promise.all(
      schematic.sheet.symbols.map(async (symbol) => {
        const definition = deviceMap.get(symbol.device);
        const props = {
          ...Object.fromEntries(
            Object.entries(definition?.properties ?? {}).map(([key, descriptor]) => [
              key,
              typeof descriptor === 'object' && descriptor !== null && 'default' in descriptor
                ? descriptor.default
                : undefined,
            ]),
          ),
          ...symbol.properties,
        };
        return [
          symbol.id,
          await prepareAssets(props, projectRoot ?? schematicUri ?? uri, files),
        ] as const;
      }),
    ),
  );
  const resources = { document, schematic, devices, widgets, assets, simulationAssets };
  for (const instance of document.widgets) {
    for (const [port, target] of Object.entries(instance.bindings ?? {})) {
      const reason = canvasBindingReason(resources, instance.id, port, target);
      if (reason !== undefined) throw new Error(reason);
    }
  }
  return resources;
}

export function canvasBindingCatalog(resources: ICanvasResources): CanvasBindingCatalog {
  return {
    widgetDefinition(id) {
      const definition = resources.widgets.get(id)?.definition;
      return (
        definition && { ports: definition.ports, propertyKeys: Object.keys(definition.properties) }
      );
    },
    hasSchematic: (path) => path === resources.document.schematic,
    hasSymbol: (id) => resources.schematic.sheet.symbols.some((symbol) => symbol.id === id),
    symbolPort(id, port) {
      const symbol = resources.schematic.sheet.symbols.find((symbol) => symbol.id === id);
      return resources.devices.find((device) => device.id === symbol?.device)?.definition.ports?.[
        port
      ];
    },
  };
}

/** Use the document validator for queries as well as writes; delivery is an additional host check. */
export function canvasBindingReason(
  resources: ICanvasResources,
  instanceId: string,
  port: string,
  target: CanvasBindingTarget,
): string | undefined {
  const instance = resources.document.widgets.find((item) => item.id === instanceId);
  if (!instance) throw new Error(`Unknown widget instance "${instanceId}".`);
  const catalog = canvasBindingCatalog(resources);
  const diagnostics = validateCanvasBindings(
    {
      ...resources.document,
      widgets: [{ ...instance, bindings: { [port]: target } }],
    },
    { catalog },
  );
  if (diagnostics.length) return diagnostics.map((item) => item.message).join(' ');
  const source = resources.widgets.get(instance.widget)?.definition.ports[port];
  const destination = catalog.symbolPort(target.symbol, target.port);
  if (
    source &&
    destination &&
    resolveDelivery(source.delivery, source.type) !==
      resolveDelivery(destination.delivery, destination.type)
  ) {
    return `Widget port "${port}" cannot bind to device port "${target.port}": delivery must match.`;
  }
  return undefined;
}

async function prepareAssets(
  properties: Readonly<Record<string, unknown>>,
  uri: string,
  files: IFileSystemProvider,
): Promise<Readonly<Record<string, Uint8Array>>> {
  const refs = new Map<string, { src: string; mode: string }>();
  for (const value of Object.values(properties)) {
    if (
      typeof value !== 'object' ||
      value === null ||
      !('src' in value) ||
      typeof value.src !== 'string' ||
      !('mode' in value) ||
      typeof value.mode !== 'string'
    )
      continue;
    refs.set(value.src, { src: value.src, mode: value.mode });
  }
  return Object.fromEntries(
    await Promise.all(
      [...refs.values()].map(async (ref) => {
        if (ref.mode === 'inline')
          return [ref.src, Uint8Array.from(atob(ref.src), (char) => char.charCodeAt(0))] as const;
        const bytes = await files.read(new URL(ref.src, uri).href);
        return [ref.src, bytes.slice()] as const;
      }),
    ),
  );
}
