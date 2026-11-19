import { MethodError } from '@mica-js/sdk/device';

type Batch = Parameters<ReturnType<DeviceFactory>['sync']>[0];

interface TimerPotParams {
  readonly id: number;
  readonly position: number;
}

interface TimerIdParams {
  readonly id: number;
}

interface TimerPotEvent {
  readonly id: number;
  readonly position: number;
}

interface TimerEdgeEvent {
  readonly time: number;
  readonly level: boolean;
  readonly id: number;
}

const LN2 = 0.6931471805599453;
const BASE_RESISTANCE = 100;
const POT_RESISTANCE = 10_000;
const CAPACITANCE = 100e-9;
const DEFAULT_POSITION = 0.5;

function timerIndex(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 2)
    throw new MethodError('ct117e-m4/timer-id', 'timer id must be 1 or 2', { id: value });
  return value - 1;
}

function frequencyAt(position: number): number {
  return 1 / (2 * LN2 * (BASE_RESISTANCE + position * POT_RESISTANCE) * CAPACITANCE);
}

export default function createTimers(context: DeviceModelContext): {
  readonly methods: Pick<
    DeviceMethods,
    'setTimerPotentiometer' | 'getTimerPotentiometer' | 'getTimerFrequency'
  >;
  sync(batch: Batch): void;
  dispose(): void;
} {
  const positions = [DEFAULT_POSITION, DEFAULT_POSITION];

  const methods = {
    setTimerPotentiometer: (params: TimerPotParams): null => {
      const index = timerIndex(params.id);
      if (!Number.isFinite(params.position) || params.position < 0 || params.position > 1)
        throw new MethodError(
          'ct117e-m4/timer-potentiometer-position',
          'position must be a finite value within 0..1',
          { id: params.id },
        );
      if (positions[index] === params.position) return null;
      positions[index] = params.position;
      context.inputs.setTimerPotentiometer.send({ id: params.id, position: params.position });
      return null;
    },
    getTimerPotentiometer: (params: TimerIdParams): number => positions[timerIndex(params.id)]!,
    getTimerFrequency: (params: TimerIdParams): number =>
      frequencyAt(positions[timerIndex(params.id)]!),
  } satisfies Pick<
    DeviceMethods,
    'setTimerPotentiometer' | 'getTimerPotentiometer' | 'getTimerFrequency'
  >;

  return {
    methods,
    sync(batch) {
      for (const message of batch.outputs.timerPotentiometer) {
        const event = message.value as TimerPotEvent;
        positions[event.id - 1] = event.position;
        context.events.onDidTimerPotentiometer.fire(event);
      }
      for (const message of batch.outputs.timerEdge) {
        context.events.onDidTimerEdge.fire(message.value as TimerEdgeEvent);
      }
    },
    dispose() {},
  };
}
