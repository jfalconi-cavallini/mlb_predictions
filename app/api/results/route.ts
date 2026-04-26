// GET /api/results?date=YYYY-MM-DD
// Returns per-player batting stats for the given date.
// Used by the frontend to show green/red result indicators on past-day picks.

import { NextRequest, NextResponse } from 'next/server';
import { fetchTodaysGames, fetchGameBoxscore } from '../../../lib/mlbApi';
import { GameResultsAPIResponse, PlayerGameResult } from '../../../types';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const date = req.nextUrl.searchParams.get('date') ?? '';
  if (!date || !DATE_RE.test(date)) {
    return NextResponse.json({ error: 'Invalid or missing date' }, { status: 400 });
  }

  const season = date.slice(0, 4);
  const { games } = await fetchTodaysGames(date, season);

  if (games.length === 0) {
    return NextResponse.json({ date, hrHitterIds: [], playerStats: {}, gamesChecked: 0 } satisfies GameResultsAPIResponse);
  }

  const results = await Promise.all(games.map(g => fetchGameBoxscore(g.gamePk)));
  const hrHitterIds = [...new Set(results.flatMap(r => r.hrHitters))];

  const playerStats: Record<string, PlayerGameResult> = {};
  for (const r of results) {
    for (const [idStr, stats] of Object.entries(r.playerStats)) {
      const existing = playerStats[idStr];
      if (existing) {
        existing.hits += stats.hits;
        existing.atBats += stats.atBats;
        existing.runs += stats.runs;
        existing.rbi += stats.rbi;
        existing.homeRuns += stats.homeRuns;
        existing.totalBases += stats.totalBases;
      } else {
        playerStats[idStr] = { ...stats };
      }
    }
  }

  return NextResponse.json({ date, hrHitterIds, playerStats, gamesChecked: games.length } satisfies GameResultsAPIResponse);
}
