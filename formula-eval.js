/**
 * formula-eval.js — safe arithmetic evaluator for derived-stat formulas.
 *
 * Part of the generic System Definition mode: a foundation may declare custom
 * ATTRIBUTES (e.g. brawn, spirit) and DERIVED_STATS whose values are computed
 * from them by a formula string like "(brawn*4)+(spirit*2)+(level*10)". The
 * engine (never the model) evaluates these so derived stats stay exact.
 *
 * Security: this is a whitelist sandbox, re-implemented from the design used by
 * the GM Lore Parser's [SYSTEM_DEF] evaluator (algorithm only; no source copied).
 * Variable names are substituted with their numeric values, then the resulting
 * expression is accepted ONLY if it contains nothing but digits, whitespace and
 * the arithmetic operators + - * / ( ) and a decimal point. Anything else
 * (identifiers, property access, function calls, commas, brackets) fails the
 * whitelist and returns the fallback — so no arbitrary code can execute even if
 * a foundation author (or a model) writes a malicious formula.
 *
 * Pure module: no DOM, no ST context. node-testable.
 */

/** Only digits, whitespace, arithmetic operators, parens and decimal points. */
const FORMULA_SAFE_RE = /^[\d\s+\-*/().]+$/;

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Evaluate an arithmetic formula with the given variable values.
 *
 * @param {string} formula - e.g. "(brawn*4)+(spirit*2)"
 * @param {Record<string, number>} vars - variable name → numeric value
 * @param {number} [fallback=0] - returned on any parse/validation/eval failure
 * @returns {number}
 */
export function evalFormula(formula, vars, fallback = 0) {
    if (typeof formula !== 'string' || !formula.trim()) return fallback;
    try {
        let expr = formula;
        // (A) Substitute variable names, longest first so "spirit_max" is replaced
        //     before "spirit" and partial names never collide.
        const names = Object.keys(vars || {}).sort((a, b) => b.length - a.length);
        for (const n of names) {
            if (!n) continue;
            const num = Number(vars[n]);
            expr = expr.replace(
                new RegExp('\\b' + escapeRegex(n) + '\\b', 'g'),
                Number.isFinite(num) ? String(num) : '0',
            );
        }
        // (B) Whitelist: reject anything that is not pure arithmetic. Any leftover
        //     identifier (an unknown variable) fails here → fallback, never eval.
        if (!FORMULA_SAFE_RE.test(expr)) return fallback;
        // (C) Sandboxed evaluation in strict mode. The whitelist above guarantees
        //     the string is a numeric expression, so this cannot reach any scope.
        const out = Function('"use strict"; return (' + expr + ')')();
        return Number.isFinite(out) ? out : fallback;
    } catch (_) {
        return fallback;
    }
}

/**
 * Whether a formula is structurally safe & evaluable given a set of known
 * variable names (used by validation to reject bad DERIVED_STATS at commit
 * time). Substitutes every known name with 1 and checks the whitelist.
 *
 * @param {string} formula
 * @param {string[]} knownVars - attribute/variable ids that may appear
 * @returns {boolean}
 */
export function isFormulaSafe(formula, knownVars = []) {
    if (typeof formula !== 'string' || !formula.trim()) return false;
    const probe = {};
    for (const n of knownVars) probe[n] = 1;
    let expr = formula;
    const names = Object.keys(probe).sort((a, b) => b.length - a.length);
    for (const n of names) {
        if (!n) continue;
        expr = expr.replace(new RegExp('\\b' + escapeRegex(n) + '\\b', 'g'), '1');
    }
    return FORMULA_SAFE_RE.test(expr);
}

export { FORMULA_SAFE_RE };
