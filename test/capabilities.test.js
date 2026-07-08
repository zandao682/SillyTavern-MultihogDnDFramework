import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, applyUpdate, memoBlock, syspromptFragment, panelRender } from '../capabilities.js';

// A Veridia-like group: skills level on use via PP; boons/titles are static.
const group = {
    id: 'caps', label: 'Capabilities', model: 'capabilities',
    config: {
        categories: ['boon', 'title', 'skill'],
        exclusive_category: 'title',
        category_progression: { skill: 'veridia_pp' },
        progressions: [
            { id: 'none', type: 'none' },
            { id: 'veridia_pp', type: 'points_tiers', levels_per_tier: 10, cost_formula: '100 * tier_rank', score_formula: '10 + total_levels * 2.5', points_label: 'PP' },
        ],
    },
};

test('validateConfig accepts a good config, rejects bad type + unsafe formula', () => {
    assert.deepEqual(validateConfig(group.config), []);
    assert.ok(validateConfig({ progressions: [{ id: 'x', type: 'bogus' }] }).some(e => /type must be one of/.test(e)));
    assert.ok(validateConfig({ progressions: [{ id: 'x', type: 'points_tiers', cost_formula: 'fetch()' }] }).some(e => /not a safe/.test(e)));
});

test('a progressing skill and a static boon coexist in one group', () => {
    const prog = {};
    applyUpdate(prog, group, null, [{ name: 'Firebolt', category: 'skill', points: 250 }]);
    applyUpdate(prog, group, null, [{ name: 'Ironhide', category: 'boon' }]);
    const caps = prog.groups.caps.capabilities;
    const fire = Object.values(caps).find(c => c.name === 'Firebolt');
    const iron = Object.values(caps).find(c => c.name === 'Ironhide');
    // Firebolt levelled via PP (250 pts / 100 = level 2, 50 remaining)
    assert.equal(fire.prog.level, 2);
    assert.equal(fire.prog.points, 50);
    assert.ok(fire.prog.score > 0);
    // Ironhide is static — never levels
    assert.equal(iron.prog.level, 0);
    assert.equal(iron.prog.points_needed, 0);
});

test('exclusive category (title) allows only one active at a time', () => {
    const prog = {};
    applyUpdate(prog, group, null, [{ name: 'The Bold', category: 'title', active: true }]);
    applyUpdate(prog, group, null, [{ name: 'The Wise', category: 'title', active: true }]);
    const caps = Object.values(prog.groups.caps.capabilities);
    const active = caps.filter(c => c.category === 'title' && c.active);
    assert.equal(active.length, 1);
    assert.equal(active[0].name, 'The Wise');
});

test('memoBlock renders progressing + static capabilities', () => {
    const prog = {};
    applyUpdate(prog, group, null, [{ name: 'Firebolt', category: 'skill', points: 250 }]);
    applyUpdate(prog, group, null, [{ name: 'Ironhide', category: 'boon' }]);
    const block = memoBlock(prog, group);
    assert.match(block, /\[CAPABILITIES\]/);
    assert.match(block, /Firebolt \(skill\) \[Novice Lv2/);   // tier+level+score+pp
    assert.match(block, /Ironhide \(boon\)/);                  // static, no [ … ] tag
    assert.doesNotMatch(block, /Ironhide \(boon\) \[/);
});

test('syspromptFragment describes categories + inline PP award rule', () => {
    const frag = syspromptFragment(group);
    assert.match(frag, /<capabilities>/);
    assert.match(frag, /skill.*advances via "veridia_pp"/);
    assert.match(frag, /boon \(static/);
    assert.match(frag, /\+N PP/);
    assert.match(frag, /Only one title may be active/);
});

test('panelRender groups by category with a PP bar for progressing rows', () => {
    const prog = {};
    applyUpdate(prog, group, null, [{ name: 'Firebolt', category: 'skill', points: 40 }]);
    applyUpdate(prog, group, null, [{ name: 'Ironhide', category: 'boon' }]);
    const html = panelRender(prog, null, group);
    assert.match(html, /rt-cap-group/);
    assert.match(html, /<summary>Skills \(1\)<\/summary>/);
    assert.match(html, /<summary>Boons \(1\)<\/summary>/);
    assert.match(html, /rt-cap-bar-fill/);      // PP bar for Firebolt
    assert.match(html, /Firebolt/);
});

test('empty group renders nothing', () => {
    assert.equal(memoBlock({}, group), '');
    assert.equal(panelRender({}, null, group), '');
});
