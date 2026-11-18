/**
 * `@mica-js/sdk/fused`: author API of the unified device model (RFC 0021) and the production
 * headless runtime of the fused contract (RFC 0024 / RFC 0025 / RFC 0026).
 *
 * The runtime is explicit and in-process: the caller supplies the document, the locked package
 * registry, the module loader and any external resource or firmware project sources. Untrusted
 * browser isolation remains the editor integration's responsibility.
 */
export type {
  AsyncMethods,
  EventListeners,
  Methods,
  ModelClient,
  ModelContext,
  ModelEvent,
  ModelEventEmitter,
  ModelEvents,
  ModelFactory,
  ModelInstance,
  ModelModule,
  Params,
  Result,
  Value,
  ValueType,
} from './model.js';
export { MethodError } from './model.js';
export { parseUnifiedManifest, validateModelValue } from '@mica-js/document/fused';

export type {
  CreatedModel,
  FusedModelContext,
  FusedModelFactory,
  ModelBindingOptions,
  ModelInterface,
  RuntimeMethod,
  RuntimeModelClient,
  RuntimeModelEvent,
} from './models.js';
export { ModelBinding, ModelDisconnectedError, ModelFault } from './models.js';

export type { DiagnosticSink, PreparationProblem, RuntimeDiagnostic } from './diagnostics.js';
export { FusedPreparationError, PreparationError } from './diagnostics.js';

export type { FirmwareFormat } from './firmware.js';
export { isDecodedFormat, readonlyBytes } from './firmware.js';
export type {
  MemoryProgram,
  ProgramFiles,
  ProgramSegment,
  ProgramLoader,
  ProgramFormat,
  ProgramReference,
} from '@mica-js/document/fused';
export type {
  ProgramArtifact,
  ProgramFile,
  ProgramTarget,
  ProgramProject,
  ProgramProjectProvider,
  ProgramProjectSelectionRequest,
  ProgramSources,
} from './program.js';
export { PROGRAM_LIMITS, ProgramError, checkProgramPath, createProgramFiles } from './program.js';
export { decodeMemoryProgram } from './program-memory.js';

export type {
  BoardPropertyValue,
  PropertyResolution,
  PropertyResolutionInput,
  ResourceRequest,
  ResourceResolver,
} from './properties.js';
export { resolveInstanceProperties } from './properties.js';
export type {
  PreparedDevice,
  PreparedInstance,
  PreparedModel,
  PreparedSession,
} from './prepare.js';
export { prepareFusedSession } from './prepare.js';
export type { VerifiedPackage } from './package.js';
export {
  MICA_HOST_API_VERSION,
  isPackagePath,
  openDevicePackage,
  satisfiesRange,
} from './package.js';

export type { HeadlessRuntime, HeadlessRuntimeOptions, RuntimeState } from './runtime.js';
export { createHeadlessRuntime, FusedRuntimeError } from './runtime.js';
