// Independent tree interpreter for docs/spec/language/expressions.rst.
// It never consumes rendered DDL, lowered IR, or compiler output.
export function evaluate(expression, bindings) {
  const read = (node) => evaluate(node, bindings);
  switch (expression.kind) {
    case 'literal':
      return expression.value;
    case 'read':
      return bindings[expression.name];
    case 'select':
      return read(expression.condition) ? read(expression.yes) : read(expression.no);
    case 'unary': {
      const value = read(expression.value);
      switch (expression.operator) {
        case '+':
          return +value;
        case '-':
          return -value;
        case '~':
          return ~value;
        case '!':
          return !value;
        default:
          throw new Error(`Unknown unary operator: ${expression.operator}`);
      }
    }
    case 'binary': {
      const left = read(expression.left);
      // Do not evaluate the right subtree for a short-circuited operation.
      if (expression.operator === '&&') return left && read(expression.right);
      if (expression.operator === '||') return left || read(expression.right);
      const right = read(expression.right);
      switch (expression.operator) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '/':
          return left / right;
        case '%':
          return left % right;
        case '**':
          return left ** right;
        case '&':
          return left & right;
        case '|':
          return left | right;
        case '^':
          return left ^ right;
        case '<<':
          return left << right;
        case '>>':
          return left >> right;
        case '>>>':
          return left >>> right;
        case '<':
          return left < right;
        case '<=':
          return left <= right;
        case '>':
          return left > right;
        case '>=':
          return left >= right;
        case '==':
          return left === right;
        case '!=':
          return left !== right;
        default:
          throw new Error(`Unknown binary operator: ${expression.operator}`);
      }
    }
    default:
      throw new Error(`Unknown expression: ${expression.kind}`);
  }
}

// A single ordinary process: ticks(0) yields but does not advance time.
export function trace(sample) {
  let time = 0;
  const result = [];
  for (let index = 0; index <= sample.delays.length; index++) {
    if (index > 0) time += sample.delays[index - 1];
    result.push({
      time,
      value: evaluate(sample.expression, { ...sample.props, tick: index }),
    });
  }
  return result;
}
