# Unified-IR Architecture Gaps

Analysis of what the unified-IR `Circuit` runtime still lacks compared to the scheduler
architecture, based on the Playground migration and its e2e results.

**How this was produced**

- Read `packages/simulator/docs/API.md`, `packages/simulator/src/unified-ir/README.md`,
  `packages/simulator/docs/PERFORMANCE.md`, and the compiler/runtime sources
  (`compiler/` = 3 262 src lines, `runtime/` = 2 204).
- Diffed the three interfaces a host can depend on: `DeviceSimExecutor`,
  `Circuit`, and the scheduler path's `DeviceSimHost` / `PowerRuntime`.
- Ran the Playground on `createCircuitExecutor`: **19 / 21 e2e pass, 2 fail**; playground
  unit tests **42 / 43 pass**. Both e2e failures and the unit failure are probe assertions.
- Inspected the example devices (`packages/device/examples/*`) to enumerate what a legacy
  bridge must execute (`pin.*`, `connection.apply`, `observe.configure`).
- No `jit-issues/J*.md` files exist in this repository (searched the whole tree), so gaps are
  referenced by area and file rather than by issue number.

---

## Executive Summary

| Kind                       | Count | Items                                                                                     |
| -------------------------- | ----: | ----------------------------------------------------------------------------------------- |
| Critical blockers          |     4 | G1 legacy device bridge, G2 dynamic connections, G3 probe API, G4 board-fixture ingestion |
| Feature-parity gaps        |    11 | G5–G13, G16–G17                                                                           |
| Developer-experience gaps  |     2 | G14 debug hooks, G15 diagnostics parity                                                   |
| Performance considerations |     3 | Sparse scheduling (§5.1), compile latency (§5.3), payload caps (§2.4)                     |

The circuit path already reaches parity on the parts the Playground exercises without
electricity: topic ports (`U1.firmwarePatch`, `S1.pressed`), deferred delivery with
"reject at `advance`, stay `ready`, clock unchanged", deterministic replay, host clock
control, reset-to-time-zero, and compile diagnostics. The remaining failures all trace back
to one fact: **the playground's electronics live in `PowerRuntime` + scheduler-path device
modules, and none of that model exists in the compiler yet.**

---

## 1. Device Capability Gaps

### 1.1 Legacy Device Bridge — **BLOCKER (G1)**

**Status**: Missing
**Impact**: `mica:ideal-button`, `mica:ideal-relay`, `mica:teaching-mcu` compile into
passive devices: no contact closes, no coil switch, no GPIO, no firmware execution. The
Playground's two electrical scenarios and its `drives the button → relay chain` unit test
cannot pass.
**Evidence**: `apps/playground/e2e/simulator.spec.ts:26` fails at `probe('contact')`;
`apps/playground/src/sim/session.test.ts` "drives the button → relay chain" sees `—`.

**Description**
A scheduler-path device is a `DeviceFactory` returning `DeviceBindings`; it builds its own
`@mica-js/ir` module through `api.ir` and relies on five domain instructions:

| Instruction          | Provided by                      | Circuit equivalent today                 |
| -------------------- | -------------------------------- | ---------------------------------------- |
| `pin.configure`      | `packages/device/src/pins`       | inlined as `array.store` on `pin_mode`   |
| `pin.write_digital`  | `packages/device/src/pins`       | inlined as `array.store` on `pin_output` |
| `pin.sample_digital` | `packages/device/src/pins`       | inlined as `array.load` on `pin_input`   |
| `connection.apply`   | `packages/device/src/connection` | none                                     |
| `observe.configure`  | `packages/device/src/observe`    | none                                     |

The unified compiler does not execute a device's module at all — it calls JS behaviour
closures that emit IR into one shared module, so a legacy factory has nowhere to run.

**Proposed solutions**

1. **Module merger (true bridge, recommended long-term).** Compile each legacy factory into
   its own `IRModule`, then merge into the circuit module: rename memories/functions/
   providers with a device prefix, rewrite `StaticRef`s, resolve `pin(id)` to the global pin
   id, and lower `pin.*` to the shared pin memories. `connection.apply` still needs G2;
   `observe.configure` needs a host-side edge detector or a no-op with a documented
   limitation.
2. **Domain executors in the circuit.** Add `executors` to `CircuitRuntimeOptions` (today it
   is not forwarded: `createEngine` passes only `validation`, `maxSteps`, `bridge`) and mount
   the device package's pin/connection/observe executors against circuit memories. Cheaper
   than a merger, but still cannot express `connection.apply` without G2.
3. **Dual-engine shim.** Run legacy instances on a private scheduler inside the adapter and
   bridge only topics/publishes. ~500 lines and green tests, but the electrical work stays on
   the scheduler, so it is a compatibility escape hatch, not a migration.

**Estimated effort**: merger 1 200–1 800 lines + 600 tests (complexity **high**);
executor route 700–1 000 lines (high); shim 400–600 lines (medium).
**Depends on**: G7 (executors) for option 2; G2 for full parity.

---

### 1.2 Dynamic Connections — **BLOCKER (G2)**

**Status**: Partially addressed for declared switches (`connection.apply` lowering, 2026-10)
**Impact**: A relay that switches COM↔NO/NC at runtime, and a button that shorts A–B when
pressed. `NetworkTopologyAnalyzer` partitions pins into nets **at compile time**, so
connectivity is a constant of the generated module.
**Evidence**: `compiler/topology.ts` (union-find over `Connection[]`), `compiler/solver-gen.ts`
(one fixed solver per net). The Playground relay's `normallyOpen`/`normallyClosed` probes and
its whole scenario depend on it.

**Update (domain instruction lowering)**
`DeviceDescription.connections` now declares switchable internal edges, and
`compiler/lowering/connection-lower.ts` lowers `connection.apply` to
`connection_states` stores plus branch-free `select(closed, merged, base)` writes.
`ElectricalSolverGenerator` folds the same switches into `solve_net_<id>`, so a closed
contact survives every following tick, and poles that share a net collapse into one
generated `solve_connections_<id>`. This implements solution 2 below for declared,
two-terminal switches (a button contact, an SPDT relay); arbitrary meshes, runtime
connection _creation_ and host-facing connection introspection remain open.

**Description**
The unified electrical model is a static netlist: `connections` are edges, nets are connected
components, and `solve_net_<id>` is emitted once. A connection whose `closed` flag changes at
runtime would change the component structure — every downstream solver would be wrong.

**Proposed solutions**

1. **Full dynamic netlist.** Give connections a boolean memory and make net solving
   connection-aware. Naively that is exponential in the number of switches; a realistic design
   computes connectivity in IR (union-find over ≤ 256 pins per tick) or keeps a host-side
   incremental union-find with an epoch check. Complexity **very high**; it also erodes the
   "no host boundary" performance story.
2. **Switch-aware device library (pragmatic).** Model switches as devices that compute the
   resulting level in IR instead of changing topology — exactly what the shipped `button-ir`
   already does ("A switch cannot join two nets at runtime; the button asserts A as an ideal
   push-button source"). Works for series switches and SPDT relays whose contacts can be
   expressed as driven pins; fails for arbitrary meshes. 300–600 lines per device family.
3. **Recompile on change.** Recreate the circuit when a contact changes. Loses state and costs
   a full compile (18–61 ms measured) per event — acceptable for edit-time validation, not for
   simulation.

**Estimated effort**: full dynamic netlist 2 500–4 000 lines + solver redesign (**high**,
high risk); switch-device library 300–600 lines per family (**medium**).
**Blocks**: G9 connection introspection, full G1 parity.

---

### 1.3 Device Reset Lifecycle (G5)

**Status**: Missing
**Impact**: The Playground capability panel reports whether a model declares `reset`
(`reset-S1` supported, `reset-U1` unsupported) — two e2e assertions. `Circuit.reset()` only
replays declared initial values and `initialize`; there is no per-device reset hook.
**Evidence**: `compiler/types.ts` `DeviceBehaviors` / `DeviceKernelRuntime` expose
`initialize`/`tick`/`update` only; the legacy path has `DeviceBindings.reset` and
`DeviceInstance.reset()`.

**Proposed solution**: add `reset?: DeviceBehavior` (or a `LifecycleRef`) to
`DeviceDescription`, generate `<id>_reset`, expose `Circuit.resetDevice(id)` and an
`accessor.reset()`, and surface it in `DeviceTopic`-like metadata so the adapter can answer
capability queries without probing on a scratch scheduler.
**Estimated effort**: 200–350 lines (**low–medium**).

---

### 1.4 Firmware / Byte-Resource Updates (G6)

**Status**: Partial
**Impact**: `U1.firmwarePatch` accepts bytes over topics, but nothing routes them into a
readonly firmware region; the teaching MCU's `updateBytes` path, `updateResources` grants and
versioned updates have no unified counterpart. The MCU e2e passes only because it asserts that
delivery is _accepted_.
**Evidence**: `DeviceDescription.updateResources` exists in the compiler
(`createModuleValidation` grants `update`), and `IRStorage.updateBytesFromBytes` is reachable
through `circuit.jit`, but `Circuit` exposes no update API, `CircuitRuntimeOptions` takes no
per-device grants, and `createCircuitExecutor` drops the Playground's
`scenario.updateResources`.

**Proposed solution**: a `Circuit.patchBytes(deviceId, resource, offset, bytes)` /
accessor-level `updateBytes` that validates the grant, plus an adapter option that forwards
per-symbol grants. Topic payloads longer than the 32-byte scalar cap need G16 first.
**Estimated effort**: 250–450 lines (**medium**).

---

### 1.5 Domain Instruction Extensibility (G7)

**Status**: Missing
**Impact**: Third-party kernels cannot use domain instructions (`pin.*`, `connection.*`,
custom ops): `CircuitRuntimeOptions` has no `executors`, and `createEngine` never forwards
them, so `engine-setup` rejects the module with `unsupported-instruction`.
**Proposed solution**: plumb `executors` through `CircuitRuntimeOptions` (and fail early with
a compile diagnostic naming the missing executor).
**Estimated effort**: 100–200 lines (**low**).

---

### 1.6 Analog, Pull and Power-Domain Model (G8)

**Status**: Missing
**Impact**: The board fixtures use 5 V supplies, `ideal-voltage` models, per-pin pull-ups/
downs, thresholds (`turnOn`/`turnOff`) and power domains. The circuit solver has `rails`
(boolean levels) and one driver per net; no analog values, no pulls, no domains. `SENSE` in
the Playground exists only because the board fixture provides a pull-down.
**Proposed solution**: either extend `ElectricalSolverGenerator` with pull models and
threshold sampling (medium), or keep power domains host-side and expose sampled levels to the
IR (a `provider` per domain).
**Estimated effort**: 800–1 500 lines (**high**); required only for real analog scenarios.

---

## 2. Runtime Feature Gaps

### 2.1 Probe / Observation API — **BLOCKER (G3)**

**Status**: Landed. `Circuit.samplePin` / `Circuit.sampleConnection` read `pin_input` / `connection_states`; `createCircuitExecutor` forwards them (symbol id or designator) and `DeviceSimExecutor` exposes them as optional members. The analysis below is the pre-landing state.
**Impact**: `DeviceSimExecutor` has no pin or connection sampling, so the adapter cannot
answer the Playground's probe table. This is the direct cause of the two e2e failures and the
unit failure; probes now render `—` with a `bench/probes-unavailable` diagnostic.
**Evidence**: `apps/playground/e2e/simulator.spec.ts:34` and `:131` expect `data-value="open"`;
they receive `"—"`. `Circuit.getPin('device.pin')` exists, but board pins (`board.SENSE`) are
not device pins, and there is no connection sampling at all.

**Description**
The scheduler path samples through `PowerRuntime`:

```ts
sampleDigital({ instanceId, pinName }): { value: 0 | 1; ready: boolean }
connectionState(instanceId, connectionId): 'open' | 'closed'
networks(): readonly TopologyNetwork[]
pinIntent(pin): ElectricalPinInput
```

`Circuit` exposes only `getPin`/`setPin` on **device pins** and no netlist view.

**Proposed solution**
Add an optional probe surface to the circuit executor (do not put it on `DeviceSimExecutor`
unless every implementation can honour it):

```ts
interface CircuitProbeHost {
  /** 'U1.GPIO' — a device pin. */
  samplePin(pin: string): { value: 0 | 1; ready: boolean };
  /** Level of the net the pin sits on (needs the read-only netlist view). */
  sampleNet(deviceId: string, pin: string): { level: 0 | 1; ready: boolean };
  /** Blocked by G2: there is no runtime connection state. */
  connectionState(deviceId: string, connectionId: string): 'open' | 'closed' | undefined;
}
```

Pin/net sampling maps onto the compiled `netlist` (`CompiledCircuit.netlist` is not exposed by
`Circuit` today — expose a read-only view) plus `getPin`. Connection sampling is blocked by
G2. Board pins need G4.
**Estimated effort**: 300–500 lines incl. tests (**low–medium**); +200 for the read-only
netlist view.

---

### 2.2 Connection Introspection (G9)

**Status**: Missing
**Impact**: Cannot answer "is K1.normallyOpen closed?" — the relay scenario's primary probe.
**Depends on**: G2 (there is no runtime connection state to read).
**Estimated effort**: 100–200 lines once G2 exists (**low**).

---

### 2.3 Electrical / Net Introspection (G9b)

**Status**: Missing
**Impact**: No public way to list nets, read a net level, or see which pins share a net.
`CompiledCircuit.netlist` exists internally but `Circuit` never exposes it; the scheduler's
`PowerRuntime.networks()` has no counterpart.
**Proposed solution**: `Circuit.nets(): readonly CompiledNet[]` (frozen view) and
`Circuit.getNet(deviceId, pin)` returning the net id and level.
**Estimated effort**: 150–300 lines (**low**).

---

### 2.4 Topic Payload Capacity (G16)

**Status**: Partial
**Impact**: `string` and `bytes` payloads are encoded as `u32` words with a **32-byte** cap
(`TOPIC_STRING_MAX_BYTES`, `TOPIC_BYTES_MAX_BYTES`). A real firmware patch (the Playground
preset is 8 B, a real image is KiB) or an image payload cannot travel; larger payloads raise
`CircuitError('invalid-topic-payload')` at delivery.
**Proposed solution**: use the IR's byte outputs (`module.outputBytes` + `bridge.send_bytes`,
which the engine already supports) with per-port writable byte memories instead of scalar
words. This is also what `api.publish` does in the legacy device layer.
**Estimated effort**: 300–500 lines (**medium**); touches `topics.ts`, `topic-payload.ts`,
`Circuit` bridge and the generated entry arity.

---

### 2.5 Event-at Scheduling Between Devices (G10)

**Status**: Missing
**Impact**: The main loop is a fixed per-tick sequence (`tick` → solve → `update`) with a
static dependency order; devices cannot schedule each other for a future time, and a sparse
system still costs one pass per tick. The scheduler path has `SchedulerInstance.at()`,
`enqueueControl` and `enqueueMessage`.
**Evidence**: `compiler/mainloop-gen.ts` emits `unified_tick` / `unified_tick_batch` with no
event queue; `Circuit.createEngine` never installs an `eventHost`, so `event.at` / `event.now`
would be rejected by `engine-setup` (`unsupported-instruction`). The IR itself supports them.
**Proposed solution**: install an `IREventHost` in `Circuit` keyed on virtual time, and let
the main loop drain due entries before/after the device phases (ordering rules must be
specified). This is the foundation for sparse execution (§5.1).
**Estimated effort**: 500–900 lines (**medium–high**).

---

### 2.6 Runtime Write Surface for Pins/Nets (G17)

**Status**: Partial
`Circuit.setPin`/`getPin` cover device pins only. There is no way to force a **board** net
level (the Playground's `board.VCC`/`SENSE` are not devices), nor to restrict a host write to
a pin that the schematic does not wire. The legacy `PowerRuntime.updatePinStates` accepts any
declared pin. Workaround today is a synthesized board device (see G4).

---

## 3. Compilation & Schematic Gaps

### 3.1 Schematic Electrical Validation (G11)

**Status**: Missing
**Impact**: `compileSchematicToCircuit` checks rails, unknown devices and properties, but not
electrical compatibility: a `power` pin wired to a `signal` pin, an output driving a rail, an
unconnected required pin, or a `gnd` pin on a high rail only surface later as
`driver-conflict`/`rail-conflict` from the analyzer — or not at all.
**Evidence**: `DevicePinDescriptor.kind` (`power` | `gnd` | `signal`) is currently only copied
into `DevicePinDescription.kind` as informational text.
**Proposed solution**: map `kind` to a validation role (`power`/`gnd` pins must be on a rail
of the matching level; `signal` pins may join any non-conflicting net), emit
`schematic/pin-kind-mismatch`, `schematic/power-on-signal-net`, `schematic/open-pin` as
diagnostics with symbol + pin locations.
**Estimated effort**: 300–600 lines (**low–medium**).

---

### 3.2 Property Validation (G12)

**Status**: Partial
**Impact**: Compile-time validation is good (`resolveDeviceProperties` enforces type, range,
enum options, colour normalisation and produces `invalid-property` diagnostics), but there is
no runtime property setter, undeclared override keys are silently ignored, and image/binary
payload limits are only checked when the value is read as an asset.
**Proposed solution**: report unknown override keys as `schematic/unknown-property`, and add
`accessor.setProperty(key, value)` with the same validation if runtime reconfiguration is
needed (the legacy path fixes properties at instance creation, so this may simply stay a
compile-time feature).
**Estimated effort**: 100–200 lines for the unknown-key diagnostic (**low**).

---

### 3.3 Board-Fixture / Non-Schematic Topology Ingestion — **BLOCKER for the Playground (G4)**

**Status**: Partially landed. `compileBoardTopology(topology, devices)` turns `power`/`gnd` pins into rails, board wires into connections and board pins into probe aliases; `createCircuitExecutor({ topology })` folds it into the compilation input. Pulls and power domains are still not derived from a fixture (G8).
**Impact**: The Playground's wiring lives in `apps/playground/src/sim/board.ts`
(`TopologyDefinition`: pins, wires, power definitions, pin intents, connections), not in the
`.sch` schematic (whose sheets only contain symbols). `compileSchematicToCircuit` derives
connections from sheet wires, so it compiles **zero** connections for these scenarios.
**Proposed solution**: a `compileBoardTopology(fixture)` front-end that produces
`{ connections, rails }` from a `BoardFixture` (wires → connections, `kind: 'power' | 'gnd'`
pins → rails, pull-ups/downs → a synthesized board device or solver pulls, connections → G2),
so non-schematic hosts can share the same compiler input.
**Estimated effort**: 400–700 lines (**medium**).

---

### 3.4 Incremental Compilation / Hot Reload (G13)

**Status**: Missing
**Impact**: Any sheet or property change requires a full `Circuit.create` (compile + JIT
setup). Measured on the playground sheets: **18–61 ms** per load versus 3.5–5.8 ms for the
scheduler path. `Circuit.reset()` avoids recompiling but cannot change topology; firmware
patching exists only through G6.
**Proposed solution**: (a) cache compiled modules per `(input hash, options)`; (b) expose a
"patch bytes" path that never recompiles (G6); (c) for topology edits, accept a full rebuild
— the file-edit rate is human.
**Estimated effort**: 150 lines for a module cache + 1 000+ for true incremental codegen
(**high** for the latter).

---

## 4. Developer Experience Gaps

### 4.1 Error Surfacing (G15)

**Status**: Partial
**Strengths**: compile errors are structured (`UnifiedIRCompilerError` with `code`,
`deviceId`, `pinName`, `netId`, `diagnostics`) and `compileSchematicToCircuit` returns
diagnostics instead of throwing; `validateIR` failures list every diagnostic with its IR path;
runtime errors carry `CircuitError` codes and `IRExecutionError` locations/call stacks.
**Gaps**: the adapter flattens schematic diagnostics into
`SimulationDiagnostic('simulator/schematic-diagnostic')`, losing the structured code and
location; there is no source-location mapping from IR back to a device factory/behaviour line;
a rejected topic payload surfaces as a bare `CircuitError` from `advance` (intentional parity,
but the payload/port context lives only in the message).
**Proposed solution**: carry `code`/`entity` through `SimulationDiagnostic`, add an optional
`location` to `CircuitError`, and attach the offending port/payload type to
`invalid-topic-payload`.
**Estimated effort**: 150–250 lines (**low**).

---

### 4.2 Debugging / Stepping / Inspection (G14)

**Status**: Partial
**Strengths**: `Circuit.step()` single-steps; `Circuit.jit` exposes the engine (storage,
epochs) for diagnostics; accessors expose every declared state (`getState`/`setState`) and
`getPin` reads solved levels; the reference interpreter can be selected with
`{ engine: 'reference' }` for step-exact comparisons.
**Gaps**: `CircuitRuntimeOptions` does not forward `stepObserver` or `stepBudget`, so there is
no per-instruction trace, breakpoint or budget from a `Circuit`; the JIT-only path hides
intermediate values; `Circuit` never exposes the generated module — tooling has to compile the
same input separately with `compileCircuit` to inspect it.
**Proposed solution**: forward `stepObserver`/`stepBudget` (and expose the compiled module for
tooling); add an optional `onStep` hook in the adapter.
**Estimated effort**: 150–300 lines (**low**).

---

## 5. Performance Considerations

### 5.1 What the Scheduler has that Circuit does not

- **Sparse, event-driven execution.** Work is proportional to activity: a sleeping MCU or an
  untouched net costs nothing. The circuit runs every device phase every tick (unless G10
  lands), so an idle circuit still pays `O(devices + nets)` per tick.
- **Change-driven electrical updates.** `PowerRuntime` only re-propagates dirty pins/domains
  and raises `PowerFeedbackError` on non-convergence; the circuit re-solves every net every
  tick unconditionally.
- **Incremental connection patches.** `connection.apply` mutates live topology; the circuit
  cannot (G2).

### 5.2 What Circuit has that the Scheduler does not

- **One engine call per batch** (`unified_tick_batch`), JIT-compiled with region fusion —
  `docs/PERFORMANCE.md` reports 56–80 M tick/s end-to-end, 6.6–6.8 ns/tick for
  `runBatch(2000)` on MCU+LED (≈ 20–22× single-step and ~960–1200× batch vs the scheduler's
  6.3–8.1 µs/tick), and 583–595 M inst/s for long-slice M3 ISA (≈ 3 400–3 900× the scheduler's
  0.13–0.18 M inst/s).
- **Provider checkpoints** inside the loop (tail dispatch without leaving the module).
- **Deterministic, allocation-light ticks** with no host boundary; topics are `bridge.send`
  rather than scheduler entries.

### 5.3 Playground measurements (this migration, same sheets)

| Scenario | Circuit load | Circuit 1000 × 10 ns steps | Scheduler load | Scheduler steps |
| -------- | -----------: | -------------------------: | -------------: | --------------: |
| button   |      60.6 ms |     6.0 ms (0.006 ms/step) |         3.5 ms |          1.0 ms |
| relay    |      17.6 ms |     1.9 ms (0.002 ms/step) |         5.5 ms |          0.2 ms |
| mcu      |      19.6 ms |     1.6 ms (0.002 ms/step) |         5.8 ms |         38.5 ms |

**Caveat**: the circuit path currently executes no device logic (G1), and the first load
includes one-time JIT/module setup, so the step column is **not** a like-for-like comparison —
the MCU row shows the scheduler running the synthetic ISA while the circuit runs nothing.
Load cost is real: compilation dominates a short-lived circuit.

---

## Roadmap

### Phase 0 — landed (this worktree)

- `compileSchematicToCircuit` (symbols → devices, wires → connections, dynamic rails,
  property conversion, diagnostics), topic endpoints (`bridge.send` + IR entries), payload
  encoding, `createCircuitExecutor` with sub-tick carry and scheduler-parity delivery
  rejection.
- G3 probe API (`Circuit.samplePin` / `sampleConnection` + executor forwarding), G4-lite
  `compileBoardTopology`, and `resolveExampleDevice` for `ideal-button` / `ideal-relay`:
  21/21 e2e.

### Phase 1 — Playground blockers (~4 000–7 500 lines, **high**)

1. ~~**G3 + G9b probe API** (300–500)~~ — landed: pins and connection states are sampleable;
   net introspection (G9b) is still open.
2. **G5 reset lifecycle** (200–350) — removes the scratch-scheduler capability probe.
3. ~~**G4 board-fixture ingestion** (400–700)~~ — landed as `compileBoardTopology` for rails,
   wires and probe aliases; fixture-driven pulls stay open (G8).
4. **G1 legacy bridge** (700–1 800) — device modules actually run.
5. **G2 dynamic connections** (2 500–4 000) or the switch-device compromise (300–600 per
   family) — relay contacts.

**Fastest unblock without G1/G2**: hybrid adapter (legacy instances on a private scheduler,
topics/probes bridged, ~700–1 000 lines, medium). It restores 21/21 e2e but keeps the
electrical cost on the scheduler.

**Fastest unblock for _this_ Playground without a legacy bridge**: port the three examples to
unified-IR with switch-style devices + G3 probes + G4 ingestion (~2 000–3 000 lines) and
adjust the two connection probes to pin/net probes.

### Phase 2 — Feature parity (~1 700–3 100 lines, **medium**)

6. G6 firmware/byte-resource updates (250–450) and G16 byte topic endpoints (300–500).
7. G7 executors option (100–200).
8. G11 schematic electrical validation (300–600).
9. G12 unknown-property diagnostics (100–200).
10. G10 event-at scheduling (500–900) — also enables §5.1 sparsity.
11. G15 diagnostics parity (150–250).

### Phase 3 — Nice-to-have (~1 100–3 000 lines, **high**)

12. G8 analog/pull/power-domain model (800–1 500).
13. G13 incremental compilation / module cache (150 + 1 000).
14. G14 step observer/budget forwarding (150–300).
15. Sparse execution on top of G10 (measure before building).

### Dependency graph

```
G3 (probe) ──► G9 (connection probe) ──► needs G2
G1 (bridge) ──► needs G7 for executor route; needs G2 for connection.apply
G2 (dynamic nets) ──► G9, full G1 parity
G4 (board ingestion) ──► needs G2 for contacts; G8 for pull-ups
G10 (events) ──► sparse execution
G16 (bytes endpoints) ──► G6 large payloads
```

---

## Appendix A — Interface diff

| Capability            | `DeviceSimExecutor` (scheduler path)                    | `Circuit` today                                   |
| --------------------- | ------------------------------------------------------- | ------------------------------------------------- |
| Load schematic        | `loadSchematic(doc)` (plus `host` factory)              | `Circuit.create(input, options)`                  |
| Advance               | `advance(delta)` → entries                              | `runBatch(count)` / `step()` (ticks)              |
| Clock                 | `getSimTime()` in ps                                    | `tickCount` (bigint) — adapter converts           |
| Topics in             | `deliver(target, payload)`                              | `deliverTopic(deviceId, port, payload)`           |
| Topics out            | `onPublish(listener)`                                   | `onPublish(listener)`                             |
| Endpoint list         | `getTopics()`                                           | `topics`                                          |
| Pin read/write        | via `PowerRuntime` (`sampleDigital`, `updatePinStates`) | `getPin` / `setPin` (device pins only)            |
| Connection state      | `PowerRuntime.connectionState()`                        | —                                                 |
| Netlist view          | `PowerRuntime.networks()`                               | — (internal `CompiledCircuit.netlist`)            |
| Reset                 | `reset()` rebuilds instances                            | `reset()` restores memories + `initialize`        |
| Per-device reset      | `DeviceInstance.reset()`                                | —                                                 |
| Firmware update       | `api.updateBytes` + versioned storage                   | storage via `circuit.jit` only; no grant plumbing |
| Property validation   | `resolveDeviceProperties` at instance creation          | same helper at compile time; no runtime setter    |
| Debug hooks           | scheduler `maxStepsPerEntry`, event host                | `step()` + `jit`; no observer/budget options      |
| Event scheduling      | `SchedulerInstance.at`                                  | — (IR supports `event.at`; no host installed)     |
| Legacy device modules | `createDeviceInstance` + `pinHost`/`topology`           | —                                                 |
| Determinism           | scheduler queue order                                   | fixed phase order per tick                        |

## Appendix B — E2E coverage after the migration

`apps/playground` — pre-landing run: **19 passed, 2 failed** (17.9 s); after G3 + G4 (partial) + the
example IR bindings: **21 passed** (22.0 s), unit suite 43/43.

| Test                                            | Scheduler | Circuit | Gap                     |
| ----------------------------------------------- | :-------: | :-----: | ----------------------- |
| button → relay → sense (`simulator.spec.ts:26`) |    ✅     |   ❌    | G1 + G2 + G3 (+ G4)     |
| MCU capabilities + invalid payload (`:64`)      |    ✅     |   ✅    | —                       |
| deterministic replay (`:95`)                    |    ✅     |   ✅    | —                       |
| clock control run/pause/reset (`:104`)          |    ✅     |   ✅    | —                       |
| scenario switching (`:120`)                     |    ✅     |   ❌    | G3 (probe value `open`) |
| narrow viewport (`:134`)                        |    ✅     |   ✅    | —                       |
| canvas editor (8) / schematic editor (6)        |    ✅     |   ✅    | not executor-dependent  |

Playground unit suite: 42/43 — `drives the button → relay chain on the virtual clock` fails on
probes (same gaps).

## Appendix C — Evidence and method

- E2E: `cd apps/playground && pnpm run test:e2e` (Playwright 1.64, chromium).
- Unit: `pnpm -r test` (simulator 333/333, playground 42/43).
- Load/step measurements: a temporary vitest probe over `SimulationSession` and
  `createDeviceSimExecutor` with the same board fixtures (1000 × 10 ns advances), removed
  after the run; the first circuit load includes one-time JIT setup.
- Interface facts verified in: `packages/simulator/src/types.ts` (executor contract),
  `packages/simulator/src/unified-ir/runtime/{circuit,circuit-executor-adapter}.ts`,
  `packages/simulator/src/unified-ir/compiler/{topology,solver-gen,mainloop-gen,device-gen}.ts`,
  `packages/core/src/{power,topology,scheduler}`, `packages/device/src/{pins,connection,observe}`
  and `packages/device/examples/*`.
