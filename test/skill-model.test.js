import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGroups, hasCustomSkillModel } from '../skill-model.js';
import { validateFoundation } from '../foundation.js';
import { defaultFoundation } from '../default-foundation.js';

test('resolveGroups defaults to a single implicit skilltree group', () => {
    const g = resolveGroups({});
    assert.equal(g.length, 1);
    assert.equal(g[0].model, 'skilltree');
    assert.equal(hasCustomSkillModel({}), false);
});

test('resolveGroups returns declared multi-group SKILL_MODEL', () => {
    const f = { SKILL_MODEL: { groups: [
        { id: 'skills', label: 'Skills', model: 'capabilities', config: {} },
        { id: 'tree', label: 'Class Tree', model: 'skilltree', config: {} },
    ] } };
    const g = resolveGroups(f);
    assert.equal(g.length, 2);
    assert.deepEqual(g.map(x => x.model), ['capabilities', 'skilltree']);
    assert.equal(hasCustomSkillModel(f), true);
});

test('validateFoundation accepts a valid multi-group SKILL_MODEL', () => {
    const f = defaultFoundation();
    f.SKILL_MODEL = { groups: [
        { id: 'caps', label: 'Capabilities', model: 'capabilities', config: { categories: ['boon', 'skill'] } },
        { id: 'class', label: 'Class Tree', model: 'skilltree', config: {} },
    ] };
    const v = validateFoundation(f);
    assert.equal(v.ok, true, v.errors.join('; '));
});

test('validateFoundation rejects unknown model + duplicate ids', () => {
    const f = defaultFoundation();
    f.SKILL_MODEL = { groups: [
        { id: 'a', model: 'nonsense' },
        { id: 'a', model: 'leveling' },
    ] };
    const v = validateFoundation(f);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some(e => /must be one of/.test(e)));
    assert.ok(v.errors.some(e => /duplicate id/.test(e)));
});

test('validateFoundation still accepts a foundation with no SKILL_MODEL (backward compat)', () => {
    assert.equal(validateFoundation(defaultFoundation()).ok, true);
});
