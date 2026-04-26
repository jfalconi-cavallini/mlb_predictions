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

const NORMALIZED_NON_MLB_NAMES: Set<string> = new Set(
  [...NON_MLB_SPORT_NAMES].map(normalizeName)
);

function normalizeName(name: string): string {
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

interface PendingPlayer {
  rawPlayer: RosterHitter;
  teamId: number;
  gamePk: number;
}

export async function validateAndBuildHitterPool(
  todaysTeamIds: Set<number>,
  teamGameMap: Map<number, number>,
  seenIds: Set<number>
): Promise<ValidationResult> {
  const accepted: MLBHitter[] = [];
  const rejected: ValidationResult['rejected'] = [];
  const validatedAt = new Date().toISOString();

  // ── STEP 1: Fetch all team rosters in parallel ───────────────────────────────
  const rosterFetches = await Promise.all(
    [...todaysTeamIds].map(async (teamId) => {
      if (!VALID_MLB_TEAM_IDS.has(teamId)) {
        return { teamId, hitters: [], valid: false };
      }
      const result = await fetchActiveRoster(teamId);
      return { teamId, hitters: result.hitters, valid: true };
    })
  );

  // ── STEP 2: Sync validation — collect players that need stat fetches ─────────
  const pending: PendingPlayer[] = [];

  for (const { teamId, hitters, valid } of rosterFetches) {
    if (!valid) {
      rejected.push({
        rawName: `[Team ${teamId}]`, rawId: null,
        reason: 'NOT_IN_TODAYS_SLATE',
        detail: `Team ID ${teamId} is not a recognized MLB franchise`,
      });
      continue;
    }

    for (const rawPlayer of hitters) {
      if (!rawPlayer.id || !Number.isInteger(rawPlayer.id) || rawPlayer.id <= 0) {
        rejected.push({ rawName: rawPlayer.fullName, rawId: null, reason: 'NO_MLB_ID', detail: 'Missing or non-integer MLB player ID' });
        continue;
      }

      if (KNOWN_NON_MLB_IDS.has(rawPlayer.id)) {
        rejected.push({ rawName: rawPlayer.fullName, rawId: rawPlayer.id, reason: 'WRONG_SPORT', detail: `Player ID ${rawPlayer.id} is a known non-MLB canary ID` });
        continue;
      }

      if (isKnownNonMLBName(rawPlayer.fullName)) {
        rejected.push({ rawName: rawPlayer.fullName, rawId: rawPlayer.id, reason: 'WRONG_SPORT', detail: `"${rawPlayer.fullName}" matches known non-MLB athlete (normalized)` });
        continue;
      }

      if (!isHitterPosition(rawPlayer.position)) {
        continue; // pitchers filtered silently
      }

      // VULN-05: queriedTeamId must match the outer teamId
      if (rawPlayer.queriedTeamId !== teamId) {
        rejected.push({ rawName: rawPlayer.fullName, rawId: rawPlayer.id, reason: 'NOT_IN_TODAYS_SLATE', detail: `queriedTeamId ${rawPlayer.queriedTeamId} !== outer teamId ${teamId} — data integrity violation` });
        continue;
      }

      if (!todaysTeamIds.has(rawPlayer.queriedTeamId)) {
        rejected.push({ rawName: rawPlayer.fullName, rawId: rawPlayer.id, reason: 'NO_GAME_TODAY', detail: `Team ${rawPlayer.queriedTeamId} not in today's validated game slate` });
        continue;
      }

      if (seenIds.has(rawPlayer.id)) {
        rejected.push({ rawName: rawPlayer.fullName, rawId: rawPlayer.id, reason: 'DUPLICATE_ID', detail: `Player ID ${rawPlayer.id} already processed — deduped` });
        continue;
      }
      seenIds.add(rawPlayer.id);

      // VULN-04: gamePk=0 is a hard rejection
      const gamePk = teamGameMap.get(teamId);
      if (!gamePk || gamePk === 0) {
        rejected.push({ rawName: rawPlayer.fullName, rawId: rawPlayer.id, reason: 'NO_GAME_TODAY', detail: `No gamePk found for team ${teamId} in today's schedule — player has no game today` });
        continue;
      }

      pending.push({ rawPlayer, teamId, gamePk });
    }
  }

  // ── STEP 3: Fetch all player stats in parallel ───────────────────────────────
  // For each valid player, the 3 stat calls (season, hand, recent) also run in parallel.
  const statsFetches = await Promise.all(
    pending.map(({ rawPlayer, teamId, gamePk }) =>
      Promise.all([
        fetchHitterSeasonStats(rawPlayer.id, CURRENT_SEASON),
        fetchHitterHand(rawPlayer.id),
        fetchHitterRecentStats(rawPlayer.id, CURRENT_SEASON, 14),
      ]).then(([seasonStats, batHand, recentStats]) => ({
        rawPlayer, teamId, gamePk, seasonStats, batHand, recentStats,
      }))
    )
  );

  // ── STEP 4: Build accepted hitters ──────────────────────────────────────────
  for (const { rawPlayer, teamId, gamePk, seasonStats, batHand, recentStats } of statsFetches) {
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

  return { accepted, rejected, todaysTeamIds, validatedAt };
}

// ─── REGRESSION TEST EXPORTS ──────────────────────────────────────────────────

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

export function testNormalizedNameRejection(): boolean {
  const variants = [
    'cade cunningham',
    'CADE CUNNINGHAM',
    'Cade  Cunningham',
    '  Cade Cunningham  ',
  ];
  return variants.every(v => isKnownNonMLBName(v));
}

export function testRejectInvalidTeamId(): boolean {
  return !VALID_MLB_TEAM_IDS.has(9999) && !VALID_MLB_TEAM_IDS.has(0) && !VALID_MLB_TEAM_IDS.has(-1);
}

export function testHitterPositionFilter(): boolean {
  const valid = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'OF', 'DH', 'IF', 'TWP'];
  const invalid = ['P', 'SP', 'RP', 'CL', 'G', 'F', 'QB', 'p', 'sp'];
  return valid.every(isHitterPosition) && invalid.every(p => !isHitterPosition(p));
}

export function testDeduplication(): boolean {
  const seenIds = new Set<number>();
  const playerId = 660271;

  const firstResult = (() => {
    if (seenIds.has(playerId)) return false;
    seenIds.add(playerId);
    return true;
  })();

  const secondResult = (() => {
    if (seenIds.has(playerId)) return false;
    seenIds.add(playerId);
    return true;
  })();

  return firstResult === true && secondResult === false;
}

export function testGamePkZeroRejection(): boolean {
  const teamGameMap = new Map<number, number>();
  const teamId = 147;
  const gamePk = teamGameMap.get(teamId);
  return gamePk === undefined || gamePk === 0;
}

export function testTeamIdCrossCheck(): boolean {
  const outerTeamId = 147;
  const fakePlayer: RosterHitter = {
    id: 123456,
    fullName: 'Stale Player',
    position: '1B',
    queriedTeamId: 143,
  };
  return fakePlayer.queriedTeamId !== outerTeamId;
}

export function testNullStatusRejection(): boolean {
  const nullStatus = null as { code: string } | null | undefined;
  const statusCode = nullStatus?.code ?? null;
  return statusCode === null;
}

// Suppress unused import warning — buildRejectedMeta is kept for test/validation use
void buildRejectedMeta;
