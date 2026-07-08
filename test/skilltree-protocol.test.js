import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    validateApply, applyValidatedRequest, computeLayout, buildSkillsMemoBlock, channelName,
} from '../skilltree-protocol.js';

const foundation = {
    POWER_SYSTEM: { resources: [{ id: 'stamina', name: 'Stamina' }] },
    PROGRESSION_RULES: { respec: { freeUntilLevel: 10, currencyName: 'gold', costMultiplier: 1.0 } },
};

function prog() {
    return {
        level: 5,
        skillPoints: { earned: 4, spent: 0 },
        acquired: {},
        tree: {
            nodes: {
                root: { id: 'root', name: 'Root', tier: 1, type: 'active', cost: 1, prereqs: [], levelGate: 0, resourceCost: { resourceId: 'stamina', amount: 5 }, descriptor: 'a jab' },
                leaf: { id: 'leaf', name: 'Leaf', tier: 2, type: 'passive', cost: 2, prereqs: ['root'], levelGate: 10, descriptor: 'poise' },
            },
        },
    };
}

test('channelName is chat-scoped', () => {
    assert.equal(channelName('abc'), 'multihog-skilltree:abc');
});

test('allocating a root within points/level is valid', () => {
    const v = validateApply(prog(), foundation, { allocate: ['root'] });
    assert.equal(v.ok, true, v.errors.join('; '));
    assert.equal(v.pointsSpent, 1);
});

test('a level-gated node is rejected below its gate', () => {
    const v = validateApply(prog(), foundation, { allocate: ['leaf'] });
    assert.equal(v.ok, false); // leaf needs level 10, prog is level 5 (and prereq)
});

test('over-spend is rejected', () => {
    const p = prog(); p.skillPoints.earned = 0;
    assert.equal(validateApply(p, foundation, { allocate: ['root'] }).ok, false);
});

test('refunding a node whose dependent is still owned breaks the chain', () => {
    const p = prog(); p.level = 10;
    applyValidatedRequest(p, { allocate: ['root'] }, validateApply(p, foundation, { allocate: ['root'] }));
    applyValidatedRequest(p, { allocate: ['leaf'] }, validateApply(p, foundation, { allocate: ['leaf'] }));
    assert.equal(validateApply(p, foundation, { refund: ['root'] }).ok, false); // leaf needs root
    assert.equal(validateApply(p, foundation, { refund: ['leaf'] }).ok, true);
});

test('applyValidatedRequest mutates acquired + spent', () => {
    const p = prog();
    applyValidatedRequest(p, { allocate: ['root'] }, validateApply(p, foundation, { allocate: ['root'] }));
    assert.ok(p.acquired.root);
    assert.equal(p.skillPoints.spent, 1);
});

test('computeLayout is deterministic and covers all nodes', () => {
    const l1 = computeLayout(prog().tree.nodes);
    const l2 = computeLayout(prog().tree.nodes);
    assert.deepEqual(l1, l2);
    assert.ok('root' in l1 && 'leaf' in l1);
    assert.ok(Number.isFinite(l1.root.x) && Number.isFinite(l1.root.y));
    // tier-2 sits farther from the origin than tier-1 (larger radius)
    assert.ok(Math.hypot(l1.leaf.x, l1.leaf.y) > Math.hypot(l1.root.x, l1.root.y));
});

test('buildSkillsMemoBlock lists acquired ACTIVES only', () => {
    const p = prog(); p.level = 10;
    applyValidatedRequest(p, { allocate: ['root'] }, validateApply(p, foundation, { allocate: ['root'] }));
    applyValidatedRequest(p, { allocate: ['leaf'] }, validateApply(p, foundation, { allocate: ['leaf'] }));
    const block = buildSkillsMemoBlock(p, foundation);
    assert.match(block, /\[SKILLS\]/);
    assert.match(block, /Root/);        // active included
    assert.doesNotMatch(block, /Leaf/); // passive excluded
});
