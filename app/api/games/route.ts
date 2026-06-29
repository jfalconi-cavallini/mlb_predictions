// GET /api/games?date=YYYY-MM-DD
// Returns game-level win probability and spread lean predictions.

import { NextRequest, NextResponse } from 'next/server';
import { fetchTodaysGames } from '../../../lib/mlbApi';
import { getParkFactors } from '../../../lib/parkFactors';
import { fetchWeather } from '../../../lib/weather';
import { fetchMLBOdds } from '../../../lib/odds';
import { scoreGame } from '../../../scoring/gameEngine';
import { GamePredictionAPIResponse } from '../../../types';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function getTodayET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const raw = req.nextUrl.searchParams.get('date') ?? '';
  let date = getTodayET();

  if (raw) {
    if (!DATE_RE.test(raw)) {
      return NextResponse.json({ error: `Invalid date: ${raw}` }, { status: 400 });
    }
    date = raw;
  }

  const season = date.slice(0, 4);
  const { games, warnings } = await fetchTodaysGames(date, season);

  // Fetch weather and odds in parallel
  const [weatherResults, lookupOULine] = await Promise.all([
    Promise.all(games.map(game => fetchWeather(game.gamePk, game.venue.id, game.gameDateTime))),
    fetchMLBOdds(),
  ]);

  const gamePredictions = games.map((game, i) => {
    const parkFactors = getParkFactors(game.venue.id, game.venue.name);
    const ouLine      = lookupOULine(game.awayTeam.name, game.homeTeam.name);
    return scoreGame(game, parkFactors, weatherResults[i], ouLine);
  });

  // Sort: LOCK first, then HIGH, MEDIUM, LOW; within tier by most decisive win prob
  gamePredictions.sort((a, b) => {
    const confOrder: Record<string, number> = { LOCK: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    const confDiff = confOrder[a.confidence] - confOrder[b.confidence];
    if (confDiff !== 0) return confDiff;
    return Math.abs(b.homeWinProbability - 0.5) - Math.abs(a.homeWinProbability - 0.5);
  });

  return NextResponse.json({
    date,
    games: gamePredictions,
    generatedAt: new Date().toISOString(),
    warnings,
  } satisfies GamePredictionAPIResponse);
}
