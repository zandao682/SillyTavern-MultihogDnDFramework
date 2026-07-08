// sysprompt.js — assembly of the narrator system prompt from the raw template.
//
// Extracted verbatim from index.js (Phase 1 modularization) so that mode-aware
// sysprompt resolution can be added here without further bloating index.js.
// Behavior is unchanged: buildSysprompt() performs tag-based module stripping,
// quest/RNG/relationship swaps, module-instruction injection, and cleanup.

import { getSettings, getNpcRelationshipMax, buildRelationshipTrackingSysprompt, getCampaignMode } from './state-manager.js';
import { buildModulesInstructionText } from './memo-processor.js';
import { QUESTS_NARRATOR, RT_PROMPTS } from './constants.js';

export function buildSysprompt(rawText) {
    if (!rawText) return "";
    const s = getSettings();
    const mods = s.syspromptModules || {};

    // 1. Tag-based module stripping and Quest mode swap
    let content = rawText
        .replace(/<(\w[\w_-]*)>([\s\S]*?)<\/\1>/g, (match, tag) => {
            if (mods[tag] === false) return '';
            if (tag === 'relationship_tracking') {
                if (!s.npcRelationshipBars) return '';
                return `<relationship_tracking>\n${buildRelationshipTrackingSysprompt(getNpcRelationshipMax(s))}\n</relationship_tracking>`;
            }
            if (tag === 'rng_system' && !s.rngEnabled) {
                const contentOnly = match.replace(/<\/?rng_system>/g, '');
                let fallbackText = "To resolve actions, simulate a fair d20 roll internally and maintain all ROLL FORMAT rules.\n\n";
                let matchedFormat = false;
                if (contentOnly.includes('[ROLL FORMAT]')) {
                    const rollFormatMatch = contentOnly.match(/(\[ROLL FORMAT\][\s\S]*?)(?=\n\n\[FALLBACK\]|$)/i);
                    if (rollFormatMatch) {
                        fallbackText += rollFormatMatch[1].trim();
                        matchedFormat = true;
                    }
                } else {
                    const l4 = contentOnly.match(/4\.\s*(Output[\s\S]*?)(?=\n\n\[FALLBACK\]|$)/i);
                    if (l4) {
                        fallbackText += l4[1].replace(/5\.\s*/g, '').trim();
                        matchedFormat = true;
                    }
                }
                if (!matchedFormat) {
                    fallbackText += "Output rolls as `[ROLL: 1d20+Mod vs DC X (Result: Y) -> Outcome]` or `[ROLL: 1d20+Mod (Result: Y) -> Outcome]`.";
                }
                return `<rng_system>\n${fallbackText.trim()}\n</rng_system>`;
            }
            // Inject correct instructions for quests based on legacy mode
            if (tag === 'quests') {
                let instruction = QUESTS_NARRATOR;
                // Strip Mood guidance if Frustration is off
                if (!mods.questsFrustration) {
                    instruction = instruction.replace(/Use the MOOD field.*?\./g, '');
                }
                // Strip Difficulty guidance if Difficulty is off
                if (!mods.questsDifficulty) {
                    instruction = instruction.replace(/the difficulty \(Very Easy to Very Hard\), /g, '');
                    instruction = instruction.replace(/Assign an appropriate difficulty \(Very Easy to Very Hard\) based on the narrative stakes\. /g, '');
                }
                return `<quests>\n${instruction.trim()}\n</quests>`;
            }
            if (tag === 'end_of_output_footer') {
                let footerContent = match;
                if (s.use24hTime) {
                    footerContent = footerContent.replace(/\[HH:MM AM\/PM\]/g, '[HH:MM] (24-hour clock, NO AM/PM)');
                }
                if (s.useDdMmYyFormat) {
                    footerContent = footerContent.replace(/Day\s+\[X\]/g, '[DD/MM/YYYY]');
                }
                return footerContent;
            }
            return match;
        });

    // 2. Inject current module instructions
    const modulesText = buildModulesInstructionText(s);
    content = content.replace("{{modulesText}}", modulesText);

    // 3. Handle Quests Hardcore rules stripping (Narrator guidance)
    if (!mods.questsDeadlines) {
        // Strip deadline assignment rule and auto_fail guidance
        content = content.replace(/- Assign an in-world Deadline.*\n/g, '');
        content = content.replace(/- Set auto_fail to true for quests.*\n/g, '');
        content = content.replace(/- If a duration is given.* Day N.*\n/g, '');
    }
    if (!mods.questsFrustration) {
        // Strip frustration coefficient and mood rules
        content = content.replace(/- Set a frustration_coefficient.*\n/g, '');
        content = content.replace(/ {2}· 0\.4 = Very patient.*\n/g, '');
        content = content.replace(/ {2}· 1\.0 = Normal.*\n/g, '');
        content = content.replace(/ {2}· 3\.0 = Volatile.*\n/g, '');
        content = content.replace(/- The NPC Mood evolves continuously.*\n/g, '');
        // Also strip the 'past deadline' override rule — only applies when Frustration is active
        content = content.replace(/- If a quest is time-sensitive and the deadline passes.*\n/g, '');
    }

    if (!s.rngEnabled) {
        content = content
            .replace(/.*RollTheDice.*\n?/gi, '')
            .replace(/.*RNG_QUEUE v6.0_PROPER.*\n?/gi, '');
    }

    return content
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

// ── Generic "System Definition" (Modern) mode gate ──────────────────────────────
//
// The D&D path above is unchanged. resolveModernSysprompt() returns a fully
// assembled Modern narrator prompt ONLY when the current chat has opted into
// Modern mode AND has a committed foundation; otherwise it returns null and the
// caller keeps its existing D&D result. The generic layer (foundation.js) is
// loaded via dynamic import() so D&D sessions never parse it.

/**
 * Fetch a prompt template from this extension's folder, falling back to the
 * bundled RT_PROMPTS copy. Path is derived from import.meta.url so no FOLDER_NAME
 * dependency is needed.
 * @param {string} fileName
 * @returns {Promise<string>}
 */
async function fetchPromptFile(fileName) {
    try {
        const response = await fetch(new URL(fileName, import.meta.url));
        if (response.ok) {
            const text = await response.text();
            if (text) return text;
        }
    } catch (_) { /* fall through to bundled fallback */ }
    return RT_PROMPTS[fileName] || '';
}

/** Strip any `<tag>…</tag>` block whose module is disabled in syspromptModules. */
function stripDisabledTags(text, mods) {
    return text.replace(/<(\w[\w_-]*)>([\s\S]*?)<\/\1>/g, (m, tag) => (mods[tag] === false ? '' : m));
}

/**
 * Assemble the Modern narrator sysprompt for the current chat, or null when the
 * chat is not a Modern campaign. Substitutes the foundation's `{{foundation_*}}`
 * placeholders into sysprompt_modern.txt and honors per-chat module toggles.
 * Never throws — any failure returns null so the D&D prompt stands.
 * @returns {Promise<string|null>}
 */
export async function resolveModernSysprompt() {
    try {
        const chatId = SillyTavern.getContext().chatId || '';
        if (!chatId || getCampaignMode(chatId) !== 'modern') return null;

        const { getFoundation, foundationPlaceholders } = await import('./foundation.js');
        const foundation = getFoundation(chatId);
        if (!foundation) return null;

        const raw = await fetchPromptFile('sysprompt_modern.txt');
        if (!raw) return null;

        let content = raw;
        const ph = foundationPlaceholders(foundation);
        for (const [k, v] of Object.entries(ph)) {
            content = content.split(`{{${k}}}`).join(v);
        }
        content = stripDisabledTags(content, getSettings().syspromptModules || {});

        // Append skill-model narrator fragments (capabilities/leveling rules per group).
        try {
            const { skillSyspromptFragments } = await import('./skill-model.js');
            const frags = await skillSyspromptFragments(foundation);
            if (frags) content += '\n\n' + frags;
        } catch (_) { /* skill fragments are optional */ }

        return content.replace(/\n{3,}/g, '\n\n').trim();
    } catch (e) {
        console.error('[Multihog Framework] Modern sysprompt resolve failed; keeping D&D:', e);
        return null;
    }
}
