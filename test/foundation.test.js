import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFoundation, foundationPlaceholders, computeDerivedStats } from '../foundation.js';
import { defaultFoundation } from '../default-foundation.js';

const emberhold = {
    schemaVersion: 1, mode: 'modern',
    SETTING: { name: 'Emberhold', synopsis: 'A frozen hold where warmth and trust are currency.' },
    POWER_SYSTEM: {
        name: 'Grit', description: 'Endurance and willpower.',
        resources: [{ id: 'vigor', name: 'Vigor' }],
        diceProfile: { primary: 'd20', dcScale: [{ label: 'Easy', value: 8 }, { label: 'Hard', value: 14 }, { label: 'Dire', value: 20 }] },
    },
    PROGRESSION_RULES: {
        progressionMode: 'none', hasClasses: false, maxLevel: null, xpCurveId: 'none',
        milestoneEvery: 0, milestoneBonus: 0, respec: { freeUntilLevel: 0, currencyName: 'favors' },
    },
    JOB_RULES: { enabled: false },
    SKILL_TAXONOMY: { damageTypes: ['cold'], rarityTiers: [{ id: 'crude', name: 'Crude' }, { id: 'fine', name: 'Fine' }], tierCount: 3, levelGatePerTier: 1 },
    LETHALITY: { template: 'hardcore' },
    ATTRIBUTES: [{ id: 'brawn', name: 'Brawn' }, { id: 'spirit', name: 'Spirit' }],
    DERIVED_STATS: [{ id: 'hp', name: 'Health', formula: '(brawn*4)+(spirit*2)' }],
    METERS: [{ id: 'warmth', name: 'Warmth', kind: 'needs', min: 0, max: 100 }],
};

test('the default leveled/classed foundation is valid (backward compat)', () => {
    const v = validateFoundation(defaultFoundation());
    assert.equal(v.ok, true, v.errors.join('; '));
});

test('a levelless/classless/attribute/meter foundation is valid', () => {
    const v = validateFoundation(emberhold);
    assert.equal(v.ok, true, v.errors.join('; '));
});

test('leveled contract still enforced when progressionMode is xp', () => {
    const bad = defaultFoundation();
    bad.PROGRESSION_RULES.maxLevel = 50; // xp mode requires 100
    assert.equal(validateFoundation(bad).ok, false);
});

test('classed contract still requires 3–6 classes', () => {
    const bad = defaultFoundation();
    bad.CLASS_ROSTER = bad.CLASS_ROSTER.slice(0, 2);
    assert.equal(validateFoundation(bad).ok, false);
});

test('unsafe derived formulas are rejected at validation', () => {
    const bad = { ...emberhold, DERIVED_STATS: [{ id: 'x', name: 'X', formula: 'fetch("/x")' }] };
    assert.equal(validateFoundation(bad).ok, false);
});

test('meters require min < max', () => {
    const bad = { ...emberhold, METERS: [{ id: 'm', name: 'M', min: 5, max: 5 }] };
    assert.equal(validateFoundation(bad).ok, false);
});

test('placeholders render the generic sections when present', () => {
    const ph = foundationPlaceholders(emberhold);
    assert.match(ph.foundation_attributes, /Brawn/);
    assert.match(ph.foundation_derived_guidance, /\(brawn\*4\)\+\(spirit\*2\)/);
    assert.match(ph.foundation_meters, /Warmth/);
});

test('placeholders are empty for a foundation without generic sections', () => {
    const ph = foundationPlaceholders(defaultFoundation());
    assert.equal(ph.foundation_attributes, '');
    assert.equal(ph.foundation_meters, '');
});

test('computeDerivedStats evaluates from attribute + level values', () => {
    assert.deepEqual(computeDerivedStats(emberhold, { brawn: 5, spirit: 3 }), { hp: 26 });
});
