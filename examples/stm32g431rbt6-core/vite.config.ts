import dts from 'vite-plugin-dts';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: {
        bus: 'src/bus.ts',
        cpu: 'src/cpu.ts',
        decode: 'src/decode.ts',
        gpio: 'src/gpio.ts',
        ir: 'src/ir.ts',
        layout: 'src/layout.ts',
        machine: 'src/machine.ts',
        memory: 'src/memory.ts',
        nvic: 'src/nvic.ts',
        pwr: 'src/pwr.ts',
        rcc: 'src/rcc.ts',
        'register-facts': 'src/register-facts.ts',
        systick: 'src/systick.ts',
        thumb16: 'src/thumb16.ts',
        thumb32: 'src/thumb32.ts',
        tick: 'src/tick.ts',
        usart: 'src/usart.ts',
      },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
    target: 'es2022',
    sourcemap: true,
    minify: false,
    rollupOptions: {
      external: (id) => id === '@mica-js/sdk' || id.startsWith('@mica-js/sdk/'),
    },
  },
  plugins: [dts({ include: ['src'], entryRoot: 'src', bundleTypes: false })],
});
