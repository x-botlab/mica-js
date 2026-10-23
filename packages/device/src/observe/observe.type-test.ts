import type { FunctionBuilder, GeneratedFunctionBuilder } from '@mica-js/ir';
import type { DeviceAPI, ObserveConfig, ObserverRef, PinRef } from '../index';

declare const api: DeviceAPI;
const trigger: PinRef = api.ir.pin('IN');
const capture: PinRef = api.ir.pin('CAP');
const config: ObserveConfig = { enabled: true, edges: 'both' };

const onEdge = api.ir.entry('onEdge', ['u8', 'u32', 'u32']);
const observer: ObserverRef = api.ir.observeDigital('edge', {
  trigger,
  captures: [trigger, capture],
  target: onEdge,
});

const wrongTarget = api.ir.entry('wrongTarget', ['u8', 'u32', 'bool']);
api.ir.observeDigital('wrong', {
  trigger,
  captures: [trigger, capture],
  // @ts-expect-error captured pins are u32, not bool
  target: wrongTarget,
});

const shortTarget = api.ir.entry('shortTarget', ['u8', 'u32']);
api.ir.observeDigital('short', {
  trigger,
  captures: [trigger, capture],
  // @ts-expect-error one captured pin requires one extra u32
  target: shortTarget,
});

const empty = api.ir.entry('empty', ['u8']);
api.ir.observeDigital('empty', { trigger, captures: [], target: empty });

const lifecycle = api.ir.lifecycle('lifecycle', ['u8']);
api.ir.observeDigital('lifecycle', {
  trigger,
  captures: [],
  // @ts-expect-error observation targets must be ordinary entries
  target: lifecycle,
});

const run = api.ir.entry('run', []);
run.body((b) => {
  b.observe.configure(observer, config);
  const nested = b.block([]);
  b.at(nested, (inner) => {
    inner.observe.configure(observer, { enabled: false, edges: 'rising' });
    inner.return([]);
  });
  // @ts-expect-error edges is a closed string union
  b.observe.configure(observer, { enabled: true, edges: 'state' });
  b.return([]);
});

declare const builder: FunctionBuilder<readonly []>;
declare const generated: GeneratedFunctionBuilder<readonly []>;
generated.observe.configure(observer, config);
builder.observe.configure(observer, config);
void capture;
