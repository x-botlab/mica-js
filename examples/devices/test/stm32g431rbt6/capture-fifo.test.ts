import { describe, expect, it } from 'vitest';
import { CAPTURE_FIFO_RIG, createCaptureFifoRig } from './capture-fifo-rig';

const word = (bytes: Uint8Array, offset: number): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);

function expectedFifoHash(): number {
  const bytes = new Uint8Array(0x400);
  const view = new DataView(bytes.buffer);
  const timeLo = CAPTURE_FIFO_RIG.EDGE_TIME_PS % CAPTURE_FIFO_RIG.CORE;
  const timeHi = Math.floor(CAPTURE_FIFO_RIG.EDGE_TIME_PS / CAPTURE_FIFO_RIG.CORE);

  for (let index = 0; index < 64; index += 1) {
    const at = index * 16;

    view.setUint32(at, timeLo, true);
    view.setUint32(at + 4, timeHi, true);
    bytes[at + 8] = index & 1;
    bytes[at + 9] = index & 1 ? 0 : 1;
  }

  let hash = 0;

  for (const byte of bytes) hash = (hash * 33 + byte) % CAPTURE_FIFO_RIG.CORE;

  return hash;
}

describe('production capture FIFO fn unit', () => {
  it('64 pushes, 65th overflow, reset, and re-enqueue keep the real DDL boundaries', async () => {
    const rig = await createCaptureFifoRig();

    try {
      const proof = rig.memory('sram');
      const capture = rig.memory('captureFifo');
      const pre = 0x1000;
      const post = 0x1040;

      // 门控未配置时 push 不入队。
      expect(word(proof, 0x1100)).toBe(0); // head
      expect(word(proof, 0x1104)).toBe(0); // tail
      expect(word(proof, 0x1108)).toBe(0); // pending

      // 65th 只 fault 一次；overflow/halted 后多次 push 不再发 fault。
      expect(rig.errors).toEqual([]);
      expect(rig.faults).toEqual([0xffffffff]);

      // 64 条成功入队，head 0 / tail 64；16B 内容由 position-weighted hash 覆盖。
      expect(word(proof, pre + 0x00)).toBe(0); // head
      expect(word(proof, pre + 0x04)).toBe(64); // tail
      expect(word(proof, pre + 0x08)).toBe(1); // pending
      expect(word(proof, pre + 0x0c)).toBe(1); // overflow
      expect(word(proof, pre + 0x10)).toBe(CAPTURE_FIFO_RIG.TEST_PC); // resume
      expect(word(proof, pre + 0x14) & 32).toBe(32); // capture service bit
      expect(word(proof, pre + 0x18)).toBe(0xffffffff); // faultPc
      expect(word(proof, pre + 0x1c)).toBe(1); // halted
      expect(word(proof, pre + 0x20)).toBe(expectedFifoHash());

      // overflow 后的多次 push 不改变 pc/resume/tail/overflow。
      expect(word(proof, 0x1110)).toBe(CAPTURE_FIFO_RIG.TEST_PC);
      expect(word(proof, 0x1114)).toBe(CAPTURE_FIFO_RIG.TEST_PC);
      expect(word(proof, 0x1118)).toBe(64);
      expect(word(proof, 0x111c)).toBe(1);

      // 生产 mcuReset 后 capture 状态与 service bit 干净。
      expect(word(proof, post + 0x00)).toBe(0);
      expect(word(proof, post + 0x04)).toBe(0);
      expect(word(proof, post + 0x08)).toBe(0);
      expect(word(proof, post + 0x0c)).toBe(0);
      expect(word(proof, post + 0x10)).toBe(0);
      expect(word(proof, post + 0x14) & 32).toBe(0);
      expect(word(proof, post + 0x18)).toBe(0);
      expect(word(proof, post + 0x1c)).toBe(0);

      // reset 后恢复入队一条；FIFO 其余字节已清零。
      expect(Number(rig.states.get('captureHead'))).toBe(0);
      expect(Number(rig.states.get('captureTail'))).toBe(1);
      expect(Number(rig.states.get('capturePending'))).toBe(1);
      expect(Number(rig.states.get('captureOverflow'))).toBe(0);
      expect(Number(rig.states.get('captureResume'))).toBe(CAPTURE_FIFO_RIG.RESET_PC);
      expect(Number(rig.states.get('serviceMask')) & 32).toBe(32);
      expect(rig.states.get('halted')).toBe(false);

      const entry = new DataView(capture.buffer, capture.byteOffset, 16);

      expect(entry.getUint32(0, true)).toBe(CAPTURE_FIFO_RIG.EDGE_TIME_PS % CAPTURE_FIFO_RIG.CORE);
      expect(entry.getUint32(4, true)).toBe(
        Math.floor(CAPTURE_FIFO_RIG.EDGE_TIME_PS / CAPTURE_FIFO_RIG.CORE),
      );
      expect(entry.getUint8(8)).toBe(0);
      expect(entry.getUint8(9)).toBe(1);

      for (let offset = 10; offset < 16; offset += 1) expect(entry.getUint8(offset)).toBe(0);
      for (let offset = 16; offset < capture.length; offset += 1) expect(capture[offset]).toBe(0);
    } finally {
      rig.dispose();
    }
  });
});
