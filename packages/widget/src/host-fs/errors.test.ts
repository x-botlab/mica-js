import { describe, expect, it } from 'vitest';
import type { HostFs } from './types';
import type { HostFsErrorCode } from './errors';
import { HostFsError, fromHostFsErrorPayload, isHostFsError, toHostFsErrorPayload } from './errors';

describe('HostFsError', () => {
  it('carries the classification and the failing URI', () => {
    const error = new HostFsError('FileNotFound', 'workspace://root/missing.png');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('HostFsError');
    expect(error.code).toBe('FileNotFound');
    expect(error.uri).toBe('workspace://root/missing.png');
    expect(error.message).toContain('workspace://root/missing.png');
  });

  it('keeps an explicit message and the cause', () => {
    const cause = new Error('backend offline');
    const error = new HostFsError('Unavailable', 'workspace://root/x.sch', 'read failed', {
      cause,
    });

    expect(error.message).toBe('read failed');
    expect(error.cause).toBe(cause);
  });

  it('rebuilds the instance from its payload', () => {
    const original = new HostFsError('NoPermissions', 'workspace://root/x.sch', 'denied');
    const rebuilt = fromHostFsErrorPayload(structuredClone(toHostFsErrorPayload(original)));

    expect(rebuilt).toBeInstanceOf(HostFsError);
    expect(rebuilt.code).toBe(original.code);
    expect(rebuilt.uri).toBe(original.uri);
    expect(rebuilt.message).toBe(original.message);
  });

  it('rebuilds the default message when the payload omits it', () => {
    const rebuilt = fromHostFsErrorPayload({ code: 'NoFileSystem', uri: 'device://x.sch' });

    expect(rebuilt.message).toContain('device://x.sch');
  });

  it('rejects an unknown code', () => {
    expect(() =>
      fromHostFsErrorPayload({
        code: 'Boom' as HostFsErrorCode,
        uri: 'workspace://root/x',
      }),
    ).toThrow(TypeError);
  });

  it('narrows with isHostFsError', () => {
    expect(isHostFsError(new HostFsError('FileNotFound', 'workspace://root/x'))).toBe(true);
    expect(isHostFsError(new Error('workspace://root/x'))).toBe(false);
    expect(isHostFsError({ code: 'FileNotFound', uri: 'workspace://root/x' })).toBe(false);
    expect(isHostFsError(undefined)).toBe(false);
  });

  it('is the rejection type of a HostFs implementation', async () => {
    const fs: HostFs = {
      read: (uri) => Promise.reject(new HostFsError('FileNotFound', uri)),
    };

    await expect(fs.read('workspace://root/x.png')).rejects.toBeInstanceOf(HostFsError);
  });
});
