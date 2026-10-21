import { describe, expect, it } from 'vitest';
import * as ir from './index';

describe('@mica/ir public entry', () => {
  it('exposes no placeholder API', () => {
    expect(Object.keys(ir)).toEqual([]);
  });
});
