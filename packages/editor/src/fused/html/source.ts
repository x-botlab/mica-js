/**
 * Adapter from the fused runtime to the HTML view manager inputs (RFC 0023 / 0025).
 *
 * Model presence is never inferred here: the declaration of the instance device says so. A device
 * whose manifest has no `model` entry has no model even when it exposes no methods or events, and a
 * device with a model keeps its proxy even when that model declares an empty public surface. Every
 * failure of the runtime is propagated, so the workbench sees "not in a run session" or "model
 * faulted" instead of a silent `api.model === undefined`.
 */
import type { HtmlViewDefinition, UnifiedDeviceManifest } from '@mica-js/document/fused';
import type { IFusedInstancePresentation, IFusedModelClient } from '../runtime/protocol';
import type { IFusedRuntime } from '../runtime/host/types';
import { HtmlViewError } from './protocol';
import type { IHtmlViewInstance } from './host';

/** Declared HTML views and model presence of one device, normally read from its manifest. */
export interface IHtmlViewDeviceDeclaration {
  /** Declared HTML views of the device; `manifest.view ?? {}`. */
  readonly views: Readonly<Record<string, HtmlViewDefinition>>;
  /** Whether the device declares a model (`manifest.model !== undefined`; RFC 0021). */
  readonly hasModel: boolean;
}

export interface IHtmlViewSourceOptions {
  readonly runtime: IFusedRuntime;
  /**
   * Declaration of one device id.
   *
   * Return `undefined` only when the workbench does not know the device at all; an instance whose
   * declaration is missing is reported as `view/unavailable-mode` instead of a view without views.
   */
  readonly device: (deviceId: string) => IHtmlViewDeviceDeclaration | undefined;
}

/** Inputs of {@link createHtmlViewHost} backed by one runtime. */
export interface IHtmlViewRuntimeSource {
  /** Describes one prepared instance; `undefined` when it is not mounted. */
  describe(instanceId: string): IHtmlViewInstance | undefined;
  /** Proxy of the mounted model; runtime failures propagate. */
  model(instanceId: string): IFusedModelClient;
}

/** Reads the declaration of one device manifest. */
export function htmlViewDeviceDeclaration(
  manifest: Pick<UnifiedDeviceManifest, 'view' | 'model'>,
): IHtmlViewDeviceDeclaration {
  return { views: manifest.view ?? {}, hasModel: manifest.model !== undefined };
}

/** Builds the manager callbacks of one runtime. */
export function createHtmlViewRuntimeSource(
  options: IHtmlViewSourceOptions,
): IHtmlViewRuntimeSource {
  return {
    describe(instanceId) {
      const instance = presentationOf(options.runtime, instanceId);
      // No prepared presentation means the run session does not hold this instance: edit mode,
      // a cleared selection or a released session. That is a deliberate "not mounted" answer.
      if (instance === undefined) return undefined;
      const declaration = options.device(instance.device);
      if (declaration === undefined) {
        throw new HtmlViewError(
          'view/unavailable-mode',
          `The workbench has no declaration for device ${instance.device}; pass its manifest view and model through the source options.`,
          { instanceId },
        );
      }
      return {
        device: instance.device,
        lock: instance.lock,
        props: instance.props,
        methods: instance.methods,
        events: instance.events,
        hasModel: declaration.hasModel,
        views: declaration.views,
      };
    },
    model(instanceId) {
      // `model/disconnected`, `model/unknown-instance` and model faults propagate to the caller.
      return options.runtime.getModel(instanceId);
    },
  };
}

function presentationOf(
  runtime: IFusedRuntime,
  instanceId: string,
): IFusedInstancePresentation | undefined {
  return runtime.display.instances.find((entry) => entry.instanceId === instanceId);
}
