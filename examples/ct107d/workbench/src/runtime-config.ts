import { toTimePs } from '@mica-js/core';

/**
 * Fixed host stepping granularity.
 *
 * The editor default is 10 µs, which makes a host-yield loop advance virtual time far too slowly
 * for a visible board. 16 ms matches the common frame batch already used by the preview benchmark
 * (16/64 ms checkpoints) and keeps control responses acceptable without changing the framework's
 * default. The value is constant for the whole host session, as the workbench contract requires.
 */
export const WORKBENCH_STEP_MS = 16;
export const WORKBENCH_STEP = toTimePs(WORKBENCH_STEP_MS, 'ms');
