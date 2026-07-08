/**
 * skilltree-strategy.js — adapts the existing prereq-DAG skill tree (skill-forge
 * + skilltree constellation + skilltree-protocol) to the skill-model strategy
 * interface, so it is just one selectable model among several.
 *
 * The tree's acquisition UI stays the separate constellation tab; here we only
 * provide the interface hooks: its [SKILLS] memo block (reusing the protocol's
 * builder) and a compact in-panel summary. Its narrator rules already live in the
 * base modern sysprompt (<skills>/<xp_system>), so syspromptFragment is empty to
 * avoid double-injection.
 *
 * A group's tree state is progression.groups[groupId] when present, else the
 * top-level progression (the implicit single-tree campaign — backward-compatible).
 *
 * Imports: skilltree-protocol.js (buildSkillsMemoBlock — pure)
 * Imported by: skill-model.js (lazy)
 */

import { buildSkillsMemoBlock } from './skilltree-protocol.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

/** The tree-bearing progression object for a group (group-scoped or top-level). */
function progFor(progression, group) {
    if (group?.id && progression?.groups?.[group.id]?.tree) return progression.groups[group.id];
    return progression;
}

/** Taxonomy/tiers are validated by the foundation's SKILL_TAXONOMY; nothing extra here. */
function validateConfig() { return []; }

/** [SKILLS] block — acquired active skills with costs + canonical descriptors. */
function memoBlock(progression, group, foundation) {
    return buildSkillsMemoBlock(progFor(progression, group), foundation);
}

/** Covered by the base modern sysprompt; no extra fragment (avoids duplication). */
function syspromptFragment() { return ''; }

/** Compact in-panel summary with an Open button (the tree itself is a tab). */
function panelRender(progression, state, group) {
    const prog = progFor(progression, group);
    const nodeCount = Object.keys(prog?.tree?.nodes || {}).length;
    const acquired = Object.keys(prog?.acquired || {}).length;
    if (!nodeCount && !acquired) return '';
    const pts = (prog?.skillPoints?.earned || 0) - (prog?.skillPoints?.spent || 0);
    return `<div class="rt-skilltree-summary" data-group="${esc(group?.id || 'skills')}">`
        + `<span class="rt-cap-group-title">🌳 ${esc(group?.label || 'Skill Tree')}</span> `
        + `<span class="rt-cap-tag">${acquired} acquired · ${pts} pts</span> `
        + `<button class="rt-open-skilltree-btn menu_button interactable" data-group="${esc(group?.id || 'skills')}">Open</button>`
        + `</div>`;
}

export const strategy = { id: 'skilltree', validateConfig, memoBlock, syspromptFragment, panelRender };
export { validateConfig, memoBlock, syspromptFragment, panelRender };
