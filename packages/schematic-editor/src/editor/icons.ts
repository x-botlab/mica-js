import type { EditorTool } from '../controller/types';

export interface ToolIcon {
  readonly tool: EditorTool;
  readonly label: string;
  /** 16×16 figure drawn with `currentColor`: stroked segments plus terminal dots. */
  readonly segments: readonly string[];
  readonly dots: readonly (readonly [number, number])[];
}

/** Toolbar entries, in display order. */
export const TOOL_ICONS: readonly ToolIcon[] = [
  {
    tool: 'wire',
    label: '导线',
    segments: ['M3.5 12.5 L12.5 3.5'],
    dots: [
      [3.5, 12.5],
      [12.5, 3.5],
    ],
  },
  {
    tool: 'power',
    label: '电源',
    segments: ['M8 14 V6', 'M4 6 H12'],
    dots: [[8, 14]],
  },
  {
    tool: 'ground',
    label: '地',
    segments: ['M8 3 V8', 'M3.5 8 H12.5', 'M5.5 11 H10.5', 'M7 14 H9'],
    dots: [[8, 3]],
  },
  {
    tool: 'label',
    label: '网络标签',
    segments: ['M8 4 V12', 'M4.5 8 L8 4 L11.5 8'],
    dots: [[8, 12]],
  },
  {
    tool: 'text',
    label: '文本',
    segments: ['M4 4 H12', 'M8 4 V12'],
    dots: [],
  },
];

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export function createToolIcon(doc: Document, icon: ToolIcon): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of icon.segments) {
    const path = doc.createElementNS(SVG_NAMESPACE, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  for (const [cx, cy] of icon.dots) {
    const circle = doc.createElementNS(SVG_NAMESPACE, 'circle');
    circle.setAttribute('cx', String(cx));
    circle.setAttribute('cy', String(cy));
    circle.setAttribute('r', '1.5');
    circle.setAttribute('fill', 'currentColor');
    circle.setAttribute('stroke', 'none');
    svg.append(circle);
  }
  return svg;
}
