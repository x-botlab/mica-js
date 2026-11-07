export { Quaternion, Transform, Vec3d } from './math';
export type { Vec2d } from './math';
export { BODY_TYPES, ENTITY_TYPES, GEOMETRY_TYPES, SENSOR_TYPES } from './entities';
export type {
  AssemblyInstance,
  AxisConstraint,
  BodyType,
  BoxGeometry,
  CameraConfig,
  CapsuleGeometry,
  ColliderDescriptor,
  ColorConfig,
  CylinderGeometry,
  DistanceConfig,
  EntityType,
  GeometryDescriptor,
  GPSConfig,
  IMUConfig,
  JointEntity,
  LightConfig,
  MagneticConfig,
  MaterialDescriptor,
  ModelEntity,
  MotionConstraints,
  OcclusionConfig,
  PhysicsConfig,
  PlaneGeometry,
  SceneEntity,
  SensorConfig,
  SensorEntity,
  SensorType,
  SoundConfig,
  SphereGeometry,
  TouchConfig,
} from './entities';

export {
  createMujocoRuntime,
  DEFAULT_GRAVITY,
  DEFAULT_JOINT_MAX_VELOCITY,
  JOINT_TARGET_KINDS,
  JOINT_TYPES,
  MujocoRuntime,
} from './physics';
export type {
  BodyTransform,
  JointConfig,
  JointLimits,
  JointMotorConfig,
  JointState,
  JointTarget,
  JointTargetKind,
  JointType,
  PhysicsRuntime,
  RaycastHit,
  RigidBodyConfig,
} from './physics';

export { BUILTIN_MATERIAL_PRESETS, SCENE3D_VERSION } from './format';
export type {
  AmbientLightConfig,
  DirectionalLightConfig,
  EnvironmentConfig,
  GroundConfig,
  MaterialLibrary,
  MaterialPreset,
  Scene3DDocument,
  Scene3DVersion,
  WorldConfig,
} from './format';

export { Scene3DRuntime } from './runtime';
export type { JointCommand, RuntimeOptions, TimeMs } from './runtime';

// Scene3DHost: the sandboxed simulation half of the split runtime.
export { createScene3DHost, Scene3DHost, TRANSFORM_STRIDE } from './runtime';
export {
  CIRCUIT_EVENT_JOINT_COMMAND,
  CIRCUIT_EVENT_SENSOR_DATA,
  Scene3DProtocolError,
  sceneHostGuest,
  sceneHostHost,
} from './runtime';
export type {
  CircuitJointCommand,
  CircuitSandboxContract,
  CircuitSandboxFactory,
  CircuitSandboxHandle,
  CircuitSandboxOptions,
  CircuitSensorData,
  CollisionEvent,
  Scene3DCircuitOptions,
  Scene3DHostAPI,
  Scene3DHostContract,
  Scene3DHostOptions,
  Scene3DHostProxy,
  SceneHostHostContract,
  Scene3DHostState,
  StepResult,
} from './runtime';
export { readBatchTranslation } from './runtime';

// Environment-neutral offscreen rendering contracts.
export {
  OffscreenRendererDisposedError,
  OffscreenRenderingUnavailableError,
  PIXEL_CHANNELS,
  createHeadlessRenderer,
} from './rendering';
export type {
  HeadlessCanvas,
  HeadlessRendererOptions,
  OffscreenRenderer,
  OffscreenSurface,
  WebGL2LikeContext,
} from './rendering';

export { ASSEMBLY_VERSION, validateAssemblyDefinition } from './assembly';
export type {
  AssemblyDefinition,
  AssemblyDiagnostic,
  AssemblyDiagnosticCode,
  AssemblyValidationResult,
  AssemblyVersion,
} from './assembly';

// Sensor runtime: base class, factory registry and the reading types.
export * from './sensors';
