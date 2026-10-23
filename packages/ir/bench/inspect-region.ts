import { createIRJIT } from '../src/index';
import { jitInternals } from '../src/jit-runtime';
import { buildRingFirmware } from './m3/firmware';
import { createM3Fixture, prepareFixture } from './m3/model';

const firmware = buildRingFirmware(4);
const fixture = createM3Fixture({ firmware, slice: 128 });
const jit = createIRJIT(fixture.module, {
  validation: fixture.validation,
  maxSteps: 10000,
  eventHost: fixture.eventHost,
});
prepareFixture(jit, fixture);
jit.execute(fixture.step, [], fixture.context);

// 运行足够多迭代让区域形成（500 次阈值）
for (let i = 0; i < 200; i++) {
  jit.execute(fixture.step, [], fixture.context);
}

const internals = (jit as Record<string, unknown>)[jitInternals] as {
  regions: number;
  compiledArtifacts: number;
  icHits: number;
  icMisses: number;
  jumpHits: number;
  dispatchSites: unknown[];
  regionSource?: string;
};
console.log('After warm-up:');
console.log('  Regions:', internals.regions);
console.log('  Compiled artifacts:', internals.compiledArtifacts);
console.log('  IC hits/misses:', internals.icHits, '/', internals.icMisses);
console.log('  Jump hits:', internals.jumpHits);
console.log('\nDispatch sites:', internals.dispatchSites);
console.log('\n=== Region 0 source (first 300 lines) ===\n');
if (internals.regions > 0 && internals.regionSource) {
  const source = internals.regionSource;
  const lines = source.split('\n').slice(0, 300);
  console.log(lines.join('\n'));
} else {
  console.log('No region source available');
}
