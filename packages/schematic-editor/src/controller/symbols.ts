import {
  SchematicError,
  designatorOf,
  hasDesignator,
  namesNet,
  netNameOf,
  parseDeviceReference,
  previewSymbolDrag,
  referenceAnchor,
  rotatePoint,
  symbolRole,
  type Point,
  type PropertyValue,
  type SchematicSymbol,
} from '@mica-js/core/schematic';
import type { EditorSession } from './session';
import { removeWire } from './wires';

/** Arms placement of `device`: the next canvas click inserts it and disarms again. */
export function placeDevice(session: EditorSession, device: string): void {
  if (parseDeviceReference(device) === undefined) {
    session.reject(
      new SchematicError([
        {
          severity: 'error',
          code: 'device/invalid-reference',
          message: `Invalid device reference ${JSON.stringify(device)}.`,
        },
      ]),
    );
  }
  session.placingDevice = device;
  session.tool = 'select';
  session.emit();
}

export function cancelPlacement(session: EditorSession): void {
  if (session.placingDevice === undefined) {
    return;
  }
  session.placingDevice = undefined;
  session.emit();
}

/** Reference designator the next placed component gets, per the host's policy. */
export function nextDesignator(session: EditorSession, device: string): string {
  return session.createDesignator(device, session.document);
}

export function moveSelectionBy(session: EditorSession, dx: number, dy: number): void {
  if (session.selection.length === 0 || (dx === 0 && dy === 0)) {
    return;
  }
  session.mutate(() => {
    for (const item of session.selection) {
      switch (item.kind) {
        case 'symbol': {
          const symbol = session.findSymbol(item.id);
          if (symbol !== undefined) {
            repositionSymbol(session, symbol, { ...symbol, x: symbol.x + dx, y: symbol.y + dy });
          }
          break;
        }
        case 'vertex': {
          const wire = session.findWire(item.wireId);
          const target = wire?.points[item.index];
          if (wire !== undefined && target !== undefined) {
            session.editor.dispatch({
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
          moveReferenceBy(session, item.symbolId, dx, dy);
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

export function rotateSelection(session: EditorSession, degrees: number): void {
  if (session.selection.length === 0 || degrees === 0) {
    return;
  }
  session.mutate(() => {
    for (const item of session.selection) {
      if (item.kind !== 'symbol') {
        continue;
      }
      const symbol = session.findSymbol(item.id);
      if (symbol === undefined) {
        continue;
      }
      repositionSymbol(session, symbol, {
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
  session: EditorSession,
  symbol: SchematicSymbol,
  next: SchematicSymbol,
): void {
  const document = session.document;
  const preview = previewSymbolDrag(document, session.devices, symbol.id, next);
  if (preview === undefined) {
    return;
  }
  session.overlay.markEdited(symbol.id);
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

  session.editor.replace({
    ...document,
    sheet: { ...document.sheet, symbols, wires, junctions },
  });
}

export function deleteSelection(session: EditorSession): void {
  if (session.selection.length === 0) {
    return;
  }
  session.mutate(() => {
    for (const item of session.selection) {
      switch (item.kind) {
        case 'symbol':
          session.editor.dispatch({ type: 'remove-symbol', id: item.id });
          break;
        case 'wire':
          removeWire(session, item.id);
          break;
        case 'junction':
          session.editor.dispatch({ type: 'remove-junction', id: item.id });
          break;
        case 'vertex': {
          const wire = session.findWire(item.wireId);
          if (wire === undefined) {
            break;
          }
          const points = wire.points.filter((_, index) => index !== item.index);
          if (points.length < 2) {
            removeWire(session, wire.id);
          } else {
            session.editor.dispatch({ type: 'set-wire-points', id: wire.id, points });
          }
          break;
        }
        default:
          break;
      }
    }
    session.selection = [];
  });
}

/** Moves a reference designator by a world-space delta; the offset is stored locally. */
export function moveReferenceBy(
  session: EditorSession,
  symbolId: string,
  dx: number,
  dy: number,
): void {
  const symbol = session.findSymbol(symbolId);
  if (symbol === undefined || (dx === 0 && dy === 0)) {
    return;
  }
  session.mutate(() => {
    const anchor = referenceAnchor(session.outlineOf(symbol), symbol.reference);
    // Offsets live in symbol-local space, so undo the rotation before moving.
    const local = rotatePoint({ x: dx, y: dy }, -symbol.rotation);
    session.editor.dispatch({
      type: 'update-symbol',
      id: symbol.id,
      reference: { x: anchor.x + local.x, y: anchor.y + local.y },
    });
  });
}

export function setSymbolProperty(
  session: EditorSession,
  symbolId: string,
  key: string,
  value: PropertyValue,
): void {
  session.mutate(() => {
    session.editor.dispatch({ type: 'set-symbol-property', id: symbolId, key, value });
  });
}

export function removeSymbolProperty(session: EditorSession, symbolId: string, key: string): void {
  session.mutate(() => {
    session.editor.dispatch({ type: 'remove-symbol-property', id: symbolId, key });
  });
}

/**
 * Sets a component's reference designator. The symbol id stays untouched, so selections and
 * `.view` layout keys keep pointing at the same element.
 */
export function renameDesignator(
  session: EditorSession,
  symbolId: string,
  nextDesignator: string,
): void {
  const trimmed = nextDesignator.trim();
  const symbol = session.requireSymbol(symbolId);
  const role = symbolRole(symbol.device);
  if (!hasDesignator(role)) {
    session.reject(
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
    session.reject(
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
  const duplicate = session.document.sheet.symbols.find(
    (candidate) => candidate.id !== symbolId && designatorOf(candidate) === trimmed,
  );
  if (duplicate !== undefined) {
    session.reject(
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
  session.mutate(() => {
    session.editor.dispatch({ type: 'update-symbol', id: symbolId, designator: trimmed });
  });
}

/**
 * Sets the net name of a label / power / ground symbol. Same-named ports are one net, so
 * duplicates are allowed.
 */
export function renameNet(session: EditorSession, symbolId: string, nextNet: string): void {
  const trimmed = nextNet.trim();
  const symbol = session.requireSymbol(symbolId);
  const role = symbolRole(symbol.device);
  if (!namesNet(role)) {
    session.reject(
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
    session.reject(
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
  session.mutate(() => {
    session.editor.dispatch({ type: 'update-symbol', id: symbolId, net: trimmed });
  });
}

function normalizeRotation(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

export type { Point };
