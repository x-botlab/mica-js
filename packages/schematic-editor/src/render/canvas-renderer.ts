import type { Point } from '@mica-js/core/schematic';
import type { SchematicScene, SceneItem } from './scene';
import { resolveSchematicTheme, type SchematicTheme } from './theme';
import { pageToScreen, type ViewportState } from './viewport';

export interface CanvasRendererOptions {
  readonly theme?: Partial<SchematicTheme>;
}

const MAJOR_GRID_INTERVAL = 5;
/** Sub-grid lines are hidden once they get closer together than this (CSS pixels). */
const MIN_GRID_PIXELS = 4;
/** Emphasised lines are stretched to stay at least this far apart (CSS pixels). */
const MIN_MAJOR_GRID_PIXELS = 20;

/** Draws a {@link SchematicScene} onto a canvas, honoring device pixel ratio. */
export class CanvasSchematicRenderer {
  #canvas: HTMLCanvasElement;
  #context: CanvasRenderingContext2D | null;
  #theme: SchematicTheme;
  #width = 0;
  #height = 0;
  #pixelRatio = 1;

  constructor(canvas: HTMLCanvasElement, options: CanvasRendererOptions = {}) {
    this.#canvas = canvas;
    this.#context = canvas.getContext('2d');
    this.#theme = resolveSchematicTheme(options.theme);
  }

  get theme(): SchematicTheme {
    return this.#theme;
  }

  setTheme(theme: SchematicTheme): void {
    this.#theme = theme;
  }

  resize(width: number, height: number, pixelRatio = 1): void {
    this.#width = width;
    this.#height = height;
    this.#pixelRatio = pixelRatio;
    // Only the bitmap size is set here; CSS keeps ownership of the display size.
    this.#canvas.width = Math.max(1, Math.round(width * pixelRatio));
    this.#canvas.height = Math.max(1, Math.round(height * pixelRatio));
  }

  render(scene: SchematicScene, viewport: ViewportState): void {
    const context = this.#context;
    if (context === null) {
      return;
    }
    context.setTransform(this.#pixelRatio, 0, 0, this.#pixelRatio, 0, 0);
    context.clearRect(0, 0, this.#width, this.#height);

    context.fillStyle = scene.background;
    context.fillRect(0, 0, this.#width, this.#height);

    if (scene.grid !== undefined) {
      this.#drawGrid(context, scene, viewport);
    }

    for (const item of scene.items) {
      this.#drawItem(context, item, viewport);
    }
  }

  destroy(): void {
    this.#context = null;
  }

  #drawGrid(
    context: CanvasRenderingContext2D,
    scene: SchematicScene,
    viewport: ViewportState,
  ): void {
    const grid = scene.grid;
    if (grid === undefined) {
      return;
    }
    const cell = grid.size * viewport.scale;
    if (!Number.isFinite(cell) || cell <= 0) {
      return;
    }
    // Too fine to read at this zoom: drop subdivisions, then fall back to emphasised lines only.
    let subdivisions = grid.subdivisions;
    while (subdivisions > 1 && cell / subdivisions < MIN_GRID_PIXELS) {
      subdivisions = Math.max(1, Math.round(subdivisions / 2));
    }
    let step = cell / subdivisions;
    if (step < MIN_GRID_PIXELS) {
      step = cell;
    }
    let majorSpacing = cell * MAJOR_GRID_INTERVAL;
    while (majorSpacing < MIN_MAJOR_GRID_PIXELS) {
      majorSpacing *= 2;
    }
    const majorOnly = step < MIN_GRID_PIXELS;
    if (majorOnly) {
      step = majorSpacing;
    }

    const origin = pageToScreen(viewport, { x: 0, y: 0 });
    const startX = origin.x - Math.ceil(origin.x / step) * step;
    const startY = origin.y - Math.ceil(origin.y / step) * step;

    context.lineWidth = 1;
    for (let x = startX; x <= this.#width; x += step) {
      if (x < 0) {
        continue;
      }
      const major = majorOnly || isMajorGridLine(x - origin.x, majorSpacing);
      context.strokeStyle = major ? grid.major : grid.minor;
      strokeLine(
        context,
        { x: Math.round(x) + 0.5, y: 0 },
        { x: Math.round(x) + 0.5, y: this.#height },
      );
    }
    for (let y = startY; y <= this.#height; y += step) {
      if (y < 0) {
        continue;
      }
      const major = majorOnly || isMajorGridLine(y - origin.y, majorSpacing);
      context.strokeStyle = major ? grid.major : grid.minor;
      strokeLine(
        context,
        { x: 0, y: Math.round(y) + 0.5 },
        { x: this.#width, y: Math.round(y) + 0.5 },
      );
    }
  }

  #drawItem(context: CanvasRenderingContext2D, item: SceneItem, viewport: ViewportState): void {
    switch (item.kind) {
      case 'line': {
        context.strokeStyle = item.color;
        context.lineWidth = item.width;
        context.setLineDash(item.dash === undefined ? [] : [...item.dash]);
        strokeLine(context, pageToScreen(viewport, item.from), pageToScreen(viewport, item.to));
        context.setLineDash([]);
        break;
      }
      case 'polyline': {
        context.strokeStyle = item.color;
        context.lineWidth = item.width;
        context.lineJoin = 'round';
        context.lineCap = 'round';
        context.setLineDash(item.dash === undefined ? [] : [...item.dash]);
        context.beginPath();
        item.points.forEach((point, index) => {
          const screen = pageToScreen(viewport, point);
          if (index === 0) {
            context.moveTo(screen.x, screen.y);
          } else {
            context.lineTo(screen.x, screen.y);
          }
        });
        context.stroke();
        context.setLineDash([]);
        break;
      }
      case 'rect': {
        const topLeft = pageToScreen(viewport, { x: item.bounds.x, y: item.bounds.y });
        const width = item.bounds.width * viewport.scale;
        const height = item.bounds.height * viewport.scale;
        context.setLineDash(item.dash === undefined ? [] : [...item.dash]);
        if (item.fill !== undefined) {
          context.fillStyle = item.fill;
          context.fillRect(topLeft.x, topLeft.y, width, height);
        }
        if (item.stroke !== undefined) {
          context.strokeStyle = item.stroke;
          context.lineWidth = item.width;
          context.strokeRect(topLeft.x, topLeft.y, width, height);
        }
        context.setLineDash([]);
        break;
      }
      case 'circle': {
        const center = pageToScreen(viewport, item.center);
        context.beginPath();
        context.arc(
          center.x,
          center.y,
          Math.max(0.5, item.radius * viewport.scale),
          0,
          Math.PI * 2,
        );
        if (item.fill !== undefined) {
          context.fillStyle = item.fill;
          context.fill();
        }
        if (item.stroke !== undefined) {
          context.strokeStyle = item.stroke;
          context.lineWidth = item.width;
          context.stroke();
        }
        break;
      }
      case 'text': {
        const position = pageToScreen(viewport, item.position);
        context.fillStyle = item.color;
        context.font = scaleFont(item.font, viewport.scale);
        context.textAlign = item.align;
        context.textBaseline = item.baseline;
        if (item.rotation === undefined || item.rotation === 0) {
          context.fillText(item.text, position.x, position.y);
          break;
        }
        context.save();
        context.translate(position.x, position.y);
        context.rotate((item.rotation * Math.PI) / 180);
        context.fillText(item.text, 0, 0);
        context.restore();
        break;
      }
      default:
        break;
    }
  }
}

function strokeLine(context: CanvasRenderingContext2D, from: Point, to: Point): void {
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.stroke();
}

function isMajorGridLine(offset: number, spacing: number): boolean {
  if (!Number.isFinite(spacing) || spacing <= 0) {
    return false;
  }
  const remainder = Math.abs(offset % spacing);
  return remainder < 0.5 || spacing - remainder < 0.5;
}

function scaleFont(font: string, scale: number): string {
  const match = /^(\d+(?:\.\d+)?)px(.*)$/.exec(font);
  if (match === null) {
    return font;
  }
  return `${(Number(match[1]) * Math.max(scale, 0.01)).toFixed(1)}px${match[2]}`;
}
