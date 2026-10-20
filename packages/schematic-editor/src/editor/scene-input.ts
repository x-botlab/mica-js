import type { Point } from '@mica/core/schematic';
import type { EditorSelection } from '../controller/types';

export interface SceneHighlight {
  readonly symbols: ReadonlySet<string>;
  readonly wires: ReadonlySet<string>;
  readonly junctions: ReadonlySet<string>;
  readonly vertices: readonly { readonly wireId: string; readonly index: number }[];
}

/** Translates controller selections into the flat sets the scene builder expects. */
export function toSceneHighlight(selection: readonly EditorSelection[]): SceneHighlight {
  const symbols = new Set<string>();
  const wires = new Set<string>();
  const junctions = new Set<string>();
  const vertices: { wireId: string; index: number }[] = [];
  for (const item of selection) {
    switch (item.kind) {
      case 'symbol':
        symbols.add(item.id);
        break;
      case 'wire':
        wires.add(item.id);
        break;
      case 'junction':
        junctions.add(item.id);
        break;
      case 'vertex':
        wires.add(item.wireId);
        vertices.push({ wireId: item.wireId, index: item.index });
        break;
      default:
        break;
    }
  }
  return { symbols, wires, junctions, vertices };
}

/** Appends the cursor to a pending wire so it rubber-bands to the pointer. */
export function withCursor(pending: readonly Point[], cursor: Point | undefined): readonly Point[] {
  return cursor === undefined ? pending : [...pending, cursor];
}
