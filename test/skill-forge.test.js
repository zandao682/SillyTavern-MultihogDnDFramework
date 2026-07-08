import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    powerBudgetForTier, parseEffectNumbers, validateSkillBatch, findCycle, extractNodeArray, NODES_PER_TIER,
} from '../skill-forge.js';

const foundation = {
    SKILL_TAXONOMY: { levelGatePerTier: 10, rarityTiers: [{ id: 'common', name: 'Common' }, { id: 'rare', name: 'Rare' }] },
    POWER_SYSTEM: { resources: [{ id: 'stamina', name: 'Stamina' }] },
};

function nodeBatch(overrides = []) {
    // 4 valid tier-1 nodes (min), 1 active + rest passive
    const base = [
        { id: 'strike', name: 'Strike', tier: 1, type: 'active', cost: 1, prereqs: [], effect: 'deal 1d6 damage', descriptor: 'a quick jab', resourceCost: { resourceId: 'stamina', amount: 5 }, rarity: 'common' },
        { id: 'guard', name: 'Guard', tier: 1, type: 'passive', cost: 1, prereqs: [], effect: '+1 defense', descriptor: 'a steady stance', rarity: 'common' },
        { id: 'focus', name: 'Focus', tier: 1, type: 'passive', cost: 1, prereqs: [], effect: '+1 to checks', descriptor: 'calm mind', rarity: 'common' },
        { id: 'dash', name: 'Dash', tier: 1, type: 'passive', cost: 1, prereqs: [], effect: 'move faster', descriptor: 'fleet feet', rarity: 'common' },
    ];
    return base.map((n, i) => ({ ...n, ...(overrides[i] || {}) }));
}

test('power budget scales with tier', () => {
    assert.equal(powerBudgetForTier(1).maxDiceTotal, 22);
    assert.ok(powerBudgetForTier(3).maxDiceTotal > powerBudgetForTier(1).maxDiceTotal);
});

test('parseEffectNumbers extracts dice/flat/percent', () => {
    const p = parseEffectNumbers('deal 2d8 +3 and reduce 25% speed');
    assert.equal(p.diceTotal, 16);
    assert.equal(p.maxFlat, 3);
    assert.equal(p.maxPercent, 25);
});

test('a well-formed tier-1 batch validates', () => {
    const { ok, errors, nodes } = validateSkillBatch(nodeBatch(), { foundation, tier: 1 });
    assert.equal(ok, true, errors.join('; '));
    assert.equal(nodes.length, 4);
});

test('over-budget dice are rejected', () => {
    const { ok, errors } = validateSkillBatch(nodeBatch([{ effect: 'deal 40d10 damage' }]), { foundation, tier: 1 });
    assert.equal(ok, false);
    assert.ok(errors.some(e => /exceeds tier-1 budget/.test(e)));
});

test('active without resource or cooldown is rejected', () => {
    const { ok, errors } = validateSkillBatch(nodeBatch([{ resourceCost: undefined }]), { foundation, tier: 1 });
    assert.equal(ok, false);
    assert.ok(errors.some(e => /resourceCost and\/or cooldown/.test(e)));
});

test('unresolved prereq is rejected', () => {
    const b = nodeBatch();
    b[1].prereqs = ['ghost_node'];
    const { ok, errors } = validateSkillBatch(b, { foundation, tier: 1 });
    assert.equal(ok, false);
    assert.ok(errors.some(e => /does not resolve/.test(e)));
});

test('findCycle detects prereq cycles', () => {
    assert.deepEqual(findCycle({ a: { prereqs: ['b'] }, b: { prereqs: ['a'] } })?.includes('a'), true);
    assert.equal(findCycle({ a: { prereqs: [] }, b: { prereqs: ['a'] } }), null);
});

test('extractNodeArray pulls the fenced json array', () => {
    const arr = extractNodeArray('blah\n```json\n[{"id":"x"}]\n```\ntrailing');
    assert.deepEqual(arr, [{ id: 'x' }]);
    assert.equal(extractNodeArray('no array here'), null);
});
