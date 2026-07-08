/**
 * progression-engine.js — generic System Definition mode (Modern RPG leveling)
 *
 * Ported from the Fatbody Framework (same author, MIT) as part of adding the
 * opt-in generic "System Definition" mode to Multihog. Deterministic leveling
 * math for the Modern (level 1–100) campaign mode.
 *
 * Pure module: no DOM, no SillyTavern context, no settings reads — everything
 * is parameterized so it runs unchanged under `node --test`.
 *
 * Design:
 *  - JS owns the XP thresholds (the narrator never sees a level table; it
 *    awards XP inline and the engine detects crossings from the memo).
 *  - Curve `modern_v1`: xpToNext(n) = round25(100 · n^1.4 · 1.08^floor((n−1)/10))
 *    Power 1.4 keeps early levels frequent; the per-decade 1.08 multiplier makes
 *    each tier-of-10 feel heavier without hard jumps. Values round to 25s and
 *    stay ≤7 digits so inline LLM arithmetic stays friendly.
 *  - Skill points: 2 at level 1, +2 per level-up, +4 bonus at each multiple of
 *    10 → 240 total at level 100.
 *  - Respec: free through level 10, then per-point
 *    round(10 · (L−10)^1.8 · costMultiplier).
 *
 * Imports: none (leaf module).
 * Imported by: the state pass (threshold detection), index.js (UI).
 */

export const MAX_LEVEL = 100;
export const XP_CURVE_ID = 'modern_v1';

/** Default progression rules — mirrored into foundation.PROGRESSION_RULES. */
export const DEFAULT_PROGRESSION_RULES = Object.freeze({
    maxLevel: MAX_LEVEL,
    xpCurveId: XP_CURVE_ID,
    skillPointsPerLevel: 2,
    milestoneEvery: 10,
    milestoneBonus: 4,
    respec: Object.freeze({ freeUntilLevel: 10, costMultiplier: 1.0 }),
});

function round25(n) {
    return Math.round(n / 25) * 25;
}

/**
 * XP required to advance FROM `level` to `level + 1`.
 * @param {number} level - 1..MAX_LEVEL-1
 * @returns {number}
 */
export function xpToNext(level) {
    if (!Number.isFinite(level) || level < 1 || level >= MAX_LEVEL) return 0;
    const decade = Math.floor((level - 1) / 10);
    return round25(100 * Math.pow(level, 1.4) * Math.pow(1.08, decade));
}

/**
 * Cumulative XP table: XP_TOTALS[L] = total XP at which level L begins.
 * XP_TOTALS[1] = 0; XP_TOTALS[MAX_LEVEL] is the final threshold.
 * Index 0 is unused (levels are 1-based).
 * @type {number[]}
 */
export const XP_TOTALS = (() => {
    const totals = [0, 0];
    for (let lvl = 1; lvl < MAX_LEVEL; lvl++) {
        totals.push(totals[lvl] + xpToNext(lvl));
    }
    return totals;
})();

/**
 * Total XP at which `level` begins.
 * @param {number} level - 1..MAX_LEVEL
 * @returns {number}
 */
export function xpTotalForLevel(level) {
    if (!Number.isFinite(level) || level < 1) return 0;
    return XP_TOTALS[Math.min(Math.floor(level), MAX_LEVEL)];
}

/**
 * The level a running XP total corresponds to (1..MAX_LEVEL).
 * @param {number} xp - cumulative XP (≥ 0)
 * @returns {number}
 */
export function levelForXp(xp) {
    if (!Number.isFinite(xp) || xp <= 0) return 1;
    // Linear scan is fine: 100 entries, called once per state pass.
    for (let lvl = MAX_LEVEL; lvl >= 1; lvl--) {
        if (xp >= XP_TOTALS[lvl]) return lvl;
    }
    return 1;
}

/**
 * XP progress within the current level, for `Level: X | XP: cur/next` rendering.
 * @param {number} xp - cumulative XP
 * @returns {{level: number, into: number, span: number}} `into`/`span` are
 *   XP earned inside the level and the level's width (span=0 at MAX_LEVEL).
 */
export function xpProgress(xp) {
    const level = levelForXp(xp);
    const base = XP_TOTALS[level];
    const span = level >= MAX_LEVEL ? 0 : xpToNext(level);
    return { level, into: Math.max(0, Math.floor(xp) - base), span };
}

/**
 * Skill points granted when REACHING `toLevel` via a level-up.
 * (The level-1 starting grant is totalSkillPointsAtLevel(1), not this.)
 * @param {number} toLevel
 * @param {{skillPointsPerLevel?: number, milestoneEvery?: number, milestoneBonus?: number}} [rules]
 * @returns {number}
 */
export function skillPointsForLevelUp(toLevel, rules = DEFAULT_PROGRESSION_RULES) {
    if (!Number.isFinite(toLevel) || toLevel < 2) return 0;
    const per = rules.skillPointsPerLevel ?? 2;
    const every = rules.milestoneEvery ?? 10;
    const bonus = rules.milestoneBonus ?? 4;
    return per + (every > 0 && toLevel % every === 0 ? bonus : 0);
}

/**
 * Total skill points earned by a character AT `level` (lifetime income,
 * ignoring spending/refunds). Includes the level-1 starting grant.
 * @param {number} level
 * @param {object} [rules]
 * @returns {number}
 */
export function totalSkillPointsAtLevel(level, rules = DEFAULT_PROGRESSION_RULES) {
    if (!Number.isFinite(level) || level < 1) return 0;
    const per = rules.skillPointsPerLevel ?? 2;
    let total = per; // level-1 starting grant
    for (let l = 2; l <= Math.min(level, rules.maxLevel ?? MAX_LEVEL); l++) {
        total += skillPointsForLevelUp(l, rules);
    }
    return total;
}

/**
 * Currency cost to refund ONE spent skill point at character level `level`.
 * Free through `freeUntilLevel` (default 10).
 * @param {number} level
 * @param {{freeUntilLevel?: number, costMultiplier?: number}} [respecRules]
 * @returns {number}
 */
export function respecCostPerPoint(level, respecRules = DEFAULT_PROGRESSION_RULES.respec) {
    const freeUntil = respecRules?.freeUntilLevel ?? 10;
    if (!Number.isFinite(level) || level <= freeUntil) return 0;
    const mult = respecRules?.costMultiplier ?? 1.0;
    return Math.round(10 * Math.pow(level - freeUntil, 1.8) * mult);
}

/**
 * Detects a level threshold crossing between two cumulative XP totals.
 * Used by the state pass after merging the memo: when the narrator's inline
 * XP awards push the total past a threshold, the engine (not the narrator)
 * declares the level-up and computes the point grant.
 *
 * @param {number} prevXp - cumulative XP before this turn
 * @param {number} newXp  - cumulative XP after this turn
 * @param {object} [rules]
 * @returns {null | {fromLevel: number, toLevel: number, points: number, milestone: boolean}}
 *   `points` covers EVERY level gained (multi-level jumps award each level's grant).
 */
export function detectLevelUp(prevXp, newXp, rules = DEFAULT_PROGRESSION_RULES) {
    // Generic System Definition: only the 'xp' progression mode auto-levels from
    // XP. 'milestone' and 'none' never fire a level-up here (absent → 'xp').
    if (rules && rules.progressionMode && rules.progressionMode !== 'xp') return null;
    const fromLevel = levelForXp(prevXp);
    const toLevel = levelForXp(newXp);
    if (toLevel <= fromLevel) return null;

    let points = 0;
    let milestone = false;
    const every = rules.milestoneEvery ?? 10;
    for (let l = fromLevel + 1; l <= toLevel; l++) {
        points += skillPointsForLevelUp(l, rules);
        if (every > 0 && l % every === 0) milestone = true;
    }
    return { fromLevel, toLevel, points, milestone };
}

/**
 * Builds the narrator-facing `[XP]` memo line for a cumulative total.
 * Same semantics as the D&D footer (`XP: running-total/next-threshold-total`)
 * so the state extractor keeps doing what it already does — accumulate the
 * inline awards — and `levelForXp` reads the first number directly.
 * @param {number} xp - cumulative XP
 * @returns {string} e.g. "Level: 12 | XP: 24,950/28,200"
 */
export function formatXpLine(xp) {
    const level = levelForXp(xp);
    const fmt = (n) => n.toLocaleString('en-US');
    return level >= MAX_LEVEL
        ? `Level: ${level} | XP: ${fmt(Math.floor(xp))} (MAX)`
        : `Level: ${level} | XP: ${fmt(Math.max(0, Math.floor(xp)))}/${fmt(XP_TOTALS[level + 1])}`;
}
