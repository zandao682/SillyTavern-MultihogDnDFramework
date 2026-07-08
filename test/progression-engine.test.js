import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    MAX_LEVEL, xpToNext, levelForXp, XP_TOTALS,
    skillPointsForLevelUp, totalSkillPointsAtLevel, detectLevelUp, formatXpLine,
} from '../progression-engine.js';

test('xp curve is monotonic and level 1 costs 100', () => {
    assert.equal(xpToNext(1), 100);
    for (let l = 1; l < MAX_LEVEL - 1; l++) {
        assert.ok(xpToNext(l) <= xpToNext(l + 1), `curve should not decrease at level ${l}`);
    }
    assert.equal(xpToNext(MAX_LEVEL), 0);
});

test('levelForXp maps totals back to levels', () => {
    assert.equal(levelForXp(0), 1);
    assert.equal(levelForXp(-5), 1);
    assert.equal(levelForXp(XP_TOTALS[5]), 5);
    assert.equal(levelForXp(XP_TOTALS[5] - 1), 4);
});

test('skill points: 2/level, +4 every 10th; 240 total at 100', () => {
    assert.equal(skillPointsForLevelUp(2), 2);
    assert.equal(skillPointsForLevelUp(10), 6); // 2 + 4 milestone
    assert.equal(totalSkillPointsAtLevel(1), 2);
    assert.equal(totalSkillPointsAtLevel(100), 240);
});

test('detectLevelUp fires for xp mode across thresholds', () => {
    const up = detectLevelUp(0, XP_TOTALS[4] + 1, { progressionMode: 'xp', milestoneEvery: 10 });
    assert.equal(up.fromLevel, 1);
    assert.equal(up.toLevel, 4);
    assert.ok(up.points > 0);
});

test('detectLevelUp is suppressed for non-xp progression modes', () => {
    assert.equal(detectLevelUp(0, 999999, { progressionMode: 'none' }), null);
    assert.equal(detectLevelUp(0, 999999, { progressionMode: 'milestone' }), null);
});

test('formatXpLine renders total/next and MAX', () => {
    assert.match(formatXpLine(0), /Level: 1 \| XP: 0\//);
    assert.match(formatXpLine(XP_TOTALS[MAX_LEVEL]), /\(MAX\)/);
});
