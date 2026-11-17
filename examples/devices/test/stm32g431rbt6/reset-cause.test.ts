import { describe, expect, it } from 'vitest';
import {
  RESET_CAUSE_IWDG,
  RESET_CAUSE_WATCHDOG,
  RESET_CAUSE_WWDG,
} from '@mica-js/stm32g431rbt6-core/reset';

describe('STM32G431RBT6 reset cause enum', () => {
  it('IWDG=5、WWDG=6；旧 WATCHDOG 名明确等价 IWDG', () => {
    expect(RESET_CAUSE_IWDG).toBe(5);
    expect(RESET_CAUSE_WWDG).toBe(6);
    expect(RESET_CAUSE_WATCHDOG).toBe(RESET_CAUSE_IWDG);
    expect(RESET_CAUSE_WATCHDOG).not.toBe(RESET_CAUSE_WWDG);
  });
});
