/**
 * foundation-wizard.js — the Foundation Builder for the generic System Definition
 * (Modern) mode. Ported from the Fatbody Framework (same author, MIT) and
 * extended so the architect can also emit the generic-expressiveness fields
 * (levelless/classless, custom attributes, derived stats, meters).
 *
 * A multi-turn Q&A wizard refines the user's ideas (plus the active character
 * card / persona / pasted documents) into a schema-validated foundation JSON,
 * previews it, and commits it — locking the chat into Modern mode.
 *
 * Conversation runs on the secondary (state-model) connection via sendAgentTurn(),
 * the same multi-turn primitive the Lorebook Agent uses. Generation is a bounded
 * loop: extract fenced JSON → validateFoundation() → feed the full error list
 * back (≤3 retries) → preview → commit.
 *
 * Imports: state-manager.js, llm-client.js, foundation.js
 * Imported by: system-def-commands.js / index.js (button wiring)
 */

import { getSettings } from './state-manager.js';
import { sendAgentTurn } from './llm-client.js';
import {
    FOUNDATION_SCHEMA_VERSION,
    validateFoundation,
    extractFoundationJson,
    renderFoundationProse,
    commitFoundationAndInit,
} from './foundation.js';

const MAX_GENERATION_RETRIES = 3;

/** Schema description the model writes against. Prose+example form — models
 *  follow examples far more reliably than abstract JSONSchema. */
const SCHEMA_SPEC = `
The foundation JSON object MUST have exactly this shape:

{
  "schemaVersion": ${FOUNDATION_SCHEMA_VERSION},
  "mode": "modern",
  "SETTING": { "name": "...", "synopsis": "2-4 sentences", "themes": ["..."], "toneNotes": "..." },
  "POWER_SYSTEM": {
    "name": "...", "description": "how powers work in this world",
    "resources": [ { "id": "mana", "name": "Mana", "description": "...", "regenRule": "..." } ],
    "diceProfile": {
      "primary": "d20", "subdice": ["d6","d8"], "queueLen": 12,
      "dcScale": [ {"label":"Trivial","value":5}, {"label":"Easy","value":10}, {"label":"Moderate","value":15}, {"label":"Hard","value":20}, {"label":"Near-impossible","value":30} ]
    }
  },
  "PROGRESSION_RULES": {
    "maxLevel": 100, "xpCurveId": "modern_v1",
    "skillPointsPerLevel": 2, "milestoneEvery": 10, "milestoneBonus": 4,
    "respec": { "freeUntilLevel": 10, "currencyName": "...", "costMultiplier": 1.0 }
  },
  "CLASS_ROSTER": [ /* exactly 3 to 6 classes */
    { "id": "slug", "name": "...", "fantasy": "one-line class fantasy", "role": "damage|control|support|tank|hybrid", "primaryResource": "<a resources id>", "treeThemes": ["...","..."] }
  ],
  "JOB_RULES": { "enabled": true, "maxJobs": 2, "unlockNarrative": "how jobs unlock in-fiction", "jobSeeds": [ { "id":"slug", "name":"...", "description":"...", "unlockHint":"..." } ] },
  "SKILL_TAXONOMY": {
    "damageTypes": ["..."], "namingConvention": "...",
    "rarityTiers": [ {"id":"common","name":"Common","color":"#aaaaaa"}, {"id":"rare","name":"Rare","color":"#5588ff"}, {"id":"epic","name":"Epic","color":"#aa55ff"} ],
    "tierCount": 10, "levelGatePerTier": 10
  },
  "LETHALITY": {
    "template": "standard",
    "downedWindow": 3,
    "injuryTable": [ "6-10 thematic permanent injuries with their mechanical debuff in parentheses" ],
    "deathRule": "what finally causes true death"
  }
}

Constraints: every CLASS_ROSTER primaryResource must match a POWER_SYSTEM.resources id; 3-6 classes; resources must not be empty; respec.currencyName is the campaign currency.

OPTIONAL GENERIC EXTENSIONS — include ONLY when the user's system calls for them; omit entirely for a standard leveled, class-based game:
- Levelless / classless: set "PROGRESSION_RULES.progressionMode" to "milestone" or "none" (default is "xp"), and/or "PROGRESSION_RULES.hasClasses": false. When progressionMode is not "xp", "maxLevel" may be null and CLASS_ROSTER may be omitted. Survival/sandbox worlds often want progressionMode "none" + hasClasses false.
- Custom attributes: "ATTRIBUTES": [ { "id":"brawn", "name":"Brawn", "abbr":"BRN", "description":"...", "range":[1,20] } ]
- Derived stats (the engine computes these from attributes + level, never the model): "DERIVED_STATS": [ { "id":"hp", "name":"Health", "formula":"(brawn*4)+(spirit*2)+(level*10)" } ]. A formula is PURE arithmetic ( + - * / and parentheses ) over declared attribute ids and the word "level" only — no function calls, no other names.
- Meters (standing / needs gauges): "METERS": [ { "id":"warmth", "name":"Warmth", "kind":"needs", "min":0, "max":100, "warnThreshold":30, "criticalThreshold":10 }, { "id":"standing", "name":"Hold Standing", "kind":"reputation", "min":-100, "max":100, "tiers":["Outcast","Wary","Kin"] } ]. kind is "reputation", "needs", or "generic".`;

export function buildWizardSystemPrompt(context) {
    return `You are the Foundation Architect for a custom RPG campaign engine. Your job is to interview the user about the world and progression system they want, refine their ideas into something mechanically coherent, and finally produce a single foundation JSON document.

PHASE 1 — INTERVIEW (now): Ask focused questions, 2-4 at a time, about whatever is still undefined: the setting's tone, how powers work, what resource fuels active skills, what the currency is, and — importantly — whether the world uses levels and classes at all, whether characters have custom attributes, and whether any standing or survival meters should be tracked. Build on the user's answers; propose concrete options when they are unsure. Keep replies under 200 words.

PHASE 2 — GENERATION (only when asked to generate): output the complete foundation as ONE fenced \`\`\`json block matching the schema below, with no commentary after it. Fill any gaps the interview left with choices consistent with everything discussed. Use the optional generic extensions when the discussed system is levelless, classless, attribute-driven, or meter-based.

${SCHEMA_SPEC}

${context ? `## SOURCE MATERIAL (character card / persona / documents provided by the user)\n${context}` : ''}`;
}

/** Gathers card description + persona as wizard source material. */
export function gatherSourceContext() {
    const ctx = SillyTavern.getContext();
    const parts = [];
    try {
        const char = ctx.characters?.[ctx.characterId];
        if (char?.description?.trim()) parts.push(`### Active character card (${char.name || 'unnamed'})\n${char.description.trim()}`);
    } catch (_) { /* no card */ }
    try {
        const persona = ctx.substituteParams ? ctx.substituteParams('{{persona}}').trim() : '';
        if (persona && persona !== '{{persona}}') parts.push(`### Player persona\n${persona}`);
    } catch (_) { /* no persona */ }
    return parts.join('\n\n');
}

/**
 * Headless generation loop: given a conversation (system + turns), ask the model
 * to emit the foundation JSON, validate it, and feed errors back up to
 * MAX_GENERATION_RETRIES. Reused by the modal and by tests. Mutates `messages`
 * (appends the generate instruction + model replies).
 *
 * @param {Array<{role:string,content:string}>} messages
 * @param {(msg:string)=>void} [onProgress]
 * @returns {Promise<{ok:boolean, foundation:object|null, errors:string[], attempts:number}>}
 */
export async function runFoundationGeneration(messages, onProgress = () => {}) {
    messages.push({ role: 'user', content: 'Generate the complete foundation JSON now, as a single fenced ```json block matching the schema exactly. No commentary after the block.' });
    let lastErrors = [];
    for (let attempt = 1; attempt <= MAX_GENERATION_RETRIES; attempt++) {
        onProgress(`Generating foundation (attempt ${attempt}/${MAX_GENERATION_RETRIES})…`);
        const { content } = await sendAgentTurn(getSettings(), messages, null, null);
        messages.push({ role: 'assistant', content });
        const parsed = extractFoundationJson(content);
        if (!parsed) {
            lastErrors = ['No parseable ```json block in the reply.'];
            messages.push({ role: 'user', content: 'Your reply contained no parseable ```json block. Output ONLY the foundation JSON in one fenced block.' });
            continue;
        }
        const { ok, errors } = validateFoundation(parsed);
        if (ok) return { ok: true, foundation: parsed, errors: [], attempts: attempt };
        lastErrors = errors;
        messages.push({ role: 'user', content: `The foundation failed validation. Fix EVERY issue and output the corrected complete JSON again:\n- ${errors.join('\n- ')}` });
    }
    return { ok: false, foundation: null, errors: lastErrors, attempts: MAX_GENERATION_RETRIES };
}

// ── Modal UI ───────────────────────────────────────────────────────────────────

let _wizardOpen = false;

/**
 * Opens the Foundation Builder modal for the current chat.
 */
export function openFoundationWizard() {
    if (_wizardOpen) return;
    const ctx = SillyTavern.getContext();
    const chatId = ctx.chatId || (typeof globalThis._rpgCurrentChatId === 'function' ? globalThis._rpgCurrentChatId() : null);
    if (!chatId) {
        toastr['warning']('Open a chat first — the foundation is stored per campaign.', 'Foundation Builder');
        return;
    }
    const s = getSettings();
    const existing = s.chatStates?.[chatId]?.foundation;

    _wizardOpen = true;
    const overlay = document.createElement('div');
    overlay.id = 'rt-foundation-wizard-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10500;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
        <div id="rt-fw-modal" style="width:min(720px,94vw);max-height:90vh;display:flex;flex-direction:column;background:var(--SmartThemeBlurTintColor, #1a1a2a);border:1px solid rgba(255,255,255,0.2);border-radius:10px;box-shadow:0 12px 48px rgba(0,0,0,0.6);">
            <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,0.1);">
                <div style="font-weight:bold;color:var(--SmartThemeQuoteColor,#3498db);">🏗️ Foundation Builder — Custom RPG (System Definition)</div>
                <button id="rt-fw-close" class="menu_button interactable" style="padding:2px 10px;">✕</button>
            </div>
            <div id="rt-fw-status" style="padding:4px 14px;font-size:0.8em;opacity:0.75;">${existing ? `Foundation v${existing.foundationVersion} exists — committing creates v${existing.foundationVersion + 1} (acquired skills are never retconned).` : 'Describe the RPG system you want; the architect will interview you, then generate the foundation.'}</div>
            <div id="rt-fw-log" style="flex:1;min-height:240px;overflow-y:auto;padding:10px 14px;display:flex;flex-direction:column;gap:8px;"></div>
            <div id="rt-fw-preview" style="display:none;flex:1;min-height:240px;overflow-y:auto;padding:10px 14px;white-space:pre-wrap;font-size:0.85em;"></div>
            <div style="padding:10px 14px;border-top:1px solid rgba(255,255,255,0.1);">
                <details style="margin-bottom:8px;">
                    <summary style="cursor:pointer;font-size:0.8em;opacity:0.7;">📎 Paste source documents (optional)</summary>
                    <textarea id="rt-fw-docs" class="text_pole" rows="4" style="width:100%;margin-top:6px;" placeholder="Worldbuilding notes, magic system docs, anything the architect should read…"></textarea>
                </details>
                <div style="display:flex;gap:8px;">
                    <textarea id="rt-fw-input" class="text_pole" rows="2" style="flex:1;" placeholder="Describe your world / answer the architect…"></textarea>
                    <div style="display:flex;flex-direction:column;gap:6px;">
                        <button id="rt-fw-send" class="menu_button interactable" style="white-space:nowrap;">Send 💬</button>
                        <button id="rt-fw-generate" class="menu_button interactable" style="white-space:nowrap;background:rgba(0,200,140,0.18);border-color:#00c88c;">Generate Foundation ⚒️</button>
                    </div>
                </div>
                <div id="rt-fw-commit-row" style="display:none;gap:8px;margin-top:8px;">
                    <button id="rt-fw-commit" class="menu_button interactable" style="flex:1;background:rgba(0,200,140,0.25);border-color:#00c88c;">✅ Commit foundation &amp; lock Modern mode</button>
                    <button id="rt-fw-back" class="menu_button interactable" style="flex:1;">↩ Keep refining</button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    const log = overlay.querySelector('#rt-fw-log');
    const input = /** @type {HTMLTextAreaElement} */ (overlay.querySelector('#rt-fw-input'));
    const docsEl = /** @type {HTMLTextAreaElement} */ (overlay.querySelector('#rt-fw-docs'));
    const statusEl = overlay.querySelector('#rt-fw-status');
    const previewEl = overlay.querySelector('#rt-fw-preview');
    const commitRow = overlay.querySelector('#rt-fw-commit-row');
    const sendBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('#rt-fw-send'));
    const genBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('#rt-fw-generate'));

    /** @type {Array<{role:string, content:string}>} */
    const messages = [];
    let docsInjected = false;
    let candidate = null;
    let busy = false;

    const close = () => { _wizardOpen = false; overlay.remove(); };
    overlay.querySelector('#rt-fw-close').addEventListener('click', close);

    const append = (role, text) => {
        const bubble = document.createElement('div');
        const isUser = role === 'user';
        bubble.style.cssText = `max-width:85%;padding:8px 10px;border-radius:8px;font-size:0.88em;line-height:1.45;white-space:pre-wrap;align-self:${isUser ? 'flex-end' : 'flex-start'};background:${isUser ? 'rgba(52,152,219,0.18)' : 'rgba(255,255,255,0.06)'};border:1px solid rgba(255,255,255,0.1);`;
        bubble.textContent = text;
        log.appendChild(bubble);
        log.scrollTop = log.scrollHeight;
    };

    const setBusy = (b, label = '') => {
        busy = b;
        sendBtn.disabled = b;
        genBtn.disabled = b;
        statusEl.textContent = b ? label : 'Ready.';
    };

    const ensureSystemPrompt = () => {
        if (messages.length === 0) {
            messages.push({ role: 'system', content: buildWizardSystemPrompt(gatherSourceContext()) });
        }
        const docs = docsEl.value.trim();
        if (docs && !docsInjected) {
            messages.push({ role: 'user', content: `Here are source documents to base the foundation on:\n\n${docs}` });
            docsInjected = true;
        }
    };

    const send = async () => {
        const text = input.value.trim();
        if (!text || busy) return;
        ensureSystemPrompt();
        input.value = '';
        append('user', text);
        messages.push({ role: 'user', content: text });
        setBusy(true, 'Architect is thinking…');
        try {
            const { content } = await sendAgentTurn(getSettings(), messages, null, null);
            messages.push({ role: 'assistant', content });
            append('assistant', content);
        } catch (e) {
            append('assistant', `⚠️ ${e.message || e}`);
        } finally {
            setBusy(false);
        }
    };

    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });

    genBtn.addEventListener('click', async () => {
        if (busy) return;
        ensureSystemPrompt();
        append('user', '⚒️ Generate the foundation JSON now.');
        setBusy(true, 'Generating foundation…');
        try {
            const { ok, foundation, errors } = await runFoundationGeneration(messages, (m) => { statusEl.textContent = m; });
            if (!ok) {
                append('assistant', `❌ Could not produce a valid foundation in ${MAX_GENERATION_RETRIES} attempts:\n- ${errors.slice(0, 8).join('\n- ')}`);
                setBusy(false);
                return;
            }
            candidate = foundation;
            previewEl.textContent = renderFoundationProse({ ...foundation, foundationVersion: (existing?.foundationVersion || 0) + 1 });
            log.style.display = 'none';
            previewEl.style.display = 'block';
            commitRow.style.display = 'flex';
            setBusy(false);
            statusEl.textContent = 'Review the foundation. Committing locks this chat to Modern mode.';
        } catch (e) {
            append('assistant', `⚠️ ${e.message || e}`);
            setBusy(false);
        }
    });

    overlay.querySelector('#rt-fw-back').addEventListener('click', () => {
        candidate = null;
        previewEl.style.display = 'none';
        commitRow.style.display = 'none';
        log.style.display = 'flex';
        statusEl.textContent = 'Keep refining, then generate again.';
    });

    overlay.querySelector('#rt-fw-commit').addEventListener('click', async () => {
        if (!candidate || busy) return;
        setBusy(true, 'Committing foundation…');
        try {
            await commitFoundationAndInit(chatId, candidate);
            globalThis._rpgAutoApplySysprompt?.(true);   // push the Modern prompt into the main prompt now
            close();
            globalThis._rpgRefreshRenderedView?.();
        } catch (e) {
            append('assistant', `❌ Commit failed: ${e.message || e}`);
            setBusy(false);
            statusEl.textContent = 'Commit failed — see the conversation log.';
        }
    });
}
