import { defineConfig } from '@mica-js/sdk/config';

/**
 * Standalone fused device project: the manifest, the DDL model and the `create` adapter are
 * explicit inputs; the unified package (`package.json`, `model.js`, `release.json`) is written
 * into this project's own `dist/`.
 */
export default defineConfig({
  outDir: 'dist',
  device: {
    manifest: 'package.json',
    model: 'src/model.ddl',
  },
});
