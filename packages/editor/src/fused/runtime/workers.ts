/**
 * Generated workers of the fused editor runtime.
 *
 * `?sandbox-worker` bundles each entry module in memory as one self-contained classic script and
 * inlines it into this module, so the editor publishes no separate worker file. `createFusedRuntime`
 * imports this module lazily: callers that inject their own workers never pull the bundled guests in.
 */
import type { SandboxWorker } from '@mica-js/sandbox';
import DisplayEntry from './display/entry.ts?sandbox-worker';
import SimulationEntry from './simulation/entry.ts?sandbox-worker';
import type { IFusedWorkerFactories } from './host/types';

export const fusedWorkerFactories: IFusedWorkerFactories = {
  createSimulationWorker(options = {}): SandboxWorker {
    return new SimulationEntry({ name: 'fused-simulation', ...options });
  },
  createDisplayWorker(options = {}): SandboxWorker {
    return new DisplayEntry({ name: 'fused-display', ...options });
  },
};
