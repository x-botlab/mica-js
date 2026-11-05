import { describe, expect, it } from 'vitest';
import type { CanvasCommand } from './commands';
import { ID_A, applyCommand, makeDocument, makeInstance, rejectionCodes } from './test-helpers';

const COMMANDS: readonly CanvasCommand[] = [
  { type: 'add-instance', instance: makeInstance(), z: 0 },
  { type: 'remove-instance', instanceId: ID_A },
  {
    type: 'set-placement',
    instanceId: ID_A,
    placement: { x: 1, y: 2, width: 3, height: 4, rotation: 5 },
  },
  { type: 'set-z', instanceId: ID_A, z: 2 },
  { type: 'set-property', instanceId: ID_A, key: 'label', value: 'x' },
  { type: 'unset-property', instanceId: ID_A, key: 'image' },
  { type: 'set-binding', instanceId: ID_A, port: 'value', target: null },
  { type: 'set-schematic', schematic: null },
];

describe('applyCanvasCommand', () => {
  it('dispatches every command type and returns a fresh document', () => {
    const document = makeDocument();
    for (const command of COMMANDS) {
      const result = applyCommand(document, command);
      expect(result).not.toBe(document);
    }
  });

  it('rejects a command type from outside the contract', () => {
    const command = { type: 'rename-canvas' } as unknown as CanvasCommand;
    expect(rejectionCodes(makeDocument(), command)).toEqual(['edit/invalid-command']);
  });
});
