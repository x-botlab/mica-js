/**
 * Bootstrap of the inner author frame (RFC 0023), bundled as `content.js` and loaded by the real
 * `content.html` document of the environment deployment directory.
 *
 * The environment creates this frame from that URL, so both frames share one concrete origin and
 * compare it exactly. The environment only hands on the author port the editor created for this
 * view: props, declared methods, model events, package reads and the close announcement reach the
 * editor directly, without an intermediate frame. This module installs `acquireDeviceViewApi`, the
 * bridge listeners and the package grant, then announces that it is prepared; the *environment*
 * writes the author document into this document afterwards. Author code therefore never sees a
 * missing bridge or a package request the worker cannot answer, and it never receives a
 * `MessagePort`, a host proxy or the editor DOM.
 */
import { createRpc } from '@mica-js/core/rpc';
import { messageOf } from '../../runtime/wire';
import { concreteOriginOf } from '../paths';
import { createDeviceViewSession } from '../client';
import type { IDeviceViewApi, IDeviceViewSession } from '../client';
import {
  HTML_VIEW_ATTACH,
  HTML_VIEW_ATTACH_ACK,
  HTML_VIEW_CHILD_CONNECT,
  HTML_VIEW_CHILD_HELLO,
  HTML_VIEW_CHILD_PREPARED,
  HTML_VIEW_FRAME_PARAM,
  fusedHtmlContentViewService,
  fusedHtmlHostService,
} from '../protocol';
import type {
  IHtmlViewAttachAckMessage,
  IHtmlViewAttachMessage,
  IHtmlViewChildConnectMessage,
  IHtmlViewChildHelloMessage,
  IHtmlViewChildPreparedMessage,
} from '../protocol';

/** Timing seams of the content bootstrap; production uses the defaults. */
export interface IHtmlViewContentOptions {
  readonly window?: Window;
  /** Budget of the environment handshake; defaults to 15 s. */
  readonly connectTimeoutMs?: number;
  /** Budget of the package authorization; defaults to 10 s. */
  readonly attachTimeoutMs?: number;
}

/** One-time token the environment put into the URL of this frame. */
const MIN_TOKEN_LENGTH = 16;

/**
 * Starts the author frame of one environment.
 *
 * @throws when the frame has no concrete origin or token, when the environment never hands over the
 * author port of the editor lease, when the package worker does not authorize this frame or when the
 * frame cannot announce its readiness; the environment reports the view as failed in every case.
 */
export async function startHtmlViewContent(options: IHtmlViewContentOptions = {}): Promise<void> {
  const win = options.window ?? globalThis.window;
  const origin = concreteOriginOf(win.location.href);
  if (origin === undefined)
    throw new Error('The HTML view content frame has no concrete environment origin.');
  const token = frameToken(win.location);
  if (token === undefined) throw new Error('The HTML view content frame carries no view token.');
  const port = await waitForBridge(win, token, origin, options.connectTimeoutMs ?? 15_000);
  const endpoint = createRpc(port);
  const host = endpoint.getProxy(fusedHtmlHostService);
  const identity = endpoint.getProxy(fusedHtmlContentViewService);
  const report = (code: string, text: string): void => {
    void host.reportFailure(code, text).catch(() => undefined);
  };
  try {
    const view = await identity.view();
    const bridge = createDeviceViewSession({ host, target: view.target, reportFailure: report });
    host.onDidModelEvent((event) => bridge.deliver(event));
    host.onDidClose(() => bridge.close());
    // The environment retains this entry across the document write; the author error lane is
    // installed by the environment after its `document.open()`, which clears window listeners.
    installApi(win, bridge);
    // The package worker must serve this frame before the author document exists: the first paint
    // of a view is never a package 404 that only a reload would hide.
    await attachAssets(win, view.token, options.attachTimeoutMs ?? 10_000);
    // Everything the author document needs is in place; the environment owns the write from here.
    const prepared: IHtmlViewChildPreparedMessage = { type: HTML_VIEW_CHILD_PREPARED, token };
    win.parent.postMessage(prepared, origin);
  } catch (cause) {
    report('view/load-failed', messageOf(cause));
    throw cause;
  }
}

/** Reads the one-time frame token the environment put into this frame URL. */
function frameToken(location: Location): string | undefined {
  const value = new URLSearchParams(location.search).get(HTML_VIEW_FRAME_PARAM);
  return value !== null && value.length >= MIN_TOKEN_LENGTH ? value : undefined;
}

/**
 * Waits for the environment to hand over the author port of this view.
 *
 * The port is created by the editor and only passed on here, so the peer of every call below is the
 * editor lease of this view and never the environment page.
 */
function waitForBridge(
  win: Window,
  token: string,
  origin: string,
  timeoutMs: number,
): Promise<MessagePort> {
  return new Promise((resolve, reject) => {
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            win.removeEventListener('message', onMessage);
            reject(new Error('The environment did not hand over a bridge port.'));
          }, timeoutMs)
        : undefined;
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as Partial<IHtmlViewChildConnectMessage> | null;
      if (data === null || typeof data !== 'object' || data.type !== HTML_VIEW_CHILD_CONNECT)
        return;
      if (data.token !== token) return;
      // Only the embedding environment may grant the bridge. Both frames are real documents of
      // one origin, so the origin is compared exactly.
      if (event.source !== win.parent) return;
      if (event.origin !== origin) return;
      const port = event.ports[0];
      if (port === undefined) return;
      if (timer !== undefined) clearTimeout(timer);
      win.removeEventListener('message', onMessage);
      resolve(port);
    };
    win.addEventListener('message', onMessage);
    const hello: IHtmlViewChildHelloMessage = { type: HTML_VIEW_CHILD_HELLO, token };
    win.parent.postMessage(hello, origin);
  });
}

/** Authorizes this frame in the package worker of the environment. */
async function attachAssets(win: Window, token: string, timeoutMs: number): Promise<void> {
  const container = win.navigator;
  const workers = container?.serviceWorker;
  if (workers === undefined) {
    throw new Error('This browser has no service worker support, so package files cannot load.');
  }
  const worker = await waitForController(workers, timeoutMs);
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            channel.port1.close();
            reject(new Error('The package asset worker did not authorize the view.'));
          }, timeoutMs)
        : undefined;
    channel.port1.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as Partial<IHtmlViewAttachAckMessage> | null;
      if (data === null || typeof data !== 'object' || data.type !== HTML_VIEW_ATTACH_ACK) return;
      if (data.token !== token) return;
      if (timer !== undefined) clearTimeout(timer);
      channel.port1.close();
      resolve();
    });
    channel.port1.start();
    const attach: IHtmlViewAttachMessage = { type: HTML_VIEW_ATTACH, token };
    worker.postMessage(attach, [channel.port2]);
  });
}

/** Waits until the package worker controls this frame; a fresh frame may still be claimed. */
function waitForController(
  workers: ServiceWorkerContainer,
  timeoutMs: number,
): Promise<ServiceWorker> {
  const controller = workers.controller;
  if (controller !== null) return Promise.resolve(controller);
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      const current = workers.controller;
      if (current === null) return;
      if (timer !== undefined) clearTimeout(timer);
      workers.removeEventListener('controllerchange', finish);
      resolve(current);
    };
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            workers.removeEventListener('controllerchange', finish);
            reject(new Error('The package asset worker does not control the view.'));
          }, timeoutMs)
        : undefined;
    workers.addEventListener('controllerchange', finish, { once: true });
    finish();
  });
}

function installApi(win: Window, session: IDeviceViewSession): void {
  let acquired: Promise<IDeviceViewApi> | undefined;
  const acquire = (): Promise<IDeviceViewApi> => (acquired ??= Promise.resolve(session.api));
  // The bridge entry is one-time and read-only: author code cannot replace or re-create it.
  Object.defineProperty(win, 'acquireDeviceViewApi', {
    value: acquire,
    enumerable: false,
    writable: false,
    configurable: false,
  });
}

if (typeof globalThis.window !== 'undefined' && typeof globalThis.document !== 'undefined') {
  void startHtmlViewContent().catch((cause: unknown) => {
    console.error('[@mica-js/editor] device view content failed', cause);
  });
}
