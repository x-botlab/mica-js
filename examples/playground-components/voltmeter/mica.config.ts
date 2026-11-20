import { defineConfig } from '@mica-js/sdk/config';

export default defineConfig({
  outDir: '../dist/voltmeter',
  device: { manifest: 'package.json', model: 'src/model.ddl' },
});
