/**
 * foundation.js — generic System Definition mode (Modern RPG)
 *
 * Ported from the Fatbody Framework (same author, MIT) as part of adding the
 * opt-in generic "System Definition" mode to Multihog.
 *
 * The Foundation is the machine-readable contract a Modern campaign is built
 * on: setting, power system (resources + dice profile), progression rules,
 * the 3–6 starting classes, job rules, skill taxonomy, and lethality. The
 * Foundation Builder wizard produces it; the modern sysprompt, Skill Forge,
 * and skill tree all consume it.
 *
 * This module owns: schema validation (hand-rolled, dependency-free),
 * fenced-JSON extraction from wizard output, prose/placeholder rendering for
 * sysprompt substitution, and versioned persistence (canonical copy in
 * chatStates + an append-only version history in the `<prefix>_Foundation`
 * lorebook, entries kept disabled — storage/recall only, never constant-active).
 *
 * Validation/rendering are pure (node-testable); persistence touches ST.
 *
 * Multihog adaptation: book writes use the surrounding codebase's convention
 * `SillyTavern.getContext().saveWorldInfo(name, data)` rather than Fatbody's
 * `writeBookToDisk` helper (which Multihog does not have).
 *
 * Imports: state-manager.js
 * Imported by: foundation-wizard.js, sysprompt.js (placeholders), skill-forge.js
 */

import { getSettings, getEffectiveRouterCampaignPrefix } from './state-manager.js';
import { isFormulaSafe, evalFormula } from './formula-eval.js';

export const FOUNDATION_SCHEMA_VERSION = 1;

/** Progression modes for the generic System Definition layer.
 *  'xp' = leveled 1–100 (the default D&D-lite contract); 'milestone' = discrete
 *  story tiers; 'none' = levelless (survival/sandbox systems). */
export const PROGRESSION_MODES = ['xp', 'milestone', 'none'];

/** Lethality templates the wizard offers. 'standard' is fully specced for 3.0.0. */
export const LETHALITY_TEMPLATES = ['standard', 'hardcore', 'story', 'gamelike'];

// ── Validation ─────────────────────────────────────────────────────────────────

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isArr = Array.isArray;

/**
 * Validates a candidate foundation object against the v1 schema.
 * Returns every problem found (not just the first) so the wizard can feed the
 * full list back to the model in one retry.
 *
 * @param {any} f - candidate foundation
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateFoundation(f) {
    const errors = [];
    const err = (msg) => errors.push(msg);

    if (!f || typeof f !== 'object' || isArr(f)) {
        return { ok: false, errors: ['foundation must be a JSON object'] };
    }

    if (f.schemaVersion !== FOUNDATION_SCHEMA_VERSION) err(`schemaVersion must be ${FOUNDATION_SCHEMA_VERSION}`);
    if (f.mode !== 'modern') err("mode must be 'modern'");

    // SETTING
    if (!f.SETTING || typeof f.SETTING !== 'object') err('SETTING object is required');
    else {
        if (!isStr(f.SETTING.name)) err('SETTING.name must be a non-empty string');
        if (!isStr(f.SETTING.synopsis)) err('SETTING.synopsis must be a non-empty string');
        if (f.SETTING.themes !== undefined && !isArr(f.SETTING.themes)) err('SETTING.themes must be an array');
    }

    // POWER_SYSTEM
    const ps = f.POWER_SYSTEM;
    if (!ps || typeof ps !== 'object') err('POWER_SYSTEM object is required');
    else {
        if (!isStr(ps.name)) err('POWER_SYSTEM.name must be a non-empty string');
        if (!isStr(ps.description)) err('POWER_SYSTEM.description must be a non-empty string');
        if (!isArr(ps.resources) || ps.resources.length < 1) {
            err('POWER_SYSTEM.resources must be a non-empty array (actives need a resource economy)');
        } else {
            const ids = new Set();
            ps.resources.forEach((r, i) => {
                if (!isStr(r?.id)) err(`POWER_SYSTEM.resources[${i}].id must be a non-empty string`);
                else if (ids.has(r.id)) err(`POWER_SYSTEM.resources duplicate id "${r.id}"`);
                else ids.add(r.id);
                if (!isStr(r?.name)) err(`POWER_SYSTEM.resources[${i}].name must be a non-empty string`);
            });
        }
        const dp = ps.diceProfile;
        if (!dp || typeof dp !== 'object') err('POWER_SYSTEM.diceProfile object is required');
        else {
            if (!/^d\d{1,3}$/.test(dp.primary || '')) err("diceProfile.primary must look like 'd20'/'d100'");
            if (dp.subdice !== undefined && (!isArr(dp.subdice) || dp.subdice.some(d => !/^d\d{1,3}$/.test(d)))) {
                err("diceProfile.subdice must be an array of 'dN' strings");
            }
            if (dp.queueLen !== undefined && (!isNum(dp.queueLen) || dp.queueLen < 1 || dp.queueLen > 24)) {
                err('diceProfile.queueLen must be 1..24');
            }
            if (!isArr(dp.dcScale) || dp.dcScale.length < 3) {
                err('diceProfile.dcScale must be an array of at least 3 {label, value} steps');
            } else {
                dp.dcScale.forEach((s, i) => {
                    if (!isStr(s?.label) || !isNum(s?.value)) err(`diceProfile.dcScale[${i}] needs {label, value}`);
                });
            }
        }
    }

    // PROGRESSION_RULES
    const pr = f.PROGRESSION_RULES;
    if (!pr || typeof pr !== 'object') err('PROGRESSION_RULES object is required');
    else {
        // progressionMode (generic extension): absent → 'xp' (the leveled 1–100
        // contract, unchanged). 'milestone'/'none' relax the level requirements.
        const mode = pr.progressionMode ?? 'xp';
        if (!PROGRESSION_MODES.includes(mode)) {
            err(`PROGRESSION_RULES.progressionMode must be one of: ${PROGRESSION_MODES.join(', ')}`);
        }
        if (mode === 'xp') {
            if (pr.maxLevel !== 100) err("PROGRESSION_RULES.maxLevel must be 100 when progressionMode is 'xp'");
            if (!isStr(pr.xpCurveId)) err('PROGRESSION_RULES.xpCurveId must be set');
            if (!isNum(pr.skillPointsPerLevel) || pr.skillPointsPerLevel < 1) err('PROGRESSION_RULES.skillPointsPerLevel must be ≥ 1');
            if (!isNum(pr.milestoneEvery) || pr.milestoneEvery < 0) err('PROGRESSION_RULES.milestoneEvery must be ≥ 0');
            if (!isNum(pr.milestoneBonus) || pr.milestoneBonus < 0) err('PROGRESSION_RULES.milestoneBonus must be ≥ 0');
        } else {
            // Levelless / milestone: level fields are optional; validate only if present.
            if (pr.maxLevel !== undefined && pr.maxLevel !== null && (!isNum(pr.maxLevel) || pr.maxLevel < 1)) {
                err('PROGRESSION_RULES.maxLevel must be a positive number or null for non-xp modes');
            }
            if (pr.skillPointsPerLevel !== undefined && (!isNum(pr.skillPointsPerLevel) || pr.skillPointsPerLevel < 0)) {
                err('PROGRESSION_RULES.skillPointsPerLevel must be ≥ 0 when provided');
            }
        }
        // hasClasses (generic extension): absent → true (classed contract).
        if (pr.hasClasses !== undefined && typeof pr.hasClasses !== 'boolean') {
            err('PROGRESSION_RULES.hasClasses must be boolean');
        }
        const rs = pr.respec;
        if (!rs || typeof rs !== 'object') err('PROGRESSION_RULES.respec object is required');
        else {
            if (!isNum(rs.freeUntilLevel) || rs.freeUntilLevel < 0) err('respec.freeUntilLevel must be ≥ 0');
            if (!isStr(rs.currencyName)) err('respec.currencyName must be a non-empty string (the campaign currency)');
            if (rs.costMultiplier !== undefined && (!isNum(rs.costMultiplier) || rs.costMultiplier <= 0)) {
                err('respec.costMultiplier must be a positive number');
            }
        }
    }

    // CLASS_ROSTER — required 3–6 when classed; optional when hasClasses is false.
    const hasClasses = (f.PROGRESSION_RULES?.hasClasses ?? true) !== false;
    const cr = f.CLASS_ROSTER;
    if (!hasClasses) {
        if (cr !== undefined && !isArr(cr)) err('CLASS_ROSTER must be an array when provided');
    } else if (!isArr(cr) || cr.length < 3 || cr.length > 6) {
        err('CLASS_ROSTER must contain 3 to 6 classes (or set PROGRESSION_RULES.hasClasses = false)');
    } else {
        const ids = new Set();
        const resourceIds = new Set((f.POWER_SYSTEM?.resources || []).map(r => r?.id).filter(Boolean));
        cr.forEach((c, i) => {
            if (!isStr(c?.id)) err(`CLASS_ROSTER[${i}].id must be a non-empty string`);
            else if (ids.has(c.id)) err(`CLASS_ROSTER duplicate id "${c.id}"`);
            else ids.add(c.id);
            if (!isStr(c?.name)) err(`CLASS_ROSTER[${i}].name must be a non-empty string`);
            if (!isStr(c?.fantasy)) err(`CLASS_ROSTER[${i}].fantasy (one-line class fantasy) is required`);
            if (!isStr(c?.role)) err(`CLASS_ROSTER[${i}].role is required`);
            if (!isStr(c?.primaryResource)) err(`CLASS_ROSTER[${i}].primaryResource is required`);
            else if (resourceIds.size && !resourceIds.has(c.primaryResource)) {
                err(`CLASS_ROSTER[${i}].primaryResource "${c.primaryResource}" does not match any POWER_SYSTEM resource id`);
            }
            if (!isArr(c?.treeThemes) || c.treeThemes.length < 1) err(`CLASS_ROSTER[${i}].treeThemes must be a non-empty array`);
        });
    }

    // JOB_RULES
    const jr = f.JOB_RULES;
    if (!jr || typeof jr !== 'object') err('JOB_RULES object is required');
    else {
        if (typeof jr.enabled !== 'boolean') err('JOB_RULES.enabled must be boolean');
        if (jr.enabled) {
            if (jr.maxJobs !== undefined && (!isNum(jr.maxJobs) || jr.maxJobs < 1)) err('JOB_RULES.maxJobs must be ≥ 1');
            if (jr.jobSeeds !== undefined) {
                if (!isArr(jr.jobSeeds)) err('JOB_RULES.jobSeeds must be an array');
                else jr.jobSeeds.forEach((j, i) => {
                    if (!isStr(j?.id)) err(`JOB_RULES.jobSeeds[${i}].id must be a non-empty string`);
                    if (!isStr(j?.name)) err(`JOB_RULES.jobSeeds[${i}].name must be a non-empty string`);
                });
            }
        }
    }

    // SKILL_TAXONOMY
    const st = f.SKILL_TAXONOMY;
    if (!st || typeof st !== 'object') err('SKILL_TAXONOMY object is required');
    else {
        if (!isArr(st.damageTypes) || st.damageTypes.length < 1) err('SKILL_TAXONOMY.damageTypes must be a non-empty array');
        if (!isArr(st.rarityTiers) || st.rarityTiers.length < 2) {
            err('SKILL_TAXONOMY.rarityTiers must list at least 2 tiers');
        } else {
            st.rarityTiers.forEach((t, i) => {
                if (!isStr(t?.id) || !isStr(t?.name)) err(`SKILL_TAXONOMY.rarityTiers[${i}] needs {id, name}`);
            });
        }
        if (!isNum(st.tierCount) || st.tierCount < 1 || st.tierCount > 20) err('SKILL_TAXONOMY.tierCount must be 1..20');
        if (!isNum(st.levelGatePerTier) || st.levelGatePerTier < 1) err('SKILL_TAXONOMY.levelGatePerTier must be ≥ 1');
    }

    // LETHALITY
    const le = f.LETHALITY;
    if (!le || typeof le !== 'object') err('LETHALITY object is required');
    else {
        if (!LETHALITY_TEMPLATES.includes(le.template)) {
            err(`LETHALITY.template must be one of: ${LETHALITY_TEMPLATES.join(', ')}`);
        }
        if (le.template === 'standard') {
            if (le.downedWindow !== undefined && !isNum(le.downedWindow)) err('LETHALITY.downedWindow must be a number (combat rounds)');
            if (le.injuryTable !== undefined && (!isArr(le.injuryTable) || le.injuryTable.length < 1)) {
                err('LETHALITY.injuryTable must be a non-empty array when provided');
            }
        }
    }

    // ── Generic extensions (all optional; absent → today's leveled/classed system) ──

    // ATTRIBUTES: custom character attributes (brawn, spirit, …) that DERIVED_STATS
    // and the extractor can reference.
    const attrIds = new Set();
    if (f.ATTRIBUTES !== undefined) {
        if (!isArr(f.ATTRIBUTES)) err('ATTRIBUTES must be an array when provided');
        else {
            f.ATTRIBUTES.forEach((a, i) => {
                if (!isStr(a?.id)) err(`ATTRIBUTES[${i}].id must be a non-empty string`);
                else if (attrIds.has(a.id)) err(`ATTRIBUTES duplicate id "${a.id}"`);
                else attrIds.add(a.id);
                if (!isStr(a?.name)) err(`ATTRIBUTES[${i}].name must be a non-empty string`);
                if (a?.range !== undefined && (!isArr(a.range) || a.range.length !== 2 || !isNum(a.range[0]) || !isNum(a.range[1]))) {
                    err(`ATTRIBUTES[${i}].range must be [min, max] numbers when provided`);
                }
            });
        }
    }

    // DERIVED_STATS: engine-computed values (e.g. hp = (brawn*4)+(spirit*2)+(level*10)).
    // Formulas are validated against the whitelist sandbox so no unsafe expression
    // can ever be committed.
    if (f.DERIVED_STATS !== undefined) {
        if (!isArr(f.DERIVED_STATS)) err('DERIVED_STATS must be an array when provided');
        else {
            const knownVars = [...attrIds, 'level'];
            f.DERIVED_STATS.forEach((d, i) => {
                if (!isStr(d?.id)) err(`DERIVED_STATS[${i}].id must be a non-empty string`);
                if (!isStr(d?.name)) err(`DERIVED_STATS[${i}].name must be a non-empty string`);
                if (!isStr(d?.formula)) err(`DERIVED_STATS[${i}].formula must be a non-empty string`);
                else if (!isFormulaSafe(d.formula, knownVars)) {
                    err(`DERIVED_STATS[${i}].formula "${d.formula}" is not a safe arithmetic expression over the declared attributes (+ level)`);
                }
            });
        }
    }

    // METERS: reputation / needs / generic gauges (multi-axis standing, hunger, warmth…).
    if (f.METERS !== undefined) {
        if (!isArr(f.METERS)) err('METERS must be an array when provided');
        else {
            const meterIds = new Set();
            const KINDS = ['reputation', 'needs', 'generic'];
            f.METERS.forEach((m, i) => {
                if (!isStr(m?.id)) err(`METERS[${i}].id must be a non-empty string`);
                else if (meterIds.has(m.id)) err(`METERS duplicate id "${m.id}"`);
                else meterIds.add(m.id);
                if (!isStr(m?.name)) err(`METERS[${i}].name must be a non-empty string`);
                if (m?.kind !== undefined && !KINDS.includes(m.kind)) err(`METERS[${i}].kind must be one of: ${KINDS.join(', ')}`);
                if (!isNum(m?.min) || !isNum(m?.max)) err(`METERS[${i}] needs numeric min and max`);
                else if (m.min >= m.max) err(`METERS[${i}].min must be < max`);
            });
        }
    }

    return { ok: errors.length === 0, errors };
}

// ── Wizard output parsing ──────────────────────────────────────────────────────

/**
 * Extracts the LAST fenced JSON block (```json ... ``` or ``` ... ```) from
 * model output and parses it. Falls back to treating the whole text as JSON.
 * @param {string} text
 * @returns {object|null}
 */
export function extractFoundationJson(text) {
    if (typeof text !== 'string' || !text.trim()) return null;
    const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)];
    const candidates = fences.length ? [fences[fences.length - 1][1]] : [text];
    for (const c of candidates) {
        try {
            const parsed = JSON.parse(c.trim());
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch (_) { /* fall through */ }
    }
    return null;
}

// ── Prose rendering (sysprompt placeholders) ───────────────────────────────────

/**
 * Renders the placeholder map consumed by sysprompt_modern.txt — each value is
 * a prose fragment substituted for its `{{foundation_*}}` token.
 * @param {object} f - validated foundation
 * @returns {Record<string, string>}
 */
export function foundationPlaceholders(f) {
    const ps = f.POWER_SYSTEM || {};
    const dp = ps.diceProfile || {};
    const pr = f.PROGRESSION_RULES || {};
    const st = f.SKILL_TAXONOMY || {};
    const le = f.LETHALITY || {};

    const resources = (ps.resources || [])
        .map(r => `- ${r.name} (${r.id})${r.description ? `: ${r.description}` : ''}${r.regenRule ? ` Regen: ${r.regenRule}.` : ''}`)
        .join('\n');

    const dcScale = (dp.dcScale || [])
        .map(s => ` ${s.label}—${s.value}`)
        .join('\n');

    const classes = (f.CLASS_ROSTER || [])
        .map(c => `- ${c.name} (${c.role}): ${c.fantasy} Primary resource: ${c.primaryResource}.`)
        .join('\n');

    // Generic extensions (empty string when the foundation doesn't use them, so
    // the corresponding sysprompt tokens simply vanish).
    const attributes = (f.ATTRIBUTES || [])
        .map(a => `- ${a.name}${a.abbr ? ` (${a.abbr})` : ''}${a.description ? `: ${a.description}` : ''}`)
        .join('\n');
    const derived = (f.DERIVED_STATS || [])
        .map(d => `- ${d.name} = ${d.formula}`)
        .join('\n');
    const meters = (f.METERS || [])
        .map(m => `- ${m.name} [${m.kind || 'generic'}] (${m.min}..${m.max})${Array.isArray(m.tiers) && m.tiers.length ? ` — tiers: ${m.tiers.join(', ')}` : ''}`)
        .join('\n');

    return {
        foundation_setting: `${f.SETTING?.name || 'The World'} — ${f.SETTING?.synopsis || ''}${f.SETTING?.toneNotes ? `\nTone: ${f.SETTING.toneNotes}` : ''}`.trim(),
        foundation_attributes: attributes ? `CUSTOM ATTRIBUTES — track these on the character; they drive derived stats:\n${attributes}` : '',
        foundation_derived_guidance: derived ? `DERIVED STATS — computed by the engine from attributes and level; never recompute or override them:\n${derived}` : '',
        foundation_meters: meters ? `TRACKED METERS — standing/needs gauges; update as the fiction warrants and keep them in range:\n${meters}` : '',
        foundation_power_system: `${ps.name || 'Power System'}: ${ps.description || ''}\n\nRESOURCES (actives spend these; track them like spell slots):\n${resources}`.trim(),
        foundation_dice: `Primary check die: ${dp.primary || 'd100'}. Threshold scale:\n${dcScale}`.trim(),
        foundation_classes: classes,
        foundation_currency: pr.respec?.currencyName || 'credits',
        foundation_award_guidance: pr.xpAwardGuidance
            || 'Award XP as a fraction of the XP shown remaining to next level in the [XP] line: minor accomplishments ≈ 0.5–2%, significant feats ≈ 5–15%, completing a major arc ≈ 25–60%. Characters must DESERVE XP.',
        foundation_lethality_template: le.template || 'standard',
        foundation_downed_window: String(le.downedWindow ?? 3),
        foundation_naming: st.namingConvention || 'evocative but concise skill names that fit the setting',
    };
}

/**
 * Renders the whole foundation as a single prose document (lorebook copy,
 * wizard preview).
 * @param {object} f
 * @returns {string}
 */
export function renderFoundationProse(f) {
    const p = foundationPlaceholders(f);
    const jobs = f.JOB_RULES?.enabled
        ? `Jobs are enabled (max ${f.JOB_RULES.maxJobs ?? 2}): professions layered on top of the class, grafting new branches onto the skill tree when unlocked.${(f.JOB_RULES.jobSeeds || []).length ? ' Seeds: ' + f.JOB_RULES.jobSeeds.map(j => j.name).join(', ') + '.' : ''}`
        : 'Jobs are disabled for this campaign.';
    return [
        `# FOUNDATION v${f.foundationVersion ?? 1} — ${f.SETTING?.name || 'Campaign'}`,
        `## Setting\n${p.foundation_setting}`,
        `## Power System\n${p.foundation_power_system}`,
        `## Checks\n${p.foundation_dice}`,
        `## Classes\n${p.foundation_classes}`,
        `## Jobs\n${jobs}`,
        `## Progression\nMax level ${f.PROGRESSION_RULES?.maxLevel ?? 100}. ${p.foundation_award_guidance}\nCurrency: ${p.foundation_currency}.`,
        `## Lethality\nTemplate: ${p.foundation_lethality_template}.`,
    ].join('\n\n');
}

// ── Derived stats (engine-computed) ─────────────────────────────────────────────

/**
 * Recompute a foundation's DERIVED_STATS from attribute (and level) values.
 * The engine owns these values — the model never computes them — so a derived
 * stat like `hp = (brawn*4)+(spirit*2)+(level*10)` stays exact. Unknown
 * variables in a formula resolve to 0 via the whitelist evaluator.
 *
 * @param {object} foundation
 * @param {Record<string, number>} attrValues - e.g. { brawn: 5, spirit: 3, level: 2 }
 * @returns {Record<string, number>} { [derivedId]: value }
 */
export function computeDerivedStats(foundation, attrValues) {
    const out = {};
    for (const d of (foundation?.DERIVED_STATS || [])) {
        if (!d?.id || !isStr(d?.formula)) continue;
        out[d.id] = evalFormula(d.formula, attrValues || {}, 0);
    }
    return out;
}

// ── Persistence ────────────────────────────────────────────────────────────────

/**
 * Canonical foundation accessor for a chat (latest version).
 * @param {string} chatId
 * @returns {object|null}
 */
export function getFoundation(chatId) {
    const s = getSettings();
    return s.chatStates?.[chatId]?.foundation || null;
}

/**
 * Commits a validated foundation: stamps the version, stores the canonical
 * copy in chatStates, locks the campaign mode to 'modern', and appends a
 * version entry to the `<prefix>_Foundation` lorebook (disabled — recall/
 * backup storage, never constant-active; VectFox may vectorize it).
 *
 * @param {string} chatId
 * @param {object} foundation - MUST already pass validateFoundation
 * @param {string} prefix - campaign prefix for the lorebook name
 * @returns {Promise<object>} the stamped foundation
 */
export async function commitFoundation(chatId, foundation, prefix) {
    const s = getSettings();
    if (!s.chatStates) s.chatStates = {};
    if (!s.chatStates[chatId]) s.chatStates[chatId] = {};

    const prevVersion = s.chatStates[chatId].foundation?.foundationVersion || 0;
    const stamped = {
        ...foundation,
        foundationVersion: prevVersion + 1,
        committedAt: new Date().toISOString(),
    };

    s.chatStates[chatId].foundation = stamped;
    s.chatStates[chatId].campaignMode = 'modern';   // locked at creation
    SillyTavern.getContext().saveSettingsDebounced();

    // Append-only version history in the foundation lorebook.
    const bookName = `${prefix}_Foundation`;
    let bookData = null;
    try {
        bookData = await SillyTavern.getContext().loadWorldInfo(bookName);
    } catch (_) { /* new book */ }
    if (!bookData?.entries) {
        bookData = { entries: {}, name: bookName, scan_depth: 4, token_budget: 400, recursive: false, extensions: {} };
    }

    const uids = Object.keys(bookData.entries).map(Number).filter(n => !isNaN(n));
    const nextUid = uids.length > 0 ? Math.max(...uids) + 1 : 0;
    bookData.entries[nextUid] = {
        uid: nextUid,
        key: [`foundation`, stamped.SETTING?.name || 'campaign'].filter(Boolean),
        keysecondary: [],
        comment: `Foundation v${stamped.foundationVersion}`,
        content: `${renderFoundationProse(stamped)}\n\n\`\`\`json\n${JSON.stringify(stamped, null, 2)}\n\`\`\``,
        constant: false, selective: false, selectiveLogic: 0, addMemo: true,
        order: 100, position: 0, disable: true,
        probability: 100, useProbability: false,
        depth: 4, group: '', groupOverride: false, groupWeight: 100,
    };

    // Multihog convention: write world info directly (no writeBookToDisk helper).
    await SillyTavern.getContext().saveWorldInfo(bookName, bookData);

    // Track the book in the campaign stack so it auto-activates on chat switch.
    const books = new Set(s.chatStates[chatId].campaignBooks || []);
    books.add(bookName);
    s.chatStates[chatId].campaignBooks = [...books];
    SillyTavern.getContext().saveSettingsDebounced();

    return stamped;
}

/**
 * Builds the [CHARACTER] module prompt for a Modern campaign from its
 * foundation: the state model must keep Level and every resource pool line
 * alive across passes (the stock prompt is D&D-shaped and would drop them).
 * Pure (node-testable).
 *
 * @param {object} foundation
 * @returns {string}
 */
/** Marker sentence present in every generated modern character prompt —
 *  isModernCharacterPrompt() keys on it to tell engine-written prompts apart
 *  from user-customized ones. */
const MODERN_CHARACTER_PROMPT_SENTINEL = 'This is NOT a D&D character';

export function buildModernCharacterPrompt(foundation) {
    const resources = foundation?.POWER_SYSTEM?.resources || [];
    const resourceLines = resources.map(r => `${r.name}: current/max`).join('\n');
    const resourceNames = resources.map(r => r.name).join(', ');
    return `Main character's core stats. Use this format:
[CHARACTER]
{{user}} (Class): current/max HP
Level: N
${resourceLines}
Attr: STR X, DEX X, CON X, INT X, WIS X, CHA X
Traits: Trait1 (effect), Trait2 (effect)
Status: Effect (duration Xh Xm)
[/CHARACTER]

Keep the Level line and EVERY resource pool line (${resourceNames}) on every update, even when unchanged. ${MODERN_CHARACTER_PROMPT_SENTINEL}: no spell slots, no AC, no saves, no hit dice.

Upon LEVEL UP, incorporate attribute changes.`;
}

/**
 * Whether a [CHARACTER] module prompt is an engine-generated Modern prompt
 * (as opposed to the stock D&D prompt or a user customization). Used on chat
 * switch to keep per-campaign prompt swaps from leaking into other chats.
 * @param {unknown} prompt
 * @returns {boolean}
 */
export function isModernCharacterPrompt(prompt) {
    return typeof prompt === 'string' && prompt.includes(MODERN_CHARACTER_PROMPT_SENTINEL);
}

/**
 * Validates a foundation against a LIVE campaign's progression state before a
 * re-commit (v2+). Acquired skills are never retconned, so the new contract
 * must keep every id the progression already references: the locked class and
 * every resource that forged skills cost. Display names may change freely —
 * only ids are load-bearing. Pure (node-testable).
 *
 * @param {object} foundation - candidate (already schema-valid) foundation
 * @param {object|null|undefined} progression - chatStates[chatId].progression
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateFoundationCompatibility(foundation, progression) {
    const errors = [];
    if (!progression) return { ok: true, errors };

    if (progression.classId) {
        const classIds = new Set((foundation?.CLASS_ROSTER || []).map(c => c.id));
        if (!classIds.has(progression.classId)) {
            errors.push(`CLASS_ROSTER no longer contains the locked class id "${progression.classId}" — keep that id in the roster (its display name may change).`);
        }
    }

    const resourceIds = new Set((foundation?.POWER_SYSTEM?.resources || []).map(r => r.id));
    const missing = new Set();
    for (const node of Object.values(progression.tree?.nodes || {})) {
        const rid = node?.resourceCost?.resourceId;
        if (rid && !resourceIds.has(rid)) missing.add(rid);
    }
    for (const rid of missing) {
        errors.push(`POWER_SYSTEM.resources no longer contains "${rid}", but forged skills cost it — keep that resource id (its display name may change).`);
    }

    return { ok: errors.length === 0, errors };
}

/**
 * Commits a validated foundation and performs first-commit campaign setup:
 * seeds the progression state, enables the [SKILLS] memo module, and clears
 * the onboarding flow flag. Shared by the Foundation Builder's Commit button
 * and the HUD's Modern "Default" path. Class selection is NOT handled here —
 * callers re-render and the HUD onboarding derives the class-selection step.
 *
 * @param {string} chatId
 * @param {object} foundationDoc - MUST already pass validateFoundation
 * @returns {Promise<object>} the stamped foundation
 */
export async function commitFoundationAndInit(chatId, foundationDoc) {
    // Re-commit guard: a v2+ foundation must stay compatible with what the
    // campaign already locked in (class id, resource ids on forged skills).
    // Blocking here keeps the wizard's "Keep refining" loop as the fix path.
    const liveProgression = getSettings().chatStates?.[chatId]?.progression;
    const compat = validateFoundationCompatibility(foundationDoc, liveProgression);
    if (!compat.ok) {
        throw new Error(`Incompatible with the live campaign — refine and regenerate:\n- ${compat.errors.join('\n- ')}`);
    }

    const prefix = getEffectiveRouterCampaignPrefix(chatId);
    const stamped = await commitFoundation(chatId, foundationDoc, prefix || 'Campaign');

    // Initialize progression state on first commit only — never reset a live campaign.
    const st = getSettings().chatStates[chatId];
    if (!st.progression) {
        st.progression = {
            mode: 'modern',
            foundationVersion: stamped.foundationVersion,
            level: 1,
            xp: 0,
            skillPoints: { earned: stamped.PROGRESSION_RULES?.skillPointsPerLevel ?? 2, spent: 0 },
            respecSpentTotal: 0,
            classId: null,
            jobIds: [],
            tree: { nodes: {}, layout: {}, tiersGenerated: {} },
            acquired: {},
            pendingLevelUp: null,
        };
    } else {
        st.progression.foundationVersion = stamped.foundationVersion;
    }
    // The onboarding flow flag has served its purpose — the committed
    // foundation now drives step derivation.
    delete st.onboarding;
    // Enable the [SKILLS] memo module for this campaign (chat-linked saves
    // snapshot `modules` per chat, so D&D chats keep it off).
    const live = getSettings();
    if (!live.modules) live.modules = {};
    live.modules.skills = true;
    // Swap the [CHARACTER] module prompt to a foundation-aware one so the
    // state model maintains Level and resource pools (`stockPrompts` is also
    // snapshotted per chat — D&D chats keep the stock D&D prompt).
    if (!live.stockPrompts) live.stockPrompts = {};
    live.stockPrompts.character = buildModernCharacterPrompt(stamped);
    SillyTavern.getContext().saveSettingsDebounced();

    toastr['success'](`Foundation v${stamped.foundationVersion} committed — campaign locked to Modern mode.`, 'Foundation Builder');
    return stamped;
}
