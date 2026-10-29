import { describe, expect, it } from 'vitest';
import { decodeDataUri, decodeDataUriText } from './data-uri';

describe('decodeDataUri', () => {
  it('percent-decodes a payload to bytes', () => {
    expect(Array.from(decodeDataUri('data:application/octet-stream,%89PNG%0D%0A'))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a,
    ]);
  });

  it('encodes literal characters as UTF-8', () => {
    const bytes = decodeDataUri('data:image/svg+xml,<svg>指示灯</svg>');

    expect(new TextDecoder().decode(bytes)).toBe('<svg>指示灯</svg>');
  });

  it('decodes a base64 payload to bytes', () => {
    expect(Array.from(decodeDataUri('data:application/octet-stream;base64,iVBORw0KGgo='))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
  });

  it('treats a plus sign as a literal', () => {
    expect(new TextDecoder().decode(decodeDataUri('data:text/plain,a+b'))).toBe('a+b');
  });

  it('decodes an empty payload to no bytes', () => {
    expect(decodeDataUri('data:text/plain,')).toHaveLength(0);
    expect(decodeDataUri('data:text/plain;base64,')).toHaveLength(0);
  });

  it('ignores the URI fragment', () => {
    expect(new TextDecoder().decode(decodeDataUri('data:text/plain,hello#ignored'))).toBe('hello');
  });

  it('rejects a URI without a payload comma', () => {
    expect(() => decodeDataUri('data:text/plain')).toThrow(TypeError);
  });

  it('rejects a URI that is not a data: URI', () => {
    expect(() => decodeDataUri('text/plain,hello')).toThrow(TypeError);
  });

  it('rejects an undecodable base64 payload', () => {
    expect(() => decodeDataUri('data:text/plain;base64,%%%')).toThrow(TypeError);
  });

  it('rejects malformed percent-encoding', () => {
    expect(() => decodeDataUri('data:text/plain,%')).toThrow(TypeError);
    expect(() => decodeDataUri('data:text/plain,%A')).toThrow(TypeError);
    expect(() => decodeDataUri('data:text/plain,%zz')).toThrow(TypeError);
  });
});

describe('decodeDataUriText', () => {
  it('percent-decodes a text payload', () => {
    expect(decodeDataUriText('data:application/json,%7B%22a%22%3A1%7D')).toBe('{"a":1}');
  });

  it('keeps raw characters that need no encoding', () => {
    expect(decodeDataUriText('data:application/json,{"a":1}')).toBe('{"a":1}');
  });

  it('decodes a base64 payload as UTF-8', () => {
    const text = '{"label":"指示灯"}';
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);

    expect(decodeDataUriText(`data:application/json;charset=utf-8;BASE64,${btoa(binary)}`)).toBe(
      text,
    );
  });

  it('ignores the URI fragment', () => {
    expect(decodeDataUriText('data:text/plain,hello#ignored')).toBe('hello');
  });

  it('rejects a URI without a payload comma', () => {
    expect(() => decodeDataUriText('data:text/plain')).toThrow(TypeError);
  });

  it('rejects a URI that is not a data: URI', () => {
    expect(() => decodeDataUriText('text/plain,hello')).toThrow(TypeError);
  });

  it('rejects an undecodable base64 payload', () => {
    expect(() => decodeDataUriText('data:text/plain;base64,%%%')).toThrow(TypeError);
  });

  it('rejects undecodable percent-encoding', () => {
    expect(() => decodeDataUriText('data:text/plain,%E0%A4%A')).toThrow(TypeError);
  });

  it('rejects a payload that is not UTF-8', () => {
    expect(() => decodeDataUriText('data:text/plain,%FF')).toThrow(TypeError);
  });
});
