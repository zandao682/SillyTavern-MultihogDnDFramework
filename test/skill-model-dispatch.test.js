import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillMemoBlocks, skillSyspromptFragments, resolveGroups } from '../skill-model.js';
import { applyUpdate as applyCaps } from '../capabilities.js';
import { applyUpdate as applyLvl } from '../leveling-strategy.js';

// A system running THREE skill modes at once.
const foundation = {
    SKILL_MODEL: {
        groups: [
            {
                id: 'caps', label: 'Capabilities', model: 'capabilities',
                config: {
                    categories: ['boon', 'skill'],
                    category_progression: { skill: 'pp' },
                    progressions: [{ id: 'none', type: 'none' }, { id: 'pp', type: 'points_tiers', cost_formula: '100 * tier_rank', points_label: 'PP' }],
                },
            },
            { id: 'weapons', label: 'Weapon Skills', model: 'leveling', config: { threshold: 100, points_label: 'XP' } },
            { id: 'class', label: 'Class Tree', model: 'skilltree', config: {} },
        ],
    },
};

test('resolveGroups returns all three groups', () => {
    assert.deepEqual(resolveGroups(foundation).map(g => g.model), ['capabilities', 'leveling', 'skilltree']);
});

test('dispatcher combines memo blocks across all active strategies', async () => {
    const progression = {};
    applyCaps(progression, foundation.SKILL_MODEL.groups[0], foundation, [
        { name: 'Firebolt', category: 'skill', points: 150 },
        { name: 'Ironhide', category: 'boon' },
    ]);
    applyLvl(progression, foundation.SKILL_MODEL.groups[1], foundation, [{ name: 'Sword', xp: 120 }]);

    const memo = await skillMemoBlocks(foundation, progression);
    assert.match(memo, /\[CAPABILITIES\]/);
    assert.match(memo, /Firebolt \(skill\)/);
    assert.match(memo, /Ironhide \(boon\)/);
    assert.match(memo, /\[SKILL_LEVELS\]/);
    assert.match(memo, /Sword: Lv 1/);
    // skilltree group has no acquired nodes → its [SKILLS] block is empty, absent from the combined memo
    assert.doesNotMatch(memo, /\[SKILLS\]/);
});

test('dispatcher combines sysprompt fragments (capabilities + leveling; skilltree empty)', async () => {
    const frag = await skillSyspromptFragments(foundation);
    assert.match(frag, /<capabilities>/);
    assert.match(frag, /<skill_leveling>/);
});
