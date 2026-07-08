/**
 * skill-forge.js — generic System Definition mode (procedural skill tree).
 *
 * Ported from the Fatbody Framework (same author, MIT).
 *
 * Generates and validates skill-tree nodes. The secondary model "forges" one
 * tier of one branch (class or job) per call, constrained by the foundation's
 * taxonomy and a coarse JS power budget; everything that can be checked
 * deterministically IS checked deterministically, with the full error list fed
 * back to the model (≤3 retries).
 *
 * Timing contract (the anti-slowdown rule): tiers 1–2 are forged at class
 * selection (setup time); tier N+1 is pre-forged in the background once the
 * player approaches tier N's ceiling. Nothing is ever generated during a
 * roleplay turn.
 *
 * Validation is pure (node-testable). Forging touches the LLM client.
 *
 * Imports: state-manager.js, llm-client.js
 * Imported by: index.js, skilltree-bridge.js
 */

import { getSettings, getCampaignMode } from './state-manager.js';
import { sendAgentTurn } from './llm-client.js';

export const MAX_FORGE_RETRIES = 3;
/** Nodes per tier per branch — enough for meaningful choice, small enough to stay coherent. */
export const NODES_PER_TIER = { min: 4, max: 8 };
export const MAX_DESCRIPTOR_WORDS = 45;

// ── Power budget ───────────────────────────────────────────────────────────────

/**
 * Coarse numeric caps for a tier. Deliberately rough — the goal is catching a
 * tier-1 "deal 40d10" outlier, not simulating balance.
 * @param {number} tier - 1-based
 */
export function powerBudgetForTier(tier) {
    return {
        maxDiceTotal: 12 + 10 * tier,   // Σ (count × sides) across all dice in the effect
        maxFlatBonus: 2 + 2 * tier,     // largest +X modifier
        maxPercent: 10 + 5 * tier,      // largest X% effect
        maxCost: tier >= 8 ? 5 : 3,     // skill-point cost per node (capstones may run hot)
    };
}

/**
 * Extracts the coarse numeric profile of an effect string.
 * @param {string} effect
 * @returns {{diceTotal: number, maxFlat: number, maxPercent: number}}
 */
export function parseEffectNumbers(effect) {
    const text = String(effect || '');
    let diceTotal = 0;
    for (const m of text.matchAll(/(\d+)d(\d+)/gi)) {
        diceTotal += Number(m[1]) * Number(m[2]);
    }
    let maxFlat = 0;
    for (const m of text.matchAll(/\+\s*(\d+)(?!\s*d\d)/g)) {
        maxFlat = Math.max(maxFlat, Number(m[1]));
    }
    let maxPercent = 0;
    for (const m of text.matchAll(/(\d+)\s*%/g)) {
        maxPercent = Math.max(maxPercent, Number(m[1]));
    }
    return { diceTotal, maxFlat, maxPercent };
}

// ── Batch validation ───────────────────────────────────────────────────────────

/**
 * Validates one forged tier batch against the foundation, the existing tree,
 * and the power budget. Returns every problem found.
 *
 * @param {any[]} nodes - candidate skill nodes from the model
 * @param {object} opts
 * @param {object} opts.foundation - committed foundation
 * @param {number} opts.tier - tier being forged (1-based)
 * @param {string|null} [opts.jobId] - set when forging a job branch
 * @param {Record<string, object>} [opts.existingTree] - nodes already in the tree (id → node)
 * @param {string[]} [opts.graftAnchors] - acquired node ids a job branch may root on
 * @returns {{ok: boolean, errors: string[], nodes: object[]}}
 */
export function validateSkillBatch(nodes, { foundation, tier, jobId = null, existingTree = {}, graftAnchors = [] }) {
    const errors = [];
    const err = (m) => errors.push(m);

    if (!Array.isArray(nodes) || nodes.length === 0) {
        return { ok: false, errors: ['output must be a non-empty JSON array of skill nodes'], nodes: [] };
    }
    if (nodes.length < NODES_PER_TIER.min || nodes.length > NODES_PER_TIER.max) {
        err(`tier must contain ${NODES_PER_TIER.min}-${NODES_PER_TIER.max} nodes (got ${nodes.length})`);
    }

    const taxonomy = foundation?.SKILL_TAXONOMY || {};
    const levelGate = tier * (taxonomy.levelGatePerTier ?? 10);
    const rarityIds = new Set((taxonomy.rarityTiers || []).map(r => r.id));
    const resourceIds = new Set((foundation?.POWER_SYSTEM?.resources || []).map(r => r.id));
    const budget = powerBudgetForTier(tier);

    const batchIds = new Set();
    const knownIds = new Set([...Object.keys(existingTree), ...graftAnchors]);
    const normalized = [];

    nodes.forEach((n, i) => {
        const at = `nodes[${i}]${n?.id ? ` (${n.id})` : ''}`;
        if (!n || typeof n !== 'object') { err(`${at}: must be an object`); return; }

        if (typeof n.id !== 'string' || !/^[a-z0-9_]{2,48}$/.test(n.id)) {
            err(`${at}: id must be a lowercase slug (a-z, 0-9, _)`);
        } else if (batchIds.has(n.id) || n.id in existingTree) {
            err(`${at}: duplicate id`);
        } else {
            batchIds.add(n.id);
        }

        if (typeof n.name !== 'string' || !n.name.trim()) err(`${at}: name required`);
        if (n.tier !== tier) err(`${at}: tier must be ${tier}`);
        if (n.type !== 'active' && n.type !== 'passive') err(`${at}: type must be 'active' or 'passive'`);

        if (!Number.isInteger(n.cost) || n.cost < 1 || n.cost > budget.maxCost) {
            err(`${at}: cost must be an integer 1..${budget.maxCost}`);
        }

        // Prereqs: tier 1 of a class roots freely; later tiers must connect to
        // known nodes or earlier nodes in this batch. Job branches must root on
        // a provided graft anchor.
        const prereqs = Array.isArray(n.prereqs) ? n.prereqs : null;
        if (!prereqs) {
            err(`${at}: prereqs must be an array (use [] for roots)`);
        } else {
            for (const p of prereqs) {
                if (!knownIds.has(p) && !batchIds.has(p)) err(`${at}: prereq "${p}" does not resolve`);
                if (p === n.id) err(`${at}: cannot require itself`);
            }
            if (tier > 1 && prereqs.length === 0 && !jobId) {
                err(`${at}: tier ${tier} nodes must have at least one prereq`);
            }
            if (jobId && tier === 1 && prereqs.length === 0) {
                err(`${at}: job-branch nodes must connect (a graft anchor or another batch node)`);
            }
        }

        if (typeof n.effect !== 'string' || !n.effect.trim()) err(`${at}: effect (mechanical) required`);
        if (typeof n.descriptor !== 'string' || !n.descriptor.trim()) {
            err(`${at}: descriptor (canonical narrative text) required`);
        } else if (n.descriptor.trim().split(/\s+/).length > MAX_DESCRIPTOR_WORDS) {
            err(`${at}: descriptor must be ≤ ${MAX_DESCRIPTOR_WORDS} words`);
        }

        if (n.rarity !== undefined && rarityIds.size && !rarityIds.has(n.rarity)) {
            err(`${at}: rarity "${n.rarity}" not in taxonomy (${[...rarityIds].join(', ')})`);
        }

        if (n.type === 'active') {
            const hasResource = n.resourceCost && typeof n.resourceCost === 'object';
            const hasCooldown = n.cooldown && typeof n.cooldown === 'object';
            if (!hasResource && !hasCooldown) {
                err(`${at}: active skills need a resourceCost and/or cooldown (no free spam)`);
            }
            if (hasResource) {
                if (!resourceIds.has(n.resourceCost.resourceId)) {
                    err(`${at}: resourceCost.resourceId "${n.resourceCost?.resourceId}" is not a valid resource id — use EXACTLY one of these lowercase ids: ${[...resourceIds].join(', ')}`);
                }
                if (!Number.isFinite(n.resourceCost.amount) || n.resourceCost.amount <= 0) {
                    err(`${at}: resourceCost.amount must be > 0`);
                }
            }
            if (hasCooldown && (!Number.isInteger(n.cooldown.turns) || n.cooldown.turns < 1)) {
                err(`${at}: cooldown.turns must be an integer ≥ 1`);
            }
        } else if (n.type === 'passive') {
            if (n.resourceCost) err(`${at}: passives cannot have a resourceCost`);
        }

        // Power budget
        const p = parseEffectNumbers(n.effect);
        if (p.diceTotal > budget.maxDiceTotal) err(`${at}: dice total ${p.diceTotal} exceeds tier-${tier} budget ${budget.maxDiceTotal}`);
        if (p.maxFlat > budget.maxFlatBonus) err(`${at}: flat bonus +${p.maxFlat} exceeds tier-${tier} budget +${budget.maxFlatBonus}`);
        if (p.maxPercent > budget.maxPercent) err(`${at}: ${p.maxPercent}% exceeds tier-${tier} budget ${budget.maxPercent}%`);

        normalized.push({
            id: n.id, name: (n.name || '').trim(), tier, type: n.type,
            cost: n.cost, prereqs: prereqs || [],
            effect: (n.effect || '').trim(), descriptor: (n.descriptor || '').trim(),
            resourceCost: n.type === 'active' && n.resourceCost ? { resourceId: n.resourceCost.resourceId, amount: n.resourceCost.amount } : null,
            cooldown: n.type === 'active' && n.cooldown ? { turns: n.cooldown.turns } : null,
            jobId: jobId || undefined,
            rarity: n.rarity,
            levelGate,
        });
    });

    // Job graft: at least ONE tier-1 node must root on an acquired anchor so the
    // branch attaches to the unified class tree (others may chain inside the batch).
    if (jobId && tier === 1 && graftAnchors.length) {
        const anchored = nodes.some(n => Array.isArray(n?.prereqs) && n.prereqs.some(p => graftAnchors.includes(p)));
        if (!anchored) {
            err(`job branch must graft onto the class tree: at least one node needs a prereq from the anchors (${graftAnchors.join(', ')})`);
        }
    }

    // Cycle check across existing tree + batch (prereq edges must form a DAG).
    if (errors.length === 0) {
        const all = { ...existingTree };
        for (const n of normalized) all[n.id] = n;
        const cycle = findCycle(all);
        if (cycle) err(`prereq cycle detected: ${cycle.join(' → ')}`);
    }

    return { ok: errors.length === 0, errors, nodes: normalized };
}

/**
 * Detects a prereq cycle in a node map. Returns the cycle path or null.
 * @param {Record<string, {prereqs?: string[]}>} nodeMap
 * @returns {string[]|null}
 */
export function findCycle(nodeMap) {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map(Object.keys(nodeMap).map(k => [k, WHITE]));
    const stack = [];

    function visit(id) {
        color.set(id, GRAY);
        stack.push(id);
        for (const p of (nodeMap[id]?.prereqs || [])) {
            if (!(p in nodeMap)) continue; // graft anchors live outside the map
            if (color.get(p) === GRAY) return [...stack.slice(stack.indexOf(p)), p];
            if (color.get(p) === WHITE) {
                const found = visit(p);
                if (found) return found;
            }
        }
        color.set(id, BLACK);
        stack.pop();
        return null;
    }

    for (const id of Object.keys(nodeMap)) {
        if (color.get(id) === WHITE) {
            const found = visit(id);
            if (found) return found;
        }
    }
    return null;
}

// ── Forge prompts ──────────────────────────────────────────────────────────────

function forgePrompt({ foundation, branch, tier, existingTree, graftAnchors }) {
    const taxonomy = foundation.SKILL_TAXONOMY || {};
    const budget = powerBudgetForTier(tier);
    const resources = (foundation.POWER_SYSTEM?.resources || []).map(r => `${r.id} (${r.name})`).join(', ');
    const resourceIdList = (foundation.POWER_SYSTEM?.resources || []).map(r => r.id).join(', ') || '(none)';
    const rarities = (taxonomy.rarityTiers || []).map(r => r.id).join(' | ');
    const existingSummary = Object.values(existingTree)
        .filter(n => (branch.jobId ? n.jobId === branch.jobId : !n.jobId))
        .map(n => `- ${n.id} (T${n.tier}, ${n.type}): ${n.name}`)
        .join('\n');

    return `You are the Skill Forge for a custom RPG. Generate tier ${tier} of the skill tree branch below as a single fenced \`\`\`json array of ${NODES_PER_TIER.min}-${NODES_PER_TIER.max} skill node objects. No commentary after the block.

## WORLD & POWER SYSTEM
${foundation.SETTING?.name}: ${foundation.SETTING?.synopsis}
${foundation.POWER_SYSTEM?.name}: ${foundation.POWER_SYSTEM?.description}
Resources for active skills: ${resources}
Damage types: ${(taxonomy.damageTypes || []).join(', ')}
Naming convention: ${taxonomy.namingConvention || 'evocative but concise'}

## BRANCH
${branch.jobId
        ? `Job: ${branch.name} — ${branch.description || ''}\nThis is a JOB branch grafted onto the class tree. Tier-1 nodes MUST include one of these acquired anchor nodes in prereqs: ${graftAnchors.join(', ')}`
        : `Class: ${branch.name} (${branch.role}) — ${branch.fantasy}\nTree themes: ${(branch.treeThemes || []).join(', ')}`}

## EXISTING NODES IN THIS BRANCH (connect tier ${tier} onto these; do not duplicate)
${existingSummary || '(none yet — this is the root tier)'}

## NODE SCHEMA
{ "id": "lowercase_slug", "name": "...", "tier": ${tier}, "type": "active"|"passive",
  "cost": 1-${budget.maxCost}, "prereqs": ["existing_or_batch_id", ...],
  "effect": "exact mechanics with numbers (dice, bonuses, durations)",
  "descriptor": "≤${MAX_DESCRIPTOR_WORDS} words of canonical narrative — EXACTLY how this skill looks/feels when used; the narrator must match its scale forever",
  "resourceCost": {"resourceId": "<EXACT lowercase id, one of: ${resourceIdList}>", "amount": N} (actives),
  "cooldown": {"turns": N} (actives, optional),
  "rarity": "${rarities}" }

## HARD RULES
- ${NODES_PER_TIER.min}-${NODES_PER_TIER.max} nodes, all tier ${tier}. Mix of active and passive (at least 1 of each).
- Tier ${tier} power budget: dice total ≤ ${budget.maxDiceTotal} (Σ count×sides), flat bonuses ≤ +${budget.maxFlatBonus}, percentages ≤ ${budget.maxPercent}%.
- Every active needs a resourceCost and/or cooldown. Passives never cost resources.
- resourceCost.resourceId MUST be one of these EXACT lowercase ids: ${resourceIdList}. Use the id, NEVER the capitalized display name.
- ${tier > 1 ? `Every node's prereqs must reference existing branch nodes or other nodes in this batch.` : 'Root-tier class nodes may have empty prereqs ([]).'}
- Descriptors are forever-binding consistency contracts: concrete scale, element, and visual character. No vague "powerful blast".`;
}

// ── Forging ────────────────────────────────────────────────────────────────────

/** Extracts the last fenced JSON array from model output. */
export function extractNodeArray(text) {
    if (typeof text !== 'string' || !text.trim()) return null;
    const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)];
    const candidates = fences.length ? [fences[fences.length - 1][1]] : [text];
    for (const c of candidates) {
        try {
            const parsed = JSON.parse(c.trim());
            if (Array.isArray(parsed)) return parsed;
        } catch (_) { /* fall through */ }
    }
    return null;
}

/**
 * Forges one tier of one branch via the secondary model, with validation
 * feedback retries. Returns normalized nodes (NOT yet written to the tree —
 * the caller merges and saves).
 *
 * @param {object} p
 * @param {object} p.foundation
 * @param {object} p.branch - class entry ({id,name,fantasy,role,treeThemes}) or job ({jobId,name,description})
 * @param {number} p.tier
 * @param {Record<string, object>} [p.existingTree]
 * @param {string[]} [p.graftAnchors]
 * @param {AbortSignal|null} [p.signal]
 * @returns {Promise<{nodes: object[], attempts: number}>}
 * @throws when no valid batch emerges within MAX_FORGE_RETRIES
 */
export async function forgeTier({ foundation, branch, tier, existingTree = {}, graftAnchors = [], signal = null }) {
    const messages = [
        { role: 'system', content: 'You generate balanced, schema-exact RPG skill nodes as JSON. Follow the user specification precisely.' },
        { role: 'user', content: forgePrompt({ foundation, branch, tier, existingTree, graftAnchors }) },
    ];

    let lastErrors = [];
    for (let attempt = 1; attempt <= MAX_FORGE_RETRIES; attempt++) {
        const { content } = await sendAgentTurn(getSettings(), messages, null, signal);
        messages.push({ role: 'assistant', content });

        const raw = extractNodeArray(content);
        if (!raw) {
            lastErrors = ['no parseable JSON array found'];
            messages.push({ role: 'user', content: 'Your reply contained no parseable ```json array. Output ONLY the node array in one fenced block.' });
            continue;
        }

        const jobId = branch.jobId || null;
        const { ok, errors, nodes } = validateSkillBatch(raw, { foundation, tier, jobId, existingTree, graftAnchors });
        if (ok) return { nodes, attempts: attempt };

        lastErrors = errors;
        messages.push({ role: 'user', content: `The batch failed validation. Fix EVERY issue and output the corrected complete array again:\n- ${errors.join('\n- ')}` });
    }

    const e = new Error(`Skill Forge: no valid tier-${tier} batch after ${MAX_FORGE_RETRIES} attempts:\n- ${lastErrors.join('\n- ')}`);
    /** @type {any} */ (e).validationErrors = lastErrors;
    throw e;
}

/**
 * Class selection: locks the class and forges its starting tiers (1–2).
 * Setup-time operation — the user is in campaign creation and expects a wait.
 *
 * @param {string} chatId
 * @param {string} classId - must be a CLASS_ROSTER id
 * @param {(msg: string) => void} [onProgress]
 * @returns {Promise<{nodeCount: number}>}
 */
export async function selectClassAndForge(chatId, classId, onProgress = () => {}) {
    const settings = getSettings();
    const st = settings.chatStates?.[chatId];
    const foundation = st?.foundation;
    if (!foundation) throw new Error('No committed foundation for this chat.');
    const branch = (foundation.CLASS_ROSTER || []).find(c => c.id === classId);
    if (!branch) throw new Error(`Unknown class "${classId}".`);
    const prog = st.progression;
    if (!prog) throw new Error('No progression state — commit the foundation first.');
    if (prog.classId && prog.classId !== classId) throw new Error('Class is locked for this campaign.');

    prog.classId = classId;
    if (!prog.tree) prog.tree = { nodes: {}, layout: {}, tiersGenerated: {} };

    let total = 0;
    try {
        for (const tier of [1, 2]) {
            if ((prog.tree.tiersGenerated[classId] || 0) >= tier) continue;
            onProgress(`Forging ${branch.name} — tier ${tier}…`);
            const { nodes } = await forgeTier({ foundation, branch, tier, existingTree: prog.tree.nodes });
            for (const n of nodes) prog.tree.nodes[n.id] = n;
            prog.tree.tiersGenerated[classId] = tier;
            total += nodes.length;
            SillyTavern.getContext().saveSettingsDebounced();
        }
    } catch (e) {
        // The class only locks once something was actually forged for it. If
        // tier 1 never landed, release the lock so the user can still pick a
        // different class instead of being trapped on a dead choice.
        if ((prog.tree.tiersGenerated[classId] || 0) === 0) {
            prog.classId = null;
            SillyTavern.getContext().saveSettingsDebounced();
        }
        throw e;
    }
    return { nodeCount: total };
}

// ── Background pre-generation ──────────────────────────────────────────────────

const _forgeInFlight = new Set();

/**
 * Ensures the next tier of the player's class branch (and active job branches)
 * exists once the player approaches the current ceiling. Fire-and-forget,
 * single-flight per chat — called from the level-up path; never blocks a turn.
 *
 * Trigger: level ≥ N·gate − gate/2 where N is the next ungenerated tier.
 *
 * @param {string} chatId
 * @returns {Promise<boolean>} true if a forge ran
 */
export async function ensureTierPregenerated(chatId) {
    if (!chatId || _forgeInFlight.has(chatId)) return false;
    const settings = getSettings();
    if (getCampaignMode(chatId) !== 'modern') return false;
    const st = settings.chatStates?.[chatId];
    const prog = st?.progression;
    const foundation = st?.foundation;
    if (!prog?.classId || !foundation) return false;

    const gate = foundation.SKILL_TAXONOMY?.levelGatePerTier ?? 10;
    const tierCount = foundation.SKILL_TAXONOMY?.tierCount ?? 10;

    const branchKeys = [prog.classId, ...(prog.jobIds || [])];
    let target = null;
    for (const key of branchKeys) {
        const have = prog.tree?.tiersGenerated?.[key] || 0;
        const next = have + 1;
        if (next > tierCount) continue;
        if (prog.level >= next * gate - Math.floor(gate / 2)) {
            target = { key, tier: next };
            break;
        }
    }
    if (!target) return false;

    _forgeInFlight.add(chatId);
    try {
        const isJob = target.key !== prog.classId;
        const branch = isJob
            ? { jobId: target.key, ...(foundation.JOB_RULES?.jobSeeds || []).find(j => j.id === target.key) }
            : (foundation.CLASS_ROSTER || []).find(c => c.id === prog.classId);
        if (!branch) return false;

        const graftAnchors = isJob && target.tier === 1
            ? Object.keys(prog.acquired || {})
            : [];

        const { nodes } = await forgeTier({
            foundation, branch, tier: target.tier,
            existingTree: prog.tree?.nodes || {}, graftAnchors,
        });

        if (!prog.tree) prog.tree = { nodes: {}, layout: {}, tiersGenerated: {} };
        for (const n of nodes) prog.tree.nodes[n.id] = n;
        prog.tree.tiersGenerated[target.key] = target.tier;
        SillyTavern.getContext().saveSettingsDebounced();
        console.log(`[RPG Tracker] Skill Forge: pre-generated tier ${target.tier} of "${target.key}" (${nodes.length} nodes).`);
        // Dynamic import keeps this module's node-test import graph DOM-free.
        try {
            const { pushSkillTreeState } = await import('./skilltree-bridge.js');
            pushSkillTreeState(chatId);
        } catch (_) { /* tab refresh is best-effort (skilltree-bridge is optional) */ }
        return true;
    } catch (e) {
        console.warn('[RPG Tracker] Skill Forge background pass failed:', e.message || e);
        return false;
    } finally {
        _forgeInFlight.delete(chatId);
    }
}
