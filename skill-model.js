/**
 * skill-model.js — registry + dispatcher for pluggable skill-model strategies.
 *
 * A foundation's SKILL_MODEL declares a SET of skill *groups*, each governed by
 * one strategy: 'skilltree' (prereq-DAG constellation), 'capabilities'
 * (category + formula progression, Veridia-style), or 'leveling' (use/xp → level).
 * Multiple groups coexist in one campaign — e.g. level-on-use skills AND
 * non-leveling capabilities together.
 *
 * Each strategy module exports `strategy` conforming to this interface (all
 * methods optional except id):
 *   {
 *     id,                                   // model key
 *     validateConfig(config) -> string[],   // config errors ([] = ok)
 *     generatePrompt?(foundation, group) -> string,   // AI generation instruction
 *     validateGenerated?(data, group) -> {ok,errors},
 *     memoBlock(progression, group, foundation) -> string,      // [BLOCK]…[/BLOCK]
 *     syspromptFragment(group, foundation) -> string,           // narrator rules
 *     panelRender(progression, group, foundation, state) -> string(html),
 *     progressionOps?: {...},               // acquire/advance helpers
 *   }
 *
 * Strategies are lazy-imported so a plain D&D or single-tree campaign never
 * parses the others. Pure helpers (resolveGroups) are node-testable.
 *
 * Imports: none at top level (strategies loaded on demand).
 */

/** model id → lazy loader of its strategy module. */
const STRATEGY_LOADERS = {
    skilltree:    () => import('./skilltree-strategy.js'),
    capabilities: () => import('./capabilities.js'),
    leveling:     () => import('./leveling-strategy.js'),
};

const _cache = {};

/**
 * Resolve a loaded strategy for a model id (cached). Returns null if unknown or
 * the module fails to load (dispatch then skips that group gracefully).
 * @param {string} model
 * @returns {Promise<object|null>}
 */
export async function getStrategy(model) {
    if (!STRATEGY_LOADERS[model]) return null;
    if (!_cache[model]) {
        try {
            const mod = await STRATEGY_LOADERS[model]();
            _cache[model] = mod.strategy || mod.default || mod;
        } catch (e) {
            console.warn(`[skill-model] strategy "${model}" failed to load:`, e);
            return null;
        }
    }
    return _cache[model];
}

/**
 * The skill groups for a foundation. Absent/empty SKILL_MODEL → a single implicit
 * skilltree group, so existing Modern campaigns behave exactly as before.
 * Pure (node-testable).
 * @param {object} foundation
 * @returns {Array<{id:string,label?:string,model:string,config?:object}>}
 */
export function resolveGroups(foundation) {
    const groups = foundation?.SKILL_MODEL?.groups;
    if (Array.isArray(groups) && groups.length) return groups;
    return [{ id: 'skills', label: 'Skills', model: 'skilltree', config: {} }];
}

async function _collect(foundation, method, ...args) {
    const out = [];
    for (const g of resolveGroups(foundation)) {
        const s = await getStrategy(g.model);
        if (s && typeof s[method] === 'function') {
            try {
                const r = s[method](...args, g, foundation);
                if (r) out.push(r);
            } catch (e) {
                console.warn(`[skill-model] ${g.model}.${method} failed:`, e);
            }
        }
    }
    return out;
}

/** Combined memo blocks across all groups (each strategy renders its own block). */
export async function skillMemoBlocks(foundation, progression) {
    return (await _collect(foundation, 'memoBlock', progression)).join('\n\n');
}

/** Combined narrator sysprompt fragments across all groups. */
export async function skillSyspromptFragments(foundation) {
    // syspromptFragment(group, foundation) — no leading state arg
    const out = [];
    for (const g of resolveGroups(foundation)) {
        const s = await getStrategy(g.model);
        if (s && typeof s.syspromptFragment === 'function') {
            try { const r = s.syspromptFragment(g, foundation); if (r) out.push(r); }
            catch (e) { console.warn(`[skill-model] ${g.model}.syspromptFragment failed:`, e); }
        }
    }
    return out.join('\n\n');
}

/** Combined panel HTML across all groups (each strategy renders its own section). */
export async function skillPanelRender(foundation, progression, state) {
    return (await _collect(foundation, 'panelRender', progression, state)).join('\n');
}

/**
 * Instructions appended to the 2nd-pass EXTRACTOR's system prompt so it keeps each
 * group's memo block current. Empty when no group needs extractor guidance.
 */
export async function skillExtractorInstructions(foundation) {
    const out = [];
    for (const g of resolveGroups(foundation)) {
        const s = await getStrategy(g.model);
        if (s && typeof s.extractorHint === 'function') {
            try { const h = s.extractorHint(g, foundation); if (h) out.push(h); }
            catch (e) { console.warn(`[skill-model] ${g.model}.extractorHint failed:`, e); }
        }
    }
    return out.length ? `\n\n## SKILL / CAPABILITY BLOCKS TO MAINTAIN\n${out.map(h => `- ${h}`).join('\n')}` : '';
}

/** Whether a foundation uses a non-default skill model (any group that isn't the implicit tree). */
export function hasCustomSkillModel(foundation) {
    return Array.isArray(foundation?.SKILL_MODEL?.groups) && foundation.SKILL_MODEL.groups.length > 0;
}
