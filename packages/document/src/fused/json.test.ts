import { describe, expect, it } from 'vitest';
import { decodeStrictJson, parseStrictJson, STRICT_JSON_MAX_DEPTH } from './json';
import { parseFusedDocument } from './document';
import { parseUnifiedManifest } from './manifest';
import { catchError, codesOf, pointersOf, rfcExample, rfcExampleText } from './test-helpers';

function decodeError(text: string): ReturnType<typeof catchError> {
  return catchError(() => parseStrictJson(text));
}

describe('parseStrictJson', () => {
  it('decodes the same values as JSON.parse', () => {
    const text = JSON.stringify(rfcExample('0024-fused-schematic.json'));

    expect(parseStrictJson(text)).toEqual(JSON.parse(text));
  });

  it('decodes escapes, unicode and number forms like JSON.parse', () => {
    const text =
      '{"s":"a\\"b\\\\c\\\\/d\\\\b\\\\f\\\\n\\\\r\\\\te","u":"\\u00e9\\ud83d\\ude00",' +
      '"n":[-0,1e3,-1.5E-2,12345678901234567890],"o":{},"a":[],"true":true,"nil":null}';

    expect(parseStrictJson(text)).toEqual(JSON.parse(text));
  });

  it('rejects a key that is repeated in one object', () => {
    const error = decodeError('{"version": 2, "version": 3}');

    expect(codesOf(error)).toEqual(['json/duplicate-key']);
    expect(pointersOf(error)).toEqual(['/version']);
  });

  it('rejects keys that only differ by their escape form', () => {
    const error = decodeError('{"publisher": "a", "\\u0070ublisher": "b"}');

    expect(codesOf(error)).toEqual(['json/duplicate-key']);
    expect(pointersOf(error)).toEqual(['/publisher']);
  });

  it('reports duplicates through nested objects and arrays', () => {
    const error = decodeError('{"outer": {"inner": {"a": 1, "a": 2}}}');
    expect(codesOf(error)).toEqual(['json/duplicate-key']);
    expect(pointersOf(error)).toEqual(['/outer/inner/a']);

    const arrayError = decodeError('{"list": [{"k": 1}, {"k": 2, "k": 3}]}');
    expect(codesOf(arrayError)).toEqual(['json/duplicate-key']);
    expect(pointersOf(arrayError)).toEqual(['/list/1/k']);
  });

  it('reports every duplicate in one object', () => {
    const error = decodeError('{"a": 1, "a": 2, "b": 3, "b": 4}');

    expect(codesOf(error)).toEqual(['json/duplicate-key', 'json/duplicate-key']);
    expect(pointersOf(error)).toEqual(['/a', '/b']);
  });

  it('allows the same key in sibling objects and keys that differ in case', () => {
    const text = '{"x": {"a": 1, "A": 2}, "y": {"a": 3}, "a ": 4}';

    expect(parseStrictJson(text)).toEqual(JSON.parse(text));
  });

  it('escapes pointer segments of the offending key', () => {
    const error = decodeError('{"a/b": 1, "a/b": 2}');

    expect(pointersOf(error)).toEqual(['/a~1b']);
  });

  it('rejects malformed text', () => {
    expect(codesOf(decodeError('{"a": 1,}'))).toEqual(['json/invalid']);
    expect(codesOf(decodeError('{"a" 1}'))).toEqual(['json/invalid']);
    expect(codesOf(decodeError('{"a": 1}x'))).toEqual(['json/invalid']);
    expect(codesOf(decodeError(''))).toEqual(['json/invalid']);
  });

  it('rejects nesting deeper than the reader supports', () => {
    const text = '['.repeat(STRICT_JSON_MAX_DEPTH + 2) + ']'.repeat(STRICT_JSON_MAX_DEPTH + 2);
    const error = decodeError(text);

    expect(codesOf(error)).toEqual(['json/invalid']);
  });

  it('exposes a non-throwing decode', () => {
    const failure = decodeStrictJson('{"a": 1, "a": 2}');

    expect(failure.ok).toBe(false);
    expect(failure.ok ? [] : failure.diagnostics.map((entry) => entry.code)).toEqual([
      'json/duplicate-key',
    ]);

    const success = decodeStrictJson('{"a": 1}');
    expect(success.ok).toBe(true);
  });
});

describe('strict JSON in the parsers', () => {
  it('rejects duplicate keys in manifest text', () => {
    const text = `{
      "publisher": "example",
      "name": "button",
      "version": "1.0.0",
      "engines": { "mica": "^1.0.0" },
      "displayName": "First",
      "displayName": "Second"
    }`;
    const error = catchError(() => parseUnifiedManifest(text));

    expect(codesOf(error)).toEqual(['json/duplicate-key']);
    expect(pointersOf(error)).toEqual(['/displayName']);
  });

  it('rejects duplicate keys in document text', () => {
    const text = `{
      "version": 2,
      "dependencies": {},
      "instances": [],
      "nodes": [],
      "wires": [],
      "labels": [],
      "references": [],
      "display": { "body": true, "body": false }
    }`;
    const error = catchError(() => parseFusedDocument(text));

    expect(codesOf(error)).toEqual(['json/duplicate-key']);
    expect(pointersOf(error)).toEqual(['/display/body']);
  });

  it('parses the RFC examples from their source text', () => {
    const manifest = parseUnifiedManifest(rfcExampleText('0020-device-package.json'));
    expect(manifest.publisher).toBe('example');
    expect(manifest.model?.entry).toBe('model.js');

    const document = parseFusedDocument(rfcExampleText('0024-fused-schematic.json'));
    expect(document.version).toBe(2);
    expect(document.instances).toHaveLength(2);
  });

  it('keeps plain-value input working and equivalent to JSON text', () => {
    const value = {
      publisher: 'example',
      name: 'button',
      version: '1.0.0',
      engines: { mica: '^1.0.0' },
      displayName: 'Button',
    };

    expect(parseUnifiedManifest(value)).toEqual(parseUnifiedManifest(JSON.stringify(value)));
  });
});
