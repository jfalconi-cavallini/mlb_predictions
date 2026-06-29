import { MLBGame, MLBPitcher, ParkFactors, GamePrediction, WeatherConditions } from '../types';

const LEAGUE_ERA = 4.20;
const LEAGUE_RUNS_PER_GAME = 4.5;
const HOME_FIELD_BOOST = 1.04;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// Composite pitcher dominance score, 0 (terrible) to 1 (elite).
// Higher = harder to score against. Used for LOCK detection and key factor labels.
function pitcherQualityScore(pitcher: MLBPitcher | null): number {
  if (!pitcher?.seasonStats) return 0.50;
  const ss = pitcher.seasonStats;

  // Each stat normalized to 0–1: higher always means better pitcher quality
  const eraScore  = clamp(1 - (ss.era    - 2.00) / 5.00, 0, 1); // ERA 2–7
  const kScore    = clamp((ss.kPer9    - 5.00) / 7.00,   0, 1); // K/9 5–12
  const bbScore   = clamp(1 - (ss.bbPer9  - 1.50) / 4.50, 0, 1); // BB/9 1.5–6
  const whipScore = clamp(1 - (ss.whip    - 0.80) / 1.10, 0, 1); // WHIP 0.80–1.90

  let quality = eraScore * 0.35 + kScore * 0.30 + bbScore * 0.20 + whipScore * 0.15;

  // Blend in recent 14-day performance when sample is meaningful
  const pr = pitcher.recentStats;
  if (pr && pr.innings >= 8) {
    const rEra  = clamp(1 - (pr.era  - 2.00) / 5.00, 0, 1);
    const rWhip = clamp(1 - (pr.whip - 0.80) / 1.10, 0, 1);
    quality = quality * 0.75 + (rEra * 0.65 + rWhip * 0.35) * 0.25;
  }

  return quality;
}

// Estimate expected runs scored against a given pitcher.
// Uses ERA + WHIP as base, then adjusts for K/9 and BB/9,
// and blends in recent 14-day performance when a meaningful sample exists.
function expectedRunsAgainst(pitcher: MLBPitcher | null): number {
  if (!pitcher?.seasonStats) return LEAGUE_RUNS_PER_GAME;
  const ss = pitcher.seasonStats;

  const eraFactor  = ss.era  / LEAGUE_ERA;
  const whipFactor = ss.whip / 1.30;

  // High K/9 → run suppression beyond what ERA shows (up to -10%)
  const kAdjust  = 1 - clamp((ss.kPer9  - 8.5) / 12,  0, 0.10);
  // High BB/9 → more baserunners, more runs (up to +8%)
  const bbAdjust = 1 + clamp((ss.bbPer9 - 3.0)  / 6.0, 0, 0.08);

  let expected = LEAGUE_RUNS_PER_GAME * (eraFactor * 0.60 + whipFactor * 0.25) * kAdjust * bbAdjust;

  // Blend recent ERA at 20–28% weight when innings sample is meaningful
  const pr = pitcher.recentStats;
  if (pr && pr.innings >= 10) {
    const recentWeight = ss.innings >= 40 ? 0.20 : 0.28;
    const recentExpected = LEAGUE_RUNS_PER_GAME * (pr.era / LEAGUE_ERA);
    expected = expected * (1 - recentWeight) + recentExpected * recentWeight;
  }

  return Math.max(0.5, expected);
}

function pythagoreanWinPct(runsFor: number, runsAgainst: number): number {
  const rf = Math.pow(Math.max(runsFor, 0.01), 1.83);
  const ra = Math.pow(Math.max(runsAgainst, 0.01), 1.83);
  return rf / (rf + ra);
}

function pitcherLine(pitcher: MLBPitcher | null): string {
  if (!pitcher) return 'TBD';
  const ss = pitcher.seasonStats;
  if (!ss) return `${pitcher.fullName} (no stats)`;
  const trend = pitcher.recentStats && pitcher.recentStats.innings >= 8
    ? (pitcher.recentStats.era < ss.era - 0.50 ? ' ↑' : pitcher.recentStats.era > ss.era + 0.50 ? ' ↓' : '')
    : '';
  return `${pitcher.fullName}: ${ss.era.toFixed(2)} ERA, ${ss.kPer9.toFixed(1)} K/9, ${ss.bbPer9.toFixed(1)} BB/9${trend}`;
}

// Returns a run-scoring multiplier driven by temperature and wind.
// Applied equally to both teams → shifts the projected total without changing run differential.
// Temperature: warm air is less dense, ball carries farther; cold air suppresses offense.
// Wind: blowing out to CF inflates totals; blowing in from CF suppresses them.
function weatherRunsMultiplier(weather: WeatherConditions | null): number {
  if (!weather || weather.isIndoor) return 1.0;

  let m = 1.0;

  // Temperature adjustment
  const t = weather.tempF;
  if (t >= 90)      m *= 1.07;
  else if (t >= 80) m *= 1.03;
  else if (t >= 65) m *= 1.00;
  else if (t >= 50) m *= 0.97;
  else if (t >= 40) m *= 0.93;
  else              m *= 0.87;

  // Wind adjustment — intensity scaled 0–1, caps out at 20 mph
  const mph = weather.windSpeedMph;
  if (mph >= 5) {
    const intensity = Math.min(mph / 20, 1.0);
    const dir = weather.windDirectionLabel;
    if (dir === 'out to CF') {
      m *= 1 + 0.15 * intensity;   // up to +15% total runs at 20+ mph
    } else if (dir === 'in from CF') {
      m *= 1 - 0.15 * intensity;   // up to -15% total runs at 20+ mph
    }
    // Crosswinds: negligible net run effect — skip
  }

  return clamp(m, 0.75, 1.30);
}

export function scoreGame(game: MLBGame, parkFactors: ParkFactors, weather: WeatherConditions | null = null, ouLine: number | null = null): GamePrediction {
  const homePitcher = game.probableHomePitcher;
  const awayPitcher = game.probableAwayPitcher;

  // Home team scores against the away pitcher; apply park runs factor and weather
  const wMult = weatherRunsMultiplier(weather);
  const rawHomeRuns = expectedRunsAgainst(awayPitcher) * parkFactors.runsFactor * wMult;
  const rawAwayRuns = expectedRunsAgainst(homePitcher) * parkFactors.runsFactor * wMult;

  // Home field advantage
  const homeExpectedRuns = rawHomeRuns * HOME_FIELD_BOOST;
  const awayExpectedRuns = rawAwayRuns;
  const projectedTotal = homeExpectedRuns + awayExpectedRuns;

  const homeWinProb = pythagoreanWinPct(homeExpectedRuns, awayExpectedRuns);
  const awayWinProb = 1 - homeWinProb;
  const winProb = Math.max(homeWinProb, awayWinProb);
  const runDiff = homeExpectedRuns - awayExpectedRuns; // positive = home team favored

  // ── PITCHER QUALITY ───────────────────────────────────────────────────────
  const homeQuality = pitcherQualityScore(homePitcher);
  const awayQuality = pitcherQualityScore(awayPitcher);
  const qualityDiff = homeQuality - awayQuality; // positive = home pitcher better
  const avgQuality  = (homeQuality + awayQuality) / 2;
  const bothKnown   = homePitcher?.seasonStats != null && awayPitcher?.seasonStats != null;

  // ── ML PICK (moneyline / run line) ────────────────────────────────────────
  // -1.5 is only recommended when the edge is genuinely extreme.
  // Most picks should be ML — it wins at a higher rate for tracking purposes.
  let spreadLean = "Pick'em";
  let spreadLeanSide: 'home' | 'away' | null = null;
  let pickLabel = 'Pass';
  let pickSide: 'home' | 'away' | null = null;

  if (runDiff >= 0.40) {
    spreadLeanSide = 'home';
    // Always recommend ML — it cashes when the team wins by 1 run too, giving a
    // consistently higher hit rate than -1.5 regardless of how large the edge is.
    spreadLean = `${game.homeTeam.abbreviation} ML`;
    pickLabel = spreadLean;
    pickSide  = 'home';
  } else if (runDiff <= -0.40) {
    spreadLeanSide = 'away';
    spreadLean = `${game.awayTeam.abbreviation} ML`;
    pickLabel = spreadLean;
    pickSide  = 'away';
  }

  // ── ML CONFIDENCE ────────────────────────────────────────────────────────
  // LOCK: high win prob + meaningful run edge + confirmed pitcher quality gap.
  // Intentionally rare — each LOCK added to the record must carry real weight.
  const mlIsLock =
    bothKnown &&
    winProb >= 0.62 &&
    Math.abs(runDiff) >= 0.90 &&
    Math.abs(qualityDiff) >= 0.18;

  const confidence: 'LOCK' | 'HIGH' | 'MEDIUM' | 'LOW' =
    mlIsLock        ? 'LOCK'   :
    winProb >= 0.60 ? 'HIGH'   :
    winProb >= 0.55 ? 'MEDIUM' :
    'LOW';

  // ── OVER / UNDER PICK (independent of ML pick) ───────────────────────────
  let totalPick: 'OVER' | 'UNDER' | null = null;
  let totalConfidence: 'LOCK' | 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
  let totalPickLabel = '';

  const maxQuality = Math.max(homeQuality, awayQuality);
  const minQuality = Math.min(homeQuality, awayQuality);

  if (ouLine !== null) {
    // Real sportsbook line available: pick based on how much our projection diverges.
    // Each run of gap ≥ 1.0 is meaningful; pitcher quality confirms the direction.
    const gap = ouLine - projectedTotal; // positive → our proj is lower → UNDER edge

    if (gap >= 1.0) {
      totalPick = 'UNDER';
      totalPickLabel = `UNDER ${ouLine.toFixed(1)}`;
      if (gap >= 2.5 && maxQuality >= 0.62) {
        totalConfidence = 'LOCK';
      } else if (gap >= 1.5 || maxQuality >= 0.62) {
        totalConfidence = 'HIGH';
      } else {
        totalConfidence = 'MEDIUM';
      }
    } else if (gap <= -1.0) {
      totalPick = 'OVER';
      totalPickLabel = `OVER ${ouLine.toFixed(1)}`;
      const absGap = Math.abs(gap);
      if (absGap >= 2.5 && minQuality <= 0.44) {
        totalConfidence = 'LOCK';
      } else if (absGap >= 1.5 || minQuality <= 0.44) {
        totalConfidence = 'HIGH';
      } else {
        totalConfidence = 'MEDIUM';
      }
    }
  } else {
    // Fallback when no real line: compare projection to a neutral 9.0 baseline.
    // UNDER: low total driven by good pitching
    // OVER : high total driven by bad pitching and/or extreme park
    if (projectedTotal <= 7.8) {
      totalPick = 'UNDER';
      totalPickLabel = `UNDER (proj ${projectedTotal.toFixed(1)})`;
      if (projectedTotal <= 6.8 && maxQuality >= 0.68) {
        totalConfidence = 'LOCK';
      } else if (projectedTotal <= 7.3 || maxQuality >= 0.62) {
        totalConfidence = 'HIGH';
      } else {
        totalConfidence = 'MEDIUM';
      }
    } else if (projectedTotal >= 9.8) {
      totalPick = 'OVER';
      totalPickLabel = `OVER (proj ${projectedTotal.toFixed(1)})`;
      if (projectedTotal >= 11.0 && minQuality <= 0.40) {
        totalConfidence = 'LOCK';
      } else if (projectedTotal >= 10.3 || minQuality <= 0.44) {
        totalConfidence = 'HIGH';
      } else {
        totalConfidence = 'MEDIUM';
      }
    }
    // Near 9.0: no pick — too close to neutral to have a reliable edge without a real line
  }

  // ── KEY FACTORS ───────────────────────────────────────────────────────────
  const keyFactors: string[] = [];

  keyFactors.push(`Away: ${pitcherLine(awayPitcher)}`);
  keyFactors.push(`Home: ${pitcherLine(homePitcher)}`);

  if (bothKnown && Math.abs(qualityDiff) >= 0.18) {
    const edgeSide = qualityDiff > 0 ? game.homeTeam.abbreviation : game.awayTeam.abbreviation;
    const edgeStr  = Math.abs(qualityDiff) >= 0.30 ? 'Clear' : 'Slight';
    keyFactors.push(`${edgeStr} pitching edge: ${edgeSide}`);
  }

  if (parkFactors.runsFactor > 1.08) {
    keyFactors.push(`Hitter-friendly park (×${parkFactors.runsFactor.toFixed(2)} runs)`);
  } else if (parkFactors.runsFactor < 0.93) {
    keyFactors.push(`Pitcher-friendly park (×${parkFactors.runsFactor.toFixed(2)} runs)`);
  }

  if (totalPick) {
    keyFactors.push(`O/U signal: projected total ${projectedTotal.toFixed(1)} runs`);
  }

  // ── WEATHER KEY FACTORS ───────────────────────────────────────────────────
  if (weather && !weather.isIndoor) {
    const mph = weather.windSpeedMph;
    const dir = weather.windDirectionLabel;
    const t   = weather.tempF;

    if (mph >= 10) {
      if (dir === 'out to CF') {
        keyFactors.push(`Wind ${mph.toFixed(0)} mph blowing OUT to CF → offense boost`);
      } else if (dir === 'in from CF') {
        keyFactors.push(`Wind ${mph.toFixed(0)} mph blowing IN from CF → offense suppressed`);
      } else {
        keyFactors.push(`Wind ${mph.toFixed(0)} mph crosswind (${dir})`);
      }
    } else if (mph >= 5) {
      keyFactors.push(`Mild wind ${mph.toFixed(0)} mph ${dir}`);
    }

    if (t <= 45) {
      keyFactors.push(`Cold game-time temp ${t.toFixed(0)}°F → ball dies, favor UNDER`);
    } else if (t >= 85) {
      keyFactors.push(`Hot game-time temp ${t.toFixed(0)}°F → ball carries, favor OVER`);
    }

    const precip = weather.precipitationProbability;
    if (precip >= 70) {
      keyFactors.push(`HIGH rain risk (${precip}%) — game-time uncertainty`);
    } else if (precip >= 40) {
      keyFactors.push(`Moderate rain risk (${precip}%) — monitor conditions`);
    }
  }

  return {
    gamePk: game.gamePk,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    homeStartingPitcher: homePitcher,
    awayStartingPitcher: awayPitcher,
    homeWinProbability: homeWinProb,
    awayWinProbability: awayWinProb,
    homeExpectedRuns,
    awayExpectedRuns,
    projectedTotal,
    spreadLean,
    spreadLeanSide,
    confidence,
    pickLabel,
    pickSide,
    totalPick,
    totalConfidence,
    totalPickLabel,
    ouLine,
    venue: game.venue,
    parkFactors,
    weather,
    gameTime: game.gameTime,
    gameDate: game.gameDate,
    keyFactors,
  };
}
