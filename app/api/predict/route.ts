// GET /api/predict?date=YYYY-MM-DD
// Full prediction pipeline:
//   1. Fetch today's schedule
//   2. Build todaysTeamIds + teamGameMap
//   3. Validate hitters against today's slate
//   4. Score each hitter via scoring/engine.ts
//   5. Return predictions sorted by HR probability (descending)

import { NextRequest, NextResponse } from 'next/server';
import { fetchTodaysGames } from '../../../lib/mlbApi';
import { validateAndBuildHitterPool } from '../../../lib/validation';
import { buildPrediction } from '../../../scoring/engine';
import { getParkFactors } from '../../../lib/parkFactors';
import {
  PredictionAPIResponse, HitterPrediction, MLBGame, MLBPitcher, DataSourceHealth,
} from '../../../types';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function getTodayET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const raw = req.nextUrl.searchParams.get('date') ?? '';
  let date = getTodayET();

  if (raw) {
    if (!DATE_RE.test(raw)) {
      return NextResponse.json({ error: `Invalid date format: ${raw}` }, { status: 400 });
    }
    date = raw;
  }

  const season = date.slice(0, 4);
  const warnings: string[] = [];
  const now = new Date().toISOString();

  // ── STEP 1: Fetch today's schedule ─────────────────────────────────────────
  const { games, warnings: schedWarn } = await fetchTodaysGames(date, season);
  warnings.push(...schedWarn);

  if (games.length === 0) {
    return NextResponse.json({
      date,
      validatedHitters: 0,
      rejectedHitters: 0,
      predictions: [],
      rejectionLog: [],
      sourceHealth: buildHealth('error', 'ok', 'ok', 'ok', 'unavailable', 'ok', now),
      generatedAt: now,
      warnings: [...warnings, 'No games scheduled for this date'],
    } satisfies PredictionAPIResponse);
  }

  // ── STEP 2: Build team → game maps ─────────────────────────────────────────
  const todaysTeamIds = new Set<number>();
  const teamGameMap = new Map<number, number>();     // teamId → gamePk
  const teamGameObjMap = new Map<number, MLBGame>(); // teamId → full MLBGame

  for (const game of games) {
    todaysTeamIds.add(game.homeTeam.id);
    todaysTeamIds.add(game.awayTeam.id);
    teamGameMap.set(game.homeTeam.id, game.gamePk);
    teamGameMap.set(game.awayTeam.id, game.gamePk);
    teamGameObjMap.set(game.homeTeam.id, game);
    teamGameObjMap.set(game.awayTeam.id, game);
  }

  // ── STEP 3: Validate hitters ─────────────────────────────────────────────
  const seenIds = new Set<number>();
  const validationResult = await validateAndBuildHitterPool(todaysTeamIds, teamGameMap, seenIds);
  warnings.push(...validationResult.rejected
    .filter(r => r.reason !== 'NOT_A_HITTER') // pitchers filtered silently
    .slice(0, 5) // don't flood warnings
    .map(r => `Rejected ${r.rawName}: ${r.reason}`));

  // ── STEP 4: Build predictions ─────────────────────────────────────────────
  const predictions: HitterPrediction[] = [];

  for (const hitter of validationResult.accepted) {
    const game = teamGameObjMap.get(hitter.team.id);
    if (!game) continue;

    // Determine which pitcher this hitter faces
    const isHome = game.homeTeam.id === hitter.team.id;
    const opposingPitcher: MLBPitcher | null = isHome
      ? game.probableAwayPitcher
      : game.probableHomePitcher;

    // Enrich hitter team fields from game data
    const teamRef = isHome ? game.homeTeam : game.awayTeam;
    hitter.team.name = teamRef.name;
    hitter.team.abbreviation = teamRef.abbreviation;
    hitter.team.franchiseName = teamRef.franchiseName;

    const parkFactors = getParkFactors(game.venue.id, game.venue.name);

    // Weather is not fetched in this version — engine handles null gracefully
    const prediction = buildPrediction(hitter, game, opposingPitcher, parkFactors, null);
    predictions.push(prediction);
  }

  // ── STEP 5: Sort by HR probability (descending) ────────────────────────────
  predictions.sort((a, b) => b.probabilities.hr - a.probabilities.hr);

  const health = buildHealth(
    games.length > 0 ? 'ok' : 'error',
    validationResult.accepted.length > 0 ? 'ok' : 'error',
    'ok',
    validationResult.accepted.some(h => h.seasonStats) ? 'ok' : 'stale',
    'unavailable',
    'ok',
    now,
  );

  const body: PredictionAPIResponse = {
    date,
    validatedHitters: validationResult.accepted.length,
    rejectedHitters: validationResult.rejected.length,
    predictions,
    rejectionLog: validationResult.rejected.map(r => ({ name: r.rawName, reason: r.reason })),
    sourceHealth: health,
    generatedAt: now,
    warnings,
  };

  return NextResponse.json(body);
}

function buildHealth(
  schedule: DataSourceHealth['schedule'],
  rosterData: DataSourceHealth['rosterData'],
  pitcherStats: DataSourceHealth['pitcherStats'],
  hitterStats: DataSourceHealth['hitterStats'],
  weather: DataSourceHealth['weather'],
  parkFactors: DataSourceHealth['parkFactors'],
  ts: string,
): DataSourceHealth {
  return {
    schedule,
    rosterData,
    pitcherStats,
    hitterStats,
    weather,
    parkFactors,
    lastUpdated: { all: ts },
  };
}
