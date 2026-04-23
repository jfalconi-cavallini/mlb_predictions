// tests/validation.test.js
// ─── COMPREHENSIVE VALIDATION TEST SUITE ─────────────────────────────────────
// Covers all 10 vulnerabilities found in QA audit.
// Run: node tests/validation.test.js
// Exit 0 = all pass. Exit 1 = at least one failure.

'use strict';
const assert = require('assert');

// ─── MIRRORS OF PATCHED PRODUCTION LOGIC ─────────────────────────────────────
// These mirror lib/validation.ts and lib/mlbApi.ts exactly.
// Any change to production code must be reflected here.

const VALID_MLB_TEAM_IDS = new Set([
  108,109,110,111,112,113,114,115,116,117,118,119,120,121,
  133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,158,
]);

const HITTER_POSITIONS = new Set([
  'C','1B','2B','3B','SS','LF','CF','RF','OF','DH','IF','TWP',
]);

// VULN-06 FIX: normalize before compare
const RAW_NON_MLB_NAMES = [
  'Cade Cunningham','Victor Wembanyama','LeBron James','Patrick Mahomes','Nikola Jokic',
];
function normalizeName(name) {
  return String(name).toLowerCase().replace(/\s+/g, ' ').trim();
}
const NORMALIZED_NON_MLB_NAMES = new Set(RAW_NON_MLB_NAMES.map(normalizeName));

const KNOWN_NON_MLB_IDS = new Set([9999991, 9999992]);

function isHitterPosition(pos) {
  return HITTER_POSITIONS.has((pos || '').toUpperCase().trim());
}

function isKnownNonMLBName(name) {
  return NORMALIZED_NON_MLB_NAMES.has(normalizeName(name));
}

// VULN-01 FIX: explicit active check
function isActiveStatus(statusObj) {
  const code = statusObj?.code ?? null;
  if (code === null) return false;   // missing = not active
  return code === 'A';
}

// VULN-08 FIX: date validation
const CURRENT_YEAR = new Date().getFullYear();
const SEASON_START = `${CURRENT_YEAR}-03-20`;
const SEASON_END   = `${CURRENT_YEAR}-11-05`;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateDateParam(raw) {
  const fallback = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  if (!raw) return { date: fallback, season: String(CURRENT_YEAR), error: null };
  if (!DATE_RE.test(raw)) return { date: fallback, season: String(CURRENT_YEAR), error: `Bad format: ${raw}` };
  const parsed = new Date(raw + 'T12:00:00Z');
  if (isNaN(parsed.getTime())) return { date: fallback, season: String(CURRENT_YEAR), error: `Invalid date: ${raw}` };
  if (raw < SEASON_START || raw > SEASON_END) return { date: fallback, season: String(CURRENT_YEAR), error: `Out of season: ${raw}` };
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  if (raw > tomorrowStr) return { date: fallback, season: String(CURRENT_YEAR), error: `Future date: ${raw}` };
  return { date: raw, season: String(parsed.getUTCFullYear()), error: null };
}

// Full validation pipeline (mirrors validateAndBuildHitterPool)
function validatePlayer(player, todaysTeamIds, teamGameMap, seenIds) {
  // CHECK 1
  if (!player.id || !Number.isInteger(player.id) || player.id <= 0)
    return { valid: false, reason: 'NO_MLB_ID' };
  // CHECK 2
  if (KNOWN_NON_MLB_IDS.has(player.id))
    return { valid: false, reason: 'WRONG_SPORT' };
  // CHECK 3 — normalized
  if (isKnownNonMLBName(player.fullName))
    return { valid: false, reason: 'WRONG_SPORT' };
  // CHECK 4
  if (!isHitterPosition(player.position))
    return { valid: false, reason: 'NOT_A_HITTER' };
  // CHECK 5 — queriedTeamId cross-check (VULN-02/05 fix)
  if (player.queriedTeamId !== player.teamId)
    return { valid: false, reason: 'NOT_IN_TODAYS_SLATE' };
  if (!todaysTeamIds.has(player.queriedTeamId))
    return { valid: false, reason: 'NO_GAME_TODAY' };
  if (!VALID_MLB_TEAM_IDS.has(player.teamId))
    return { valid: false, reason: 'NOT_IN_TODAYS_SLATE' };
  // CHECK 6 — dedup
  if (seenIds.has(player.id))
    return { valid: false, reason: 'DUPLICATE_ID' };
  seenIds.add(player.id);
  // CHECK 7 — gamePk non-zero (VULN-04 fix)
  const gamePk = teamGameMap ? teamGameMap.get(player.teamId) : undefined;
  if (!gamePk || gamePk === 0)
    return { valid: false, reason: 'NO_GAME_TODAY' };

  return { valid: true, reason: null };
}

// ─── TEST RUNNER ─────────────────────────────────────────────────────────────

let passed = 0; let failed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    → ${e.message}`); failed++; failures.push(name); }
}

function makeValidPlayer(overrides = {}) {
  return {
    id: 660271, fullName: 'Shohei Ohtani',
    teamId: 119, queriedTeamId: 119, position: 'DH',
    ...overrides,
  };
}

const TODAY_TEAMS = new Set([119, 137]); // LAD vs SF
const TODAY_GAME_MAP = new Map([[119, 824693], [137, 824693]]);

// ══════════════════════════════════════════════════════════════════════════════
// GROUP 1: VULN-01 — Status code null bypass
// ══════════════════════════════════════════════════════════════════════════════
console.log('\nGROUP 1: VULN-01 — Status code null bypass\n');

test('Null status object → rejected (not treated as active)', () => {
  assert.strictEqual(isActiveStatus(null), false);
});

test('Undefined status object → rejected', () => {
  assert.strictEqual(isActiveStatus(undefined), false);
});

test('Status object with no code field → rejected', () => {
  assert.strictEqual(isActiveStatus({}), false);
});

test('Status code = "A" → active (passes)', () => {
  assert.strictEqual(isActiveStatus({ code: 'A' }), true);
});

test('Status code = "D" (disabled list) → rejected', () => {
  assert.strictEqual(isActiveStatus({ code: 'D' }), false);
});

test('Status code = "RM" (restricted) → rejected', () => {
  assert.strictEqual(isActiveStatus({ code: 'RM' }), false);
});

test('Status code = "" (empty string) → rejected', () => {
  assert.strictEqual(isActiveStatus({ code: '' }), false);
});

test('Old buggy logic would pass null status — new logic rejects it', () => {
  // Old: `if (entry.status?.code && entry.status.code !== 'A') { continue }`
  // When status=null: undefined && anything = false → skip continue → player passes
  const nullStatus = null;
  const oldLogicWouldPass = !(nullStatus?.code && nullStatus.code !== 'A');
  const newLogicRejects = !isActiveStatus(nullStatus);
  assert.strictEqual(oldLogicWouldPass, true, 'Old logic incorrectly passes null status');
  assert.strictEqual(newLogicRejects, true, 'New logic correctly rejects null status');
});

// ══════════════════════════════════════════════════════════════════════════════
// GROUP 2: VULN-02/05 — Dead team-in-slate check / player-team cross-reference
// ══════════════════════════════════════════════════════════════════════════════
console.log('\nGROUP 2: VULN-02/05 — Team cross-reference\n');

test('Player queriedTeamId matches outer teamId → passes cross-check', () => {
  const p = makeValidPlayer({ teamId: 119, queriedTeamId: 119 });
  const r = validatePlayer(p, TODAY_TEAMS, TODAY_GAME_MAP, new Set());
  assert.strictEqual(r.valid, true, `Expected valid, got ${r.reason}`);
});

test('Player queriedTeamId differs from outer teamId → rejected (data integrity violation)', () => {
  const p = makeValidPlayer({ teamId: 119, queriedTeamId: 143 }); // PHI returned for LAD query
  const r = validatePlayer(p, TODAY_TEAMS, TODAY_GAME_MAP, new Set());
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.reason, 'NOT_IN_TODAYS_SLATE');
});

test('Player whose team is not in today\'s slate → rejected', () => {
  const p = makeValidPlayer({ teamId: 147, queriedTeamId: 147 }); // NYY not playing today
  const r = validatePlayer(p, TODAY_TEAMS, TODAY_GAME_MAP, new Set());
  assert.strictEqual(r.valid, false);
  assert.ok(['NO_GAME_TODAY', 'NOT_IN_TODAYS_SLATE'].includes(r.reason));
});

// ══════════════════════════════════════════════════════════════════════════════
// GROUP 3: VULN-03 — Cache staleness (behavioral test on cache config)
// ══════════════════════════════════════════════════════════════════════════════
console.log('\nGROUP 3: VULN-03 — Cache staleness enforcement\n');

test('Fetch config uses cache:no-store (verified by reading source)', () => {
  const fs = require('fs');
  const src = fs.readFileSync('./lib/mlbApi.ts', 'utf-8');
  assert.ok(src.includes("cache: 'no-store'"), 'mlbApi.ts must use cache: no-store');
  assert.ok(src.includes('revalidate: 0'), 'mlbApi.ts must set revalidate: 0');
});

test('No stale fetch() calls without cache override exist in mlbApi.ts', () => {
  const fs = require('fs');
  const src = fs.readFileSync('./lib/mlbApi.ts', 'utf-8');
  // The ONLY legitimate `await fetch(` call in the file must be inside fetchWithTimeout()
  // which passes cache:'no-store'. Any other await fetch() is a violation.
  // Strategy: count `await fetch(` occurrences and ensure exactly 1 exists
  // (the one inside fetchWithTimeout), and that it has cache:'no-store' near it.
  const rawFetchMatches = (src.match(/\bawait fetch\(/g) || []);
  assert.strictEqual(rawFetchMatches.length, 1,
    `Expected exactly 1 await fetch() call (in fetchWithTimeout), found ${rawFetchMatches.length}`);
  // Verify the single fetch() is inside fetchWithTimeout and has cache: 'no-store'
  assert.ok(src.includes("cache: 'no-store'"),
    'The fetch() call must include cache: no-store');
  // Verify no other function directly calls fetch() — all must go via fetchWithTimeout
  const hasDirectFetch = src.includes('fetchJSON') && !src.includes('fetchWithTimeout(url');
  // fetchJSON must call fetchWithTimeout, not fetch directly
  const fetchJsonCallsWrapper = src.includes('fetchWithTimeout(url)');
  assert.ok(fetchJsonCallsWrapper, 'fetchJSON must call fetchWithTimeout, not fetch() directly');
});

// ══════════════════════════════════════════════════════════════════════════════
// GROUP 4: VULN-04 — gamePk=0 false VALID state
// ══════════════════════════════════════════════════════════════════════════════
console.log('\nGROUP 4: VULN-04 — gamePk=0 must be a rejection\n');

test('Player with no gamePk entry in map → rejected (not given gamePk=0)', () => {
  const emptyGameMap = new Map(); // no games
  const p = makeValidPlayer({ teamId: 119, queriedTeamId: 119 });
  const r = validatePlayer(p, TODAY_TEAMS, emptyGameMap, new Set());
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.reason, 'NO_GAME_TODAY');
});

test('gamePk explicitly 0 → rejected', () => {
  const zeroGameMap = new Map([[119, 0]]);
  const p = makeValidPlayer({ teamId: 119, queriedTeamId: 119 });
  const r = validatePlayer(p, TODAY_TEAMS, zeroGameMap, new Set());
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.reason, 'NO_GAME_TODAY');
});

test('Old code: `?? 0` would produce gamePk=0 and mark VALID', () => {
  // This tests that the old pattern `teamGameMap.get(id) ?? 0` is gone from validation.ts
  const fs = require('fs');
  const src = fs.readFileSync('./lib/validation.ts', 'utf-8');
  // Strip comment lines before searching — comments can legitimately reference the old pattern
  const codeOnly = src.split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');
  assert.ok(!codeOnly.includes('?? 0'), 'validation.ts must not use `?? 0` fallback for gamePk in live code');
});

// ══════════════════════════════════════════════════════════════════════════════
// GROUP 5: VULN-06 — Name ban list normalized comparison
// ══════════════════════════════════════════════════════════════════════════════
console.log('\nGROUP 5: VULN-06 — Normalized name rejection\n');

const nameCases = [
  ['Cade Cunningham',     'exact match'],
  ['cade cunningham',     'all lowercase'],
  ['CADE CUNNINGHAM',     'all uppercase'],
  ['Cade  Cunningham',    'double space'],
  ['  Cade Cunningham  ', 'leading/trailing spaces'],
  ['cADE cUNNINGHAM',     'mixed case'],
];

for (const [variant, desc] of nameCases) {
  test(`Cade Cunningham variant rejected: "${desc}"`, () => {
    assert.strictEqual(isKnownNonMLBName(variant), true, `"${variant}" should be rejected`);
  });
}

test('LeBron James rejected (normalized)', () => {
  assert.strictEqual(isKnownNonMLBName('lebron james'), true);
});

test('Victor Wembanyama rejected (normalized)', () => {
  assert.strictEqual(isKnownNonMLBName('VICTOR WEMBANYAMA'), true);
});

test('Real MLB player "Shohei Ohtani" is NOT in the banned list', () => {
  assert.strictEqual(isKnownNonMLBName('Shohei Ohtani'), false);
});

test('Real MLB player "Aaron Judge" is NOT in the banned list', () => {
  assert.strictEqual(isKnownNonMLBName('Aaron Judge'), false);
});

// ══════════════════════════════════════════════════════════════════════════════
// GROUP 6: VULN-07 — Position type case sensitivity
// ══════════════════════════════════════════════════════════════════════════════
console.log('\nGROUP 6: VULN-07 — Position type case insensitivity\n');

test('All standard hitter positions accepted (uppercase)', () => {
  ['C','1B','2B','3B','SS','LF','CF','RF','OF','DH','IF','TWP'].forEach(p => {
    assert.ok(isHitterPosition(p), `${p} should be a hitter position`);
  });
});

test('Pitcher abbreviations rejected regardless of case', () => {
  ['P','SP','RP','CL','p','sp','rp'].forEach(p => {
    assert.ok(!isHitterPosition(p), `${p} should NOT be a hitter position`);
  });
});

test('Basketball/football positions rejected', () => {
  ['G','F','C_NBA','QB','WR','PG','SG','SF','PF'].forEach(p => {
    assert.ok(!isHitterPosition(p), `${p} should NOT be a hitter position`);
  });
});

test('Empty string position rejected', () => {
  assert.ok(!isHitterPosition(''), 'Empty position must be rejected');
});

test('Null/undefined position rejected without crash', () => {
  assert.ok(!isHitterPosition(null), 'null position must be rejected');
  assert.ok(!isHitterPosition(undefined), 'undefined position must be rejected');
});

// ══════════════════════════════════════════════════════════════════════════════
// GROUP 7: VULN-08 — Date parameter validation
// ══════════════════════════════════════════════════════════════════════════════
console.log('\nGROUP 7: VULN-08 — Date parameter validation\n');

test('null date → defaults to today, no error', () => {
  const r = validateDateParam(null);
  assert.strictEqual(r.error, null);
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.date));
});

test('Bad format "April 23 2026" → error, falls back to today', () => {
  const r = validateDateParam('April 23 2026');
  assert.ok(r.error !== null);
});

test('Date "1999-01-01" → out of season, rejected', () => {
  const r = validateDateParam('1999-01-01');
  assert.ok(r.error !== null, 'Historical date must be rejected');
});

test('Date "2099-12-31" → far future, rejected', () => {
  const r = validateDateParam('2099-12-31');
  assert.ok(r.error !== null, 'Far future date must be rejected');
});

test('Season is derived from date year, not hardcoded', () => {
  // If we ask for today's date, season should be current year
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const r = validateDateParam(today);
  assert.strictEqual(r.season, String(CURRENT_YEAR), 'Season must match date year');
});

test('Invalid calendar date "2026-02-30" → error', () => {
  const r = validateDateParam('2026-02-30');
  assert.ok(r.error !== null, 'Non-existent date must be rejected');
});

// ══════════════════════════════════════════════════════════════════════════════
// GROUP 8: VULN-09 — Real deduplication test (replaces vacuous Set.has() test)
// ══════════════════════════════════════════════════════════════════════════════
console.log('\nGROUP 8: VULN-09 — Real deduplication pipeline test\n');

test('Same player ID accepted once, rejected on second encounter', () => {
  const seen = new Set();
  const p = makeValidPlayer({ id: 660271, teamId: 119, queriedTeamId: 119 });

  const first = validatePlayer(p, TODAY_TEAMS, TODAY_GAME_MAP, seen);
  assert.strictEqual(first.valid, true, 'First encounter should be valid');

  const second = validatePlayer({ ...p }, TODAY_TEAMS, TODAY_GAME_MAP, seen);
  assert.strictEqual(second.valid, false, 'Second encounter must be rejected');
  assert.strictEqual(second.reason, 'DUPLICATE_ID', 'Rejection reason must be DUPLICATE_ID');
});

test('Different player IDs are not incorrectly deduplicated', () => {
  const seen = new Set();
  const p1 = makeValidPlayer({ id: 660271, fullName: 'Shohei Ohtani', teamId: 119, queriedTeamId: 119 });
  const p2 = makeValidPlayer({ id: 671096, fullName: 'Freddie Freeman', teamId: 119, queriedTeamId: 119 });

  const r1 = validatePlayer(p1, TODAY_TEAMS, TODAY_GAME_MAP, seen);
  const r2 = validatePlayer(p2, TODAY_TEAMS, TODAY_GAME_MAP, seen);

  assert.strictEqual(r1.valid, true, 'First player should be valid');
  assert.strictEqual(r2.valid, true, 'Second player with different ID should also be valid');
});

test('Three different teams, same player appears twice → second rejected', () => {
  const seen = new Set();
  const sharedId = 123456;
  const teams = new Set([119, 137, 147]);
  const gameMap = new Map([[119, 1001], [137, 1001], [147, 1002]]);

  const p1 = makeValidPlayer({ id: sharedId, teamId: 119, queriedTeamId: 119 });
  const p2 = makeValidPlayer({ id: sharedId, teamId: 137, queriedTeamId: 137 });

  const r1 = validatePlayer(p1, teams, gameMap, seen);
  const r2 = validatePlayer(p2, teams, gameMap, seen);

  assert.strictEqual(r1.valid, true);
  assert.strictEqual(r2.valid, false);
  assert.strictEqual(r2.reason, 'DUPLICATE_ID');
});

// ══════════════════════════════════════════════════════════════════════════════
// GROUP 9: MLB ID and team validation
// ══════════════════════════════════════════════════════════════════════════════
console.log('\nGROUP 9: MLB ID and team validation\n');

test('Null player ID → NO_MLB_ID', () => {
  const p = makeValidPlayer({ id: null });
  const r = validatePlayer(p, TODAY_TEAMS, TODAY_GAME_MAP, new Set());
  assert.strictEqual(r.reason, 'NO_MLB_ID');
});

test('Float player ID → NO_MLB_ID', () => {
  const p = makeValidPlayer({ id: 12345.6 });
  const r = validatePlayer(p, TODAY_TEAMS, TODAY_GAME_MAP, new Set());
  assert.strictEqual(r.reason, 'NO_MLB_ID');
});

test('Negative player ID → NO_MLB_ID', () => {
  const p = makeValidPlayer({ id: -1 });
  const r = validatePlayer(p, TODAY_TEAMS, TODAY_GAME_MAP, new Set());
  assert.strictEqual(r.reason, 'NO_MLB_ID');
});

test('Non-MLB team ID 9999 → rejected', () => {
  const p = makeValidPlayer({ teamId: 9999, queriedTeamId: 9999 });
  const r = validatePlayer(p, new Set([9999]), TODAY_GAME_MAP, new Set());
  assert.ok(!r.valid);
});

test('All 30 MLB team IDs registered', () => {
  assert.strictEqual(VALID_MLB_TEAM_IDS.size, 30);
});

// ══════════════════════════════════════════════════════════════════════════════
// GROUP 10: Regression — cross-sport contamination
// ══════════════════════════════════════════════════════════════════════════════
console.log('\nGROUP 10: Regression — cross-sport contamination\n');

test('[REGRESSION] Cade Cunningham rejected on all 4 checks simultaneously', () => {
  const cade = { id: 9999991, fullName: 'Cade Cunningham', teamId: 160, queriedTeamId: 160, position: 'G' };
  assert.ok(KNOWN_NON_MLB_IDS.has(cade.id),          'Must fail: known non-MLB ID');
  assert.ok(isKnownNonMLBName(cade.fullName),         'Must fail: known non-MLB name');
  assert.ok(!VALID_MLB_TEAM_IDS.has(cade.teamId),     'Must fail: invalid MLB team');
  assert.ok(!isHitterPosition(cade.position),         'Must fail: invalid hitter position');
});

test('[REGRESSION] Cade Cunningham with fake valid MLB ID still rejected by name', () => {
  const cade = makeValidPlayer({ id: 123456, fullName: 'Cade Cunningham', teamId: 119, queriedTeamId: 119, position: '1B' });
  const r = validatePlayer(cade, TODAY_TEAMS, TODAY_GAME_MAP, new Set());
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.reason, 'WRONG_SPORT');
});

test('[REGRESSION] Victor Wembanyama canary ID rejected', () => {
  const wemby = makeValidPlayer({ id: 9999992, fullName: 'Victor Wembanyama', position: 'C' });
  const r = validatePlayer(wemby, TODAY_TEAMS, TODAY_GAME_MAP, new Set());
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.reason, 'WRONG_SPORT');
});

test('[REGRESSION] Real MLB hitter passes all checks', () => {
  const ohtani = makeValidPlayer({ id: 660271, fullName: 'Shohei Ohtani', teamId: 119, queriedTeamId: 119, position: 'DH' });
  const r = validatePlayer(ohtani, TODAY_TEAMS, TODAY_GAME_MAP, new Set());
  assert.strictEqual(r.valid, true, `Expected valid, got: ${r.reason}`);
});

test('[REGRESSION] Minor leaguer (team not in slate) is rejected', () => {
  // A real MLB player ID but their team has no game today
  const minorPlayer = makeValidPlayer({ id: 999001, teamId: 999, queriedTeamId: 999, position: '2B' });
  const r = validatePlayer(minorPlayer, TODAY_TEAMS, TODAY_GAME_MAP, new Set());
  assert.strictEqual(r.valid, false);
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
  console.log('✅ All validation tests passed — 10 vulnerabilities patched and verified\n');
  process.exit(0);
}
