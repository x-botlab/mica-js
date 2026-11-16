export declare const STRONG_RESISTANCES: readonly number[];
export declare const WEAK_RESISTANCES: readonly number[];
export type DriveStrength = 'strong' | 'weak';
export declare function driveStrength(resistance: number, where?: string): DriveStrength;
export declare function driveCode(
  resistance: number,
  rail: 'vcc' | 'gnd' | 'VCC' | 'GND',
  where?: string,
): 0 | 1 | 2 | 3;
