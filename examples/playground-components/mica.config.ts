import { defineConfig } from '@mica-js/sdk/config';

// The Playground's v1 canvas consumes standalone device/widget bundles, not unified packages.
export default defineConfig({ outDir: 'dist/runtime-demo' });
