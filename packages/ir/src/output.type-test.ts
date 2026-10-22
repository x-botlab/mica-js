import { createIRModule } from './module';
import type { FunctionBuilder, Value } from './types';

const module = createIRModule();
const scalar = module.output('scalar', { params: ['u32', 'bool'], capacity: 2 });
const bytes = module.outputBytes('bytes', { maxBytes: 8, capacity: 2 });
const inbox = module.inbox('inbox', 4);

declare const b: FunctionBuilder;
const scalarResult: Value<'bool'> = b.output(scalar, [b.const('u32', 1), b.const('bool', true)]);
const bytesResult: Value<'bool'> = b.outputBytes(
  bytes,
  inbox,
  b.const('u32', 0),
  b.const('u32', 2),
);

void [scalarResult, bytesResult];

// @ts-expect-error scalar output arguments must match the declared params
b.output(scalar, [b.const('u8', 1), b.const('bool', true)]);
// @ts-expect-error scalar output arguments are a fixed tuple
b.output(scalar, [b.const('u32', 1)]);
// @ts-expect-error the byte output region must be a readable byte resource
b.outputBytes(bytes, module.state('state', 'u32', 0), b.const('u32', 0), b.const('u32', 1));
// @ts-expect-error byte output offsets and lengths are u32 values
b.outputBytes(bytes, inbox, b.const('u8', 0), b.const('u32', 1));
// @ts-expect-error byte outputs require an explicit length
b.outputBytes(bytes, inbox, b.const('u32', 0));
