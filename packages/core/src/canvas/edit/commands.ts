import type { Diagnostic } from '../../format/diagnostics';
import { throwIfErrors } from '../../format/errors';
import type {
  CanvasBindingTarget,
  CanvasDocument,
  CanvasWidgetInstance,
  WidgetPlacement,
} from '../format/types';
import { setBinding, setSchematic } from './bindings';
import { addInstance, removeInstance, setPlacement, setZ } from './instances';
import { setProperty, unsetProperty } from './properties';

/**
 * One edit to a `.cnv` document. Every command describes document content only, so hosts can
 * journal them for undo and persistence.
 */
export type CanvasCommand =
  | { readonly type: 'add-instance'; readonly instance: CanvasWidgetInstance; readonly z: number }
  | { readonly type: 'remove-instance'; readonly instanceId: string }
  | {
      readonly type: 'set-placement';
      readonly instanceId: string;
      readonly placement: WidgetPlacement;
    }
  | { readonly type: 'set-z'; readonly instanceId: string; readonly z: number }
  | {
      readonly type: 'set-property';
      readonly instanceId: string;
      readonly key: string;
      readonly value: unknown;
    }
  | { readonly type: 'unset-property'; readonly instanceId: string; readonly key: string }
  | {
      readonly type: 'set-binding';
      readonly instanceId: string;
      readonly port: string;
      readonly target: CanvasBindingTarget | null;
    }
  | { readonly type: 'set-schematic'; readonly schematic: string | null };

/**
 * Applies one command to a copy of `document`.
 *
 * @throws {SchematicError} when the command is invalid; `diagnostics` carries every problem found
 * and the input document is never mutated.
 */
export function applyCanvasCommand(
  document: CanvasDocument,
  command: CanvasCommand,
): CanvasDocument {
  const diagnostics: Diagnostic[] = [];
  const result = dispatch(document, command, diagnostics);
  throwIfErrors(diagnostics);
  return result;
}

function dispatch(
  document: CanvasDocument,
  command: CanvasCommand,
  diagnostics: Diagnostic[],
): CanvasDocument {
  switch (command.type) {
    case 'add-instance':
      return addInstance(document, command.instance, command.z, diagnostics);
    case 'remove-instance':
      return removeInstance(document, command.instanceId, diagnostics);
    case 'set-placement':
      return setPlacement(document, command.instanceId, command.placement, diagnostics);
    case 'set-z':
      return setZ(document, command.instanceId, command.z, diagnostics);
    case 'set-property':
      return setProperty(document, command.instanceId, command.key, command.value, diagnostics);
    case 'unset-property':
      return unsetProperty(document, command.instanceId, command.key, diagnostics);
    case 'set-binding':
      return setBinding(document, command.instanceId, command.port, command.target, diagnostics);
    case 'set-schematic':
      return setSchematic(document, command.schematic, diagnostics);
    default: {
      diagnostics.push({
        severity: 'error',
        code: 'edit/invalid-command',
        message: `Unsupported canvas command ${JSON.stringify((command as { type?: unknown }).type)}.`,
      });
      return document;
    }
  }
}
