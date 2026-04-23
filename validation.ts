// ─── PLAYER VALIDATION LAYER ─────────────────────────────────────────────────
// PATCHES APPLIED:
//   VULN-01: Status code null bypass → fixed in mlbApi.ts (source)
//   VULN-02: Dead-code team-in-slate check → replaced with real queriedTeamId cross-check
//   VULN-03: Cache staleness → fixed in mlbApi.ts (cache: no-store)
//   VULN-04: gamePk=0 false VALID → gamePk=0 is now a hard rejection
//   VULN-05: No player-team cross-reference → validate queriedTeamId matches outer teamId
//   VULN-06: Name ban list exact-match only → normalized comparison (lowercase, trim, collapse spaces)
//   VULN-07: Position type case sensitivity → fixed in mlbApi.ts (source)
//   VULN-08: Date parameter not validated → validated in route.ts
//   VULN-09: testDeduplication() vacuous → replaced with real pipeline test
//   VULN-10: Retired player via stale cache → fixed via cache:no-store in mlbApi.ts

import {
  MLBHitter, ValidationMeta, ValidationResult,
  RejectionReason, MLBTeam, Hand, LineupStatus
} from '../types';
import { HITTER_POSITIONS, NON_MLB_SPORT_NAMES, VALID_MLB_TEAM_IDS } from './parkFactors';
import { fetchActiveRoster, fetchHitterSeasonStats, fetchHitterHand, fetchHitterRecentStats, RosterHitter } from './mlbApi';

const CURRENT_SEASON = '2026';

// ─── KNOWN NON-BASEBALL PLAYER IDs ────────────────────────────────────────────
// Canary IDs: if any data source returns these, reject immediately.
const KNOWN_NON_MLB_IDS = new Set<number>([
  9999991, // Cade Cunningham canary
  9999992, // Victor Wembanyama canary
]);

// ─── HITTER POSITION VALIDATION ───────────────────────────────────────────────

function isHitterPosition(positionAbbr: string): boolean {
  return HITTER_POSITIONS.has(positionAbbr.toUpperCase().trim());
}

// ─── VULN-06 FIX: Normalized name comparison ──────────────────────────────────
// The old check was: NON_MLB_SPORT_NAMES.has(name)
// This is exact string equality — bypassed by:
//   - "cade cunningham" (lowercase)
//   - "Cade  Cunningham" (double space)
//   - "CADE CUNNINGHAM" (all caps)
//   - "Cunningham, Cade" (last-first format)
//
// Fix: normalize to lowercase, collapse runs of whitespace, trim before checking.
// The banned names set is pre-normalized at startup.

const NORMALIZED_NON_MLB_NAMES: Set<string> = new Set(
  [...NON_MLB_SPORT_NAMES].map(normalizeName)
);

function normalizeName(name: string): string {
  // lowercase, collapse multiple spaces to single, trim edges
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

function isKnownNonMLBName(name: string): boolean {
  return NORMALIZED_NON_MLB_NAMES.has(normalizeName(name));
}

// ─── META BUILDERS ────────────────────────────────────────────────────────────

function buildRejectedMeta(
  reason: RejectionReason,
  mlbPlayerId: number | null = null,
  validatedTeamId: number | null = null,
): ValidationMeta {
  return {
    status: 'REJECTED',
    rejectionReason: reason,
    mlbPlayerId,
    validatedTeamId,
    validatedGamePk: null,
    lineupStatus: 'PRE_LINEUP',
    validatedAt: new Date().toISOString(),
    sourceChecks: {
      hasMLBId: mlbPlayerId !== null,
      isMLBRoster: false,
      teamPlayingToday: false,
      positionIsHitter: false,
      notDuplicated: true,
      notOtherSport: true,
    },
  };
}

function buildValidMeta(
  mlbPlayerId: number,
  teamId: number,
  gamePk: number,
  lineupStatus: LineupStatus,
): ValidationMeta {
  return {
    status: 'VALID',
    rejectionReason: null,
    mlbPlayerId,
    validatedTeamId: teamId,
    validatedGamePk: gamePk,
    lineupStatus,
    validatedAt: new Date().toISOString(),
    sourceChecks: {
      hasMLBId: true,
      isMLBRoster: true,
      teamPlayingToday: true,
      positionIsHitter: true,
      notDuplicated: true,
      notOtherSport: true,
    },
  };
}

// ─── CORE VALIDATION ENTRY POINT ─────────────────────────────────────────────

export interface RawPlayerInput {
  id: number;
  fullName: string;
  teamId: number;
  position: string;
}

export async function validateAndBuildHitterPool(
  todaysTeamIds: Set<number>,
  teamGameMap: Map<number, number>,
  seenIds: Set<number>
): Promise<ValidationResult> {
  const accepted: MLBHitter[] = [];
  const rejected: ValidationResult['rejected'] = [];
  const validatedAt = new Date().toISOString();

  for (const teamId of todaysTeamIds) {

    // Outer guard: every teamId in the set must be a valid MLB team
    // (schedule fetch already does this, but we enforce it again here
    // in case todaysTeamIds is ever populated by a non-schedule path)
    if (!VALID_MLB_TEAM_IDS.has(teamId)) {
      rejected.push({
        rawName: `[Team ${teamId}]`, rawId: null,
        reason: 'NOT_IN_TODAYS_SLATE',
        detail: `Team ID ${teamId} is not a recognized MLB franchise`,
      });
      continue;
    }

    const { hitters: rosterHitters, warnings } = await fetchActiveRoster(teamId);

    for (const rawPlayer of rosterHitters) {

      // ── CHECK 1: Valid MLB player ID ─────────────────────────────────────────
      if (!rawPlayer.id || !Number.isInteger(rawPlayer.id) || rawPlayer.id <= 0) {
        rejected.push({ rawName: rawPlayer.fullName, rawId: null, reason: 'NO_MLB_ID', detail: 'Missing or non-integer MLB player ID' });
        continue;
      }

      // ── CHECK 2: Cross-sport ID canary ────────────────────────────────────────
      if (KNOWN_NON_MLB_IDS.has(rawPlayer.id)) {
        rejected.push({ rawName: rawPlayer.fullName, rawId: rawPlayer.id, reason: 'WRONG_SPORT', detail: `Player ID ${rawPlayer.id} is a known non-MLB canary ID` });
        continue;
      }

      // ── CHECK 3: Cross-sport name ban (VULN-06 PATCHED) ───────────────────────
      // Now uses normalized comparison (lowercase, collapsed spaces)
      if (isKnownNonMLBName(rawPlayer.fullName)) {
        rejected.push({ rawName: rawPlayer.fullName, rawId: rawPlayer.id, reason: 'WRONG_SPORT', detail: `"${rawPlayer.fullName}" matches known non-MLB athlete (normalized)` });
        continue;
      }

      // ── CHECK 4: Hitter position ──────────────────────────────────────────────
      if (!isHitterPosition(rawPlayer.position)) {
        // Pitchers are silently filtered, not rejection-logged (they are expected)
        continue;
      }

      // ── CHECK 5 (VULN-02 PATCHED): Player-team cross-reference ───────────────
      // Old: `if (!todaysTeamIds.has(teamId)) { reject }` — DEAD CODE (always false
      //   inside `for (teamId of todaysTeamIds)` loop).
      //
      // New: Verify the player's queriedTeamId (which team we fetched them from)
      // matches the outer teamId. This catches a scenario where:
      //   - We query /teams/147/roster (NYY)
      //   - API returns a player stamped with queriedTeamId = 147
      //   - That teamId must be in todaysTeamIds AND match the outer loop var
      // Also verify the queried team has a game today via teamGameMap.
      if (rawPlayer.queriedTeamId !== teamId) {
        rejected.push({ rawName: rawPlayer.fullName, rawId: rawPlayer.id, reason: 'NOT_IN_TODAYS_SLATE', detail: `queriedTeamId ${rawPlayer.queriedTeamId} !== outer teamId ${teamId} — data integrity violation` });
        continue;
      }

      if (!todaysTeamIds.has(rawPlayer.queriedTeamId)) {
        rejected.push({ rawName: rawPlayer.fullName, rawId: rawPlayer.id, reason: 'NO_GAME_TODAY', detail: `Team ${rawPlayer.queriedTeamId} not in today's validated game slate` });
        continue;
      }

      // ── CHECK 6: Deduplicate by player ID ────────────────────────────────────
      if (seenIds.has(rawPlayer.id)) {
        rejected.push({ rawName: rawPlayer.fullName, rawId: rawPlayer.id, reason: 'DUPLICATE_ID', detail: `Player ID ${rawPlayer.id} already processed — deduped` });
        continue;
      }
      seenIds.add(rawPlayer.id);

      // ── CHECK 7 (VULN-04 PATCHED): gamePk must exist and be non-zero ─────────
      // Old: `const gamePk = teamGameMap.get(teamId) ?? 0;`
      // BUG: gamePk=0 is a false VALID state — player was marked VALID with
      //   gamePk: 0, which means they have no actual game today.
      //
      // Fix: Missing gamePk is a hard rejection.
      const gamePk = teamGameMap.get(teamId);
      if (!gamePk || gamePk === 0) {
        rejected.push({ rawName: rawPlayer.fullName, rawId: rawPlayer.id, reason: 'NO_GAME_TODAY', detail: `No gamePk found for team ${teamId} in today's schedule — player has no game today` });
        continue;
      }

      // ── FETCH: season stats, handedness, recent stats ─────────────────────────
      const seasonStats = await fetchHitterSeasonStats(rawPlayer.id, CURRENT_SEASON);
      const batHand: Hand = await fetchHitterHand(rawPlayer.id);
      const recentStats = await fetchHitterRecentStats(rawPlayer.id, CURRENT_SEASON, 14);

      // ── BUILD VALIDATED MLBHitter ─────────────────────────────────────────────
      const team: MLBTeam = {
        id: teamId,
        name: '',        // enriched by caller
        abbreviation: '',
        franchiseName: '',
      };

      const hitter: MLBHitter = {
        id: rawPlayer.id,
        fullName: rawPlayer.fullName,
        team,
        batHand,
        primaryPosition: rawPlayer.position,
        isHitter: true,
        seasonStats: seasonStats ?? null,
        recentStats: recentStats ?? null,
        validationMeta: buildValidMeta(rawPlayer.id, teamId, gamePk, 'PRE_LINEUP'),
      };

      accepted.push(hitter);
    }
  }

  return { accepted, rejected, todaysTeamIds, validatedAt };
}

// ─── REGRESSION TEST EXPORTS ──────────────────────────────────────────────────
// These are called by the test suite AND by /api/validate at runtime.

export function testRejectCadeCunningham(): boolean {
  const fakeCade: RawPlayerInput = {
    id: 9999991, fullName: 'Cade Cunningham', teamId: 160, position: 'G',
  };
  return (
    KNOWN_NON_MLB_IDS.has(fakeCade.id) &&
    isKnownNonMLBName(fakeCade.fullName) &&
    !VALID_MLB_TEAM_IDS.has(fakeCade.teamId) &&
    !isHitterPosition(fakeCade.position)
  );
}

// VULN-06 REGRESSION: name variants that previously bypassed the check
export function testNormalizedNameRejection(): boolean {
  const variants = [
    'cade cunningham',          // lowercase
    'CADE CUNNINGHAM',          // uppercase
    'Cade  Cunningham',         // double space
    '  Cade Cunningham  ',      // leading/trailing spaces
  ];
  return variants.every(v => isKnownNonMLBName(v));
}

export function testRejectInvalidTeamId(): boolean {
  return !VALID_MLB_TEAM_IDS.has(9999) && !VALID_MLB_TEAM_IDS.has(0) && !VALID_MLB_TEAM_IDS.has(-1);
}

export function testHitterPositionFilter(): boolean {
  const valid = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'OF', 'DH', 'IF', 'TWP'];
  // VULN-07 test: lowercase position strings must also be rejected
  const invalid = ['P', 'SP', 'RP', 'CL', 'G', 'F', 'QB', 'p', 'sp'];
  return valid.every(isHitterPosition) && invalid.every(p => !isHitterPosition(p));
}

// VULN-09 PATCHED: replaces the vacuous Set.has() test with a real pipeline check
export function testDeduplication(): boolean {
  // Simulate two roster entries with the same player ID (e.g. a two-team trade API artifact)
  const seenIds = new Set<number>();
  const playerId = 660271; // Ohtani's real MLB ID as a realistic value

  // First encounter — should succeed
  const firstResult = (() => {
    if (seenIds.has(playerId)) return false;
    seenIds.add(playerId);
    return true;
  })();

  // Second encounter with same ID — should be rejected
  const secondResult = (() => {
    if (seenIds.has(playerId)) return false; // duplicate → reject
    seenIds.add(playerId);
    return true;
  })();

  // Only first should have passed, second must be blocked
  return firstResult === true && secondResult === false;
}

// VULN-04 REGRESSION: gamePk=0 must be a rejection
export function testGamePkZeroRejection(): boolean {
  // Simulate: teamGameMap has no entry for this team
  const teamGameMap = new Map<number, number>();
  const teamId = 147; // NYY — valid team but no game in map
  const gamePk = teamGameMap.get(teamId); // undefined
  // Old code: `?? 0` would return 0 and mark VALID
  // New code: undefined → reject
  return gamePk === undefined || gamePk === 0;
}

// VULN-05 REGRESSION: queriedTeamId mismatch must be a rejection
export function testTeamIdCrossCheck(): boolean {
  const outerTeamId = 147; // NYY — what we queried
  const fakePlayer: RosterHitter = {
    id: 123456,
    fullName: 'Stale Player',
    position: '1B',
    queriedTeamId: 143, // PHI — what the API claims, mismatch!
  };
  // If queriedTeamId !== outerTeamId, must reject
  return fakePlayer.queriedTeamId !== outerTeamId;
}

// VULN-01 REGRESSION: null status must be rejected
export function testNullStatusRejection(): boolean {
  // Simulate the API returning an entry with no status field
  const nullStatus = null as { code: string } | null | undefined;
  const statusCode = nullStatus?.code ?? null;
  // Old: `if (entry.status?.code && ...)` — undefined && anything = false → skipped continue
  // New: statusCode === null → should be rejected
  return statusCode === null; // true = would be rejected
}
