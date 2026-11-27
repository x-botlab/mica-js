import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ContributionRegistry } from '../contributions/registry';
import type { IWorkbenchExtensionContext, IWorkbenchState } from '../types';
import { ToolbarPart } from './toolbar-part';

const state: IWorkbenchState = {
  mode: 'edit',
  simulationStatus: undefined,
  busy: false,
  dirty: false,
  readOnly: false,
  canUndo: false,
  canRedo: false,
  tool: 'select',
  activeContainer: undefined,
};

function render(overrides: Partial<IWorkbenchState> = {}): string {
  return renderToStaticMarkup(
    createElement(ToolbarPart, {
      state: { ...state, ...overrides },
      registry: { toolbar: [] } as unknown as ContributionRegistry,
      context: {} as IWorkbenchExtensionContext,
      onError() {},
    }),
  );
}

describe('fused workbench simulation controls', () => {
  it('offers only Run while editing', () => {
    const html = render();
    expect(html).toContain('>运行</button>');
    expect(html).not.toContain('>编辑</button>');
    expect(html).not.toContain('>复位</button>');
  });

  it('offers Pause and Reset while running and Continue and Reset while paused', () => {
    const running = render({ mode: 'run', simulationStatus: 'running' });
    expect(running).toContain('>暂停</button>');
    expect(running).toContain('>复位</button>');
    const paused = render({ mode: 'run', simulationStatus: 'paused' });
    expect(paused).toContain('>继续</button>');
    expect(paused).toContain('>复位</button>');
    expect(paused).toContain('结束仿真并返回编辑');
  });

  it('disables controls during transitions and leaves Reset available after a fault', () => {
    expect(render({ busy: true })).toContain('disabled=""');
    const faulted = render({ mode: 'run', simulationStatus: 'faulted' });
    expect(faulted).toContain('class="is-primary" disabled=""');
    expect(faulted).toContain('<button title="结束仿真并返回编辑"');
  });
});
