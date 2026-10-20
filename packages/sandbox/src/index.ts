export { createSandbox } from './host/create-sandbox';
export { SandboxError } from './errors';
export type { SandboxErrorCode } from './errors';
export { SANDBOX_FRAME_HTML } from './host/frame-html';
export { transferable } from './internal/transfer';
export type { CapabilityTransfer } from './internal/transfer';
export type {
  GuestContext,
  GuestHandler,
  GuestMethods,
  GuestSurface,
  GuestSurfaceOptions,
  ModuleSourceFromCode,
  ModuleSourceFromUrl,
  SandboxCapabilities,
  SandboxCapability,
  SandboxContract,
  SandboxHandle,
  SandboxHostOptions,
  SandboxLogEntry,
  SandboxRequestOptions,
  SandboxResizeOptions,
  SandboxSource,
  SandboxState,
  ScriptSourceFromCode,
  ScriptSourceFromUrl,
} from './types';
export type { SandboxFeatures, SandboxInfo, SandboxLogLevel, SurfaceGeometry } from './protocol';
