import { describe, it, expect } from 'vitest';
import { normaliseName, NAME_LENGTH } from '../../src/sim/names';

describe('US-024 arcade names', () => {
  it('US-024: names are upper case, up to 8 allowed characters', () => {
    expect(normaliseName('racer')).toBe('RACER');
    expect(normaliseName('  a.b-c_d9  ')).toBe('A.B-C_D9');
    expect(normaliseName('waytoolongname')).toHaveLength(NAME_LENGTH);
    expect(normaliseName('ä!@#b')).toBe('B');
    expect(normaliseName('   ')).toBeNull();
    expect(normaliseName('!!!')).toBeNull();
  });
});
