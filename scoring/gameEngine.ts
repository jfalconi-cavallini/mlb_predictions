import { MLBGame, MLBPitcher, ParkFactors, GamePrediction } from '../types';

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

export function scoreGame(game: MLBGame, parkFactors: ParkFactors): GamePrediction {
  const homePitcher = game.probableHomePitcher;
  const awayPitcher = game.probableAwayPitcher;

  // Home team scores against the away pitcher; apply park runs factor
  const rawHomeRuns = expectedRunsAgainst(awayPitcher) * parkFactors.runsFactor;
  const rawAwayRuns = expectedRunsAgainst(homePitcher) * parkFactors.runsFactor;

  // Home field advantage
  const homeExpectedRuns = rawHomeRuns * HOME_FIELD_BOOST;
  const awayExpectedRuns = rawAwayRuns;

  const homeWinProb = pythagoreanWinPct(homeExpectedRuns, awayExpectedRuns);
  const awayWinProb = 1 - homeWinProb;
  const winProb = Math.max(homeWinProb, awayWinProb);

  const runDiff = homeExpectedRuns - awayExpectedRuns; // positive = home team favored

  // ── PITCHER QUALITY DIFFERENTIAL ─────────────────────────────────────────
  const homeQuality = pitcherQualityScore(homePitcher);
  const awayQuality = pitcherQualityScore(awayPitcher);
  // Positive = home pitcher better; negative = away pitcher better
  const qualityDiff = homeQuality - awayQuality;

  // ── SPREAD LEAN ───────────────────────────────────────────────────────────
  // Only recommend -1.5 (run line) when run differential and win prob are both high
  let spreadLean = "Pick'em";
  let spreadLeanSide: 'home' | 'away' | null = null;

  if (runDiff > 0) {
    spreadLeanSide = 'home';
    if (runDiff > 1.2 && winProb >= 0.63) {
      spreadLean = `${game.homeTeam.abbreviation} -1.5`;
    } else if (runDiff > 0.35) {
      spreadLean = `${game.homeTeam.abbreviation} ML`;
    } else {
      spreadLean = "Pick'em";
      spreadLeanSide = null;
    }
  } else if (runDiff < 0) {
    spreadLeanSide = 'away';
    if (runDiff < -1.2 && winProb >= 0.63) {
      spreadLean = `${game.awayTeam.abbreviation} -1.5`;
    } else if (runDiff < -0.35) {
      spreadLean = `${game.awayTeam.abbreviation} ML`;
    } else {
      spreadLean = "Pick'em";
      spreadLeanSide = null;
    }
  }

  // ── CONFIDENCE + LOCK DETECTION ──────────────────────────────────────────
  // LOCK: strong win probability AND meaningful pitcher quality edge AND run differential
  // This is intentionally rare — diluting LOCKs destroys their tracking value.
  const bothPitchersKnown = homePitcher?.seasonStats != null && awayPitcher?.seasonStats != null;
  const isLock =
    bothPitchersKnown &&
    winProb >= 0.62 &&
    Math.abs(runDiff) >= 0.90 &&
    Math.abs(qualityDiff) >= 0.18;

  const confidence: 'LOCK' | 'HIGH' | 'MEDIUM' | 'LOW' =
    isLock      ? 'LOCK'   :
    winProb >= 0.60 ? 'HIGH'   :
    winProb >= 0.55 ? 'MEDIUM' :
    'LOW';

  // ── PICK LABEL (for record tracking) ─────────────────────────────────────
  // Expressed as the recommended moneyline or run-line bet, or "Pass".
  let pickLabel = "Pass";
  let pickSide: 'home' | 'away' | null = null;
  if (spreadLeanSide) {
    pickLabel = spreadLean;
    pickSide = spreadLeanSide;
  }

  // ── KEY FACTORS ───────────────────────────────────────────────────────────
  const keyFactors: string[] = [];

  // Always lead with full pitcher stat lines
  keyFactors.push(`Away: ${pitcherLine(awayPitcher)}`);
  keyFactors.push(`Home: ${pitcherLine(homePitcher)}`);

  // Pitcher quality edge call-out
  if (bothPitchersKnown && Math.abs(qualityDiff) >= 0.18) {
    const edgeSide = qualityDiff > 0 ? game.homeTeam.abbreviation : game.awayTeam.abbreviation;
    const edgeStrength = Math.abs(qualityDiff) >= 0.30 ? 'clear' : 'slight';
    keyFactors.push(`${edgeStrength.charAt(0).toUpperCase() + edgeStrength.slice(1)} pitching edge: ${edgeSide}`);
  }

  // Park environment
  if (parkFactors.runsFactor > 1.08) {
    keyFactors.push(`Hitter-friendly park (×${parkFactors.runsFactor.toFixed(2)} runs)`);
  } else if (parkFactors.runsFactor < 0.93) {
    keyFactors.push(`Pitcher-friendly park (×${parkFactors.runsFactor.toFixed(2)} runs)`);
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
    spreadLean,
    spreadLeanSide,
    confidence,
    pickLabel,
    pickSide,
    venue: game.venue,
    parkFactors,
    gameTime: game.gameTime,
    gameDate: game.gameDate,
    keyFactors,
  };
}
