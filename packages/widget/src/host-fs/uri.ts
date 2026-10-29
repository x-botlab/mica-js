interface UriParts {
  readonly scheme: string | undefined;
  readonly authority: string | undefined;
  readonly path: string;
  readonly query: string | undefined;
  readonly fragment: string | undefined;
}

interface PathReference {
  readonly path: string;
  readonly query: string | undefined;
  readonly fragment: string | undefined;
}

const ABSOLUTE_URI = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Whether `uri` carries a scheme, i.e. is absolute rather than a relative reference. */
export function isAbsoluteHostUri(uri: string): boolean {
  return ABSOLUTE_URI.test(uri);
}

/** Splits a reference into path, query and fragment without interpreting leading slashes. */
function splitPath(value: string): PathReference {
  const hash = value.indexOf('#');
  const fragment = hash < 0 ? undefined : value.slice(hash + 1);
  const beforeFragment = hash < 0 ? value : value.slice(0, hash);
  const question = beforeFragment.indexOf('?');
  const query = question < 0 ? undefined : beforeFragment.slice(question + 1);
  const path = question < 0 ? beforeFragment : beforeFragment.slice(0, question);
  return { path, query, fragment };
}

function parseUri(value: string): UriParts {
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value);
  const scheme = schemeMatch?.[1];
  let rest = schemeMatch === null ? value : value.slice(schemeMatch[0].length);

  let authority: string | undefined;
  if (rest.startsWith('//')) {
    const tail = rest.slice(2);
    const end = tail.search(/[/?#]/);
    authority = end < 0 ? tail : tail.slice(0, end);
    rest = end < 0 ? '' : tail.slice(end);
  }

  const { path, query, fragment } = splitPath(rest);
  return { scheme, authority, path, query, fragment };
}

function removeLastSegment(output: string): string {
  const slash = output.lastIndexOf('/');
  return slash < 0 ? '' : output.slice(0, slash);
}

/** RFC 3986 §5.2.4: drops `.` and `..` segments without touching empty segments. */
function removeDotSegments(path: string): string {
  let input = path;
  let output = '';
  while (input.length > 0) {
    if (input.startsWith('../')) {
      input = input.slice(3);
    } else if (input.startsWith('./')) {
      input = input.slice(2);
    } else if (input.startsWith('/./')) {
      input = `/${input.slice(3)}`;
    } else if (input === '/.') {
      input = '/';
    } else if (input.startsWith('/../')) {
      input = `/${input.slice(4)}`;
      output = removeLastSegment(output);
    } else if (input === '/..') {
      input = '/';
      output = removeLastSegment(output);
    } else if (input === '.' || input === '..') {
      input = '';
    } else {
      const segment = /^\/?[^/]*/.exec(input)?.[0] ?? input;
      output += segment;
      input = input.slice(segment.length);
    }
  }
  return output;
}

/** RFC 3986 §5.3: merges a relative path with the base path. */
function mergePath(base: UriParts, referencePath: string): string {
  if (referencePath === '') return base.path;
  if (base.authority !== undefined && base.path === '') return `/${referencePath}`;
  const slash = base.path.lastIndexOf('/');
  return slash < 0 ? referencePath : `${base.path.slice(0, slash + 1)}${referencePath}`;
}

function compose(
  scheme: string,
  authority: string | undefined,
  path: string,
  query: string | undefined,
  fragment: string | undefined,
): string {
  let uri = `${scheme}:`;
  if (authority !== undefined) uri += `//${authority}`;
  uri += path;
  if (query !== undefined) uri += `?${query}`;
  if (fragment !== undefined) uri += `#${fragment}`;
  return uri;
}

/**
 * Resolves a document reference against the absolute URI of the document that contains it.
 *
 * - a reference with a scheme is an absolute URI and is returned unchanged;
 * - a reference starting with `/` replaces the path and keeps the base scheme and authority;
 * - any other reference is merged with the base directory and normalized.
 *
 * The result always keeps the scheme and authority of `baseUri`, so a `//host/path` reference
 * stays inside the base authority instead of replacing it. Hosts pass a base URI whose path is
 * not empty; a base with an authority and an empty path resolves relative references under that
 * authority.
 *
 * @throws TypeError when `baseUri` is not an absolute URI.
 */
export function resolveHostUri(baseUri: string, reference: string): string {
  const base = parseUri(baseUri);
  if (base.scheme === undefined) {
    throw new TypeError(`Host URI base must be absolute: ${baseUri}`);
  }
  if (isAbsoluteHostUri(reference)) return reference;

  const target = splitPath(reference);
  const replacesPath = reference.startsWith('/');
  const path = replacesPath
    ? removeDotSegments(target.path)
    : removeDotSegments(mergePath(base, target.path));
  const keepBaseQuery = !replacesPath && target.path === '' && target.query === undefined;
  const query = keepBaseQuery ? base.query : target.query;
  return compose(base.scheme, base.authority, path, query, target.fragment);
}
