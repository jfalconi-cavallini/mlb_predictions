// Point-in-time inputs for the HR model: season HR/PA through the day before
// the slate, team games played, and a 2026 home-vs-road park factor.
// One bulk stats call per split instead of a request per hitter.

import { empiricalParkFactor, LEAGUE_HR_PA_FALLBACK } from '../scoring/hrModel';

const BASE = 'https://statsapi.mlb.com/api/v1';

export interface HitterHrLine {
  hr: number;
  pa: number;
}

export interface HrSlateContext {
  /** YYYY-MM-DD, inclusive end of the stat window (day before the slate). */
  endDate: string;
  leagueHrPa: number;
  hitting: Map<number, HitterHrLine>;
  /** Keyed by the home team's id. Value is the raw (pre-sqrt) HR factor. */
  parkByHomeTeam: Map<number, number>;
  teamGames: Map<number, number>;
}

interface StatSplit {
  stat?: Record<string, string | number>;
  team?: { id?: number };
  player?: { id?: number };
  position?: { abbreviation?: string };
}

async function mlbJson(url: string): Promise<{ stats?: Array<{ splits?: StatSplit[]; totalSplits?: number }> } | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json() as { stats?: Array<{ splits?: StatSplit[]; totalSplits?: number }> };
  } catch {
    return null;
  }
}

function seasonStart(season: string): string {
  return `${season}-03-18`;
}

function dayBefore(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function fetchSplits(
  group: 'hitting' | 'pitching',
  season: string,
  start: string,
  end: string,
  sit?: string,
): Promise<StatSplit[]> {
  const sitQ = sit ? `&sitCodes=${sit}` : '';
  const url =
    `${BASE}/stats?stats=byDateRange&group=${group}&season=${season}&sportId=1` +
    `&playerPool=all&limit=8000&startDate=${start}&endDate=${end}${sitQ}`;
  const data = await mlbJson(url);
  return data?.stats?.[0]?.splits ?? [];
}

function addCounting(
  splits: StatSplit[],
  hrKey: string,
  paKey: string,
): Map<number, { hr: number; pa: number }> {
  const map = new Map<number, { hr: number; pa: number }>();
  for (const sp of splits) {
    const id = sp.player?.id;
    if (!id) continue;
    const cur = map.get(id) ?? { hr: 0, pa: 0 };
    cur.hr += num(sp.stat?.[hrKey]);
    cur.pa += num(sp.stat?.[paKey]);
    map.set(id, cur);
  }
  return map;
}

function teamEnv(splits: StatSplit[], hrKey: string, paKey: string): Map<number, { hr: number; pa: number }> {
  const map = new Map<number, { hr: number; pa: number }>();
  for (const sp of splits) {
    const id = sp.team?.id;
    if (!id) continue;
    const cur = map.get(id) ?? { hr: 0, pa: 0 };
    cur.hr += num(sp.stat?.[hrKey]);
    cur.pa += num(sp.stat?.[paKey]);
    map.set(id, cur);
  }
  return map;
}

export async function loadHrSlateContext(date: string): Promise<{ ctx: HrSlateContext; warnings: string[] }> {
  const season = date.slice(0, 4);
  const endDate = dayBefore(date);
  const start = seasonStart(season);
  const warnings: string[] = [];

  const empty: HrSlateContext = {
    endDate,
    leagueHrPa: LEAGUE_HR_PA_FALLBACK,
    hitting: new Map(),
    parkByHomeTeam: new Map(),
    teamGames: new Map(),
  };

  if (endDate < start) return { ctx: empty, warnings };

  const [hittingSplits, hitHome, hitAway, pitHome, pitAway, standings] = await Promise.all([
    fetchSplits('hitting', season, start, endDate),
    fetchSplits('hitting', season, start, endDate, 'h'),
    fetchSplits('hitting', season, start, endDate, 'a'),
    fetchSplits('pitching', season, start, endDate, 'h'),
    fetchSplits('pitching', season, start, endDate, 'a'),
    fetch(
      `${BASE}/standings?leagueId=103,104&season=${season}&date=${endDate}`,
      { cache: 'no-store' },
    ).then(async (res) => (res.ok ? res.json() as Promise<{
      records?: Array<{ teamRecords?: Array<{ team?: { id?: number }; gamesPlayed?: number }> }>;
    }> : null)).catch(() => null),
  ]);

  if (hittingSplits.length === 0) {
    warnings.push('HR context: season hitting stats unavailable — ranking falls back to per-player season lines');
  }

  const hitting = addCounting(hittingSplits, 'homeRuns', 'plateAppearances');

  // League HR/PA from hitters with a real sample. Position lives on the raw
  // split; skip rows tagged as pitchers so a few mop-up at-bats don't move it.
  const posByPlayer = new Map<number, string>();
  for (const sp of hittingSplits) {
    const id = sp.player?.id;
    const pos = (sp.position?.abbreviation ?? '').toUpperCase();
    if (!id || !pos) continue;
    if (pos !== 'P') posByPlayer.set(id, pos);
    else if (!posByPlayer.has(id)) posByPlayer.set(id, 'P');
  }
  let leagueHr = 0;
  let leaguePa = 0;
  for (const [id, line] of hitting) {
    if (posByPlayer.get(id) === 'P' || line.pa < 50) continue;
    leagueHr += line.hr;
    leaguePa += line.pa;
  }
  const leagueHrPa = leaguePa > 0 ? leagueHr / leaguePa : LEAGUE_HR_PA_FALLBACK;

  const hh = teamEnv(hitHome, 'homeRuns', 'plateAppearances');
  const ha = teamEnv(hitAway, 'homeRuns', 'plateAppearances');
  const ph = teamEnv(pitHome, 'homeRuns', 'battersFaced');
  const pa = teamEnv(pitAway, 'homeRuns', 'battersFaced');
  const parkByHomeTeam = new Map<number, number>();
  if (hh.size === 0 || ph.size === 0) {
    warnings.push('HR context: home/away splits unavailable — parks treated as neutral');
  }
  for (const tid of new Set([...hh.keys(), ...ha.keys(), ...ph.keys(), ...pa.keys()])) {
    const factor = empiricalParkFactor(
      (hh.get(tid)?.hr ?? 0) + (ph.get(tid)?.hr ?? 0),
      (hh.get(tid)?.pa ?? 0) + (ph.get(tid)?.pa ?? 0),
      (ha.get(tid)?.hr ?? 0) + (pa.get(tid)?.hr ?? 0),
      (ha.get(tid)?.pa ?? 0) + (pa.get(tid)?.pa ?? 0),
      leagueHrPa,
    );
    if (factor != null) parkByHomeTeam.set(tid, factor);
  }

  const teamGames = new Map<number, number>();
  for (const rec of standings?.records ?? []) {
    for (const tr of rec.teamRecords ?? []) {
      if (tr.team?.id) teamGames.set(tr.team.id, num(tr.gamesPlayed));
    }
  }
  if (teamGames.size === 0) {
    warnings.push('HR context: standings unavailable — pre-lineup playing time uses a neutral PA prior');
  }

  return {
    ctx: { endDate, leagueHrPa, hitting, parkByHomeTeam, teamGames },
    warnings,
  };
}
