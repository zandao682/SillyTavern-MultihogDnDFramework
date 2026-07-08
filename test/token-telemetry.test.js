import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, recordPass, getTelemetry, resetTelemetry, projectCost } from '../token-telemetry.js';

test('estimateTokens is char-based and safe on junk', () => {
    assert.equal(estimateTokens('abcd'.repeat(100)), 100); // 400 chars / 4
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(null), 0);
});

test('records estimate and backend passes and accumulates', () => {
    resetTelemetry('t1');
    recordPass({ chatId: 't1', promptText: 'x'.repeat(4000), outputText: 'y'.repeat(400) }); // 1000/100 est
    recordPass({ chatId: 't1', inTokens: 1200, outTokens: 150 });                              // backend
    const t = getTelemetry('t1');
    assert.equal(t.totals.calls, 2);
    assert.equal(t.totals.in, 2200);
    assert.equal(t.totals.out, 250);
    assert.deepEqual(t.passes.map(p => p.method), ['estimate', 'backend']);
});

test('projectCost computes indicative $ per call', () => {
    resetTelemetry('t2');
    recordPass({ chatId: 't2', inTokens: 1_000_000, outTokens: 1_000_000 });
    const c = projectCost('t2', 0.15, 0.60);
    assert.equal(c.estCostUSD, 0.75); // 0.15 + 0.60
    assert.equal(c.calls, 1);
});

test('resetTelemetry clears a chat', () => {
    recordPass({ chatId: 't3', inTokens: 10, outTokens: 5 });
    resetTelemetry('t3');
    assert.equal(getTelemetry('t3').totals.calls, 0);
});
