// 规范参考计算，不导入或实现仿真运行时。
import assert from 'node:assert/strict';
import { TextEncoder } from 'node:util';

function derive(seed, id) {
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, seed, true);
  const bytes = [...prefix, ...new TextEncoder().encode(id)];
  let h = 2166136261;
  for (const byte of bytes) h = Math.imul(h ^ byte, 16777619) >>> 0;
  const state = [];
  for (let i = 0; i < 4; i++) {
    h = (h + 0x9e3779b9) >>> 0;
    let z = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    state.push((z ^ (z >>> 16)) >>> 0);
  }
  if (state.every((word) => word === 0)) state[0] = 1;
  return state;
}

// 用任意精度整数复核低 32 位转换，避免仅重复同一宿主位运算错误。
function deriveBigInt(seed, id) {
  const mask = 0xffffffffn;
  const word = BigInt(seed);
  const bytes = [0n, 8n, 16n, 24n].map((shift) => (word >> shift) & 255n);
  bytes.push(...[...new TextEncoder().encode(id)].map(BigInt));
  let h = 2166136261n;
  for (const byte of bytes) h = ((h ^ byte) * 16777619n) & mask;
  const state = [];
  for (let i = 0; i < 4; i++) {
    h = (h + 0x9e3779b9n) & mask;
    let z = ((h ^ (h >> 16n)) * 0x85ebca6bn) & mask;
    z = ((z ^ (z >> 13n)) * 0xc2b2ae35n) & mask;
    state.push(Number((z ^ (z >> 16n)) & mask));
  }
  if (state.every((value) => value === 0)) state[0] = 1;
  return state;
}

const derivationVectors = [
  [0, 'node', [707525232, 509745386, 1308297789, 731779076]],
  [1, 'node', [2648463390, 2500224213, 1838051541, 1612885659]],
  [0, '节点', [3809353869, 4108939103, 3288804777, 4173018801]],
  [4294967295, 'node', [925380700, 3481821134, 2591495791, 852227599]],
  [0, '\ud800', [3243574574, 1283130022, 3057373851, 3311942463]],
  [0, '\ufffd', [3243574574, 1283130022, 3057373851, 3311942463]],
];
for (const [seed, id, expected] of derivationVectors) {
  assert.deepEqual(derive(seed, id), expected);
  assert.deepEqual(deriveBigInt(seed, id), expected);
}

function xoshiro(state) {
  const rotl = (value, bits) => ((value << bits) | (value >>> (32 - bits))) >>> 0;
  const output = Math.imul(rotl(Math.imul(state[1], 5), 7), 9) >>> 0;
  const t = state[1] << 9;
  state[2] = (state[2] ^ state[0]) >>> 0;
  state[3] = (state[3] ^ state[1]) >>> 0;
  state[1] = (state[1] ^ state[2]) >>> 0;
  state[0] = (state[0] ^ state[3]) >>> 0;
  state[2] = (state[2] ^ t) >>> 0;
  state[3] = rotl(state[3], 11);
  return output;
}

const outputVectors = [
  [
    [1, 2, 3, 4],
    [11520, 0, 5927040, 70819200, 2031721883, 1637235492, 1287239034, 3734860849],
    [7, 0, 1026, 12288],
  ],
  [
    [4294967295, 2147483648, 305419896, 2596069104],
    [576, 1717984802, 1718080997, 1559538964, 15555279, 2485143469, 3130077668, 2221532938],
    [3846381839, 1842063751, 3989547399, 3874980053],
  ],
  [
    [0, 0, 0, 1],
    [0, 0, 5760, 11802240, 2699105920, 137178368, 1670727104, 65994905],
    [1, 0, 0, 2048],
  ],
];
for (const [initial, expected, firstState] of outputVectors) {
  const state = [...initial];
  const actual = expected.map((_, index) => {
    const output = xoshiro(state);
    if (index === 0) assert.deepEqual(state, firstState);
    assert.ok(output / 4294967296 >= 0 && output / 4294967296 < 1);
    return output;
  });
  assert.deepEqual(actual, expected);
}
console.log('Passed: 6 derivation vectors (uint32 and BigInt), 3 xoshiro output/state vectors.');
