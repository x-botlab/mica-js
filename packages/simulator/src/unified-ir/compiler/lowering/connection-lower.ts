import type { FunctionBuilder, FunctionRef, IRModule, Value } from '@mica-js/ir';
import { emitNetLevel, planNetLevel, type NetLevelPlan } from '../net-level';
import type { PowerGating } from '../power';
import {
  UnifiedIRCompilerError,
  type CompiledCircuitMemory,
  type CompiledNet,
  type CompiledNetlist,
  type CompiledPinConnection,
  type CompiledRail,
  type DeviceConnectionSlot,
  type GlobalConnectionMap,
  type GlobalPinMap,
} from '../types';

/**
 * `connection.apply` lowering.
 *
 * A device switch is a *dynamic* edge between two pins: closed, both sides form
 * one electrical net; open, each side is solved on its own. The compiler knows
 * the whole static netlist (external `connections` are wires and never change),
 * so closing a switch only ever merges two known nets. That turns the runtime
 * question "what does this net look like now?" into a compile-time table:
 *
 * ```text
 * connection.apply [@contact], [%pressed]
 *   -> connection_states[i] = %pressed
 *   -> PIN_INPUT[sink] = select(%pressed, mergedLevel, baseLevel)
 * ```
 *
 * Every `select` arm is a compile-time expanded driver read; nothing walks the
 * netlist at run time. Switches that share a net (the two poles of an SPDT
 * relay) are compiled as one *group*: a generated `solve_connections_<id>`
 * function reads every group state once and writes every group sink once, so a
 * two-pole switch is one call and O(pins) array stores.
 *
 * A patch whose level is a compile-time constant (a plain `boolean`, as opposed
 * to an SSA `Value<'bool'>`) is eliminated statically: no state load, no
 * `select`, only the stores the new level implies.
 */

/** Level applied to one connection: a compile-time `boolean` or an SSA value. */
export type ConnectionClosed = Value<'bool'> | boolean;

/** One entry of one atomic `connection.apply` patch. */
export interface ConnectionPatchEntry {
  readonly slot: DeviceConnectionSlot;
  readonly closed: ConnectionClosed;
}

/** A generated group solver, kept for introspection and tests. */
export interface ConnectionSolverRuntime {
  readonly groupId: number;
  /** Generated `solve_connections_<id>`. */
  readonly name: string;
  readonly solve: FunctionRef<readonly [], readonly []>;
  /** Every switch the solver reads, in declaration order. */
  readonly switches: readonly DeviceConnectionSlot[];
}

/** Lowering surface used by device generation. */
export interface ConnectionLowering {
  /** Resolves one declared switch of a device. */
  slotOf(deviceId: string, name: string): DeviceConnectionSlot | undefined;
  /**
   * Emits one atomic patch. The caller has already validated that every entry
   * belongs to `deviceId`.
   */
  emitPatch(builder: FunctionBuilder<readonly []>, entries: readonly ConnectionPatchEntry[]): void;
  /** Emits the propagation implied by the `initial: 'closed'` switches. */
  emitInitialization(builder: FunctionBuilder<readonly []>): void;
  /**
   * Switches whose closure merges `netId` with another net, in declaration
   * order. The net solvers fold them into their own sink writes, so a closed
   * switch survives the electrical solve of every following tick.
   */
  switchesOfNet(netId: number): readonly DeviceConnectionSlot[];
  /** Emits the level the merged node of `slot` produces while it is closed. */
  emitMergedLevel(builder: FunctionBuilder<readonly []>, slot: DeviceConnectionSlot): Value<'bool'>;
  /** Generated group solvers (only groups with more than one switch). */
  readonly solvers: readonly ConnectionSolverRuntime[];
}

/** Everything connection lowering reads from the earlier stages. */
export interface ConnectionLoweringContext {
  readonly module: IRModule;
  readonly memory: CompiledCircuitMemory;
  readonly netlist: CompiledNetlist;
  readonly pins: GlobalPinMap;
  readonly connections: GlobalConnectionMap;
  /** Power-domain gating; a domain that is off releases its drivers. */
  readonly power?: PowerGating;
}

/** A pin set that is solved as one node when the switch is on one side. */
interface SidePlan {
  /** Net identity: `net:<id>` for a compiled net, `pin:<id>` for an isolated pin. */
  readonly key: string;
  readonly pins: readonly CompiledPinConnection[];
  readonly rails: readonly CompiledRail[];
  /** RFC 0002 level of the node: strong drive, then rail, then weak bias. */
  readonly level: NetLevelPlan;
}

/** One sink of a switch, with the level it sees while the switch is open. */
interface SinkPlan {
  readonly globalPinId: number;
  readonly base: NetLevelPlan;
}

interface SwitchPlan {
  readonly slot: DeviceConnectionSlot;
  /** Both pins already share a net: the switch cannot change anything. */
  readonly inert: boolean;
  readonly from: SidePlan;
  readonly to: SidePlan;
  /** Sink pins of both sides; each keeps its own open level. */
  readonly sinks: readonly SinkPlan[];
  /** Level the merged node produces while the switch is closed. */
  readonly merged: NetLevelPlan;
}

interface GroupSinkPlan {
  readonly globalPinId: number;
  readonly base: NetLevelPlan;
  /** Switches whose closure merges this sink into a different net. */
  readonly switches: readonly SwitchPlan[];
}

interface GroupPlan {
  readonly groupId: number;
  readonly switches: readonly SwitchPlan[];
  readonly sinks: readonly GroupSinkPlan[];
  readonly solver: FunctionRef<readonly [], readonly []> | undefined;
}

interface LoweringPlan extends ConnectionLowering {
  readonly groups: readonly GroupPlan[];
  readonly switches: readonly SwitchPlan[];
}

/** Builds the lowering plan and declares/emits the group solvers. */
export function createConnectionLowering(context: ConnectionLoweringContext): ConnectionLowering {
  const pinConnections = indexPinConnections(context.pins);
  const netByPin = indexNets(context.netlist);
  const pinDomains = context.power?.pinDomains;

  const side = (pinId: number): SidePlan => {
    const net = netByPin.get(pinId);
    if (net !== undefined) {
      return Object.freeze({
        key: `net:${net.netId}`,
        pins: net.pins,
        rails: net.rails,
        level: planNetLevel(net.pins, net.rails, pinDomains),
      });
    }
    const pin = pinConnections.get(pinId);
    if (pin === undefined) {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        `Connection endpoint pin ${pinId} is not part of the global pin map`,
      );
    }
    return Object.freeze({
      key: `pin:${pinId}`,
      pins: Object.freeze([pin]),
      rails: Object.freeze([]) as readonly CompiledRail[],
      level: planNetLevel([pin], [], pinDomains),
    });
  };

  const switches: SwitchPlan[] = context.connections.slots.map((slot) => {
    const from = side(slot.fromPinId);
    const to = side(slot.toPinId);
    const inert = from.key === to.key;
    const fromPins = new Set(from.pins.map((pin) => pin.globalPinId));
    const sinks: SinkPlan[] = [];
    const seenSinks = new Set<number>();
    for (const pin of [...from.pins, ...to.pins]) {
      if (!pin.senses || seenSinks.has(pin.globalPinId)) continue;
      seenSinks.add(pin.globalPinId);
      sinks.push(
        Object.freeze({
          globalPinId: pin.globalPinId,
          base: fromPins.has(pin.globalPinId) ? from.level : to.level,
        }),
      );
    }
    sinks.sort((left, right) => left.globalPinId - right.globalPinId);
    const mergedPins = dedupePins([...from.pins, ...to.pins]);
    return Object.freeze({
      slot,
      inert,
      from,
      to,
      sinks: Object.freeze(sinks),
      merged: planNetLevel(mergedPins, [...from.rails, ...to.rails], pinDomains),
    });
  });

  const groups = buildGroups(switches, context);
  return new ConnectionLoweringPlan(context.memory, switches, groups);
}

/** Stateful emitter: owns the plan and the generated group solvers. */
class ConnectionLoweringPlan implements LoweringPlan {
  readonly switches: readonly SwitchPlan[];
  readonly groups: readonly GroupPlan[];
  readonly solvers: readonly ConnectionSolverRuntime[];
  private readonly memory: CompiledCircuitMemory;
  private readonly lookup: ReadonlyMap<string, DeviceConnectionSlot>;
  private readonly groupBySwitch: ReadonlyMap<SwitchPlan, GroupPlan>;
  private readonly mergedBySlot: ReadonlyMap<DeviceConnectionSlot, NetLevelPlan>;
  private readonly switchesByNet: ReadonlyMap<number, readonly DeviceConnectionSlot[]>;

  constructor(
    memory: CompiledCircuitMemory,
    switches: readonly SwitchPlan[],
    groups: readonly GroupPlan[],
  ) {
    this.memory = memory;
    this.switches = switches;
    this.groups = groups;
    this.solvers = Object.freeze(
      groups.flatMap((group) =>
        group.solver === undefined
          ? []
          : [
              Object.freeze({
                groupId: group.groupId,
                name: `solve_connections_${group.groupId}`,
                solve: group.solver,
                switches: Object.freeze(group.switches.map((entry) => entry.slot)),
              }),
            ],
      ),
    );
    const lookup = new Map<string, DeviceConnectionSlot>();
    const mergedBySlot = new Map<DeviceConnectionSlot, NetLevelPlan>();
    const switchesByNet = new Map<number, DeviceConnectionSlot[]>();
    for (const sw of switches) {
      lookup.set(`${sw.slot.deviceId}.${sw.slot.name}`, sw.slot);
      mergedBySlot.set(sw.slot, sw.merged);
      if (sw.inert) continue;
      for (const side of [sw.from, sw.to]) {
        if (!side.key.startsWith('net:')) continue;
        const netId = Number(side.key.slice(4));
        const bucket = switchesByNet.get(netId);
        if (bucket === undefined) switchesByNet.set(netId, [sw.slot]);
        else bucket.push(sw.slot);
      }
    }
    this.lookup = lookup;
    this.mergedBySlot = mergedBySlot;
    this.switchesByNet = switchesByNet;
    const bySwitch = new Map<SwitchPlan, GroupPlan>();
    for (const group of groups) {
      for (const sw of group.switches) bySwitch.set(sw, group);
    }
    this.groupBySwitch = bySwitch;
  }

  slotOf(deviceId: string, name: string): DeviceConnectionSlot | undefined {
    return this.lookup.get(`${deviceId}.${name}`);
  }

  switchesOfNet(netId: number): readonly DeviceConnectionSlot[] {
    return this.switchesByNet.get(netId) ?? [];
  }

  emitMergedLevel(
    builder: FunctionBuilder<readonly []>,
    slot: DeviceConnectionSlot,
  ): Value<'bool'> {
    const merged = this.mergedBySlot.get(slot);
    if (merged === undefined) {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        `Connection "${slot.deviceId}.${slot.name}" has no merged level`,
        { deviceId: slot.deviceId },
      );
    }
    return emitNetLevel(builder, this.memory, merged, new Map());
  }

  emitPatch(builder: FunctionBuilder<readonly []>, entries: readonly ConnectionPatchEntry[]): void {
    if (entries.length === 0) {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        'connection.apply requires at least one entry',
      );
    }
    const seen = new Set<string>();
    const groupEntries = new Map<GroupPlan, ConnectionPatchEntry[]>();
    const switchOf = new Map<DeviceConnectionSlot, SwitchPlan>(
      this.switches.map((sw) => [sw.slot, sw]),
    );
    for (const entry of entries) {
      const key = `${entry.slot.deviceId}.${entry.slot.name}`;
      if (seen.has(key)) {
        throw new UnifiedIRCompilerError(
          'invalid-input',
          `connection.apply repeats connection "${key}" in one patch`,
          { deviceId: entry.slot.deviceId },
        );
      }
      seen.add(key);
      const sw = switchOf.get(entry.slot);
      if (sw === undefined) {
        throw new UnifiedIRCompilerError(
          'invalid-input',
          `connection.apply references undeclared connection "${key}"`,
          { deviceId: entry.slot.deviceId },
        );
      }
      if (sw.inert) {
        // Both pins already share a net: keep the state (introspection) but
        // there is no level to propagate.
        const array = this.memory.connectionStates;
        if (array !== undefined) {
          const value =
            typeof entry.closed === 'boolean' ? builder.const('bool', entry.closed) : entry.closed;
          builder.array.store(array, builder.const('u32', entry.slot.index), value);
        }
        continue;
      }
      const group = this.groupBySwitch.get(sw);
      if (group === undefined) continue;
      const bucket = groupEntries.get(group);
      if (bucket === undefined) groupEntries.set(group, [entry]);
      else bucket.push(entry);
    }

    const states = this.memory.connectionStates;
    for (const [group, patch] of groupEntries) {
      const single = group.switches.length === 1 && patch.length === 1 ? patch[0] : undefined;
      if (single !== undefined && typeof single.closed === 'boolean') {
        // Static elimination: the level is known at compile time.
        this.emitStaticSwitch(builder, group.switches[0] as SwitchPlan, single.closed);
        continue;
      }
      if (states === undefined) {
        throw new UnifiedIRCompilerError(
          'invalid-input',
          'connection.apply needs a `connection_states` array; allocate connections first',
        );
      }
      for (const entry of patch) {
        const value =
          typeof entry.closed === 'boolean' ? builder.const('bool', entry.closed) : entry.closed;
        builder.array.store(states, builder.const('u32', entry.slot.index), value);
      }
      if (single !== undefined) {
        // One switch, one runtime level: inline the select instead of calling.
        this.emitDynamicSwitch(
          builder,
          group.switches[0] as SwitchPlan,
          single.closed as Value<'bool'>,
        );
      } else if (group.solver !== undefined) {
        builder.call(group.solver, []);
      }
    }
  }

  /**
   * Emits the t=0 propagation of every declared switch from the state array.
   *
   * Reading the array (instead of the declared `initial`) keeps this correct
   * when a device has already patched a switch from its `initialize` phase.
   */
  emitInitialization(builder: FunctionBuilder<readonly []>): void {
    const states = this.memory.connectionStates;
    for (const group of this.groups) {
      if (group.switches.length === 1) {
        const sw = group.switches[0] as SwitchPlan;
        if (states === undefined) continue;
        const state = builder.array.load(states, builder.const('u32', sw.slot.index));
        this.emitDynamicSwitch(builder, sw, state);
        continue;
      }
      if (group.solver !== undefined) builder.call(group.solver, []);
    }
  }

  /** Emits the level of a constant patch: no state read, no `select`. */
  private emitStaticSwitch(
    builder: FunctionBuilder<readonly []>,
    sw: SwitchPlan,
    closed: boolean,
  ): void {
    const states = this.memory.connectionStates;
    if (states === undefined) {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        'connection.apply needs a `connection_states` array; allocate connections first',
      );
    }
    // The switch still owns a state slot: the net solvers read it every tick,
    // so a constant patch must not leave the previous state behind.
    builder.array.store(states, builder.const('u32', sw.slot.index), builder.const('bool', closed));
    if (sw.sinks.length === 0) return;
    const input = this.memory.input;
    const cache = new Map<NetLevelPlan, Value<'bool'>>();
    if (closed) {
      const level = emitNetLevel(builder, this.memory, sw.merged, cache);
      for (const sink of sw.sinks) {
        builder.array.store(input, builder.const('u32', sink.globalPinId), level);
      }
      return;
    }
    for (const sink of sw.sinks) {
      const level = emitNetLevel(builder, this.memory, sink.base, cache);
      builder.array.store(input, builder.const('u32', sink.globalPinId), level);
    }
  }

  /** Emits `select(closed, merged, base)` for every sink of one switch. */
  private emitDynamicSwitch(
    builder: FunctionBuilder<readonly []>,
    sw: SwitchPlan,
    closed: Value<'bool'>,
  ): void {
    if (sw.sinks.length === 0) return;
    const cache = new Map<NetLevelPlan, Value<'bool'>>();
    const merged = emitNetLevel(builder, this.memory, sw.merged, cache);
    for (const sink of sw.sinks) {
      const base = emitNetLevel(builder, this.memory, sink.base, cache);
      builder.array.store(
        this.memory.input,
        builder.const('u32', sink.globalPinId),
        builder.select(closed, merged, base),
      );
    }
  }
}

/**
 * Groups switches that share a net, so an SPDT relay re-solves its two poles
 * together. Every group with more than one switch gets one generated
 * `solve_connections_<id>` function that reads the states in order and writes
 * each sink exactly once.
 */
function buildGroups(
  switches: readonly SwitchPlan[],
  context: ConnectionLoweringContext,
): readonly GroupPlan[] {
  const parent = switches.map((_, index) => index);
  const find = (index: number): number => {
    let current = index;
    while (parent[current] !== current) current = parent[current] as number;
    return current;
  };
  const union = (left: number, right: number): void => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  };

  const owner = new Map<string, number>();
  for (const [index, sw] of switches.entries()) {
    if (sw.inert) continue;
    for (const key of [sw.from.key, sw.to.key]) {
      const existing = owner.get(key);
      if (existing === undefined) owner.set(key, index);
      else union(existing, index);
    }
  }

  const members = new Map<number, SwitchPlan[]>();
  for (const [index, sw] of switches.entries()) {
    if (sw.inert) continue;
    const root = find(index);
    const bucket = members.get(root);
    if (bucket === undefined) members.set(root, [sw]);
    else bucket.push(sw);
  }

  const groups: GroupPlan[] = [];
  for (const bucket of members.values()) {
    const sinks = new Map<
      number,
      { readonly base: NetLevelPlan; readonly switches: SwitchPlan[] }
    >();
    for (const sw of bucket) {
      for (const sink of sw.sinks) {
        const existing = sinks.get(sink.globalPinId);
        if (existing === undefined) {
          sinks.set(sink.globalPinId, { base: sink.base, switches: [sw] });
        } else {
          existing.switches.push(sw);
        }
      }
    }
    const ordered: GroupSinkPlan[] = [...sinks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([globalPinId, entry]) =>
        Object.freeze({
          globalPinId,
          base: entry.base,
          switches: Object.freeze(entry.switches),
        }),
      );
    const groupId = groups.length;
    const needsSolver = bucket.length > 1 && ordered.length > 0;
    if (!needsSolver) {
      groups.push(
        Object.freeze({
          groupId,
          switches: Object.freeze([...bucket]),
          sinks: Object.freeze(ordered),
          solver: undefined,
        }),
      );
      continue;
    }
    const solver = context.module.func(`solve_connections_${groupId}`, {
      params: [],
      results: [],
    });
    const group: GroupPlan = Object.freeze({
      groupId,
      switches: Object.freeze([...bucket]),
      sinks: Object.freeze(ordered),
      solver,
    });
    defineGroupSolver(solver, context.memory, group);
    groups.push(group);
  }
  return Object.freeze(groups);
}

/** Emits the body of one `solve_connections_<id>` function. */
function defineGroupSolver(
  solver: FunctionRef<readonly [], readonly []>,
  memory: CompiledCircuitMemory,
  group: GroupPlan,
): void {
  const states = memory.connectionStates;
  if (states === undefined) {
    throw new UnifiedIRCompilerError(
      'invalid-input',
      'A multi-switch group needs a `connection_states` array',
    );
  }
  solver.body((b) => {
    const cache = new Map<NetLevelPlan, Value<'bool'>>();
    const merged = new Map<SwitchPlan, Value<'bool'>>();
    for (const sw of group.switches) {
      merged.set(sw, emitNetLevel(b, memory, sw.merged, cache));
    }
    for (const sink of group.sinks) {
      let value = emitNetLevel(b, memory, sink.base, cache);
      for (const sw of sink.switches) {
        const state = b.array.load(states, b.const('u32', sw.slot.index));
        value = b.select(state, merged.get(sw) as Value<'bool'>, value);
      }
      b.array.store(memory.input, b.const('u32', sink.globalPinId), value);
    }
    b.return([]);
  });
}

function indexNets(netlist: CompiledNetlist): ReadonlyMap<number, CompiledNet> {
  const netByPin = new Map<number, CompiledNet>();
  for (const net of netlist.nets) {
    for (const pin of net.pins) netByPin.set(pin.globalPinId, net);
  }
  return netByPin;
}

function indexPinConnections(pins: GlobalPinMap): ReadonlyMap<number, CompiledPinConnection> {
  const byId = new Map<number, CompiledPinConnection>();
  for (const allocation of pins.devices.values()) {
    for (const pin of allocation.resolved.values()) {
      byId.set(
        pin.globalPinId,
        Object.freeze({
          endpoint: `${pin.deviceId}.${pin.name}`,
          deviceId: pin.deviceId,
          pinName: pin.name,
          globalPinId: pin.globalPinId,
          role: pin.role,
          senses: pin.senses,
        }),
      );
    }
  }
  return byId;
}

function dedupePins(pins: readonly CompiledPinConnection[]): readonly CompiledPinConnection[] {
  const seen = new Set<number>();
  const unique: CompiledPinConnection[] = [];
  for (const pin of pins) {
    if (seen.has(pin.globalPinId)) continue;
    seen.add(pin.globalPinId);
    unique.push(pin);
  }
  unique.sort((left, right) => left.globalPinId - right.globalPinId);
  return Object.freeze(unique);
}
