import type { HostFs, HostFsErrorCode, HostFsErrorPayload } from '../index';
import {
  HostFsError,
  decodeDataUri,
  decodeDataUriText,
  isAbsoluteHostUri,
  resolveHostUri,
} from '../index';

declare const fs: HostFs;
const bytes: Promise<Uint8Array> = fs.read('workspace://root/panel.cnv');
const uri: string = resolveHostUri('workspace://root/panel.cnv', 'art/x.png');
const absolute: boolean = isAbsoluteHostUri(uri);
const inline: Uint8Array = decodeDataUri('data:text/plain,hello');
const inlineText: string = decodeDataUriText('data:text/plain,hello');

const error: HostFsError = new HostFsError('FileNotFound', uri);
const code: HostFsErrorCode = error.code;
const failedUri: string = error.uri;
const payload: HostFsErrorPayload = { code, uri: failedUri };
void [bytes, uri, absolute, inline, inlineText, payload];

// @ts-expect-error `read` always resolves to the raw bytes.
const text: Promise<string> = fs.read(uri);
void text;
// @ts-expect-error `data:` decoding yields bytes, not text.
const decodedText: string = decodeDataUri(uri);
void decodedText;
// @ts-expect-error The error code is a closed set.
new HostFsError('NotFound', uri);
