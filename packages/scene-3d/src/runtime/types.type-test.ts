import type { PhysicsRuntime } from '../physics';
import { Scene3DRuntime } from './index';
import type { JointCommand, RuntimeOptions, TimeMs } from './index';

declare const physics: PhysicsRuntime;
declare const runtime: Scene3DRuntime;

const delta: TimeMs = 1000 / 60;
const options: RuntimeOptions = { physics, startTime: delta };
const command: JointCommand = { jointId: 'wheel', target: { kind: 'velocity', value: 1 } };

const stepResult: Promise<void> = runtime.step(delta);
const currentTime: TimeMs = runtime.currentTime;
const readTime: TimeMs = runtime.getCurrentTime();
const configuredPhysics: PhysicsRuntime = new Scene3DRuntime(options).physics;

// @ts-expect-error a runtime needs a physics implementation
const missingPhysics: RuntimeOptions = {};
const startTimeIsNumber: RuntimeOptions = {
  physics,
  // @ts-expect-error the clock is expressed in milliseconds as a number
  startTime: '16',
};
// @ts-expect-error a joint command targets a physics joint by id
const missingJointId: JointCommand = { target: { kind: 'torque', value: 1 } };
// @ts-expect-error the clock is read-only
runtime.currentTime = 1;

void [
  command,
  configuredPhysics,
  currentTime,
  missingJointId,
  missingPhysics,
  readTime,
  startTimeIsNumber,
  stepResult,
];
