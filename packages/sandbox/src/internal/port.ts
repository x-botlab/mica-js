/** The subset of `MessagePort` the RPC layer needs, so it can be exercised without a browser. */
export interface PortMessageEvent {
  data: unknown;
}

export interface PortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: PortMessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: PortMessageEvent) => void): void;
  close?(): void;
  start?(): void;
}
