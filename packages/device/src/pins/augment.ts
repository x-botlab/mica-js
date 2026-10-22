import type { ScalarType } from '@mica-js/ir';
import type { PinOperations } from '../types';

declare module '@mica-js/ir' {
  // The type parameter must match the core declaration even though it is unused here.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface FunctionBuilder<R extends readonly ScalarType[] = readonly []> {
    readonly pin: PinOperations;
  }
}
