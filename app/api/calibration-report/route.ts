// GET /api/calibration-report
// Suggest-only self-improvement report. Compares realized hit rates (from
// graded history) against the live engine's calibration and confidence-tier
// thresholds, and recommends changes that would raise the correctness
// percentage. Nothing here is applied automatically — scoring/engine.ts and
// scoring/gameEngine.ts are only ever edited by hand.

import { NextResponse } from 'next/server';
import { loadAllGrades, aggregateWindow } from '../../../lib/gradeStore';
import { PROP_CALIBRATION } from '../../../scoring/engine';
import {
  PropType, HitRateBucket, CalibrationSuggestion, ConfidenceTierFlag,
  CalibrationReportAPIResponse,
} from '../../../types';

const PROP_TYPES: PropType[] = ['hit', 'run', 'rbi', 'hr'];
const MIN_PROP_SAMPLE = 100;
const MIN_TIER_SAMPLE = 30;
const MIN_GAME_LOCK_SAMPLE = 15;

function logit(p: number): number {
  const clamped = Math.min(0.99, Math.max(0.01, p));
  return Math.log(clamped / (1 - clamped));
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function checkTierOrder(
  category: string,
  tiersInOrder: Array<{ name: string; bucket: HitRateBucket; minN: number }>,
): ConfidenceTierFlag[] {
  const flags: ConfidenceTierFlag[] = [];
  for (let i = 0; i < tiersInOrder.length - 1; i++) {
    const higher = tiersInOrder[i];
    const lower = tiersInOrder[i + 1];
    if (higher.bucket.total < higher.minN || lower.bucket.total < lower.minN) continue;
    if (higher.bucket.rate === null || lower.bucket.rate === null) continue;
    if (lower.bucket.rate > higher.bucket.rate) {
      flags.push({
        category,
        higherTier: higher.name,
        lowerTier: lower.name,
        higherTierRate: higher.bucket.rate,
        lowerTierRate: lower.bucket.rate,
        note: `${lower.name} (${pct(lower.bucket.rate)}, n=${lower.bucket.total}) is outperforming ${higher.name} `
          + `(${pct(higher.bucket.rate)}, n=${higher.bucket.total}) in ${category} — the ${higher.name} threshold is `
          + `too loose to mean what it claims. Tightening it should raise overall correctness.`,
      });
    }
  }
  return flags;
}

export async function GET(): Promise<NextResponse> {
  const grades = await loadAllGrades();
  const allProps = grades.flatMap(g => g.propGrades);
  const allTime = aggregateWindow(grades, null);

  // ── Prop probability calibration: shift intercept toward realized rate ─────
  const propSuggestions: CalibrationSuggestion[] = PROP_TYPES.map((prop) => {
    const picks = allProps.filter(p => p.prop === prop); // ELITE+STRONG+VALUE only (LOW never graded)
    const n = picks.length;
    const { intercept, scale } = PROP_CALIBRATION[prop];

    if (n < MIN_PROP_SAMPLE) {
      return {
        prop,
        sampleSize: n,
        predictedAvgProbability: n > 0 ? picks.reduce((s, p) => s + p.predictedProbability, 0) / n : 0,
        actualHitRate: n > 0 ? picks.filter(p => p.correct).length / n : 0,
        currentIntercept: intercept,
        currentScale: scale,
        suggestedIntercept: null,
        note: `Insufficient sample (n=${n}, need ${MIN_PROP_SAMPLE}+) to safely suggest a calibration change.`,
      };
    }

    const predictedAvg = picks.reduce((s, p) => s + p.predictedProbability, 0) / n;
    const actualRate = picks.filter(p => p.correct).length / n;
    const suggestedIntercept = intercept + (logit(actualRate) - logit(predictedAvg)) / scale;
    const gap = actualRate - predictedAvg;
    const direction = gap > 0 ? 'under-calling' : 'over-calling';

    return {
      prop,
      sampleSize: n,
      predictedAvgProbability: predictedAvg,
      actualHitRate: actualRate,
      currentIntercept: intercept,
      currentScale: scale,
      suggestedIntercept,
      note: Math.abs(gap) < 0.02
        ? `Well calibrated (predicted ${pct(predictedAvg)} vs actual ${pct(actualRate)}, n=${n}). No change recommended.`
        : `Engine is ${direction} ${prop.toUpperCase()} (predicted avg ${pct(predictedAvg)} vs actual ${pct(actualRate)}, n=${n}). `
          + `Shifting intercept from ${intercept.toFixed(2)} to ${suggestedIntercept.toFixed(2)} would align predicted probability with reality.`,
    };
  });

  // ── Confidence tier ordering sanity (should this tier maximize correctness?) ─
  const tierFlags: ConfidenceTierFlag[] = [];
  for (const prop of PROP_TYPES) {
    tierFlags.push(...checkTierOrder(`${prop} prop`, [
      { name: 'ELITE', bucket: allTime.props[prop].ELITE, minN: MIN_TIER_SAMPLE },
      { name: 'STRONG', bucket: allTime.props[prop].STRONG, minN: MIN_TIER_SAMPLE },
      { name: 'VALUE', bucket: allTime.props[prop].VALUE, minN: MIN_TIER_SAMPLE },
    ]));
  }
  tierFlags.push(...checkTierOrder('ML game pick', [
    { name: 'LOCK', bucket: allTime.games.ml.LOCK, minN: MIN_GAME_LOCK_SAMPLE },
    { name: 'HIGH', bucket: allTime.games.ml.HIGH, minN: MIN_TIER_SAMPLE },
    { name: 'MEDIUM', bucket: allTime.games.ml.MEDIUM, minN: MIN_TIER_SAMPLE },
  ]));
  tierFlags.push(...checkTierOrder('O/U game pick', [
    { name: 'LOCK', bucket: allTime.games.ou.LOCK, minN: MIN_GAME_LOCK_SAMPLE },
    { name: 'HIGH', bucket: allTime.games.ou.HIGH, minN: MIN_TIER_SAMPLE },
    { name: 'MEDIUM', bucket: allTime.games.ou.MEDIUM, minN: MIN_TIER_SAMPLE },
  ]));
  tierFlags.push(...checkTierOrder('NRFI/YRFI game pick', [
    { name: 'LOCK', bucket: allTime.games.nrfi.LOCK, minN: MIN_GAME_LOCK_SAMPLE },
    { name: 'HIGH', bucket: allTime.games.nrfi.HIGH, minN: MIN_TIER_SAMPLE },
    { name: 'MEDIUM', bucket: allTime.games.nrfi.MEDIUM, minN: MIN_TIER_SAMPLE },
  ]));

  const body: CalibrationReportAPIResponse = {
    propSuggestions,
    tierFlags,
    generatedAt: new Date().toISOString(),
  };

  return NextResponse.json(body);
}
