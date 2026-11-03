// Source inventory, not execution evidence. Cases require the real SDK adapter.
export const fixtures = [
  {
    id: 'resistor',
    sources: ['resistor/resistor.ddl'],
    cases: ['device-resistor-initial-network'],
  },
  { id: 'controlled-switch', sources: ['controlled-switch/controlled-switch.ddl'], cases: [] },
  { id: 'nand', sources: ['nand/nand.ddl'], cases: ['device-nand-two-stage-pulldown'] },
  { id: 'tristate-buffer', sources: ['tristate-buffer/tristate-buffer.ddl'], cases: [] },
  {
    id: 'd-flip-flop',
    sources: ['d-flip-flop/d-flip-flop.ddl'],
    cases: ['device-d-flip-flop-published-edge-capture'],
  },
  {
    id: 'retriggerable-monostable',
    sources: ['retriggerable-monostable/retriggerable-monostable.ddl'],
    cases: ['device-monostable-retrigger-deadline'],
  },
  { id: 'bouncing-button', sources: ['bouncing-button/bouncing-button.ddl'], cases: [] },
  { id: 'counter-pwm', sources: ['counter-pwm/counter-pwm.ddl'], cases: [] },
  { id: 'asynchronous-sram', sources: ['asynchronous-sram/asynchronous-sram.ddl'], cases: [] },
  { id: 'i2c-eeprom', sources: ['i2c-eeprom/i2c-eeprom.ddl'], cases: [] },
  { id: 'uart', sources: ['uart/uart.ddl', 'uart/uart-adapter.js'], cases: [] },
  {
    id: 'minimal-processor',
    sources: [
      'minimal-processor/minimal-processor.ts',
      'minimal-processor/minimal-processor-adapter.js',
    ],
    cases: [],
    integration:
      'Typecheck with the parent conformance project. Inject a fresh DeviceBuilder and real TypeFactory into buildProcessor, pass createProcessorTranslator(types) to createProcessor. The declaration-only contracts provide no runtime SDK.',
  },
].map((fixture) => ({
  ...fixture,
  status: fixture.cases.length ? 'requires-runtime' : 'fixture-only',
}));
