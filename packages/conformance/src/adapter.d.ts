import type { DeviceIR } from '../../../docs/spec/contracts/ir';
import type { DeviceBuilder, JitBlockBuilder } from '../../../docs/spec/contracts/builder';
import type { createBoard, createDeviceLibrary } from '../../../docs/spec/contracts/host';

/** Implementations forward these entry points to the real compiler and runtime. */
export interface ConformanceAdapter {
  compileDDL(source: string): DeviceIR | Promise<DeviceIR>;
  createDeviceLibrary: typeof createDeviceLibrary;
  createBoard: typeof createBoard;
  createDeviceBuilder(): DeviceBuilder;
  createJitBlockBuilder(): JitBlockBuilder;
}
