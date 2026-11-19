import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { ResourceField, programPackageCandidates, validateProgramProjects } from './program';

describe('program source selection', () => {
  it('lists only asset files matching accepted formats and derives exact directory prefixes', () => {
    const paths = [
      'assets/app/main.py',
      'assets/application/main.py',
      'assets/app/lib/module.py',
      'outside/main.bin',
      'assets/image.AXF',
      'assets/boot.ihx',
    ];
    expect(programPackageCandidates(paths, 'memory', ['elf', 'hex'])).toEqual([
      'assets/boot.ihx',
      'assets/image.AXF',
    ]);
    expect(programPackageCandidates(paths, 'filesystem')).toEqual([
      'assets',
      'assets/app',
      'assets/app/lib',
      'assets/application',
    ]);
  });
  it('rejects duplicate or malformed host project identities', () => {
    expect(() =>
      validateProgramProjects([
        { id: 'x', title: 'X' },
        { id: 'x', title: 'Y' },
      ]),
    ).toThrow('program/project-selection-failed');
    expect(() => validateProgramProjects([{ id: 'x', title: ' ' }])).toThrow(
      'program/project-selection-failed',
    );
  });
  it('retains unavailable project references and keeps opening available while editing is disabled', () => {
    const html = renderToStaticMarkup(
      createElement(ResourceField, {
        name: 'scripts',
        descriptor: { type: 'program', loader: 'filesystem' },
        value: { mode: 'project', projectId: 'missing' },
        target: { deviceId: 'test:device', property: 'scripts', loader: 'filesystem' },
        sources: undefined,
        packagePaths: [],
        snapshot: undefined,
        disabled: true,
        overridden: true,
        assets: undefined,
        validate: async () => undefined,
        commit: async () => {},
        reset() {},
        set() {},
        onOpenProject() {},
        onError() {},
      }),
    );
    expect(html).toContain('missing');
    expect(html).toContain('aria-label="打开项目"');
    expect(html).not.toContain('从模板创建项目');
    expect(html).not.toContain('aria-label="文件详情"');
  });
});
