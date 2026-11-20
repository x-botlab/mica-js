import { defineConfig } from '@mica-js/sdk/config';

export default defineConfig({
  device: { manifest: 'package.json', model: 'src/board-model.ddl' },
});
