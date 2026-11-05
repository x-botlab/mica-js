import { timePs } from '@mica-js/core';
import { compileDDL } from '@mica-js/ddl';
import { parseSchematic } from '@mica-js/document/schematic';
import type { DeviceMetadata } from '@mica-js/document/schematic';
import type { IPreparedSimulation, ISimulationMessage, SimulationModuleImporter } from './types';

export const SYMBOL = '11111111-1111-4111-8111-111111111111';
export const DEVICE = 'test:toggle';
export const PANEL = 'panel.png';
export const PANEL_BYTES = new TextEncoder().encode('PNG');

export const TOGGLE_MODEL = await compileDDL(`
device Toggle(panel: bytes, scale: number default 1) {
  pin out;
  input channel control: bool(capacity: 64);
  output channel lampValue: bool(capacity: 64);
  process start {
    loop {
      const value = await control.receive();
      lampValue.send(value);
    }
  }
}
`);

export const TOGGLE_CREATE = `
export function create(context) {
  if (!(context.props.panel instanceof Object) || context.props.panel.length === 0) {
    throw new Error('panel bytes missing');
  }
  let lamp = false;
  let pulseCount = 0;
  let frameLength = 0;
  const blob = new Uint8Array([1, 2, 3]);
  const subscription = context.topics.onDidReceive(({ topic, payload }) => {
    if (topic === 'lamp') context.inputs.control.send(payload);
    if (topic === 'pulse') pulseCount += 1;
    if (topic === 'frame') frameLength = payload.length;
  });
  return {
    sync(batch) {
      for (const output of batch.outputs.lampValue) lamp = output.value;
      context.topics.publish('state', lamp);
      context.topics.publish('pulseCount', pulseCount);
      context.topics.publish('frameLength', frameLength);
      context.topics.publish('echo', 'tick');
      context.topics.publish('blob', blob);
    },
    dispose() { subscription.dispose(); },
  };
}
`;
export const TOGGLE_CODE = `export const model = ${JSON.stringify(TOGGLE_MODEL)};\n${TOGGLE_CREATE}`;

export const DEFINITION: DeviceMetadata = {
  kind: 'device',
  id: 'toggle',
  version: '1.0.0',
  displayName: 'Toggle',
  designatorPrefix: 'K',
  pins: { out: {} },
  properties: { panel: { type: 'bytes', required: false, default: { src: PANEL, mode: 'file' } } },
  ports: {
    lamp: { direction: 'input', type: 'boolean', delivery: 'level' },
    pulse: { direction: 'input', type: 'string', delivery: 'message' },
    frame: { direction: 'input', type: 'bytes', delivery: 'message' },
    state: { direction: 'output', type: 'boolean', delivery: 'level' },
    pulseCount: { direction: 'output', type: 'number', delivery: 'level' },
    frameLength: { direction: 'output', type: 'number', delivery: 'level' },
    echo: { direction: 'output', type: 'string', delivery: 'message' },
    blob: { direction: 'output', type: 'bytes', delivery: 'message' },
  },
};

/** Node executes the exact self-contained ESM supplied to a browser guest. */
export const importer: SimulationModuleImporter = (code) =>
  import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(code)}`);

export function schematic(): ReturnType<typeof parseSchematic> {
  return parseSchematic({
    version: 1,
    sheet: {
      symbols: [{ id: SYMBOL, device: DEVICE, designator: 'K1', x: 0, y: 0, rotation: 0 }],
      wires: [],
      junctions: [],
    },
  });
}

export function toggleSimulation(
  assets: IPreparedSimulation['assets'] = { [SYMBOL]: { [PANEL]: PANEL_BYTES } },
): IPreparedSimulation {
  return {
    schematic: schematic(),
    devices: [{ id: DEVICE, definition: DEFINITION, code: TOGGLE_CODE }],
    ...(assets === undefined ? {} : { assets }),
  };
}

export function message(symbol: string, port: string, payload: unknown): ISimulationMessage {
  return { target: { symbol, port }, payload, simTime: timePs(0) };
}
