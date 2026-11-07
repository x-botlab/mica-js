import { describe, expect, it } from 'vitest';
import { createMujocoRuntime } from '../physics/mujoco-runtime';
import { createOffscreenRenderer } from '../rendering/renderer.headless';
import { SCENE3D_VERSION } from '../format';
import { createScene3DHost } from './host';

const document = {
  version: SCENE3D_VERSION,
  world: { gravity: { x: 0, y: -9.81, z: 0 }, physicsStep: 1000 / 60 },
  entities: [],
  environment: { ambientLight: { color: '#ffffff', intensity: 1 } },
} as const;

describe('in-process Scene3DHost bootstrap', () => {
  it('creates a deterministic headless host without a sandbox', async () => {
    const host = await createScene3DHost({
      document,
      physics: createMujocoRuntime(),
      renderer: createOffscreenRenderer(),
    });
    await expect(host.step(16)).resolves.toMatchObject({ timeMs: 16, stepCount: 1 });
    await expect(host.dispose()).resolves.toBeUndefined();
  });
});
