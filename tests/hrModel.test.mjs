import test from 'node:test';
import assert from 'node:assert/strict';
import {
  homeRunProbability,
  regressedHrPerPa,
  dampenedParkFactor,
  empiricalParkFactor,
  expectedPlateAppearances,
  spotHomeRunProbability,
  pitcherHrMultiplier,
  weatherHrMultiplier,
  handAdjustedHrRate,
} from '../scoring/hrModel.ts';

const league = 0.0306;

function input(overrides = {}) {
  return {
    hr: 36,
    pa: 600,
    leagueHrPa: league,
    parkFactor: 1,
    teamGames: 140,
    lineupKnown: true,
    lineupSpot: 4,
    ...overrides,
  };
}

test('small samples shrink toward the league HR rate', () => {
  const fluke = regressedHrPerPa(3, 15, league);
  assert.ok(fluke < 0.05, `fluke rate ${fluke} should not stay near 3/15`);
  assert.ok(fluke > league, 'a few homers still sit above the league rate');
  const established = regressedHrPerPa(36, 600, league);
  assert.ok(established > fluke);
  assert.ok(Math.abs(established - 36 / 600) < 0.01);
});

test('no plate appearances uses a league-level rate, not zero', () => {
  const rate = regressedHrPerPa(0, 0, league);
  assert.equal(rate, league * 0.85);
});

test('more playing time raises HR probability for the same rate', () => {
  const leadoff = homeRunProbability(input({ lineupSpot: 1 }));
  const ninth = homeRunProbability(input({ lineupSpot: 9 }));
  const bench = homeRunProbability(input({ lineupSpot: 0 }));
  assert.ok(leadoff > ninth);
  assert.ok(ninth > bench);
  assert.ok(bench < 0.05);
});

test('pre-lineup playing time discounts part-time bats', () => {
  const regular = expectedPlateAppearances(input({ lineupKnown: false, lineupSpot: null, pa: 560, teamGames: 140 }));
  const bench = expectedPlateAppearances(input({ lineupKnown: false, lineupSpot: null, pa: 140, teamGames: 140 }));
  assert.ok(regular > 3.5);
  assert.ok(bench < 1.2);
  assert.ok(homeRunProbability(input({ lineupKnown: false, lineupSpot: null, pa: 560, hr: 34 }))
    > homeRunProbability(input({ lineupKnown: false, lineupSpot: null, pa: 140, hr: 8 })));
});

test('park factor is square-root dampened and still ordered', () => {
  assert.ok(Math.abs(dampenedParkFactor(1.21) - 1.1) < 1e-9);
  assert.ok(dampenedParkFactor(1.35) < 1.35);
  assert.equal(dampenedParkFactor(1), 1);
  const plus = homeRunProbability(input({ parkFactor: 1.21 }));
  const neutral = homeRunProbability(input({ parkFactor: 1 }));
  const coorsLike = homeRunProbability(input({ parkFactor: 1.35 }));
  assert.ok(plus > neutral);
  assert.ok(coorsLike > plus);
  assert.ok(dampenedParkFactor(1.35) < 1.2);
});

test('empirical park factor shrinks a thin Coors-style gap toward 1', () => {
  // Observed 2026 Rockies shape: slightly more HR at home than on the road, not 1.38x.
  const factor = empiricalParkFactor(203, 6200, 184, 6000, league);
  assert.ok(factor != null);
  assert.ok(factor > 1);
  assert.ok(factor < 1.15, `factor ${factor} should not recreate the stale 1.38 Coors weight`);
  assert.equal(empiricalParkFactor(10, 100, 10, 100, league), null);
});

test('neutral matchup spot rate matches the season-rate model', () => {
  const base = homeRunProbability(input());
  const spot = spotHomeRunProbability(input(), 'matchup');
  assert.ok(Math.abs(base - spot) < 1e-12, `base ${base} spot ${spot}`);
});

test('a homer-prone starter raises matchup probability', () => {
  const neutral = spotHomeRunProbability(input(), 'matchup');
  const soft = spotHomeRunProbability(input({
    pitcherHr: 28,
    pitcherBf: 700,
  }), 'matchup');
  const stingy = spotHomeRunProbability(input({
    pitcherHr: 8,
    pitcherBf: 700,
  }), 'matchup');
  assert.ok(soft > neutral);
  assert.ok(stingy < neutral);
  assert.ok(pitcherHrMultiplier(28, 700, league) > 1);
  assert.ok(pitcherHrMultiplier(null, null, league) === 1);
});

test('hand split moves the rate toward the matchup sample', () => {
  const vsLeft = handAdjustedHrRate(30, 600, 2, 120, league);
  const vsRight = handAdjustedHrRate(30, 600, 28, 480, league);
  assert.ok(vsLeft < vsRight);
  const bad = spotHomeRunProbability(input({ handHr: 2, handPa: 120 }), 'matchup');
  const good = spotHomeRunProbability(input({ handHr: 28, handPa: 480 }), 'matchup');
  assert.ok(good > bad);
});

test('wind out raises the spot model and a dome does not', () => {
  const calm = spotHomeRunProbability(input({ tempF: 70, windMph: 0, windOutComponent: 0 }), 'spot');
  const out = spotHomeRunProbability(input({ tempF: 85, windMph: 18, windOutComponent: 1 }), 'spot');
  const dome = spotHomeRunProbability(input({
    tempF: 95, windMph: 20, windOutComponent: 1, suppressWeather: true,
  }), 'spot');
  assert.ok(out > calm);
  assert.ok(Math.abs(dome - calm) < 1e-9);
  assert.ok(weatherHrMultiplier(85, 18, 1, false) > 1);
  assert.equal(weatherHrMultiplier(95, 20, 1, true), 1);
});

test('extra barrels raise contact probability above the raw HR rate', () => {
  const raw = spotHomeRunProbability(input(), 'contact');
  const barrels = spotHomeRunProbability(input({
    barrels: 70,
    barrelPa: 600,
    leagueBarrelPa: 0.049,
    hrPerBarrel: 2940 / 4783,
  }), 'contact');
  assert.ok(barrels > raw, `barrels ${barrels} raw ${raw}`);
});

test('probabilities stay in a single-game range', () => {
  const elite = homeRunProbability(input({ hr: 45, pa: 600, lineupSpot: 3, parkFactor: 1.15 }));
  const empty = homeRunProbability(input({ hr: 0, pa: 0, lineupKnown: false, lineupSpot: null, teamGames: 0 }));
  assert.ok(elite > 0.15 && elite < 0.45, `elite ${elite}`);
  assert.ok(empty > 0 && empty < 0.2);
});
