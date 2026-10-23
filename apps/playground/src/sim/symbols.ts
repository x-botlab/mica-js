import { BUTTON_DEVICE, MCU_DEVICE, RELAY_DEVICE } from './devices';

/**
 * Symbols of the committed examples.
 *
 * `.sch` and `.cnv` require UUID v4 ids, so the bench uses stable UUIDs and shows the designator
 * wherever a human reads the name. Bindings and probe targets use the id.
 */
export interface BenchSymbol {
  readonly id: string;
  readonly designator: string;
  readonly device: string;
}

export const BUTTON_SYMBOL: BenchSymbol = Object.freeze({
  id: 'a3f0c8b2-1d4e-4f6a-9b7c-8d5e2f1a0c93',
  designator: 'S1',
  device: BUTTON_DEVICE,
});

export const RELAY_SYMBOL: BenchSymbol = Object.freeze({
  id: 'b7e1d2c4-3a5f-4b8e-8c6d-1e9f0a2b3c47',
  designator: 'K1',
  device: RELAY_DEVICE,
});

export const MCU_SYMBOL: BenchSymbol = Object.freeze({
  id: 'c4d5e6f7-2b3a-4c1d-9e8f-0a1b2c3d4e58',
  designator: 'U1',
  device: MCU_DEVICE,
});
