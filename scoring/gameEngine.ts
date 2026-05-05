import { MLBGame, MLBPitcher, ParkFactors, GamePrediction } from '../types';

const LEAGUE_ERA = 4.20;
const LEAGUE_RUNS_PER_GAME = 4.5;
const HOME_FIELD_BOOST = 1.04;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// Estimate expected runs scored against a given pitcher.
// Uses ERA + WHIP as base, then adjusts for K/9 (suppresses) and BB/9 (adds),
// and blends in recent 14-day performance when a meaningful sample exists.
function expectedRunsAgainst(pitcher: MLBPitcher | null): number {
  if (!pitcher?.seasonStats) return LEAGUE_RUNS_PER_GAME;
  const ss = pitcher.seasonStats;

  const eraFactor = ss.era / LEAGUE_ERA;
  const whipFactor = ss.whip / 1.30;

  // High K/9 → pitcher suppresses runs beyond what ERA shows (up to -10%)
  const kAdjust = 1 - clamp((ss.kPer9 - 8.5) / 12, 0, 0.10);
  // High BB/9 → pitcher allows more runners, more runs (up to +8%)
  const bbAdjust = 1 + clamp((ss.bbPer9 - 3.0) / 6.0, 0, 0.08);

  let expected = LEAGUE_RUNS_PER_GAME * (eraFactor * 0.60 + whipFactor * 0.25) * kAdjust * bbAdjust;

  // Blend recent 14-day ERA at 20–25% weight when innings sample is meaningful
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

  const runDiff = homeExpectedRuns - awayExpectedRuns;

  let spreadLean = "Pick'em";
  let spreadLeanSide: 'home' | 'away' | null = null;
  if (runDiff > 0.7) {
    spreadLean = `${game.homeTeam.abbreviation} -1.5 (lean)`;
    spreadLeanSide = 'home';
  } else if (runDiff > 0.3) {
    spreadLean = `${game.homeTeam.abbreviation} ML (lean)`;
    spreadLeanSide = 'home';
  } else if (runDiff < -0.7) {
    spreadLean = `${game.awayTeam.abbreviation} -1.5 (lean)`;
    spreadLeanSide = 'away';
  } else if (runDiff < -0.3) {
    spreadLean = `${game.awayTeam.abbreviation} ML (lean)`;
    spreadLeanSide = 'away';
  }

  const winProb = Math.max(homeWinProb, awayWinProb);
  // In MLB, a 60%+ win probability is a significant edge given parity of the sport.
  const confidence: 'HIGH' | 'MEDIUM' | 'LOW' =
    winProb >= 0.62 ? 'HIGH' : winProb >= 0.56 ? 'MEDIUM' : 'LOW';

  const keyFactors: string[] = [];
  if (awayPitcher?.seasonStats) {
    keyFactors.push(`${awayPitcher.fullName} (${awayPitcher.seasonStats.era.toFixed(2)} ERA)`);
  } else if (awayPitcher) {
    keyFactors.push(`${awayPitcher.fullName} (TBD stats)`);
  }
  if (homePitcher?.seasonStats) {
    keyFactors.push(`${homePitcher.fullName} (${homePitcher.seasonStats.era.toFixed(2)} ERA)`);
  } else if (homePitcher) {
    keyFactors.push(`${homePitcher.fullName} (TBD stats)`);
  }
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
    venue: game.venue,
    parkFactors,
    gameTime: game.gameTime,
    gameDate: game.gameDate,
    keyFactors,
  };
}
