/**
 * Validated `viewBaseUrlTemplate` of the HTML view environments (RFC 0023).
 *
 * The template names the deployment directory of the environment resources and carries exactly one
 * `${id}` hostname label. Every environment substitutes a fresh DNS label, so two environments never
 * share an origin and one environment can never read the storage or workers of another.
 */
import { HtmlViewError } from './protocol';

/** Placeholder of the environment id inside the template's hostname. */
export const VIEW_ENV_LABEL = '${id}';

/** Label used to validate the template around the environment id. */
const PLACEHOLDER_LABEL = 'mica-environment';

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Validated base URL of the HTML environment deployment. */
export interface IHtmlViewBase {
  /** Configured template, with its single `${id}` label retained. */
  readonly template: string;
  /** Minimum suffix shared by every environment URL, used for diagnostics only. */
  readonly deployment: string;
}

/**
 * Validates one `viewBaseUrlTemplate`.
 *
 * @throws {HtmlViewError} `view/invalid-base-url-template` when the template is not an absolute
 * HTTP(S) directory URL with one standalone `${id}` hostname label on an independent origin.
 */
export function parseHtmlViewBase(template: string, hostOrigin?: string): IHtmlViewBase {
  function fail(reason: string): never {
    throw new HtmlViewError(
      'view/invalid-base-url-template',
      `viewBaseUrlTemplate ${reason}: ${JSON.stringify(template)}`,
    );
  }
  if (typeof template !== 'string' || template.length === 0) fail('must be a non-empty string');
  if (!template.endsWith('/')) fail("must end with '/'");
  if (template.split(VIEW_ENV_LABEL).length !== 2) fail('must contain exactly one ${id} label');

  const parsed = parseUrl(template.replace(VIEW_ENV_LABEL, PLACEHOLDER_LABEL));
  if (parsed === undefined) fail('must be an absolute URL');
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail('must use HTTP or HTTPS');
  if (parsed.search !== '' || parsed.hash !== '') fail('must not carry a query or a fragment');
  if (parsed.username !== '' || parsed.password !== '') fail('must not carry credentials');
  if (!parsed.hostname.split('.').includes(PLACEHOLDER_LABEL))
    fail('must place ${id} as a complete hostname label');

  if (hostOrigin !== undefined) {
    const environment = parseUrl(template.replace(VIEW_ENV_LABEL, PLACEHOLDER_LABEL));
    if (environment !== undefined && environment.origin === hostOrigin)
      fail('must use an origin independent of the editor');
  }
  return Object.freeze({ template, deployment: parsed.origin });
}

/**
 * Environment URL of one validated base and environment id.
 *
 * @throws {TypeError} when `id` is not a DNS label; ids come from {@link newHtmlEnvironmentId}.
 */
export function htmlEnvironmentUrl(base: IHtmlViewBase, id: string): URL {
  if (!DNS_LABEL.test(id) || id.length > 63)
    throw new TypeError(`HTML view environment id must be a DNS label, received "${id}"`);
  return new URL(base.template.replace(VIEW_ENV_LABEL, id));
}

/** Fresh environment id; distinct ids give every environment its own origin. */
export function newHtmlEnvironmentId(): string {
  const bytes = new Uint8Array(8);
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.getRandomValues === 'function') webCrypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.random() * 256;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'));
  return `mica-${hex.join('')}`;
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
