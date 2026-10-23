/** Seven-segment font: which of the `a`–`g` segments each character lights. */
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

const OFF_COLOR = 'rgba(148, 163, 184, 0.16)';

function drawDigit(context, left, top, width, height, thickness, character, color) {
  if (character === '.') {
    context.fillStyle = color;
    context.beginPath();
    context.arc(left + width / 2, top + height - thickness * 1.5, thickness * 1.4, 0, Math.PI * 2);
    context.fill();
    return;
  }

  const lit = DIGIT_SEGMENTS[character] ?? '';
  const right = left + width;
  const bottom = top + height;
  const middle = top + height / 2;
  const segments = [
    ['a', left + thickness, top, right - thickness, top],
    ['b', right, top + thickness, right, middle - thickness],
    ['c', right, middle + thickness, right, bottom - thickness],
    ['d', left + thickness, bottom, right - thickness, bottom],
    ['e', left, middle + thickness, left, bottom - thickness],
    ['f', left, top + thickness, left, middle - thickness],
    ['g', left + thickness, middle, right - thickness, middle],
  ];

  context.lineCap = 'round';
  context.lineWidth = thickness;
  for (const [name, x1, y1, x2, y2] of segments) {
    context.strokeStyle = lit.includes(name) ? color : OFF_COLOR;
    context.beginPath();
    context.moveTo(x1, y1);
    context.lineTo(x2, y2);
    context.stroke();
  }
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

      const digits = Math.max(1, Math.min(24, Math.floor(Number(api.props.digits)) || 8));
      const color = typeof api.props.color === 'string' ? api.props.color : '#ff3b30';
      // Right-aligned and blank-padded, so "12.34" keeps the decimal point where it belongs.
      const characters = text.slice(-digits).padStart(digits, ' ');

      context.fillStyle = 'rgba(9, 9, 11, 0.85)';
      context.fillRect(0, 0, width, height);

      const cell = width / digits;
      const insetX = Math.min(cell * 0.2, height * 0.3);
      const insetY = height * 0.12;
      const digitWidth = Math.max(2, cell - insetX * 2);
      const digitHeight = Math.max(4, height - insetY * 2);
      const thickness = Math.max(1, Math.min(digitWidth, digitHeight) * 0.13);

      for (let index = 0; index < digits; index += 1) {
        drawDigit(
          context,
          index * cell + insetX,
          insetY,
          digitWidth,
          digitHeight,
          thickness,
          characters[index],
          color,
        );
      }
    },
  };
}
