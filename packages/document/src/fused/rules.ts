/** Lexical rules of device identity, versions, paths and member names (RFC 0020 / RFC 0024). */

const NAME_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEVICE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const INTEGRITY = /^sha256:[0-9a-f]{64}$/;
const MEMBER_KEY = /^[A-Za-z][A-Za-z0-9]*$/;
const EVENT_KEY = /^onDid[A-Z][A-Za-z0-9]*$/;
const PIN_ID = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CODICON = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const DESIGNATOR_PREFIX = /^[A-Za-z][A-Za-z0-9]*$/;
const EXTENSION = /^\.[A-Za-z0-9]+$/;
const COLOR = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const DRIVE_LETTER = /^[A-Za-z]:/;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
/** True when the text carries C0 or DEL control characters. */
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** Publisher namespace or device name segment; defaults to `U` for designator prefixes. */
export function isNameSegment(value: string): boolean {
  return NAME_SEGMENT.test(value);
}

/** Full `publisher:name` device id (RFC 0020). */
export function isDeviceId(value: string): boolean {
  return DEVICE_ID.test(value);
}

/** Problem of a `publisher:name` device id, or `undefined` when it is well formed. */
export function deviceIdProblem(value: string): string | undefined {
  if (value.length === 0) {
    return 'must not be empty';
  }
  return isDeviceId(value)
    ? undefined
    : 'must be a "publisher:name" pair of lowercase dash-separated segments';
}

/** Full SemVer version, including prerelease and build metadata (RFC 0020). */
export function isSemVer(value: string): boolean {
  return SEMVER.test(value);
}

/** Release identity or file digest: `sha256:` plus 64 lowercase hex digits (RFC 0020). */
export function isIntegrity(value: string): boolean {
  return INTEGRITY.test(value);
}

/** Property, method, public type and view id key (RFC 0020). */
export function isMemberKey(value: string): boolean {
  return MEMBER_KEY.test(value);
}

/** Event key in `onDidXxx` form (RFC 0020 / RFC 0021). */
export function isEventKey(value: string): boolean {
  return EVENT_KEY.test(value);
}

/** Model pin name, matching the DDL identifier form (RFC 0021). */
export function isPinId(value: string): boolean {
  return PIN_ID.test(value);
}

/** VS Code Codicons name supplied by the editor (RFC 0020). */
export function isCodiconName(value: string): boolean {
  return CODICON.test(value);
}

/** Reference designator prefix (RFC 0020). */
export function isDesignatorPrefix(value: string): boolean {
  return DESIGNATOR_PREFIX.test(value);
}

/** `binary` extension filter entry, e.g. `.bin` (RFC 0020). */
export function isExtensionFilter(value: string): boolean {
  return EXTENSION.test(value);
}

/** `#RRGGBB` / `#RRGGBBAA` color (RFC 0009). */
export function isColor(value: string): boolean {
  return COLOR.test(value);
}

/**
 * Package-root relative POSIX file path problem, or `undefined` when it is well formed.
 *
 * Case sensitivity, empty segments, `.` / `..`, backslashes and absolute paths are rejected
 * (RFC 0020).
 */
export function packagePathProblem(path: string): string | undefined {
  return relativePathProblem(path, 'package root');
}

/** Project-root relative POSIX file path problem, or `undefined` when it is well formed. */
export function projectPathProblem(path: string): string | undefined {
  return relativePathProblem(path, 'project root');
}

function relativePathProblem(path: string, root: string): string | undefined {
  if (path.length === 0) {
    return 'must not be empty';
  }
  if (path.startsWith('/')) {
    return `must be relative to the ${root}, not absolute`;
  }
  if (DRIVE_LETTER.test(path)) {
    return 'must not carry a drive letter';
  }
  if (URL_SCHEME.test(path)) {
    return 'must not be a URL';
  }
  if (path.includes('\\')) {
    return 'must use POSIX separators';
  }
  if (hasControlCharacters(path)) {
    return 'must not contain control characters';
  }
  const segments = path.split('/');
  if (segments[segments.length - 1] === '') {
    return 'must name a file, not a directory';
  }
  for (const segment of segments) {
    if (segment.length === 0) {
      return 'must not contain empty segments';
    }
    if (segment === '.' || segment === '..') {
      return `must not contain "${segment}" segments`;
    }
  }
  return undefined;
}

/** Problem of a file name that must end in one of `extensions`, or `undefined` when it does. */
export function extensionProblem(path: string, extensions: readonly string[]): string | undefined {
  const lower = path.toLowerCase();
  const expected = extensions.map((extension) => extension.toLowerCase());
  return expected.some((extension) => lower.endsWith(extension))
    ? undefined
    : `must name a ${extensions.join(' or ')} file`;
}

/** `sha256:` digest problem of a release identity or file digest, or `undefined` when valid. */
export function integrityProblem(value: string): string | undefined {
  return isIntegrity(value)
    ? undefined
    : 'must be "sha256:" followed by 64 lowercase hexadecimal digits';
}

/** Normalizes `#RRGGBB` / `#RRGGBBAA` to upper case; `undefined` when the text is not a color. */
export function normalizeColor(value: string): string | undefined {
  return isColor(value) ? value.toUpperCase() : undefined;
}
