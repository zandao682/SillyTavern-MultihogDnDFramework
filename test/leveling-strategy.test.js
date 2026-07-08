import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, applyUpdate, memoBlock } from '../leveling-strategy.js';

const group = { id: 'skills', label: 'Skills', model: 'leveling', config: { threshold: 100, points_label: 'XP' } };

test('validateConfig rejects bad type/threshold', () => {
    assert.deepEqual(validateConfig(group.config), []);
    assert.ok(validateConfig({ type: 'nope' }).some(e => /must be one of/.test(e)));
    assert.ok(validateConfig({ threshold: 0 }).some(e => /≥ 1/.test(e)));
});

test('use_tracked leveling accumulates xp into levels', () => {
    const prog = {};
    applyUpdate(prog, group, null, [{ name: 'Swordplay', xp: 250 }]); // 250 / 100 → level 2, 50 left
    const sk = Object.values(prog.groups.skills.skills)[0];
    assert.equal(sk.prog.level, 2);
    assert.equal(sk.prog.points, 50);
});

test('memoBlock renders [SKILL_LEVELS]', () => {
    const prog = {};
    applyUpdate(prog, group, null, [{ name: 'Swordplay', xp: 120 }]);
    const b = memoBlock(prog, group);
    assert.match(b, /\[SKILL_LEVELS\]/);
    assert.match(b, /Swordplay: Lv 1 \(20\/100\)/);
});
