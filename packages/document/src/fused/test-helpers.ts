/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { FusedDocumentError } from './diagnostics';

export function catchError(run: () => unknown): FusedDocumentError {
  try {
    run();
  } catch (error) {
    if (error instanceof FusedDocumentError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a FusedDocumentError to be thrown');
}

export function codesOf(error: FusedDocumentError): readonly string[] {
  return error.diagnostics.map((diagnostic) => diagnostic.code);
}

export function pointersOf(error: FusedDocumentError): readonly string[] {
  return error.diagnostics.map((diagnostic) => diagnostic.pointer);
}

/** Reads a JSON example that ships with the RFCs. */
export function rfcExample(name: string): unknown {
  return JSON.parse(rfcExampleText(name)) as unknown;
}

/** Reads the source text of a JSON example that ships with the RFCs. */
export function rfcExampleText(name: string): string {
  const url = new URL(`../../../../docs/rfc/examples/${name}`, import.meta.url);
  return readFileSync(url, 'utf8');
}

export const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_INSTANCE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const NODE_ID = '22222222-2222-4222-8222-222222222222';
export const OTHER_NODE_ID = '77777777-7777-4777-8777-777777777777';

export const BUTTON_MANIFEST = {
  publisher: 'example',
  name: 'button',
  version: '1.0.0',
  engines: { mica: '^1.0.0' },
  displayName: '轻触开关',
  pins: { a1: { label: '1' }, a2: { label: '2' }, b1: { label: '3' }, b2: { label: '4' } },
  model: { entry: 'model.js' },
};

export const LABEL_MANIFEST = {
  publisher: 'example',
  name: 'label',
  version: '1.0.0',
  engines: { mica: '^1.0.0' },
  displayName: '标注',
};

export function instance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: INSTANCE_ID,
    device: 'example:button',
    designator: 'S1',
    placement: { x: 20, y: 15, rotation: 0 },
    ...overrides,
  };
}

export function documentValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    dependencies: {
      'example:button': {
        version: '1.0.0',
        integrity: `sha256:${'0'.repeat(64)}`,
      },
    },
    instances: [instance()],
    nodes: [],
    wires: [],
    labels: [],
    references: [],
    ...overrides,
  };
}
