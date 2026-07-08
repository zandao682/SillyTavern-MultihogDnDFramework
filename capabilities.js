/**
 * capabilities.js — the "capabilities" skill-model strategy (Veridia-style).
 *
 * Category-based capabilities whose progression is formula-driven and per-category:
 * a system can have skills that level on use AND capabilities that never level, at
 * once. Engine-tracked (the deterministic math lives in capability-progression.js
 * and runs here, not in the model), stored under
 * progression.groups[groupId].capabilities keyed by id.
 *
 * Conforms to the skill-model strategy interface. Pure module (no DOM/ST) — memo,
 * sysprompt, and panel outputs are plain strings; state is plain objects. Design
 * re-derived from the GM Lore Parser capability model (AGPL — reimplemented).
 *
 * Imports: capability-progression.js, formula-eval.js
 * Imported by: skill-model.js (lazy)
 */

import {
    newProg, advance, progIsProgressing, progTierNames, progHasScore, totalLevels, recomputeScore,
} from './capability-progression.js';
import { isFormulaSafe } from './formula-eval.js';

const PROGRESSION_TYPES = ['none', 'counter', 'use_tracked', 'milestone', 'points_tiers', 'xp_levels'];
const FORMULA_VARS = ['tier_rank', 'skill_level', 'total_levels'];

// ── Config resolution ──────────────────────────────────────────────────────────

function cfgFor(group) {
    const c = group?.config || {};
    return {
        categories: Array.isArray(c.categories) && c.categories.length ? c.categories : ['boon', 'title', 'passive', 'trait', 'skill'],
        default_category: c.default_category || 'boon',
        default_activation: c.default_activation || 'always',
        exclusive_category: c.exclusive_category || 'title',
        category_progression: c.category_progression || {},
        progressions: Array.isArray(c.progressions) && c.progressions.length ? c.progressions : [{ id: 'none', type: 'none' }],
        require_granted: c.require_granted === true,
        memoTag: c.memoTag || 'CAPABILITIES',
    };
}

function profileFor(cfg, cap) {
    const id = cap.progression_id || cfg.category_progression[cap.category] || 'none';
    return cfg.progressions.find(p => p.id === id) || { id: 'none', type: 'none' };
}

function firstProgressingCategory(cfg) {
    for (const [cat, prof] of Object.entries(cfg.category_progression)) if (prof && prof !== 'none') return cat;
    return null;
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const capLabel = (c) => c ? c.charAt(0).toUpperCase() + c.slice(1) + 's' : c;

/** The capability map for a group (created on demand). */
function store(progression, group) {
    if (!progression.groups) progression.groups = {};
    if (!progression.groups[group.id]) progression.groups[group.id] = { capabilities: {} };
    if (!progression.groups[group.id].capabilities) progression.groups[group.id].capabilities = {};
    return progression.groups[group.id].capabilities;
}

// ── Strategy interface ───────────────────────────────────────────────────────────

/** Validate a capabilities group's config; returns an array of error strings. */
function validateConfig(config) {
    const errors = [];
    const c = config || {};
    if (c.categories !== undefined && !Array.isArray(c.categories)) errors.push('capabilities.categories must be an array');
    if (c.progressions !== undefined) {
        if (!Array.isArray(c.progressions)) errors.push('capabilities.progressions must be an array');
        else c.progressions.forEach((p, i) => {
            if (!p || typeof p.id !== 'string' || !p.id.trim()) errors.push(`progressions[${i}].id is required`);
            if (!PROGRESSION_TYPES.includes(p?.type)) errors.push(`progressions[${i}].type must be one of: ${PROGRESSION_TYPES.join(', ')}`);
            for (const key of ['cost_formula', 'score_formula']) {
                if (p?.[key] !== undefined && !isFormulaSafe(p[key], FORMULA_VARS)) {
                    errors.push(`progressions[${i}].${key} "${p[key]}" is not a safe arithmetic formula over ${FORMULA_VARS.join(', ')}`);
                }
            }
        });
    }
    if (c.category_progression !== undefined && (typeof c.category_progression !== 'object' || Array.isArray(c.category_progression))) {
        errors.push('capabilities.category_progression must be an object mapping category → progression id');
    }
    return errors;
}

/**
 * Apply progression updates (deterministic). Records: {name, points?, level?,
 * category?, progression?, active?, description?}. Creates capabilities lazily
 * unless require_granted. Mutates progression; returns notifications.
 */
function applyUpdate(progression, group, foundation, records) {
    const cfg = cfgFor(group);
    const caps = store(progression, group);
    const notes = [];

    for (const rec of (records || [])) {
        if (!rec?.name) continue;
        const s = slug(rec.name);
        let cap = Object.values(caps).find(c => slug(c.name) === s);

        if (!cap && cfg.require_granted) {
            notes.push({ type: 'rejected', msg: `"${rec.name}" is not granted — must be granted before it can progress.` });
            continue;
        }
        if (!cap) {
            const category = (rec.category || firstProgressingCategory(cfg) || cfg.default_category).toLowerCase();
            cap = {
                id: `${category}:${s}`,
                name: rec.name,
                category,
                progression_id: rec.progression || cfg.category_progression[category] || 'none',
                activation: cfg.default_activation,
                active: category !== cfg.exclusive_category,
                description: rec.description || '',
                prog: null,
            };
            cap.prog = newProg(profileFor(cfg, cap));
            caps[cap.id] = cap;
        }
        if (rec.description && !cap.description) cap.description = rec.description;

        // Exclusivity toggle (e.g. one active title)
        if (rec.active !== undefined && rec.active !== null) {
            cap.active = !!rec.active;
            if (cap.active && cap.category === cfg.exclusive_category) {
                for (const o of Object.values(caps)) if (o !== cap && o.category === cfg.exclusive_category) o.active = false;
            }
        }

        const p = profileFor(cfg, cap);
        for (const n of advance(cap.prog, p, { points: rec.points, level: rec.level })) {
            notes.push({ type: n.type, msg: `${cap.name}: ${n.msg}` });
        }
    }

    // Recompute derived scores across the group (total_levels changed).
    const all = Object.values(caps);
    const profOf = (c) => profileFor(cfg, c);
    const tl = totalLevels(all, profOf);
    for (const cap of all) recomputeScore(cap.prog, profOf(cap), tl);

    return notes;
}

/** [CAPABILITIES] memo block from the current engine state (authoritative for the narrator). */
function memoBlock(progression, group /*, foundation */) {
    const cfg = cfgFor(group);
    const caps = Object.values(store(progression, group));
    if (!caps.length) return '';
    const lines = caps
        .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
        .map(cap => {
            const p = profileFor(cfg, cap);
            let tag = '';
            if (progIsProgressing(p)) {
                const tier = progTierNames(p)[cap.prog.tier_idx] || `T${cap.prog.tier_idx + 1}`;
                const score = progHasScore(p) ? ` · ${cap.prog.score}` : '';
                const pp = cap.prog.points_needed ? ` · ${cap.prog.points}/${cap.prog.points_needed}` : '';
                tag = ` [${tier} Lv${cap.prog.level}${score}${pp}]`;
            }
            const act = cap.active === false ? ' (inactive)' : '';
            const desc = cap.description ? `: ${cap.description}` : '';
            return `- ${cap.name} (${cap.category})${tag}${act}${desc}`;
        });
    return `[${cfg.memoTag}]\n${lines.join('\n')}\n[/${cfg.memoTag}]`;
}

/** Narrator rules fragment appended to the modern sysprompt. */
function syspromptFragment(group /*, foundation */) {
    const cfg = cfgFor(group);
    const catLines = cfg.categories.map(c => {
        const prof = cfg.category_progression[c] || 'none';
        return `  - ${c}${prof !== 'none' ? ` → advances via "${prof}"` : ' (static, never levels)'}`;
    });
    const progLines = cfg.progressions.filter(p => p.type !== 'none')
        .map(p => `  - ${p.id} (${p.type})${p.points_label ? `, points labelled "${p.points_label}"` : ''}`);
    const ptLabel = (cfg.progressions.find(p => p.points_label)?.points_label) || 'progression';

    return `<capabilities>
The character's CAPABILITIES (group: ${group.label || group.id}) are grouped by category. Categories and how each advances:
${catLines.join('\n')}
${progLines.length ? `Progression profiles:\n${progLines.join('\n')}` : 'All capabilities in this group are static.'}

RULES:
- The [${cfg.memoTag}] block in the STATE MEMO is the single source of truth for what the character has and their current tier/level — honor it exactly.
- When the character trains, uses, or is rewarded for a PROGRESSING capability, award points inline like *(+N ${ptLabel} — capability name — reason)*. Do NOT compute the new tier/level yourself; the engine advances it from the points and updates the block.
- Static capabilities never level — narrate their effect consistently.
- Only one ${cfg.exclusive_category} may be active at a time.
- Do not invent capabilities the block doesn't list; if the story grants a new one, state it clearly so it can be recorded.
</capabilities>`;
}

/** Category-grouped panel HTML for this group. */
function panelRender(progression, state, group /*, foundation */) {
    const cfg = cfgFor(group);
    const caps = Object.values(store(progression, group));
    if (!caps.length) return '';
    const byCat = {};
    for (const c of caps) (byCat[c.category] = byCat[c.category] || []).push(c);
    const order = [...cfg.categories, ...Object.keys(byCat).filter(k => !cfg.categories.includes(k))];

    const sections = [];
    for (const cat of order) {
        const members = byCat[cat];
        if (!members || !members.length) continue;
        const rows = members.map(cap => {
            const p = profileFor(cfg, cap);
            let tag = '';
            if (progIsProgressing(p)) {
                const tier = progTierNames(p)[cap.prog.tier_idx] || `T${cap.prog.tier_idx + 1}`;
                tag = `<span class="rt-cap-tag">${esc(tier)} Lv${cap.prog.level}${progHasScore(p) ? ` · ${cap.prog.score}` : ''}</span>`;
            }
            let bar = '';
            if (progIsProgressing(p) && cap.prog.points_needed > 0) {
                const pct = Math.min(100, (cap.prog.points / cap.prog.points_needed) * 100);
                bar = `<div class="rt-cap-bar"><div class="rt-cap-bar-fill" style="width:${pct}%"></div></div><span class="rt-cap-pp">${cap.prog.points}/${cap.prog.points_needed}</span>`;
            }
            const desc = cap.description ? `<div class="rt-cap-desc">${esc(cap.description)}</div>` : '';
            return `<div class="rt-cap-row${cap.active === false ? ' rt-cap-inactive' : ''}"><span class="rt-cap-name">${esc(cap.name)}</span>${tag}${bar}${desc}</div>`;
        }).join('');
        sections.push(`<details class="rt-cap-cat rt-cap-cat-${esc(cat)}" open><summary>${esc(capLabel(cat))} (${members.length})</summary>${rows}</details>`);
    }
    return `<div class="rt-cap-group" data-group="${esc(group.id)}"><div class="rt-cap-group-title">${esc(group.label || 'Capabilities')}</div>${sections.join('')}</div>`;
}

/** Instruction for the 2nd-pass extractor: which block to maintain and how. */
function extractorHint(group) {
    const cfg = cfgFor(group);
    return `[${cfg.memoTag}] — one line per capability the character has. Progressing: "- Name (category) [Tier LvN · score · points/needed]"; static: "- Name (category)". Categories: ${cfg.categories.join(', ')}. Keep every owned capability, add newly-gained ones, and update points/level whenever the narration awards points.`;
}

export const strategy = {
    id: 'capabilities',
    validateConfig,
    memoBlock,
    syspromptFragment,
    panelRender,
    extractorHint,
    progressionOps: { applyUpdate, profileFor: (group, cap) => profileFor(cfgFor(group), cap) },
};

// Named exports for tests / wiring.
export { validateConfig, applyUpdate, memoBlock, syspromptFragment, panelRender, extractorHint, cfgFor, profileFor };
