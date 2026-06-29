// Fetches real MLB O/U totals from The Odds API (the-odds-api.com).
// Requires ODDS_API_KEY in .env.local — free tier: 500 requests/month.
// Results are cached in-process for 15 minutes to conserve quota.

const ODDS_API_KEY = process.env.ODDS_API_KEY ?? '';
const CACHE_TTL_MS = 15 * 60 * 1000;

let cache: Map<string, number> | null = null;
let cacheTs = 0;

interface OddsAPIEvent {
  home_team: string;
  away_team: string;
  bookmakers: Array<{
    key: string;
    markets: Array<{
      key: string;
      outcomes: Array<{ name: string; point: number }>;
    }>;
  }>;
}

// Strip non-alpha and lowercase — lets "Los Angeles Dodgers" match "Dodgers"
function norm(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, '');
}

// True if the normalized API name contains the normalized MLB name (or vice versa)
function nameMatch(apiName: string, mlbName: string): boolean {
  const a = norm(apiName);
  const b = norm(mlbName);
  return a === b || a.includes(b) || b.includes(a);
}

// Fetches and caches O/U lines keyed by "awayApiName|homeApiName".
// Returns a lookup function so callers never touch the raw map.
export async function fetchMLBOdds(): Promise<(awayName: string, homeName: string) => number | null> {
  if (!ODDS_API_KEY) return () => null;

  const now = Date.now();
  if (cache && now - cacheTs < CACHE_TTL_MS) return makeLookup(cache);

  try {
    const url =
      `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/` +
      `?apiKey=${ODDS_API_KEY}&regions=us&markets=totals&oddsFormat=american` +
      `&bookmakers=draftkings,fanduel,betmgm`;

    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return () => null;

    const events: OddsAPIEvent[] = await res.json();
    const map = new Map<string, number>();

    for (const event of events) {
      for (const book of event.bookmakers) {
        const market = book.markets.find(m => m.key === 'totals');
        if (!market) continue;
        const over = market.outcomes.find(o => o.name === 'Over');
        if (!over) continue;
        map.set(`${norm(event.away_team)}|${norm(event.home_team)}`, over.point);
        break;
      }
    }

    cache  = map;
    cacheTs = now;
    return makeLookup(map);
  } catch {
    return () => null;
  }
}

function makeLookup(map: Map<string, number>) {
  return (awayName: string, homeName: string): number | null => {
    // Exact normalized key first
    const key = `${norm(awayName)}|${norm(homeName)}`;
    if (map.has(key)) return map.get(key)!;

    // Fuzzy fallback — scan entries for a team-name substring match
    for (const [k, line] of map) {
      const [a, h] = k.split('|');
      if (nameMatch(a, awayName) && nameMatch(h, homeName)) return line;
    }
    return null;
  };
}
