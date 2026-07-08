/**
 * token-telemetry.js — per-turn token / cost instrumentation.
 *
 * The dual-LLM design runs a SECOND model call (the state extractor) on top of
 * the narrator generation, so a turn costs more than a single completion. This
 * module accumulates the token cost of the calls the framework itself makes
 * (primarily the state-extraction pass) so the real API cost of the two-pass
 * architecture can be measured — the headline question for running on a paid
 * hosted model vs. a free local one.
 *
 * Debug-gated: callers only record when telemetry/debug is enabled. Estimates
 * are char-based (~4 chars/token) unless a backend usage figure is supplied;
 * each record notes which method was used so estimates aren't mistaken for exact
 * counts. Storage is in-memory and resets on reload — this is measurement
 * scaffolding, not shipped state.
 *
 * Pure module (no DOM, no ST). node-testable.
 */

const CHARS_PER_TOKEN = 4;

/** @type {Record<string, {passes: Array<object>, totals: {in:number,out:number,calls:number}}>} */
const store = {};

/** Rough char-based token estimate. */
export function estimateTokens(text) {
    if (typeof text !== 'string' || !text) return 0;
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function bucket(chatId) {
    const key = chatId || '_';
    if (!store[key]) store[key] = { passes: [], totals: { in: 0, out: 0, calls: 0 } };
    return store[key];
}

/**
 * Record one model call's token cost.
 * @param {object} p
 * @param {string} [p.chatId]
 * @param {'narrator'|'extractor'|'rng'|'agent'|string} [p.kind]
 * @param {string} [p.promptText] - assembled prompt (used when inTokens absent)
 * @param {string} [p.outputText] - model output (used when outTokens absent)
 * @param {number|null} [p.inTokens]  - backend-reported prompt tokens, if available
 * @param {number|null} [p.outTokens] - backend-reported completion tokens, if available
 * @returns {object} the recorded row
 */
export function recordPass({ chatId = '_', kind = 'extractor', promptText = '', outputText = '', inTokens = null, outTokens = null } = {}) {
    const inT = Number.isFinite(inTokens) ? inTokens : estimateTokens(promptText);
    const outT = Number.isFinite(outTokens) ? outTokens : estimateTokens(outputText);
    const method = (Number.isFinite(inTokens) || Number.isFinite(outTokens)) ? 'backend' : 'estimate';
    const b = bucket(chatId);
    const row = { kind, in: inT, out: outT, method };
    b.passes.push(row);
    b.totals.in += inT;
    b.totals.out += outT;
    b.totals.calls += 1;
    return row;
}

/** Accumulated telemetry for a chat. */
export function getTelemetry(chatId = '_') {
    return store[chatId || '_'] || { passes: [], totals: { in: 0, out: 0, calls: 0 } };
}

/** Clear telemetry (one chat, or all when chatId omitted). */
export function resetTelemetry(chatId) {
    if (chatId) delete store[chatId];
    else for (const k of Object.keys(store)) delete store[k];
}

/**
 * Project a paid-API cost from accumulated tokens at reference $/1M-token prices
 * (defaults ≈ a cheap flash-tier extractor model). Purely indicative.
 * @param {string} [chatId]
 * @param {number} [inPricePerM]  - USD per 1M input tokens
 * @param {number} [outPricePerM] - USD per 1M output tokens
 */
export function projectCost(chatId = '_', inPricePerM = 0.15, outPricePerM = 0.60) {
    const t = getTelemetry(chatId).totals;
    const cost = (t.in / 1e6) * inPricePerM + (t.out / 1e6) * outPricePerM;
    return {
        calls: t.calls,
        inTokens: t.in,
        outTokens: t.out,
        estCostUSD: +cost.toFixed(4),
        perCallUSD: t.calls ? +(cost / t.calls).toFixed(5) : 0,
    };
}

/** One-line human summary for a debug readout. */
export function summarize(chatId = '_') {
    const t = getTelemetry(chatId).totals;
    const c = projectCost(chatId);
    return `${t.calls} calls · in ${t.in} / out ${t.out} tok · ~$${c.estCostUSD} (~$${c.perCallUSD}/call)`;
}
