// tests/grading.test.js
// ─── GRADING ENGINE TEST SUITE ────────────────────────────────────────────────
// Covers scoring/grading.ts (prop + game grading) and the inverse-sigmoid
// calibration math used by app/api/calibration-report/route.ts.
// Run: node tests/grading.test.js
// Exit 0 = all pass. Exit 1 = at least one failure.

'use strict';
const assert = require('assert');

// ─── MIRRORS OF PRODUCTION LOGIC ──────────────────────────────────────────────
// These mirror scoring/grading.ts and app/api/calibration-report/route.ts exactly.
// Any change to production code must be reflected here.

function gradeProp(date, prediction, propType, result) {
  const explanation = prediction.explanations.find(e => e.prop === propType);
  if (!explanation) return null;
  if (explanation.confidence === 'LOW') return null;
  if (!result) return null;

  const correct = (() => {
    switch (propType) {
      case 'hit': return result.hits >= 1;
      case 'run': return result.runs >= 1;
      case 'rbi': return result.rbi >= 1;
      case 'hr':  return result.homeRuns >= 1;
    }
  })();

  return {
    date, playerId: prediction.hitter.id, playerName: prediction.hitter.fullName,
    prop: propType, tier: explanation.confidence, predictedProbability: explanation.probability, correct,
  };
}

function gradeGame(date, prediction, actual) {
  if (!actual.isFinal) return { ml: null, ou: null, nrfi: null };

  const actualWinnerSide = actual.homeRuns === actual.awayRuns
    ? null : actual.homeRuns > actual.awayRuns ? 'home' : 'away';

  let ml = null;
  if (prediction.pickSide && actualWinnerSide) {
    ml = {
      date, gamePk: prediction.gamePk, pickType: 'ml', pickLabel: prediction.pickLabel,
      confidence: prediction.confidence, correct: prediction.pickSide === actualWinnerSide,
    };
  }

  let ou = null;
  if (prediction.totalPick && prediction.ouLine !== null) {
    const actualTotal = actual.homeRuns + actual.awayRuns;
    const actualResult = actualTotal === prediction.ouLine
      ? null : actualTotal > prediction.ouLine ? 'OVER' : 'UNDER';
    if (actualResult) {
      ou = {
        date, gamePk: prediction.gamePk, pickType: 'ou', pickLabel: prediction.totalPickLabel,
        confidence: prediction.totalConfidence, correct: prediction.totalPick === actualResult,
      };
    }
  }

  let nrfi = null;
  if (prediction.nrfiPick) {
    const anyFirstInningRun = actual.homeFirstInningRuns > 0 || actual.awayFirstInningRuns > 0;
    const actualNrfi = anyFirstInningRun ? 'YRFI' : 'NRFI';
    nrfi = {
      date, gamePk: prediction.gamePk, pickType: 'nrfi', pickLabel: prediction.nrfiPickLabel,
      confidence: prediction.nrfiConfidence, correct: prediction.nrfiPick === actualNrfi,
    };
  }

  return { ml, ou, nrfi };
}

function logit(p) {
  const clamped = Math.min(0.99, Math.max(0.01, p));
  return Math.log(clamped / (1 - clamped));
}

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

function suggestIntercept(currentIntercept, scale, predictedAvg, actualRate) {
  return currentIntercept + (logit(actualRate) - logit(predictedAvg)) / scale;
}

// ─── TEST RUNNER ─────────────────────────────────────────────────────────────

let passed = 0; let failed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    → ${e.message}`); failed++; failures.push(name); }
}

function makePrediction(overrides = {}) {
  return {
    hitter: { id: 660271, fullName: 'Shohei Ohtani' },
    explanations: [
      { prop: 'hr', probability: 0.20, confidence: 'ELITE' },
      { prop: 'hit', probability: 0.70, confidence: 'STRONG' },
      { prop: 'run', probability: 0.25, confidence: 'LOW' },
      { prop: 'rbi', probability: 0.15, confidence: 'VALUE' },
    ],
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// GROUP 1: Prop grading
// ══════════════════════════════════════════════════════════════════════════════
console.log('\nGROUP 1: Prop grading\n');

test('HR pick hits when player actually homered', () => {
  const p = makePrediction();
  const g = gradeProp('2026-05-01', p, 'hr', { hits: 1, atBats: 4, runs: 1, rbi: 2, homeRuns: 1, totalBases: 4 });
  assert.strictEqual(g.correct, true);
  assert.strictEqual(g.tier, 'ELITE');
});

test('HR pick misses when player did not homer', () => {
  const p = makePrediction();
  const g = gradeProp('2026-05-01', p, 'hr', { hits: 1, atBats: 4, runs: 0, rbi: 0, homeRuns: 0, totalBases: 1 });
  assert.strictEqual(g.correct, false);
});

test('LOW tier prop is never graded (not an advertised pick)', () => {
  const p = makePrediction();
  const g = gradeProp('2026-05-01', p, 'run', { hits: 1, atBats: 4, runs: 1, rbi: 0, homeRuns: 0, totalBases: 1 });
  assert.strictEqual(g, null, 'LOW-tier predictions must be excluded from grading');
});

test('Missing boxscore result (DNP/scratched) excluded, not scored as a loss', () => {
  const p = makePrediction();
  const g = gradeProp('2026-05-01', p, 'hit', undefined);
  assert.strictEqual(g, null);
});

test('Hit/RBI props graded independently per prop type', () => {
  const p = makePrediction();
  const result = { hits: 2, atBats: 4, runs: 1, rbi: 0, homeRuns: 0, totalBases: 2 };
  const hitGrade = gradeProp('2026-05-01', p, 'hit', result);
  const rbiGrade = gradeProp('2026-05-01', p, 'rbi', result);
  assert.strictEqual(hitGrade.correct, true);
  assert.strictEqual(rbiGrade.correct, false);
});

// ══════════════════════════════════════════════════════════════════════════════
// GROUP 2: Game grading — Moneyline
// ══════════════════════════════════════════════════════════════════════════════
console.log('\nGROUP 2: Moneyline grading\n');

function makeGamePrediction(overrides = {}) {
  return {
    gamePk: 1001, pickSide: 'home', pickLabel: 'NYY ML', confidence: 'HIGH',
    totalPick: null, totalPickLabel: '', totalConfidence: 'LOW', ouLine: null,
    nrfiPick: null, nrfiPickLabel: '', nrfiConfidence: 'LOW',
    ...overrides,
  };
}

test('ML pick correct when picked side wins', () => {
  const pred = makeGamePrediction({ pickSide: 'home' });
  const actual = { gamePk: 1001, isFinal: true, homeRuns: 5, awayRuns: 2, homeFirstInningRuns: 0, awayFirstInningRuns: 0 };
  const { ml } = gradeGame('2026-05-01', pred, actual);
  assert.strictEqual(ml.correct, true);
});

test('ML pick incorrect when picked side loses', () => {
  const pred = makeGamePrediction({ pickSide: 'home' });
  const actual = { gamePk: 1001, isFinal: true, homeRuns: 1, awayRuns: 6, homeFirstInningRuns: 0, awayFirstInningRuns: 0 };
  const { ml } = gradeGame('2026-05-01', pred, actual);
  assert.strictEqual(ml.correct, false);
});

test('No pick ("Pick\'em", pickSide null) is never graded', () => {
  const pred = makeGamePrediction({ pickSide: null });
  const actual = { gamePk: 1001, isFinal: true, homeRuns: 3, awayRuns: 3, homeFirstInningRuns: 0, awayFirstInningRuns: 0 };
  const { ml } = gradeGame('2026-05-01', pred, actual);
  assert.strictEqual(ml, null);
});

test('Game not yet Final is never graded', () => {
  const pred = makeGamePrediction({ pickSide: 'home' });
  const actual = { gamePk: 1001, isFinal: false, homeRuns: 5, awayRuns: 2, homeFirstInningRuns: 0, awayFirstInningRuns: 0 };
  const { ml, ou, nrfi } = gradeGame('2026-05-01', pred, actual);
  assert.strictEqual(ml, null);
  assert.strictEqual(ou, null);
  assert.strictEqual(nrfi, null);
});

// ══════════════════════════════════════════════════════════════════════════════
// GROUP 3: Game grading — Over/Under
// ══════════════════════════════════════════════════════════════════════════════
console.log('\nGROUP 3: Over/Under grading\n');

test('O/U pick graded correct when actual total clears a real sportsbook line', () => {
  const pred = makeGamePrediction({ totalPick: 'OVER', totalPickLabel: 'OVER 8.5', totalConfidence: 'HIGH', ouLine: 8.5 });
  const actual = { gamePk: 1001, isFinal: true, homeRuns: 5, awayRuns: 5, homeFirstInningRuns: 0, awayFirstInningRuns: 0 };
  const { ou } = gradeGame('2026-05-01', pred, actual);
  assert.strictEqual(ou.correct, true);
});

test('O/U pick with no real sportsbook line is never graded (fallback picks excluded)', () => {
  const pred = makeGamePrediction({ totalPick: 'UNDER', totalPickLabel: 'UNDER (proj 7.2)', totalConfidence: 'HIGH', ouLine: null });
  const actual = { gamePk: 1001, isFinal: true, homeRuns: 2, awayRuns: 2, homeFirstInningRuns: 0, awayFirstInningRuns: 0 };
  const { ou } = gradeGame('2026-05-01', pred, actual);
  assert.strictEqual(ou, null, 'No-line fallback picks must not be judged against a line nobody offered');
});

test('O/U push (actual total exactly equals the line) excluded, not a loss', () => {
  const pred = makeGamePrediction({ totalPick: 'OVER', totalPickLabel: 'OVER 9.0', totalConfidence: 'MEDIUM', ouLine: 9.0 });
  const actual = { gamePk: 1001, isFinal: true, homeRuns: 5, awayRuns: 4, homeFirstInningRuns: 0, awayFirstInningRuns: 0 };
  const { ou } = gradeGame('2026-05-01', pred, actual);
  assert.strictEqual(ou, null);
});

// ══════════════════════════════════════════════════════════════════════════════
// GROUP 4: Game grading — NRFI/YRFI
// ══════════════════════════════════════════════════════════════════════════════
console.log('\nGROUP 4: NRFI/YRFI grading\n');

test('NRFI pick correct when neither team scores in the 1st', () => {
  const pred = makeGamePrediction({ nrfiPick: 'NRFI', nrfiPickLabel: 'NRFI', nrfiConfidence: 'HIGH' });
  const actual = { gamePk: 1001, isFinal: true, homeRuns: 4, awayRuns: 3, homeFirstInningRuns: 0, awayFirstInningRuns: 0 };
  const { nrfi } = gradeGame('2026-05-01', pred, actual);
  assert.strictEqual(nrfi.correct, true);
});

test('NRFI pick incorrect when either team scores in the 1st', () => {
  const pred = makeGamePrediction({ nrfiPick: 'NRFI', nrfiPickLabel: 'NRFI', nrfiConfidence: 'HIGH' });
  const actual = { gamePk: 1001, isFinal: true, homeRuns: 4, awayRuns: 3, homeFirstInningRuns: 1, awayFirstInningRuns: 0 };
  const { nrfi } = gradeGame('2026-05-01', pred, actual);
  assert.strictEqual(nrfi.correct, false);
});

test('YRFI pick correct when a run scores in the 1st', () => {
  const pred = makeGamePrediction({ nrfiPick: 'YRFI', nrfiPickLabel: 'YRFI', nrfiConfidence: 'LOCK' });
  const actual = { gamePk: 1001, isFinal: true, homeRuns: 4, awayRuns: 3, homeFirstInningRuns: 0, awayFirstInningRuns: 2 };
  const { nrfi } = gradeGame('2026-05-01', pred, actual);
  assert.strictEqual(nrfi.correct, true);
});

// ══════════════════════════════════════════════════════════════════════════════
// GROUP 5: Calibration math (inverse-sigmoid intercept suggestion)
// ══════════════════════════════════════════════════════════════════════════════
console.log('\nGROUP 5: Calibration math\n');

test('Suggested intercept round-trips: applying it recovers the target actual rate', () => {
  const scale = 0.557;
  const currentIntercept = -8.90;
  const rawScore = 3.5; // arbitrary fixed raw feature score
  const predictedAvg = sigmoid((rawScore + currentIntercept) * scale);
  const actualRate = 0.12; // realized rate diverges from what the engine predicted

  const newIntercept = suggestIntercept(currentIntercept, scale, predictedAvg, actualRate);
  const recovered = sigmoid((rawScore + newIntercept) * scale);

  assert.ok(Math.abs(recovered - actualRate) < 1e-9,
    `Expected recovered probability ${recovered} to match actual rate ${actualRate}`);
});

test('No calibration gap → suggested intercept equals current intercept', () => {
  const scale = 0.256;
  const currentIntercept = -0.35;
  const predictedAvg = 0.63;
  const actualRate = 0.63; // perfectly calibrated
  const newIntercept = suggestIntercept(currentIntercept, scale, predictedAvg, actualRate);
  assert.ok(Math.abs(newIntercept - currentIntercept) < 1e-9);
});

test('Engine under-calling reality → suggested intercept shifts upward (raises predicted probability)', () => {
  const scale = 0.355;
  const currentIntercept = -5.75;
  const predictedAvg = 0.22; // engine says 22%
  const actualRate = 0.30;   // reality is 30% — engine is too conservative
  const newIntercept = suggestIntercept(currentIntercept, scale, predictedAvg, actualRate);
  assert.ok(newIntercept > currentIntercept, 'Intercept should rise to predict higher probabilities');
});

// ──────────────────────────────────────────────────────────────────────────────
// RESULTS
// ──────────────────────────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log(`\nFailed tests:`);
  failures.forEach(f => console.log(`  ✗ ${f}`));
}
console.log(`${'─'.repeat(60)}\n`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('✅ All grading tests passed\n');
  process.exit(0);
}
