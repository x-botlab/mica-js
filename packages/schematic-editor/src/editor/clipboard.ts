import { SCHEMATIC_CLIPBOARD_MIME } from '../model/clipboard';

/**
 * Bridge to the host clipboard. The editor keeps its own in-memory payload, so a port that throws
 * (no permission, no secure context) only costs system-clipboard interop.
 */
export interface ClipboardPort {
  /** Payload text, or `undefined` when the clipboard is empty or unreadable. */
  read(): Promise<string | undefined>;
  /** Replaces the clipboard with `text`; rejects when the host denies the write. */
  write(text: string): Promise<void>;
}

type BrowserClipboard = Pick<Clipboard, 'read' | 'readText' | 'write' | 'writeText'>;

/**
 * Asynchronous Clipboard API, preferring the editor MIME type and degrading to `text/plain`.
 * Reads resolve to `undefined` and writes reject when the API is missing, so callers fall back to
 * the editor's own buffer.
 */
export function createBrowserClipboardPort(): ClipboardPort {
  return {
    async read() {
      const clipboard = browserClipboard();
      if (clipboard === undefined) {
        return undefined;
      }
      if (typeof clipboard.read === 'function') {
        try {
          const items = await clipboard.read();
          for (const item of items) {
            const text = await readItemText(item);
            if (text !== undefined) {
              return text;
            }
          }
        } catch {
          // Custom MIME reads are permission-gated in some browsers; try plain text next.
        }
      }
      try {
        const text = await clipboard.readText();
        return text.length > 0 ? text : undefined;
      } catch {
        return undefined;
      }
    },
    async write(text) {
      const clipboard = browserClipboard();
      if (clipboard === undefined) {
        throw new Error('The Clipboard API is unavailable.');
      }
      if (typeof ClipboardItem !== 'undefined' && typeof clipboard.write === 'function') {
        try {
          await clipboard.write([
            new ClipboardItem({
              [SCHEMATIC_CLIPBOARD_MIME]: new Blob([text], { type: SCHEMATIC_CLIPBOARD_MIME }),
              'text/plain': new Blob([text], { type: 'text/plain' }),
            }),
          ]);
          return;
        } catch {
          // Some browsers reject custom MIME types; fall back to plain text.
        }
      }
      await clipboard.writeText(text);
    },
  };
}

/** Clipboard kept in memory: tests, Electron shells and hosts without clipboard permissions. */
export class MemoryClipboardPort implements ClipboardPort {
  #text: string | undefined;

  constructor(text?: string) {
    this.#text = text;
  }

  read(): Promise<string | undefined> {
    return Promise.resolve(this.#text);
  }

  write(text: string): Promise<void> {
    this.#text = text;
    return Promise.resolve();
  }
}

/** Reads the editor MIME type from a DOM clipboard event, falling back to `text/plain`. */
export function readClipboardEvent(event: ClipboardEvent): string | undefined {
  const data = event.clipboardData;
  if (data === null) {
    return undefined;
  }
  const custom = data.getData(SCHEMATIC_CLIPBOARD_MIME);
  if (custom.length > 0) {
    return custom;
  }
  const plain = data.getData('text/plain');
  return plain.length > 0 ? plain : undefined;
}

/** Writes `text` under the editor MIME type and `text/plain`, for DOM copy / cut events. */
export function writeClipboardEvent(event: ClipboardEvent, text: string): void {
  const data = event.clipboardData;
  if (data === null) {
    return;
  }
  data.setData(SCHEMATIC_CLIPBOARD_MIME, text);
  data.setData('text/plain', text);
}

function browserClipboard(): BrowserClipboard | undefined {
  const navigatorLike = (globalThis as { navigator?: { clipboard?: unknown } }).navigator;
  const clipboard = navigatorLike?.clipboard;
  return typeof clipboard === 'object' && clipboard !== null
    ? (clipboard as BrowserClipboard)
    : undefined;
}

async function readItemText(item: ClipboardItem): Promise<string | undefined> {
  for (const type of [SCHEMATIC_CLIPBOARD_MIME, 'text/plain']) {
    if (!item.types.includes(type)) {
      continue;
    }
    const text = await (await item.getType(type)).text();
    if (text.length > 0) {
      return text;
    }
  }
  return undefined;
}
