import { describe, expect, it } from 'vitest';
import displayScript from './display/entry.ts?sandbox-worker-code';
import simulationScript from './simulation/entry.ts?sandbox-worker-code';

/**
 * The two guests must ship as self-contained classic scripts: the sandbox plugin bundles each
 * `?sandbox-worker` entry in memory and inlines it, so no package stays external in the worker.
 */
describe('fused worker bundles', () => {
  it('bundles both guests through the sandbox plugin', async () => {
    const { fusedWorkerFactories } = await import('./workers');
    expect(typeof fusedWorkerFactories.createSimulationWorker).toBe('function');
    expect(typeof fusedWorkerFactories.createDisplayWorker).toBe('function');
  });

  it('serves the same factories through the public runtime entry', async () => {
    const { loadFusedWorkerFactories } = await import('./index');
    const factories = await loadFusedWorkerFactories();
    expect(typeof factories.createSimulationWorker).toBe('function');
    expect(typeof factories.createDisplayWorker).toBe('function');
  });

  it('inlines every dependency of both guests', () => {
    for (const [name, script] of [
      ['Simulation', simulationScript],
      ['Display', displayScript],
    ] as const) {
      expect(script.length, `${name} guest is bundled`).toBeGreaterThan(2_000);
      // A classic script cannot keep module syntax: anything left would break `new Worker(blob)`.
      expect(script, `${name} guest keeps no import`).not.toMatch(/^\s*import\s/m);
      expect(script, `${name} guest keeps no export`).not.toMatch(/^\s*export\s/m);
      expect(script, `${name} guest runs its own entry`).toContain(`startFused${name}Guest`);
    }
    expect(simulationScript).toContain('fused-simulation');
    expect(simulationScript, 'simulation guest inlines the SDK').toContain('createHeadlessRuntime');
    // A sandbox worker has no WebCrypto, so the packaged SHA-256 of the package gate must ship too.
    // The first SHA-256 round constant proves the packaged hashing code is really inlined.
    expect(simulationScript, 'simulation guest carries a packaged SHA-256').toMatch(
      /428a2f98|1116352408/,
    );
    expect(displayScript).toContain('fused-display');
  });
});
