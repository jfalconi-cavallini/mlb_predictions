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
import { buildPrediction, PROP_CONFIDENCE_THRESHOLDS } from '../../../scoring/engine';
import { loadHrSlateContext, HrSlateContext } from '../../../lib/hrContext';
import { HomeRunInput, LEAGUE_HR_PA_FALLBACK, homeRunProbability } from '../../../scoring/hrModel';
import {
  buildBoards, explainBoardPick, FULL_BOARD_OPTIONS, HrCandidate, pickKey, WEATHER_NEUTRAL_VENUE_IDS,
} from '../../../scoring/hrBoard';
import { CENTER_FIELD_BEARING, classifyWind, outComponentToward } from '../../../lib/wind';
import { getParkFactors } from '../../../lib/parkFactors';
import { fetchWeather } from '../../../lib/weather';
import { getCachedPredictions, savePredictions } from '../../../lib/cache';
import {
  PredictionAPIResponse, HitterPrediction, MLBGame, MLBPitcher, DataSourceHealth,
  WeatherConditions, Hand, HrBoardPayload, HrPickLog,
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

  // ── CACHE: Return locked predictions for past dates ─────────────────────────
  const today = getTodayET();
  if (date < today) {
    const cached = getCachedPredictions(date);
    // Boards shipped after the first cache. An old file has no hrBoard and
    // would freeze the HR tab on the previous ranker.
    if (cached && cached.hrBoard) return NextResponse.json(cached);
  }

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
      sourceHealth: buildHealth('error', 'ok', 'ok', 'ok', 'error', 'ok', now),
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

  // ── STEP 3: Validate hitters, and load point-in-time HR context in parallel
  const seenIds = new Set<number>();
  const [validationResult, hrLoaded] = await Promise.all([
    validateAndBuildHitterPool(todaysTeamIds, teamGameMap, seenIds, date),
    loadHrSlateContext(date),
  ]);
  const hrCtx = hrLoaded.ctx;
  warnings.push(...hrLoaded.warnings);
  warnings.push(...validationResult.rejected
    .filter(r => r.reason !== 'NOT_A_HITTER') // pitchers filtered silently
    .slice(0, 5) // don't flood warnings
    .map(r => `Rejected ${r.rawName}: ${r.reason}`));

  // ── STEP 4a: Fetch weather for every unique game in parallel ─────────────
  const uniqueGames = [...new Map([...teamGameObjMap.values()].map(g => [g.gamePk, g])).values()];
  const weatherResults = await Promise.all(
    uniqueGames.map(g => fetchWeather(g.gamePk, g.venue.id, g.gameDateTime)),
  );
  const weatherMap = new Map<number, WeatherConditions | null>();
  uniqueGames.forEach((g, i) => weatherMap.set(g.gamePk, weatherResults[i]));

  // ── STEP 4b: Build predictions ────────────────────────────────────────────
  const predictions: HitterPrediction[] = [];
  const boardCandidates: HrCandidate[] = [];

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
    const weather = weatherMap.get(game.gamePk) ?? null;

    const lineupIds = isHome ? game.homeLineupIds : game.awayLineupIds;
    const lineupKnown = lineupIds.length >= 8;
    const lineupIdx = lineupIds.indexOf(hitter.id);
    if (lineupKnown && lineupIdx >= 0) {
      hitter.validationMeta.lineupStatus = 'CONFIRMED';
    }
    const counted = hrCtx.hitting.get(hitter.id);
    const seasonPa = counted?.pa ?? hitter.seasonStats?.paCount ?? 0;
    const seasonHr = counted
      ? counted.hr
      : (hitter.seasonStats ? hitter.seasonStats.hrRate * hitter.seasonStats.paCount : 0);
    const hrInput: HomeRunInput = {
      hr: seasonHr,
      pa: seasonPa,
      leagueHrPa: hrCtx.leagueHrPa || LEAGUE_HR_PA_FALLBACK,
      parkFactor: hrCtx.parkByHomeTeam.get(game.homeTeam.id) ?? 1,
      teamGames: hrCtx.teamGames.get(hitter.team.id) ?? 0,
      lineupKnown,
      lineupSpot: lineupKnown ? (lineupIdx >= 0 ? lineupIdx + 1 : 0) : null,
    };

    const prediction = buildPrediction(hitter, game, opposingPitcher, parkFactors, weather, hrInput);
    predictions.push(prediction);
    boardCandidates.push(toBoardCandidate(hitter, game, opposingPitcher, weather, hrCtx, hrInput));
  }

  const built = buildBoards(boardCandidates, FULL_BOARD_OPTIONS, hrCtx.endDate);
  const published = new Map<string, HrPickLog>();
  for (const pick of [...built.spot, ...built.full]) {
    const key = pickKey(pick.playerId, pick.gamePk);
    if (!published.has(key)) published.set(key, pick);
  }
  for (const pred of predictions) {
    const pick = published.get(pickKey(pred.hitter.id, pred.game.gamePk));
    if (!pick) continue;
    pred.probabilities.hr = pick.probability;
    const hrExpl = pred.explanations.find(e => e.prop === 'hr');
    if (hrExpl) {
      hrExpl.probability = pick.probability;
      hrExpl.confidence = hrTier(pick.probability);
      hrExpl.keyDrivers = explainBoardPick(pick).slice(0, 4);
      hrExpl.featureContributions = {
        env: pick.envMultiplier,
        weather: pick.weatherMultiplier,
        stadiumHr: pick.stadiumHr ?? 1,
        pitcherVuln: pick.pitcherVuln ?? 1,
        order: pick.order ?? 0,
      };
    }
  }

  const contactSource = boardContactSource([...published.values()]);
  const hrBoard: HrBoardPayload = {
    asOfDate: hrCtx.endDate,
    contactSource,
    spotKeys: built.spot.map(p => pickKey(p.playerId, p.gamePk)),
    fullKeys: built.full.map(p => pickKey(p.playerId, p.gamePk)),
    picks: [...published.values()],
  };
  warnings.push(
    contactSource === 'proxy'
      ? `HR board stats through ${hrCtx.endDate}. Barrel% and xISO are null; contact is an ISO proxy until an as-of Statcast feed is wired.`
      : `HR board stats through ${hrCtx.endDate}. Contact source: ${contactSource}.`,
  );

  // Hit / run / RBI keep their own sort. The HR tab reads hrBoard order.
  predictions.sort((a, b) => b.probabilities.hr - a.probabilities.hr);

  const health = buildHealth(
    games.length > 0 ? 'ok' : 'error',
    validationResult.accepted.length > 0 ? 'ok' : 'error',
    'ok',
    validationResult.accepted.some(h => h.seasonStats) ? 'ok' : 'stale',
    weatherResults.some(w => w?.dataSource === 'forecast') ? 'ok' : 'unavailable',
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
    hrBoard,
  };

  // Save to cache so past-day views always return the same picks
  savePredictions(date, body as unknown as Record<string, unknown>);

  return NextResponse.json(body);
}

function hrTier(prob: number): 'ELITE' | 'STRONG' | 'VALUE' | 'LOW' {
  const [elite, strong, value] = PROP_CONFIDENCE_THRESHOLDS.hr;
  if (prob >= elite) return 'ELITE';
  if (prob >= strong) return 'STRONG';
  if (prob >= value) return 'VALUE';
  return 'LOW';
}

function boardContactSource(picks: HrPickLog[]): HrBoardPayload['contactSource'] {
  const sources = new Set(picks.map(p => p.contactSource));
  if (sources.size === 0) return 'proxy';
  if (sources.size > 1) return 'mixed';
  return sources.has('statcast') ? 'statcast' : 'proxy';
}

function pullOffset(bat: Hand, pitcher: Hand | null): number {
  const stand = bat === 'S' ? (pitcher === 'L' ? 'R' : 'L') : bat;
  return stand === 'R' ? -45 : 45;
}

function isoFromLine(line: { ab: number; doubles: number; triples: number; hr: number } | undefined): number | null {
  if (!line || line.ab < 40) return null;
  return (line.doubles + 2 * line.triples + 3 * line.hr) / line.ab;
}

function toBoardCandidate(
  hitter: { id: number; batHand: Hand; team: { id: number }; seasonStats: { iso: number; paCount: number; hrRate: number } | null },
  game: MLBGame,
  opposingPitcher: MLBPitcher | null,
  weather: WeatherConditions | null,
  hrCtx: HrSlateContext,
  hrInput: HomeRunInput,
): HrCandidate {
  const counted = hrCtx.hitting.get(hitter.id);
  const l14 = hrCtx.l14.get(hitter.id);
  const throwHand = opposingPitcher?.throwHand ?? null;
  const split = throwHand === 'L' ? hrCtx.vsL.get(hitter.id) : throwHand === 'R' ? hrCtx.vsR.get(hitter.id) : undefined;
  const stand = hitter.batHand === 'S' ? (throwHand === 'L' ? 'R' : 'L') : hitter.batHand;
  const pit = opposingPitcher ? hrCtx.pitching.get(opposingPitcher.id) : undefined;
  const pitHand = opposingPitcher
    ? (stand === 'L' ? hrCtx.pitchingVsL.get(opposingPitcher.id) : hrCtx.pitchingVsR.get(opposingPitcher.id))
    : undefined;
  const neutral = WEATHER_NEUTRAL_VENUE_IDS.has(game.venue.id) || !!weather?.isIndoor;
  const cfBearing = CENTER_FIELD_BEARING[game.venue.id];
  const from = weather?.windDirectionDeg ?? 0;
  const mph = weather?.windSpeedMph ?? 0;
  const cfOut = !weather || neutral ? 0 : classifyWind(game.venue.id, from, mph, false).outComponent;
  const pullOut = !weather || neutral || cfBearing == null
    ? 0
    : outComponentToward(from, mph, false, cfBearing + pullOffset(hitter.batHand, throwHand));
  const gamesPlayed = hrCtx.teamGames.get(hitter.team.id) ?? 0;
  const seasonPa = counted?.pa ?? hitter.seasonStats?.paCount ?? 0;
  return {
    playerId: hitter.id,
    gamePk: game.gamePk,
    teamId: hitter.team.id,
    batHand: hitter.batHand,
    lineupSpot: hrInput.lineupSpot,
    lineupKnown: hrInput.lineupKnown,
    seasonPaPerGame: gamesPlayed > 0 ? seasonPa / gamesPlayed : null,
    seasonHr: hrInput.hr,
    seasonPa,
    iso: isoFromLine(counted) ?? (hitter.seasonStats ? hitter.seasonStats.iso : null),
    vsHandHr: split?.hr ?? null,
    vsHandPa: split?.pa ?? null,
    l14Hr: l14?.hr ?? 0,
    l14Pa: l14?.pa ?? 0,
    l30Pa: hrCtx.l30Pa.get(hitter.id) ?? 0,
    contactSeason: null,
    contactL14: null,
    xIso: null,
    pitcherKnown: opposingPitcher != null,
    pitcherHand: throwHand,
    pitcherHr: pit?.hr ?? 0,
    pitcherBf: pit?.bf ?? 0,
    pitcherVsHandHr: pitHand?.hr ?? null,
    pitcherVsHandBf: pitHand?.pa ?? null,
    pitcherAirOuts: pit ? pit.airOuts : null,
    pitcherGroundOuts: pit ? pit.groundOuts : null,
    pitcherHard: null,
    pitcherBbe: null,
    stadiumHr: hrCtx.stadiumByHomeTeam.get(game.homeTeam.id) ?? null,
    weather: {
      tempF: weather && !neutral ? weather.tempF : null,
      windMph: weather && !neutral ? weather.windSpeedMph : null,
      cfOut,
      pullOut,
      indoorOrRoof: neutral,
      missing: !neutral && !weather,
    },
    leagueHrPa: hrCtx.leagueHrPa || LEAGUE_HR_PA_FALLBACK,
    leagueIso: hrCtx.leagueIso,
    baselineProbability: homeRunProbability(hrInput),
  };
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
