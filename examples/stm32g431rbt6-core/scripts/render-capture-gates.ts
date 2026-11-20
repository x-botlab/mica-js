import { pathToFileURL } from 'node:url';

/**
 * 从 TIM capture armed 纯描述生成 DDL `captureArmed` 文本。
 *
 * 该文件不导入浏览器运行时，也不复制 TIM 寄存器/位域逻辑；所有字段都来自
 * `timerCaptureGateDescriptors()`。Node 24 可直接执行本文件读取构建后的 descriptor：
 *
 *   node examples/stm32g431rbt6-core/scripts/render-capture-gates.ts
 *
 * 输出只包含带 BEGIN/END marker 的 DDL 片段，供两个 consumer DDL patch。
 */

/** 中央 FIFO 的本地 pinId 映射；顺序即 pinId 0/1。 */
export const LOCAL_CAPTURE_PINS = ['PA15', 'PB4'] as const;

export const CAPTURE_GATE_MARKERS = {
  begin: '  // BEGIN GENERATED TIM CAPTURE GATES (render-capture-gates.ts)',
  end: '  // END GENERATED TIM CAPTURE GATES',
} as const;

export interface CaptureClockGate {
  readonly enable: number;
  readonly bit: number;
  readonly reset: number;
  readonly resetBit: number;
}

/** 只依赖 descriptor 的结构字段，避免 renderer 导入 core/DDL 运行时。 */
export interface CaptureGateDescriptor {
  readonly pinName: string;
  readonly af: number;
  readonly timerMemoryOffset: number;
  readonly cr1Offset: number;
  readonly ccmrOffset: number;
  readonly ccxsShift: number;
  readonly ccerOffset: number;
  readonly ccerShift: number;
  readonly moderState: string;
  readonly moderShift: number;
  readonly afrState: string;
  readonly afrShift: number;
  readonly timerClockGate: CaptureClockGate;
  readonly gpioClockGate: CaptureClockGate;
}

const hex = (value: number): string => `0x${value.toString(16)}`;
const hexOffset = (value: number): string => `0x${value.toString(16).padStart(2, '0')}`;

const periphLoad = (offset: number): string => `load32le(periph, ${hex(offset)})`;
const timLoad = (timerOffset: number, offset: number): string =>
  `load32le(tim, ${hexOffset(timerOffset)} + ${hexOffset(offset)})`;

function gateEnabled(gate: CaptureClockGate): string {
  return `(${periphLoad(gate.enable)} & ${1 << gate.bit}) != 0`;
}

function resetReleased(gate: CaptureClockGate): string {
  if (gate.reset < 0) throw new Error(`capture gate has no reset register (bit ${gate.resetBit})`);

  return `(${periphLoad(gate.reset)} & ${1 << gate.resetBit}) == 0`;
}

function descriptorTerm(descriptor: CaptureGateDescriptor): string {
  const terms = [
    gateEnabled(descriptor.gpioClockGate),
    resetReleased(descriptor.gpioClockGate),
    gateEnabled(descriptor.timerClockGate),
    resetReleased(descriptor.timerClockGate),
    `(${timLoad(descriptor.timerMemoryOffset, descriptor.cr1Offset)} & 1) != 0`,
    `((${timLoad(descriptor.timerMemoryOffset, descriptor.ccmrOffset)} >> ${descriptor.ccxsShift}) & 3) == 1`,
    `(${timLoad(descriptor.timerMemoryOffset, descriptor.ccerOffset)} & ${1 << descriptor.ccerShift}) != 0`,
    `((${descriptor.moderState} >> ${descriptor.moderShift}) & 3) == 2`,
    `((${descriptor.afrState} >> ${descriptor.afrShift}) & 0xf) == ${descriptor.af}`,
  ];

  return terms.map((term, index) => (index === 0 ? term : `&& ${term}`)).join('\n        ');
}

/**
 * 生成带 marker 的 DDL 片段。`localPins` 的顺序就是本地 pinId；按 `pinName` 显式映射，
 * 不使用 descriptor 的全局 `pinId`。同一 pin 的多个 descriptor 以 OR 合并。
 */
export function renderCaptureGates(
  descriptors: readonly CaptureGateDescriptor[],
  localPins: readonly string[] = LOCAL_CAPTURE_PINS,
): string {
  if (localPins.length === 0) throw new Error('capture local pin mapping is empty');
  if (new Set(localPins).size !== localPins.length)
    throw new Error('capture local pin mapping contains duplicates');

  const lines: string[] = [
    CAPTURE_GATE_MARKERS.begin,
    '  pure fn captureArmed(pinId: number) -> bool {',
  ];

  localPins.forEach((pinName, localPinId) => {
    const matching = descriptors.filter((descriptor) => descriptor.pinName === pinName);

    if (matching.length === 0)
      throw new Error(`no capture descriptor for local pin ${pinName} (pinId ${localPinId})`);

    const terms = matching.map(descriptorTerm);
    const body =
      terms.length === 1 ? terms[0]! : terms.map((term) => `(${term})`).join('\n        || ');

    lines.push(
      localPinId === 0
        ? `    if pinId == ${localPinId} {`
        : `    } else if pinId == ${localPinId} {`,
    );
    lines.push(`      return ${body};`);
  });

  lines.push('    } else {');
  lines.push('      return false;');
  lines.push('    }');
  lines.push('  }');
  lines.push(CAPTURE_GATE_MARKERS.end);

  return lines.join('\n');
}

const isMain =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const { timerCaptureGateDescriptors } = (await import('../dist/tim.js')) as {
    timerCaptureGateDescriptors: () => readonly CaptureGateDescriptor[];
  };

  process.stdout.write(`${renderCaptureGates(timerCaptureGateDescriptors())}\n`);
}
