import { defineConfig } from 'vite';
import { micaSdk } from '@mica-js/sdk/vite';

export default defineConfig({ plugins: [micaSdk()] });
