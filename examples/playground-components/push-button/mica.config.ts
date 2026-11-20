import { defineConfig } from '@mica-js/sdk/config';

export default defineConfig({
  outDir: '../dist/push-button',
  device: { manifest: 'package.json', model: 'src/model.ddl' },
});
