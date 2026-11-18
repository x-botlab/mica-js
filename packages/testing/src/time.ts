import { timePs, type TimePs } from '@mica-js/core';

export const ps = timePs;

function convert(value: number, factor: number): TimePs {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError('Test durations must be finite nonnegative numbers');
  }
  return timePs(value * factor);
}

export const ns = (value: number): TimePs => convert(value, 1_000);
export const us = (value: number): TimePs => convert(value, 1_000_000);
export const ms = (value: number): TimePs => convert(value, 1_000_000_000);
export const seconds = (value: number): TimePs => convert(value, 1_000_000_000_000);
