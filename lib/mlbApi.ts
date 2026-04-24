// ─── MLB STATS API CLIENT ─────────────────────────────────────────────────────
// All fetches use cache: 'no-store' to prevent stale data (VULN-03 fix).
// VULN-01 fix: roster entries with null/missing status are rejected.
// VULN-07 fix: position abbreviations are uppercased at the source here.

import {
  MLBGame, MLBTeam, MLBPitcher,
  PitcherSeasonStats, PitcherRecentStats,
  HitterSeasonStats, HitterRecentStats,
  Hand,
} from '../types';

const BASE = 'https://statsapi.mlb.com/api/v1';

// ─── SHARED FETCH HELPER ──────────────────────────────────────────────────────

async function mlbFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' }); // VULN-03: no stale cache
  if (!res.ok) throw new Error(`MLB API ${res.status}: ${url}`);
  return res.json() as Promise<T>;
}

// ─── ROSTER ───────────────────────────────────────────────────────────────────

export interface RosterHitter {
  id: number;
  fullName: string;
  position: string;      // uppercase abbreviation (e.g. "1B", "CF", "DH")
  queriedTeamId: number; // the teamId we queried — used for VULN-05 cross-check
}

interface RosterAPIResponse {
  roster: Array<{
    person: { id: number; fullName: string };
    position: { abbreviation: string };
    status: { code: string } | null | undefined;
  }>;
}

export async function fetchActiveRoster(
  teamId: number,
): Promise<{ hitters: RosterHitter[]; warnings: string[] }> {
  const warnings: string[] = [];
  const hitters: RosterHitter[] = [];

  let data: RosterAPIResponse;
  try {
    const season = new Date().getFullYear();
    data = await mlbFetch<RosterAPIResponse>(
      `${BASE}/teams/${teamId}/roster/Active?season=${season}`,
    );
  } catch (err) {
    warnings.push(`Roster fetch failed for team ${teamId}: ${(err as Error).message}`);
    return { hitters, warnings };
  }

  for (const entry of data.roster ?? []) {
    // VULN-01 FIX: explicit active check — null/undefined/missing status → reject
    const statusCode = entry.status?.code ?? null;
    if (statusCode === null || statusCode !== 'A') continue;

    const id = entry.person?.id;
    const fullName = entry.person?.fullName ?? '';
    // VULN-07 FIX: uppercase at the source so position checks are case-insensitive
    const position = (entry.position?.abbreviation ?? '').toUpperCase().trim();

    if (!id || !Number.isInteger(id) || id <= 0) continue;

    hitters.push({ id, fullName, position, queriedTeamId: teamId });
  }

  return { hitters, warnings };
}

// ─── HITTER SEASON STATS ──────────────────────────────────────────────────────

interface StatsAPIResponse {
  stats: Array<{
    splits: Array<{
      stat: Record<string, string | number>;
    }>;
  }>;
}

export async function fetchHitterSeasonStats(
  playerId: number,
  season: string,
): Promise<HitterSeasonStats | null> {
  try {
    const data = await mlbFetch<StatsAPIResponse>(
      `${BASE}/people/${playerId}/stats?stats=season&group=hitting&season=${season}`,
    );

    const split = data.stats?.[0]?.splits?.[0]?.stat;
    if (!split) return null;

    const pa = Number(split.plateAppearances) || 0;
    const hr = Number(split.homeRuns) || 0;
    const k  = Number(split.strikeOuts) || 0;
    const bb = Number(split.baseOnBalls) || 0;
    const avg = parseFloat(String(split.avg)) || 0;
    const obp = parseFloat(String(split.obp)) || 0;
    const slg = parseFloat(String(split.slg)) || 0;
    const ops = parseFloat(String(split.ops)) || 0;

    if (pa < 10) return null; // too few PA for meaningful stats

    return {
      avg,
      obp,
      slg,
      ops,
      iso: Math.max(0, slg - avg),
      woba: null,        // not in standard Stats API — Statcast only
      xwoba: null,
      barrelPct: null,
      hardHitPct: null,
      avgExitVelo: null,
      kPct: pa > 0 ? k / pa : 0,
      bbPct: pa > 0 ? bb / pa : 0,
      hrRate: pa > 0 ? hr / pa : 0,
      paCount: pa,
    };
  } catch {
    return null;
  }
}

// ─── HITTER RECENT STATS ──────────────────────────────────────────────────────

export async function fetchHitterRecentStats(
  playerId: number,
  season: string,
  days: number,
): Promise<HitterRecentStats | null> {
  try {
    const data = await mlbFetch<StatsAPIResponse>(
      `${BASE}/people/${playerId}/stats?stats=lastXDays&group=hitting&season=${season}&lastXDays=${days}`,
    );

    const split = data.stats?.[0]?.splits?.[0]?.stat;
    if (!split) return null;

    const pa  = Number(split.plateAppearances) || 0;
    const hr  = Number(split.homeRuns) || 0;
    const avg = parseFloat(String(split.avg)) || 0;
    const obp = parseFloat(String(split.obp)) || 0;
    const slg = parseFloat(String(split.slg)) || 0;

    if (pa < 5) return null;

    return {
      windowDays: days,
      avg,
      obp,
      slg,
      hrCount: hr,
      paCount: pa,
      hardHitPct: null,
      avgExitVelo: null,
    };
  } catch {
    return null;
  }
}

// ─── PLAYER HANDEDNESS ────────────────────────────────────────────────────────

interface PeopleAPIResponse {
  people: Array<{
    id: number;
    batSide?: { code: string };
    pitchHand?: { code: string };
  }>;
}

export async function fetchHitterHand(playerId: number): Promise<Hand> {
  try {
    const data = await mlbFetch<PeopleAPIResponse>(`${BASE}/people/${playerId}`);
    const code = data.people?.[0]?.batSide?.code?.toUpperCase() ?? 'R';
    if (code === 'L' || code === 'S') return code;
    return 'R';
  } catch {
    return 'R'; // safe default
  }
}

export async function fetchPitcherHand(pitcherId: number): Promise<Hand> {
  try {
    const data = await mlbFetch<PeopleAPIResponse>(`${BASE}/people/${pitcherId}`);
    const code = data.people?.[0]?.pitchHand?.code?.toUpperCase() ?? 'R';
    if (code === 'L' || code === 'S') return code;
    return 'R';
  } catch {
    return 'R';
  }
}

// ─── PITCHER STATS ────────────────────────────────────────────────────────────

export async function fetchPitcherStats(
  pitcherId: number,
  season: string,
): Promise<{ seasonStats: PitcherSeasonStats | null; recentStats: PitcherRecentStats | null }> {
  try {
    const [seasonData, recentData, handData] = await Promise.all([
      mlbFetch<StatsAPIResponse>(
        `${BASE}/people/${pitcherId}/stats?stats=season&group=pitching&season=${season}`,
      ).catch(() => null),
      mlbFetch<StatsAPIResponse>(
        `${BASE}/people/${pitcherId}/stats?stats=lastXDays&group=pitching&season=${season}&lastXDays=14`,
      ).catch(() => null),
      mlbFetch<PeopleAPIResponse>(`${BASE}/people/${pitcherId}`).catch(() => null),
    ]);

    void handData; // used externally via fetchPitcherHand

    const ss = seasonData?.stats?.[0]?.splits?.[0]?.stat ?? null;
    const seasonStats: PitcherSeasonStats | null = ss ? {
      era: parseFloat(String(ss.era)) || 4.50,
      fip: null,
      xfip: null,
      whip: parseFloat(String(ss.whip)) || 1.30,
      hrPer9: parseFloat(String(ss.homeRunsPer9)) || 1.20,
      kPer9: parseFloat(String(ss.strikeoutsPer9Inn)) || 8.50,
      bbPer9: parseFloat(String(ss.walksPer9Inn)) || 3.00,
      hrFbRate: null,
      hardHitPctAllowed: null,
      barrelPctAllowed: null,
      innings: parseFloat(String(ss.inningsPitched)) || 0,
    } : null;

    const rs = recentData?.stats?.[0]?.splits?.[0]?.stat ?? null;
    const recentStats: PitcherRecentStats | null = rs ? {
      windowDays: 14,
      era: parseFloat(String(rs.era)) || 4.50,
      hrPer9: parseFloat(String(rs.homeRunsPer9)) || 1.20,
      whip: parseFloat(String(rs.whip)) || 1.30,
      innings: parseFloat(String(rs.inningsPitched)) || 0,
    } : null;

    return { seasonStats, recentStats };
  } catch {
    return { seasonStats: null, recentStats: null };
  }
}

// ─── TODAY'S SCHEDULE ─────────────────────────────────────────────────────────

interface ScheduleAPIRaw {
  dates: Array<{
    date: string;
    games: Array<{
      gamePk: number;
      gameDate: string;
      status: { detailedState: string };
      teams: {
        away: {
          team: { id: number; name: string; abbreviation?: string; franchiseName?: string };
          probablePitcher?: { id: number; fullName: string };
        };
        home: {
          team: { id: number; name: string; abbreviation?: string; franchiseName?: string };
          probablePitcher?: { id: number; fullName: string };
        };
      };
      venue: { id: number; name: string; city?: string; state?: string };
    }>;
  }>;
}

export async function fetchTodaysGames(
  date: string, // YYYY-MM-DD
  season: string,
): Promise<{ games: MLBGame[]; warnings: string[] }> {
  const warnings: string[] = [];
  const games: MLBGame[] = [];

  let raw: ScheduleAPIRaw;
  try {
    raw = await mlbFetch<ScheduleAPIRaw>(
      `${BASE}/schedule?sportId=1&date=${date}&hydrate=probablePitcher,team,venue`,
    );
  } catch (err) {
    warnings.push(`Schedule fetch failed: ${(err as Error).message}`);
    return { games, warnings };
  }

  const dateEntry = raw.dates?.[0];
  if (!dateEntry || !dateEntry.games?.length) {
    warnings.push(`No games found for ${date}`);
    return { games, warnings };
  }

  // Batch-fetch pitcher stats for all probable pitchers in parallel
  const pitcherIds = new Set<number>();
  for (const g of dateEntry.games) {
    if (g.teams.away.probablePitcher?.id) pitcherIds.add(g.teams.away.probablePitcher.id);
    if (g.teams.home.probablePitcher?.id) pitcherIds.add(g.teams.home.probablePitcher.id);
  }

  const pitcherCache = new Map<number, MLBPitcher>();
  await Promise.all(
    [...pitcherIds].map(async (pid) => {
      const [stats, hand] = await Promise.all([
        fetchPitcherStats(pid, season),
        fetchPitcherHand(pid),
      ]);
      pitcherCache.set(pid, {
        id: pid,
        fullName: '', // filled below per-game
        throwHand: hand,
        seasonStats: stats.seasonStats,
        recentStats: stats.recentStats,
      });
    }),
  );

  for (const g of dateEntry.games) {
    const status = g.status?.detailedState ?? 'Unknown';

    const buildTeam = (t: { id: number; name: string; abbreviation?: string; franchiseName?: string }): MLBTeam => ({
      id: t.id,
      name: t.name,
      abbreviation: t.abbreviation ?? '',
      franchiseName: t.franchiseName ?? t.name,
    });

    const buildPitcher = (
      prob: { id: number; fullName: string } | undefined,
    ): MLBPitcher | null => {
      if (!prob?.id) return null;
      const cached = pitcherCache.get(prob.id);
      if (!cached) return null;
      return { ...cached, fullName: prob.fullName };
    };

    // Parse game time from ISO gameDate string
    const gameTimeRaw = g.gameDate ? new Date(g.gameDate).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York',
    }) : 'TBD';

    games.push({
      gamePk: g.gamePk,
      gameDate: date,
      status,
      homeTeam: buildTeam(g.teams.home.team),
      awayTeam: buildTeam(g.teams.away.team),
      venue: {
        id: g.venue.id,
        name: g.venue.name,
        city: g.venue.city ?? '',
        state: g.venue.state ?? '',
      },
      gameTime: gameTimeRaw,
      gameDateTime: g.gameDate ?? '',
      probableHomePitcher: buildPitcher(g.teams.home.probablePitcher),
      probableAwayPitcher: buildPitcher(g.teams.away.probablePitcher),
    });
  }

  return { games, warnings };
}
