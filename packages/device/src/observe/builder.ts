import type { FunctionBuilder, IRBuilderExtension } from '@mica-js/ir';
import { isPlainRecord } from '../internal/records';
import type { ObserveEdge, ObserverRef, ObserveOperations } from '../types';
import { type ObserveCatalog, observeConfigError } from './catalog';
import { OBSERVE_EDGE_CODES, type ObserveInstructionSet } from './instructions';

const CONFIG_FIELDS = new Set(['enabled', 'edges']);

/** Lowers `b.observe` calls to the declared explicit observation configuration instruction. */
export function createObserveBuilderExtension(
  catalog: ObserveCatalog,
  instructions: () => ObserveInstructionSet,
  deviceId: string,
): IRBuilderExtension {
  return {
    namespace: 'observe',
    create(builder: FunctionBuilder): Readonly<Record<string, unknown>> {
      const operations: ObserveOperations = {
        configure(observer, config) {
          if (typeof observer !== 'object' || observer === null) {
            throw observeConfigError(deviceId, 'observe.configure requires an observer binding');
          }
          const ref = observer as ObserverRef;
          if (catalog.descriptor(ref) === undefined) {
            throw observeConfigError(
              deviceId,
              'observe.configure references an observation binding outside this device',
            );
          }
          if (!isPlainRecord(config)) {
            throw observeConfigError(deviceId, 'observe.configure requires a configuration object');
          }
          for (const field of Object.keys(config)) {
            if (!CONFIG_FIELDS.has(field)) {
              throw observeConfigError(
                deviceId,
                `observe.configure has unknown field ${JSON.stringify(field)}`,
              );
            }
          }
          const enabled = config['enabled'];
          if (typeof enabled !== 'boolean') {
            throw observeConfigError(deviceId, 'observe.configure enabled must be a boolean');
          }
          const edges = config['edges'];
          if (typeof edges !== 'string' || !Object.hasOwn(OBSERVE_EDGE_CODES, edges)) {
            throw observeConfigError(
              deviceId,
              `observe.configure edges must be "rising", "falling", or "both"`,
            );
          }
          const code = OBSERVE_EDGE_CODES[edges as ObserveEdge];
          builder.invoke(instructions().configure, [observer, enabled, code]);
          return undefined;
        },
      };
      return operations as unknown as Readonly<Record<string, unknown>>;
    },
  };
}
