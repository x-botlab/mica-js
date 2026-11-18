/**
 * The fused board's supported resistor contract.
 *
 * This is deliberately a closed set rather than an arbitrary threshold: the CT107D
 * sources only use 1 Ω/25 Ω push-pull outputs, 10 kΩ 8051 quasi-bidirectional pull-ups,
 * and 1 MΩ passive pull-downs. A different value would change the electrical meaning and
 * must be reviewed instead of silently becoming "strong" or "weak".
 */
export const STRONG_RESISTANCES = Object.freeze([1, 25]);
export const WEAK_RESISTANCES = Object.freeze([10_000, 1_000_000]);

export function driveStrength(resistance, where = 'resistance') {
  if (typeof resistance !== 'number' || !Number.isFinite(resistance) || resistance <= 0)
    throw new Error(`${where}: invalid resistance ${String(resistance)} Ω`);
  if (STRONG_RESISTANCES.includes(resistance)) return 'strong';
  if (WEAK_RESISTANCES.includes(resistance)) return 'weak';
  throw new Error(
    `${where}: unsupported resistance ${resistance} Ω; supported strong 1/25 Ω and weak 10000/1000000 Ω`,
  );
}

/** Drive code used by per-pin fusedDriveN resources / source-merged pin setters. */
export function driveCode(resistance, rail, where = 'resistance') {
  const strength = driveStrength(resistance, where);

  if (rail === 'vcc' || rail === 'VCC') return strength === 'strong' ? 1 : 2;
  if (rail === 'gnd' || rail === 'GND') return strength === 'strong' ? 0 : 3;
  throw new Error(`${where}: unsupported rail ${String(rail)}`);
}
