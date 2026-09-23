import test from 'node:test';
import assert from 'node:assert/strict';
import {
  asOfContact,
  buildBoards,
  FULL_BOARD_OPTIONS,
  weatherHrMultiplier,
} from '../scoring/hrBoard.ts';

const asOf = '2026-09-07';
const slate = '2026-09-08';

function candidate(overrides = {}) {
  return {
    playerId: 1,
    gamePk: 100,
    teamId: 10,
    batHand: 'R',
    lineupSpot: 3,
    lineupKnown: true,
    seasonPaPerGame: 4.2,
    seasonHr: 30,
    seasonPa: 500,
    iso: 0.250,
    vsHandHr: 12,
    vsHandPa: 180,
    l14Hr: 3,
    l14Pa: 50,
    l30Pa: 100,
    contactSeason: null,
    contactL14: null,
    xIso: null,
    pitcherKnown: true,
    pitcherHand: 'L',
    pitcherHr: 20,
    pitcherBf: 500,
    pitcherVsHandHr: 10,
    pitcherVsHandBf: 200,
    pitcherAirOuts: 120,
    pitcherGroundOuts: 150,
    pitcherHard: null,
    pitcherBbe: null,
    stadiumHr: 1.12,
    weather: {
      tempF: 78,
      windMph: 10,
      cfOut: 0.9,
      pullOut: 0.9,
      indoorOrRoof: false,
      missing: false,
    },
    leagueHrPa: 0.0306,
    leagueIso: 0.155,
    baselineProbability: 0.2,
    ...overrides,
  };
}

test('as-of contact excludes the slate date and anything after it', () => {
  const rows = [
    { date: '2026-09-06', playerId: 7, pa: 4, bbe: 3, barrel: 1, hard: 2 },
    { date: asOf, playerId: 7, pa: 4, bbe: 2, barrel: 1, hard: 1 },
    { date: slate, playerId: 7, pa: 5, bbe: 4, barrel: 4, hard: 4 },
    { date: '2026-09-09', playerId: 7, pa: 5, bbe: 5, barrel: 5, hard: 5 },
    { date: '2026-09-06', playerId: 8, pa: 4, bbe: 4, barrel: 4, hard: 4 },
  ];
  const sum = asOfContact(rows, 7, slate);
  assert.equal(sum.pa, 8);
  assert.equal(sum.bbe, 5);
  assert.equal(sum.barrel, 2);
  assert.equal(sum.hard, 3);
  assert.equal(asOfContact(rows, 7, slate).barrel, 2);
});

test('a suppressed park never pads the board', () => {
  const banned = candidate({
    playerId: 1,
    stadiumHr: 0.75,
    weather: { tempF: 70, windMph: 0, cfOut: 0, pullOut: 0, indoorOrRoof: false, missing: false },
    baselineProbability: 0.9,
    iso: 0.400,
  });
  const ok = candidate({ playerId: 2, gamePk: 200, teamId: 20, iso: 0.210 });
  const boards = buildBoards([banned, ok], FULL_BOARD_OPTIONS, asOf);
  assert.equal(boards.full.some(p => p.playerId === 1), false);
  assert.equal(boards.all.find(p => p.playerId === 1).filterReason, 'env-ban');
  assert.equal(boards.full.some(p => p.playerId === 2), true);
});

test('order 8 is dropped and order 3 stays', () => {
  const eighth = candidate({ playerId: 8, lineupSpot: 8, iso: 0.180 });
  const third = candidate({ playerId: 3, lineupSpot: 3, gamePk: 200, teamId: 20, iso: 0.180 });
  const boards = buildBoards([eighth, third], FULL_BOARD_OPTIONS, asOf);
  assert.equal(boards.all.find(p => p.playerId === 8).filterReason, 'order');
  assert.equal(boards.full.some(p => p.playerId === 3), true);
  assert.equal(boards.full.some(p => p.playerId === 8), false);
});

test('the board publishes 2 when only 2 pass', () => {
  const a = candidate({ playerId: 1, iso: 0.260 });
  const b = candidate({ playerId: 2, gamePk: 200, teamId: 20, iso: 0.240 });
  const boards = buildBoards([a, b], FULL_BOARD_OPTIONS, asOf);
  assert.equal(boards.full.length, 2);
  assert.ok(boards.full.length < 20);
});

test('null Statcast stays null and the source is the ISO proxy', () => {
  const row = candidate({ contactSeason: null, xIso: null, iso: 0.280 });
  const boards = buildBoards([row], FULL_BOARD_OPTIONS, asOf);
  assert.equal(boards.full.length, 1);
  assert.equal(boards.full[0].barrelPct, null);
  assert.equal(boards.full[0].xIso, null);
  assert.equal(boards.full[0].contactSource, 'proxy');
  assert.ok(boards.full[0].flags.includes('proxy'));
});

test('wind out to CF raises the multiplier and wind in lowers it', () => {
  const out = weatherHrMultiplier({
    tempF: 75, windMph: 12, cfOut: 1, pullOut: 1, indoorOrRoof: false, missing: false,
  });
  const inn = weatherHrMultiplier({
    tempF: 75, windMph: 12, cfOut: -1, pullOut: -1, indoorOrRoof: false, missing: false,
  });
  assert.ok(out.mult > 1);
  assert.ok(inn.mult < 1);
  assert.ok(out.mult > inn.mult);
});

test('a CF tailwind still helps when the pull side is into the wind', () => {
  const blended = weatherHrMultiplier({
    tempF: 70, windMph: 10, cfOut: 1, pullOut: -1, indoorOrRoof: false, missing: false,
  });
  const calm = weatherHrMultiplier({
    tempF: 70, windMph: 0, cfOut: 0, pullOut: 0, indoorOrRoof: false, missing: false,
  });
  assert.ok(blended.mult > calm.mult);
});
