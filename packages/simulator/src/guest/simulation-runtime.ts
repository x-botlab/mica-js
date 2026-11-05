import { startSimulationRuntimeGuest } from '../simulation-runtime/guest';

// The sandbox boot handshake transfers ports only; all application traffic uses typed RPC.
globalThis.addEventListener('message', function start(event: MessageEvent): void {
  const [port, ...ports] = event.ports;
  if (port === undefined) return;
  globalThis.removeEventListener('message', start);
  startSimulationRuntimeGuest(port, { ports });
});
