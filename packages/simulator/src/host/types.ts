import type { CanvasBindingTarget, PayloadType } from '@mica-js/core/canvas';
import type { Event } from '@mica-js/core/lifecycle';
import type { SchematicDocument } from '@mica-js/core/schematic';

/** One payload a simulation published for an endpoint the canvas can bind to. */
export interface SimulationPublish {
  readonly target: CanvasBindingTarget;
  readonly payload: unknown;
  readonly simTime: number;
}

/** One endpoint of a mounted device instance, as the simulation reports it. */
export interface DeviceTopic {
  readonly symbol: string;
  /** Reference designator shown to users; informational for the canvas. */
  readonly designator?: string;
  readonly port: string;
  readonly direction: 'input' | 'output';
  readonly type: PayloadType;
  readonly title?: string;
}

/** What one {@link DeviceSimulationHost.tick} call executed. */
export interface DeviceSimTickReport {
  /** Simulation time after the step, in picoseconds. */
  readonly simTime: number;
  /** Circuit steps executed by this call. */
  readonly executed: number;
}

/**
 * Simulation the canvas runtime drives (RFC 0018).
 *
 * Every method returns a promise, so a same-thread implementation and a cross-thread one are called
 * the same way and `WidgetHost` and the simulation can live on different threads. The host owns the
 * frame clock: it calls {@link tick} with one fixed step at a time and reads the current simulation
 * time back from {@link getSimTime}, so there is exactly one authority for time.
 */
export interface DeviceSimulationHost {
  /**
   * Reads and mounts the schematic behind `uri`; `undefined` clears the runtime.
   *
   * The implementation reads the bytes through its own `fs` and resolves the `image` / `binary`
   * properties of every symbol against that schematic URI.
   */
  loadSchematic(uri: string | undefined): Promise<void>;
  /** Resets the loaded runtime to its initial state without unloading the schematic. */
  reset(): Promise<void>;
  /** Advances one fixed step of `dt` picoseconds when the widget host is in simulation mode. */
  tick(dt: number): Promise<DeviceSimTickReport>;
  /** Queues one payload for a device endpoint; consumed at the next {@link tick}. */
  deliver(target: CanvasBindingTarget, payload: unknown, simTime?: number): Promise<void>;
  /** Subscribes to device publishes; registering itself is a local operation. */
  readonly onDidPublish: Event<SimulationPublish>;
  /** Endpoints of the running devices, in schematic order. */
  getTopics(): Promise<readonly DeviceTopic[]>;
  /** Current simulation time, in picoseconds. */
  getSimTime(): Promise<number>;
  /** Schematic the runtime was built from. */
  getSchematic(): Promise<SchematicDocument | undefined>;
  /** Releases the runtime. */
  dispose(): Promise<void>;
}
