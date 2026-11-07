import {
  type ModelEntity,
  type Scene3DDocument,
  type SensorData,
  type SensorEntity,
  type JointEntity,
  SCENE3D_VERSION,
} from '@mica-js/scene-3d';
import {
  createScene3DHostProxy,
  createScene3DHostSandbox,
  Scene3DClient,
} from '@mica-js/scene-3d/client';
import { createThreeScene3DView } from '@mica-js/scene-3d/client/three';
import { PerspectiveCamera } from 'three';
import './scene3d.css';

const STEP_MS = 1000 / 60;
const MAX_STEPS_PER_FRAME = 5;
/** Upper bound on one host round-trip, so a lost frame cannot freeze the demo. */
const STEP_TIMEOUT_MS = 5000;

const identity: { x: number; y: number; z: number; w: number } = { x: 0, y: 0, z: 0, w: 1 };

function model(
  id: string,
  geometry: ModelEntity['geometry'],
  position: { x: number; y: number; z: number },
  physics: ModelEntity['physics'],
  color: string,
  collider: ModelEntity['collider'],
  rotation = identity,
): ModelEntity {
  return {
    id,
    type: 'model',
    position,
    rotation,
    geometry,
    material: { color, friction: 0.7, restitution: 0.1 },
    collider,
    physics,
  };
}

function sensor(
  id: string,
  position: { x: number; y: number; z: number },
  config: SensorEntity['config'],
  mountedOn?: string,
): SensorEntity {
  return {
    id,
    type: 'sensor',
    position,
    rotation: identity,
    sensorType: config.type,
    config,
    ...(mountedOn === undefined ? {} : { mountedOn }),
  };
}

function joint(id: string, bodyB: string, anchorX: number): JointEntity {
  return {
    id,
    type: 'joint',
    position: { x: 0, y: 0, z: 0 },
    rotation: identity,
    jointType: 'revolute',
    bodyA: 'chassis',
    bodyB,
    anchorA: { x: anchorX, y: -0.02, z: 0 },
    anchorB: { x: 0, y: 0, z: 0 },
    axis: { x: 1, y: 0, z: 0 },
    motor: { maxForce: 1, maxVelocity: 10 },
  };
}

const sceneDocument: Scene3DDocument = {
  version: SCENE3D_VERSION,
  world: { gravity: { x: 0, y: -9.81, z: 0 }, physicsStep: STEP_MS },
  entities: [
    model(
      'track-base',
      {
        type: 'acrylic',
        acrylic: {
          contour: { type: 'rect', width: 0.4, height: 0.6 },
          thickness: 0.003,
          color: '#f5f5f5',
          // 50 mm line printed down the middle; the sensors ride its edges at ±25 mm.
          paint: {
            base: '#f5f5f5',
            strokes: [{ axis: 'z', center: 0, width: 0.05, color: '#141414' }],
          },
        },
      },
      { x: 0, y: 0.0015, z: 0 },
      { bodyType: 'static' },
      '#f5f5f5',
      { type: 'trimesh', source: 'geometry' },
    ),
    model(
      'wall-left',
      { type: 'box', size: { x: 0.02, y: 0.04, z: 0.6 } },
      { x: -0.19, y: 0.02, z: 0 },
      { bodyType: 'static' },
      '#a8d8ea',
      { type: 'box', size: { x: 0.02, y: 0.04, z: 0.6 } },
    ),
    model(
      'wall-right',
      { type: 'box', size: { x: 0.02, y: 0.04, z: 0.6 } },
      { x: 0.19, y: 0.02, z: 0 },
      { bodyType: 'static' },
      '#a8d8ea',
      { type: 'box', size: { x: 0.02, y: 0.04, z: 0.6 } },
    ),
    model(
      'chassis',
      { type: 'box', size: { x: 0.1, y: 0.03, z: 0.16 } },
      { x: 0.012, y: 0.052, z: 0 },
      // The in-memory engine has no contacts yet, so a dynamic body would fall through the plate.
      { bodyType: 'dynamic', mass: 0.2, constraints: { freezePosition: { y: true } } },
      '#e45757',
      { type: 'box', size: { x: 0.1, y: 0.03, z: 0.16 } },
    ),
    model(
      'wheel-left',
      { type: 'cylinder', radius: 0.032, height: 0.016 },
      { x: -0.058, y: 0.032, z: 0 },
      { bodyType: 'dynamic', mass: 0.05, constraints: { freezePosition: { y: true } } },
      '#202020',
      { type: 'cylinder', radius: 0.032, height: 0.016 },
      { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 },
    ),
    model(
      'wheel-right',
      { type: 'cylinder', radius: 0.032, height: 0.016 },
      { x: 0.058, y: 0.032, z: 0 },
      { bodyType: 'dynamic', mass: 0.05, constraints: { freezePosition: { y: true } } },
      '#202020',
      { type: 'cylinder', radius: 0.032, height: 0.016 },
      { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 },
    ),
    joint('joint-left', 'wheel-left', -0.058),
    joint('joint-right', 'wheel-right', 0.058),
    sensor(
      'color-left',
      { x: -0.025, y: -0.017, z: -0.06 },
      {
        type: 'color',
        direction: { x: 0, y: -1, z: 0 },
        maxRange: 0.05,
        sampleRadius: 0.003,
        updateRate: 60,
      },
      'chassis',
    ),
    sensor(
      'color-right',
      { x: 0.025, y: -0.017, z: -0.06 },
      {
        type: 'color',
        direction: { x: 0, y: -1, z: 0 },
        maxRange: 0.05,
        sampleRadius: 0.003,
        updateRate: 60,
      },
      'chassis',
    ),
    sensor(
      'distance-front',
      { x: 0, y: 0, z: -0.1 },
      { type: 'distance', maxRange: 1, fov: 0, updateRate: 20 },
      'chassis',
    ),
  ],
  environment: { ambientLight: { color: '#ffffff', intensity: 1 } },
};

const root = documentElement('body');
root.innerHTML = `
  <main class="scene3d-demo">
    <header><h1>Mica <span>3D Scene</span></h1><p>Sandboxed line-following robot</p></header>
    <section class="scene3d-stage"><canvas id="scene" aria-label="3D scene"></canvas><aside class="scene3d-hud">
      <div id="status" role="status">加载中…</div>
      <dl><dt>虚拟时间</dt><dd id="time">0.0 ms</dd><dt>步数</dt><dd id="steps">0</dd><dt>color-left</dt><dd id="left">—</dd><dt>color-right</dt><dd id="right">—</dd><dt>distance-front</dt><dd id="distance">—</dd></dl>
      <div class="scene3d-controls"><button id="play">播放</button><button id="pause">暂停</button><button id="single">单步</button><button id="reset">重置</button></div>
    </aside></section>
  </main>`;

const canvas = root.querySelector<HTMLCanvasElement>('#scene')!;
const status = root.querySelector<HTMLElement>('#status')!;
const time = root.querySelector<HTMLElement>('#time')!;
const steps = root.querySelector<HTMLElement>('#steps')!;
const left = root.querySelector<HTMLElement>('#left')!;
const right = root.querySelector<HTMLElement>('#right')!;
const distance = root.querySelector<HTMLElement>('#distance')!;
let client: Scene3DClient | undefined;
let view: ReturnType<typeof createThreeScene3DView> | undefined;
let running = false;
let accumulator = 0;
let lastFrame = 0;
let controlCounter = 0;
let pending = false;
let drainingSteps = false;
/** Heading of the demo chassis, integrated from the steering command. */
let yaw = 0;
/** Set once the chassis reaches the end of the plate. */
let finished = false;

function documentElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}

function showError(error: unknown): void {
  status.textContent = `错误：${error instanceof Error ? error.message : String(error)}`;
  status.classList.add('error');
}

function read(
  data: readonly { readonly sensorId: string; readonly data: SensorData }[],
  id: string,
): SensorData | undefined {
  return data.find((entry) => entry.sensorId === id)?.data;
}

function updateHud(
  readings: readonly { readonly sensorId: string; readonly data: SensorData }[],
): void {
  if (!client) return;
  const colorLeft = read(readings, 'color-left');
  const colorRight = read(readings, 'color-right');
  const front = read(readings, 'distance-front');
  const formatColor = (value: SensorData | undefined) =>
    value?.type === 'color' ? `${value.color.join(', ')} · 灰度 ${value.grayscale}` : '—';
  left.textContent = formatColor(colorLeft);
  right.textContent = formatColor(colorRight);
  distance.textContent =
    front?.type === 'distance'
      ? front.distance === null
        ? '超出范围'
        : `${front.distance.toFixed(3)} m`
      : '—';
  time.textContent = `${client.currentTime.toFixed(1)} ms`;
  steps.textContent = String(client.stepCount);
}

async function applyControl(): Promise<void> {
  if (!client) return;
  const readings = await client.readSensors();
  updateHud(readings);
  const leftData = read(readings, 'color-left');
  const rightData = read(readings, 'color-right');
  const grayLeft = leftData?.type === 'color' ? leftData.grayscale : 255;
  const grayRight = rightData?.type === 'color' ? rightData.grayscale : 255;
  // A dark line under the left sensor drives `error` positive, so the robot has drifted right and
  // must steer back to its left. Positive yaw turns left (−X), hence the negated yaw rate.
  const error = grayLeft - grayRight;
  const steer = clamp(error / 255, -1, 1);
  const speed = 0.1; // m/s
  const yawRate = -steer * 0.9; // rad/s

  // The in-memory engine has no tyre contact yet, so the wheels spin for show and the chassis is
  // driven kinematically from the real pose the host reports.
  const transforms = await client.refreshTransforms();
  const offset = chassisOffset();
  if (offset >= 0) {
    const x = transforms[offset + 12] ?? 0;
    const z = transforms[offset + 14] ?? 0;
    if (Math.abs(z) > 0.22 || Math.abs(x) > 0.15) {
      await client.setBodyVelocity('chassis', {
        linearVelocity: { x: 0, y: 0, z: 0 },
        angularVelocity: { x: 0, y: 0, z: 0 },
      });
      running = false;
      finished = true;
      return;
    }
  }

  yaw += (yawRate * STEP_MS) / 1000;
  const linearVelocity = { x: -Math.sin(yaw) * speed, y: 0, z: -Math.cos(yaw) * speed };
  await client.setBodyVelocity('chassis', {
    linearVelocity,
    angularVelocity: { x: 0, y: yawRate, z: 0 },
  });
  // The mock engine neither constrains jointed bodies nor models tyre contact, so the wheels are
  // carried along: same translational velocity plus the chassis yaw. Giving them their own rolling
  // spin would compose two non-commuting world-space rotations and make the discs visibly wobble;
  // a plain cylinder shows no spin anyway, and a real engine will derive it from contact.
  for (const wheel of ['wheel-left', 'wheel-right']) {
    await client.setBodyVelocity(wheel, {
      linearVelocity,
      angularVelocity: { x: 0, y: yawRate, z: 0 },
    });
  }
  await client.setJointTarget('joint-left', { kind: 'velocity', value: speed / 0.032 });
  await client.setJointTarget('joint-right', { kind: 'velocity', value: speed / 0.032 });
}

/** Floats per entity in a transform batch, matching `THREE.Matrix4.elements`. */
const TRANSFORM_STRIDE = 16;

/** Offset of the chassis in the transform batch, or −1 when the document has no chassis. */
function chassisOffset(): number {
  const index = sceneDocument.entities.findIndex((entity) => entity.id === 'chassis');
  return index < 0 ? -1 : index * TRANSFORM_STRIDE;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Rejects when `promise` does not settle in time. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    }),
  ]);
}

async function stepOnce(): Promise<void> {
  if (!client || pending) return;
  pending = true;
  try {
    // A reset() that disposes the client mid-step can leave the RPC unanswered; bound the wait so
    // one lost frame cannot freeze the whole demo.
    await withTimeout(client.step(STEP_MS), STEP_TIMEOUT_MS, 'scene step');
    controlCounter++;
    if (controlCounter % 3 === 0) await applyControl();
    else updateHud(await client.readSensors());
    status.textContent = running ? '运行中' : finished ? '到达赛道终点' : '已暂停';
    if (!running) return;
    status.classList.remove('error');
  } catch (error) {
    running = false;
    showError(error);
  } finally {
    pending = false;
  }
}

async function runFrameSteps(count: number): Promise<void> {
  if (drainingSteps) return;
  drainingSteps = true;
  try {
    for (let index = 0; index < count; index++) await stepOnce();
  } finally {
    drainingSteps = false;
  }
}

async function reset(): Promise<void> {
  running = false;
  accumulator = 0;
  controlCounter = 0;
  yaw = 0;
  finished = false;
  pending = false;
  drainingSteps = false;
  if (client) await client.dispose().catch(() => undefined);
  client = undefined;
  view = undefined;
  try {
    view = createThreeScene3DView({
      canvas,
      background: '#101318',
      camera: new PerspectiveCamera(45, 1, 0.01, 10),
    });
    const camera = view.camera as PerspectiveCamera;
    camera.position.set(0.42, 0.34, 0.52);
    camera.lookAt(0, 0, 0);
    view.resize?.(canvas.clientWidth || 800, canvas.clientHeight || 600);
    const worker = createScene3DHostSandbox();
    client = await Scene3DClient.create({
      document: sceneDocument,
      view,
      createHost: async ({ document: scene }) =>
        createScene3DHostProxy(worker, { document: scene }),
    });
    await client.refreshTransforms();
    updateHud(await client.readSensors());
    status.textContent = '已暂停';
    status.classList.remove('error');
  } catch (error) {
    showError(error);
  }
}

function frame(now: number): void {
  const elapsed = lastFrame === 0 ? 0 : Math.min(now - lastFrame, 250);
  lastFrame = now;
  if (running) {
    accumulator += elapsed;
    let count = 0;
    while (accumulator >= STEP_MS && count < MAX_STEPS_PER_FRAME) {
      accumulator -= STEP_MS;
      count++;
    }
    if (count > 0) void runFrameSteps(count);
    if (count === MAX_STEPS_PER_FRAME && accumulator >= STEP_MS) accumulator = 0;
  }
  requestAnimationFrame(frame);
}

root.querySelector<HTMLButtonElement>('#play')!.onclick = () => {
  running = true;
  status.textContent = '运行中';
};
root.querySelector<HTMLButtonElement>('#pause')!.onclick = () => {
  running = false;
  status.textContent = '已暂停';
};
root.querySelector<HTMLButtonElement>('#single')!.onclick = () => {
  running = false;
  void stepOnce();
};
root.querySelector<HTMLButtonElement>('#reset')!.onclick = () => {
  void reset();
};
window.addEventListener('resize', () => {
  view?.resize?.(canvas.clientWidth || 800, canvas.clientHeight || 600);
});
void reset();
requestAnimationFrame(frame);
