/**
 * system-library.js — a GLOBAL library of reusable System-Definition foundations.
 *
 * A committed foundation normally lives per-chat (chatStates[chatId].foundation),
 * so a custom game system can't be reused in another chat. The System Library
 * stores foundations globally in extension settings so any chat can apply one,
 * and supports JSON export/import for sharing/backup across installs.
 *
 * Mirrors the Scenario-Profiles CRUD pattern (state-manager saveProfile/…).
 * Pure CRUD + settings access here; foundation validation/commit are lazy-imported
 * so a plain D&D session never parses the generic layer.
 *
 * Imports: state-manager.js (+ lazy foundation.js)
 * Imported by: index.js (settings UI + panel selector)
 */

import { getSettings } from './state-manager.js';

/** @returns {Array<object>} the live library array (created if missing). */
export function listSystems() {
    const s = getSettings();
    if (!Array.isArray(s.systemLibrary)) s.systemLibrary = [];
    return s.systemLibrary;
}

/** Stable slug id from a name. */
function slugify(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'system';
}

export function getSystem(id) {
    return listSystems().find(e => e.id === id) || null;
}

/**
 * Save (or overwrite by name) a foundation into the global library.
 * @param {string} name
 * @param {object} foundation - a validated foundation object
 * @param {{description?: string, tags?: string[]}} [meta]
 * @returns {object} the stored entry
 */
export function saveSystemToLibrary(name, foundation, meta = {}) {
    const lib = listSystems();
    const id = slugify(name);
    const entry = {
        id,
        name: String(name || 'Untitled System'),
        description: meta.description || foundation?.SETTING?.synopsis || '',
        tags: Array.isArray(meta.tags) ? meta.tags : (foundation?.SETTING?.themes || []),
        foundation: JSON.parse(JSON.stringify(foundation)),
        createdAt: new Date().toISOString(),
    };
    const idx = lib.findIndex(e => e.id === id);
    if (idx >= 0) lib[idx] = entry; else lib.push(entry);
    const s = getSettings();
    s.activeSystemId = id;
    SillyTavern.getContext().saveSettingsDebounced();
    return entry;
}

export function deleteSystemFromLibrary(id) {
    const s = getSettings();
    const lib = listSystems();
    const idx = lib.findIndex(e => e.id === id);
    if (idx < 0) return false;
    lib.splice(idx, 1);
    if (s.activeSystemId === id) s.activeSystemId = '';
    SillyTavern.getContext().saveSettingsDebounced();
    return true;
}

/**
 * Apply a library system to a chat: validate, then commit via the normal
 * foundation commit path (locks the chat into Modern mode).
 * @param {string} id
 * @param {string} chatId
 * @returns {Promise<{ok: boolean, errors?: string[]}>}
 */
export async function applySystemFromLibrary(id, chatId) {
    if (!chatId) { toastr['warning']('Open a chat first.', 'System Library'); return { ok: false, errors: ['no chat'] }; }
    const entry = getSystem(id);
    if (!entry) { toastr['error']('System not found in the library.', 'System Library'); return { ok: false, errors: ['not found'] }; }

    const { validateFoundation, commitFoundationAndInit } = await import('./foundation.js');
    const v = validateFoundation(entry.foundation);
    if (!v.ok) {
        toastr['error'](`"${entry.name}" failed validation: ${v.errors.slice(0, 4).join('; ')}`, 'System Library');
        return { ok: false, errors: v.errors };
    }
    // Fresh copy so committing (which stamps version/date) doesn't mutate the library entry.
    await commitFoundationAndInit(chatId, JSON.parse(JSON.stringify(entry.foundation)));
    getSettings().activeSystemId = id;
    globalThis._rpgAutoApplySysprompt?.(true);
    toastr['success'](`Applied "${entry.name}" — chat is now in Modern mode.`, 'System Library');
    return { ok: true };
}

/**
 * Trigger a JSON file download of a library system.
 * @param {string} id
 */
export function exportSystem(id) {
    const entry = getSystem(id);
    if (!entry) { toastr['error']('System not found.', 'System Library'); return; }
    const payload = { kind: 'multihog-system', version: 1, name: entry.name, description: entry.description, tags: entry.tags, foundation: entry.foundation };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slugify(entry.name)}.system.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Import a system from JSON text (an exported file's contents). The foundation
 * is validated BEFORE it enters the library — never trust an imported file.
 * Accepts either a wrapped export ({foundation}) or a bare foundation object.
 * @param {string} jsonText
 * @returns {Promise<{ok: boolean, errors?: string[], entry?: object}>}
 */
export async function importSystem(jsonText) {
    let parsed;
    try { parsed = JSON.parse(jsonText); }
    catch (e) { toastr['error']('Import failed: not valid JSON.', 'System Library'); return { ok: false, errors: ['bad json'] }; }

    const foundation = parsed?.foundation && typeof parsed.foundation === 'object' ? parsed.foundation : parsed;
    const name = parsed?.name || foundation?.SETTING?.name || 'Imported System';

    const { validateFoundation } = await import('./foundation.js');
    const v = validateFoundation(foundation);
    if (!v.ok) {
        toastr['error'](`Import rejected: ${v.errors.slice(0, 4).join('; ')}`, 'System Library');
        return { ok: false, errors: v.errors };
    }
    const entry = saveSystemToLibrary(name, foundation, { description: parsed?.description, tags: parsed?.tags });
    toastr['success'](`Imported "${entry.name}" into the library.`, 'System Library');
    return { ok: true, entry };
}
