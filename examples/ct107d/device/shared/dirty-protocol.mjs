/**
 * Dirty protocol shared by the DDL generator and the JIT fusion pass.
 *
 * The generated model owns the refresh side: a changed MCU drive marks the pin
 * mirrors that must be recomputed and the observable groups that read one of their
 * inputs. The firmware side runs in the JIT and must mark exactly the same resources
 * from the same instruction batch, so both paths import this module instead of
 * duplicating names or group arithmetic.
 */

/** Per-drive byte: 1 means the MCU pin mirror may have changed since the last refresh. */
export const PIN_DIRTY_MEMORY = 'fusedPinDirty';
/** Per-group byte: any marked drive in the group sets its summary byte. */
export const DIRTY_GROUP_MEMORY = 'fusedDirtyGroups';
/** Grouped observables; each flag gates work that reads only that group's inputs. */
export const BUTTON_DIRTY_STATE = 'fusedButtonDirty';
export const LED_DIRTY_STATE = 'fusedLedDirty';
export const ACTUATOR_DIRTY_STATE = 'fusedActuatorDirty';

/** Number of drive indices sharing one dirty summary byte. */
export const DIRTY_GROUP_SIZE = 8;

export function dirtyGroup(drive) {
  if (!Number.isInteger(drive) || drive < 0)
    throw new RangeError(`Invalid dirty drive ${String(drive)}`);
  return Math.floor(drive / DIRTY_GROUP_SIZE);
}

export function dirtyGroupCount(pinCount) {
  if (!Number.isInteger(pinCount) || pinCount < 0)
    throw new RangeError(`Invalid dirty pin count ${String(pinCount)}`);
  return Math.ceil(pinCount / DIRTY_GROUP_SIZE);
}

/** Independent memory resource per MCU pin level and drive code. */
export function pinMemoryName(drive) {
  return `fusedPin${drive}`;
}

export function driveMemoryName(drive) {
  return `fusedDrive${drive}`;
}
