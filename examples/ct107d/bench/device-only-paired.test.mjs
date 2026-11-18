import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HEAD_BOARD_LAYOUT, WORKTREE_BOARD_LAYOUT } from './device-only-paired.mjs';

test('paired bench keeps the HEAD and worktree legacy layouts separate', () => {
  assert.equal(HEAD_BOARD_LAYOUT.schematic, 'ct107d.sch');
  assert.deepEqual(HEAD_BOARD_LAYOUT.boardFiles, [
    ['examples/ct107d/verify-firmware.mjs', 'verify-firmware.mjs'],
    ['examples/ct107d/ct107d.sch', 'ct107d.sch'],
    ['examples/ct107d/ct107d.netlist.json', 'ct107d.netlist.json'],
  ]);
  assert.equal(HEAD_BOARD_LAYOUT.legacyTree, 'examples/ct107d/legacy');

  assert.equal(WORKTREE_BOARD_LAYOUT.schematic, 'legacy/source/ct107d.sch');
  assert.deepEqual(WORKTREE_BOARD_LAYOUT.boardFiles, [
    ['verify-firmware.mjs', 'verify-firmware.mjs'],
  ]);
  assert.equal(WORKTREE_BOARD_LAYOUT.legacyTree, 'legacy');
});
