// Home-run Spot Board and Full Board.
//
// This replaces season-HR/PA × 3 as the HR tab ranker. The plate-appearance
// model in hrModel.ts stays available as the env-gate ablation baseline.
// None of the constants below were fit on Sep 8–22.
//
// Stage A drops names that fail a hard gate. The board shrinks; it does not
// backfill from a suppressed park. Stage B is a per-PA rate:
//
//   q = talent × pitcherVuln × (park × weather) × platoon × orderBoost × recent
//   P(at least one HR) = 1 - (1 - q) ^ expectedPA
//
// Talent is as-of Statcast (barrel% / hard-hit% / a barrel-implied rate,
// blended with the last 14 days) when a real sample exists. Season HR/PA is
// only the shrinkage prior. Until that feed is wired, talent is an ISO proxy
// and barrel / xISO stay null. Stage C fills Elite/Great games first.

export const HR_PA_PRIOR = 200;
export const LEAGUE_HR_PA_FALLBACK = 0.0306;
export const LEAGUE_ISO_FALLBACK = 0.155;
/** 2026 play-by-play through June 30: 2940 HR / 4783 barrels. */
export const HR_PER_BARREL_THROUGH_JUNE = 2940 / 4783;

export const ENV_BAN = 0.85;
export const STADIUM_BAN = 0.80;
export const WEATHER_POOR = 0.88;
export const ENV_GATE = 1.05;
export const STADIUM_GATE = 1.05;
export const WEATHER_GREAT = 1.08;
export const ELITE_ENV = 1.15;
export const MIN_SEASON_PA = 80;
export const MIN_L30_PA = 40;
export const MIN_BBE = 40;
export const BARREL_OUTLIER = 0.15;
export const BARREL_GATE = 0.08;
export const ORDER_OVERRIDE_BARREL = 0.10;
export const ORDER_OVERRIDE_ISO = 0.220;
export const PROJECTED_PA_PER_GAME = 3.2;
export const MAX_PER_TEAM = 4;
export const MAX_PER_GAME = 6;
export const ELITE_BATS_PER_GAME = 4;
export const FULL_BOARD_CAP = 20;
export const SPOT_BOARD_CAP = 12;
export const PITCHER_BF_PRIOR = 350;
export const PITCHER_THIN_BF = 80;
export const LEAGUE_FB_RATE = 0.42;
export const LEAGUE_HARD_HIT = 0.38;
export const HAND_SPLIT_PA_PRIOR = 80;
export const FLAT_PA = 4.2;

export const ORDER_PA: Record<number, number> = {
  1: 4.70,
  2: 4.62,
  3: 4.55,
  4: 4.40,
  5: 4.28,
  6: 4.12,
  7: 3.95,
  8: 3.84,
  9: 3.72,
};

/** Domes and retractable roofs. Outdoor wind is not the air the ball is in. */
export const WEATHER_NEUTRAL_VENUE_IDS = new Set<number>([12, 14, 2392, 5325]);

const WEATHER_TEMP_PER_F = 0.004;
const WEATHER_WIND_PER_MPH = 0.012;
const WEATHER_MIN = 0.82;
const WEATHER_MAX = 1.22;
const Q_MIN = 0.004;
const Q_MAX = 0.14;

export type BatHand = 'L' | 'R' | 'S';
export type WeatherLabel = 'Elite' | 'Great' | 'Average' | 'Poor' | 'Neutral' | 'Unknown';
export type EnvBucket = 'elite' | 'average' | 'banned';
export type ContactSource = 'statcast' | 'proxy';

export interface ContactCounts {
  pa: number;
  bbe: number;
  barrel: number;
  hard: number;
}

export interface ContactGameRow {
  date: string;
  playerId: number;
  pa: number;
  bbe: number;
  barrel: number;
  hard: number;
}

export interface WeatherInput {
  tempF: number | null;
  windMph: number | null;
  /** +1 out to CF, −1 in from CF. Already 0 when calm, indoor, or unknown. */
  cfOut: number;
  /** +1 out toward the hitter's pull field. */
  pullOut: number;
  indoorOrRoof: boolean;
  /** No temperature, and the park is not a roof. */
  missing: boolean;
}

export interface HrCandidate {
  playerId: number;
  gamePk: number;
  teamId: number;
  batHand: BatHand;
  /** 1–9 in the posted order, 0 when the lineup is posted and he is not in it, null when no lineup is posted. */
  lineupSpot: number | null;
  lineupKnown: boolean;
  seasonPaPerGame: number | null;
  seasonHr: number;
  seasonPa: number;
  iso: number | null;
  vsHandHr: number | null;
  vsHandPa: number | null;
  l14Hr: number;
  l14Pa: number;
  l30Pa: number;
  /** Null until an as-of Statcast feed is wired. An all-zero object is a real sample. */
  contactSeason: ContactCounts | null;
  contactL14: ContactCounts | null;
  /** Expected ISO. Stay null; do not invent it from barrels. */
  xIso: number | null;
  pitcherKnown: boolean;
  pitcherHand: BatHand | null;
  pitcherHr: number;
  pitcherBf: number;
  pitcherVsHandHr: number | null;
  pitcherVsHandBf: number | null;
  pitcherAirOuts: number | null;
  pitcherGroundOuts: number | null;
  pitcherHard: number | null;
  pitcherBbe: number | null;
  stadiumHr: number | null;
  weather: WeatherInput;
  leagueHrPa: number;
  leagueIso: number;
  /** Live plate-appearance model. Used only by the env-gate ablation. */
  baselineProbability: number;
}

export interface BoardOptions {
  restrictOrder: boolean;
  contactGate: boolean;
  orderBoost: boolean;
  stack: boolean;
  /** 'baseline' ranks with the plate-appearance model. 'model' uses scoreHrSpot. */
  rankBy: 'model' | 'baseline';
  /** Ignore batting-order PA so the Statcast ablation is not an order effect. */
  flatPa: boolean;
}

export const ENV_GATE_OPTIONS: BoardOptions = {
  restrictOrder: false,
  contactGate: false,
  orderBoost: false,
  stack: false,
  rankBy: 'baseline',
  flatPa: false,
};

export const STATCAST_OPTIONS: BoardOptions = {
  restrictOrder: false,
  contactGate: true,
  orderBoost: false,
  stack: false,
  rankBy: 'model',
  flatPa: true,
};

export const FULL_BOARD_OPTIONS: BoardOptions = {
  restrictOrder: true,
  contactGate: true,
  orderBoost: true,
  stack: true,
  rankBy: 'model',
  flatPa: false,
};

export interface ScoredHrPick {
  playerId: number;
  gamePk: number;
  teamId: number;
  probability: number;
  envMultiplier: number;
  stadiumHr: number | null;
  weatherMultiplier: number;
  weatherLabel: WeatherLabel;
  envBucket: EnvBucket;
  order: number | null;
  barrelPct: number | null;
  xIso: number | null;
  iso: number | null;
  contactSource: ContactSource;
  asOfDate: string;
  pitcherVuln: number | null;
  flags: string[];
  filterReason: string | null;
  passed: boolean;
}

export interface BuiltBoards {
  spot: ScoredHrPick[];
  full: ScoredHrPick[];
  /** Everyone who was scored, including failures. Tests use this. */
  all: ScoredHrPick[];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function pickKey(playerId: number, gamePk: number): string {
  return `${playerId}:${gamePk}`;
}

/**
 * A batted-ball row counts for a slate only when the game was already played.
 * `slateDate` is the morning of the game. Rows on that date or later are future.
 */
export function contactCountsForSlate(gameDate: string, slateDate: string): boolean {
  return gameDate < slateDate;
}

export function sumContact(
  rows: ContactGameRow[],
  playerId: number,
  startInclusive: string | null,
  endExclusive: string,
): ContactCounts {
  let pa = 0;
  let bbe = 0;
  let barrel = 0;
  let hard = 0;
  for (const row of rows) {
    if (row.playerId !== playerId) continue;
    if (startInclusive != null && row.date < startInclusive) continue;
    if (!contactCountsForSlate(row.date, endExclusive)) continue;
    pa += row.pa;
    bbe += row.bbe;
    barrel += row.barrel;
    hard += row.hard;
  }
  return { pa, bbe, barrel, hard };
}

/** Season-to-date contact for a slate. Includes yesterday. Excludes the slate date. */
export function asOfContact(rows: ContactGameRow[], playerId: number, slateDate: string): ContactCounts {
  return sumContact(rows, playerId, null, slateDate);
}

export function regressedHrPerPa(hr: number, pa: number, leagueHrPa: number): number {
  const league = leagueHrPa > 0 ? leagueHrPa : LEAGUE_HR_PA_FALLBACK;
  if (pa > 0) return (hr + league * HR_PA_PRIOR) / (pa + HR_PA_PRIOR);
  return league * 0.85;
}

/**
 * Shrunk home/away HR factor with a wide clamp so a real −20% park can be
 * banned. The plate-appearance model still square-root dampens its own copy.
 */
export function wideStadiumFactor(
  homeHr: number,
  homePa: number,
  awayHr: number,
  awayPa: number,
  leagueHrPa: number,
): number | null {
  if (homePa < 500 || awayPa < 500) return null;
  const league = leagueHrPa > 0 ? leagueHrPa : LEAGUE_HR_PA_FALLBACK;
  const prior = 2200;
  const shrunkHome = (homeHr + league * prior) / (homePa + prior);
  const shrunkAway = (awayHr + league * prior) / (awayPa + prior);
  if (shrunkAway <= 0) return null;
  return clamp(shrunkHome / shrunkAway, 0.70, 1.60);
}

export function weatherHrMultiplier(weather: WeatherInput): { mult: number; label: WeatherLabel } {
  if (weather.indoorOrRoof) return { mult: 1, label: 'Neutral' };
  if (weather.missing || weather.tempF == null || !Number.isFinite(weather.tempF)) {
    return { mult: 1, label: 'Unknown' };
  }
  const temp = 1 + (weather.tempF - 70) * WEATHER_TEMP_PER_F;
  const mph = weather.windMph != null && Number.isFinite(weather.windMph) ? Math.max(0, weather.windMph) : 0;
  const blended = 0.75 * (weather.cfOut || 0) + 0.25 * (weather.pullOut || 0);
  const wind = 1 + blended * mph * WEATHER_WIND_PER_MPH;
  const mult = clamp(temp * wind, WEATHER_MIN, WEATHER_MAX);
  let label: WeatherLabel = 'Average';
  if (mult >= 1.15) label = 'Elite';
  else if (mult >= WEATHER_GREAT) label = 'Great';
  else if (mult <= WEATHER_POOR) label = 'Poor';
  return { mult, label };
}

export function gameEnvironment(
  stadiumHr: number | null,
  weatherMult: number,
  weatherLabel: WeatherLabel,
): { env: number; banned: boolean; gate: boolean; bucket: EnvBucket } {
  const stadium = stadiumHr != null && stadiumHr > 0 ? stadiumHr : 1;
  const env = stadium * weatherMult;
  const banned = env <= ENV_BAN
    || (stadiumHr != null && stadiumHr <= STADIUM_BAN)
    || weatherLabel === 'Poor'
    || weatherMult <= WEATHER_POOR;
  const weatherHelps = weatherLabel === 'Great' || weatherLabel === 'Elite';
  const gate = !banned && (
    env >= ENV_GATE
    || (stadiumHr != null && stadiumHr >= STADIUM_GATE)
    || weatherHelps
  );
  const elite = gate && (
    env >= ELITE_ENV
    || (stadiumHr != null && stadiumHr >= ELITE_ENV && weatherMult >= 0.98)
  );
  const bucket: EnvBucket = !gate ? 'banned' : elite ? 'elite' : 'average';
  return { env, banned, gate, bucket };
}

function statcastLive(c: HrCandidate): boolean {
  return (c.contactSeason?.bbe ?? 0) >= MIN_BBE;
}

function barrelRate(line: ContactCounts | null): number | null {
  if (!line || line.bbe <= 0) return null;
  return line.barrel / line.bbe;
}

function stands(bat: BatHand, pitcher: BatHand | null): 'L' | 'R' {
  if (bat === 'S') return pitcher === 'L' ? 'R' : 'L';
  return bat === 'L' ? 'L' : 'R';
}

interface Talent {
  rate: number;
  source: ContactSource;
  barrelPct: number | null;
}

function talentRate(c: HrCandidate): Talent {
  const league = c.leagueHrPa > 0 ? c.leagueHrPa : LEAGUE_HR_PA_FALLBACK;
  const prior = regressedHrPerPa(c.seasonHr, c.seasonPa, league);
  const season = c.contactSeason;
  if (season && season.bbe >= MIN_BBE && season.pa > 0) {
    let implied = (season.barrel / season.bbe) * (season.bbe / season.pa) * HR_PER_BARREL_THROUGH_JUNE;
    const l14 = c.contactL14;
    if (l14 && l14.bbe >= 15 && l14.pa > 0) {
      const l14Implied = (l14.barrel / l14.bbe) * (l14.bbe / l14.pa) * HR_PER_BARREL_THROUGH_JUNE;
      implied = 0.75 * implied + 0.25 * l14Implied;
    }
    const hh = season.hard / season.bbe;
    const tilt = clamp((hh / LEAGUE_HARD_HIT) ** 0.15, 0.92, 1.08);
    return {
      rate: 0.72 * implied * tilt + 0.28 * prior,
      source: 'statcast',
      barrelPct: season.barrel / season.bbe,
    };
  }
  const leagueIso = c.leagueIso > 0 ? c.leagueIso : LEAGUE_ISO_FALLBACK;
  let rate = prior;
  if (c.iso != null && c.iso > 0) {
    const isoRate = (c.iso / leagueIso) * league;
    rate = 0.65 * isoRate + 0.35 * prior;
  }
  if (c.l14Pa >= 20) {
    const l14 = (c.l14Hr + league * 40) / (c.l14Pa + 40);
    rate = 0.82 * rate + 0.18 * l14;
  }
  return { rate, source: 'proxy', barrelPct: null };
}

function recentMultiplier(c: HrCandidate, prior: number): number {
  if (c.l14Pa < 20 || prior <= 0) return 1;
  const league = c.leagueHrPa > 0 ? c.leagueHrPa : LEAGUE_HR_PA_FALLBACK;
  const l14 = (c.l14Hr + league * 40) / (c.l14Pa + 40);
  return clamp(Math.sqrt(l14 / prior), 0.94, 1.08);
}

function pitcherMultiplier(c: HrCandidate): { mult: number; thin: boolean } {
  const league = c.leagueHrPa > 0 ? c.leagueHrPa : LEAGUE_HR_PA_FALLBACK;
  const vsBf = c.pitcherVsHandBf ?? 0;
  const useHand = vsBf >= 40 && c.pitcherVsHandHr != null;
  const hr = useHand ? c.pitcherVsHandHr! : c.pitcherHr;
  const bf = useHand ? vsBf : c.pitcherBf;
  if (bf < PITCHER_THIN_BF) return { mult: 1, thin: true };
  const shrunk = (hr + league * PITCHER_BF_PRIOR) / (bf + PITCHER_BF_PRIOR);
  let mult = shrunk / league;
  const air = c.pitcherAirOuts;
  const ground = c.pitcherGroundOuts;
  if (air != null && ground != null && air + ground >= 80 && ground + air > 0) {
    const fb = air / (air + ground);
    mult *= (fb / LEAGUE_FB_RATE) ** 0.35;
  }
  if (c.pitcherHard != null && c.pitcherBbe != null && c.pitcherBbe >= MIN_BBE && c.pitcherBbe > 0) {
    mult *= ((c.pitcherHard / c.pitcherBbe) / LEAGUE_HARD_HIT) ** 0.25;
  }
  return { mult: clamp(mult, 0.72, 1.45), thin: false };
}

function platoonMultiplier(c: HrCandidate, prior: number): number {
  if (c.vsHandPa != null && c.vsHandHr != null && c.vsHandPa >= 40 && prior > 0) {
    const hand = (c.vsHandHr + prior * HAND_SPLIT_PA_PRIOR) / (c.vsHandPa + HAND_SPLIT_PA_PRIOR);
    return clamp(hand / prior, 0.82, 1.18);
  }
  if (c.batHand === 'S') return 1.03;
  if (!c.pitcherHand) return 1;
  const batterStand = stands(c.batHand, c.pitcherHand);
  return batterStand === c.pitcherHand ? 0.92 : 1.05;
}

/** Park × CF wind is the same for every hitter in the game. Pull wind only moves the score. */
function gateWeather(weather: WeatherInput): WeatherInput {
  return { ...weather, pullOut: weather.cfOut };
}

function orderBoostFor(spot: number | null, enabled: boolean): number {
  if (!enabled || spot == null || spot < 1 || spot > 6) return 1;
  if (spot <= 3) return 1.06;
  if (spot <= 5) return 1.02;
  return 1;
}

function expectedPa(c: HrCandidate, flat: boolean): number {
  if (flat) return FLAT_PA;
  if (c.lineupKnown && c.lineupSpot != null && c.lineupSpot >= 1) {
    return ORDER_PA[c.lineupSpot] ?? 4.1;
  }
  if (c.seasonPaPerGame != null && c.seasonPaPerGame > 0) {
    return clamp(c.seasonPaPerGame, 3.2, 4.6);
  }
  return 3.8;
}

export interface ScoreParts {
  probability: number;
  talent: number;
  pitcherVuln: number;
  pitcherThin: boolean;
  env: number;
  weatherMult: number;
  weatherLabel: WeatherLabel;
  bucket: EnvBucket;
  platoon: number;
  orderBoost: number;
  contactSource: ContactSource;
  barrelPct: number | null;
}

export function scoreHrSpot(c: HrCandidate, opts: Pick<BoardOptions, 'orderBoost' | 'flatPa'>): ScoreParts {
  const weather = weatherHrMultiplier(c.weather);
  const envInfo = gameEnvironment(c.stadiumHr, weather.mult, weather.label);
  const talent = talentRate(c);
  const prior = regressedHrPerPa(c.seasonHr, c.seasonPa, c.leagueHrPa);
  const pitcher = pitcherMultiplier(c);
  const platoon = platoonMultiplier(c, prior);
  const boost = orderBoostFor(c.lineupSpot, opts.orderBoost);
  const recent = recentMultiplier(c, prior);
  const q = clamp(talent.rate * pitcher.mult * envInfo.env * platoon * boost * recent, Q_MIN, Q_MAX);
  const n = expectedPa(c, opts.flatPa);
  return {
    probability: 1 - (1 - q) ** n,
    talent: talent.rate,
    pitcherVuln: pitcher.mult,
    pitcherThin: pitcher.thin,
    env: envInfo.env,
    weatherMult: weather.mult,
    weatherLabel: weather.label,
    bucket: envInfo.bucket,
    platoon,
    orderBoost: boost,
    contactSource: talent.source,
    barrelPct: talent.barrelPct,
  };
}

function orderOverride(c: HrCandidate, bucket: EnvBucket): boolean {
  if (bucket !== 'elite') return false;
  const barrel = barrelRate(statcastLive(c) ? c.contactSeason : null);
  if (barrel != null && barrel >= ORDER_OVERRIDE_BARREL) return true;
  return c.iso != null && c.iso >= ORDER_OVERRIDE_ISO;
}

interface FilterResult {
  pass: boolean;
  reason: string | null;
  flags: string[];
  bucket: EnvBucket;
  weather: { mult: number; label: WeatherLabel };
  env: number;
}

function hardFilter(c: HrCandidate, opts: BoardOptions): FilterResult {
  const weather = weatherHrMultiplier(gateWeather(c.weather));
  const envInfo = gameEnvironment(c.stadiumHr, weather.mult, weather.label);
  const flags: string[] = [];
  if (c.stadiumHr == null) flags.push('park-unknown');
  if (weather.label === 'Unknown') flags.push('weather-unknown');
  if (weather.label === 'Neutral') flags.push('weather-neutral');

  const fail = (reason: string): FilterResult => ({
    pass: false,
    reason,
    flags,
    bucket: envInfo.bucket,
    weather,
    env: envInfo.env,
  });

  if (!c.pitcherKnown) return fail('no-starter');

  if (c.lineupKnown) {
    const spot = c.lineupSpot ?? 0;
    if (spot < 1) return fail('not-in-lineup');
    if (spot <= 6) flags.push('confirmed');
    else if (!opts.restrictOrder) flags.push('confirmed');
    else if (orderOverride(c, envInfo.bucket)) flags.push('order-override');
    else return fail('order');
  } else if (c.seasonPaPerGame != null && c.seasonPaPerGame >= PROJECTED_PA_PER_GAME) {
    flags.push('projected', 'order-unknown');
  } else {
    return fail('not-projected');
  }

  if (envInfo.banned) return fail('env-ban');
  if (!envInfo.gate) return fail('env-gate');

  if (c.seasonPa < MIN_SEASON_PA && c.l30Pa < MIN_L30_PA) return fail('pa-floor');

  const season = c.contactSeason;
  if (season && season.bbe > 0 && season.bbe < MIN_BBE) {
    const rate = season.barrel / season.bbe;
    if (rate >= BARREL_OUTLIER) return fail('barrel-sample');
  }

  return { pass: true, reason: null, flags, bucket: envInfo.bucket, weather, env: envInfo.env };
}

function isoMedian(pool: HrCandidate[]): number | null {
  const isos = pool.map(c => c.iso).filter((v): v is number => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (isos.length === 0) return null;
  return isos[Math.floor((isos.length - 1) / 2)];
}

function xIsoMedian(pool: HrCandidate[]): number | null {
  const xs = pool.map(c => c.xIso).filter((v): v is number => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  return xs[Math.floor((xs.length - 1) / 2)];
}

function applyContactGate(
  c: HrCandidate,
  proxyMedian: number | null,
  xMedian: number | null,
): { pass: boolean; reason: string | null; flag: string | null } {
  if (statcastLive(c)) {
    const barrel = barrelRate(c.contactSeason) ?? 0;
    const xOk = c.xIso != null && xMedian != null && c.xIso >= xMedian;
    if (barrel >= BARREL_GATE || xOk) return { pass: true, reason: null, flag: 'statcast' };
    return { pass: false, reason: 'contact-gate', flag: null };
  }
  if (c.iso == null || proxyMedian == null || c.iso < proxyMedian) {
    return { pass: false, reason: 'contact-gate', flag: null };
  }
  return { pass: true, reason: null, flag: 'proxy' };
}

function toPick(
  c: HrCandidate,
  opts: BoardOptions,
  filter: FilterResult,
  asOfDate: string,
  contactFlag: string | null,
  passed: boolean,
  reason: string | null,
): ScoredHrPick {
  const scored = scoreHrSpot(c, opts);
  const probability = opts.rankBy === 'baseline' ? c.baselineProbability : scored.probability;
  const flags = [...filter.flags];
  if (contactFlag) flags.push(contactFlag);
  if (scored.pitcherThin && passed) flags.push('pitcher-thin');
  return {
    playerId: c.playerId,
    gamePk: c.gamePk,
    teamId: c.teamId,
    probability,
    envMultiplier: filter.env,
    stadiumHr: c.stadiumHr,
    weatherMultiplier: filter.weather.mult,
    weatherLabel: filter.weather.label,
    envBucket: filter.bucket,
    order: c.lineupKnown ? c.lineupSpot : null,
    barrelPct: scored.barrelPct,
    xIso: c.xIso,
    iso: c.iso,
    contactSource: scored.contactSource,
    asOfDate,
    pitcherVuln: c.pitcherKnown ? scored.pitcherVuln : null,
    flags,
    filterReason: reason,
    passed,
  };
}

function byScore(a: ScoredHrPick, b: ScoredHrPick): number {
  if (b.probability !== a.probability) return b.probability - a.probability;
  return a.playerId - b.playerId;
}

function takeStacked(picks: ScoredHrPick[]): { full: ScoredHrPick[]; spot: ScoredHrPick[] } {
  const eliteGames = new Map<number, ScoredHrPick[]>();
  const averageGames = new Map<number, ScoredHrPick[]>();
  for (const pick of picks) {
    const dest = pick.envBucket === 'elite' ? eliteGames : averageGames;
    const list = dest.get(pick.gamePk) ?? [];
    list.push(pick);
    dest.set(pick.gamePk, list);
  }
  const gameOrder = (map: Map<number, ScoredHrPick[]>) => [...map.entries()].sort((a, b) => {
    const ae = Math.max(...a[1].map(p => p.envMultiplier));
    const be = Math.max(...b[1].map(p => p.envMultiplier));
    if (be !== ae) return be - ae;
    return a[0] - b[0];
  });

  const full: ScoredHrPick[] = [];
  const teamCount = new Map<number, number>();
  const gameCount = new Map<number, number>();

  const fill = (groups: Array<[number, ScoredHrPick[]]>, perGame: number) => {
    for (const [, bats] of groups) {
      if (full.length >= FULL_BOARD_CAP) return;
      let taken = 0;
      for (const bat of [...bats].sort(byScore)) {
        if (full.length >= FULL_BOARD_CAP || taken >= perGame) break;
        if ((gameCount.get(bat.gamePk) ?? 0) >= MAX_PER_GAME) break;
        if ((teamCount.get(bat.teamId) ?? 0) >= MAX_PER_TEAM) continue;
        full.push(bat);
        taken += 1;
        teamCount.set(bat.teamId, (teamCount.get(bat.teamId) ?? 0) + 1);
        gameCount.set(bat.gamePk, (gameCount.get(bat.gamePk) ?? 0) + 1);
      }
    }
  };

  fill(gameOrder(eliteGames), ELITE_BATS_PER_GAME);
  const spot = full.filter(p => p.envBucket === 'elite').slice(0, SPOT_BOARD_CAP);
  fill(gameOrder(averageGames), ELITE_BATS_PER_GAME);
  return { full, spot };
}

/**
 * Build the spot board (environment-first, cap 12, no average-park padding)
 * and the full board (cap 20, no banned-park padding).
 */
export function buildBoards(candidates: HrCandidate[], opts: BoardOptions, asOfDate: string): BuiltBoards {
  const prelim = candidates.map(c => ({ c, filter: hardFilter(c, opts) }));
  const eligible = prelim.filter(p => p.filter.pass).map(p => p.c);
  const proxyPool = eligible.filter(c => !statcastLive(c));
  const livePool = eligible.filter(statcastLive);
  const proxyMed = isoMedian(proxyPool);
  const xMed = xIsoMedian(livePool);

  const all: ScoredHrPick[] = [];
  const passing: ScoredHrPick[] = [];
  for (const { c, filter } of prelim) {
    if (!filter.pass) {
      all.push(toPick(c, opts, filter, asOfDate, null, false, filter.reason));
      continue;
    }
    if (opts.contactGate) {
      const gate = applyContactGate(c, proxyMed, xMed);
      const pick = toPick(c, opts, filter, asOfDate, gate.flag, gate.pass, gate.reason);
      all.push(pick);
      if (gate.pass) passing.push(pick);
      continue;
    }
    const flag = statcastLive(c) ? 'statcast' : 'proxy';
    const pick = toPick(c, opts, filter, asOfDate, flag, true, null);
    all.push(pick);
    passing.push(pick);
  }

  if (!opts.stack) {
    const full = [...passing].sort(byScore).slice(0, FULL_BOARD_CAP);
    return { spot: [], full, all };
  }
  const stacked = takeStacked(passing);
  return { spot: stacked.spot, full: stacked.full, all };
}

export function explainBoardPick(pick: {
  envMultiplier: number;
  stadiumHr: number | null;
  weatherMultiplier: number;
  weatherLabel: string;
  order: number | null;
  flags: string[];
  contactSource: ContactSource;
  barrelPct: number | null;
  xIso: number | null;
  iso: number | null;
  asOfDate: string;
  pitcherVuln: number | null;
}): string[] {
  const drivers: string[] = [];
  const stadium = pick.stadiumHr == null ? 'park n/a' : `stadium ${pick.stadiumHr.toFixed(2)}`;
  drivers.push(
    `Env ×${pick.envMultiplier.toFixed(2)} (${stadium} × weather ×${pick.weatherMultiplier.toFixed(2)} ${pick.weatherLabel})`,
  );
  if (pick.order != null && pick.order >= 1) {
    drivers.push(`Batting ${pick.order}${pick.flags.includes('order-override') ? ' (order override)' : ''}`);
  } else if (pick.flags.includes('projected')) {
    drivers.push('Lineup not posted — projected regular, order unknown');
  }
  if (pick.contactSource === 'statcast' && pick.barrelPct != null) {
    const x = pick.xIso == null ? 'xISO n/a' : `xISO ${pick.xIso.toFixed(3)}`;
    drivers.push(`Barrel ${(pick.barrelPct * 100).toFixed(1)}% as of ${pick.asOfDate} (${x})`);
  } else {
    const iso = pick.iso == null ? 'ISO n/a' : `ISO ${pick.iso.toFixed(3)}`;
    drivers.push(`${iso} proxy as of ${pick.asOfDate} (barrel% and xISO not wired)`);
  }
  if (pick.pitcherVuln != null) {
    const thin = pick.flags.includes('pitcher-thin') ? ', thin sample' : '';
    drivers.push(`Pitcher vulnerability ×${pick.pitcherVuln.toFixed(2)}${thin}`);
  }
  if (pick.flags.length > 0) drivers.push(`Flags: ${pick.flags.join(', ')}`);
  return drivers.slice(0, 5);
}
