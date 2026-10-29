import type { PackageFiles } from './package/load';

export interface MemoryFilesOptions {
  readonly label?: string;
  /** Collects every path that was read, including failed reads. */
  readonly reads?: string[];
}

/** Builds an in-memory package file source; missing paths reject like a file system would. */
export function createMemoryFiles(
  entries: Readonly<Record<string, string | Uint8Array>>,
  options: MemoryFilesOptions = {},
): PackageFiles {
  const encoder = new TextEncoder();
  return {
    label: options.label ?? 'memory-package',
    async read(path) {
      options.reads?.push(path);
      const entry = entries[path];
      if (entry === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return typeof entry === 'string' ? encoder.encode(entry) : entry;
    },
  };
}

export const DEMO_MANIFEST = {
  name: 'demo-package',
  version: '1.2.3',
  widgets: {
    indicator: {
      path: 'widgets/indicator.json',
      displayName: '指示灯',
      description: '亮度指示',
    },
    gauge: { path: 'widgets/gauge.json' },
  },
};

export const INDICATOR_DEFINITION = {
  properties: {
    color: { type: 'color', default: '#22AA55FF' },
  },
  ports: {
    brightness: { direction: 'input', type: 'number' },
  },
};

export const GAUGE_DEFINITION = {
  properties: {},
  ports: {
    value: { direction: 'output', type: 'number', title: '读数' },
  },
};

export const INDICATOR_CODE = 'export default function indicator() {\n  return 1;\n}\n';
export const GAUGE_CODE = 'export default () => 2;\n';

/** A complete package with two widgets, ready to load. */
export function demoEntries(): Record<string, string> {
  return {
    'package.json': JSON.stringify(DEMO_MANIFEST),
    'widgets/indicator.json': JSON.stringify(INDICATOR_DEFINITION),
    'widgets/indicator.js': INDICATOR_CODE,
    'widgets/gauge.json': JSON.stringify(GAUGE_DEFINITION),
    'widgets/gauge.js': GAUGE_CODE,
  };
}
