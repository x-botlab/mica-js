# @mica-js/device-model

Device model IR, immutable validation and the typed construction API from
`docs/spec/contracts/ir.d.ts` and `builder.d.ts`. This package does not execute
models and has no dependency on the former IR package.

```typescript
import { createDeviceBuilder, types } from '@mica-js/device-model';

const device = createDeviceBuilder({ name: 'Counter' });
device.state({ name: 'count', type: types.number, initial: 0 });
device.start((body) => {
  body.writeState('count', body.add(body.readState('count', types.number), 1));
});
const model = device.finish();
```

`validateDeviceIR(input)` validates a complete definition. `validateBlockIR(input)`
validates an unbound JIT block. Both throw `BuildError` with structured diagnostics
and return recursively frozen independent snapshots, including byte constants.
Revalidating a snapshot produced by the same validator returns that snapshot by
identity. Only successful validator outputs are trusted; mutable originals and
caller-frozen inputs always receive full validation. Successful block binding is
reused only for the same trusted block and trusted device snapshot identities.
Builder callbacks run synchronously, close when they return, and only generate IR.
Values, locals and resource references cannot cross independent bodies.

Runtime integrations can use `createJitBlockBuilder({ device?, source? })` and
`validateBoundBlockIR(block, device)` to validate resource names, signatures and
transitive effects against a definition. Block validation does not establish
runtime instance identity, entry generation or code-version ownership. Those checks
remain the runtime's responsibility. Dynamic numeric bounds are checked when the
corresponding IR operations execute.

Duplicate input-channel consumers produce an `IR_REFERENCE` diagnostic and carry
non-writable `error.code = 'CHANNEL_CONSUMER_CONFLICT'` metadata for runtime error
translation. This metadata survives source enrichment and binding diagnostics.

Development: `pnpm --filter @mica-js/device-model typecheck` and
`pnpm --filter @mica-js/device-model build`.
