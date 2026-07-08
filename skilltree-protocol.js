/**
 * skilltree-protocol.js — generic System Definition mode (Skill Tree).
 *
 * Ported from the Fatbody Framework (same author, MIT).
 *
 * Shared, PURE logic for the Skill Tree tab: the BroadcastChannel message
 * contract, allocation/refund validation ("staging math"), the deterministic
 * radial layout, and the [SKILLS] memo block builder.
 *
 * Imported by BOTH sides — skilltree-bridge.js (opener, holds mutation
 * authority) and skilltree/skilltree.js (the tab, a view + staging surface) —
 * so the two can never disagree about what a legal purchase is. The tab is a
 * plain same-origin static page: this module (and progression-engine.js)
 * must stay free of SillyTavern/DOM dependencies.
 *
 * Message contract (JSON, all messages carry {v: PROTOCOL_VERSION, type}):
 *   tab → opener:  hello | requestState | apply {allocate[], refund[]} | resetAll | ping
 *   opener → tab:  state {progression, foundation, theme, readonly} |
 *                  applyResult {ok, errors[]} | pong
 *
 * Imports: progression-engine.js (leaf)
 */

import { respecCostPerPoint } from './progression-engine.js';

export const PROTOCOL_VERSION = 1;

/** Channel is chat-scoped so two campaigns never cross talk. */
export function channelName(chatId) {
    return `multihog-skilltree:${chatId}`;
}

// ── Staging math / apply validation ───────────────────────────────────────────

/**
 * Validates an allocate/refund request against progression state. Pure — the
 * tab uses it for live affordability feedback, the opener as the authority
 * gate before mutating.
 *
 * @param {object} progression - { level, skillPoints:{earned,spent}, tree:{nodes}, acquired }
 * @param {object} foundation  - committed foundation (respec rules)
 * @param {{allocate?: string[], refund?: string[]}} request
 * @returns {{ok: boolean, errors: string[], pointsSpent: number, pointsRefunded: number,
 *            currencyCost: number, acquiredAfter: string[]}}
 */
export function validateApply(progression, foundation, { allocate = [], refund = [] } = {}) {
    const errors = [];
    const err = (m) => errors.push(m);

    const nodes = progression?.tree?.nodes || {};
    const acquired = new Set(Object.keys(progression?.acquired || {}));
    const level = progression?.level || 1;
    const earned = progression?.skillPoints?.earned || 0;
    const spent = progression?.skillPoints?.spent || 0;

    const refundSet = new Set(refund);

    for (const id of allocate) {
        const n = nodes[id];
        if (!n) { err(`unknown node "${id}"`); continue; }
        if (acquired.has(id)) err(`"${n.name}" is already acquired`);
        if (refundSet.has(id)) err(`"${n.name}" cannot be allocated and refunded together`);
        if (level < (n.levelGate || 0)) err(`"${n.name}" requires level ${n.levelGate} (you are ${level})`);
    }
    for (const id of refund) {
        const n = nodes[id];
        if (!n) { err(`unknown node "${id}"`); continue; }
        if (!acquired.has(id)) err(`"${n.name}" is not acquired — nothing to refund`);
    }
    if (errors.length) {
        return { ok: false, errors, pointsSpent: 0, pointsRefunded: 0, currencyCost: 0, acquiredAfter: [...acquired] };
    }

    // Resulting set, then prereq-closure check: every owned node's prereqs that
    // exist in the tree must still be owned (graft anchors outside the tree are
    // exempt by construction — findCycle/validateSkillBatch guarantee shape).
    const after = new Set(acquired);
    for (const id of refund) after.delete(id);
    for (const id of allocate) after.add(id);

    for (const id of after) {
        const n = nodes[id];
        if (!n) continue;
        for (const p of (n.prereqs || [])) {
            if (p in nodes && !after.has(p)) {
                err(`"${n.name}" requires "${nodes[p]?.name || p}" — refund/allocate order breaks the chain`);
            }
        }
    }

    const pointsSpent = allocate.reduce((sum, id) => sum + (nodes[id]?.cost || 0), 0);
    const pointsRefunded = refund.reduce((sum, id) => sum + (nodes[id]?.cost || 0), 0);
    const newSpent = spent + pointsSpent - pointsRefunded;
    if (newSpent > earned) {
        err(`not enough skill points: need ${pointsSpent - pointsRefunded} more than the ${earned - spent} available`);
    }
    if (newSpent < 0) err('refund exceeds spent points');

    const respecRules = foundation?.PROGRESSION_RULES?.respec;
    const currencyCost = pointsRefunded * respecCostPerPoint(level, respecRules);

    return {
        ok: errors.length === 0,
        errors,
        pointsSpent,
        pointsRefunded,
        currencyCost,
        acquiredAfter: [...after],
    };
}

/**
 * Applies a validated request to progression (mutates). Opener-side only.
 * @param {object} progression
 * @param {{allocate?: string[], refund?: string[]}} request
 * @param {ReturnType<typeof validateApply>} validation - MUST be ok
 */
export function applyValidatedRequest(progression, { allocate = [], refund = [] }, validation) {
    if (!validation?.ok) throw new Error('applyValidatedRequest called with a failed validation');
    if (!progression.acquired) progression.acquired = {};
    for (const id of refund) delete progression.acquired[id];
    for (const id of allocate) progression.acquired[id] = { acquiredAtLevel: progression.level || 1 };
    if (!progression.skillPoints) progression.skillPoints = { earned: 0, spent: 0 };
    progression.skillPoints.spent += validation.pointsSpent - validation.pointsRefunded;
    progression.respecSpentTotal = (progression.respecSpentTotal || 0) + validation.currencyCost;
}

// ── Deterministic layout ───────────────────────────────────────────────────────

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ≈ 2.39996 rad

/**
 * Computes a deterministic constellation layout: the class branch radiates
 * from the center in tier rings; each job branch occupies its own outward
 * sector anchored past the class rings. Same tree → same coordinates, always
 * (nodes sorted by id; no randomness), so both sides and successive opens
 * agree without persisting anything.
 *
 * @param {Record<string, object>} nodes - id → skill node
 * @returns {Record<string, {x: number, y: number, cluster: string}>}
 */
export function computeLayout(nodes) {
    const layout = {};
    const branches = new Map(); // branchKey → node[]
    for (const id of Object.keys(nodes).sort()) {
        const n = nodes[id];
        const key = n.jobId || '__class__';
        if (!branches.has(key)) branches.set(key, []);
        branches.get(key).push(n);
    }

    const jobKeys = [...branches.keys()].filter(k => k !== '__class__').sort();
    const TIER_RADIUS = 110;

    // Class branch: full-circle rings around the origin.
    for (const [key, list] of branches) {
        const isClass = key === '__class__';
        // Job sectors sit evenly spaced, pushed outward beyond the class rings.
        const jobIndex = jobKeys.indexOf(key);
        const sectorCenter = isClass ? 0 : (jobIndex / Math.max(1, jobKeys.length)) * 2 * Math.PI;
        const maxClassTier = Math.max(1, ...(branches.get('__class__') || []).map(n => n.tier || 1));
        const baseRadius = isClass ? 0 : (maxClassTier + 1) * TIER_RADIUS;

        // Group by tier, position within tier deterministically.
        const byTier = new Map();
        for (const n of list) {
            const t = n.tier || 1;
            if (!byTier.has(t)) byTier.set(t, []);
            byTier.get(t).push(n);
        }
        for (const [tier, tierNodes] of byTier) {
            tierNodes.sort((a, b) => a.id.localeCompare(b.id));
            const count = tierNodes.length;
            tierNodes.forEach((n, i) => {
                let angle, radius;
                if (isClass) {
                    // Spread evenly around the ring, offset per-tier via the golden
                    // angle so consecutive rings don't align into spokes.
                    angle = (i / count) * 2 * Math.PI + tier * GOLDEN_ANGLE;
                    radius = tier * TIER_RADIUS;
                } else {
                    // Jobs: a 70° outward wedge, tiers extending the radius.
                    const sectorWidth = (70 * Math.PI) / 180;
                    angle = sectorCenter - sectorWidth / 2 + (count === 1 ? sectorWidth / 2 : (i / (count - 1)) * sectorWidth);
                    radius = baseRadius + (tier - 1) * TIER_RADIUS;
                }
                layout[n.id] = {
                    x: Math.round(Math.cos(angle) * radius),
                    y: Math.round(Math.sin(angle) * radius),
                    cluster: key,
                };
            });
        }
    }
    return layout;
}

// ── [SKILLS] memo block ────────────────────────────────────────────────────────

/**
 * Builds the [SKILLS] memo block from acquired ACTIVE skills (passives are
 * baked into [CHARACTER] stats at acquisition and excluded here). The format
 * matches the stock `skills` module prompt the extractor maintains.
 *
 * @param {object} progression
 * @param {object} [foundation] - resource name lookups
 * @returns {string} block text, or '' when no actives are acquired
 */
export function buildSkillsMemoBlock(progression, foundation = null) {
    const nodes = progression?.tree?.nodes || {};
    const resourceNames = new Map((foundation?.POWER_SYSTEM?.resources || []).map(r => [r.id, r.name]));

    const lines = [];
    for (const id of Object.keys(progression?.acquired || {}).sort()) {
        const n = nodes[id];
        if (!n || n.type !== 'active') continue;
        const costParts = [];
        if (n.resourceCost) {
            costParts.push(`${n.resourceCost.amount} ${resourceNames.get(n.resourceCost.resourceId) || n.resourceCost.resourceId}`);
        }
        if (n.cooldown) costParts.push(`CD ${n.cooldown.turns} turns: ready`);
        const cost = costParts.length ? costParts.join(', ') : 'at will';
        lines.push(`- ${n.name} (${cost}, active, ${n.descriptor})`);
    }

    return lines.length ? `[SKILLS]\n${lines.join('\n')}\n[/SKILLS]` : '';
}
