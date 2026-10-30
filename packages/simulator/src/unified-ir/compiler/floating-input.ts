import type { ArrayRef, FunctionBuilder, IRModule, Value } from '@mica-js/ir';
import type { ResistiveSolver } from './resistive-solver';

type Builder = Pick<
  FunctionBuilder<readonly []>,
  'const' | 'int' | 'bool' | 'float' | 'convert' | 'array' | 'state'
>;
const u = (b: Builder, n: number) => b.const('u32', n);
function mix(b: Builder, x: Value<'u32'>): Value<'u32'> {
  x = b.int.mul(b.int.xor(x, b.int.lshr(x, u(b, 16))), u(b, 0x7feb352d));
  x = b.int.mul(b.int.xor(x, b.int.lshr(x, u(b, 15))), u(b, 0x846ca68b));
  return b.int.xor(x, b.int.lshr(x, u(b, 16)));
}
function random(b: Builder, x: Value<'u32'>): Value<'f64'> {
  return b.float.div(b.convert.intToFloat('f64', x), b.const('f64', 0x100000000));
}

/** mica-floating-v2 phase identity is hashed at build time except for the decimal episode count. */
export function createFloatingInput(
  module: IRModule,
  solver: ResistiveSolver,
  clock: ArrayRef<'u32'>,
  prefix: string,
  seed: number,
  deviceId: string,
  pinName: string,
  node: number,
  reference: number,
) {
  const text = JSON.stringify(['mica-floating-v2', seed, deviceId, pinName]).slice(0, -1) + ',';
  let prefixHash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text))
    prefixHash = Math.imul(prefixHash ^ byte, 0x01000193) >>> 0;
  const count = module.state(`${prefix}_count`, 'u32', 0);
  const wasFloating = module.state(`${prefix}_floating`, 'bool', false);
  const episode = module.state(`${prefix}_episode`, 'u32', 0);
  const initialized = module.state(`${prefix}_initialized`, 'bool', false);
  const initial = module.state(`${prefix}_initial`, 'f64', 0);
  const update = module.func(`${prefix}_update`, { params: [], results: [] });
  const sample = module.func(`${prefix}_sample`, { params: [], results: ['f64'] });
  const ready = (b: Builder) =>
    b.bool.and(
      b.array.load(solver.sourceEnabled, u(b, reference)),
      b.float.cmp('gt', b.array.load(solver.sourceVoltage, u(b, reference)), b.const('f64', 0)),
    );
  update.body((b) => {
    const floating = b.int.cmp(
      'eq',
      b.array.load(solver.voltageState, u(b, node)),
      b.const('u8', 1),
    );
    const enter = b.block([]);
    const after = b.block([]);
    b.branch(
      b.bool.and(floating, b.bool.not(b.state.load(wasFloating))),
      { target: enter, args: [] },
      { target: after, args: [] },
    );
    b.at(enter, (b) => {
      const next = b.int.add(b.state.load(count), u(b, 1));
      b.state.store(count, next);
      let hash = u(b, prefixHash);
      let started = b.const('bool', false);
      for (const power of [
        1000000000, 100000000, 10000000, 1000000, 100000, 10000, 1000, 100, 10, 1,
      ]) {
        const digit = b.int.rem(b.int.div(next, u(b, power)), u(b, 10));
        started = b.bool.or(
          started,
          power === 1 ? b.const('bool', true) : b.int.cmp('ne', digit, u(b, 0)),
        );
        hash = b.select(
          started,
          b.int.mul(b.int.xor(hash, b.int.add(digit, u(b, 48))), u(b, 0x01000193)),
          hash,
        );
      }
      hash = b.int.mul(b.int.xor(hash, u(b, 93)), u(b, 0x01000193));
      b.state.store(episode, b.select(b.int.cmp('eq', hash, u(b, 0)), u(b, 1), hash));
      b.state.store(initialized, b.const('bool', false));
      b.jump(after, []);
    });
    b.at(after, (b) => {
      b.state.store(wasFloating, floating);
      const initialize = b.block([]);
      const done = b.block([]);
      b.branch(
        b.bool.and(floating, b.bool.and(ready(b), b.bool.not(b.state.load(initialized)))),
        { target: initialize, args: [] },
        { target: done, args: [] },
      );
      b.at(initialize, (b) => {
        let value = b.state.load(episode);
        value = b.int.xor(value, b.int.shl(value, u(b, 13)));
        value = b.int.xor(value, b.int.lshr(value, u(b, 17)));
        value = b.int.xor(value, b.int.shl(value, u(b, 5)));
        b.state.store(
          initial,
          b.float.mul(random(b, value), b.array.load(solver.sourceVoltage, u(b, reference))),
        );
        b.state.store(initialized, b.const('bool', true));
        b.jump(done, []);
      });
      b.at(done, (b) => b.return([]));
    });
  });
  sample.body((b) => {
    const active = b.block([]);
    const gated = b.block([]);
    b.branch(ready(b), { target: active, args: [] }, { target: gated, args: [] });
    b.at(gated, (b) => b.return([b.const('f64', 0)]));
    b.at(active, (b) => {
      const physical = b.block([]);
      const floating = b.block([]);
      b.branch(
        b.int.cmp('eq', b.array.load(solver.voltageState, u(b, node)), b.const('u8', 0)),
        { target: physical, args: [] },
        { target: floating, args: [] },
      );
      b.at(physical, (b) => b.return([b.array.load(solver.voltage, u(b, node))]));
      b.at(floating, (b) => {
        const value = mix(
          b,
          b.int.xor(
            mix(b, b.int.xor(b.state.load(episode), b.array.load(clock, u(b, 0)))),
            b.array.load(clock, u(b, 1)),
          ),
        );
        const noise = b.float.mul(
          b.float.sub(b.float.mul(random(b, value), b.const('f64', 2)), b.const('f64', 1)),
          b.const('f64', 0.1),
        );
        const raw = b.float.add(b.state.load(initial), noise);
        const supply = b.array.load(solver.sourceVoltage, u(b, reference));
        b.return([
          b.select(
            b.float.cmp('lt', raw, b.const('f64', 0)),
            b.const('f64', 0),
            b.select(b.float.cmp('gt', raw, supply), supply, raw),
          ),
        ]);
      });
    });
  });
  return { update, sample };
}
