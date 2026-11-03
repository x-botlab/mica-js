// @ts-check
// Static pairing for uart.ddl. These are explicit model-specific SDK generic
// projections, not imports from a supposedly generated module.
/** @typedef {import('../../../../docs/spec/contracts/host').DeviceContext<{readonly bitTime: number}, {readonly transmit: import('../../../../docs/spec/contracts/host').InputChannel<Uint8Array>}, object>} UartContext */
/** @typedef {{readonly value: number, readonly framingError: boolean, readonly unknown: boolean}} Frame */
/** @typedef {import('../../../../docs/spec/contracts/host').DeviceBatch<{readonly received: readonly import('../../../../docs/spec/contracts/host').ChannelMessage<Frame>[], readonly txDropped: readonly import('../../../../docs/spec/contracts/host').ChannelMessage<number>[]}>} UartBatch */

/**
 * Input topic uart/transmit accepts a Uint8Array (including empty/subviews).
 * SDK send validates <=16 bytes before FIFO capacity and copies that subview.
 * Bad topic payload throws in the callback (the host faults the board); a direct
 * SDK send with invalid input throws according to the host input contract.
 * uart/batch publishes the original readonly batch, retaining message ps times,
 * not just the final byte. Output publication may stage input for NEXT batch.
 * @param {UartContext} ctx
 * @returns {import('../../../../docs/spec/contracts/host').DeviceAdapter<UartBatch>}
 */
export function createUart(ctx) {
  const subscription = ctx.topics.onDidReceive((message) => {
    if (message.topic !== 'uart/transmit') return;
    if (!(message.payload instanceof Uint8Array)) {
      throw new TypeError('uart/transmit requires Uint8Array');
    }
    ctx.inputs.transmit.send(message.payload);
  });
  return {
    sync(batch) {
      ctx.topics.publish('uart/batch', batch);
    },
    dispose() {
      subscription.dispose();
    },
  };
}
