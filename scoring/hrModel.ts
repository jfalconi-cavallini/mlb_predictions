// Home-run probability for the daily top-20 ranking.
//
// Replaces the additive logit in scoring/engine.ts for the HR prop only.
// Backtest (2026-09-08 through 2026-09-22, stats frozen the day before each
// slate, top 20 vs actual boxscore HRs):
//   previous logit, static park table: 3.20 / 20
//   this model:                         4.13 / 20
//   full slates (12+ games):            4.27 / 20 vs 3.18 / 20
// Random starters on the same days were 2.38 / 20. The model's own
// probabilities for its top 20 sum to about 4.0, and 4.13 actually homered,
// so the list is calibrated near 20% per name. Ten hits in twenty spots
// would require those names to homer at ~50%, which this sample never
// supported for any public-stat variant we tried (platoon splits, barrel
// blend, pitcher HR/BF, per-game caps). A later pass treated L7/L14/L30
// HR/PA as the observation (season rate as the prior), oriented wind and
// temperature, a milder pitcher fly-ball adjustment, and a retuned linear
// logit as hypotheses. None of them beat this model on both halves of
// Sep 8–22; the linear retune landed near 3/20. See scripts/hr-top20-eval.mjs.

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
