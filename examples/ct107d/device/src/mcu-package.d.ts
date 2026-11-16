/**
 * External factory contract for the built IAP15F2K61S2 unified device.
 *
 * The fused package bundles `examples/devices/dist/iap15f2k61s2/model.js` at build
 * time. This declaration keeps the boundary typed without importing the standalone
 * package's global `.mica/device.d.ts` types.
 */
declare module '*/devices/dist/iap15f2k61s2/model.js' {
  import type {
    DeviceBatch,
    DeviceContext,
    FirmwareImage,
    ModelContext,
  } from '@mica-js/sdk/device';
  import type { DeviceIR } from '@mica-js/sdk/model';

  export type McuSerialData = {
    readonly cursor: number;
    readonly data: Uint8Array;
  };

  export interface McuProps {
    readonly clockFrequency: number;
    readonly firmware: FirmwareImage | null;
  }

  export type McuEventMap = {
    readonly onDidUart1Tx: McuSerialData;
    readonly onDidUart1Rx: McuSerialData;
  };

  export type McuContext = ModelContext<
    DeviceContext<McuProps, object, object>,
    McuProps,
    McuEventMap
  >;

  export interface McuSerialChunk {
    readonly start: number;
    readonly end: number;
    readonly dropped: number;
    readonly data: Uint8Array;
  }

  export interface McuSerialStatus {
    readonly capacity: number;
    readonly oldest: number;
    readonly next: number;
    readonly droppedTotal: number;
  }

  export interface McuAdapter {
    readonly methods: {
      readonly readSerial: (params: {
        readonly channel: string;
        readonly cursor: number;
      }) => McuSerialChunk;
      readonly getSerialStatus: (params: { readonly channel: string }) => McuSerialStatus;
    };
    sync(batch: DeviceBatch): void;
    dispose(): void;
  }

  export const create: (context: McuContext) => McuAdapter;
  export const model: DeviceIR;
}
