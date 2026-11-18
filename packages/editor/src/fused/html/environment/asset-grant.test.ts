import { describe, expect, it } from 'vitest';
import { AssetGrantRegistry } from './asset-grant';

const SCOPE = 'https://mica-1.cdn.example.com/p/__mica_view__/';
const ROOT = '/p/__mica_view__/__mica_package__/';
const TOKEN = 'a'.repeat(32);
const PARENT = {
  id: 'client-parent',
  frameType: 'nested' as const,
  url: `${SCOPE}index.html`,
};
const CHILD = {
  id: 'client-child',
  frameType: 'nested' as const,
  url: `${SCOPE}content.html?view=${TOKEN}`,
};

function registry(): AssetGrantRegistry {
  return new AssetGrantRegistry(SCOPE);
}

function granted(): AssetGrantRegistry {
  const grants = registry();
  expect(grants.grant({ token: TOKEN, root: ROOT }, PARENT)).toBeDefined();
  return grants;
}

describe('AssetGrantRegistry', () => {
  it('serves the granting page only, until an inner frame attaches', () => {
    const grants = granted();
    expect(grants.serves('client-parent')).toBe(ROOT);
    // A second client of the same origin is refused: the environment owns exactly one grant.
    expect(grants.serves('client-child')).toBeUndefined();
    expect(grants.serves('client-other')).toBeUndefined();
    expect(grants.serves(undefined)).toBeUndefined();
  });

  it('authorizes the nested content frame that presents the grant token', () => {
    const grants = granted();
    // The real browser shape: Chrome reports `nested` for an iframe client of this directory.
    expect(grants.attach({ token: TOKEN }, CHILD)).toMatchObject({
      childClientId: 'client-child',
    });
    expect(grants.serves('client-child')).toBe(ROOT);
    // The token, not the client id, is the capability: a wrong token changes nothing.
    expect(grants.attach({ token: 'b'.repeat(32) }, CHILD)).toBeUndefined();
    expect(grants.serves('client-child')).toBe(ROOT);
    expect(
      grants.attach({ token: 'b'.repeat(32) }, { ...CHILD, id: 'client-evil' }),
    ).toBeUndefined();
    expect(grants.serves('client-evil')).toBeUndefined();
  });

  it('refuses a client whose frame type is not a nested document', () => {
    const grants = granted();
    for (const frameType of ['top-level', 'auxiliary', 'none']) {
      expect(
        grants.attach({ token: TOKEN }, { ...CHILD, id: 'client-x', frameType }),
      ).toBeUndefined();
      expect(grants.serves('client-x')).toBeUndefined();
    }
    // A browser that reports no frame type leaves the token as the only authority.
    expect(
      grants.attach({ token: TOKEN }, { id: 'client-no-frame', url: CHILD.url }),
    ).toBeDefined();
  });

  it('correlates the client URL with the deployment directory', () => {
    const grants = granted();
    const attach = (id: string, url: string) =>
      grants.attach({ token: TOKEN }, { id, frameType: 'nested', url });
    expect(attach('client-content', `${SCOPE}content.html`)).toBeDefined();
    expect(grants.serves('client-content')).toBe(ROOT);
    // Another origin and a path outside the deployment scope never join this environment.
    expect(attach('client-origin', 'https://other.example.com/content.html')).toBeUndefined();
    expect(
      attach('client-elsewhere', 'https://mica-1.cdn.example.com/p/other/content.html'),
    ).toBeUndefined();
    expect(attach('client-unparsable', 'about:blank')).toBeUndefined();
    expect(grants.serves('client-origin')).toBeUndefined();
    expect(grants.serves('client-elsewhere')).toBeUndefined();
    // A browser without a client URL keeps the token as the authority.
    expect(
      grants.attach({ token: TOKEN }, { id: 'client-no-url', frameType: 'nested' }),
    ).toBeDefined();
  });

  it('refuses an environment page that does not belong to the deployment directory', () => {
    const grants = registry();
    expect(
      grants.grant(
        { token: TOKEN, root: ROOT },
        { id: 'client-foreign', frameType: 'nested', url: 'https://other.example.com/index.html' },
      ),
    ).toBeUndefined();
    expect(grants.active).toBeUndefined();
    expect(
      grants.grant(
        { token: TOKEN, root: ROOT },
        { id: 'client-foreign', frameType: 'nested', url: `${SCOPE}../evil/index.html` },
      ),
    ).toBeUndefined();
  });

  it('refuses to authorize a client without identity', () => {
    const grants = granted();
    expect(grants.attach({ token: TOKEN }, { id: '', frameType: 'nested' })).toBeUndefined();
    expect(grants.attach({ token: TOKEN }, null)).toBeUndefined();
  });

  it('replaces a previous grant when the environment page reloads', () => {
    const grants = granted();
    grants.attach({ token: TOKEN }, CHILD);
    expect(grants.serves('client-child')).toBe(ROOT);
    expect(
      grants.grant({ token: 'c'.repeat(32), root: ROOT }, { ...PARENT, id: 'client-next' }),
    ).toBeDefined();
    expect(grants.serves('client-parent')).toBeUndefined();
    expect(grants.serves('client-child')).toBeUndefined();
    expect(grants.serves('client-next')).toBe(ROOT);
  });

  it('rejects a grant outside the deployment scope or with an unusable token and root', () => {
    const grants = registry();
    const client = PARENT;
    expect(
      grants.grant({ token: TOKEN, root: '/p/other/__mica_package__/' }, client),
    ).toBeUndefined();
    expect(grants.grant({ token: TOKEN, root: '/p/__mica_view__/' }, client)).toBeUndefined();
    expect(grants.grant({ token: TOKEN, root: `${ROOT}../escape/` }, client)).toBeUndefined();
    expect(grants.grant({ token: 'short', root: ROOT }, client)).toBeUndefined();
    expect(grants.grant({ token: TOKEN, root: `${ROOT}child` }, client)).toBeUndefined();
    expect(grants.grant({ token: TOKEN, root: ROOT }, {})).toBeUndefined();
    expect(grants.active).toBeUndefined();
  });

  it('accepts only non-root absolute paths inside the deployment', () => {
    const grants = registry();
    const client = PARENT;
    expect(
      grants.grant({ token: TOKEN, root: 'p/__mica_view__/__mica_package__/' }, client),
    ).toBeUndefined();
    expect(
      grants.grant({ token: TOKEN, root: '/p/__mica_view__/a b/__mica_package__/' }, client),
    ).toBeDefined();
    expect(
      grants.grant({ token: TOKEN, root: '/p/__mica_view__/__mica_package__/?x' }, client),
    ).toBeUndefined();
  });

  it('clears every client when the environment goes away', () => {
    const grants = granted();
    grants.attach({ token: TOKEN }, CHILD);
    grants.clear();
    expect(grants.active).toBeUndefined();
    expect(grants.serves('client-parent')).toBeUndefined();
    expect(grants.serves('client-child')).toBeUndefined();
  });
});
