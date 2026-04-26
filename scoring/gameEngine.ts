import { MLBGame, MLBPitcher, ParkFactors, GamePrediction } from '../types';

const LEAGUE_ERA = 4.20;
const LEAGUE_RUNS_PER_GAME = 4.5;
const HOME_FIELD_BOOST = 1.04;

// Estimate runs scored against a given pitcher using ERA + WHIP blend
function expectedRunsAgainst(pitcher: MLBPitcher | null): number {
  if (!pitcher?.seasonStats) return LEAGUE_RUNS_PER_GAME;
  const ss = pitcher.seasonStats;
  const eraFactor = ss.era / LEAGUE_ERA;
  const whipFactor = ss.whip / 1.30;
  return LEAGUE_RUNS_PER_GAME * (eraFactor * 0.70 + whipFactor * 0.30);
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
  const confidence: 'HIGH' | 'MEDIUM' | 'LOW' =
    winProb >= 0.63 ? 'HIGH' : winProb >= 0.57 ? 'MEDIUM' : 'LOW';

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
