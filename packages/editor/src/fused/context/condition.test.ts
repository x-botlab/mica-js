import { describe, expect, it } from 'vitest';
import { ConditionError, parseCondition, type ContextValue } from './index';

function evaluate(expression: string, values: Record<string, ContextValue> = {}): boolean {
  return parseCondition(expression).evaluate((name) => values[name]);
}

function catchError(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('parseCondition', () => {
  it('collects dependency names in first-seen order without duplicates', () => {
    expect(parseCondition('editor.a && (editor.b || editor.a)').keys).toEqual([
      'editor.a',
      'editor.b',
    ]);
    expect(parseCondition('true && 1 && "text" && undefined').keys).toEqual([]);
  });

  it('evaluates scalar literals and key truthiness', () => {
    expect(evaluate('true')).toBe(true);
    expect(evaluate('false')).toBe(false);
    expect(evaluate("''")).toBe(false);
    expect(evaluate('"text"')).toBe(true);
    expect(evaluate('0')).toBe(false);
    expect(evaluate('-1.5')).toBe(true);
    expect(evaluate('editor.flag', { 'editor.flag': true })).toBe(true);
    expect(evaluate('editor.count', { 'editor.count': 0 })).toBe(false);
    expect(evaluate('editor.name', { 'editor.name': '' })).toBe(false);
  });

  it('applies ! before comparison before && before ||', () => {
    const values = { 'editor.a': false, 'editor.b': true, 'editor.c': false };
    expect(evaluate('editor.a || editor.b && editor.c', values)).toBe(false);
    expect(evaluate('(editor.a || editor.b) && !editor.c', values)).toBe(true);
    expect(evaluate('!editor.a == true', values)).toBe(true);
    expect(evaluate('editor.a || (editor.b && editor.c) || true', values)).toBe(true);
  });

  it('compares scalars with == and !=', () => {
    expect(evaluate("editor.kind == 'symbol'", { 'editor.kind': 'symbol' })).toBe(true);
    expect(evaluate("editor.kind != 'symbol'", { 'editor.kind': 'symbol' })).toBe(false);
    expect(evaluate('editor.count == 3', { 'editor.count': 3 })).toBe(true);
    expect(evaluate('editor.flag == true', { 'editor.flag': true })).toBe(true);
    expect(
      evaluate("editor.kind == 'symbol' && editor.count != 2", {
        'editor.kind': 'symbol',
        'editor.count': 3,
      }),
    ).toBe(true);
  });

  it('reads unknown keys as undefined', () => {
    expect(evaluate('editor.missing')).toBe(false);
    expect(evaluate('!editor.missing')).toBe(true);
    expect(evaluate('editor.missing == undefined')).toBe(true);
    expect(evaluate('editor.missing == null')).toBe(true);
    expect(evaluate('editor.missing != false')).toBe(true);
    expect(evaluate('editor.missing == false')).toBe(false);
  });

  it('parses quoted strings with escapes and both quote styles', () => {
    expect(evaluate('editor.label == "tab\\there"', { 'editor.label': 'tab\there' })).toBe(true);
    expect(evaluate("editor.label == 'it\\'s'", { 'editor.label': "it's" })).toBe(true);
    expect(
      evaluate('editor.label == "quote \\" inside"', { 'editor.label': 'quote " inside' }),
    ).toBe(true);
  });

  it('rejects malformed expressions with a position', () => {
    const malformed = [
      '',
      '   ',
      '&& editor.a',
      'editor.a &&',
      '(editor.a',
      'editor.a)',
      'editor.a & editor.b',
      'editor.a = editor.b',
      'editor.a == editor.b == editor.c',
      '"unterminated',
      'editor.a @',
      'editor.a editor.b',
      '()',
    ];
    for (const expression of malformed) {
      expect(() => parseCondition(expression), expression).toThrow(ConditionError);
    }
    const failure = catchError(() => parseCondition('editor.a &&'));
    expect(failure).toBeInstanceOf(ConditionError);
    expect((failure as ConditionError).position).toBe('editor.a &&'.length);
    expect((failure as ConditionError).expression).toBe('editor.a &&');
    expect(catchError(() => parseCondition('editor.a @'))).toMatchObject({ position: 9 });
  });
});
