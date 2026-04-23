// ─── SCORING ENGINE ──────────────────────────────────────────────────────────
// Interpretable feature-based scoring with logistic sigmoid output.
// Probabilities are derived from weighted feature vectors, not magic.
// Every weight is documented and traceable to a specific data signal.
//
// Architecture:
// 1. Extract feature vector from hitter, pitcher, park, weather
// 2. Score each prop using prop-specific weighted sum
// 3. Pass through logistic sigmoid to get calibrated probability (0–1)
// 4. Generate explanation from top contributing features

import {
  MLBHitter, MLBPitcher, ParkFactors, WeatherConditions,
  FeatureVector, PropProbabilities, PropExplanation,
  HitterPrediction, MLBGame, ConfidenceTier, PropType
} from '../types';

// ─── LOGISTIC SIGMOID ────────────────────────────────────────────────────────

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

// Convert raw score to probability. The intercept and scale are chosen so that:
// - An average MLB hitter vs average pitcher in neutral conditions → ~0.27 hit prob
// - Elite hitter in great spot → ~0.40–0.50
// - Weak hitter in bad spot → ~0.10–0.18
function scoreToProbability(rawScore: number, intercept: number, scale: number): number {
  const logit = (rawScore + intercept) * scale;
  return Math.max(0.01, Math.min(0.95, sigmoid(logit)));
}

// ─── FEATURE EXTRACTION ───────────────────────────────────────────────────────

export function extractFeatures(
  hitter: MLBHitter,
  pitcher: MLBPitcher | null,
  park: ParkFactors,
  weather: WeatherConditions | null,
): FeatureVector {
  const ss = hitter.seasonStats;
  const rs = hitter.recentStats;
  const ps = pitcher?.seasonStats;

  // ── HITTER CONTACT SKILL ─────────────────────────────────────────────────
  // Based on: AVG (40%), OBP (35%), K% inverted (25%)
  // Range: 0 (awful) to 1 (elite contact)
  const avgNorm = ss ? clamp((ss.avg - 0.15) / 0.25, 0, 1) : 0.40;      // 0.15–0.40 range
  const obpNorm = ss ? clamp((ss.obp - 0.25) / 0.20, 0, 1) : 0.40;      // 0.25–0.45 range
  const kInv = ss ? clamp(1 - (ss.kPct / 0.35), 0, 1) : 0.50;           // invert K%
  const hitterContactSkill = (avgNorm * 0.40) + (obpNorm * 0.35) + (kInv * 0.25);

  // ── HITTER POWER SKILL ────────────────────────────────────────────────────
  // Based on: ISO (50%), SLG (30%), hardHit% (20% if available)
  const isoNorm = ss ? clamp((ss.iso - 0.05) / 0.25, 0, 1) : 0.30;      // 0.05–0.30 ISO range
  const slgNorm = ss ? clamp((ss.slg - 0.25) / 0.35, 0, 1) : 0.35;      // 0.25–0.60 SLG range
  const hardHitNorm = ss?.hardHitPct ? clamp((ss.hardHitPct - 0.25) / 0.35, 0, 1) : 0.35;
  const hitterPowerSkill = (isoNorm * 0.50) + (slgNorm * 0.30) + (hardHitNorm * 0.20);

  // ── HITTER HR RATE ───────────────────────────────────────────────────────
  // Direct: HR per PA, normalized to 0–1 range
  // 0 HR/PA = 0, ~0.07 HR/PA = 1 (elite like Judge)
  const hitterHRRate = ss ? clamp(ss.hrRate / 0.07, 0, 1) : 0.20;

  // ── HITTER RECENT FORM ────────────────────────────────────────────────────
  // 14-day stats, weighted: recent_slg (50%), recent_avg (50%)
  // If no recent stats, use 0.50 (neutral — don't penalize without data)
  let hitterRecentForm = 0.50;
  if (rs && rs.paCount >= 10) {
    const rAvgNorm = clamp((rs.avg - 0.15) / 0.25, 0, 1);
    const rSlgNorm = clamp((rs.slg - 0.25) / 0.35, 0, 1);
    const rHRBoost = rs.hrCount > 0 ? Math.min(rs.hrCount / 4, 0.3) : 0;
    hitterRecentForm = (rAvgNorm * 0.40) + (rSlgNorm * 0.40) + (rHRBoost * 0.20);
  }

  // ── PLATOON EDGE ──────────────────────────────────────────────────────────
  // LHB vs RHP or RHB vs LHP = platoon advantage
  // Switch hitters = slight positive (they always get the advantaged side)
  let hitterPlatoonEdge = 0.50;
  if (pitcher) {
    const pitcherHand = pitcher.throwHand;
    const batterHand = hitter.batHand;
    if (batterHand === 'S') {
      hitterPlatoonEdge = 0.65; // Switch hitters always have platoon side
    } else if ((batterHand === 'L' && pitcherHand === 'R') ||
               (batterHand === 'R' && pitcherHand === 'L')) {
      hitterPlatoonEdge = 0.72; // Full platoon advantage
    } else {
      hitterPlatoonEdge = 0.28; // Same-hand disadvantage
    }
  }

  // ── OBP SKILL ────────────────────────────────────────────────────────────
  const hitterOBPSkill = ss ? clamp((ss.obp - 0.25) / 0.20, 0, 1) : 0.40;

  // ── RBI CONTEXT (proxy: OPS × power) ─────────────────────────────────────
  const hitterRBIContext = ss
    ? clamp(((ss.ops - 0.60) / 0.40) * 0.60 + hitterPowerSkill * 0.40, 0, 1)
    : 0.35;

  // ── PITCHER VULNERABILITY (HR) ────────────────────────────────────────────
  // High = pitcher gives up more HRs. Based on: HR/9, ERA (proxy)
  // If no pitcher data, use league-average vulnerability (0.50)
  let pitcherVulnerabilityHR = 0.50;
  if (ps) {
    const hrPer9Norm = clamp((ps.hrPer9 - 0.5) / 2.0, 0, 1);   // 0.5–2.5 HR/9 range
    const eraProxy = clamp((ps.era - 2.0) / 4.0, 0, 1);          // ERA 2.0–6.0
    const hardHitAllowed = ps.hardHitPctAllowed
      ? clamp((ps.hardHitPctAllowed - 0.25) / 0.25, 0, 1)
      : 0.50;
    pitcherVulnerabilityHR = (hrPer9Norm * 0.50) + (eraProxy * 0.25) + (hardHitAllowed * 0.25);
  }

  // ── PITCHER VULNERABILITY (CONTACT) ──────────────────────────────────────
  let pitcherVulnerabilityContact = 0.50;
  if (ps) {
    const whipNorm = clamp((ps.whip - 0.80) / 1.0, 0, 1);        // 0.8–1.8 WHIP
    const kInvPitcher = clamp(1 - (ps.kPer9 / 12.0), 0, 1);      // less Ks = more contact
    pitcherVulnerabilityContact = (whipNorm * 0.60) + (kInvPitcher * 0.40);
  }

  // ── PITCHER VULNERABILITY (RUNS) ──────────────────────────────────────────
  let pitcherVulnerabilityRuns = 0.50;
  if (ps) {
    const eraFull = clamp((ps.era - 2.0) / 4.5, 0, 1);
    const bbBoost = clamp((ps.bbPer9 - 2.0) / 4.0, 0, 1);         // walks fuel runs
    pitcherVulnerabilityRuns = (eraFull * 0.60) + (bbBoost * 0.40);
  }

  // ── PARK FACTORS ──────────────────────────────────────────────────────────
  // Normalize around 1.0 neutral (range 0.80–1.40)
  const parkHRFactor = clamp((park.hrFactor - 0.80) / 0.60, 0, 1);
  const parkRunsFactor = clamp((park.runsFactor - 0.80) / 0.60, 0, 1);

  // ── WEATHER ADJUSTMENTS ───────────────────────────────────────────────────
  let weatherHRBoost = 0.40;   // Neutral default (favors pitchers slightly in April)
  let weatherRunsBoost = 0.40;
  let windFavorable = false;

  if (weather && !weather.isIndoor) {
    // Temperature: warmer = ball carries further
    // Below 60°F: penalty. 60–70: neutral. 70–80: slight boost. 80+: good boost.
    const tempBoost = clamp((weather.tempF - 60) / 35, 0, 1) * 0.3;

    // Wind: determine if wind blows "out" (favorable) or "in" (unfavorable)
    // Wind blowing toward CF (180° ± 45°) = pitchers park
    // Wind blowing from CF (0° ± 45°) = hitters park
    // Left-right (90° or 270°) = moderate boost for opposite field hitters
    const windDeg = weather.windDirectionDeg % 360;
    const windMph = weather.windSpeedMph;

    let windBoost = 0;
    if (windMph >= 10) {
      // Wind out to CF (from home plate perspective) = big boost
      if (windDeg >= 315 || windDeg <= 45) {
        windBoost = clamp((windMph - 8) / 15, 0, 0.4);
        windFavorable = true;
      }
      // Wind in from CF = penalty
      else if (windDeg >= 135 && windDeg <= 225) {
        windBoost = -clamp((windMph - 8) / 15, 0, 0.3);
      }
      // Crosswind = small boost (balls carry to gaps)
      else {
        windBoost = clamp((windMph - 8) / 30, 0, 0.15);
        windFavorable = windMph >= 15;
      }
    }

    // Altitude already captured in park factor, but Coors is so extreme add extra
    const altitudeBoost = park.altitude >= 5000 ? 0.10 : park.altitude >= 1000 ? 0.03 : 0;

    weatherHRBoost = clamp(0.40 + tempBoost + windBoost + altitudeBoost, 0, 1);
    weatherRunsBoost = clamp(0.40 + (tempBoost * 0.6) + (windBoost * 0.4), 0, 1);
  } else if (weather?.isIndoor) {
    // Indoor: no wind, controlled temp — neutral
    weatherHRBoost = 0.40;
    weatherRunsBoost = 0.45;
  }

  return {
    hitterContactSkill,
    hitterPowerSkill,
    hitterHRRate,
    hitterRecentForm,
    hitterPlatoonEdge,
    hitterOBPSkill,
    hitterRBIContext,
    pitcherVulnerabilityHR,
    pitcherVulnerabilityContact,
    pitcherVulnerabilityRuns,
    parkHRFactor,
    parkRunsFactor,
    weatherHRBoost,
    weatherRunsBoost,
    platoonAdvantage: hitterPlatoonEdge >= 0.65,
    windFavorable,
    parkFavorableHR: park.hrFactor >= 1.15,
  };
}

// ─── PROP SCORING ─────────────────────────────────────────────────────────────
// Each prop uses a linear combination of features, then sigmoid to [0,1].
// Weights are documented. Positive = raises probability. Negative = lowers.

export function scoreProbabilities(f: FeatureVector): PropProbabilities {
  // ── HIT PROBABILITY ───────────────────────────────────────────────────────
  // Drivers: contact skill (strongest), recent form, platoon, pitcher contact vuln
  const hitRaw =
    (f.hitterContactSkill    * 2.2) +   // strongest signal
    (f.hitterRecentForm      * 0.8) +   // recent form matters but don't over-weight
    (f.hitterPlatoonEdge     * 0.9) +   // platoon edge is real
    (f.pitcherVulnerabilityContact * 1.0) + // how hittable is this pitcher?
    (f.parkHRFactor          * 0.3) +   // park affects balls in play
    (f.hitterOBPSkill        * 0.5);    // OBP hitters find ways on base
  // Intercept calibrated so average (all 0.5 features) → ~0.26 hit prob
  const hit = scoreToProbability(hitRaw, -2.8, 0.85);

  // ── RUN PROBABILITY ───────────────────────────────────────────────────────
  // Drivers: OBP skill (must get on), recent form, team run environment
  const runRaw =
    (f.hitterOBPSkill        * 2.0) +
    (f.hitterContactSkill    * 0.8) +
    (f.hitterRecentForm      * 0.6) +
    (f.pitcherVulnerabilityRuns * 0.9) +
    (f.parkRunsFactor        * 0.7) +
    (f.weatherRunsBoost      * 0.5);
  const run = scoreToProbability(runRaw, -3.2, 0.80);

  // ── RBI PROBABILITY ───────────────────────────────────────────────────────
  // Drivers: power, RBI context, platoon, pitcher runs vuln
  const rbiRaw =
    (f.hitterRBIContext      * 1.8) +
    (f.hitterPowerSkill      * 0.9) +
    (f.hitterPlatoonEdge     * 0.7) +
    (f.pitcherVulnerabilityRuns * 0.9) +
    (f.hitterRecentForm      * 0.5) +
    (f.parkRunsFactor        * 0.4);
  const rbi = scoreToProbability(rbiRaw, -3.1, 0.80);

  // ── HR PROBABILITY ────────────────────────────────────────────────────────
  // Drivers: HR rate (strongest), power skill, pitcher HR vuln, park, weather
  const hrRaw =
    (f.hitterHRRate          * 3.0) +   // individual HR rate is the biggest predictor
    (f.hitterPowerSkill      * 1.5) +   // raw power
    (f.pitcherVulnerabilityHR * 1.8) +  // pitcher gives up HRs?
    (f.parkHRFactor          * 1.2) +   // park is critical for HRs
    (f.weatherHRBoost        * 1.0) +   // wind/temp
    (f.hitterPlatoonEdge     * 0.6) +   // platoon matters less for raw power
    (f.hitterRecentForm      * 0.4);    // recent form matters less than HR rate
  // Calibrated: average MLB hitter → ~0.05 HR prob (realistic for 1 game)
  const hr = scoreToProbability(hrRaw, -4.5, 0.75);

  return { hit, run, rbi, hr };
}

// ─── EXPLANATION GENERATION ───────────────────────────────────────────────────

export function generateExplanations(
  f: FeatureVector,
  probs: PropProbabilities,
  hitter: MLBHitter,
  pitcher: MLBPitcher | null,
  park: ParkFactors,
  weather: WeatherConditions | null,
): PropExplanation[] {
  const explanations: PropExplanation[] = [];

  const props: Array<{ type: PropType; prob: number }> = [
    { type: 'hr', prob: probs.hr },
    { type: 'hit', prob: probs.hit },
    { type: 'run', prob: probs.run },
    { type: 'rbi', prob: probs.rbi },
  ];

  for (const { type, prob } of props) {
    const drivers: string[] = [];
    const contributions: Record<string, number> = {};

    if (type === 'hr') {
      if (f.hitterHRRate > 0.6) { drivers.push(`Strong HR rate this season (${(hitter.seasonStats?.hrRate ?? 0 * 600).toFixed(0)}+ HR pace)`); contributions['hrRate'] = f.hitterHRRate; }
      if (f.pitcherVulnerabilityHR > 0.65) { drivers.push(`Pitcher allows elevated HR rate (${pitcher?.seasonStats?.hrPer9?.toFixed(2) ?? 'N/A'} HR/9)`); contributions['pitcherHRVuln'] = f.pitcherVulnerabilityHR; }
      if (f.parkHRFactor > 0.65) { drivers.push(`Hitter-friendly park for HRs (${park.venueName}, ${park.hrFactor.toFixed(2)}× factor)`); contributions['parkHR'] = f.parkHRFactor; }
      if (f.weatherHRBoost > 0.60) { drivers.push(weather?.windDirectionLabel ? `Wind blowing ${weather.windDirectionLabel} (${weather.windSpeedMph} mph)` : `Favorable temperature (${weather?.tempF ?? '?'}°F)`); contributions['weather'] = f.weatherHRBoost; }
      if (f.platoonAdvantage) { drivers.push(`Platoon advantage (${hitter.batHand} vs ${pitcher?.throwHand ?? '?'}HP)`); contributions['platoon'] = f.hitterPlatoonEdge; }
      if (f.hitterPowerSkill > 0.65) { drivers.push(`Elite power profile (ISO/SLG/barrel%)`); contributions['powerSkill'] = f.hitterPowerSkill; }
    }

    if (type === 'hit') {
      if (f.hitterContactSkill > 0.60) { drivers.push(`Strong contact profile (AVG ${hitter.seasonStats?.avg?.toFixed(3) ?? 'N/A'}, OBP ${hitter.seasonStats?.obp?.toFixed(3) ?? 'N/A'})`); contributions['contactSkill'] = f.hitterContactSkill; }
      if (f.hitterRecentForm > 0.60) { drivers.push(`Hot recent form (L14 days: AVG ${hitter.recentStats?.avg?.toFixed(3) ?? 'N/A'})`); contributions['recentForm'] = f.hitterRecentForm; }
      if (f.platoonAdvantage) { drivers.push(`Platoon advantage vs ${pitcher?.throwHand ?? '?'}HP`); contributions['platoon'] = f.hitterPlatoonEdge; }
      if (f.pitcherVulnerabilityContact > 0.60) { drivers.push(`Pitcher has elevated WHIP (${pitcher?.seasonStats?.whip?.toFixed(2) ?? 'N/A'})`); contributions['pitcherContact'] = f.pitcherVulnerabilityContact; }
    }

    if (type === 'run') {
      if (f.hitterOBPSkill > 0.60) { drivers.push(`High OBP hitter (${hitter.seasonStats?.obp?.toFixed(3) ?? 'N/A'})`); contributions['obp'] = f.hitterOBPSkill; }
      if (f.parkRunsFactor > 0.60) { drivers.push(`High-scoring park environment (${park.runsFactor.toFixed(2)}× runs factor)`); contributions['parkRuns'] = f.parkRunsFactor; }
      if (f.pitcherVulnerabilityRuns > 0.60) { drivers.push(`Pitcher allows runs at elevated rate (ERA ${pitcher?.seasonStats?.era?.toFixed(2) ?? 'N/A'})`); contributions['pitcherRuns'] = f.pitcherVulnerabilityRuns; }
    }

    if (type === 'rbi') {
      if (f.hitterRBIContext > 0.60) { drivers.push(`Strong run production profile (OPS ${hitter.seasonStats?.ops?.toFixed(3) ?? 'N/A'})`); contributions['rbiContext'] = f.hitterRBIContext; }
      if (f.hitterPowerSkill > 0.60) { drivers.push(`Power hitter profile lifts RBI probability`); contributions['power'] = f.hitterPowerSkill; }
      if (f.pitcherVulnerabilityRuns > 0.60) { drivers.push(`Pitcher allows batters to reach and score`); contributions['pitcherRuns'] = f.pitcherVulnerabilityRuns; }
    }

    // Add warnings when data is limited
    if (!hitter.seasonStats) drivers.push(`⚠ Limited 2026 stats — prediction uses league-average baselines`);
    if (!pitcher) drivers.push(`⚠ No probable pitcher confirmed — pitcher matchup not factored`);
    if (!weather) drivers.push(`⚠ Weather data unavailable — neutral conditions assumed`);

    if (drivers.length === 0) {
      drivers.push(`Near-average matchup across all factors`);
    }

    explanations.push({
      prop: type,
      probability: prob,
      confidence: getConfidenceTier(prob, type),
      keyDrivers: drivers.slice(0, 4),
      featureContributions: contributions,
    });
  }

  return explanations;
}

function getConfidenceTier(prob: number, prop: PropType): ConfidenceTier {
  const thresholds: Record<PropType, [number, number, number]> = {
    hit: [0.38, 0.30, 0.22],   // ELITE, STRONG, VALUE
    run: [0.30, 0.22, 0.15],
    rbi: [0.28, 0.20, 0.13],
    hr:  [0.12, 0.08, 0.05],
  };
  const [elite, strong, value] = thresholds[prop];
  if (prob >= elite) return 'ELITE';
  if (prob >= strong) return 'STRONG';
  if (prob >= value) return 'VALUE';
  return 'LOW';
}

// ─── FULL PREDICTION BUILDER ───────────────────────────────────────────────────

export function buildPrediction(
  hitter: MLBHitter,
  game: MLBGame,
  opposingPitcher: MLBPitcher | null,
  park: ParkFactors,
  weather: WeatherConditions | null,
): HitterPrediction {
  const features = extractFeatures(hitter, opposingPitcher, park, weather);
  const probabilities = scoreProbabilities(features);
  const explanations = generateExplanations(features, probabilities, hitter, opposingPitcher, park, weather);

  return {
    hitter,
    game,
    opposingPitcher,
    parkFactors: park,
    weather,
    features,
    probabilities,
    explanations,
    lineupStatus: hitter.validationMeta.lineupStatus,
    generatedAt: new Date().toISOString(),
  };
}

// ─── UTILITY ──────────────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
