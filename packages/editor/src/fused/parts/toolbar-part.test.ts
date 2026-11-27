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
    expect(html).not.toContain('>停止</button>');
    expect(html).not.toContain('>重启</button>');
  });

  it('offers Stop and Restart throughout the run session', () => {
    for (const simulationStatus of ['running', 'paused', 'faulted'] as const) {
      const html = render({ mode: 'run', simulationStatus });
      expect(html).toContain('codicon-debug-stop');
      expect(html).toContain('>停止</button>');
      expect(html).toContain('codicon-debug-restart');
      expect(html).toContain('<button title="重启仿真"');
      expect(html).toContain('>重启</button>');
      expect(html).not.toContain('>继续</button>');
      expect(html).not.toContain('>暂停</button>');
    }
  });

  it('disables controls during transitions and keeps Stop available after a fault', () => {
    expect(render({ busy: true })).toContain('disabled=""');
    const faulted = render({ mode: 'run', simulationStatus: 'faulted' });
    expect(faulted).not.toContain('class="is-primary" disabled=""');
    expect(faulted).toContain('<button title="重启仿真"');
  });
});
