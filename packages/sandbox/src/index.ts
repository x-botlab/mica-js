// The ambient module is declared in `sandbox-worker.d.ts`; referencing it keeps consumer
// typechecks aware of the generated sandbox class.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./sandbox-worker.d.ts" />
export { SandboxWorker } from './host/sandbox';
export { SandboxError } from './errors';
export type { SandboxErrorCode } from './errors';
export type {
  SandboxState,
  SandboxPostMessageOptions,
  SandboxWorkerError,
  SandboxWorkerOptions,
  TrustedHtmlPolicy,
} from './types';
