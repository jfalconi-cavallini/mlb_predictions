// Home-run probability for the daily top-20 ranking.
//
// The live board uses homeRunProbability(): regressed season HR/PA, times a
// square-root park factor, times expected plate appearances. It replaces the
// additive logit in scoring/engine.ts for the HR prop only.
//
// Backtest (stats frozen the day before each slate, top 20 vs boxscore HRs):
//   previous logit, static park table, Sep 8–22:     3.20 / 20
//   this plate-appearance model, Sep 8–22:           4.13 / 20   top 10: 2.07 / 10
//   full slates (12+ games):                         4.27 / 20 vs 3.18 / 20
//   this model, Jul 1–Sep 7 (66 game days):          3.58 / 20   top 10: 1.97 / 10
//
// spotHomeRunProbability() is a different ranker (hand split, starter HR/BF,
// point-in-time barrels, last-45 HR/PA, wind and temperature). It is not the
// live sort. On the Jul 1–Sep 7 window it was chosen against, the best of
// those modes was 3.64/20. On the untouched Sep 8–22 window:
//   matchup (hand × starter × park):                 3.53 / 20   top 10: 2.40 / 10
//   contact (matchup with a barrel blend):           4.00 / 20   top 10: 2.07 / 10
//   spot (contact + recent form + weather):          3.67 / 20   top 10: 1.93 / 10
// The names those modes swapped in homered less often than the names they
// replaced. See scripts/hr-spot-research.mjs.
//
// Ten hits in twenty spots would require those names to homer about half the
// time. They do not. On Jul 1–Sep 7 about 28 players homered per day, the top
// talent quintile (150+ PA) homered in 16.9% of games, and the baseline top
// 20 homered in 17.9%. Pitcher, park, wind, platoon, and a hot 45 days each
// moved that elite group by about 0–3 percentage points. No public pre-game
// bucket in the study reached 50%.
//
// The model's own probabilities for its Sep 8–22 top 20 sum to about 4.0,
// and 4.13 actually homered. A CoS retune of the old logit scored 3.07/20
// on that window. Putting that package inside this formula scored 3.87/20.
// See scripts/hr-top20-eval.mjs.

export const HR_PA_PRIOR = 200;
export const PARK_SHRINK_PA = 2200;
export const LEAGUE_HR_PA_FALLBACK = 0.0306;
export const BENCH_PA_WHEN_LINEUP_POSTED = 0.2;

// Typical PA by batting-order slot (top of the order sees the pitcher more often).
export const PA_BY_LINEUP_SPOT = [0, 4.67, 4.56, 4.45, 4.34, 4.23, 4.12, 4.01, 3.9, 3.79];

export interface HomeRunInput {
  hr: number;
  pa: number;
  leagueHrPa: number;
  /** Raw 2026 home/away HR factor for the park. 1 = neutral. The model square-roots it. */
  parkFactor: number;
  teamGames: number;
  lineupKnown: boolean;
  /** 1–9 when the hitter is in the posted order, 0 when the lineup is posted and they are not in it, null when no lineup is posted. */
  lineupSpot: number | null;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function regressedHrPerPa(hr: number, pa: number, leagueHrPa: number): number {
  const league = leagueHrPa > 0 ? leagueHrPa : LEAGUE_HR_PA_FALLBACK;
  if (pa > 0) return (hr + league * HR_PA_PRIOR) / (pa + HR_PA_PRIOR);
  return league * 0.85;
}

/**
 * Basic park factors overstate the HR environment (a raw Coors multiplier
 * near 1.4 filled the top 20 with one game). Square-root dampening kept the
 * direction of the 2026 home/away factor and raised top-20 hits on both
 * halves of the Sep 8–22 backtest; the undampened factor did not.
 */
export function dampenedParkFactor(parkFactor: number): number {
  const raw = Number.isFinite(parkFactor) && parkFactor > 0 ? parkFactor : 1;
  return Math.sqrt(clamp(raw, 0.82, 1.35));
}

/**
 * Home HR factor from a team's own home vs road HR (batting + pitching),
 * shrunk toward 1 with a 2,200-PA prior. Returns null when either side is
 * too thin to use.
 */
export function empiricalParkFactor(
  homeHr: number,
  homePa: number,
  awayHr: number,
  awayPa: number,
  leagueHrPa: number,
): number | null {
  if (homePa < 500 || awayPa < 500) return null;
  const league = leagueHrPa > 0 ? leagueHrPa : LEAGUE_HR_PA_FALLBACK;
  const shrunkHome = (homeHr + league * PARK_SHRINK_PA) / (homePa + PARK_SHRINK_PA);
  const shrunkAway = (awayHr + league * PARK_SHRINK_PA) / (awayPa + PARK_SHRINK_PA);
  if (shrunkAway <= 0) return null;
  return clamp(shrunkHome / shrunkAway, 0.82, 1.35);
}

export function expectedPlateAppearances(input: HomeRunInput): number {
  if (input.lineupKnown && input.lineupSpot != null && input.lineupSpot >= 1) {
    return PA_BY_LINEUP_SPOT[input.lineupSpot] ?? 4.1;
  }
  if (input.lineupKnown) return BENCH_PA_WHEN_LINEUP_POSTED;
  if (input.teamGames > 0) return clamp(input.pa / input.teamGames, 0.12, 4.9);
  return 2.5;
}

export function homeRunProbability(input: HomeRunInput): number {
  const league = input.leagueHrPa > 0 ? input.leagueHrPa : LEAGUE_HR_PA_FALLBACK;
  const rate = regressedHrPerPa(input.hr, input.pa, league) * dampenedParkFactor(input.parkFactor);
  const q = clamp(rate, 0.002, 0.09);
  const n = expectedPlateAppearances(input);
  return 1 - (1 - q) ** n;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

export function explainHomeRun(input: HomeRunInput): string[] {
  const league = input.leagueHrPa > 0 ? input.leagueHrPa : LEAGUE_HR_PA_FALLBACK;
  const raw = regressedHrPerPa(input.hr, input.pa, league);
  const per600 = Math.round(raw * 600);
  const drivers: string[] = [];

  if (input.pa >= 1) {
    drivers.push(`Regressed HR rate about ${per600} per 600 PA (${input.hr} HR in ${input.pa} PA)`);
  } else {
    drivers.push('No plate appearances yet — HR rate set to the league baseline');
  }

  const n = expectedPlateAppearances(input);
  if (input.lineupKnown && input.lineupSpot != null && input.lineupSpot >= 1) {
    drivers.push(`Batting ${ordinal(input.lineupSpot)} — about ${n.toFixed(2)} PA`);
  } else if (input.lineupKnown) {
    drivers.push(`Not in the posted lineup — about ${n.toFixed(2)} expected PA`);
  } else {
    drivers.push(`Lineup not posted — about ${n.toFixed(2)} PA from season playing time`);
  }

  const damp = dampenedParkFactor(input.parkFactor);
  const rawPark = Number.isFinite(input.parkFactor) && input.parkFactor > 0 ? input.parkFactor : 1;
  if (damp >= 1.03) {
    drivers.push(`Park boosts HR (2026 factor ${rawPark.toFixed(2)}, dampened to ${damp.toFixed(2)})`);
  } else if (damp <= 0.97) {
    drivers.push(`Park suppresses HR (2026 factor ${rawPark.toFixed(2)}, dampened to ${damp.toFixed(2)})`);
  } else {
    drivers.push(`Park HR environment near neutral (2026 factor ${rawPark.toFixed(2)})`);
  }

  return drivers;
}

// ─── SPOT RANKER ─────────────────────────────────────────────────────────────
// A different HR ranking path from the season-rate × PA × park model above.
// Per-PA home-run rate is a matchup, not a season total:
//
//   q = talent × starterHrEnvironment × dampenedPark × weather
//   P(at least one HR) = 1 - (1 - q) ^ expectedPA
//
// talent is the hitter's HR/PA versus today's pitcher hand (shrunk toward his
// own overall rate). The starter environment is his regressed HR/BF, blended
// 65/35 with the league because a lineup only sees the starter for part of
// the game. `contact` replaces half of each rate with a barrel-implied rate
// (Statcast barrel zone, point-in-time). `spot` also folds in the last 45
// days and wind/temperature. None of these constants were fit on Sep 8–22.
//
// HR per barrel is measured on 2026 games through June 30 only (play-by-play
// barrel zone below), so the Sep 8–22 backtest does not set it.
// 2940 HR / 4783 barrels = 0.6147.

export const HR_PER_BARREL_THROUGH_JUNE = 2940 / 4783;
export const HAND_SPLIT_PA_PRIOR = 100;
export const PITCHER_BF_PRIOR = 400;
/** Share of a hitter's plate appearances typically taken against the starter. */
export const STARTER_PA_SHARE = 0.65;
export const BARREL_BLEND = 0.5;
export const RECENT_PA_PRIOR = 120;
export const RECENT_TALENT_WEIGHT = 0.3;
export const RECENT_MIN_PA = 20;
export const SPOT_Q_MIN = 0.002;
export const SPOT_Q_MAX = 0.12;
/** ~4% relative HR per 10°F away from 70. Not fit on the eval window. */
export const WEATHER_TEMP_PER_F = 0.004;
/** ~12% relative HR per 10 mph of wind straight out to CF. */
export const WEATHER_WIND_PER_MPH = 0.012;
export const WEATHER_FACTOR_MIN = 0.82;
export const WEATHER_FACTOR_MAX = 1.22;

/**
 * Retractable roofs and domes. Outside wind and temperature are not the
 * air the ball is hit in, so the spot model leaves weather at 1.
 */
export const WEATHER_NEUTRAL_VENUE_IDS = new Set<number>([
  12,   // Tropicana Field
  14,   // Rogers Centre
  2392, // Minute Maid Park
  5325, // Globe Life Field
]);

export type SpotMode = 'matchup' | 'contact' | 'spot';

export interface SpotHomeRunInput extends HomeRunInput {
  /** HR and PA versus the probable pitcher's throwing hand. */
  handHr?: number | null;
  handPa?: number | null;
  pitcherHr?: number | null;
  pitcherBf?: number | null;
  /** Point-in-time barrels and the PA denominator they were counted on. */
  barrels?: number | null;
  barrelPa?: number | null;
  handBarrels?: number | null;
  handBarrelPa?: number | null;
  pitcherBarrels?: number | null;
  pitcherBarrelBf?: number | null;
  leagueBarrelPa?: number | null;
  /** Defaults to HR_PER_BARREL_THROUGH_JUNE when omitted. */
  hrPerBarrel?: number | null;
  recentHr?: number | null;
  recentPa?: number | null;
  tempF?: number | null;
  windMph?: number | null;
  /** +1 wind blowing toward CF, −1 blowing in, 0 calm or unknown. */
  windOutComponent?: number | null;
  indoor?: boolean;
  suppressWeather?: boolean;
}

export interface SpotBreakdown {
  q: number;
  handRate: number;
  talentRate: number;
  pitcherMultiplier: number;
  park: number;
  weather: number;
  usedBarrels: boolean;
  usedRecent: boolean;
}

export function handAdjustedHrRate(
  hr: number,
  pa: number,
  handHr: number | null | undefined,
  handPa: number | null | undefined,
  leagueHrPa: number,
): number {
  const overall = regressedHrPerPa(hr, pa, leagueHrPa);
  if (handHr == null || handPa == null || handPa <= 0) return overall;
  return (handHr + overall * HAND_SPLIT_PA_PRIOR) / (handPa + HAND_SPLIT_PA_PRIOR);
}

export function barrelImpliedHrRate(
  barrels: number,
  pa: number,
  leagueBarrelPa: number,
  hrPerBarrel: number,
  priorPa: number = HR_PA_PRIOR,
): number {
  if (!(pa > 0) || !(hrPerBarrel > 0)) return 0;
  const leagueB = leagueBarrelPa > 0 ? leagueBarrelPa : 0.05;
  const perPa = (barrels + leagueB * priorPa) / (pa + priorPa);
  return perPa * hrPerBarrel;
}

export function weatherHrMultiplier(
  tempF: number | null | undefined,
  windMph: number | null | undefined,
  windOutComponent: number | null | undefined,
  neutral: boolean,
): number {
  if (neutral || tempF == null || !Number.isFinite(tempF)) return 1;
  const temp = 1 + WEATHER_TEMP_PER_F * (tempF - 70);
  const mph = windMph != null && Number.isFinite(windMph) ? Math.max(0, windMph) : 0;
  const out = windOutComponent != null && Number.isFinite(windOutComponent)
    ? clamp(windOutComponent, -1, 1)
    : 0;
  return clamp(temp * (1 + WEATHER_WIND_PER_MPH * out * mph), WEATHER_FACTOR_MIN, WEATHER_FACTOR_MAX);
}

export function pitcherHrMultiplier(
  pitcherHr: number | null | undefined,
  pitcherBf: number | null | undefined,
  leagueHrPa: number,
  barrels?: number | null,
  barrelBf?: number | null,
  leagueBarrelPa?: number | null,
  hrPerBarrel?: number | null,
): number {
  const league = leagueHrPa > 0 ? leagueHrPa : LEAGUE_HR_PA_FALLBACK;
  if (pitcherHr == null || pitcherBf == null || pitcherBf <= 0) return 1;
  let rate = (pitcherHr + league * PITCHER_BF_PRIOR) / (pitcherBf + PITCHER_BF_PRIOR);
  if (
    barrels != null && barrelBf != null && barrelBf > 0
    && hrPerBarrel != null && hrPerBarrel > 0
    && leagueBarrelPa != null && leagueBarrelPa > 0
  ) {
    const barrelRate = barrelImpliedHrRate(barrels, barrelBf, leagueBarrelPa, hrPerBarrel, PITCHER_BF_PRIOR);
    rate = (1 - BARREL_BLEND) * rate + BARREL_BLEND * barrelRate;
  }
  const blended = STARTER_PA_SHARE * rate + (1 - STARTER_PA_SHARE) * league;
  return blended / league;
}

function blendHandBarrels(input: SpotHomeRunInput, k: number, leagueB: number): number | null {
  if (input.barrels == null || input.barrelPa == null || !(input.barrelPa > 0) || !(k > 0)) return null;
  const overall = barrelImpliedHrRate(input.barrels, input.barrelPa, leagueB, k);
  if (input.handBarrels == null || input.handBarrelPa == null || !(input.handBarrelPa > 0)) return overall;
  const overallPerPa = (input.barrels + leagueB * HR_PA_PRIOR) / (input.barrelPa + HR_PA_PRIOR);
  const handPerPa = (input.handBarrels + overallPerPa * HAND_SPLIT_PA_PRIOR)
    / (input.handBarrelPa + HAND_SPLIT_PA_PRIOR);
  return handPerPa * k;
}

export function computeSpotRates(input: SpotHomeRunInput, mode: SpotMode): SpotBreakdown {
  const league = input.leagueHrPa > 0 ? input.leagueHrPa : LEAGUE_HR_PA_FALLBACK;
  const k = input.hrPerBarrel != null && input.hrPerBarrel > 0
    ? input.hrPerBarrel
    : HR_PER_BARREL_THROUGH_JUNE;
  const leagueB = input.leagueBarrelPa != null && input.leagueBarrelPa > 0 ? input.leagueBarrelPa : 0.05;
  const handRate = handAdjustedHrRate(input.hr, input.pa, input.handHr, input.handPa, league);

  let talentRate = handRate;
  let usedBarrels = false;
  if (mode === 'contact' || mode === 'spot') {
    const barrelRate = blendHandBarrels(input, k, leagueB);
    if (barrelRate != null) {
      talentRate = (1 - BARREL_BLEND) * handRate + BARREL_BLEND * barrelRate;
      usedBarrels = true;
    }
  }

  let usedRecent = false;
  if (
    mode === 'spot'
    && input.recentHr != null
    && input.recentPa != null
    && input.recentPa >= RECENT_MIN_PA
  ) {
    const recent = (input.recentHr + talentRate * RECENT_PA_PRIOR) / (input.recentPa + RECENT_PA_PRIOR);
    talentRate = (1 - RECENT_TALENT_WEIGHT) * talentRate + RECENT_TALENT_WEIGHT * recent;
    usedRecent = true;
  }

  const pitcherMultiplier = pitcherHrMultiplier(
    input.pitcherHr,
    input.pitcherBf,
    league,
    usedBarrels ? input.pitcherBarrels : null,
    usedBarrels ? input.pitcherBarrelBf : null,
    leagueB,
    k,
  );
  const park = dampenedParkFactor(input.parkFactor);
  const weather = mode === 'spot'
    ? weatherHrMultiplier(
      input.tempF,
      input.windMph,
      input.windOutComponent,
      !!(input.indoor || input.suppressWeather),
    )
    : 1;
  const q = clamp(talentRate * pitcherMultiplier * park * weather, SPOT_Q_MIN, SPOT_Q_MAX);
  return { q, handRate, talentRate, pitcherMultiplier, park, weather, usedBarrels, usedRecent };
}

export function spotHomeRunProbability(input: SpotHomeRunInput, mode: SpotMode): number {
  const { q } = computeSpotRates(input, mode);
  const n = expectedPlateAppearances(input);
  return 1 - (1 - q) ** n;
}

export function explainSpotHomeRun(input: SpotHomeRunInput, mode: SpotMode): string[] {
  const league = input.leagueHrPa > 0 ? input.leagueHrPa : LEAGUE_HR_PA_FALLBACK;
  const rates = computeSpotRates(input, mode);
  const per600 = Math.round(rates.talentRate * 600);
  const lines: Array<{ text: string; impact: number }> = [];

  if (input.pa >= 1) {
    const barrelNote = rates.usedBarrels && input.barrels != null && input.barrelPa
      ? `, barrel rate ${(100 * input.barrels / input.barrelPa).toFixed(1)}% blended in`
      : '';
    lines.push({
      text: `HR skill about ${per600} per 600 PA (${input.hr} HR in ${input.pa} PA${barrelNote})`,
      impact: 100,
    });
  } else {
    lines.push({ text: 'No plate appearances yet — HR skill set from the league baseline', impact: 100 });
  }

  const n = expectedPlateAppearances(input);
  if (input.lineupKnown && input.lineupSpot != null && input.lineupSpot >= 1) {
    lines.push({ text: `Batting ${ordinal(input.lineupSpot)} — about ${n.toFixed(2)} PA`, impact: 99 });
  } else if (input.lineupKnown) {
    lines.push({ text: `Not in the posted lineup — about ${n.toFixed(2)} expected PA`, impact: 99 });
  } else {
    lines.push({ text: `Lineup not posted — about ${n.toFixed(2)} PA from season playing time`, impact: 99 });
  }

  if (input.handPa != null && input.handPa >= 40 && input.handHr != null) {
    const rawHand = input.handPa > 0 ? input.handHr / input.handPa : 0;
    const overall = input.pa > 0 ? input.hr / input.pa : league;
    if (Math.abs(rawHand - overall) >= 0.008) {
      lines.push({
        text: `Versus this pitcher hand: ${input.handHr} HR in ${input.handPa} PA`,
        impact: Math.abs(rates.handRate - regressedHrPerPa(input.hr, input.pa, league)),
      });
    }
  }

  if (input.pitcherBf != null && input.pitcherBf > 0 && input.pitcherHr != null) {
    const away = Math.abs(Math.log(Math.max(rates.pitcherMultiplier, 0.05)));
    if (away >= 0.03) {
      const word = rates.pitcherMultiplier >= 1 ? 'elevated' : 'suppressed';
      lines.push({
        text: `Starter allows ${word} HR (${input.pitcherHr} HR / ${input.pitcherBf} BF, ${rates.pitcherMultiplier.toFixed(2)}× league after regression)`,
        impact: away,
      });
    }
  }

  const rawPark = Number.isFinite(input.parkFactor) && input.parkFactor > 0 ? input.parkFactor : 1;
  if (Math.abs(rates.park - 1) >= 0.03) {
    const word = rates.park >= 1 ? 'boosts' : 'suppresses';
    lines.push({
      text: `Park ${word} HR (2026 factor ${rawPark.toFixed(2)}, dampened to ${rates.park.toFixed(2)})`,
      impact: Math.abs(rates.park - 1),
    });
  }

  if (mode === 'spot' && Math.abs(rates.weather - 1) >= 0.03) {
    const word = rates.weather >= 1 ? 'helps' : 'hurts';
    const temp = input.tempF != null ? `${Math.round(input.tempF)}°F` : 'unknown temp';
    const wind = input.windMph != null ? `${Math.round(input.windMph)} mph wind` : 'wind unknown';
    lines.push({
      text: `Weather ${word} HR (${temp}, ${wind}, ${rates.weather.toFixed(2)}×)`,
      impact: Math.abs(rates.weather - 1),
    });
  }

  if (rates.usedRecent && input.recentPa != null && input.recentHr != null) {
    lines.push({
      text: `Last 45 days: ${input.recentHr} HR in ${input.recentPa} PA, shrunk toward the season skill`,
      impact: 0.04,
    });
  }

  lines.sort((a, b) => b.impact - a.impact);
  return lines.slice(0, 4).map(line => line.text);
}
