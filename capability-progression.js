/**
 * capability-progression.js — formula-driven progression math for the
 * "capabilities" skill-model strategy.
 *
 * A capability's CATEGORY says what it is; its PROGRESSION PROFILE says how it
 * advances (or not) — the two are orthogonal, so one system can have skills that
 * level on use AND capabilities that never level, at the same time. That is the
 * Veridia case this strategy targets.
 *
 * Profile types: 'none' (static) | 'counter' | 'use_tracked' | 'milestone' |
 * 'points_tiers' | 'xp_levels'. Costs/scores come from arithmetic formulas
 * evaluated by the shared whitelist sandbox (formula-eval.js) over the vars
 * { tier_rank, skill_level, total_levels } — exactly GLP's evaluator surface.
 *
 * Pure module: no DOM, no ST, no settings. node-testable. Design re-derived from
 * the GM Lore Parser capability model (AGPL — behavior reimplemented, not copied).
 *
 * Imports: formula-eval.js (leaf)
 */

import { evalFormula } from './formula-eval.js';

/** Fallback tier vocabulary when a profile doesn't provide `tier_names`. */
export const DEFAULT_TIER_NAMES = Object.freeze([
    'Novice', 'Apprentice', 'Adept', 'Expert', 'Master',
    'Grandmaster', 'Legendary', 'Mythic', 'Paragon', 'Transcendent',
]);

export function progIsProgressing(p) { return !!(p && p.type && p.type !== 'none'); }
export function progTierNames(p) {
    return (p && Array.isArray(p.tier_names) && p.tier_names.length) ? p.tier_names : DEFAULT_TIER_NAMES;
}
export function progLpt(p) { return (p && p.levels_per_tier) ?? 10; }
export function progHasScore(p) { return !!(p && p.score_formula); }

/** Point cost of the next level, from the profile's cost_formula (fallback 100·tier_rank). */
export function progCost(p, vars) {
    const tr = vars.tier_rank || 1;
    return Math.max(1, Math.round(evalFormula(p && p.cost_formula, vars, 100 * tr)));
}

/** Derived numeric score from the profile's score_formula (fallback 10). */
export function progScore(p, vars) {
    return Math.round(evalFormula(p && p.score_formula, vars, 10));
}

/** Fresh progression state for a capability under profile `p`. */
export function newProg(p) {
    const prog = { tier_idx: 0, level: 0, points: 0, points_needed: 0, total_levels: 0, score: 0, branches: [] };
    if (p && (p.type === 'points_tiers' || p.type === 'xp_levels')) {
        prog.points_needed = progCost(p, { tier_rank: 1, skill_level: 0 });
        prog.total_levels = 1; // level-0 counts as 1 for the level-cap formula
    }
    return prog;
}

/**
 * Advance one capability's progression by an update record. Mutates `prog`.
 * @param {object} prog - the capability's progression state
 * @param {object} p - the progression profile
 * @param {{points?: number, level?: number|null}} rec
 * @returns {Array<{type:string, msg:string}>} notifications
 */
export function advance(prog, p, rec = {}) {
    const notes = [];
    const type = (p && p.type) || 'none';
    const points = Number.isFinite(rec.points) ? rec.points : 0;
    const recLevel = (rec.level === null || rec.level === undefined) ? null : Number(rec.level);

    switch (type) {
        case 'counter':
            if (recLevel !== null && Number.isFinite(recLevel)) prog.level = recLevel;
            else prog.level += (points || 1);
            notes.push({ type: 'level', msg: `Level ${prog.level}` });
            break;

        case 'use_tracked': {
            const threshold = p.threshold || 5;
            prog.points += (points || 1);
            while (prog.points >= threshold) {
                prog.points -= threshold;
                prog.level += 1;
                notes.push({ type: 'level', msg: `Level ${prog.level}` });
            }
            break;
        }

        case 'milestone':
            if (recLevel !== null && Number.isFinite(recLevel)) {
                prog.level = recLevel;
                notes.push({ type: 'milestone', msg: `Milestone ${prog.level}` });
            }
            break;

        case 'points_tiers':
        case 'xp_levels': {
            if (!(points > 0)) break;
            const lpt = progLpt(p);
            prog.points += points;
            let advanced = false;
            while (prog.points >= prog.points_needed) {
                prog.points -= prog.points_needed;
                prog.level += 1;
                prog.total_levels = prog.tier_idx * lpt + prog.level + 1;
                advanced = true;
                if (prog.level >= lpt) {
                    const names = progTierNames(p);
                    const next = prog.tier_idx + 1;
                    if (next < names.length) {
                        prog.tier_idx = next;
                        prog.level = 0;
                        prog.points_needed = progCost(p, { tier_rank: next + 1, skill_level: prog.tier_idx * lpt });
                        notes.push({ type: 'tier', msg: `Advanced to ${names[next]}` });
                    } else {
                        prog.level = lpt;
                        prog.points = 0;
                        notes.push({ type: 'tier', msg: 'Maximum mastery achieved' });
                    }
                } else {
                    notes.push({ type: 'level', msg: `${progTierNames(p)[prog.tier_idx]} Lv${prog.level}` });
                }
            }
            if (advanced) {
                prog.points_needed = progCost(p, { tier_rank: prog.tier_idx + 1, skill_level: prog.tier_idx * lpt + prog.level });
            }
            break;
        }

        default: break; // 'none' — static, never advances
    }
    return notes;
}

/**
 * Sum of effective levels across a set of capabilities (drives score_formula's
 * `total_levels`). `profileOf(cap)` returns the capability's profile.
 * @param {Array<{prog: object}>} caps
 * @param {(cap: object) => object} profileOf
 * @returns {number}
 */
export function totalLevels(caps, profileOf) {
    let total = 0;
    for (const cap of caps) {
        const p = profileOf(cap);
        if (!p || !cap.prog) continue;
        if (p.type === 'points_tiers' || p.type === 'xp_levels') {
            total += cap.prog.tier_idx * progLpt(p) + cap.prog.level + 1;
        } else if (p.type === 'counter' || p.type === 'use_tracked' || p.type === 'milestone') {
            total += (cap.prog.level || 0);
        }
    }
    return total;
}

/** Recompute a capability's derived score after advancement. Mutates `prog`. */
export function recomputeScore(prog, p, totalLevelsForOwner) {
    if (progHasScore(p)) {
        prog.score = progScore(p, {
            total_levels: totalLevelsForOwner,
            skill_level: prog.tier_idx * progLpt(p) + prog.level,
        });
    }
}
