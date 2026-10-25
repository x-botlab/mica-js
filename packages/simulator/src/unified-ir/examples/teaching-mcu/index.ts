export { TeachingMCUError } from './teaching-mcu.errors';
export type { TeachingMCUErrorCode, TeachingMCUErrorOptions } from './teaching-mcu.errors';
export {
  createTeachingMCUCircuit,
  createTeachingMCUDescription,
  createTeachingMCUIR,
  FLASH_BASE,
  GPIO_DIR,
  GPIO_IDR,
  GPIO_ODR,
  GPIO_PORT_STRIDE,
  NVIC_ACTIVE,
  NVIC_BLOCK_SIZE,
  NVIC_ENABLE,
  NVIC_PENDING,
  NVIC_PRIORITY,
  PERIPHERAL_BASE,
  RAM_BASE,
  REGISTER_COUNT,
  resolveTeachingMCUConfig,
  TEACHING_MCU_IR_TYPE,
} from './teaching-mcu';
export type {
  IRDevice,
  ResolvedTeachingMCUConfig,
  TeachingMCUConfig,
  TeachingMCUCircuitInput,
  TeachingMCUInterruptConfig,
  TeachingMCULayout,
  TeachingMCUPin,
  TeachingMCUPinMemory,
} from './teaching-mcu';
export {
  buildAccessor,
  registerTeachingMCULayout,
  unregisterTeachingMCULayout,
} from './teaching-mcu.ac';
export type {
  StorageAccessor,
  TeachingMCUAccessor,
  TeachingMCUAccessorOptions,
  TeachingMCUFlags,
  TeachingMCUGpioState,
  TeachingMCUNvicSnapshot,
  TeachingMCUSnapshot,
} from './teaching-mcu.ac';
