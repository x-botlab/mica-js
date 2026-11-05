import type { ICanvasEditor, ISchematicEditor } from '@mica-js/editor';
import type { PropertyValue } from '@mica-js/document/schematic';

export type EditorSession =
  | { readonly kind: 'canvas'; readonly editor: ICanvasEditor }
  | { readonly kind: 'schematic'; readonly editor: ISchematicEditor };

export type HostTarget =
  | ReturnType<ICanvasEditor['getSelection']>[number]
  | ReturnType<ISchematicEditor['getSelection']>[number];

export function targetId(target: HostTarget): string {
  if ('id' in target) return target.id;
  if ('symbolId' in target) return target.symbolId;
  return target.wireId;
}

export function targetKey(target: HostTarget): string {
  return `${target.kind}:${targetId(target)}${'index' in target ? `:${target.index}` : 'pinId' in target ? `:${target.pinId}` : ''}`;
}

export function propertyValue(value: unknown): PropertyValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (
    typeof value === 'object' &&
    value !== null &&
    'src' in value &&
    'mode' in value &&
    typeof value.src === 'string' &&
    (value.mode === 'file' || value.mode === 'inline' || value.mode === 'store')
  ) {
    return { src: value.src, mode: value.mode };
  }
  throw new Error('属性值必须是有限数字、文本、布尔值、null 或资源引用。');
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
