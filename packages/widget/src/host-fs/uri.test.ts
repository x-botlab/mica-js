import { describe, expect, it } from 'vitest';
import { isAbsoluteHostUri, resolveHostUri } from './uri';

const BASE = 'workspace://root/dir/panel.cnv';

describe('isAbsoluteHostUri', () => {
  it('separates absolute URIs from relative references', () => {
    expect(isAbsoluteHostUri('workspace://root/panel.cnv')).toBe(true);
    expect(isAbsoluteHostUri('data:application/json,x')).toBe(true);
    expect(isAbsoluteHostUri('file:/panel.cnv')).toBe(true);
    expect(isAbsoluteHostUri('dir/panel.cnv')).toBe(false);
    expect(isAbsoluteHostUri('/panel.cnv')).toBe(false);
    expect(isAbsoluteHostUri('')).toBe(false);
    expect(isAbsoluteHostUri('1abc:panel.cnv')).toBe(false);
  });
});

describe('resolveHostUri', () => {
  it('returns an absolute URI unchanged', () => {
    expect(resolveHostUri(BASE, 'https://example.com/panel.cnv')).toBe(
      'https://example.com/panel.cnv',
    );
    expect(resolveHostUri(BASE, 'device://other/schematic.sch')).toBe(
      'device://other/schematic.sch',
    );
    expect(resolveHostUri(BASE, 'data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
  });

  it('merges a relative reference with the base directory', () => {
    expect(resolveHostUri(BASE, 'art/x.png')).toBe('workspace://root/dir/art/x.png');
    expect(resolveHostUri(BASE, 'art/nested/x.png')).toBe('workspace://root/dir/art/nested/x.png');
    expect(resolveHostUri(BASE, './art/x.png')).toBe('workspace://root/dir/art/x.png');
    expect(resolveHostUri(BASE, '../art/x.png')).toBe('workspace://root/art/x.png');
    expect(resolveHostUri(BASE, '../../../../art/x.png')).toBe('workspace://root/art/x.png');
  });

  it('replaces the path for a reference that starts with a slash', () => {
    expect(resolveHostUri(BASE, '/art/x.png')).toBe('workspace://root/art/x.png');
    expect(resolveHostUri(BASE, '/art/../x.png')).toBe('workspace://root/x.png');
    expect(resolveHostUri('file:///dir/panel.cnv', '/art/x.png')).toBe('file:///art/x.png');
    expect(resolveHostUri('demo:/dir/panel.cnv', '/art/x.png')).toBe('demo:/art/x.png');
    expect(resolveHostUri('demo:dir/panel.cnv', '/art/x.png')).toBe('demo:/art/x.png');
  });

  it('keeps a network-path reference inside the base authority', () => {
    expect(resolveHostUri(BASE, '//other/x.png')).toBe('workspace://root//other/x.png');
  });

  it('resolves relative references under an authority with an empty path', () => {
    expect(resolveHostUri('workspace://root', 'art/x.png')).toBe('workspace://root/art/x.png');
    expect(resolveHostUri('workspace://root', '#top')).toBe('workspace://root#top');
  });

  it('preserves the query and fragment of the reference', () => {
    expect(resolveHostUri(BASE, 'art/x.png?v=2#bottom')).toBe(
      'workspace://root/dir/art/x.png?v=2#bottom',
    );
    expect(resolveHostUri(`${BASE}?x=1#top`, '?v=2')).toBe('workspace://root/dir/panel.cnv?v=2');
    expect(resolveHostUri(`${BASE}?x=1#top`, '#section')).toBe(
      'workspace://root/dir/panel.cnv?x=1#section',
    );
    expect(resolveHostUri(`${BASE}?x=1#top`, '')).toBe('workspace://root/dir/panel.cnv?x=1');
  });

  it('drops the base query when the reference names a path', () => {
    expect(resolveHostUri(`${BASE}?x=1#top`, 'art/x.png')).toBe('workspace://root/dir/art/x.png');
    expect(resolveHostUri(`${BASE}?x=1`, '/art/x.png')).toBe('workspace://root/art/x.png');
  });

  it('keeps the case of the scheme, authority and path', () => {
    expect(resolveHostUri('Workspace://Root/Dir/Panel.cnv', 'Art/X.png')).toBe(
      'Workspace://Root/Dir/Art/X.png',
    );
  });

  it('resolves relative references for a base without an authority', () => {
    expect(resolveHostUri('demo:dir/panel.cnv', 'art/x.png')).toBe('demo:dir/art/x.png');
    expect(resolveHostUri('demo:/dir/panel.cnv', 'art/x.png')).toBe('demo:/dir/art/x.png');
    expect(resolveHostUri('demo:/dir/panel.cnv', '../art/x.png')).toBe('demo:/art/x.png');
  });

  it('normalizes dot segments in the base directory', () => {
    expect(resolveHostUri('workspace://root/dir/./panel.cnv', 'art/x.png')).toBe(
      'workspace://root/dir/art/x.png',
    );
    expect(resolveHostUri('workspace://root/dir/sub/../panel.cnv', 'art/x.png')).toBe(
      'workspace://root/dir/art/x.png',
    );
  });

  it('rejects a base that is not an absolute URI', () => {
    expect(() => resolveHostUri('dir/panel.cnv', 'art/x.png')).toThrow(TypeError);
    expect(() => resolveHostUri('', 'art/x.png')).toThrow(TypeError);
  });
});
