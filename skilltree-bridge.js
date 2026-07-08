/**
 * skilltree-bridge.js — generic System Definition mode (Skill Tree opener side).
 * Ported from the Fatbody Framework (same author, MIT).
 *
 * Opener-side half of the Skill Tree tab. ALL mutation authority lives here
 * (the tab is a view + staging surface): apply requests are re-validated via
 * the shared protocol, progression is mutated, the [SKILLS] memo block is
 * refreshed, chat state is saved, and the new state is broadcast back.
 *
 * The tab is opened as a same-origin static page (skilltree/skilltree.html)
 * and communicates over a chat-scoped BroadcastChannel. If the opener dies,
 * the tab degrades to read-only (heartbeat).
 *
 * Multihog adaptation: passive-application uses globalThis._rpgSendDirectPrompt
 * (Multihog keeps sendDirectPrompt in index.js, not a state-pass.js module).
 *
 * Imports: state-manager.js, skilltree-protocol.js, env.js
 * Imported by: index.js
 */

import { FOLDER_NAME } from './env.js';
import { getSettings, getCampaignMode, saveChatState } from './state-manager.js';
import {
    PROTOCOL_VERSION,
    channelName,
    validateApply,
    applyValidatedRequest,
    buildSkillsMemoBlock,
} from './skilltree-protocol.js';

/** CSS custom properties snapshotted into the tab so it matches the user's theme. */
const THEME_VARS = [
    '--rt-accent', '--rt-accent-bg', '--rt-accent-dim',
    '--SmartThemeBodyColor', '--SmartThemeBlurTintColor', '--SmartThemeBorderColor',
    '--SmartThemeQuoteColor', '--SmartThemeEmColor',
];

let _channel = null;
let _channelChatId = null;

function snapshotTheme() {
    const out = {};
    try {
        const cs = getComputedStyle(document.documentElement);
        for (const v of THEME_VARS) {
            const val = cs.getPropertyValue(v).trim();
            if (val) out[v] = val;
        }
    } catch (_) { /* defaults in the tab CSS cover it */ }
    return out;
}

/** Foundation subset the tab needs (never the whole document). */
function foundationSubsetFor(st) {
    const f = st?.foundation || {};
    return {
        SETTING: { name: f.SETTING?.name },
        POWER_SYSTEM: { resources: f.POWER_SYSTEM?.resources || [] },
        PROGRESSION_RULES: f.PROGRESSION_RULES || {},
        CLASS_ROSTER: f.CLASS_ROSTER || [],
        JOB_RULES: { enabled: !!f.JOB_RULES?.enabled, jobSeeds: f.JOB_RULES?.jobSeeds || [] },
        SKILL_TAXONOMY: f.SKILL_TAXONOMY || {},
    };
}

function postState(chatId) {
    if (!_channel) return;
    const st = getSettings().chatStates?.[chatId];
    if (!st?.progression) return;
    _channel.postMessage({
        v: PROTOCOL_VERSION,
        type: 'state',
        progression: JSON.parse(JSON.stringify(st.progression)),
        foundation: foundationSubsetFor(st),
        theme: snapshotTheme(),
        readonly: false,
    });
}

/** Whether `chatId` is the chat currently active in the SillyTavern UI.
 *  The tab can outlive a chat switch, so bridge mutations must never assume
 *  the live globals (settings.currentMemo etc.) belong to the tab's chat. */
function isActiveChat(chatId) {
    const ctx = SillyTavern.getContext();
    const active = ctx.chatId || (typeof globalThis._rpgCurrentChatId === 'function' ? globalThis._rpgCurrentChatId() : null);
    return !!chatId && chatId === active;
}

/**
 * Refreshes the [SKILLS] block inside the tab-chat's memo from acquired
 * actives, and kicks a state-extractor pass for newly acquired PASSIVES so
 * their effects get baked into [CHARACTER] with (P: Name) restoration anchors.
 * @param {string} chatId
 * @param {string[]} allocatedIds
 */
async function syncMemoAfterApply(chatId, allocatedIds) {
    const settings = getSettings();
    const st = settings.chatStates?.[chatId];
    if (!st?.progression) return;
    const active = isActiveChat(chatId);

    // 1. [SKILLS] block (actives) — deterministic, in-place.
    const block = buildSkillsMemoBlock(st.progression, st.foundation);
    const memo = (active ? settings.currentMemo : st.currentMemo) || '';
    let updated = memo;
    if (/\[SKILLS\][\s\S]*?\[\/SKILLS\]/i.test(memo)) {
        updated = block
            ? memo.replace(/\[SKILLS\][\s\S]*?\[\/SKILLS\]/i, block)
            : memo.replace(/\s*\[SKILLS\][\s\S]*?\[\/SKILLS\]/i, '').trim();
    } else if (block) {
        updated = memo ? `${memo.trim()}\n\n${block}` : block;
    }
    if (active) settings.currentMemo = updated;
    else st.currentMemo = updated;

    // 2. Passives → one setup-time extractor pass (menu action, not a turn).
    const nodes = st.progression.tree?.nodes || {};
    const passives = allocatedIds.map(id => nodes[id]).filter(n => n?.type === 'passive');
    if (passives.length) {
        if (!active) {
            toastr['warning']('Passive skills applied while another chat is open — switch back and use the tracker 💬 to bake their effects into [CHARACTER].', 'Skill Tree');
        } else {
            const lines = passives.map(n => `- ${n.name}: ${n.effect} (narrative: ${n.descriptor})`).join('\n');
            try {
                const sendDirectPrompt = globalThis._rpgSendDirectPrompt;
                if (typeof sendDirectPrompt !== 'function') throw new Error('sendDirectPrompt unavailable');
                await sendDirectPrompt(
                    `{{user}} acquired the following PASSIVE skills from the skill tree. Apply each one's mechanical effect directly to the [CHARACTER] block stats (attack lines, Defense, attributes, resource maximums, etc) and annotate each modified value with a restoration anchor in the form (P: Skill Name) so the bonus can be reversed on respec. Do NOT add these to [SKILLS] or [ABILITIES] — they are stat modifications only.\n\n${lines}`,
                );
            } catch (e) {
                console.warn('[RPG Tracker] Passive application pass failed (apply manually via 💬):', e);
                toastr['warning']('Passive skill effects could not be auto-applied — use the tracker 💬 to apply them.', 'Skill Tree');
            }
        }
    }

    // UI refresh (rendered tracker view)
    if (active && typeof globalThis._rpgRefreshRenderedView === 'function') globalThis._rpgRefreshRenderedView();
}

function installChannel(chatId) {
    if (_channel && _channelChatId === chatId) return;
    if (_channel) { try { _channel.close(); } catch (_) {} }
    _channelChatId = chatId;
    _channel = new BroadcastChannel(channelName(chatId));

    _channel.onmessage = async (ev) => {
        const msg = ev.data;
        if (!msg || msg.v !== PROTOCOL_VERSION) return;
        const settings = getSettings();
        const st = settings.chatStates?.[chatId];

        switch (msg.type) {
            case 'hello':
            case 'requestState':
                postState(chatId);
                break;

            case 'ping':
                _channel.postMessage({ v: PROTOCOL_VERSION, type: 'pong' });
                break;

            case 'apply': {
                if (!st?.progression) return;
                const request = { allocate: msg.allocate || [], refund: msg.refund || [] };
                const validation = validateApply(st.progression, st.foundation, request);
                if (validation.ok) {
                    applyValidatedRequest(st.progression, request, validation);
                    if (isActiveChat(chatId)) saveChatState(chatId);
                    else SillyTavern.getContext().saveSettingsDebounced();
                    await syncMemoAfterApply(chatId, request.allocate);
                    if (validation.currencyCost > 0) {
                        const currency = st.foundation?.PROGRESSION_RULES?.respec?.currencyName || 'currency';
                        toastr['info'](`Respec: -${validation.currencyCost.toLocaleString()} ${currency} (deduct from inventory).`, 'Skill Tree');
                    }
                }
                _channel.postMessage({
                    v: PROTOCOL_VERSION, type: 'applyResult',
                    ok: validation.ok, errors: validation.errors,
                    currencyCost: validation.currencyCost,
                });
                postState(chatId);
                break;
            }

            case 'resetAll': {
                if (!st?.progression) return;
                const acquiredIds = Object.keys(st.progression.acquired || {});
                const validation = validateApply(st.progression, st.foundation, { refund: acquiredIds });
                if (validation.ok) {
                    applyValidatedRequest(st.progression, { allocate: [], refund: acquiredIds }, validation);
                    if (isActiveChat(chatId)) saveChatState(chatId);
                    else SillyTavern.getContext().saveSettingsDebounced();
                    await syncMemoAfterApply(chatId, []);
                }
                _channel.postMessage({
                    v: PROTOCOL_VERSION, type: 'applyResult',
                    ok: validation.ok, errors: validation.errors,
                    currencyCost: validation.currencyCost,
                });
                postState(chatId);
                break;
            }
        }
    };
}

/**
 * Opens (or focuses) the Skill Tree tab for the active chat and installs the
 * opener-side bridge. Modern campaigns only.
 */
export function openSkillTreeTab() {
    const ctx = SillyTavern.getContext();
    const chatId = ctx.chatId || (typeof globalThis._rpgCurrentChatId === 'function' ? globalThis._rpgCurrentChatId() : null);
    if (!chatId) {
        toastr['warning']('Open a chat first.', 'Skill Tree');
        return;
    }
    if (getCampaignMode(chatId) !== 'modern') {
        toastr['info']('The Skill Tree is a Modern-mode feature. Build a foundation first (/sysdef build or /sysdef default).', 'Skill Tree');
        return;
    }
    const st = getSettings().chatStates?.[chatId];
    if (!st?.progression) {
        toastr['warning']('No progression state — commit a foundation first.', 'Skill Tree');
        return;
    }

    installChannel(chatId);
    const url = `/scripts/extensions/third-party/${FOLDER_NAME}/skilltree/skilltree.html#${encodeURIComponent(chatId)}`;
    const win = window.open(url, 'multihog-skilltree');
    if (!win) {
        toastr['error']('Popup blocked — allow popups for SillyTavern to open the Skill Tree tab.', 'Skill Tree');
        return;
    }
    // First state push happens on the tab's 'hello', but also push proactively
    // in case the tab was already open and just got focused.
    setTimeout(() => postState(chatId), 400);
}

/**
 * Pushes fresh state to an already-open tab after an out-of-band progression
 * change (class forge, background tier pre-generation). No-op when no tab
 * channel is installed or it belongs to another chat.
 * @param {string} chatId
 */
export function pushSkillTreeState(chatId) {
    if (_channel && _channelChatId === chatId) postState(chatId);
}

/** Re-anchors the bridge when the active chat changes while a tab is open. */
export function onSkillTreeChatChanged(newChatId) {
    if (_channel && newChatId && _channelChatId !== newChatId && getCampaignMode(newChatId) === 'modern') {
        installChannel(newChatId);
        postState(newChatId);
    }
}
