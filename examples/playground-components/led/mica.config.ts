import { defineConfig } from '@mica-js/sdk/config';

export default defineConfig({
  outDir: '../dist/led',
  device: { manifest: 'package.json', model: 'src/model.ddl' },
});
