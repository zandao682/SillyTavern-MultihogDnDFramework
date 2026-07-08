/**
 * leveling-strategy.js — the lightweight "leveling" skill-model strategy:
 * skills that simply gain a numeric level with use or experience, no categories
 * and no prereq tree. Proves the strategy pattern extends cheaply.
 *
 * Implemented on the shared progression engine (capability-progression.js) with a
 * single config-driven profile (default `use_tracked`, threshold 100). State lives
 * under progression.groups[groupId].skills keyed by slug. Pure module.
 *
 * Config: { type?: 'use_tracked'|'counter'|'points_tiers'|'xp_levels', threshold?,
 *           levels_per_tier?, cost_formula?, tier_names?, points_label?, memoTag? }
 *
 * Imports: capability-progression.js
 * Imported by: skill-model.js (lazy)
 */

import { newProg, advance, progTierNames, progIsProgressing } from './capability-progression.js';

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const ALLOWED = ['counter', 'use_tracked', 'points_tiers', 'xp_levels'];

function profileFor(group) {
    const c = group?.config || {};
    return {
        id: 'lvl',
        type: ALLOWED.includes(c.type) ? c.type : 'use_tracked',
        threshold: c.threshold || 100,
        levels_per_tier: c.levels_per_tier || 10,
        cost_formula: c.cost_formula,
        tier_names: c.tier_names,
    };
}

/** Points needed for the next level under this profile (threshold vs tiered cost). */
function nextDenom(p, prog) {
    return (p.type === 'use_tracked') ? (p.threshold || 0) : (prog.points_needed || 0);
}

function store(progression, group) {
    if (!progression.groups) progression.groups = {};
    if (!progression.groups[group.id]) progression.groups[group.id] = { skills: {} };
    if (!progression.groups[group.id].skills) progression.groups[group.id].skills = {};
    return progression.groups[group.id].skills;
}

function validateConfig(config) {
    const errors = [];
    if (config?.type !== undefined && !ALLOWED.includes(config.type)) {
        errors.push(`leveling.type must be one of: ${ALLOWED.join(', ')}`);
    }
    if (config?.threshold !== undefined && (typeof config.threshold !== 'number' || config.threshold < 1)) {
        errors.push('leveling.threshold must be a number ≥ 1');
    }
    return errors;
}

/** Advance skills by records {name, xp?/uses?/points?, level?}. Mutates progression. */
function applyUpdate(progression, group, foundation, records) {
    const p = profileFor(group);
    const skills = store(progression, group);
    const notes = [];
    for (const rec of (records || [])) {
        if (!rec?.name) continue;
        const s = slug(rec.name);
        let sk = Object.values(skills).find(x => slug(x.name) === s);
        if (!sk) { sk = { name: rec.name, prog: newProg(p) }; skills[s] = sk; }
        const amount = rec.xp ?? rec.uses ?? rec.points;
        for (const n of advance(sk.prog, p, { points: amount, level: rec.level })) {
            notes.push({ type: n.type, msg: `${sk.name}: ${n.msg}` });
        }
    }
    return notes;
}

function memoBlock(progression, group) {
    const p = profileFor(group);
    const tag = group?.config?.memoTag || 'SKILL_LEVELS';
    const skills = Object.values(store(progression, group));
    if (!skills.length) return '';
    const lines = skills.sort((a, b) => a.name.localeCompare(b.name)).map(sk => {
        const tierName = (p.type === 'points_tiers' || p.type === 'xp_levels') ? `${progTierNames(p)[sk.prog.tier_idx] || ''} ` : '';
        const denom = nextDenom(p, sk.prog);
        const prog = denom ? ` (${sk.prog.points}/${denom})` : '';
        return `- ${sk.name}: ${tierName}Lv ${sk.prog.level}${prog}`;
    });
    return `[${tag}]\n${lines.join('\n')}\n[/${tag}]`;
}

function syspromptFragment(group) {
    const tag = group?.config?.memoTag || 'SKILL_LEVELS';
    const label = group?.config?.points_label || 'XP';
    return `<skill_leveling>
The character has SKILLS that level with use/experience (group: ${group.label || group.id}). When a skill is trained or used meaningfully, award progress inline like *(+N ${label} — skill name)*; the engine raises the level — do NOT set levels yourself. The [${tag}] block in the STATE MEMO is authoritative.
</skill_leveling>`;
}

function panelRender(progression, state, group) {
    const p = profileFor(group);
    const skills = Object.values(store(progression, group));
    if (!skills.length) return '';
    const rows = skills.sort((a, b) => a.name.localeCompare(b.name)).map(sk => {
        let bar = '';
        const denom = nextDenom(p, sk.prog);
        if (progIsProgressing(p) && denom > 0) {
            const pct = Math.min(100, (sk.prog.points / denom) * 100);
            bar = `<div class="rt-cap-bar"><div class="rt-cap-bar-fill" style="width:${pct}%"></div></div><span class="rt-cap-pp">${sk.prog.points}/${denom}</span>`;
        }
        return `<div class="rt-cap-row"><span class="rt-cap-name">${esc(sk.name)}</span><span class="rt-cap-tag">Lv ${sk.prog.level}</span>${bar}</div>`;
    }).join('');
    return `<div class="rt-cap-group" data-group="${esc(group.id)}"><div class="rt-cap-group-title">${esc(group.label || 'Skills')}</div>${rows}</div>`;
}

/** Instruction for the 2nd-pass extractor. */
function extractorHint(group) {
    const tag = group?.config?.memoTag || 'SKILL_LEVELS';
    return `[${tag}] — one line per leveling skill: "- Name: Lv N (points/next)". Keep all skills, add new ones, and update level/points as the narration awards ${group?.config?.points_label || 'XP'}.`;
}

export const strategy = { id: 'leveling', validateConfig, memoBlock, syspromptFragment, panelRender, extractorHint, progressionOps: { applyUpdate } };
export { validateConfig, applyUpdate, memoBlock, syspromptFragment, panelRender, extractorHint };
