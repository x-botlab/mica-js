# @mica-js/compiler

Browser-compatible TypeScript ESM compiler for validated `@mica-js/device-model`
execution bodies. All `OperationIR` variants are emitted as direct JavaScript;
there is no runtime IR dispatcher or dependency on the old IR or simulator.

## API

- `compileBody(region)` returns `(host, args?, reaction?) => Generator`.
- `compileComputation(computation)` returns `(host) => unknown`. It synchronously
  completes nested calls and rejects any yielded execution signal.
- `compileBodyArtifact` and `compileComputationArtifact` additionally return the
  executable, generated JavaScript source, captured constants, operation/source
  positions, suspension/resume locations and conservative effect metadata.
- `ExecutionHost`, `ExecutionSignal`, `ReactionFrame` and value helpers are exported.

Inputs must have passed model validation, scope/effect checks and instance binding.
The compiler does not replace model validation. Arbitrary names and literal values
are captured as data; binary64 constants retain NaN, infinities and negative zero.
Primitive constant pooling preserves signed zero, and known primitive equalities
use direct strict comparisons. No effectful computation is reordered or eliminated.
Generated bodies no longer reference their input IR.

`compileBody(fn.body)(host, args)` needs no function parameter declarations at
compile time. Each value parameter is initialized by its explicit
`{ kind: 'parameter', index, result, type }` operation, which reads `args[index]`.
Resource parameters instead use parameter references directly. Supply arguments in
the declared positional order, retaining resource parameters in their positions.
Argument count, resource category and value types are validated by the model/binder,
not inferred or defaulted by the compiler.

Native JavaScript generators preserve locals across suspension. Native branches,
loops and labeled value regions preserve lazy evaluation and control flow. Calls
use generator delegation; stop and redirect terminate the entire delegated path,
even if a driver resumes after a terminal signal. Drivers should close the outer
execution generator when receiving either terminal signal. Receive results are
passed to `generator.next(value)`. A receive or waitUntil signal can be satisfied
immediately by the driver without introducing a scheduling boundary. Ticks always
yield, including zero; elapse(0) does not yield. waitUntil ends its instruction path.
Time and redirect values are checked at the operation's execution position.

Runtime values use `null` for none, enum member-name strings, frozen plain records,
`Uint8Array` byte snapshots, plain sample objects and flat readonly intent branch
arrays. Both constructed and constant bytes produce a fresh `Uint8Array` each time
the operation executes. Byte constants capture frozen number-array seeds, never a
mutable buffer reused across invocations. Typed arrays are immutable by execution
contract: hosts must not mutate received values, must copy mutable boundary inputs
and must provide SDK `ReadonlyBytes` wrappers at the external boundary.
`host.resistor` supplies an intent branch array; intent combinations flatten these
arrays without changing branches. Resource references are direct name strings or
the corresponding `args[index]`. The host enforces memory, resistor, channel and
resource ownership contracts.
Equality is structural for records, bytes and samples, with strict numeric equality
including NaN inequality and signed-zero equality. Strings index UTF-16 code units.
Byte construction and indexing enforce range checks without coercion.

Effect metadata is syntactic and includes all branches. Calls are conservatively
marked as possibly reading/writing any resource, suspending, redirecting, stopping,
reading time and consuming random state; resolve actual transitive effects through
the validated model call graph. Position lines/columns refer to the exposed generated
source (one-based), not the engine's surrounding Function wrapper. Resume locations
are diagnostic metadata, not serializable generator frames.

Compilation uses `new Function` once per body and requires a host CSP that permits
dynamic JavaScript compilation. Generated execution itself requires no Node APIs.
No asynchronous execution, scheduling or electrical solving is implemented here.

## First-Release Analysis And Maps

Every compilation indexes the original body before optimization. `compileBody` and
`compileComputation` run the same correctness-preserving constant/use analysis, but
emit executable functions directly without generating CFG edges, liveness sets,
recovery maps, source positions or artifact objects. They retain no diagnostic IR.

Artifact compilation captures lightweight source/emission information. Its CFG/SSA,
effects and recovery metadata are lazy, memoized getters; requesting those fields
lowers regions into an independent, immutable internal graph (`artifact.mir`).
Merely reading `artifact.execute` or `artifact.source` does not build that graph.
Operation-granular basic blocks have explicit predecessors, successors, branch/match edges,
loop backedges, break/continue targets, value-region yields, call completion,
suspension/resumption and return/throw/stop/redirect exits. Internal instructions
carry operand IDs, detached attributes, nested-region IDs, original input paths,
source links and per-operation effects. This is separate from public `RegionIR`;
the JavaScript emitter keeps native structured control flow, not a CFG interpreter.

Results have single-assignment definitions and use lists; select/short-circuit
joins record phi inputs. Mutable locals remain explicitly identified slots, not
SSA-renamed local versions. Fixed-point liveness handles loops and is computed both
for the original baseline and for optimized uses/definitions.

The default optimizer propagates known primitive/enum constants through arithmetic,
comparisons, numeric builtins, optional lifting and none checks. Folded numbers stay
binary64 values captured outside source text, including NaN and signed zero. An
unused-result pass removes only total, effect-free scalar computations. Unknown
intermediates used by original operations are conservatively retained, even if their
only consumer is dead, so baseline recovery never requires unavailable unknown
values. Known discarded values have constant materialization recipes. Dynamic bytes,
reads, calls, assertions, resistor construction, indexing and other potentially
failing operations remain. A non-null check is removed only for a known non-null
constant. There is no branch speculation, host-read reuse, effect reordering or
trust in a call's `pure` annotation. `{ optimize: false }` disables these transforms
while retaining the same stable baseline position IDs and analysis/maps.

Artifacts additionally expose:

- `sourceMap`: stable original operation IDs, paths, inherited source locations and
  real generated UTF-16 line/column ranges. Eliminated operations remain present
  with `generated: null`; folded operations retain their original identity.
- `frameLayout`: typed result/local/context slots and compiler-created condition or
  assertion-message temporaries, linked to actual JavaScript binding names/scopes.
  Constant materialization recipes preserve baseline values removed by folding/DCE.
  Storage is explicitly `native-generator`, not a serializable external frame.
- `resumeMap`: actual generated yield/yield* lines, continuation locations and live
  slots. Receive results are defined on continuation; delegated results are defined
  on call completion, not before suspension. Terminal signals have no live suffix.
  Delegated resumption retains the native call stack; a position alone cannot
  reconstruct it or replay the call safely.
- `exitMap` and the exported `ExitState` data contract: source-linked baseline
  positions for return, suspension, terminal control, failure and future optimized
  exits, with required baseline slots versus slots that need capturing. Resume
  positions are after the completed wait (or inside a retained delegate), avoiding
  replay of prefix effects. Guard-exit entries are mapping data, not emitted guards.
- `dependencies`: resource/callee dependencies plus optional binding identities.
  Calls and wait predicates retain unresolved dependency summaries until resolved
  against the model. `binding` is null unless the caller explicitly supplies
  `{ binding: { instance, entry, generation, codeVersion, instruction } }`; identities
  and code versions are never invented or inferred from resource names.

The maps describe real emitted baseline locations and recovery requirements.
Current execution does **not** capture `ExitState` objects, expose native generator
locals, serialize frames or implement a speculative/deoptimization executor. A
consumer must retain the native continuation or provide future capture machinery.
Internal graph/layout schemas are compiler implementation metadata, not a replacement
for the stable public model schema.

Deferred, rather than claimed complete: local-to-SSA promotion and dominator/range
analysis; interprocedural call/derived analysis and short-function inlining; alias-
aware resource read/check CSE; bound numeric resource-slot specialization; optimized
stack capture and deoptimization execution. The body-only ABI supplies no callee
bodies or instance binding graph, so this release records conservative dependencies
instead of making unsupported purity/aliasing assumptions. Model-level validation
still owns call/derived cycle and effect legality checks.

## Host Evaluation Order

Assertions check their saved boolean condition first. A true condition skips both
message computation and the host assertion call. On failure, the entire lazy message
region runs before `host.assert(false, message)`; an omitted message is `undefined`.
Message effects are therefore visible to the host assertion, while a throwing or
redirecting message never reaches that call. The host must throw for a failed assertion.

Memory operations call `host.load`, `host.store`, `host.copyBytes` and
`host.memoryLength` at their original execution positions. Reads are not hoisted,
cached or merged across writes or suspension. Generated calls pass the original
operand values; the host validates resource ownership, nonnegative safe-integer
byte offsets, complete ranges and safe-integer store values before mutation.
Multi-byte accesses may be unaligned; store values use width-specific low bits only
after validation. Byte copies must return independent immutable snapshots.

Resource names appear as captured `C[index]` entries in generated source, while
resource parameters appear as `args[index]`. Inspect `artifact.constants` alongside
`artifact.source` to resolve captured names. Operation/source positions locate the
load/store call site, not the inside of the host memory helper. The benchmark's
DataView host is a small checked implementation of only the two exercised opcodes,
not a replacement for the simulator's memory and lifecycle implementation.

## Benchmark

Build once, then run the bounded Node benchmark from the repository root:

```powershell
pnpm --dir packages\compiler build
pnpm --dir packages\compiler bench --smoke
pnpm --dir packages\compiler bench
```

The benchmark imports the public compiler package API and constructs new-model IR.
It measures arithmetic and arithmetic-plus-memory kernels with native generated
loops, parameterized seeds and loop counts. The memory kernel stores little-endian
32-bit values through a resource parameter and reads big-endian values through a
direct resource name at unaligned byte offsets.

Each row reports first uncached `compileBody` time, subsequent artifact construction
time, first lazy metadata materialization time, generated source length in UTF-16
code units, median warmed batch time, executions/second, rounds/second and memory
accesses/second. Baseline compilation includes optimization, emission and
`new Function`, but excludes diagnostic CFG/liveness/recovery work, module import,
fixture creation, package build and first execution. Artifact construction is timed
after the baseline, so it can benefit from JavaScript engine source caching; it is
not presented as a second cold measurement. Metadata timing explicitly forces all
analysis/layout maps, verifies memoization, and is outside execution timing.
Cold means the first uncached baseline compilation of each kernel in this process,
not fresh-process startup; arithmetic is measured before memory.
Warmed timings use the fast baseline executable and include generator creation,
one `.next()`, host range/value checks and checksum accumulation. JavaScript reference calculations and preflight checks
are outside measured batches; results are consumed and verified against reference
checksums. These are local microbenchmarks, not simulator throughput or latency.

Smoke mode uses 100 warmups, three 1,000-execution samples and 64 rounds per
execution. Default mode uses 2,000 warmups, five 10,000-execution samples and 128
rounds. Both modes do fixed, bounded work and add no unit tests. Compare results
using the same Node version and machine; short smoke timings are especially noisy.
