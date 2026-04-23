// GET /api/schedule?date=YYYY-MM-DD
// Returns today's MLB schedule from statsapi.mlb.com.

import { NextRequest, NextResponse } from 'next/server';
import { fetchTodaysGames } from '../../../lib/mlbApi';
import { ScheduleAPIResponse } from '../../../types';

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

  try {
    const { games, warnings } = await fetchTodaysGames(date, season);
    const body: ScheduleAPIResponse = {
      date,
      games,
      totalGames: games.length,
      fetchedAt: new Date().toISOString(),
      sourceHealth: warnings.length === 0 ? 'ok' : games.length > 0 ? 'partial' : 'error',
      warnings,
    };
    return NextResponse.json(body);
  } catch (err) {
    return NextResponse.json(
      { error: 'Schedule fetch failed', detail: (err as Error).message },
      { status: 502 },
    );
  }
}
