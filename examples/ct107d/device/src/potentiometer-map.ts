export const POTENTIOMETER_DESIGNATORS = ['RB2', 'RB4', 'RB3'] as const;
export type PotentiometerDesignator = (typeof POTENTIOMETER_DESIGNATORS)[number];

export const RB2_ADC_CHANNEL = 3;
export const RB3_DEFAULT_POSITION = 0.5;

export function rb3TimingScale(position: number): number {
  // Approximate the trim range while preserving the original rB at the midpoint.
  return 1 + (RB3_DEFAULT_POSITION - position) * 1.8;
}
