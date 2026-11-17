import { MethodError } from '@mica-js/sdk/device';
import { createMcu } from './mcu';
import type { McuContext } from './mcu';
import { fuseBlock } from './fuse';
import { BOARD_DEFAULTS, CHANNELS } from './channels';

const KEY_INDEX: ReadonlyMap<string, number> = new Map([
  ['S1', 0],
  ['S4', 1],
  ['S5', 2],
  ['S6', 3],
  ['S7', 4],
  ['S8', 5],
  ['S9', 6],
  ['S10', 7],
  ['S11', 8],
  ['S12', 9],
  ['S13', 10],
  ['S14', 11],
  ['S15', 12],
  ['S16', 13],
  ['S17', 14],
  ['S18', 15],
  ['S19', 16],
]);
const KEY_NAME: ReadonlyMap<number, string> = new Map(
  [...KEY_INDEX].map(([name, index]) => [index, name]),
);
const JUMPER_INDEX: ReadonlyMap<string, number> = new Map([
  ['J13', 0],
  ['J3', 1],
  ['J2', 2],
  ['J5', 3],
]);

type Batch = Parameters<ReturnType<DeviceFactory>['sync']>[0];
type Outputs = Readonly<Record<string, readonly { readonly value: unknown }[]>>;

interface LedValue {
  readonly index: number;
  readonly brightness: number;
  readonly current: number;
  readonly voltage: number;
}
interface DisplayValue {
  readonly designator: number;
  readonly digit1: number;
  readonly digit2: number;
  readonly digit3: number;
  readonly digit4: number;
}
interface SwitchValue {
  readonly index: number;
  readonly pressed: boolean;
}
interface ActuatorValue {
  readonly target: number;
  readonly active: boolean;
  readonly value: number;
}
interface ActuatorStateValue {
  readonly relay: boolean;
  readonly buzzer: boolean;
}
interface JumperValue {
  readonly index: number;
  readonly closed: boolean;
}
interface AmplifierValue {
  readonly position: number;
  readonly gain: number;
  readonly outputVoltage: number;
}
interface InfraredValue {
  LD1: boolean;
  U11: boolean;
  U20: boolean;
}
interface Ne555Value {
  frequency: number;
  dutyCycle: number;
}
interface Uln2003Value {
  mask: number;
  channels: string;
}
interface DecoderValue {
  select: number;
  enabled: boolean;
  code: string;
}
interface Pcf8591Value {
  channel: number;
  output: number;
  analog: number[];
}
interface TemperatureValue {
  converted: boolean;
  value: number;
}
interface Lm386Value {
  active: boolean;
}
interface LedState {
  brightness: number;
  current: number;
  voltage: number;
}

/**
 * One CT107D board instance. The 8051 JIT is the only JIT; every board device lives in
 * the same model. This adapter turns internal output channels into board-level events
 * with explicit designator/port identities and exposes typed controls/queries.
 */
export const create: DeviceFactory = (context) => {
  const mcuContext: McuContext = {
    ...context,
    attachJit(options) {
      return context.attachJit({
        ...options,
        translate: (input, builder) => fuseBlock(options.translate(input, builder)),
      });
    },
  };
  const mcu = createMcu(mcuContext);

  const latches = { U6: 0, U7: 0, U8: 0, U9: 0 };
  const displays: Record<'DS1' | 'DS2', number[]> = {
    DS1: [0, 0, 0, 0],
    DS2: [0, 0, 0, 0],
  };
  const leds = Array.from({ length: 8 }, () => 0);
  let relay = false;
  let buzzer = false;
  // Last value announced by the bounded history channel. Kept separately from the
  // authoritative snapshot so a dropped event can be converged once at batch end.
  let lastNotifiedRelay: boolean | undefined;
  let lastNotifiedBuzzer: boolean | undefined;
  let hall = false;
  let amplifier: AmplifierValue = { ...BOARD_DEFAULTS.lm324 };
  let eeprom = new Uint8Array(0);
  let rtc = { datetime: '', running: false };
  const switchStates = Array.from({ length: 17 }, () => false);
  const jumperStates: boolean[] = [
    BOARD_DEFAULTS.j13Closed,
    BOARD_DEFAULTS.j3Closed,
    BOARD_DEFAULTS.j2Vs1838,
    BOARD_DEFAULTS.j5Closed,
  ];
  const infrared: InfraredValue = { LD1: false, U11: false, U20: false };
  const ne555: Ne555Value = { frequency: 0, dutyCycle: 0 };
  const uln2003: Uln2003Value = { mask: 0, channels: '0000000' };
  const decoder: DecoderValue = { select: 0, enabled: true, code: '00' };
  const pcf8591: Pcf8591Value = { channel: 0, output: 0, analog: [0, 0, 0, 0] };
  const temperature: TemperatureValue = { converted: false, value: 0 };
  const lm386: Lm386Value = { active: false };
  const ledStates: LedState[] = Array.from({ length: 8 }, () => ({
    brightness: 0,
    current: 0,
    voltage: 0,
  }));

  const signal = (designator: string, port: string, value: number): void => {
    context.events.onDidSignal.fire({ designator, port, value });
  };
  const bytes = (designator: string, port: string, data: Uint8Array): void => {
    context.events.onDidBytes.fire({ designator, port, data });
  };

  const cacheMerged = (name: string, value: unknown): void => {
    const info = CHANNELS[name];
    if (info === undefined) return;
    if (info.bytes) {
      const data = new Uint8Array((value as Uint8Array).slice());
      if (name === 'u4_dump') eeprom = new Uint8Array(data);
      else if (name === 'u19_datetime') rtc = { ...rtc, datetime: new TextDecoder().decode(data) };
      else if (name === 'u10_channels') uln2003.channels = statusString(data);
      else if (name === 'u24_code') decoder.code = statusString(data);
      return;
    }
    const numeric =
      typeof value === 'boolean' ? (value ? 1 : 0) : typeof value === 'number' ? value : 0;
    if (name === 'u6_latch') latches.U6 = numeric;
    else if (name === 'u7_latch') latches.U7 = numeric;
    else if (name === 'u8_latch') latches.U8 = numeric;
    else if (name === 'u9_latch') latches.U9 = numeric;
    else if (name === 'u19_running') rtc = { ...rtc, running: numeric === 1 };
    else if (name === 'u21_active') hall = numeric === 1;
    else if (name === 'ld1_carrier') infrared.LD1 = numeric === 1;
    else if (name === 'u11_receiving') infrared.U11 = numeric === 1;
    else if (name === 'u20_receiving') infrared.U20 = numeric === 1;
    else if (name === 'u15_frequency') ne555.frequency = numeric;
    else if (name === 'u15_dutyCycle') ne555.dutyCycle = numeric;
    else if (name === 'u16_aout') pcf8591.output = numeric;
    else if (name === 'u16_channel') pcf8591.channel = numeric;
    else if (name === 'u24_select') decoder.select = numeric;
    else if (name === 'u24_enabled') decoder.enabled = numeric === 1;
    else if (name === 'u10_mask') uln2003.mask = numeric;
    else if (name === 'u5_temperatureOut') {
      temperature.converted = true;
      temperature.value = numeric;
    } else if (name === 'u14_active') lm386.active = numeric === 1;
  };

  const fireMerged = (name: string, value: unknown): void => {
    const info = CHANNELS[name];
    if (info === undefined) return;
    if (info.bytes) {
      // The event owns a separate copy from the query cache.
      bytes(info.designator, info.port, new Uint8Array((value as Uint8Array).slice()));
      return;
    }
    const numeric =
      typeof value === 'boolean' ? (value ? 1 : 0) : typeof value === 'number' ? value : 0;
    signal(info.designator, info.port, numeric);
  };

  const statusString = (data: Uint8Array): string =>
    Array.from(data, (value) => String.fromCharCode(value)).join('');

  const methods: DeviceMethods = {
    setSwitch: (params) => {
      const index = KEY_INDEX.get(params.designator);
      if (index === undefined)
        throw new MethodError(
          'switch/unknown-designator',
          `Unknown switch designator: ${params.designator}`,
          { designator: params.designator },
        );
      switchStates[index] = params.pressed;
      context.inputs.switchEvent.send({ index, pressed: params.pressed });
      return null;
    },
    setJumper: (params) => {
      const index = JUMPER_INDEX.get(params.designator);
      if (index === undefined)
        throw new MethodError(
          'jumper/unknown-designator',
          `Unknown jumper designator: ${params.designator}`,
          { designator: params.designator },
        );
      jumperStates[index] = params.closed;
      context.inputs.jumperEvent.send({ index, closed: params.closed });
      return null;
    },
    setHallField: (params) => {
      if (!Number.isFinite(params.value) || params.value < 0 || params.value > 1000)
        throw new MethodError(
          'hall/invalid-field',
          'Hall field must be a finite value within 0..1000 mT',
          null,
        );
      context.inputs.u21_fieldInput.send(params.value);
      return null;
    },
    setWiper: (params) => {
      if (!Number.isFinite(params.value))
        throw new MethodError('amplifier/invalid-wiper', 'Wiper position must be finite', null);
      context.inputs.amplifierEvent.send({
        field: 0,
        value: Math.min(1, Math.max(0, params.value)),
      });
      return null;
    },
    setAmplifierInputs: (params) => {
      if (!Number.isFinite(params.plus) || !Number.isFinite(params.minus))
        throw new MethodError('amplifier/invalid-input', 'Amplifier inputs must be finite', null);
      context.inputs.lm324Input.send({ field: 0, value: params.plus });
      context.inputs.lm324Input.send({ field: 1, value: params.minus });
      return null;
    },
    setIrCarrier: (params) => {
      if (params.designator === 'LD1') context.inputs.ld1_request.send(params.value);
      else if (params.designator === 'U11') context.inputs.u11_carrier.send(params.value);
      else if (params.designator === 'U20') context.inputs.u20_carrier.send(params.value);
      else
        throw new MethodError(
          'infrared/unknown-designator',
          `Unknown infrared source: ${params.designator}`,
          { designator: params.designator },
        );
      return null;
    },
    setTemperature: (params) => {
      if (!Number.isFinite(params.value))
        throw new MethodError('temperature/invalid', 'Temperature must be finite', null);
      context.inputs.u5_temperature.send(params.value);
      return null;
    },
    setAnalogInput: (params) => {
      const channel = params.channel;
      if (!Number.isInteger(channel) || channel < 0 || channel > 3)
        throw new MethodError(
          'analog/invalid-channel',
          'Analog channel must be an integer within 0..3',
          { channel },
        );
      if (!Number.isFinite(params.value))
        throw new MethodError('analog/invalid-value', 'Analog input must be finite', null);
      const analog = [
        context.inputs.u16_ain0,
        context.inputs.u16_ain1,
        context.inputs.u16_ain2,
        context.inputs.u16_ain3,
      ][channel]!;
      const value = Math.min(1, Math.max(0, params.value));
      analog.send(value);
      pcf8591.analog[channel] = value;
      return null;
    },
    sendUart: (params) => {
      const data = new Uint8Array(params.data.slice());
      if (data.length > 64)
        throw new MethodError('uart/too-long', 'UART probe accepts at most 64 bytes', {
          length: data.length,
        });
      context.inputs.uart_probe_send.send(data);
      return null;
    },
    getSnapshot: () => ({
      latches: { ...latches },
      displays: {
        DS1: [...displays.DS1],
        DS2: [...displays.DS2],
      },
      leds: [...leds],
      relay,
      buzzer,
      hall,
      amplifier: { ...amplifier },
      ledStates: ledStates.map((state) => ({ ...state })),
      temperature: { ...temperature },
      lm386: { ...lm386 },
      switches: {
        S1: switchStates[0]!,
        S4: switchStates[1]!,
        S5: switchStates[2]!,
        S6: switchStates[3]!,
        S7: switchStates[4]!,
        S8: switchStates[5]!,
        S9: switchStates[6]!,
        S10: switchStates[7]!,
        S11: switchStates[8]!,
        S12: switchStates[9]!,
        S13: switchStates[10]!,
        S14: switchStates[11]!,
        S15: switchStates[12]!,
        S16: switchStates[13]!,
        S17: switchStates[14]!,
        S18: switchStates[15]!,
        S19: switchStates[16]!,
      },
      jumpers: {
        J13: jumperStates[0]!,
        J3: jumperStates[1]!,
        J2: jumperStates[2]!,
        J5: jumperStates[3]!,
      },
      infrared: { ...infrared },
      ne555: { ...ne555 },
      uln2003: { ...uln2003 },
      decoder: { ...decoder },
      pcf8591: { ...pcf8591, analog: [...pcf8591.analog] },
    }),
    getAmplifier: () => ({ ...amplifier }),
    getEeprom: () => new Uint8Array(eeprom),
    getRtc: () => ({ datetime: rtc.datetime, running: rtc.running }),
    readSerial: (params) =>
      mcu.methods.readSerial(params) as ReturnType<DeviceMethods['readSerial']>,
    getSerialStatus: (params) =>
      mcu.methods.getSerialStatus(params) as ReturnType<DeviceMethods['getSerialStatus']>,
  };

  return {
    methods,
    sync(batch: Batch) {
      const outputs = batch.outputs as unknown as Outputs;

      // First update every query snapshot. Subscribers of any event, including UART,
      // therefore observe a coherent state for the whole batch.
      for (const [name, messages] of Object.entries(outputs)) {
        if (name === 'uart1Tx' || name === 'uart1Rx') continue;
        if (CHANNELS[name] !== undefined)
          for (const message of messages) cacheMerged(name, message.value);
      }
      for (const message of (outputs['led'] ?? []) as readonly { value: LedValue }[]) {
        const value = message.value;
        leds[value.index] = value.brightness;
        ledStates[value.index] = {
          brightness: value.brightness,
          current: value.current,
          voltage: value.voltage,
        };
      }
      for (const message of (outputs['display'] ?? []) as readonly { value: DisplayValue }[]) {
        const value = message.value;
        displays[value.designator === 0 ? 'DS1' : 'DS2'] = [
          value.digit1,
          value.digit2,
          value.digit3,
          value.digit4,
        ];
      }
      // The bounded `actuator` channel is history only. Snapshot state comes from the
      // complete-state channel, whose capacity 1 always retains the latest value.
      for (const message of (outputs['actuatorState'] ?? []) as readonly {
        value: ActuatorStateValue;
      }[]) {
        relay = message.value.relay;
        buzzer = message.value.buzzer;
      }
      for (const message of (outputs['amplifier'] ?? []) as readonly {
        value: AmplifierValue;
      }[]) {
        const value = message.value;
        amplifier = {
          position: value.position,
          gain: value.gain,
          outputVoltage: value.outputVoltage,
        };
      }
      for (const message of (outputs['switch'] ?? []) as readonly { value: SwitchValue }[]) {
        switchStates[message.value.index] = message.value.pressed;
      }
      for (const message of (outputs['jumper'] ?? []) as readonly { value: JumperValue }[]) {
        jumperStates[message.value.index] = message.value.closed;
      }

      // MCU UART events are part of the same coherent snapshot.
      mcu.sync(batch);

      for (const [name, messages] of Object.entries(outputs)) {
        if (name === 'uart1Tx' || name === 'uart1Rx') continue;
        if (CHANNELS[name] !== undefined)
          for (const message of messages) fireMerged(name, message.value);
      }
      for (const message of (outputs['led'] ?? []) as readonly { value: LedValue }[]) {
        const value = message.value;
        const designator = `D${value.index + 1}`;
        signal(designator, 'brightness', value.brightness);
        signal(designator, 'current', value.current);
        signal(designator, 'voltage', value.voltage);
      }
      const displayDesignators = new Set(
        ((outputs['display'] ?? []) as readonly { value: DisplayValue }[]).map(
          (message) => message.value.designator,
        ),
      );
      for (const index of displayDesignators) {
        const designator = index === 0 ? 'DS1' : 'DS2';
        const digits = displays[designator];
        // The unified seg4 event is a whole-display snapshot. The legacy seg4 adapter
        // read each digit's latest value once per sync; coalescing here is intentional
        // and keeps the preview trajectory identical.
        for (let digit = 0; digit < 4; digit += 1)
          signal(designator, `digit${digit + 1}`, digits[digit]!);
      }
      for (const message of (outputs['switch'] ?? []) as readonly { value: SwitchValue }[]) {
        const value = message.value;
        const designator = KEY_NAME.get(value.index);
        if (designator === undefined) continue;
        signal(designator, 'press', value.pressed ? 1 : 0);
        signal(designator, 'pressed', value.pressed ? 1 : 0);
      }
      for (const message of (outputs['actuator'] ?? []) as readonly { value: ActuatorValue }[]) {
        const value = message.value;
        if (value.target === 0) {
          lastNotifiedRelay = value.active;
          signal('K1', 'energized', value.active ? 1 : 0);
        } else if (value.target === 1) {
          lastNotifiedBuzzer = value.active;
          signal('SP1', 'active', value.active ? 1 : 0);
        }
      }
      // History is bounded, so the final transition of one target can be evicted by
      // noise from the other. Converge once per batch when the last notification does
      // not equal the complete state. This is an end-of-batch state, not a fabricated
      // historical edge; the callback already sees the final batch snapshot.
      if (lastNotifiedRelay !== relay) {
        lastNotifiedRelay = relay;
        signal('K1', 'energized', relay ? 1 : 0);
      }
      if (lastNotifiedBuzzer !== buzzer) {
        lastNotifiedBuzzer = buzzer;
        signal('SP1', 'active', buzzer ? 1 : 0);
      }
      for (const message of (outputs['jumper'] ?? []) as readonly { value: JumperValue }[]) {
        const value = message.value;
        const designator =
          value.index === 0 ? 'J13' : value.index === 1 ? 'J3' : value.index === 2 ? 'J2' : 'J5';
        signal(
          designator,
          value.index === 2 ? 'closedState2' : 'closedState',
          value.closed ? 1 : 0,
        );
      }
      for (const message of (outputs['amplifier'] ?? []) as readonly {
        value: AmplifierValue;
      }[]) {
        context.events.onDidAmplifier.fire({ ...message.value });
      }
    },
    dispose() {
      mcu.dispose();
    },
  };
};
