import type { DeviceIR, OperationIR, RegionIR } from '@mica-js/sdk/model';
import { expect, it } from 'vitest';
import { inlineCalls } from '../src/inline';

const number = { kind: 'number' } as const;
const model: DeviceIR = {
  kind: 'device',
  name: 'InlineTest',
  declarations: [
    {
      kind: 'function',
      name: 'readValue',
      pure: true,
      params: [{ name: 'input', type: number }],
      returns: number,
      body: {
        operations: [
          { kind: 'parameter', index: 0, result: 0, type: number },
          { kind: 'returnValue', value: 0 },
        ],
      },
    },
  ],
};

it('总线函数只展开在原分支内，未改写的区域与元数据保持共享', () => {
  const retained: OperationIR = {
    kind: 'constant',
    result: 0,
    type: number,
    constant: { kind: 'number', value: 42 },
  };
  const cold: RegionIR = { operations: [{ kind: 'yield', value: 0 }] };
  expect(inlineCalls(cold, model)).toBe(cold);

  const yes: RegionIR = {
    operations: [
      {
        kind: 'callValue',
        name: 'readValue',
        pure: true,
        args: [{ kind: 'value', value: 0 }],
        result: 2,
        type: number,
      },
      { kind: 'yield', value: 2 },
    ],
  };
  const branch: OperationIR = {
    kind: 'select',
    condition: 1,
    result: 3,
    type: number,
    yes: { type: number, body: yes },
    no: { type: number, body: cold },
    source: { label: 'branch' },
  };
  const input: RegionIR = {
    operations: [
      retained,
      {
        kind: 'constant',
        result: 1,
        type: { kind: 'bool' },
        constant: { kind: 'bool', value: true },
      },
      branch,
    ],
  };
  const expanded = inlineCalls(input, model);
  expect(expanded.operations[0]).toBe(retained);
  const mapped = expanded.operations[2];
  if (mapped?.kind !== 'select') throw new Error('Missing select');
  expect(mapped.source).toBe(branch.source);
  expect(mapped.no).toBe(branch.no);
  expect(mapped.yes.body.operations).toEqual([
    { kind: 'constant', result: 4, type: number, constant: { kind: 'number', value: 0 } },
    { kind: 'local', local: 0, type: number, initial: 4 },
    { kind: 'localWrite', local: 0, value: 0 },
    { kind: 'localRead', local: 0, result: 2, type: number },
    { kind: 'yield', value: 2 },
  ]);
  expect(yes.operations[0]?.kind).toBe('callValue');
});
