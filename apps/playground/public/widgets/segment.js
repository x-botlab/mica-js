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
/** Share of a digit cell kept clear of the glyph and its decimal point. */
const DEFAULT_SPACING = 0.1;
/** Width / height of one digit: a real display is clearly taller than it is wide. */
const DIGIT_ASPECT = 0.58;
/** Share of the widget height the glyph may use. */
const HEIGHT_FILL = 0.76;
/** Size of the decimal point, and its distance from the digit, in digit-height fractions. */
const POINT_RATIO = 0.12;
const POINT_GAP_RATIO = 0.9;

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

/** Every position of a real display has its own decimal point, sitting beside the digit. */
function drawPoint(context, left, top, size, lit, color) {
  context.fillStyle = lit ? color : OFF_COLOR;
  context.fillRect(left, top, size, size);
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
      const stroke = Math.max(1, digitHeight * thickness);
      // The decimal point is its own column beside the digit, never inside the segment field.
      const pointSize = Math.max(1, Math.min(stroke * 0.75, digitHeight * POINT_RATIO));
      const pointGap = Math.max(1, pointSize * POINT_GAP_RATIO);
      const innerWidth = Math.max(2, cell * (1 - spacing));
      const digitWidth = Math.max(
        2,
        Math.min(innerWidth - pointSize - pointGap, digitHeight * DIGIT_ASPECT),
      );

      // Every cell paints, lit or not: unlit segments and points are what a real display shows.
      for (let index = 0; index < digits; index += 1) {
        const glyph = cells[index - offset];
        const innerLeft = index * cell + (cell - innerWidth) / 2;
        drawDigit(
          context,
          innerLeft,
          digitTop,
          digitWidth,
          digitHeight,
          stroke,
          glyph === undefined ? ' ' : glyph.character,
          color,
        );
        drawPoint(
          context,
          innerLeft + innerWidth - pointSize,
          digitTop + digitHeight - pointSize,
          pointSize,
          glyph !== undefined && glyph.dot,
          color,
        );
      }
    },
  };
}
