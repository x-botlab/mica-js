import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { summarize } from './summarize-tier-profile.mjs';

test('maps sample PCs to the code and tier live at that point in the log', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ct117e-tier-parser-'));
  try {
    const log = join(directory, 'v8.log');
    const dispatcher =
      'function run(F, deadline) {\nnext = D7(F, deadline, pc); break;\n}\nreturn run;';
    const dispatcherLog = dispatcher.replaceAll(',', '\\x2C').replaceAll('\n', '\\n');
    await writeFile(
      log,
      [
        'code-creation,JS,10,900,0x100,32,stepShard127 :3:1,0x600,^',
        'script-source,18,<unknown>,function stepShard127(F) {\\nconst S = F.states\\x2C M = F.memories;\\n}',
        'code-source-info,0x100,18,0,60,,,',
        'LoadIC,0x101,-55000,2,13,0,1,0xab,states,,',
        'LoadIC,0x101,950,2,13,1,P,0xcd,states,,',
        'code-creation,JS,12,905,0x200,32,run :3:1,0x650,*',
        `script-source,17,<unknown>,${dispatcherLog}`,
        `code-source-info,0x200,17,0,80,C1O0C4O${dispatcher.indexOf('D7')}C6O0F0,,`,
        'code-creation,JS,12,910,0x400,32,run /test/runner.js:3:1,0x700,*',
        'code-creation,Builtin,2,920,0xa00,32,KeyedLoadIC',
        'code-creation,JS,2,999,0x700,32,ct117e_clear_begin_1 :3:1,0x750,~',
        'code-creation,JS,9,1000,0x800,32,ct117e_clear_begin_1 :3:1,0x750,~',
        'tick,0x101,998,0,0x0,0',
        'tick,0x101,1100,0,0x0,0,0x206',
        'tick,0x201,1200,0,0x0,0',
        'tick,0x401,1300,0,0x0,0,0x206',
        'code-move,0x100,0x300',
        'tick,0x302,1400,0,0x0,0',
        'LoadIC,0x302,1400,2,13,P,P,0xef,states,,',
        'LoadIC,0x302,1400,2,13,P,P,0x22,memories,,',
        'LoadIC,0x302,1400,1,13,P,P,0x33,states,,',
        'tick,0xa02,1500,0,0x0,0,0x304,0x206',
        'tick,0xa02,1600,0,0x0,0,0x206',
        'tick,0xa02,1700,0,0x0,0',
        'tick,0xa02,1800,0,0x0,0,0x208',
        'code-creation,JS,12,6000,0x500,32,stepShard127 :3:1,0x600,*',
        'script-source,19,<unknown>,function stepShard127(F) {\\nS[335] = v11;\\n}',
        'code-source-info,0x500,19,0,48,,,',
        'tick,0x501,6100,0,0x0,0',
        'code-deopt,6120,32,0x500,-1,19,deopt-eager,<unknown:2:4>,wrong map',
        'code-deopt,6130,32,0x500,0,19,deopt-eager,<unknown:2:4>,wrong map',
        'code-delete,0x500',
        'tick,0x501,6150,0,0x0,0',
        'code-creation,Builtin,0,6200,0x2ff,5,KeyedLoadIC',
        'tick,0x310,6300,0,0x0,0',
        'code-creation,JS,9,6400,0x900,32,ct117e_clear_end_1 :3:1,0x950,~',
        'tick,0x201,6500,0,0x0,0',
      ].join('\n'),
    );
    const [window] = await summarize(log);
    assert.deepEqual(window.bins, [
      {
        'shard:sparkplug': 2,
        'run:turbofan': 1,
        'under:run:turbofan': 3,
        'under:shard:sparkplug': 1,
        other: 1,
      },
      { 'shard:turbofan': 1, other: 2 },
    ]);
    assert.deepEqual(window.creation, [{ atUs: 5000, function: 'stepShard127', tier: 'turbofan' }]);
    assert.deepEqual(window.deopts, [
      {
        atUs: 5120,
        function: 'stepShard127',
        tier: 'turbofan',
        location: '<unknown:2:4>',
        sourceLine: 'S[335] = v11;',
        reason: 'wrong map',
      },
      {
        atUs: 5130,
        function: 'stepShard127',
        tier: 'turbofan',
        location: '<unknown:2:4>',
        reason: 'wrong map',
      },
    ]);
    assert.deepEqual(window.icCallers, {
      'stepShard127:sparkplug': 1,
      'run:turbofan': 2,
      '(no generated caller)': 1,
    });
    assert.deepEqual(window.icDispatchSites, { D7: 1, '(unmapped run position)': 1 });
    assert.deepEqual(window.frameStateLoads, [
      { atUs: -50, function: 'stepShard127', scriptId: '18', from: '1', to: 'P', map: '0xcd' },
      { atUs: 400, function: 'stepShard127', scriptId: '18', from: 'P', to: 'P', map: '0xef' },
    ]);
    assert.equal(window.endUs - window.beginUs, 5400);
  } finally {
    await rm(directory, { recursive: true });
  }
});
