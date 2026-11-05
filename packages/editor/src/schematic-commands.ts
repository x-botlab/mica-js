import type { Point, PropertyValue, SchematicCommand } from '@mica-js/document/schematic';
import type { IEditorCommand } from './host';
import type { EditorTool } from './schematic/types';

type AddDevice = Omit<Extract<SchematicCommand, { type: 'add-symbol' }>, 'type' | 'device'> & {
  readonly deviceId: string;
};
type UpdateDevice = Omit<
  Extract<SchematicCommand, { type: 'update-symbol' }>,
  'type' | 'id' | 'device'
> & {
  readonly symbolId: string;
  readonly deviceId?: string;
};

/** Semantic host operations. Document editing commands remain implementation details. */
export interface ISchematicCommandMap {
  readonly 'schematic.setProperty': IEditorCommand<{
    readonly symbolId: string;
    readonly key: string;
    readonly value: PropertyValue;
  }>;
  readonly 'schematic.removeProperty': IEditorCommand<{
    readonly symbolId: string;
    readonly key: string;
  }>;
  /** Removed keys are separate so that null remains a property value. Removals run first. */
  readonly 'schematic.setProperties': IEditorCommand<{
    readonly symbolId: string;
    readonly values: Readonly<Record<string, PropertyValue>>;
    readonly remove?: readonly string[];
  }>;
  readonly 'schematic.addDevice': IEditorCommand<AddDevice, string>;
  readonly 'schematic.removeDevice': IEditorCommand<{ readonly symbolId: string }>;
  readonly 'schematic.updateDevice': IEditorCommand<UpdateDevice>;
  readonly 'schematic.addWire': IEditorCommand<
    { readonly id?: string; readonly points: readonly Point[] },
    string
  >;
  readonly 'schematic.removeWire': IEditorCommand<{ readonly wireId: string }>;
  readonly 'schematic.setWirePoints': IEditorCommand<{
    readonly wireId: string;
    readonly points: readonly Point[];
  }>;
  readonly 'schematic.deleteSelection': IEditorCommand;
  readonly 'schematic.moveSelection': IEditorCommand<{ readonly dx: number; readonly dy: number }>;
  readonly 'schematic.rotateSelection': IEditorCommand<{ readonly degrees: number }>;
  readonly 'schematic.placeDevice': IEditorCommand<{ readonly deviceId: string }>;
  readonly 'schematic.undo': IEditorCommand;
  readonly 'schematic.redo': IEditorCommand;
  readonly 'schematic.setTool': IEditorCommand<{ readonly tool: EditorTool }>;
  readonly 'schematic.zoom': IEditorCommand<{ readonly scale: number }>;
  readonly 'schematic.fit': IEditorCommand;
  readonly 'schematic.resetView': IEditorCommand;
}
