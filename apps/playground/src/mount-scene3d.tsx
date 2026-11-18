import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  board,
  boardEndOf,
  bundlesOf,
  byId,
  deviceEndOf,
  MM,
  PLANE_H,
  PLANE_W,
  TERMINAL_SPEC,
  connectorOf,
  parts,
  pinOf,
  ribbonWidth,
  terminalHeight,
  type Part,
  type PinRef,
  type Point,
  type Wire,
} from './mount-demo-data';

const CORE = (x: number, y: number) =>
  new THREE.Vector3((x - PLANE_W / 2) / MM, 0, (y - PLANE_H / 2) / MM);
const BOARD_TOP = 3;
const UP = new THREE.Vector3(0, 1, 0);
/** 单根铜芯外径，用作圆线束的粗细基准。 */
const CORE_RADIUS = 0.17;
/** 不可见的拾取代理半径，保证细线也点得中。 */
const PICK_RADIUS = 1.05;
/** FPC 基材厚度 mm。 */
const RIBBON_THICKNESS = 0.32;

const SURFACE: Record<Part['kind'], number> = {
  chip: 0x333b46,
  terminal: 0x232a33,
  motor: 0x5b6572,
  servo: 0x4d5563,
  sensor: 0x3f6b74,
  camera: 0x3f4956,
};

/**
 * 真实器件模型：按最长边归一成 mm 并居中，姿态修正后按器件基准面摆放。
 * 电机本体绕 Y 转 −90° 让输出轴朝向 +X；轮胎本身就沿 X 轴，直接挂在轴端。
 */
interface PartModel {
  url: string;
  size: number;
  rotation?: [number, number, number];
  /** 模型基准面相对器件底面的抬高 mm。 */
  lift?: number;
  wheel?: { url: string; size: number; offset: [number, number, number] };
}

const PART_MODELS: Record<string, PartModel> = {
  m1: {
    url: '/models/tt-motor.glb',
    size: 70.7,
    rotation: [0, Math.PI / 2, 0],
    lift: 34.4,
    wheel: { url: '/models/tt-wheel.glb', size: 69, offset: [20.4, 0, 0] },
  },
  q1: { url: '/models/ultrasonic.glb', size: 45, rotation: [Math.PI / 2, 0, 0] },
};

const gltfCache = new Map<string, THREE.Group>();
const gltfLoading = new Set<string>();
const gltfFailed = new Set<string>();
let sharedLoader: GLTFLoader | null = null;

function modelLoader() {
  if (sharedLoader) return sharedLoader;
  const draco = new DRACOLoader();
  draco.setDecoderPath('/draco/');
  sharedLoader = new GLTFLoader();
  sharedLoader.setDRACOLoader(draco);
  return sharedLoader;
}

function requestModel(url: string, done: () => void) {
  if (gltfCache.has(url) || gltfLoading.has(url) || gltfFailed.has(url)) return;
  gltfLoading.add(url);
  modelLoader().load(
    url,
    (gltf) => {
      gltfLoading.delete(url);
      gltfCache.set(url, gltf.scene);
      done();
    },
    undefined,
    () => {
      gltfLoading.delete(url);
      gltfFailed.add(url);
      done();
    },
  );
}

/** 克隆一份模型，归一成 mm 并居中，外面套一个可旋转的壳以便摆姿态。 */
function modelInstance(url: string, size: number, rotation?: [number, number, number]) {
  const source = gltfCache.get(url);
  if (!source) return null;
  const inner = source.clone(true);
  // 克隆共享缓存的几何与材质，重建场景时不能销毁它们。
  inner.traverse((node) => {
    node.userData = { ...node.userData, shared: true };
  });
  inner.updateMatrixWorld(true);
  const extent = new THREE.Box3().setFromObject(inner).getSize(new THREE.Vector3());
  const scale = size / Math.max(extent.x, extent.y, extent.z, 0.0001);
  inner.scale.multiplyScalar(scale);
  inner.updateMatrixWorld(true);
  const center = new THREE.Box3().setFromObject(inner).getCenter(new THREE.Vector3());
  inner.position.sub(center);
  const wrapper = new THREE.Group();
  if (rotation) wrapper.rotation.set(...rotation);
  wrapper.add(inner);
  return { wrapper, size: extent.multiplyScalar(scale) };
}
export type Selection = { kind: 'wire'; index: number } | { kind: 'part'; id: string } | null;

/**
 * 聚酰亚胺基材 + 每条芯一根印刷导体 + 两端金手指和 pin 1 标记，画一次复用。
 */
const ribbonTextures = new Map<number, THREE.CanvasTexture>();
function ribbonTexture(conductors: number) {
  const cached = ribbonTextures.get(conductors);
  if (cached) return cached;
  const pitch = 18;
  const height = 96;
  const canvas = document.createElement('canvas');
  canvas.width = conductors * pitch;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#e3ab63';
  context.fillRect(0, 0, canvas.width, height);
  context.strokeStyle = '#a9762f';
  context.lineWidth = pitch * 0.44;
  for (let index = 0; index < conductors; index += 1) {
    const x = pitch * (index + 0.5);
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }
  const gold = 13;
  context.fillStyle = '#f4d491';
  for (let index = 0; index < conductors; index += 1) {
    const x = pitch * (index + 0.5) - pitch * 0.3;
    context.fillRect(x, 0, pitch * 0.6, gold);
    context.fillRect(x, height - gold, pitch * 0.6, gold);
  }
  context.fillStyle = '#6b5127';
  context.beginPath();
  context.moveTo(pitch * 0.18, gold + 3);
  context.lineTo(pitch * 0.7, gold + 3);
  context.lineTo(pitch * 0.18, gold + 11);
  context.closePath();
  context.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  ribbonTextures.set(conductors, texture);
  return texture;
}

/**
 * 扁带几何：每个截面保持宽度轴在 X、厚度轴垂直于切线，于是可数出芯数、也能看到侧边厚度。
 * 真实 FPC 只沿一个轴弯，平面扫掠即可，不需要自由标架。
 */
function ribbonGeometry(
  curve: THREE.Curve<THREE.Vector3>,
  width: number,
  thickness: number,
  divisions = 72,
) {
  const sections = Array.from({ length: divisions + 1 }, (_, step) => {
    const t = step / divisions;
    const point = curve.getPoint(t);
    const tangent = curve.getTangent(t).normalize();
    const axis = new THREE.Vector3(1, 0, 0).addScaledVector(tangent, -tangent.x).normalize();
    const normal = new THREE.Vector3().crossVectors(tangent, axis).normalize();
    return {
      a: point
        .clone()
        .addScaledVector(axis, width / 2)
        .addScaledVector(normal, thickness / 2),
      b: point
        .clone()
        .addScaledVector(axis, -width / 2)
        .addScaledVector(normal, thickness / 2),
      c: point
        .clone()
        .addScaledVector(axis, -width / 2)
        .addScaledVector(normal, -thickness / 2),
      d: point
        .clone()
        .addScaledVector(axis, width / 2)
        .addScaledVector(normal, -thickness / 2),
      t,
    };
  });

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const quad = (
    p0: THREE.Vector3,
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    p3: THREE.Vector3,
    uv0: number[],
    uv1: number[],
    uv2: number[],
    uv3: number[],
  ) => {
    const base = positions.length / 3;
    for (const point of [p0, p1, p2, p3]) positions.push(point.x, point.y, point.z);
    uvs.push(...uv0, ...uv1, ...uv2, ...uv3);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  for (let step = 0; step < divisions; step += 1) {
    const now = sections[step]!;
    const next = sections[step + 1]!;
    quad(now.a, now.b, next.b, next.a, [1, now.t], [0, now.t], [0, next.t], [1, next.t]);
  }
  const topCount = indices.length;

  for (let step = 0; step < divisions; step += 1) {
    const now = sections[step]!;
    const next = sections[step + 1]!;
    quad(now.c, now.d, next.d, next.c, [0, now.t], [1, now.t], [1, next.t], [0, next.t]);
  }
  const bottomCount = indices.length - topCount;

  for (let step = 0; step < divisions; step += 1) {
    const now = sections[step]!;
    const next = sections[step + 1]!;
    quad(now.d, now.a, next.a, next.d, [now.t, 1], [now.t, 0], [next.t, 0], [next.t, 1]);
    quad(now.b, now.c, next.c, next.b, [now.t, 0], [now.t, 1], [next.t, 1], [next.t, 0]);
  }
  const sideCount = indices.length - topCount - bottomCount;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.addGroup(0, topCount, 0);
  geometry.addGroup(topCount, bottomCount, 1);
  geometry.addGroup(topCount + bottomCount, sideCount, 2);
  geometry.computeVertexNormals();
  return geometry;
}

function polylineLength(curve: THREE.Curve<THREE.Vector3>, samples = 96) {
  let total = 0;
  let previous = curve.getPoint(0);
  for (let step = 1; step <= samples; step += 1) {
    const point = curve.getPoint(step / samples);
    total += previous.distanceTo(point);
    previous = point;
  }
  return total;
}

/**
 * FPC 是标准长度件：先固定弧长，再用中点抬升量反解出走向。
 * 加强板段不允许弯折，所以两端各留一段直段。
 */
function fpcRoute(from: THREE.Vector3, to: THREE.Vector3, lengthMm: number, stiffener: number) {
  const direction = to.clone().sub(from);
  const unit = direction.clone().normalize();
  const build = (lift: number) => {
    const head = from.clone().addScaledVector(unit, stiffener);
    const tail = to.clone().addScaledVector(unit, -stiffener);
    const middle = head.clone().add(tail).multiplyScalar(0.5);
    middle.y += lift;
    return new THREE.CatmullRomCurve3([from.clone(), head, middle, tail, to.clone()]);
  };
  let low = 0;
  let high = 260;
  if (polylineLength(build(0)) >= lengthMm) {
    return { curve: build(0), tooShort: true, lift: 0 };
  }
  for (let step = 0; step < 22; step += 1) {
    const mid = (low + high) / 2;
    if (polylineLength(build(mid)) < lengthMm) low = mid;
    else high = mid;
  }
  return { curve: build(low), tooShort: false, lift: low };
}

interface Props {
  positions: Record<string, Point>;
  wires: Wire[];
  running: boolean;
  pending: PinRef | null;
  selected: Selection;
  onPickPin: (ref: PinRef) => void;
  onPickWire: (index: number) => void;
  onPickPart: (id: string) => void;
  onOpenBoard: () => void;
}

function disposeTree(root: THREE.Object3D) {
  root.traverse((node) => {
    if (node.userData.shared) return;
    if (node instanceof THREE.Mesh) {
      node.geometry.dispose();
      const material = node.material;
      if (Array.isArray(material)) material.forEach((item) => item.dispose());
      else material.dispose();
    }
  });
}

/** Pin anchor on the part body: board pins sit on the copper, device pins on the connector face. */
function pinAnchor(part: Part, ref: PinRef, at: Record<string, Point>) {
  const center = at[part.id]!;
  const pin = pinOf(ref);
  const base = CORE(center.x, center.y);
  return new THREE.Vector3(
    base.x + pin.dx,
    (part.onboard ? BOARD_TOP + part.h : part.h) + terminalHeight(ref),
    base.z + pin.dy,
  );
}

export function Scene3D({
  positions,
  wires,
  running,
  pending,
  selected,
  onPickPin,
  onPickWire,
  onPickPart,
  onOpenBoard,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [modelEpoch, setModelEpoch] = useState(0);
  const api = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    content: THREE.Group;
    layer: HTMLDivElement;
    pickables: THREE.Object3D[];
    animated: { mesh: THREE.Object3D; kind: Part['kind']; axis?: 'x' | 'y' }[];
    labels: { el: HTMLDivElement; anchor: THREE.Vector3 }[];
    boardMesh?: THREE.Object3D;
    orbit: { radius: number; theta: number; phi: number };
    applyCamera?: () => void;
  } | null>(null);
  const latest = useRef({ onPickPin, onPickWire, onPickPart, onOpenBoard });

  latest.current = { onPickPin, onPickWire, onPickPart, onOpenBoard };

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    element.appendChild(renderer.domElement);
    const layer = document.createElement('div');
    layer.className = 'scene-labels';
    element.appendChild(layer);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf7f9fc);
    const camera = new THREE.PerspectiveCamera(34, 1, 1, 2000);
    const content = new THREE.Group();
    scene.add(content);

    scene.add(new THREE.HemisphereLight(0xffffff, 0xdfe6ef, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(90, 150, 80);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xdce6f4, 0.8);
    fill.position.set(-110, 60, -90);
    scene.add(fill);

    const table = new THREE.Mesh(
      new THREE.PlaneGeometry(380, 300),
      new THREE.MeshStandardMaterial({ color: 0xeef2f8, roughness: 1, metalness: 0 }),
    );
    table.rotation.x = -Math.PI / 2;
    table.position.y = -0.4;
    scene.add(table);
    const grid = new THREE.GridHelper(380, 76, 0xd6deea, 0xe6ecf4);
    grid.position.y = -0.3;
    scene.add(grid);

    api.current = {
      renderer,
      scene,
      camera,
      content,
      layer,
      pickables: [],
      animated: [],
      labels: [],
      orbit: { radius: 330, theta: 0.55, phi: 1.0 },
    };

    const target = new THREE.Vector3(-6, 8, -6);
    const applyCamera = () => {
      const { radius, theta, phi } = api.current!.orbit;
      camera.position.set(
        target.x + radius * Math.sin(phi) * Math.sin(theta),
        target.y + radius * Math.cos(phi),
        target.z + radius * Math.sin(phi) * Math.cos(theta),
      );
      camera.lookAt(target);
    };
    applyCamera();
    api.current.applyCamera = applyCamera;

    const resize = () => {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      renderer.setSize(rect.width, rect.height, false);
      camera.aspect = rect.width / rect.height;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let dragging: { x: number; y: number } | null = null;
    let pressed: { id: string } | null = null;

    const toNdc = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
    };
    /** 细线靠不可见代理拾取，但代理会盖住端子顶点，所以端子优先。 */
    const pick = () => {
      const hits = raycaster.intersectObjects(api.current!.pickables, false);
      const nearest = hits[0];
      if (!nearest) return undefined;
      const pin = hits.find((hit) => hit.object.userData.kind === 'pin');
      if (pin && pin.distance - nearest.distance < 2.4) return pin;
      return nearest;
    };

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      toNdc(event);
      const hit = pick();
      if (hit?.object.userData.kind === 'pin') {
        latest.current.onPickPin(hit.object.userData.ref as PinRef);
        return;
      }
      if (hit?.object.userData.kind === 'wire') {
        latest.current.onPickWire(hit.object.userData.index as number);
        return;
      }
      // 器件体上按下先当拖动，松手没移动才算点选，这样整块板面仍可旋转。
      pressed =
        hit?.object.userData.kind === 'part' ? { id: hit.object.userData.id as string } : null;
      dragging = { x: event.clientX, y: event.clientY };
      renderer.domElement.setPointerCapture(event.pointerId);
    };
    const onMove = (event: PointerEvent) => {
      toNdc(event);
      renderer.domElement.style.cursor = pick() ? 'pointer' : dragging ? 'grabbing' : 'grab';
      if (!dragging) return;
      if (Math.hypot(event.clientX - dragging.x, event.clientY - dragging.y) > 3) pressed = null;
      const orbit = api.current!.orbit;
      orbit.theta -= (event.clientX - dragging.x) * 0.006;
      orbit.phi = Math.min(1.44, Math.max(0.22, orbit.phi - (event.clientY - dragging.y) * 0.006));
      dragging = { x: event.clientX, y: event.clientY };
      api.current!.applyCamera?.();
    };
    const onUp = () => {
      if (pressed) latest.current.onPickPart(pressed.id);
      pressed = null;
      dragging = null;
    };
    const onDouble = (event: MouseEvent) => {
      const panel = api.current?.boardMesh;
      if (!panel) return;
      toNdc(event as PointerEvent);
      if (raycaster.intersectObject(panel, false).length) latest.current.onOpenBoard();
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const orbit = api.current!.orbit;
      orbit.radius = Math.min(620, Math.max(150, orbit.radius * Math.exp(event.deltaY * 0.0012)));
      api.current!.applyCamera?.();
    };
    const canvas = renderer.domElement;
    canvas.style.cursor = 'grab';
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDouble);

    const projection = new THREE.Vector3();
    const paintLabels = () => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      for (const entry of api.current!.labels) {
        projection.copy(entry.anchor).project(camera);
        const visible = projection.z < 1;
        entry.el.style.opacity = visible ? '1' : '0';
        if (!visible) continue;
        entry.el.style.left = `${(projection.x * 0.5 + 0.5) * rect.width}px`;
        entry.el.style.top = `${(-projection.y * 0.5 + 0.5) * rect.height}px`;
      }
    };

    let frame = 0;
    const start = performance.now();
    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      const t = (now - start) / 1000;
      for (const entry of api.current?.animated ?? []) {
        if (entry.kind === 'servo') entry.mesh.rotation.y = Math.sin(t * 1.6) * 0.8;
        if (entry.kind === 'motor') {
          if (entry.axis === 'x') entry.mesh.rotation.x = t * 9;
          else entry.mesh.rotation.y = t * 9;
        }
      }
      paintLabels();
      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDouble);
      disposeTree(content);
      disposeTree(table);
      layer.remove();
      renderer.dispose();
      canvas.remove();
      api.current = null;
    };
  }, []);

  useEffect(() => {
    const state = api.current;
    if (!state) return;
    disposeTree(state.content);
    state.content.clear();
    state.layer.replaceChildren();
    state.pickables = [];
    state.animated = [];
    state.labels = [];

    const edgeMaterial = new THREE.LineBasicMaterial({
      color: 0x2b3441,
      transparent: true,
      opacity: 0.55,
    });
    const outline = (mesh: THREE.Mesh) => {
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), edgeMaterial);
      mesh.add(edges);
    };
    const highlight = (mesh: THREE.Mesh, color: number, intensity: number) => {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        const standard = material as THREE.MeshStandardMaterial;
        standard.emissive?.setHex(color);
        standard.emissiveIntensity = intensity;
      }
    };

    const center = CORE(board.x + board.w / 2, board.y + board.h / 2);
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(board.w / MM, BOARD_TOP, board.h / MM),
      new THREE.MeshStandardMaterial({ color: 0xe4efe8, roughness: 0.85, metalness: 0.02 }),
    );
    slab.position.set(center.x, BOARD_TOP / 2, center.z);
    slab.userData = { kind: 'board' };
    outline(slab);
    state.content.add(slab);
    state.boardMesh = slab;

    const gold = new THREE.MeshStandardMaterial({
      color: 0xd3ab48,
      roughness: 0.28,
      metalness: 0.92,
    });
    const nylon = new THREE.MeshStandardMaterial({
      color: 0x232a33,
      roughness: 0.62,
      metalness: 0.04,
    });
    const actuator = new THREE.MeshStandardMaterial({
      color: 0x4a5361,
      roughness: 0.5,
      metalness: 0.05,
    });
    const solder = new THREE.MeshStandardMaterial({
      color: 0xb9c2cc,
      roughness: 0.35,
      metalness: 0.8,
    });
    const pickMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const pendingMaterial = new THREE.MeshBasicMaterial({
      color: 0x4f7ad6,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    });

    /** 真实端子：塑料壳 + 金属件，线接在金属顶部而不是一个球。 */
    const buildConnector = (part: Part, connector: ReturnType<typeof connectorOf>) => {
      const refs = part.pins
        .filter((pin) => pin.connector === connector.id)
        .map((pin) => ({ device: part.id, pin: pin.id }) as PinRef);
      if (refs.length === 0) return;
      const anchors = refs.map((ref) => pinAnchor(part, ref, positions));
      const spec = TERMINAL_SPEC[connector.kind];
      const anchorY = anchors[0]!.y;
      const z = anchors[0]!.z;
      const xs = anchors.map((item) => item.x);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const span = maxX - minX;
      const pitch = connector.pitch;
      const bare = part.onboard && part.kind === 'terminal';
      const mountY = anchorY - spec.postH - (bare ? 0 : spec.housingH);
      const width = span + pitch * 1.15;

      if (!bare) {
        const housing = new THREE.Mesh(
          new THREE.BoxGeometry(width, spec.housingH, spec.depth),
          nylon,
        );
        housing.position.set((minX + maxX) / 2, mountY + spec.housingH / 2, z);
        housing.userData = { kind: 'part', id: part.id };
        outline(housing);
        state.content.add(housing);
        state.pickables.push(housing);
      }

      if (connector.kind === 'fpc') {
        // ZIF：翻盖压在触点上方，金手指从正面插进去。
        anchors.forEach((anchor) => {
          const pad = new THREE.Mesh(
            new THREE.BoxGeometry(pitch * 0.55, 0.28, spec.depth * 0.5),
            gold,
          );
          pad.position.set(anchor.x, anchorY - 0.14, z + spec.depth * 0.12);
          state.content.add(pad);
        });
        const cover = new THREE.Mesh(
          new THREE.BoxGeometry(width, 0.5, spec.depth * 0.34),
          actuator,
        );
        cover.position.set((minX + maxX) / 2, anchorY + 0.15, z - spec.depth * 0.3);
        state.content.add(cover);
      } else if (connector.gender === 'female') {
        // 排母：金属框里是插孔，端子从上方插进去。
        anchors.forEach((anchor) => {
          const rim = new THREE.Mesh(new THREE.BoxGeometry(pitch * 0.44, 0.3, pitch * 0.44), gold);
          rim.position.set(anchor.x, anchorY - 0.15, z);
          const hole = new THREE.Mesh(
            new THREE.BoxGeometry(pitch * 0.24, 0.36, pitch * 0.24),
            nylon,
          );
          hole.position.set(anchor.x, anchorY - 0.12, z);
          state.content.add(rim, hole);
        });
      } else {
        // 排针 / JST / 散线端子：方针或压接片，顶端才是接线点。
        anchors.forEach((anchor) => {
          const size = Math.min(pitch * 0.28, 0.7);
          const post = new THREE.Mesh(new THREE.BoxGeometry(size, spec.postH, size), gold);
          post.position.set(anchor.x, mountY + spec.postH / 2, z);
          const foot = new THREE.Mesh(new THREE.BoxGeometry(size * 1.5, 0.22, size * 1.5), solder);
          foot.position.set(anchor.x, mountY + 0.11, z);
          state.content.add(post, foot);
        });
      }

      refs.forEach((ref, index) => {
        const anchor = anchors[index]!;
        const isPending = pending && pending.device === ref.device && pending.pin === ref.pin;
        const hit = new THREE.Mesh(
          new THREE.BoxGeometry(
            Math.max(pitch * 0.82, 0.5),
            spec.postH + spec.housingH + 2.2,
            spec.depth + 0.6,
          ),
          pickMaterial,
        );
        hit.position.set(anchor.x, anchorY - (spec.postH + spec.housingH) / 2 + 0.4, z);
        hit.userData = { kind: 'pin', ref };
        state.content.add(hit);
        state.pickables.push(hit);

        if (isPending) {
          const ring = new THREE.Mesh(new THREE.SphereGeometry(1.7, 16, 12), pendingMaterial);
          ring.position.copy(anchor);
          state.content.add(ring);
        }
      });
    };

    for (const part of parts) {
      const at = positions[part.id]!;
      const base = CORE(at.x, at.y);
      const height = part.h;
      const isSelected = selected?.kind === 'part' && selected.id === part.id;
      const modelSpec = PART_MODELS[part.id];
      if (modelSpec) requestModel(modelSpec.url, () => setModelEpoch((value) => value + 1));
      if (modelSpec?.wheel) {
        requestModel(modelSpec.wheel.url, () => setModelEpoch((value) => value + 1));
      }
      const model = modelSpec
        ? modelInstance(modelSpec.url, modelSpec.size, modelSpec.rotation)
        : null;

      if (model && modelSpec) {
        const assembly = new THREE.Group();
        assembly.position.set(
          base.x,
          (part.onboard ? BOARD_TOP : 0) + (modelSpec.lift ?? 0),
          base.z,
        );
        assembly.add(model.wrapper);
        if (modelSpec.wheel) {
          const wheel = modelInstance(modelSpec.wheel.url, modelSpec.wheel.size);
          if (wheel) {
            wheel.wrapper.position.set(...modelSpec.wheel.offset);
            assembly.add(wheel.wrapper);
            if (running) state.animated.push({ mesh: wheel.wrapper, kind: 'motor', axis: 'x' });
          }
        }
        assembly.traverse((node) => {
          if (node instanceof THREE.Mesh) {
            node.userData = { ...node.userData, kind: 'part', id: part.id };
            state.pickables.push(node);
          }
        });
        state.content.add(assembly);
        if (isSelected) {
          const frame = new THREE.BoxHelper(assembly, 0x4f7ad6);
          state.content.add(frame);
        }
      } else {
        const body = new THREE.Mesh(
          new THREE.BoxGeometry(part.w, height, part.d),
          new THREE.MeshStandardMaterial({
            color: SURFACE[part.kind],
            roughness: 0.7,
            metalness: 0.08,
          }),
        );
        body.position.set(base.x, (part.onboard ? BOARD_TOP : 0) + height / 2, base.z);
        body.userData = { kind: 'part', id: part.id };
        outline(body);
        if (isSelected) highlight(body, 0x33517d, 0.5);
        state.content.add(body);
        state.pickables.push(body);

        if (part.kind === 'servo') {
          const horn = new THREE.Mesh(
            new THREE.BoxGeometry(part.w * 0.8, 1.4, 2.6),
            new THREE.MeshStandardMaterial({ color: 0xdbe1e9, roughness: 0.6 }),
          );
          horn.position.set(base.x, BOARD_TOP * 0 + part.h + 0.8, base.z);
          state.content.add(horn);
          state.animated.push({ mesh: horn, kind: 'servo' });
        }
        if (part.kind === 'motor') {
          const shaft = new THREE.Mesh(
            new THREE.CylinderGeometry(2.6, 2.6, 6, 16),
            new THREE.MeshStandardMaterial({ color: 0x9aa4b1, roughness: 0.5, metalness: 0.3 }),
          );
          shaft.position.set(base.x, part.h + 3, base.z);
          state.content.add(shaft);
          state.animated.push({ mesh: shaft, kind: 'motor' });
        }
      }

      for (const connector of part.connectors) buildConnector(part, connector);

      const label = document.createElement('div');
      label.className = `scene-label${isSelected ? ' is-selected' : ''}`;
      label.textContent = `${part.designator} · ${part.title}`;
      state.layer.appendChild(label);
      state.labels.push({
        el: label,
        anchor: new THREE.Vector3(base.x, (part.onboard ? BOARD_TOP : 0) + height + 1.6, base.z),
      });
    }

    const pickableWire = (object: THREE.Object3D, index: number) => {
      object.userData = { kind: 'wire', index };
      state.content.add(object);
      state.pickables.push(object);
    };
    const isSelectedWire = (index: number) => selected?.kind === 'wire' && selected.index === index;

    const tube = (
      points: THREE.Vector3[],
      radius: number,
      color: number,
      material?: THREE.Material,
    ) => {
      const curve = new THREE.CatmullRomCurve3(points);
      return new THREE.Mesh(
        new THREE.TubeGeometry(curve, 48, radius, 7, false),
        material ?? new THREE.MeshStandardMaterial({ color, roughness: 0.52, metalness: 0.02 }),
      );
    };

    for (const bundle of bundlesOf(wires, positions)) {
      const boardRefs = bundle.indexes.map((index) => boardEndOf(wires[index]!));
      const deviceRefs = bundle.indexes.map((index) => deviceEndOf(wires[index]!));
      const boardAnchors = boardRefs.map((ref) => pinAnchor(byId(ref.device), ref, positions));
      const deviceAnchors = deviceRefs.map((ref) => pinAnchor(byId(ref.device), ref, positions));
      const vertexAverage = (list: THREE.Vector3[]) =>
        list
          .reduce((sum, item) => sum.add(item), new THREE.Vector3())
          .multiplyScalar(1 / list.length);
      const from = vertexAverage(boardAnchors);
      const to = vertexAverage(deviceAnchors);

      if (bundle.form === 'ribbon') {
        const lengthMm = bundle.lengthMm ?? from.distanceTo(to);
        const stiffenerLength = Math.min(
          bundle.deviceConnector.stiffener ?? 4,
          from.distanceTo(to) * 0.24,
        );
        const { curve } = fpcRoute(from, to, lengthMm, stiffenerLength);
        const width = ribbonWidth(bundle.deviceConnector);
        const conductors = bundle.deviceConnector.contacts;
        const texture = ribbonTexture(conductors);
        const polyimide = new THREE.MeshStandardMaterial({
          color: 0xd8a45e,
          roughness: 0.78,
          metalness: 0,
        });
        const bare = new THREE.MeshStandardMaterial({ color: 0xb98a4d, roughness: 0.9 });
        const face = new THREE.MeshStandardMaterial({
          map: texture,
          roughness: 0.42,
          metalness: 0.16,
          side: THREE.DoubleSide,
        });
        const reverse = bundle.deviceConnector.contactSide === 'opposite';
        const strip = new THREE.Mesh(ribbonGeometry(curve, width, RIBBON_THICKNESS), [
          reverse ? polyimide : face,
          reverse ? face : polyimide,
          bare,
        ]);
        if (isSelectedWire(bundle.indexes[0]!)) highlight(strip, 0x2f5d9e, 0.45);
        pickableWire(strip, bundle.indexes[0]!);

        const axis = new THREE.Vector3(1, 0, 0);
        const plate = (origin: THREE.Vector3, direction: THREE.Vector3, size: number) => {
          const normal = new THREE.Vector3().crossVectors(direction, axis).normalize();
          const basis = new THREE.Matrix4().makeBasis(axis, direction, normal);
          const stiffener = new THREE.Mesh(
            new THREE.BoxGeometry(width, size, RIBBON_THICKNESS + 0.34),
            new THREE.MeshStandardMaterial({ color: 0xf2f4f7, roughness: 0.65 }),
          );
          stiffener.position.copy(origin).addScaledVector(direction, size / 2);
          stiffener.quaternion.setFromRotationMatrix(basis);
          state.content.add(stiffener);
        };
        const heading = to.clone().sub(from).normalize();
        plate(from, heading, stiffenerLength);
        plate(to, heading.clone().negate(), stiffenerLength);
        continue;
      }

      const direction = to.clone().sub(from);
      const span = direction.length();
      const unit = direction.clone().normalize();
      const perpendicular = new THREE.Vector3().crossVectors(unit, UP).normalize();
      const lead = Math.min(20, Math.max(6, span * 0.22));
      const breakFrom = from.clone().addScaledVector(unit, lead);
      const breakTo = to.clone().addScaledVector(unit, -lead);
      const middle = breakFrom.clone().add(breakTo).multiplyScalar(0.5);
      middle.y += 1.5 + span * 0.055;
      const count = bundle.indexes.length;

      bundle.indexes.forEach((index, slot) => {
        const offset = (slot - (count - 1) / 2) * CORE_RADIUS * 2.15;
        const shift = perpendicular.clone().multiplyScalar(offset);
        const points = [
          boardAnchors[slot]!.clone(),
          breakFrom.clone().add(shift),
          middle.clone().add(shift),
          breakTo.clone().add(shift),
          deviceAnchors[slot]!.clone(),
        ];
        const color = new THREE.Color(wires[index]!.color).getHex();
        const core = tube(points, CORE_RADIUS, color);
        if (isSelectedWire(index)) highlight(core, 0x2f5d9e, 0.6);
        pickableWire(core, index);

        const proxy = tube(points, PICK_RADIUS, 0xffffff, pickMaterial);
        proxy.userData = { kind: 'wire', index };
        state.content.add(proxy);
        state.pickables.push(proxy);
      });
    }

    state.animated = running ? state.animated : [];
  }, [positions, wires, running, pending, selected, modelEpoch]);

  return <div className="scene-3d" ref={host} />;
}
