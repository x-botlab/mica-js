import { describe, expect, it } from 'vitest';
import { SANDBOX_FRAME_HTML } from './frame-html';
import { applyCspOverride, buildFrameCsp } from './csp';
import { buildFrameDocument } from './frame-document';

describe('frame CSP', () => {
  it('allows blob workers and inline code but blocks the network', () => {
    const csp = buildFrameCsp({ nonce: 'abc123' });

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-abc123' blob: 'unsafe-eval'");
    expect(csp).toContain('worker-src blob:');
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
  });

  it("falls back to 'unsafe-inline' for the hosted frame document", () => {
    expect(buildFrameCsp()).toContain("script-src 'unsafe-inline' blob: 'unsafe-eval'");
  });

  it('supports string and function overrides', () => {
    const base = buildFrameCsp({ nonce: 'n' });
    expect(applyCspOverride(base, 'default-src none')).toBe('default-src none');
    expect(applyCspOverride(base, (csp) => `${csp}; report-uri /r`)).toBe(`${base}; report-uri /r`);
    expect(applyCspOverride(base, undefined)).toBe(base);
  });
});

describe('frame document', () => {
  it('embeds the nonce, the CSP and the bootstrap', () => {
    const html = buildFrameDocument({ csp: buildFrameCsp({ nonce: 'nonce-1' }), nonce: 'nonce-1' });

    expect(html).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(html).toContain('script-src &#39;'.replace('&#39;', "'"));
    expect(html).toContain('<script nonce="nonce-1">');
    expect(html).toContain('mica:boot');
    expect(html).toContain('mica:frame-ready');
  });

  it('escapes attribute values', () => {
    const html = buildFrameDocument({ csp: "default-src 'none'", nonce: 'a"b' });
    expect(html).toContain('nonce="a&quot;b"');
  });

  it('never closes the bootstrap script early', () => {
    const html = buildFrameDocument({ csp: buildFrameCsp({ nonce: 'n' }), nonce: 'n' });
    const scriptBody = html.slice(html.indexOf('<script'));
    const firstClose = scriptBody.indexOf('</script>');
    const lastClose = scriptBody.lastIndexOf('</script>');
    expect(firstClose).toBe(lastClose);
  });

  it('ships a ready-to-host document without a nonce', () => {
    expect(SANDBOX_FRAME_HTML).toContain("script-src 'unsafe-inline' blob: 'unsafe-eval'");
    expect(SANDBOX_FRAME_HTML).not.toContain('nonce=');
  });
});
