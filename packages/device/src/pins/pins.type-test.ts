import type { FunctionBuilder, GeneratedFunctionBuilder, Value } from '@mica-js/ir';
import type { DeviceAPI, PinConfig, PinRef } from '../index';

declare const api: DeviceAPI;
const pin: PinRef = api.ir.pin('OUT');
const config: PinConfig = { mode: 'push-pull', outputEnabled: true, pull: 'none' };

const entry = api.ir.entry('run', ['bool']);
entry.body((b, [on]) => {
  b.pin.writeDigital(pin, on);
  b.pin.configure(pin, config);
  const sample: Value<'u32'> = b.pin.sampleDigital(pin);
  void sample;
  b.return([]);
});

declare const builder: FunctionBuilder<readonly []>;
declare const generated: GeneratedFunctionBuilder<readonly []>;
generated.pin.writeDigital(pin, generated.const('bool', true));
generated.pin.configure(pin, { mode: 'high-z', outputEnabled: false, pull: 'up' });
builder.pin.sampleDigital(pin);

// @ts-expect-error sampled digital pins are u32, not bool
const wrongSample: Value<'bool'> = builder.pin.sampleDigital(pin);
// @ts-expect-error digital output requires bool SSA
builder.pin.writeDigital(pin, builder.const('u32', 1));
// @ts-expect-error raw booleans are not SSA values
builder.pin.writeDigital(pin, true);
// @ts-expect-error pin id must be a string
api.ir.pin(1);
// @ts-expect-error mode is a closed string union
builder.pin.configure(pin, { mode: 'totally-invalid', outputEnabled: true, pull: 'none' });
// @ts-expect-error observation belongs to #56
void api.ir.observeDigital;
// @ts-expect-error connection.apply belongs to #57
void api.ir.connection;
void wrongSample;
