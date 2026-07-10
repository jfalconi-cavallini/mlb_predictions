// ─── GRADING ENGINE ──────────────────────────────────────────────────────────
// Pure functions: turn a locked-in prediction + the real outcome into a
// correct/incorrect record. No I/O here — callers (lib/gradeStore.ts) handle
// fetching actuals and persisting the graded results.
//
// Grading philosophy: only grade what was actually advertised as a pick.
// - Prop tiers: LOW isn't a pick, so it's excluded (not counted as a loss).
// - O/U: only graded when a real sportsbook line existed at pick time —
//   grading the no-line fallback against a synthetic baseline would
//   misrepresent the record against a bet nobody could actually place.
// - A missing/incomplete result (player didn't play, game not final) means
//   the pick is excluded entirely rather than scored as wrong.

import {
  HitterPrediction, GamePrediction, PropType, PlayerGameResult,
  GameActual, PropGrade, GameGrade,
} from '../types';

export function gradeProp(
  date: string,
  prediction: HitterPrediction,
  propType: PropType,
  result: PlayerGameResult | undefined,
): PropGrade | null {
  const explanation = prediction.explanations.find(e => e.prop === propType);
  if (!explanation) return null;
  if (explanation.confidence === 'LOW') return null; // not an advertised pick
  if (!result) return null; // scratched/DNP/no boxscore entry

  const correct = (() => {
    switch (propType) {
      case 'hit': return result.hits >= 1;
      case 'run': return result.runs >= 1;
      case 'rbi': return result.rbi >= 1;
      case 'hr':  return result.homeRuns >= 1;
    }
  })();

  return {
    date,
    playerId: prediction.hitter.id,
    playerName: prediction.hitter.fullName,
    prop: propType,
    tier: explanation.confidence,
    predictedProbability: explanation.probability,
    correct,
  };
}

export function gradeGame(
  date: string,
  prediction: GamePrediction,
  actual: GameActual,
): { ml: GameGrade | null; ou: GameGrade | null; nrfi: GameGrade | null } {
  if (!actual.isFinal) {
    return { ml: null, ou: null, nrfi: null };
  }

  const actualWinnerSide: 'home' | 'away' | null =
    actual.homeRuns === actual.awayRuns ? null : actual.homeRuns > actual.awayRuns ? 'home' : 'away';

  let ml: GameGrade | null = null;
  if (prediction.pickSide && actualWinnerSide) {
    ml = {
      date,
      gamePk: prediction.gamePk,
      pickType: 'ml',
      pickLabel: prediction.pickLabel,
      confidence: prediction.confidence,
      correct: prediction.pickSide === actualWinnerSide,
    };
  }

  let ou: GameGrade | null = null;
  if (prediction.totalPick && prediction.ouLine !== null) {
    const actualTotal = actual.homeRuns + actual.awayRuns;
    const actualResult: 'OVER' | 'UNDER' | null =
      actualTotal === prediction.ouLine ? null : actualTotal > prediction.ouLine ? 'OVER' : 'UNDER';
    if (actualResult) {
      ou = {
        date,
        gamePk: prediction.gamePk,
        pickType: 'ou',
        pickLabel: prediction.totalPickLabel,
        confidence: prediction.totalConfidence,
        correct: prediction.totalPick === actualResult,
      };
    }
  }

  let nrfi: GameGrade | null = null;
  if (prediction.nrfiPick) {
    const anyFirstInningRun = actual.homeFirstInningRuns > 0 || actual.awayFirstInningRuns > 0;
    const actualNrfi: 'NRFI' | 'YRFI' = anyFirstInningRun ? 'YRFI' : 'NRFI';
    nrfi = {
      date,
      gamePk: prediction.gamePk,
      pickType: 'nrfi',
      pickLabel: prediction.nrfiPickLabel,
      confidence: prediction.nrfiConfidence,
      correct: prediction.nrfiPick === actualNrfi,
    };
  }

  return { ml, ou, nrfi };
}
