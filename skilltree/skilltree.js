/**
 * skilltree/skilltree.js — the Skill Tree tab (generic System Definition mode).
 * Ported from the Fatbody Framework (same author, MIT).
 *
 * A same-origin static page: pure DOM + SVG, no SillyTavern imports. State
 * arrives over a chat-scoped BroadcastChannel from skilltree-bridge.js; the
 * shared protocol module provides the SAME validation/layout code the opener
 * uses, so staging feedback here always matches the opener's verdict.
 *
 * The tab never mutates progression — it stages allocations/refunds locally
 * and sends an `apply` request; the opener is the authority.
 */

import {
    PROTOCOL_VERSION,
    channelName,
    validateApply,
    computeLayout,
} from '../skilltree-protocol.js';

const chatId = decodeURIComponent(location.hash.slice(1) || '');
const $ = (id) => document.getElementById(id);

// ── State ──────────────────────────────────────────────────────────────────────
let progression = null;
let foundation = null;
let staged = { allocate: new Set(), refund: new Set() };
let connected = false;
let missedPongs = 0;
let layout = {};
let searchTerm = '';

const channel = chatId ? new BroadcastChannel(channelName(chatId)) : null;

// ── Channel ────────────────────────────────────────────────────────────────────
function send(msg) {
    channel?.postMessage({ v: PROTOCOL_VERSION, ...msg });
}

if (channel) {
    channel.onmessage = (ev) => {
        const msg = ev.data;
        if (!msg || msg.v !== PROTOCOL_VERSION) return;
        switch (msg.type) {
            case 'state':
                progression = msg.progression;
                foundation = msg.foundation;
                if (msg.theme) applyTheme(msg.theme);
                setConnected(true);
                // Drop staged entries that no longer make sense after the new state.
                for (const id of [...staged.allocate]) {
                    if (progression.acquired?.[id] || !progression.tree?.nodes?.[id]) staged.allocate.delete(id);
                }
                for (const id of [...staged.refund]) {
                    if (!progression.acquired?.[id]) staged.refund.delete(id);
                }
                renderAll();
                break;
            case 'applyResult':
                if (msg.ok) {
                    staged = { allocate: new Set(), refund: new Set() };
                } else if (msg.errors?.length) {
                    alert(`Could not apply:\n- ${msg.errors.join('\n- ')}`);
                }
                // state broadcast follows; renderAll happens there
                break;
            case 'pong':
                missedPongs = 0;
                setConnected(true);
                break;
        }
    };
    send({ type: 'hello' });
    setInterval(() => {
        missedPongs++;
        if (missedPongs >= 2) setConnected(false);
        send({ type: 'ping' });
    }, 5000);
} else {
    setConnected(false);
}

function setConnected(ok) {
    if (ok === connected) { updateConnChip(); return; }
    connected = ok;
    updateConnChip();
    $('st-banner').hidden = ok;
    renderHeader();
}
function updateConnChip() {
    const chip = $('st-conn');
    chip.textContent = connected ? '● live' : '● offline';
    chip.classList.toggle('st-conn-ok', connected);
    chip.classList.toggle('st-conn-bad', !connected);
}

function applyTheme(vars) {
    for (const [k, v] of Object.entries(vars)) {
        document.documentElement.style.setProperty(k, v);
    }
}

// ── Staging helpers ────────────────────────────────────────────────────────────
function stagedRequest() {
    return { allocate: [...staged.allocate], refund: [...staged.refund] };
}
function currentValidation() {
    if (!progression) return null;
    return validateApply(progression, { PROGRESSION_RULES: foundation?.PROGRESSION_RULES }, stagedRequest());
}

/** Would allocating `id` (on top of current staging) be legal? */
function canStageAllocate(id) {
    if (!progression || !connected) return false;
    const v = validateApply(progression, { PROGRESSION_RULES: foundation?.PROGRESSION_RULES }, {
        allocate: [...staged.allocate, id],
        refund: [...staged.refund],
    });
    return v.ok;
}
function canStageRefund(id) {
    if (!progression || !connected) return false;
    const v = validateApply(progression, { PROGRESSION_RULES: foundation?.PROGRESSION_RULES }, {
        allocate: [...staged.allocate],
        refund: [...staged.refund, id],
    });
    return v.ok;
}

function toggleNode(id) {
    if (!progression || !connected) return;
    const acquired = !!progression.acquired?.[id];

    if (staged.allocate.has(id)) { staged.allocate.delete(id); renderAll(); return; }
    if (staged.refund.has(id)) { staged.refund.delete(id); renderAll(); return; }

    if (acquired) {
        if (canStageRefund(id)) staged.refund.add(id);
        else flashNode(id);
    } else {
        if (canStageAllocate(id)) staged.allocate.add(id);
        else flashNode(id);
    }
    renderAll();
}

function flashNode(id) {
    const el = document.querySelector(`[data-node-id="${CSS.escape(id)}"] circle.st-core`);
    if (!el) return;
    el.style.stroke = '#e74c3c';
    setTimeout(() => { el.style.stroke = ''; }, 350);
}

// ── Rendering ──────────────────────────────────────────────────────────────────
const SVG_NS = 'http://www.w3.org/2000/svg';
const NODE_R = 22;

function rarityColor(node) {
    const tier = (foundation?.SKILL_TAXONOMY?.rarityTiers || []).find(r => r.id === node.rarity);
    return tier?.color || null;
}

function nodeState(id) {
    const n = progression.tree.nodes[id];
    if (staged.refund.has(id)) return 'st-refund';
    if (staged.allocate.has(id)) return 'st-staged';
    if (progression.acquired?.[id]) return 'st-acquired';
    if ((progression.level || 1) < (n?.levelGate || 0)) return 'st-locked';
    // prereq-reachable with current acquired+staged set?
    const owned = new Set([...Object.keys(progression.acquired || {}), ...staged.allocate]);
    for (const id2 of staged.refund) owned.delete(id2);
    const reachable = (n.prereqs || []).every(p => !(p in progression.tree.nodes) || owned.has(p));
    return reachable ? 'st-affordable' : 'st-locked';
}

function renderAll() {
    renderHeader();
    renderTree();
}

function renderHeader() {
    $('st-campaign-name').textContent = foundation?.SETTING?.name
        ? `${foundation.SETTING.name} — Skill Tree` : 'Skill Tree';

    const v = currentValidation();
    const earned = progression?.skillPoints?.earned || 0;
    const spent = progression?.skillPoints?.spent || 0;
    const delta = v ? (v.pointsSpent - v.pointsRefunded) : 0;
    $('st-points').textContent = `${Math.max(0, earned - spent - delta)} pts left`;

    const stagedCount = staged.allocate.size + staged.refund.size;
    const stagedChip = $('st-staged');
    stagedChip.hidden = stagedCount === 0;
    stagedChip.textContent = `staged: +${staged.allocate.size} / −${staged.refund.size}`;

    const respecChip = $('st-respec');
    const currency = foundation?.PROGRESSION_RULES?.respec?.currencyName || 'currency';
    respecChip.hidden = !v || v.currencyCost <= 0;
    if (v && v.currencyCost > 0) respecChip.textContent = `respec: ${v.currencyCost.toLocaleString()} ${currency}`;

    const okToApply = connected && stagedCount > 0 && v?.ok;
    $('st-apply').disabled = !okToApply;
    $('st-cancel').disabled = stagedCount === 0;
    $('st-reset').disabled = !connected || !Object.keys(progression?.acquired || {}).length;
}

function renderTree() {
    const nodes = progression?.tree?.nodes || {};
    const ids = Object.keys(nodes);
    $('st-empty').hidden = ids.length > 0;

    layout = computeLayout(nodes);
    const edges = $('st-edges');
    const nodesG = $('st-nodes');
    edges.replaceChildren();
    nodesG.replaceChildren();

    const term = searchTerm.trim().toLowerCase();
    const matches = term
        ? new Set(ids.filter(id => (nodes[id].name + ' ' + nodes[id].effect + ' ' + nodes[id].descriptor).toLowerCase().includes(term)))
        : null;

    // Edges
    for (const id of ids) {
        for (const p of (nodes[id].prereqs || [])) {
            if (!(p in nodes)) continue;
            const a = layout[p], b = layout[id];
            if (!a || !b) continue;
            const line = document.createElementNS(SVG_NS, 'line');
            line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
            line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
            const owned = progression.acquired?.[p] && progression.acquired?.[id];
            line.setAttribute('class', `st-edge${owned ? ' st-edge-owned' : ''}${matches && !(matches.has(p) || matches.has(id)) ? ' st-edge-dim' : ''}`);
            edges.appendChild(line);
        }
    }

    // Nodes
    for (const id of ids) {
        const n = nodes[id];
        const pos = layout[id];
        if (!pos) continue;
        const g = document.createElementNS(SVG_NS, 'g');
        let cls = `st-node ${nodeState(id)}`;
        if (matches) cls += matches.has(id) ? ' st-match' : ' st-dim';
        g.setAttribute('class', cls);
        g.setAttribute('transform', `translate(${pos.x},${pos.y})`);
        g.dataset.nodeId = id;

        const core = document.createElementNS(SVG_NS, 'circle');
        core.setAttribute('class', 'st-core');
        core.setAttribute('r', NODE_R);
        const rc = rarityColor(n);
        if (rc) core.style.filter = `drop-shadow(0 0 6px ${rc})`;
        g.appendChild(core);

        const glyph = document.createElementNS(SVG_NS, 'text');
        glyph.setAttribute('class', 'st-glyph');
        glyph.textContent = n.type === 'passive' ? '◆' : '✦';
        if (rc) glyph.style.fill = rc;
        g.appendChild(glyph);

        const label = document.createElementNS(SVG_NS, 'text');
        label.setAttribute('class', 'st-label');
        label.setAttribute('y', NODE_R + 14);
        label.textContent = n.name;
        g.appendChild(label);

        g.addEventListener('click', (e) => { e.stopPropagation(); toggleNode(id); });
        g.addEventListener('mouseenter', (e) => showTooltip(n, e));
        g.addEventListener('mousemove', (e) => positionTooltip(e));
        g.addEventListener('mouseleave', hideTooltip);
        nodesG.appendChild(g);
    }

    fitViewIfFirst(ids);
}

// ── Tooltip ────────────────────────────────────────────────────────────────────
function showTooltip(n, e) {
    const tt = $('st-tooltip');
    const resources = new Map((foundation?.POWER_SYSTEM?.resources || []).map(r => [r.id, r.name]));
    const costBits = [];
    if (n.resourceCost) costBits.push(`${n.resourceCost.amount} ${resources.get(n.resourceCost.resourceId) || n.resourceCost.resourceId}`);
    if (n.cooldown) costBits.push(`CD ${n.cooldown.turns} turns`);
    const rc = rarityColor(n);
    tt.innerHTML = `
        <div class="tt-name" ${rc ? `style="color:${escapeHtml(rc)}"` : ''}>${escapeHtml(n.name)}</div>
        <div class="tt-meta">Tier ${n.tier} ${n.jobId ? `· ${escapeHtml(n.jobId)} (job)` : ''} · ${n.type} · ${n.cost} pt${n.cost > 1 ? 's' : ''}${costBits.length ? ' · ' + escapeHtml(costBits.join(', ')) : ''}</div>
        <div class="tt-effect">${escapeHtml(n.effect)}</div>
        <div class="tt-desc">${escapeHtml(n.descriptor)}</div>
        ${(progression.level || 1) < (n.levelGate || 0) ? `<div class="tt-req">Requires level ${n.levelGate}</div>` : ''}`;
    tt.hidden = false;
    positionTooltip(e);
}
function positionTooltip(e) {
    const tt = $('st-tooltip');
    if (tt.hidden) return;
    const pad = 14;
    let x = e.clientX + pad, y = e.clientY + pad;
    const r = tt.getBoundingClientRect();
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
    if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
    tt.style.left = `${x}px`;
    tt.style.top = `${y}px`;
}
function hideTooltip() { $('st-tooltip').hidden = true; }

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Pan / zoom ─────────────────────────────────────────────────────────────────
const svg = $('st-canvas');
let view = { x: -600, y: -400, w: 1200, h: 800 };
let didFit = false;

function applyView() {
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
}
function fitViewIfFirst(ids) {
    if (didFit || !ids.length) { applyView(); return; }
    didFit = true;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of ids) {
        const p = layout[id];
        if (!p) continue;
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const pad = 140;
    view = { x: minX - pad, y: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
    // keep aspect ratio sane
    const aspect = innerWidth / Math.max(1, innerHeight - 50);
    if (view.w / view.h < aspect) {
        const w = view.h * aspect;
        view.x -= (w - view.w) / 2; view.w = w;
    }
    applyView();
}

let panning = null;
svg.addEventListener('pointerdown', (e) => {
    panning = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y };
    svg.classList.add('st-panning');
    svg.setPointerCapture(e.pointerId);
});
svg.addEventListener('pointermove', (e) => {
    if (!panning) return;
    const scale = view.w / svg.clientWidth;
    view.x = panning.vx - (e.clientX - panning.px) * scale;
    view.y = panning.vy - (e.clientY - panning.py) * scale;
    applyView();
});
svg.addEventListener('pointerup', (e) => {
    panning = null;
    svg.classList.remove('st-panning');
    svg.releasePointerCapture(e.pointerId);
});
svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const rect = svg.getBoundingClientRect();
    const mx = view.x + ((e.clientX - rect.left) / rect.width) * view.w;
    const my = view.y + ((e.clientY - rect.top) / rect.height) * view.h;
    view.w = Math.min(8000, Math.max(300, view.w * factor));
    view.h = Math.min(8000, Math.max(200, view.h * factor));
    view.x = mx - ((e.clientX - rect.left) / rect.width) * view.w;
    view.y = my - ((e.clientY - rect.top) / rect.height) * view.h;
    applyView();
}, { passive: false });

// ── Header actions ─────────────────────────────────────────────────────────────
$('st-apply').addEventListener('click', () => {
    if (!connected) return;
    send({ type: 'apply', ...stagedRequest() });
});
$('st-cancel').addEventListener('click', () => {
    staged = { allocate: new Set(), refund: new Set() };
    renderAll();
});
$('st-reset').addEventListener('click', () => {
    if (!connected || !progression) return;
    const v = validateApply(progression, { PROGRESSION_RULES: foundation?.PROGRESSION_RULES }, {
        refund: Object.keys(progression.acquired || {}),
    });
    const currency = foundation?.PROGRESSION_RULES?.respec?.currencyName || 'currency';
    const costNote = v.currencyCost > 0 ? `\n\nThis will cost ${v.currencyCost.toLocaleString()} ${currency}.` : '';
    if (confirm(`Refund ALL acquired skills?${costNote}`)) {
        staged = { allocate: new Set(), refund: new Set() };
        send({ type: 'resetAll' });
    }
});
$('st-search').addEventListener('input', (e) => {
    searchTerm = e.target.value || '';
    renderTree();
});

applyView();
