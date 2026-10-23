/** Which of the `a`–`g` segments each character lights. */
const DIGIT_SEGMENTS = {
  0: 'abcdef',
  1: 'bc',
  2: 'abdeg',
  3: 'abcdg',
  4: 'bcfg',
  5: 'acdfg',
  6: 'acdefg',
  7: 'abc',
  8: 'abcdefg',
  9: 'abcdfg',
  '-': 'g',
  ' ': '',
};

const BACKGROUND = 'rgba(9, 9, 11, 0.85)';
const OFF_COLOR = 'rgba(148, 163, 184, 0.09)';
const FALLBACK_COLOR = '#FF3B30';

const DEFAULT_DIGITS = 4;
/** Stroke width of a real 0.56-inch display, as a fraction of the digit height. */
const DEFAULT_THICKNESS = 0.13;
/** Share of a digit cell left empty on both sides, so neighbours do not touch. */
const DEFAULT_SPACING = 0.16;
/** Width / height of one digit: a real display is clearly taller than it is wide. */
const DIGIT_ASPECT = 0.58;
/** Share of the widget height the glyph may use. */
const HEIGHT_FILL = 0.9;

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

/** A horizontal segment: a bar whose ends are cut at 45°, as on a real display. */
function horizontalBar(context, left, right, center, thickness) {
  const half = thickness / 2;
  context.beginPath();
  context.moveTo(left, center);
  context.lineTo(left + half, center - half);
  context.lineTo(right - half, center - half);
  context.lineTo(right, center);
  context.lineTo(right - half, center + half);
  context.lineTo(left + half, center + half);
  context.closePath();
}

/** The same bar rotated 90°, so the bevel stays along the segment axis. */
function verticalBar(context, center, top, bottom, thickness) {
  const half = thickness / 2;
  context.beginPath();
  context.moveTo(center, top);
  context.lineTo(center + half, top + half);
  context.lineTo(center + half, bottom - half);
  context.lineTo(center, bottom);
  context.lineTo(center - half, bottom - half);
  context.lineTo(center - half, top + half);
  context.closePath();
}

function drawDigit(context, left, top, width, height, thickness, character, color) {
  const lit = DIGIT_SEGMENTS[character] ?? '';
  const half = thickness / 2;
  // The gap scales with the stroke: a display with thicker segments also separates them further.
  const gap = thickness * 0.22;
  const right = left + width;
  const bottom = top + height;
  const middle = top + height / 2;
  const innerLeft = left + half + gap;
  const innerRight = right - half - gap;

  const bars = [
    { name: 'a', axis: 'x', from: innerLeft, to: innerRight, at: top + half },
    { name: 'g', axis: 'x', from: innerLeft, to: innerRight, at: middle },
    { name: 'd', axis: 'x', from: innerLeft, to: innerRight, at: bottom - half },
    { name: 'f', axis: 'y', from: top + half + gap, to: middle - gap, at: left + half },
    { name: 'e', axis: 'y', from: middle + gap, to: bottom - half - gap, at: left + half },
    { name: 'b', axis: 'y', from: top + half + gap, to: middle - gap, at: right - half },
    { name: 'c', axis: 'y', from: middle + gap, to: bottom - half - gap, at: right - half },
  ];

  for (const bar of bars) {
    if (bar.to <= bar.from) continue;
    context.fillStyle = lit.includes(bar.name) ? color : OFF_COLOR;
    if (bar.axis === 'x') {
      horizontalBar(context, bar.from, bar.to, bar.at, thickness);
    } else {
      verticalBar(context, bar.at, bar.from, bar.to, thickness);
    }
    context.fill();
  }
}

/** Every position of a real display has its own decimal point; only the lit ones show. */
function drawPoint(context, left, top, width, height, thickness, lit, color) {
  context.fillStyle = lit ? color : OFF_COLOR;
  context.fillRect(left + width - thickness, top + height - thickness, thickness, thickness);
}

/**
 * Turns the payload into one entry per glyph, right alignment included. A `.` belongs to the glyph
 * before it, the way a real display lights its decimal point instead of spending a whole digit.
 */
function layout(text, digits) {
  const cells = [];
  for (const character of text) {
    if (character === '.' && cells.length > 0) {
      cells[cells.length - 1].dot = true;
      continue;
    }
    cells.push({ character, dot: false });
  }
  const visible = cells.slice(-digits);
  return { cells: visible, offset: digits - visible.length };
}

export default function segmentDisplay(api) {
  let text = '';

  api.subscribe('value', (value) => {
    text = String(value);
    api.invalidate();
  });

  return {
    render(context) {
      const width = api.width;
      const height = api.height;
      if (width <= 0 || height <= 0) return;

      const digits = Math.round(clampNumber(api.props.digits, 1, 24, DEFAULT_DIGITS));
      const color =
        typeof api.props.color === 'string' && api.props.color.length > 0
          ? api.props.color
          : FALLBACK_COLOR;
      const thickness = clampNumber(api.props.thickness, 0.04, 0.4, DEFAULT_THICKNESS);
      const spacing = clampNumber(api.props.spacing, 0, 0.7, DEFAULT_SPACING);
      const { cells, offset } = layout(text, digits);

      context.fillStyle = BACKGROUND;
      context.fillRect(0, 0, width, height);

      const cell = width / digits;
      const digitHeight = height * HEIGHT_FILL;
      const digitTop = (height - digitHeight) / 2;
      const digitWidth = Math.max(2, Math.min(cell * (1 - spacing), digitHeight * DIGIT_ASPECT));
      const stroke = Math.max(1, digitHeight * thickness);

      // Every cell paints, lit or not: unlit segments and points are what a real display shows.
      for (let index = 0; index < digits; index += 1) {
        const glyph = cells[index - offset];
        const left = index * cell + (cell - digitWidth) / 2;
        drawDigit(
          context,
          left,
          digitTop,
          digitWidth,
          digitHeight,
          stroke,
          glyph === undefined ? ' ' : glyph.character,
          color,
        );
        drawPoint(
          context,
          left,
          digitTop,
          digitWidth,
          digitHeight,
          stroke,
          glyph !== undefined && glyph.dot,
          color,
        );
      }
    },
  };
}
