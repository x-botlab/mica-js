import type { PayloadType } from '../../format/type-name';

/** One endpoint a binding can reach; widget and device ports share this shape. */
export interface CanvasPortDescriptor {
  readonly direction: 'input' | 'output';
  readonly type: PayloadType;
}

/**
 * What the binding validator needs to know about widgets and the bound schematic.
 *
 * A host implements this over its widget registry and schematic model, so the validator itself
 * depends on neither package and never owns a document.
 */
export interface CanvasBindingCatalog {
  /** Widget definition for `"<package>:<widget>"`; `undefined` when unknown. */
  widgetDefinition(ref: string):
    | {
        readonly ports: Readonly<Record<string, CanvasPortDescriptor>>;
        readonly propertyKeys: readonly string[];
      }
    | undefined;
  /** True when the `.cnv` `schematic` path is loaded. */
  hasSchematic(path: string): boolean;
  /** True when the bound schematic contains this symbol id. */
  hasSymbol(symbolId: string): boolean;
  /** Device port declaration; `undefined` when the symbol has no such port. */
  symbolPort(symbolId: string, port: string): CanvasPortDescriptor | undefined;
}
