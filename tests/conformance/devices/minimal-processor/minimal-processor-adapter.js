// @ts-check
// Inject the translator produced by createProcessorTranslator with real SDK types.
// No runtime import targets declaration-only contracts or unbuilt TypeScript.

/**
 * processor/irq and processor/wake latch input notifications for the next batch.
 * processor/load accepts {bytes: Uint8Array, offset: number}; only an idle topic
 * callback may load. A sync-nested publication is rejected by the host contract.
 * Code writes do not reset PC, unblock WAIT, or restart HALT.
 * @param {import('./minimal-processor').ProcessorContext} ctx
 * @param {import('../../../../docs/spec/contracts/host').JitTranslate} translate
 * @returns {import('../../../../docs/spec/contracts/host').DeviceAdapter}
 */
export function createProcessor(ctx, translate) {
  const registration = ctx.attachJit({
    entry: 'cpu',
    code: 'code',
    pc: 'pc',
    beforeInstruction: { when: 'takeIrq', call: 'enterIrq' },
    translate,
  });
  try {
    // Binding precedes loading; slice owns the copied bytes.
    ctx.loadBytes('code', ctx.props.firmware.slice());
    const subscription = ctx.topics.onDidReceive((message) => {
      switch (message.topic) {
        case 'processor/irq':
          ctx.inputs.irq.notify();
          break;
        case 'processor/wake':
          ctx.inputs.wake.notify();
          break;
        case 'processor/load': {
          const payload = message.payload;
          if (
            typeof payload !== 'object' ||
            payload === null ||
            !('bytes' in payload) ||
            !(payload.bytes instanceof Uint8Array) ||
            !('offset' in payload) ||
            typeof payload.offset !== 'number'
          ) {
            throw new TypeError('processor/load requires {bytes: Uint8Array, offset: number}');
          }
          // Host validates integer range atomically, including empty writes.
          ctx.loadBytes('code', payload.bytes, payload.offset);
          break;
        }
      }
    });
    return {
      sync() {},
      dispose() {
        try {
          subscription.dispose();
        } finally {
          registration.dispose();
        }
      },
    };
  } catch (error) {
    registration.dispose();
    throw error;
  }
}
