import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evalFormula, isFormulaSafe } from '../formula-eval.js';

test('evaluates arithmetic over variables', () => {
    assert.equal(evalFormula('(brawn*4)+(spirit*2)+(level*10)', { brawn: 5, spirit: 3, level: 2 }), 46);
    assert.equal(evalFormula('spirit*3', { spirit: 3 }), 9);
    assert.equal(evalFormula('10 + 5 * 2', {}), 20);
});

test('longest-first substitution avoids partial-name collisions', () => {
    assert.equal(evalFormula('spirit_max - spirit', { spirit: 3, spirit_max: 10 }), 7);
});

test('unknown variables fall back (never partially evaluate)', () => {
    assert.equal(evalFormula('brawn + mystery', { brawn: 5 }, -1), -1);
});

test('rejects code injection and property access', () => {
    assert.equal(evalFormula('constructor.constructor("return 1")()', {}, -1), -1);
    assert.equal(evalFormula('globalThis', {}, -1), -1);
    assert.equal(evalFormula('(1).toString()', {}, -1), -1);
    assert.equal(evalFormula('process.exit(1)', {}, -1), -1);
});

test('handles malformed / empty input', () => {
    assert.equal(evalFormula('', {}, 7), 7);
    assert.equal(evalFormula(null, {}, 7), 7);
    assert.equal(evalFormula('1/0', {}, 7), 7); // Infinity -> fallback
});

test('isFormulaSafe accepts arithmetic, rejects the rest', () => {
    assert.equal(isFormulaSafe('(brawn*4)+(spirit*2)', ['brawn', 'spirit']), true);
    assert.equal(isFormulaSafe('brawn + fetch()', ['brawn']), false);
    assert.equal(isFormulaSafe('brawn + unknown', ['brawn']), false); // undeclared var
});
