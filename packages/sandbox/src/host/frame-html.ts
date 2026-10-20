import { buildFrameCsp } from './csp';
import { buildFrameDocument } from './frame-document';

/**
 * Ready to serve frame document for the `frameUrl` mode. Documents loaded from a real URL do not
 * inherit the embedding page's CSP, so apps with a strict policy only need to allow `frame-src`.
 */
export const SANDBOX_FRAME_HTML = buildFrameDocument({ csp: buildFrameCsp() });
