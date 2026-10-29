import {
  SchematicError,
  designatorOf,
  hasDesignator,
  namesNet,
  netNameOf,
  previewSymbolDrag,
  referenceAnchor,
  rotatePoint,
  symbolRole,
  type PropertyValue,
  type SchematicSymbol,
} from '@mica-js/core/schematic';
import type { SchematicTarget } from '../types';
import type { DocumentStore } from './store';
import { removeWire } from './wires';

/** Reference designator the next placed component gets, per the host's policy. */
export function nextDesignator(store: DocumentStore, device: string): string {
  return store.createDesignator(device, store.document);
}

export function moveTargets(
  store: DocumentStore,
  targets: readonly SchematicTarget[],
  dx: number,
  dy: number,
): void {
  if (targets.length === 0 || (dx === 0 && dy === 0)) {
    return;
  }
  store.mutate(() => {
    for (const item of targets) {
      switch (item.kind) {
        case 'symbol': {
          const symbol = store.findSymbol(item.id);
          if (symbol !== undefined) {
            repositionSymbol(store, symbol, { ...symbol, x: symbol.x + dx, y: symbol.y + dy });
          }
          break;
        }
        case 'vertex': {
          const wire = store.findWire(item.wireId);
          const target = wire?.points[item.index];
          if (wire !== undefined && target !== undefined) {
            store.editor.dispatch({
              type: 'set-wire-points',
              id: wire.id,
              points: wire.points.map((point, index) =>
                index === item.index ? { x: point.x + dx, y: point.y + dy } : point,
              ),
            });
          }
          break;
        }
        case 'reference':
          moveReferenceBy(store, item.symbolId, dx, dy);
          break;
        case 'junction':
          // Junctions are derived from wire geometry; moving one would break orthogonality.
          break;
        default:
          break;
      }
    }
  });
}

export function rotateTargets(
  store: DocumentStore,
  targets: readonly SchematicTarget[],
  degrees: number,
): void {
  if (targets.length === 0 || degrees === 0) {
    return;
  }
  store.mutate(() => {
    for (const item of targets) {
      if (item.kind !== 'symbol') {
        continue;
      }
      const symbol = store.findSymbol(item.id);
      if (symbol === undefined) {
        continue;
      }
      repositionSymbol(store, symbol, {
        ...symbol,
        rotation: normalizeRotation(symbol.rotation + degrees),
      });
    }
  });
}

/**
 * Replaces a symbol's placement and drags everything anchored to its pins: wire ends keep
 * orthogonal routing, junctions and attached builtin anchors follow.
 */
export function repositionSymbol(
  store: DocumentStore,
  symbol: SchematicSymbol,
  next: SchematicSymbol,
): void {
  const document = store.document;
  const preview = previewSymbolDrag(document, store.devices, symbol.id, next);
  if (preview === undefined) {
    return;
  }
  const symbols = document.sheet.symbols.map((item) => {
    if (item.id === symbol.id) {
      return next;
    }
    const target = preview.symbols.get(item.id);
    return target === undefined ? item : { ...item, x: target.x, y: target.y };
  });
  const wires = document.sheet.wires.map((wire) => {
    const points = preview.wires.get(wire.id);
    return points === undefined ? wire : { ...wire, points };
  });
  const junctions = document.sheet.junctions.map((junction) => {
    const target = preview.junctions.get(junction.id);
    return target === undefined ? junction : { ...junction, x: target.x, y: target.y };
  });

  store.editor.replace({
    ...document,
    sheet: { ...document.sheet, symbols, wires, junctions },
  });
}

export function removeTargets(store: DocumentStore, targets: readonly SchematicTarget[]): void {
  if (targets.length === 0) {
    return;
  }
  store.mutate(() => {
    for (const item of targets) {
      switch (item.kind) {
        case 'symbol':
          store.editor.dispatch({ type: 'remove-symbol', id: item.id });
          break;
        case 'wire':
          removeWire(store, item.id);
          break;
        case 'junction':
          // Removing a wire already drops junctions it leaves with fewer than two wires, so a
          // rubber-band selection around a T connection contains junction ids that are gone.
          if (store.document.sheet.junctions.some((junction) => junction.id === item.id)) {
            store.editor.dispatch({ type: 'remove-junction', id: item.id });
          }
          break;
        case 'vertex': {
          const wire = store.findWire(item.wireId);
          if (wire === undefined) {
            break;
          }
          const points = wire.points.filter((_, index) => index !== item.index);
          if (points.length < 2) {
            removeWire(store, wire.id);
          } else {
            store.editor.dispatch({ type: 'set-wire-points', id: wire.id, points });
          }
          break;
        }
        default:
          break;
      }
    }
  });
}

/** Moves a reference designator by a world-space delta; the offset is stored locally. */
export function moveReferenceBy(
  store: DocumentStore,
  symbolId: string,
  dx: number,
  dy: number,
): void {
  const symbol = store.findSymbol(symbolId);
  if (symbol === undefined || (dx === 0 && dy === 0)) {
    return;
  }
  store.mutate(() => {
    const anchor = referenceAnchor(store.outlineOf(symbol), symbol.reference);
    // Offsets live in symbol-local space, so undo the rotation before moving.
    const local = rotatePoint({ x: dx, y: dy }, -symbol.rotation);
    store.editor.dispatch({
      type: 'update-symbol',
      id: symbol.id,
      reference: { x: anchor.x + local.x, y: anchor.y + local.y },
    });
  });
}

export function setSymbolProperty(
  store: DocumentStore,
  symbolId: string,
  key: string,
  value: PropertyValue,
): void {
  store.mutate(() => {
    store.editor.dispatch({ type: 'set-symbol-property', id: symbolId, key, value });
  });
}

export function removeSymbolProperty(store: DocumentStore, symbolId: string, key: string): void {
  store.mutate(() => {
    store.editor.dispatch({ type: 'remove-symbol-property', id: symbolId, key });
  });
}

/**
 * Sets a component's reference designator. The symbol id stays untouched, so selections and
 * stable ids keep references pointing at the same element.
 */
export function renameDesignator(
  store: DocumentStore,
  symbolId: string,
  nextDesignator: string,
): void {
  const trimmed = nextDesignator.trim();
  const symbol = store.requireSymbol(symbolId);
  const role = symbolRole(symbol.device);
  if (!hasDesignator(role)) {
    store.reject(
      new SchematicError([
        {
          severity: 'error',
          code: 'symbol/unsupported-field',
          message: `Symbols of role "${role}" carry no reference designator.`,
          entity: { kind: 'symbol', id: symbolId },
        },
      ]),
    );
  }
  if (trimmed.length === 0) {
    store.reject(
      new SchematicError([
        {
          severity: 'error',
          code: 'schema/invalid-value',
          message: 'Reference designator must not be empty.',
        },
      ]),
    );
  }
  if (trimmed === designatorOf(symbol)) {
    return;
  }
  const duplicate = store.document.sheet.symbols.find(
    (candidate) => candidate.id !== symbolId && designatorOf(candidate) === trimmed,
  );
  if (duplicate !== undefined) {
    store.reject(
      new SchematicError([
        {
          severity: 'error',
          code: 'symbol/designator-duplicate',
          message: `Reference designator ${JSON.stringify(trimmed)} is already used.`,
          entity: { kind: 'symbol', id: duplicate.id },
        },
      ]),
    );
  }
  store.mutate(() => {
    store.editor.dispatch({ type: 'update-symbol', id: symbolId, designator: trimmed });
  });
}

/**
 * Sets the net name of a label / power / ground symbol. Same-named ports are one net, so
 * duplicates are allowed.
 */
export function renameNet(store: DocumentStore, symbolId: string, nextNet: string): void {
  const trimmed = nextNet.trim();
  const symbol = store.requireSymbol(symbolId);
  const role = symbolRole(symbol.device);
  if (!namesNet(role)) {
    store.reject(
      new SchematicError([
        {
          severity: 'error',
          code: 'symbol/unsupported-field',
          message: `Symbols of role "${role}" name no net.`,
          entity: { kind: 'symbol', id: symbolId },
        },
      ]),
    );
  }
  if (trimmed.length === 0) {
    store.reject(
      new SchematicError([
        {
          severity: 'error',
          code: 'schema/invalid-value',
          message: 'Net name must not be empty.',
        },
      ]),
    );
  }
  if (trimmed === netNameOf(symbol)) {
    return;
  }
  store.mutate(() => {
    store.editor.dispatch({ type: 'update-symbol', id: symbolId, net: trimmed });
  });
}

function normalizeRotation(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}
