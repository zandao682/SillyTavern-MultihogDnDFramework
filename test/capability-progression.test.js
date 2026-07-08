import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    newProg, advance, progCost, progScore, totalLevels, recomputeScore, progIsProgressing, DEFAULT_TIER_NAMES,
} from '../capability-progression.js';

// The Veridia PP profile.
const PP = { id: 'veridia_pp', type: 'points_tiers', levels_per_tier: 10, cost_formula: '100 * tier_rank', score_formula: '10 + total_levels * 2.5' };
const USE = { id: 'use', type: 'use_tracked', threshold: 5, score_formula: 'skill_level' };
const CNT = { id: 'cnt', type: 'counter' };
const NONE = { id: 'none', type: 'none' };

test('progIsProgressing distinguishes static vs progressing', () => {
    assert.equal(progIsProgressing(NONE), false);
    assert.equal(progIsProgressing(PP), true);
});

test('points_tiers newProg seeds cost and level', () => {
    const p = newProg(PP);
    assert.equal(p.points_needed, 100); // 100 * tier_rank(1)
    assert.equal(p.total_levels, 1);
});

test('points_tiers advances levels and recomputes cost within a tier', () => {
    const prog = newProg(PP);
    advance(prog, PP, { points: 250 });
    assert.equal(prog.level, 2);
    assert.equal(prog.points, 50);
    assert.equal(prog.tier_idx, 0);
    assert.equal(prog.points_needed, 100); // still tier_rank 1
});

test('points_tiers rolls over to the next tier at levels_per_tier', () => {
    const prog = newProg(PP);
    advance(prog, PP, { points: 1000 }); // 10 levels * 100 each = one full tier
    assert.equal(prog.tier_idx, 1);
    assert.equal(prog.level, 0);
    assert.equal(prog.points_needed, 200); // 100 * tier_rank(2)
});

test('use_tracked accumulates uses into levels by threshold', () => {
    const prog = newProg(USE);
    const notes = advance(prog, USE, { points: 12 }); // 12 / 5 = 2 levels, 2 remaining
    assert.equal(prog.level, 2);
    assert.equal(prog.points, 2);
    assert.equal(notes.filter(n => n.type === 'level').length, 2);
});

test('counter sets or increments a plain level', () => {
    const prog = newProg(CNT);
    advance(prog, CNT, { level: 3 });
    assert.equal(prog.level, 3);
    advance(prog, CNT, { points: 2 });
    assert.equal(prog.level, 5);
});

test('none never advances (static capability)', () => {
    const prog = newProg(NONE);
    advance(prog, NONE, { points: 999, level: 5 });
    assert.equal(prog.level, 0);
    assert.equal(prog.tier_idx, 0);
});

test('score_formula computes from total_levels', () => {
    assert.equal(progScore(PP, { total_levels: 4, skill_level: 0 }), 20); // 10 + 4*2.5
    const prog = newProg(PP);
    recomputeScore(prog, PP, 4);
    assert.equal(prog.score, 20);
});

test('totalLevels sums across a mixed capability set', () => {
    const caps = [
        { prog: { tier_idx: 1, level: 3 } },  // points_tiers → 1*10+3+1 = 14
        { prog: { level: 2 } },               // use_tracked  → 2
    ];
    const profileOf = (c) => (c.prog.tier_idx !== undefined && c === caps[0]) ? PP : USE;
    assert.equal(totalLevels(caps, profileOf), 16);
});

test('cost formula falls back safely on a bad formula', () => {
    assert.equal(progCost({ type: 'points_tiers', cost_formula: 'fetch()' }, { tier_rank: 3 }), 300); // fallback 100*tier_rank
});

test('DEFAULT_TIER_NAMES is a non-empty vocabulary', () => {
    assert.ok(DEFAULT_TIER_NAMES.length >= 5);
});
