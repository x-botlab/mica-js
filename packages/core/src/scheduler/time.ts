declare const timeBrand: unique symbol;

export type TimePs = number & { readonly [timeBrand]: 'TimePs' };

/**
 * RFC 0001: 虚拟时间模型
 *
 * 支持的时间单位：
 * - 'ps': 皮秒（picoseconds）
 * - 'ns': 纳秒（nanoseconds）
 * - 'us': 微秒（microseconds，ASCII 别名）
 * - 'µs': 微秒（microseconds，Unicode）
 * - 'ms': 毫秒（milliseconds）
 * - 's': 秒（seconds）
 *
 * 'us' 和 'µs' 等价，推荐使用 'µs'。
 */
export type TimeUnit = 'ps' | 'ns' | 'us' | 'µs' | 'ms' | 's';
export const MAX_TIME_PS = 7_200_000_000_000_000;

const factors: Readonly<Record<TimeUnit, number>> = {
  ps: 1,
  ns: 1_000,
  us: 1_000_000,
  µs: 1_000_000,
  ms: 1_000_000_000,
  s: 1_000_000_000_000,
};

function checked(value: number, name: string): TimePs {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new TypeError(`${name}=${String(value)} must be a finite integer number of picoseconds`);
  }
  if (value < 0 || value > MAX_TIME_PS) {
    throw new RangeError(`${name}=${value} must be in [0, ${MAX_TIME_PS}] ps`);
  }
  return (value === 0 ? 0 : value) as TimePs;
}

export function timePs(value: number): TimePs {
  return checked(value, 'time');
}

export function toTimePs(value: number, unit: TimeUnit): TimePs {
  if (typeof unit !== 'string' || !Object.hasOwn(factors, unit)) {
    throw new TypeError(`unit=${String(unit)} must be ps, ns, us, µs, ms, or s`);
  }
  checked(value, `input (${unit})`);
  return checked(value * factors[unit], `conversion ${String(value)} ${unit} to ps`);
}

export function addTime(left: number, right: number): TimePs {
  checked(left, 'left');
  checked(right, 'right');
  return checked(left + right, `addition ${left} + ${right}`);
}

export function subtractTime(later: number, earlier: number): TimePs {
  checked(later, 'later');
  checked(earlier, 'earlier');
  return checked(later - earlier, `subtraction ${later} - ${earlier}`);
}
