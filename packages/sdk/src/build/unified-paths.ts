import { stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

/**
 * True when `child` is `parent` itself or lies below it, using path-segment comparison so that
 * sibling directories with a shared prefix are rejected.
 */
export function isContained(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return (
    path === '' ||
    (!isAbsolute(path) && path !== '..' && !path.startsWith('..\\') && !path.startsWith('../'))
  );
}

/**
 * Validates a package-root-relative POSIX path and returns it unchanged.
 *
 * Package paths are the artifact paths declared by the manifest: no backslashes, no drive or URL
 * prefix, no empty, `.` or `..` segment, and no leading or trailing slash.
 */
export function packagePath(path: string, field: string): string {
  const invalid = (reason: string): never => {
    throw new Error(`Invalid ${field} path '${path}': ${reason}`);
  };
  if (path.length === 0) invalid('the path is empty');
  if (path.includes('\\')) invalid('package paths use forward slashes');
  if (path.startsWith('/')) invalid('the path is absolute');
  if (path.endsWith('/')) invalid('the path names a directory');
  if (/:/.test(path)) invalid('the path contains a drive or URL separator');
  for (const segment of path.split('/')) {
    if (segment.length === 0) invalid('the path contains an empty segment');
    if (segment === '.' || segment === '..') invalid(`the path contains a '${segment}' segment`);
  }
  return path;
}

/**
 * Authoring sources tried for an artifact path, in order.
 *
 * The declared artifact path wins when the source already uses it; otherwise a `.js` (or
 * `.mjs` / `.jsx`) artifact also accepts the matching TypeScript source.
 */
export function sourceCandidates(path: string): readonly string[] {
  const candidates = [path];
  if (path.endsWith('.js')) {
    const stem = path.slice(0, -'.js'.length);
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`);
  } else if (path.endsWith('.mjs')) {
    candidates.push(`${path.slice(0, -'.mjs'.length)}.mts`);
  } else if (path.endsWith('.jsx')) {
    candidates.push(`${path.slice(0, -'.jsx'.length)}.tsx`);
  }
  return candidates;
}

/** Absolute candidate paths of an artifact path inside the source directory. */
export function sourcePaths(sourceRoot: string, path: string): readonly string[] {
  return sourceCandidates(path).map((candidate) => resolveSource(sourceRoot, candidate));
}

/** Resolves a package path below the source directory without leaving it. */
export function resolveSource(sourceRoot: string, path: string): string {
  const file = resolve(sourceRoot, ...path.split('/'));
  if (!isContained(sourceRoot, file))
    throw new Error(`Source path '${path}' escapes ${sourceRoot}`);
  return file;
}

export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

/**
 * Resolves the authoring source of an artifact path.
 *
 * @throws When no candidate exists; the message lists the tried paths and the declaring field.
 */
export async function findSource(sourceRoot: string, path: string, field: string): Promise<string> {
  const candidates = sourcePaths(sourceRoot, path);
  for (const candidate of candidates) if (await isFile(candidate)) return candidate;
  const tried = candidates.map((candidate) => relative(sourceRoot, candidate)).join(', ');
  throw new Error(
    `Cannot find the source of ${field} '${path}': expected one of ${tried} inside ${sourceRoot}`,
  );
}
