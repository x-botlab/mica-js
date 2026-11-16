import { describe, expect, it } from 'vitest';
import {
  VIEW_ENV_LABEL,
  htmlEnvironmentUrl,
  newHtmlEnvironmentId,
  parseHtmlViewBase,
} from './base-url';
import { HtmlViewError } from './protocol';

const TEMPLATE = 'https://${id}.cdn.example.com/public/0123456789abcdef/__mica_view__/';

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof HtmlViewError ? error.code : `unexpected:${String(error)}`;
  }
  throw new Error('expected the call to throw');
}

describe('parseHtmlViewBase', () => {
  it('accepts an absolute directory with one hostname label', () => {
    const base = parseHtmlViewBase(TEMPLATE, 'https://editor.example.com');
    expect(base.template).toBe(TEMPLATE);
    expect(base.deployment).toBe('https://mica-environment.cdn.example.com');
  });

  it('rejects templates that cannot give every environment its own origin', () => {
    expect(codeOf(() => parseHtmlViewBase('https://cdn.example.com/views/'))).toBe(
      'view/invalid-base-url-template',
    );
    expect(codeOf(() => parseHtmlViewBase('https://${id}.cdn.example.com/views'))).toBe(
      'view/invalid-base-url-template',
    );
    expect(codeOf(() => parseHtmlViewBase('ftp://${id}.cdn.example.com/views/'))).toBe(
      'view/invalid-base-url-template',
    );
    expect(codeOf(() => parseHtmlViewBase('https://${id}.cdn.example.com/${id}.js/'))).toBe(
      'view/invalid-base-url-template',
    );
    expect(codeOf(() => parseHtmlViewBase('https://${id}.cdn.example.com/v/?x=1'))).toBe(
      'view/invalid-base-url-template',
    );
    expect(codeOf(() => parseHtmlViewBase('https://${id}${id}.cdn.example.com/views/'))).toBe(
      'view/invalid-base-url-template',
    );
    expect(codeOf(() => parseHtmlViewBase('/views/${id}/'))).toBe('view/invalid-base-url-template');
  });

  it('rejects a deployment on the editor origin', () => {
    expect(
      codeOf(() => parseHtmlViewBase(TEMPLATE, 'https://mica-environment.cdn.example.com')),
    ).toBe('view/invalid-base-url-template');
  });
});

describe('htmlEnvironmentUrl', () => {
  it('substitutes the one label and keeps the directory', () => {
    const base = parseHtmlViewBase(TEMPLATE);
    const url = htmlEnvironmentUrl(base, 'mica-0123456789abcdef');
    expect(url.href).toBe(
      'https://mica-0123456789abcdef.cdn.example.com/public/0123456789abcdef/__mica_view__/',
    );
    expect(url.hostname.startsWith('mica-')).toBe(true);
  });

  it('refuses anything that is not a DNS label', () => {
    const base = parseHtmlViewBase(TEMPLATE);
    expect(() => htmlEnvironmentUrl(base, 'Mica:1')).toThrow(TypeError);
    expect(() => htmlEnvironmentUrl(base, '-mica')).toThrow(TypeError);
    expect(() => htmlEnvironmentUrl(base, `${'a'.repeat(64)}`)).toThrow(TypeError);
  });
});

describe('newHtmlEnvironmentId', () => {
  it('is a fresh DNS label', () => {
    const first = newHtmlEnvironmentId();
    const second = newHtmlEnvironmentId();
    expect(first).toMatch(/^mica-[0-9a-f]{16}$/);
    expect(first).not.toBe(second);
    expect(first.startsWith(VIEW_ENV_LABEL)).toBe(false);
  });
});
