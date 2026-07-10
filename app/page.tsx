'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  PredictionAPIResponse, HitterPrediction, PropType, ConfidenceTier, GamePredictionAPIResponse, GamePrediction,
  GameResultsAPIResponse, PlayerGameResult, TrackRecordAPIResponse, CalibrationReportAPIResponse, HitRateBucket,
  TrackRecordWindow, GamePickType, GameConfidenceTier,
} from '../types';

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function pct(v: number): string {
  return (v * 100).toFixed(1) + '%';
}

function fmt(v: number | null | undefined, decimals = 3): string {
  if (v == null || isNaN(v)) return '—';
  return v.toFixed(decimals);
}

function tierClass(tier: ConfidenceTier): string {
  return {
    ELITE: 'tier-elite',
    STRONG: 'tier-strong',
    VALUE: 'tier-value',
    LOW: 'tier-low',
  }[tier];
}

function probBarColor(prob: number): string {
  // Thresholds match the (post-2026-07-10 recalibration) HR ELITE/STRONG/VALUE
  // cutoffs — Hit/Run/RBI probabilities always clear the top bucket already.
  if (prob >= 0.065) return 'bg-yellow-400';
  if (prob >= 0.039) return 'bg-green-500';
  if (prob >= 0.021) return 'bg-blue-500';
  return 'bg-slate-600';
}

// ─── RESULT HELPERS ───────────────────────────────────────────────────────────

function propHit(prop: PropType, result: PlayerGameResult): boolean {
  if (prop === 'hit') return result.hits > 0;
  if (prop === 'run') return result.runs > 0;
  if (prop === 'rbi') return result.rbi > 0;
  return result.homeRuns > 0;
}

function propStatLabel(prop: PropType, result: PlayerGameResult): string {
  if (prop === 'hit') return `${result.hits}H / ${result.atBats}AB`;
  if (prop === 'run') return `${result.runs}R`;
  if (prop === 'rbi') return `${result.rbi}RBI`;
  return `${result.homeRuns}HR`;
}

// ─── PREDICTION CARD ──────────────────────────────────────────────────────────

function PredictionCard({
  pred,
  rank,
  activeProp,
  playerResult,
}: {
  pred: HitterPrediction;
  rank: number;
  activeProp: PropType;
  playerResult: PlayerGameResult | null;
}) {
  const { hitter, game, opposingPitcher, parkFactors, probabilities, explanations, lineupStatus } = pred;
  const explanation = explanations.find(e => e.prop === activeProp);
  const prob = probabilities[activeProp];
  const matchup = `${game.awayTeam.abbreviation || game.awayTeam.name} @ ${game.homeTeam.abbreviation || game.homeTeam.name}`;

  const isHit = playerResult ? propHit(activeProp, playerResult) : null;

  const resultBorder =
    isHit === true ? 'border-green-600 ring-1 ring-green-600/40' :
    isHit === false ? 'border-red-800 ring-1 ring-red-800/30' :
    '';

  const statLabel = playerResult ? propStatLabel(activeProp, playerResult) : null;

  const resultBadge = statLabel ? (
    <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${
      isHit
        ? 'text-green-400 bg-green-950/60 border-green-700'
        : 'text-red-400 bg-red-950/60 border-red-800'
    }`}>{statLabel}</span>
  ) : null;

  return (
    <div className={`card hover:border-slate-700 transition-colors ${resultBorder}`}>
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-3">
          <span className="text-slate-500 font-mono text-sm w-6 shrink-0">#{rank}</span>
          <div>
            <div className="font-bold text-white text-sm flex items-center gap-2 flex-wrap">
              {hitter.fullName}
              {resultBadge}
            </div>
            <div className="text-slate-400 text-xs flex items-center gap-1.5 mt-0.5">
              <span>{hitter.team.abbreviation || hitter.team.name}</span>
              <span className="text-slate-600">·</span>
              <span>{hitter.primaryPosition}</span>
              <span className="text-slate-600">·</span>
              <span>{hitter.batHand}HB</span>
              {lineupStatus !== 'PRE_LINEUP' && (
                <>
                  <span className="text-slate-600">·</span>
                  <span className={lineupStatus === 'CONFIRMED' ? 'text-green-400' : 'text-yellow-400'}>
                    {lineupStatus}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="text-right shrink-0">
          <div className="font-mono text-xl font-bold text-white">{pct(prob)}</div>
          {explanation && (
            <span className={`stat-pill text-xs ${tierClass(explanation.confidence)}`}>
              {explanation.confidence}
            </span>
          )}
        </div>
      </div>

      <div className="h-1.5 bg-slate-800 rounded-full mb-3 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${probBarColor(prob)}`}
          style={{ width: `${Math.min(prob * (activeProp === 'hr' ? 20 : 6), 1) * 100}%` }}
        />
      </div>

      {/* All 4 prop probabilities + actual results if available */}
      <div className="grid grid-cols-4 gap-1.5 mb-3">
        {(['hr', 'hit', 'run', 'rbi'] as PropType[]).map(p => {
          const ex = explanations.find(e => e.prop === p);
          const actualHit = playerResult ? propHit(p, playerResult) : null;
          const actualLabel = playerResult ? propStatLabel(p, playerResult) : null;
          return (
            <div
              key={p}
              className={`text-center p-1.5 rounded-lg ${
                activeProp === p ? 'bg-slate-800 ring-1 ring-slate-600' : 'bg-slate-900'
              } ${actualHit === true ? 'ring-1 ring-green-700/50' : actualHit === false ? 'ring-1 ring-red-900/50' : ''}`}
            >
              <div className="text-slate-400 text-xs uppercase tracking-wider">{p}</div>
              <div className="font-mono font-bold text-sm text-white">{pct(probabilities[p])}</div>
              {actualLabel && (
                <div className={`text-[10px] font-mono mt-0.5 ${actualHit ? 'text-green-400' : 'text-red-400'}`}>
                  {actualLabel}
                </div>
              )}
              {!actualLabel && ex && (
                <span className={`stat-pill text-[10px] ${tierClass(ex.confidence)}`}>
                  {ex.confidence}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {playerResult && (
        <div className="flex flex-wrap gap-1.5 text-xs mb-3">
          <span className="stat-pill bg-slate-800/80 text-slate-400 font-mono">
            <span className="text-slate-500">RESULT</span>{' '}
            <span className={playerResult.hits > 0 ? 'text-green-400' : 'text-slate-400'}>{playerResult.hits}H</span>
            <span className="text-slate-600">/</span>
            <span className="text-slate-300">{playerResult.atBats}AB</span>
            {' · '}
            <span className={playerResult.runs > 0 ? 'text-green-400' : 'text-slate-400'}>{playerResult.runs}R</span>
            {' · '}
            <span className={playerResult.rbi > 0 ? 'text-green-400' : 'text-slate-400'}>{playerResult.rbi}RBI</span>
            {playerResult.homeRuns > 0 && (
              <><span className="text-slate-600"> · </span><span className="text-yellow-400">{playerResult.homeRuns}HR</span></>
            )}
            {' · '}
            <span className={playerResult.totalBases >= 2 ? 'text-green-400' : 'text-slate-400'}>{playerResult.totalBases}TB</span>
          </span>
        </div>
      )}

      <div className="flex flex-wrap gap-2 text-xs text-slate-400 mb-3">
        <span className="stat-pill bg-slate-800 text-slate-300">{matchup} · {game.gameTime} ET</span>
        {opposingPitcher && (
          <span className="stat-pill bg-slate-800 text-slate-300">
            vs {opposingPitcher.fullName} ({opposingPitcher.throwHand}HP)
          </span>
        )}
        <span className="stat-pill bg-slate-800 text-slate-300">
          {parkFactors.venueName} · HR×{parkFactors.hrFactor.toFixed(2)}
        </span>
      </div>

      {hitter.seasonStats && (
        <div className="flex flex-wrap gap-2 text-xs mb-3">
          {[
            { label: 'AVG', val: fmt(hitter.seasonStats.avg) },
            { label: 'OBP', val: fmt(hitter.seasonStats.obp) },
            { label: 'SLG', val: fmt(hitter.seasonStats.slg) },
            { label: 'ISO', val: fmt(hitter.seasonStats.iso) },
            { label: 'K%', val: pct(hitter.seasonStats.kPct) },
            { label: 'PA', val: String(hitter.seasonStats.paCount) },
          ].map(({ label, val }) => (
            <span key={label} className="stat-pill bg-slate-800 text-slate-300">
              <span className="text-slate-500">{label}</span> {val}
            </span>
          ))}
          {hitter.recentStats && (
            <span className="stat-pill bg-slate-800 text-amber-300">
              <span className="text-slate-500">L{hitter.recentStats.windowDays}</span>{' '}
              {fmt(hitter.recentStats.avg)}/{fmt(hitter.recentStats.slg)}
              {hitter.recentStats.hrCount > 0 && ` · ${hitter.recentStats.hrCount}HR`}
            </span>
          )}
        </div>
      )}

      {explanation && explanation.keyDrivers.length > 0 && (
        <ul className="space-y-1">
          {explanation.keyDrivers.map((d, i) => (
            <li key={i} className="text-xs text-slate-400 flex items-start gap-1.5">
              <span className="text-slate-600 mt-0.5">›</span>
              <span>{d}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── GAME PICK CARD ───────────────────────────────────────────────────────────

function confBadgeColor(conf: 'LOCK' | 'HIGH' | 'MEDIUM' | 'LOW'): string {
  return conf === 'LOCK' ? 'text-yellow-400' :
         conf === 'HIGH' ? 'text-green-400'  :
         conf === 'MEDIUM' ? 'text-blue-400' :
         'text-slate-500';
}

function GamePickCard({ game }: { game: GamePrediction }) {
  const mlIsLock    = game.confidence === 'LOCK';
  const ouIsLock    = game.totalConfidence === 'LOCK';
  const nrfiIsLock  = game.nrfiConfidence === 'LOCK' && game.nrfiPick !== null;
  const anyLock     = mlIsLock || ouIsLock || nrfiIsLock;
  const pickHome  = game.pickSide === 'home';
  const pickAway  = game.pickSide === 'away';

  const mlPct = Math.max(game.homeWinProbability, game.awayWinProbability);
  // O/U hit-rate estimate: deviation of our projection from the real line (or neutral 9.0) × 10 pp.
  const ouBaseline = game.ouLine ?? 9.0;
  const ouPct = game.totalPick
    ? Math.min(0.50 + Math.abs(game.projectedTotal - ouBaseline) * 0.10, 0.80)
    : null;

  const cardClass = anyLock
    ? 'card border-yellow-500/50 ring-1 ring-yellow-500/15 hover:border-yellow-500/70'
    : 'card hover:border-slate-700';

  const w = game.weather;
  const windColor =
    w?.windDirectionLabel === 'out to CF'   ? 'text-green-400' :
    w?.windDirectionLabel === 'in from CF'  ? 'text-red-400'   :
    'text-slate-400';
  const tempColor =
    w && w.tempF >= 85 ? 'text-orange-400' :
    w && w.tempF <= 45 ? 'text-blue-400'   :
    'text-slate-400';
  const rainColor =
    w && w.precipitationProbability >= 70 ? 'text-red-400'    :
    w && w.precipitationProbability >= 40 ? 'text-yellow-400' :
    'text-slate-500';

  return (
    <div className={`${cardClass} transition-colors`}>

      {/* LOCK banner */}
      {anyLock && (
        <div className="flex flex-wrap items-center gap-2 mb-3 px-2.5 py-1.5 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
          <span className="text-yellow-400 text-xs font-bold tracking-wide">★ LOCK</span>
          {mlIsLock && <span className="text-yellow-200 text-xs font-semibold">{game.pickLabel}</span>}
          {ouIsLock && <span className="text-yellow-200 text-xs font-semibold">{game.totalPickLabel}</span>}
          {nrfiIsLock && <span className="text-yellow-200 text-xs font-semibold">{game.nrfiPickLabel}</span>}
          {mlIsLock && (
            <span className="ml-auto text-yellow-600 text-xs">{pct(mlPct)} win prob</span>
          )}
          {nrfiIsLock && !mlIsLock && (
            <span className="ml-auto text-yellow-600 text-xs">{pct(game.nrfiProbability)} NRFI</span>
          )}
        </div>
      )}

      {/* Matchup header */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex-1">
          <div className={`font-bold text-sm ${pickAway ? 'text-white' : 'text-slate-400'}`}>
            {game.awayTeam.abbreviation || game.awayTeam.name}
            {pickAway && <span className="ml-1.5 text-xs text-green-400">◀ pick</span>}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {game.awayStartingPitcher ? game.awayStartingPitcher.fullName : 'TBD'}
          </div>
          {game.awayStartingPitcher?.seasonStats && (
            <div className="text-xs text-slate-600">
              {game.awayStartingPitcher.seasonStats.era.toFixed(2)} ERA
              · {game.awayStartingPitcher.seasonStats.kPer9.toFixed(1)} K/9
            </div>
          )}
        </div>

        <div className="text-center px-3">
          <div className="text-slate-600 text-xs font-mono">@</div>
          <div className="text-slate-500 text-xs mt-1">{game.gameTime} ET</div>
        </div>

        <div className="flex-1 text-right">
          <div className={`font-bold text-sm ${pickHome ? 'text-white' : 'text-slate-400'}`}>
            {pickHome && <span className="mr-1.5 text-xs text-green-400">pick ▶</span>}
            {game.homeTeam.abbreviation || game.homeTeam.name}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {game.homeStartingPitcher ? game.homeStartingPitcher.fullName : 'TBD'}
          </div>
          {game.homeStartingPitcher?.seasonStats && (
            <div className="text-xs text-slate-600">
              {game.homeStartingPitcher.seasonStats.era.toFixed(2)} ERA
              · {game.homeStartingPitcher.seasonStats.kPer9.toFixed(1)} K/9
            </div>
          )}
        </div>
      </div>

      {/* Predicted score */}
      <div className="flex items-center justify-between text-xs mb-2 px-0.5">
        <span className={`font-mono font-bold text-sm ${pickAway ? 'text-white' : 'text-slate-400'}`}>
          {game.awayExpectedRuns.toFixed(1)}
        </span>
        <span className="text-slate-600 text-xs">predicted score</span>
        <span className={`font-mono font-bold text-sm ${pickHome ? 'text-white' : 'text-slate-400'}`}>
          {game.homeExpectedRuns.toFixed(1)}
        </span>
      </div>

      {/* Win probability bar */}
      <div className="flex h-2 rounded-full overflow-hidden mb-2 bg-slate-800">
        <div className="bg-blue-600 transition-all" style={{ width: `${game.awayWinProbability * 100}%` }} />
        <div className="bg-red-600 transition-all" style={{ width: `${game.homeWinProbability * 100}%` }} />
      </div>
      <div className="flex justify-between text-xs text-slate-500 mb-3">
        <span>{pct(game.awayWinProbability)}</span>
        <span>{pct(game.homeWinProbability)}</span>
      </div>

      {/* ML pick row — shows model win probability as hit-rate estimate */}
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-slate-600 text-xs w-7">ML</span>
          <span className={`font-semibold text-sm ${game.pickSide ? 'text-white' : 'text-slate-500'}`}>
            {game.pickLabel}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {game.pickSide && (
            <span className="text-slate-300 text-xs font-mono font-bold">{pct(mlPct)}</span>
          )}
          <span className={`text-xs font-bold ${confBadgeColor(game.confidence)}`}>
            {game.confidence}
          </span>
        </div>
      </div>

      {/* O/U pick row — shows estimated O/U hit rate from projected total deviation */}
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-slate-600 text-xs w-7">O/U</span>
          <span className={`font-semibold text-sm ${game.totalPick ? 'text-white' : 'text-slate-500'}`}>
            {game.totalPickLabel || 'No pick'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {ouPct !== null && (
            <span className="text-slate-300 text-xs font-mono font-bold">{pct(ouPct)}</span>
          )}
          {game.totalPick ? (
            <span className={`text-xs font-bold ${confBadgeColor(game.totalConfidence)}`}>
              {game.totalConfidence}
            </span>
          ) : (
            <span className="text-slate-600 text-xs">xTotal: {game.projectedTotal.toFixed(1)}</span>
          )}
        </div>
      </div>

      {/* NRFI/YRFI row */}
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-1.5">
          <span className="text-slate-600 text-xs w-7">1st</span>
          <span className={`font-semibold text-sm ${game.nrfiPick ? 'text-white' : 'text-slate-500'}`}>
            {game.nrfiPickLabel || 'No pick'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-300 text-xs font-mono font-bold">{pct(game.nrfiProbability)} NRFI</span>
          {game.nrfiPick && (
            <span className={`text-xs font-bold ${confBadgeColor(game.nrfiConfidence)}`}>
              {game.nrfiConfidence}
            </span>
          )}
        </div>
      </div>

      {/* Weather row */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs border-t border-slate-800/60 pt-2 mb-2">
        {!w && <span className="text-slate-700">Weather unavailable</span>}
        {w?.isIndoor && <span className="text-slate-500">Dome · controlled conditions</span>}
        {w && !w.isIndoor && (
          <>
            <span className={tempColor}>{w.tempF.toFixed(0)}°F</span>
            {w.windSpeedMph >= 5 ? (
              <span className={windColor}>{w.windSpeedMph.toFixed(0)}mph {w.windDirectionLabel}</span>
            ) : (
              <span className="text-slate-600">Calm wind</span>
            )}
            {w.precipitationProbability >= 20 && (
              <span className={rainColor}>Rain {w.precipitationProbability}%</span>
            )}
          </>
        )}
      </div>

      {/* Key factors */}
      {game.keyFactors.length > 0 && (
        <ul className="space-y-1 border-t border-slate-800 pt-2">
          {game.keyFactors.map((f, i) => (
            <li key={i} className="text-xs text-slate-400 flex items-start gap-1.5">
              <span className="text-slate-600 mt-0.5">›</span>
              <span>{f}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── HRR CARD ─────────────────────────────────────────────────────────────────

function HRRCard({
  pred,
  rank,
  score,
  playerResult,
}: {
  pred: HitterPrediction;
  rank: number;
  score: number;
  playerResult: PlayerGameResult | null;
}) {
  const { hitter, game, opposingPitcher, probabilities, explanations } = pred;
  const matchup = `${game.awayTeam.abbreviation || game.awayTeam.name} @ ${game.homeTeam.abbreviation || game.homeTeam.name}`;

  const actualHRR = playerResult ? playerResult.hits + playerResult.runs + playerResult.rbi : null;
  const hrrHit = actualHRR !== null ? actualHRR > 1.5 : null;

  const resultBorder =
    hrrHit === true ? 'border-green-600 ring-1 ring-green-600/40' :
    hrrHit === false ? 'border-red-800 ring-1 ring-red-800/30' :
    '';

  return (
    <div className={`card hover:border-slate-700 transition-colors ${resultBorder}`}>
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-3">
          <span className="text-slate-500 font-mono text-sm w-6 shrink-0">#{rank}</span>
          <div>
            <div className="font-bold text-white text-sm flex items-center gap-2 flex-wrap">
              {hitter.fullName}
              {actualHRR !== null && (
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${
                  hrrHit
                    ? 'text-green-400 bg-green-950/60 border-green-700'
                    : 'text-red-400 bg-red-950/60 border-red-800'
                }`}>
                  HRR {actualHRR} {hrrHit ? '✓ o1.5' : '✗ u1.5'}
                </span>
              )}
            </div>
            <div className="text-slate-400 text-xs flex items-center gap-1.5 mt-0.5">
              <span>{hitter.team.abbreviation || hitter.team.name}</span>
              <span className="text-slate-600">·</span>
              <span>{hitter.primaryPosition}</span>
              <span className="text-slate-600">·</span>
              <span>{hitter.batHand}HB</span>
            </div>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="font-mono text-xl font-bold text-white">{score.toFixed(3)}</div>
          <div className="text-slate-500 text-xs">HRR Score</div>
        </div>
      </div>

      <div className="h-1.5 bg-slate-800 rounded-full mb-3 overflow-hidden">
        <div
          className="h-full rounded-full bg-purple-500 transition-all"
          style={{ width: `${Math.min(score / 1.5, 1) * 100}%` }}
        />
      </div>

      <div className="grid grid-cols-4 gap-1.5 mb-3">
        {(['hr', 'hit', 'run', 'rbi'] as PropType[]).map(p => {
          const ex = explanations.find(e => e.prop === p);
          const actualHit = playerResult ? propHit(p, playerResult) : null;
          const actualLabel = playerResult ? propStatLabel(p, playerResult) : null;
          return (
            <div key={p} className={`text-center p-1.5 rounded-lg bg-slate-900 ${
              actualHit === true ? 'ring-1 ring-green-700/50' : actualHit === false ? 'ring-1 ring-red-900/50' : ''
            }`}>
              <div className="text-slate-400 text-xs uppercase tracking-wider">{p}</div>
              <div className="font-mono font-bold text-sm text-white">{pct(probabilities[p])}</div>
              {actualLabel && (
                <div className={`text-[10px] font-mono mt-0.5 ${actualHit ? 'text-green-400' : 'text-red-400'}`}>
                  {actualLabel}
                </div>
              )}
              {!actualLabel && ex && (
                <span className={`stat-pill text-[10px] ${tierClass(ex.confidence)}`}>{ex.confidence}</span>
              )}
            </div>
          );
        })}
      </div>

      {playerResult && (
        <div className="flex flex-wrap gap-1.5 text-xs mb-3">
          <span className="stat-pill bg-slate-800/80 text-slate-400 font-mono">
            <span className="text-slate-500">RESULT</span>{' '}
            <span className={playerResult.hits > 0 ? 'text-green-400' : 'text-slate-400'}>{playerResult.hits}H</span>
            <span className="text-slate-600">/</span>
            <span className="text-slate-300">{playerResult.atBats}AB</span>
            {' · '}
            <span className={playerResult.runs > 0 ? 'text-green-400' : 'text-slate-400'}>{playerResult.runs}R</span>
            {' · '}
            <span className={playerResult.rbi > 0 ? 'text-green-400' : 'text-slate-400'}>{playerResult.rbi}RBI</span>
            {playerResult.homeRuns > 0 && (
              <><span className="text-slate-600"> · </span><span className="text-yellow-400">{playerResult.homeRuns}HR</span></>
            )}
            {' · '}
            <span className={playerResult.totalBases >= 2 ? 'text-green-400' : 'text-slate-400'}>{playerResult.totalBases}TB</span>
          </span>
        </div>
      )}

      <div className="flex flex-wrap gap-2 text-xs text-slate-400 mb-3">
        <span className="stat-pill bg-slate-800 text-slate-300">{matchup} · {game.gameTime} ET</span>
        {opposingPitcher && (
          <span className="stat-pill bg-slate-800 text-slate-300">
            vs {opposingPitcher.fullName} ({opposingPitcher.throwHand}HP)
          </span>
        )}
      </div>

      {hitter.seasonStats && (
        <div className="flex flex-wrap gap-2 text-xs">
          {[
            { label: 'AVG', val: fmt(hitter.seasonStats.avg) },
            { label: 'OBP', val: fmt(hitter.seasonStats.obp) },
            { label: 'OPS', val: fmt(hitter.seasonStats.ops) },
            { label: 'K%', val: pct(hitter.seasonStats.kPct) },
            { label: 'PA', val: String(hitter.seasonStats.paCount) },
          ].map(({ label, val }) => (
            <span key={label} className="stat-pill bg-slate-800 text-slate-300">
              <span className="text-slate-500">{label}</span> {val}
            </span>
          ))}
          {hitter.recentStats && (
            <span className="stat-pill bg-slate-800 text-amber-300">
              <span className="text-slate-500">L{hitter.recentStats.windowDays}</span>{' '}
              {fmt(hitter.recentStats.avg)}/{fmt(hitter.recentStats.slg)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── TOTAL BASES CARD ─────────────────────────────────────────────────────────

function TotalBasesCard({
  pred,
  rank,
  projectedTB,
  playerResult,
}: {
  pred: HitterPrediction;
  rank: number;
  projectedTB: number;
  playerResult: PlayerGameResult | null;
}) {
  const { hitter, game, opposingPitcher, probabilities, parkFactors } = pred;
  const matchup = `${game.awayTeam.abbreviation || game.awayTeam.name} @ ${game.homeTeam.abbreviation || game.homeTeam.name}`;
  const avg = hitter.seasonStats?.avg ?? 0;
  const slg = hitter.seasonStats?.slg ?? 0;
  const basesPerHit = avg > 0 ? slg / avg : 0;

  const actualTB = playerResult?.totalBases ?? null;
  const tbHit = actualTB !== null ? actualTB > 1.5 : null;

  const resultBorder =
    tbHit === true ? 'border-green-600 ring-1 ring-green-600/40' :
    tbHit === false ? 'border-red-800 ring-1 ring-red-800/30' :
    '';

  return (
    <div className={`card hover:border-slate-700 transition-colors ${resultBorder}`}>
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-3">
          <span className="text-slate-500 font-mono text-sm w-6 shrink-0">#{rank}</span>
          <div>
            <div className="font-bold text-white text-sm flex items-center gap-2 flex-wrap">
              {hitter.fullName}
              {actualTB !== null && (
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${
                  tbHit
                    ? 'text-green-400 bg-green-950/60 border-green-700'
                    : 'text-red-400 bg-red-950/60 border-red-800'
                }`}>
                  {actualTB}TB {tbHit ? '✓ o1.5' : '✗ u1.5'}
                </span>
              )}
            </div>
            <div className="text-slate-400 text-xs flex items-center gap-1.5 mt-0.5">
              <span>{hitter.team.abbreviation || hitter.team.name}</span>
              <span className="text-slate-600">·</span>
              <span>{hitter.primaryPosition}</span>
              <span className="text-slate-600">·</span>
              <span>{hitter.batHand}HB</span>
            </div>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="font-mono text-xl font-bold text-white">{projectedTB.toFixed(3)}</div>
          <div className="text-slate-500 text-xs">Proj. xTB</div>
        </div>
      </div>

      <div className="h-1.5 bg-slate-800 rounded-full mb-3 overflow-hidden">
        <div
          className="h-full rounded-full bg-amber-500 transition-all"
          style={{ width: `${Math.min(projectedTB / 0.75, 1) * 100}%` }}
        />
      </div>

      <div className="grid grid-cols-3 gap-1.5 mb-3">
        <div className="text-center p-1.5 rounded-lg bg-slate-900">
          <div className="text-slate-400 text-xs uppercase tracking-wider">Hit%</div>
          <div className="font-mono font-bold text-sm text-white">{pct(probabilities.hit)}</div>
          {playerResult && (
            <div className={`text-[10px] font-mono mt-0.5 ${playerResult.hits > 0 ? 'text-green-400' : 'text-red-400'}`}>
              {playerResult.hits}H/{playerResult.atBats}AB
            </div>
          )}
        </div>
        <div className="text-center p-1.5 rounded-lg bg-slate-900">
          <div className="text-slate-400 text-xs uppercase tracking-wider">xB/H</div>
          <div className="font-mono font-bold text-sm text-white">{basesPerHit > 0 ? basesPerHit.toFixed(2) : '—'}</div>
          {playerResult && (
            <div className={`text-[10px] font-mono mt-0.5 ${tbHit ? 'text-green-400' : 'text-red-400'}`}>
              {actualTB}TB
            </div>
          )}
        </div>
        <div className="text-center p-1.5 rounded-lg bg-slate-900">
          <div className="text-slate-400 text-xs uppercase tracking-wider">HR%</div>
          <div className="font-mono font-bold text-sm text-white">{pct(probabilities.hr)}</div>
          {playerResult && (
            <div className={`text-[10px] font-mono mt-0.5 ${playerResult.homeRuns > 0 ? 'text-yellow-400' : 'text-slate-500'}`}>
              {playerResult.homeRuns}HR
            </div>
          )}
        </div>
      </div>

      {playerResult && (
        <div className="flex flex-wrap gap-1.5 text-xs mb-3">
          <span className="stat-pill bg-slate-800/80 text-slate-400 font-mono">
            <span className="text-slate-500">RESULT</span>{' '}
            <span className={playerResult.hits > 0 ? 'text-green-400' : 'text-slate-400'}>{playerResult.hits}H</span>
            <span className="text-slate-600">/</span>
            <span className="text-slate-300">{playerResult.atBats}AB</span>
            {' · '}
            <span className={playerResult.runs > 0 ? 'text-green-400' : 'text-slate-400'}>{playerResult.runs}R</span>
            {' · '}
            <span className={playerResult.rbi > 0 ? 'text-green-400' : 'text-slate-400'}>{playerResult.rbi}RBI</span>
            {playerResult.homeRuns > 0 && (
              <><span className="text-slate-600"> · </span><span className="text-yellow-400">{playerResult.homeRuns}HR</span></>
            )}
            {' · '}
            <span className={tbHit ? 'text-green-400' : 'text-slate-400'}>{actualTB}TB</span>
          </span>
        </div>
      )}

      <div className="flex flex-wrap gap-2 text-xs text-slate-400 mb-3">
        <span className="stat-pill bg-slate-800 text-slate-300">{matchup} · {game.gameTime} ET</span>
        {opposingPitcher && (
          <span className="stat-pill bg-slate-800 text-slate-300">
            vs {opposingPitcher.fullName} ({opposingPitcher.throwHand}HP)
          </span>
        )}
        <span className="stat-pill bg-slate-800 text-slate-300">
          {parkFactors.venueName} · HR×{parkFactors.hrFactor.toFixed(2)}
        </span>
      </div>

      {hitter.seasonStats && (
        <div className="flex flex-wrap gap-2 text-xs">
          {[
            { label: 'AVG', val: fmt(hitter.seasonStats.avg) },
            { label: 'SLG', val: fmt(hitter.seasonStats.slg) },
            { label: 'ISO', val: fmt(hitter.seasonStats.iso) },
            { label: 'PA', val: String(hitter.seasonStats.paCount) },
          ].map(({ label, val }) => (
            <span key={label} className="stat-pill bg-slate-800 text-slate-300">
              <span className="text-slate-500">{label}</span> {val}
            </span>
          ))}
          {hitter.recentStats && (
            <span className="stat-pill bg-slate-800 text-amber-300">
              <span className="text-slate-500">L{hitter.recentStats.windowDays}</span>{' '}
              {fmt(hitter.recentStats.avg)}/{fmt(hitter.recentStats.slg)}
              {hitter.recentStats.hrCount > 0 && ` · ${hitter.recentStats.hrCount}HR`}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── NRFI CARD ────────────────────────────────────────────────────────────────

function NRFICard({ game }: { game: GamePrediction }) {
  const isNRFI = game.nrfiPick === 'NRFI';
  const isYRFI = game.nrfiPick === 'YRFI';
  const isLock = game.nrfiConfidence === 'LOCK' && game.nrfiPick !== null;

  const cardClass = isLock
    ? 'card border-emerald-500/50 ring-1 ring-emerald-500/15 hover:border-emerald-500/70'
    : 'card hover:border-slate-700';

  const pickColor = isNRFI ? 'text-emerald-400' : isYRFI ? 'text-orange-400' : 'text-slate-500';
  const barColor  = isNRFI ? 'bg-emerald-500' : isYRFI ? 'bg-orange-500' : 'bg-slate-600';

  const w = game.weather;
  const windColor =
    w?.windDirectionLabel === 'out to CF'  ? 'text-green-400' :
    w?.windDirectionLabel === 'in from CF' ? 'text-red-400'   :
    'text-slate-400';
  const tempColor =
    w && w.tempF >= 85 ? 'text-orange-400' :
    w && w.tempF <= 45 ? 'text-blue-400'   :
    'text-slate-400';

  return (
    <div className={`${cardClass} transition-colors`}>
      {isLock && (
        <div className="flex items-center gap-2 mb-3 px-2.5 py-1.5 bg-emerald-500/10 border border-emerald-500/30 rounded-lg">
          <span className="text-emerald-400 text-xs font-bold tracking-wide">★ LOCK</span>
          <span className={`text-xs font-bold ${pickColor}`}>{game.nrfiPickLabel}</span>
          <span className="ml-auto text-emerald-600 text-xs">{pct(game.nrfiProbability)} NRFI prob</span>
        </div>
      )}

      {/* Matchup */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <div>
          <div className="font-bold text-white text-sm">{game.awayTeam.abbreviation} @ {game.homeTeam.abbreviation}</div>
          <div className="text-slate-500 text-xs">{game.gameTime} ET · {game.venue.name}</div>
        </div>
        <div className="text-right">
          <div className={`font-mono text-2xl font-bold ${pickColor}`}>{pct(game.nrfiProbability)}</div>
          <div className="text-slate-500 text-xs">NRFI prob</div>
        </div>
      </div>

      {/* NRFI probability bar */}
      <div className="h-1.5 bg-slate-800 rounded-full mb-3 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${game.nrfiProbability * 100}%` }}
        />
      </div>

      {/* Pick badge */}
      <div className="flex items-center justify-between mb-3">
        <span className={`font-bold text-base ${pickColor}`}>
          {game.nrfiPick ?? 'No pick'}
        </span>
        {game.nrfiPick && (
          <span className={`text-xs font-bold ${confBadgeColor(game.nrfiConfidence)}`}>
            {game.nrfiConfidence}
          </span>
        )}
        {!game.nrfiPick && (
          <span className="text-slate-600 text-xs">Lean: {game.nrfiProbability >= 0.70 ? 'slight NRFI' : game.nrfiProbability <= 0.67 ? 'slight YRFI' : 'neutral'}</span>
        )}
      </div>

      {/* Pitchers */}
      <div className="grid grid-cols-2 gap-2 mb-3 text-xs">
        <div className="p-2 bg-slate-900 rounded-lg">
          <div className="text-slate-500 mb-0.5">{game.awayTeam.abbreviation} starter</div>
          <div className="text-white font-medium">{game.awayStartingPitcher?.fullName ?? 'TBD'}</div>
          {game.awayStartingPitcher?.seasonStats && (
            <div className="text-slate-400 font-mono mt-0.5">
              {game.awayStartingPitcher.seasonStats.era.toFixed(2)} ERA · {game.awayStartingPitcher.seasonStats.whip.toFixed(2)} WHIP
            </div>
          )}
        </div>
        <div className="p-2 bg-slate-900 rounded-lg">
          <div className="text-slate-500 mb-0.5">{game.homeTeam.abbreviation} starter</div>
          <div className="text-white font-medium">{game.homeStartingPitcher?.fullName ?? 'TBD'}</div>
          {game.homeStartingPitcher?.seasonStats && (
            <div className="text-slate-400 font-mono mt-0.5">
              {game.homeStartingPitcher.seasonStats.era.toFixed(2)} ERA · {game.homeStartingPitcher.seasonStats.whip.toFixed(2)} WHIP
            </div>
          )}
        </div>
      </div>

      {/* Weather */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs border-t border-slate-800/60 pt-2">
        {!w && <span className="text-slate-700">Weather unavailable</span>}
        {w?.isIndoor && <span className="text-slate-500">Dome</span>}
        {w && !w.isIndoor && (
          <>
            <span className={tempColor}>{w.tempF.toFixed(0)}°F</span>
            {w.windSpeedMph >= 5 ? (
              <span className={windColor}>{w.windSpeedMph.toFixed(0)}mph {w.windDirectionLabel}</span>
            ) : (
              <span className="text-slate-600">Calm</span>
            )}
            {w.precipitationProbability >= 20 && (
              <span className={w.precipitationProbability >= 70 ? 'text-red-400' : 'text-yellow-400'}>
                Rain {w.precipitationProbability}%
              </span>
            )}
          </>
        )}
        <span className="text-slate-600 ml-auto">Park ×{game.parkFactors.runsFactor.toFixed(2)}</span>
      </div>
    </div>
  );
}

// ─── HEALTH INDICATOR ─────────────────────────────────────────────────────────

function HealthDot({ status }: { status: string }) {
  const cls = status === 'ok' ? 'bg-green-500' :
              status === 'partial' || status === 'stale' ? 'bg-yellow-500' :
              status === 'unavailable' ? 'bg-slate-600' : 'bg-red-500';
  return <span className={`inline-block w-2 h-2 rounded-full ${cls}`} />;
}

// ─── TRACK RECORD HELPERS ─────────────────────────────────────────────────────

const SMALL_SAMPLE_THRESHOLD = 10;

function HitRateRow({ label, bucket }: { label: string; bucket: HitRateBucket }) {
  const smallSample = bucket.total > 0 && bucket.total < SMALL_SAMPLE_THRESHOLD;
  const rateColor = bucket.rate === null ? 'text-slate-600' :
    smallSample ? 'text-slate-400' :
    bucket.rate >= 0.55 ? 'text-green-400' :
    bucket.rate >= 0.45 ? 'text-yellow-400' : 'text-red-400';

  return (
    <div className="flex items-center justify-between text-sm py-0.5">
      <span className="text-slate-400">{label}</span>
      <span className={`font-mono ${rateColor}`}>
        {bucket.rate === null ? '—' : pct(bucket.rate)}
        <span className="text-slate-600 ml-1">({bucket.wins}/{bucket.total})</span>
      </span>
    </div>
  );
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────

function getTodayET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function offsetDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA');
}

function formatDisplayDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

// A single activeView replaces the old activeSection + activeProp pair.
// Prop views (hr/hit/run/rbi) sort PredictionCards by that prop.
// hrr/totalbases show their own card types. games/nrfi show game picks.
type ActiveView = 'hr' | 'hit' | 'run' | 'rbi' | 'hrr' | 'totalbases' | 'games' | 'nrfi' | 'track-record' | 'best-bets';
type TrackRecordWindowKey = 'last7' | 'last30' | 'allTime';

const PROP_VIEWS: PropType[] = ['hr', 'hit', 'run', 'rbi'];

const PROP_LABELS: Record<PropType, string> = {
  hr: 'Home Run',
  hit: 'Hit',
  run: 'Run',
  rbi: 'RBI',
};

// ─── BEST BETS (cross-category ranked list) ───────────────────────────────────
// Combines the day's top-tier picks from every category (props, ML, O/U, NRFI)
// into one ranked list. Ranking: top confidence tier first (LOCK/ELITE before
// HIGH/STRONG — anything below is excluded, it isn't a standout pick), then by
// that category+tier's realized historical hit rate (from the grading pipeline,
// gated by sample size so a lucky/unlucky small sample can't skew the order),
// then by the model's stated probability as a last tiebreaker.

type BestBetCategory = 'prop' | 'ml' | 'ou' | 'nrfi';

interface BestBetItem {
  category: BestBetCategory;
  tierRank: 0 | 1; // 0 = LOCK/ELITE, 1 = HIGH/STRONG
  tierLabel: string;
  title: string;
  subtitle: string;
  probability: number | null;
  realizedRate: number | null;
  realizedN: number;
}

const BEST_BET_TIER_RANK: Record<string, 0 | 1> = { LOCK: 0, ELITE: 0, HIGH: 1, STRONG: 1 };
const MIN_REALIZED_SAMPLE = 15;

function realizedFor(bucket: HitRateBucket | undefined): { rate: number | null; n: number } {
  if (!bucket || bucket.rate === null || bucket.total < MIN_REALIZED_SAMPLE) return { rate: null, n: bucket?.total ?? 0 };
  return { rate: bucket.rate, n: bucket.total };
}

function buildBestBets(
  data: PredictionAPIResponse | null,
  gameData: GamePredictionAPIResponse | null,
  trackRecord: TrackRecordAPIResponse | null,
): BestBetItem[] {
  const items: BestBetItem[] = [];
  const w = trackRecord?.windows.allTime ?? null;

  if (data) {
    for (const pred of data.predictions) {
      for (const propType of PROP_VIEWS) {
        const ex = pred.explanations.find(e => e.prop === propType);
        if (!ex || (ex.confidence !== 'ELITE' && ex.confidence !== 'STRONG')) continue;
        const { rate, n } = realizedFor(w?.props[propType][ex.confidence]);
        items.push({
          category: 'prop',
          tierRank: BEST_BET_TIER_RANK[ex.confidence],
          tierLabel: ex.confidence,
          title: `${pred.hitter.fullName} — ${PROP_LABELS[propType]}`,
          subtitle: `${pred.game.awayTeam.abbreviation || pred.game.awayTeam.name} @ ${pred.game.homeTeam.abbreviation || pred.game.homeTeam.name}`,
          probability: ex.probability,
          realizedRate: rate,
          realizedN: n,
        });
      }
    }
  }

  if (gameData) {
    for (const g of gameData.games) {
      const matchup = `${g.awayTeam.abbreviation || g.awayTeam.name} @ ${g.homeTeam.abbreviation || g.homeTeam.name}`;

      if (g.pickSide && (g.confidence === 'LOCK' || g.confidence === 'HIGH')) {
        const { rate, n } = realizedFor(w?.games.ml[g.confidence]);
        items.push({
          category: 'ml',
          tierRank: BEST_BET_TIER_RANK[g.confidence],
          tierLabel: g.confidence,
          title: g.pickLabel,
          subtitle: matchup,
          probability: g.pickSide === 'home' ? g.homeWinProbability : g.awayWinProbability,
          realizedRate: rate,
          realizedN: n,
        });
      }

      if (g.totalPick && g.ouLine !== null && (g.totalConfidence === 'LOCK' || g.totalConfidence === 'HIGH')) {
        const { rate, n } = realizedFor(w?.games.ou[g.totalConfidence]);
        items.push({
          category: 'ou',
          tierRank: BEST_BET_TIER_RANK[g.totalConfidence],
          tierLabel: g.totalConfidence,
          title: g.totalPickLabel,
          subtitle: matchup,
          probability: null,
          realizedRate: rate,
          realizedN: n,
        });
      }

      if (g.nrfiPick && (g.nrfiConfidence === 'LOCK' || g.nrfiConfidence === 'HIGH')) {
        const { rate, n } = realizedFor(w?.games.nrfi[g.nrfiConfidence]);
        items.push({
          category: 'nrfi',
          tierRank: BEST_BET_TIER_RANK[g.nrfiConfidence],
          tierLabel: g.nrfiConfidence,
          title: g.nrfiPickLabel,
          subtitle: matchup,
          probability: g.nrfiPick === 'NRFI' ? g.nrfiProbability : 1 - g.nrfiProbability,
          realizedRate: rate,
          realizedN: n,
        });
      }
    }
  }

  items.sort((a, b) => {
    if (a.tierRank !== b.tierRank) return a.tierRank - b.tierRank;
    if (a.realizedRate !== null || b.realizedRate !== null) {
      return (b.realizedRate ?? -1) - (a.realizedRate ?? -1);
    }
    return (b.probability ?? 0) - (a.probability ?? 0);
  });

  return items;
}

function categoryBadge(category: BestBetCategory): { label: string; className: string } {
  switch (category) {
    case 'prop': return { label: 'PROP', className: 'bg-blue-950 text-blue-300 border border-blue-800' };
    case 'ml':   return { label: 'MONEYLINE', className: 'bg-slate-800 text-blue-200 border border-slate-600' };
    case 'ou':   return { label: 'O/U', className: 'bg-amber-950 text-amber-300 border border-amber-800' };
    case 'nrfi': return { label: 'NRFI/YRFI', className: 'bg-emerald-950 text-emerald-300 border border-emerald-800' };
  }
}

export default function Home() {
  const [data, setData] = useState<PredictionAPIResponse | null>(null);
  const [gameData, setGameData] = useState<GamePredictionAPIResponse | null>(null);
  const [playerResults, setPlayerResults] = useState<Record<number, PlayerGameResult>>({});
  const [loading, setLoading] = useState(true);
  const [gamesLoading, setGamesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<ActiveView>('hr');
  const [showRejected, setShowRejected] = useState(false);
  const [minProb, setMinProb] = useState(0);
  const [selectedDate, setSelectedDate] = useState<string>(getTodayET());
  const [displayCount, setDisplayCount] = useState(20);
  const [trackRecordData, setTrackRecordData] = useState<TrackRecordAPIResponse | null>(null);
  const [trackRecordLoading, setTrackRecordLoading] = useState(false);
  const [trWindow, setTrWindow] = useState<TrackRecordWindowKey>('last30');
  const [calibrationData, setCalibrationData] = useState<CalibrationReportAPIResponse | null>(null);
  const [calibrationLoading, setCalibrationLoading] = useState(false);
  const [showCalibration, setShowCalibration] = useState(false);

  const today = getTodayET();
  const isToday = selectedDate === today;
  const isPastDate = selectedDate < today;

  // Derived flags
  const isGamesView = activeView === 'games';
  const isNrfiView = activeView === 'nrfi';
  const isTrackRecordView = activeView === 'track-record';
  const isBestBetsView = activeView === 'best-bets';
  const isHrrView = activeView === 'hrr';
  const isTbView = activeView === 'totalbases';
  const isPropView = (PROP_VIEWS as string[]).includes(activeView);
  const activeProp = isPropView ? (activeView as PropType) : 'hr';

  const loadPredictions = useCallback(async (date: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/predict?date=${date}`);
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const json: PredictionAPIResponse = await res.json();
      setData(json);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadGamePredictions = useCallback(async (date: string) => {
    setGamesLoading(true);
    try {
      const res = await fetch(`/api/games?date=${date}`);
      if (!res.ok) return;
      const json: GamePredictionAPIResponse = await res.json();
      setGameData(json);
    } catch {
      // game picks are non-critical
    } finally {
      setGamesLoading(false);
    }
  }, []);

  const loadHrResults = useCallback(async (date: string) => {
    try {
      const res = await fetch(`/api/results?date=${date}`);
      if (!res.ok) return;
      const json: GameResultsAPIResponse = await res.json();
      const map: Record<number, PlayerGameResult> = {};
      for (const [idStr, stats] of Object.entries(json.playerStats ?? {})) {
        map[Number(idStr)] = stats;
      }
      setPlayerResults(map);
    } catch {
      setPlayerResults({});
    }
  }, []);

  const loadTrackRecord = useCallback(async () => {
    setTrackRecordLoading(true);
    try {
      const res = await fetch('/api/track-record');
      if (!res.ok) return;
      const json: TrackRecordAPIResponse = await res.json();
      setTrackRecordData(json);
    } catch {
      // non-critical
    } finally {
      setTrackRecordLoading(false);
    }
  }, []);

  const loadCalibrationReport = useCallback(async () => {
    setCalibrationLoading(true);
    try {
      const res = await fetch('/api/calibration-report');
      if (!res.ok) return;
      const json: CalibrationReportAPIResponse = await res.json();
      setCalibrationData(json);
    } catch {
      // non-critical
    } finally {
      setCalibrationLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPredictions(selectedDate);
    loadGamePredictions(selectedDate);
    if (selectedDate < getTodayET()) {
      loadHrResults(selectedDate);
    } else {
      setPlayerResults({});
    }
  }, [loadPredictions, loadGamePredictions, loadHrResults, selectedDate]);

  useEffect(() => {
    if ((isTrackRecordView || isBestBetsView) && !trackRecordData && !trackRecordLoading) {
      loadTrackRecord();
    }
  }, [isTrackRecordView, isBestBetsView, trackRecordData, trackRecordLoading, loadTrackRecord]);

  useEffect(() => {
    if (showCalibration && !calibrationData && !calibrationLoading) {
      loadCalibrationReport();
    }
  }, [showCalibration, calibrationData, calibrationLoading, loadCalibrationReport]);

  useEffect(() => { setDisplayCount(20); }, [activeView]);

  function goToDate(date: string) {
    if (date > today) return;
    setSelectedDate(date);
    setData(null);
    setGameData(null);
    setPlayerResults({});
  }

  // Sorted predictions for prop views
  const sortedPredictions = data
    ? [...data.predictions].sort((a, b) => b.probabilities[activeProp] - a.probabilities[activeProp])
    : [];

  const filteredPredictions = sortedPredictions.filter(
    p => p.probabilities[activeProp] >= minProb,
  );

  // Hit + Run + RBI combined score
  const hrrSorted = data
    ? [...data.predictions]
        .map(p => ({ pred: p, score: p.probabilities.hit + p.probabilities.run + p.probabilities.rbi }))
        .sort((a, b) => b.score - a.score)
    : [];

  // Total bases: hit probability × average bases per hit (SLG / AVG)
  const tbSorted = data
    ? [...data.predictions]
        .map(p => {
          const avg = p.hitter.seasonStats?.avg ?? 0.26;
          const slg = p.hitter.seasonStats?.slg ?? 0.42;
          const basesPerHit = avg > 0 ? slg / avg : 1.6;
          return { pred: p, projectedTB: p.probabilities.hit * basesPerHit };
        })
        .sort((a, b) => b.projectedTB - a.projectedTB)
    : [];

  const bestBetsList = isBestBetsView ? buildBestBets(data, gameData, trackRecordData) : [];

  return (
    <div>
      {/* Date navigation */}
      {!isTrackRecordView && (
        <div className="flex items-center gap-2 mb-5">
          <button
            onClick={() => goToDate(offsetDate(selectedDate, -1))}
            disabled={loading}
            className="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:border-slate-600 disabled:opacity-40 transition-colors"
            aria-label="Previous day"
          >
            ‹
          </button>
          <input
            type="date"
            value={selectedDate}
            max={today}
            onChange={e => { if (e.target.value) goToDate(e.target.value); }}
            className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:border-slate-600"
          />
          <button
            onClick={() => goToDate(offsetDate(selectedDate, 1))}
            disabled={loading || isToday}
            className="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:border-slate-600 disabled:opacity-40 transition-colors"
            aria-label="Next day"
          >
            ›
          </button>
          <span className="text-slate-400 text-sm">{formatDisplayDate(selectedDate)}</span>
          {!isToday && (
            <button
              onClick={() => goToDate(today)}
              className="ml-auto text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              Back to today
            </button>
          )}
        </div>
      )}

      {/* ── TOP NAV: Best Bets | Hitter Picks | Game Picks ──────────────────────── */}
      <div className="flex flex-wrap bg-slate-900 border border-slate-800 rounded-lg p-1 gap-1 mb-3 w-fit">
        <button
          onClick={() => setActiveView('best-bets')}
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
            isBestBetsView ? 'bg-yellow-600 text-yellow-950' : 'text-slate-400 hover:text-white'
          }`}
        >
          ★ Best Bets
        </button>
        <button
          onClick={() => { if (isGamesView || isNrfiView || isTrackRecordView || isBestBetsView) setActiveView('hr'); }}
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
            !isGamesView && !isNrfiView && !isTrackRecordView && !isBestBetsView ? 'bg-mlb-navy text-white' : 'text-slate-400 hover:text-white'
          }`}
        >
          Hitter Picks
        </button>
        <button
          onClick={() => setActiveView('games')}
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
            isGamesView ? 'bg-mlb-navy text-white' : 'text-slate-400 hover:text-white'
          }`}
        >
          Game Picks
        </button>
        <button
          onClick={() => setActiveView('nrfi')}
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
            isNrfiView ? 'bg-emerald-800 text-white' : 'text-slate-400 hover:text-white'
          }`}
        >
          NRFI
        </button>
        <button
          onClick={() => setActiveView('track-record')}
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
            isTrackRecordView ? 'bg-purple-800 text-white' : 'text-slate-400 hover:text-white'
          }`}
        >
          Track Record
        </button>
      </div>

      {/* ── SUB-NAV: shown when in any hitter view ──────────────────────────────── */}
      {!isGamesView && !isNrfiView && !isTrackRecordView && !isBestBetsView && (
        <div className="flex flex-wrap bg-slate-900/50 border border-slate-800 rounded-lg p-1 gap-1 mb-5 w-fit">
          {PROP_VIEWS.map(p => (
            <button
              key={p}
              onClick={() => setActiveView(p)}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                activeView === p ? 'bg-mlb-navy text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              {PROP_LABELS[p]}
            </button>
          ))}
          <div className="w-px bg-slate-700 mx-1 self-stretch" />
          <button
            onClick={() => setActiveView('hrr')}
            className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
              isHrrView ? 'bg-purple-800 text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            Hit+Run+RBI
          </button>
          <button
            onClick={() => setActiveView('totalbases')}
            className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
              isTbView ? 'bg-amber-800 text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            Total Bases
          </button>
        </div>
      )}

      {/* ── BEST BETS: cross-category ranked list ───────────────────────────────── */}
      {isBestBetsView && (
        <>
          <div className="flex items-center justify-between mb-5">
            <p className="text-slate-400 text-sm">
              Every top-tier pick today (props, moneyline, O/U, NRFI/YRFI), ranked by confidence tier first,
              then by how that tier has actually performed historically{trackRecordData ? ` (n≥${MIN_REALIZED_SAMPLE})` : ''}.
            </p>
            <button
              onClick={() => loadTrackRecord()}
              disabled={trackRecordLoading}
              className="px-4 py-1.5 bg-yellow-700 hover:bg-yellow-600 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
            >
              {trackRecordLoading ? 'Loading...' : 'Refresh'}
            </button>
          </div>

          {(loading || gamesLoading) && !data && !gameData && (
            <div className="text-center py-16 text-slate-500 text-sm">Loading today&apos;s picks…</div>
          )}

          {data && gameData && bestBetsList.length === 0 && (
            <div className="text-center py-16">
              <div className="text-4xl mb-3">😶</div>
              <div className="text-slate-300 font-medium">No standout picks today</div>
              <div className="text-slate-500 text-sm mt-1">Nothing hit LOCK/ELITE or HIGH/STRONG confidence on this slate.</div>
            </div>
          )}

          {bestBetsList.length > 0 && (
            <div className="card overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-slate-500 text-xs uppercase text-left">
                    <th className="pb-2 pr-3">#</th>
                    <th className="pb-2 pr-3">Category</th>
                    <th className="pb-2 pr-3">Pick</th>
                    <th className="pb-2 pr-3">Matchup</th>
                    <th className="pb-2 pr-3">Tier</th>
                    <th className="pb-2 pr-3">Model Prob</th>
                    <th className="pb-2">Historical Accuracy</th>
                  </tr>
                </thead>
                <tbody>
                  {bestBetsList.map((item, i) => {
                    const badge = categoryBadge(item.category);
                    return (
                      <tr key={i} className="border-t border-slate-800">
                        <td className="py-2 pr-3 text-slate-500 font-mono">{i + 1}</td>
                        <td className="py-2 pr-3 whitespace-nowrap">
                          <span className={`stat-pill ${badge.className}`}>{badge.label}</span>
                        </td>
                        <td className="py-2 pr-3 text-white font-medium whitespace-nowrap">{item.title}</td>
                        <td className="py-2 pr-3 text-slate-400 whitespace-nowrap">{item.subtitle}</td>
                        <td className="py-2 pr-3 whitespace-nowrap">
                          <span className={`stat-pill ${item.tierRank === 0 ? 'tier-elite' : 'tier-strong'}`}>{item.tierLabel}</span>
                        </td>
                        <td className="py-2 pr-3 text-slate-300 font-mono whitespace-nowrap">
                          {item.probability === null ? '—' : pct(item.probability)}
                        </td>
                        <td className="py-2 text-slate-400 font-mono whitespace-nowrap">
                          {item.realizedRate === null
                            ? <span className="text-slate-600">no history yet</span>
                            : <>{pct(item.realizedRate)} <span className="text-slate-600">(n={item.realizedN})</span></>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ── HITTER PROP VIEWS (hr / hit / run / rbi) ────────────────────────────── */}
      {isPropView && (
        <>
          {/* Controls bar */}
          <div className="flex flex-wrap items-center gap-3 mb-6">
            {/* Min probability filter */}
            <div className="flex items-center gap-2 text-sm">
              <span className="text-slate-400">Min prob:</span>
              <select
                value={minProb}
                onChange={e => setMinProb(Number(e.target.value))}
                className="bg-slate-900 border border-slate-800 rounded-lg px-2 py-1.5 text-white text-sm"
              >
                <option value={0}>All</option>
                {activeProp === 'hr' ? (
                  <>
                    <option value={0.02}>2%+</option>
                    <option value={0.04}>4%+</option>
                    <option value={0.065}>6.5%+</option>
                  </>
                ) : (
                  <>
                    <option value={0.15}>15%+</option>
                    <option value={0.22}>22%+</option>
                    <option value={0.30}>30%+</option>
                  </>
                )}
              </select>
            </div>

            <button
              onClick={() => loadPredictions(selectedDate)}
              disabled={loading}
              className="ml-auto px-4 py-1.5 bg-mlb-navy hover:bg-blue-700 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
            >
              {loading ? 'Loading...' : 'Refresh'}
            </button>
          </div>

          {/* Status bar */}
          {data && (
            <div className="flex flex-wrap items-center gap-4 mb-5 text-xs text-slate-400">
              <span>
                <span className="text-white font-medium">{data.validatedHitters}</span> hitters validated
                · <span className="text-white font-medium">{filteredPredictions.length}</span> shown
                · <span className="text-white font-medium">{data.date}</span>
              </span>
              <span className="flex items-center gap-1.5">
                <HealthDot status={data.sourceHealth.schedule} /> Schedule
                <HealthDot status={data.sourceHealth.rosterData} /> Rosters
                <HealthDot status={data.sourceHealth.hitterStats} /> Stats
                <HealthDot status={data.sourceHealth.weather} /> Weather
              </span>
              <span className="text-slate-600">
                Generated {new Date(data.generatedAt).toLocaleTimeString()}
              </span>
              {isPastDate && Object.keys(playerResults).length === 0 && (
                <span className="text-slate-600">Loading results...</span>
              )}
              {isPastDate && Object.keys(playerResults).length > 0 && (
                <span className="text-green-600">
                  {Object.values(playerResults).filter(r => r.homeRuns > 0).length} HR ·{' '}
                  {Object.values(playerResults).filter(r => r.hits > 0).length} got a hit that day
                </span>
              )}
            </div>
          )}

          {/* Warnings */}
          {data?.warnings && data.warnings.length > 0 && (
            <div className="mb-4 p-3 bg-yellow-950/40 border border-yellow-900/50 rounded-lg">
              <div className="text-yellow-400 text-xs font-medium mb-1">Warnings</div>
              {data.warnings.slice(0, 3).map((w, i) => (
                <div key={i} className="text-yellow-300/70 text-xs">{w}</div>
              ))}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="p-6 text-center">
              <div className="text-red-400 font-medium mb-1">Failed to load predictions</div>
              <div className="text-slate-500 text-sm">{error}</div>
              <button
                onClick={() => loadPredictions(selectedDate)}
                className="mt-3 px-4 py-2 bg-mlb-navy text-white text-sm rounded-lg"
              >
                Retry
              </button>
            </div>
          )}

          {/* Loading skeleton */}
          {loading && !data && (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {Array.from({ length: 9 }).map((_, i) => (
                <div key={i} className="card animate-pulse">
                  <div className="h-4 bg-slate-800 rounded w-40 mb-2" />
                  <div className="h-3 bg-slate-800 rounded w-24 mb-4" />
                  <div className="h-1.5 bg-slate-800 rounded-full mb-4" />
                  <div className="grid grid-cols-4 gap-1.5 mb-4">
                    {[...Array(4)].map((_, j) => <div key={j} className="h-12 bg-slate-800 rounded-lg" />)}
                  </div>
                  <div className="space-y-2">
                    <div className="h-3 bg-slate-800 rounded w-full" />
                    <div className="h-3 bg-slate-800 rounded w-4/5" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && data && data.predictions.length === 0 && (
            <div className="text-center py-16">
              <div className="text-4xl mb-3">⚾</div>
              <div className="text-slate-300 font-medium">No predictions available</div>
              <div className="text-slate-500 text-sm mt-1">
                {data.warnings[0] ?? 'No games may be scheduled for today'}
              </div>
            </div>
          )}

          {!loading && data && data.predictions.length > 0 && filteredPredictions.length === 0 && (
            <div className="text-center py-10">
              <div className="text-slate-400">No hitters meet the minimum probability filter.</div>
              <button onClick={() => setMinProb(0)} className="mt-2 text-blue-400 text-sm hover:underline">
                Clear filter
              </button>
            </div>
          )}

          {!loading && filteredPredictions.length > 0 && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {filteredPredictions.slice(0, displayCount).map((pred, i) => (
                  <PredictionCard
                    key={`${pred.hitter.id}-${pred.game.gamePk}`}
                    pred={pred}
                    rank={i + 1}
                    activeProp={activeProp}
                    playerResult={isPastDate ? (playerResults[pred.hitter.id] ?? null) : null}
                  />
                ))}
              </div>

              {filteredPredictions.length > displayCount && (
                <div className="mt-6 text-center">
                  <button
                    onClick={() => setDisplayCount(c => c + 20)}
                    className="px-6 py-2 bg-slate-900 border border-slate-700 text-slate-300 text-sm rounded-lg hover:border-slate-500 hover:text-white transition-colors"
                  >
                    Load more ({filteredPredictions.length - displayCount} remaining)
                  </button>
                </div>
              )}

              {data && data.rejectionLog.length > 0 && (
                <div className="mt-8">
                  <button
                    onClick={() => setShowRejected(r => !r)}
                    className="text-slate-500 hover:text-slate-300 text-sm transition-colors"
                  >
                    {showRejected ? 'Hide' : 'Show'} rejection log ({data.rejectionLog.length} players)
                  </button>
                  {showRejected && (
                    <div className="mt-3 card">
                      <div className="text-slate-400 text-xs font-medium mb-2">Rejection Log</div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5 max-h-64 overflow-y-auto">
                        {data.rejectionLog.map((r, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs">
                            <span className="text-slate-300">{r.name}</span>
                            <span className="stat-pill bg-slate-800 text-slate-400">{r.reason}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ── HIT + RUN + RBI ─────────────────────────────────────────────────────── */}
      {isHrrView && (
        <>
          <div className="flex items-center justify-between mb-5">
            <p className="text-slate-400 text-sm">
              Combined Hit + Run + RBI probability score. Higher = more likely to contribute across all three props.
            </p>
            <button
              onClick={() => loadPredictions(selectedDate)}
              disabled={loading}
              className="px-4 py-1.5 bg-purple-900 hover:bg-purple-800 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
            >
              {loading ? 'Loading...' : 'Refresh'}
            </button>
          </div>

          {loading && !data && (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="card animate-pulse">
                  <div className="h-4 bg-slate-800 rounded w-40 mb-2" />
                  <div className="h-3 bg-slate-800 rounded w-24 mb-4" />
                  <div className="h-1.5 bg-slate-800 rounded-full mb-4" />
                  <div className="grid grid-cols-4 gap-1.5 mb-4">
                    {[...Array(4)].map((_, j) => <div key={j} className="h-12 bg-slate-800 rounded-lg" />)}
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && hrrSorted.length === 0 && (
            <div className="text-center py-16">
              <div className="text-4xl mb-3">⚾</div>
              <div className="text-slate-300 font-medium">No predictions available</div>
            </div>
          )}

          {!loading && hrrSorted.length > 0 && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {hrrSorted.slice(0, displayCount).map(({ pred, score }, i) => (
                  <HRRCard
                    key={`${pred.hitter.id}-${pred.game.gamePk}`}
                    pred={pred}
                    rank={i + 1}
                    score={score}
                    playerResult={isPastDate ? (playerResults[pred.hitter.id] ?? null) : null}
                  />
                ))}
              </div>
              {hrrSorted.length > displayCount && (
                <div className="mt-6 text-center">
                  <button
                    onClick={() => setDisplayCount(c => c + 20)}
                    className="px-6 py-2 bg-slate-900 border border-slate-700 text-slate-300 text-sm rounded-lg hover:border-slate-500 hover:text-white transition-colors"
                  >
                    Load more ({hrrSorted.length - displayCount} remaining)
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ── TOTAL BASES ─────────────────────────────────────────────────────────── */}
      {isTbView && (
        <>
          <div className="flex items-center justify-between mb-5">
            <p className="text-slate-400 text-sm">
              Projected total bases = hit probability × avg bases per hit (SLG ÷ AVG). Higher xTB = elite contact + power combination.
            </p>
            <button
              onClick={() => loadPredictions(selectedDate)}
              disabled={loading}
              className="px-4 py-1.5 bg-amber-900 hover:bg-amber-800 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
            >
              {loading ? 'Loading...' : 'Refresh'}
            </button>
          </div>

          {loading && !data && (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="card animate-pulse">
                  <div className="h-4 bg-slate-800 rounded w-40 mb-2" />
                  <div className="h-3 bg-slate-800 rounded w-24 mb-4" />
                  <div className="h-1.5 bg-slate-800 rounded-full mb-4" />
                  <div className="grid grid-cols-3 gap-1.5 mb-4">
                    {[...Array(3)].map((_, j) => <div key={j} className="h-12 bg-slate-800 rounded-lg" />)}
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && tbSorted.length === 0 && (
            <div className="text-center py-16">
              <div className="text-4xl mb-3">⚾</div>
              <div className="text-slate-300 font-medium">No predictions available</div>
            </div>
          )}

          {!loading && tbSorted.length > 0 && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {tbSorted.slice(0, displayCount).map(({ pred, projectedTB }, i) => (
                  <TotalBasesCard
                    key={`${pred.hitter.id}-${pred.game.gamePk}`}
                    pred={pred}
                    rank={i + 1}
                    projectedTB={projectedTB}
                    playerResult={isPastDate ? (playerResults[pred.hitter.id] ?? null) : null}
                  />
                ))}
              </div>
              {tbSorted.length > displayCount && (
                <div className="mt-6 text-center">
                  <button
                    onClick={() => setDisplayCount(c => c + 20)}
                    className="px-6 py-2 bg-slate-900 border border-slate-700 text-slate-300 text-sm rounded-lg hover:border-slate-500 hover:text-white transition-colors"
                  >
                    Load more ({tbSorted.length - displayCount} remaining)
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ── NRFI VIEW ───────────────────────────────────────────────────────────── */}
      {isNrfiView && (
        <>
          <div className="flex items-center justify-between mb-5">
            <p className="text-slate-400 text-sm">
              No Run First Inning — probability neither team scores in the 1st inning. Driven by starting pitcher quality, park, and weather.
            </p>
            <button
              onClick={() => loadGamePredictions(selectedDate)}
              disabled={gamesLoading}
              className="px-4 py-1.5 bg-emerald-900 hover:bg-emerald-800 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
            >
              {gamesLoading ? 'Loading...' : 'Refresh'}
            </button>
          </div>

          {gamesLoading && !gameData && (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="card animate-pulse">
                  <div className="h-4 bg-slate-800 rounded w-full mb-3" />
                  <div className="h-2 bg-slate-800 rounded-full mb-3" />
                  <div className="h-4 bg-slate-800 rounded w-32 mb-2" />
                  <div className="h-3 bg-slate-800 rounded w-full" />
                </div>
              ))}
            </div>
          )}

          {!gamesLoading && gameData && gameData.games.length === 0 && (
            <div className="text-center py-16">
              <div className="text-4xl mb-3">⚾</div>
              <div className="text-slate-300 font-medium">No games scheduled</div>
            </div>
          )}

          {gameData && gameData.games.length > 0 && (() => {
            const nrfiSorted = [...gameData.games].sort((a, b) => {
              // NRFI picks first (sorted by NRFI prob desc), then YRFI (sorted by NRFI prob asc), then no-pick
              if (a.nrfiPick === 'NRFI' && b.nrfiPick !== 'NRFI') return -1;
              if (a.nrfiPick !== 'NRFI' && b.nrfiPick === 'NRFI') return 1;
              if (a.nrfiPick === 'YRFI' && b.nrfiPick !== 'YRFI') return 1;
              if (a.nrfiPick !== 'YRFI' && b.nrfiPick === 'YRFI') return -1;
              return b.nrfiProbability - a.nrfiProbability;
            });

            const nrfiLockHigh = nrfiSorted.filter(g => g.nrfiPick !== null && (g.nrfiConfidence === 'LOCK' || g.nrfiConfidence === 'HIGH'));
            const nrfiRest = nrfiSorted.filter(g => !nrfiLockHigh.includes(g));

            return (
              <>
                {nrfiLockHigh.length > 0 && (
                  <div className="mb-7">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-emerald-400 text-sm font-bold">★ Best NRFI/YRFI Picks</span>
                      <span className="text-slate-600 text-xs">{nrfiLockHigh.length} game{nrfiLockHigh.length !== 1 ? 's' : ''}</span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                      {nrfiLockHigh.map(game => <NRFICard key={game.gamePk} game={game} />)}
                    </div>
                  </div>
                )}
                {nrfiRest.length > 0 && (
                  <div>
                    {nrfiLockHigh.length > 0 && (
                      <div className="text-slate-600 text-xs font-medium mb-3 uppercase tracking-wide">All Games</div>
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                      {nrfiRest.map(game => <NRFICard key={game.gamePk} game={game} />)}
                    </div>
                  </div>
                )}
              </>
            );
          })()}
        </>
      )}

      {/* ── GAME PICKS ──────────────────────────────────────────────────────────── */}
      {isGamesView && (
        <>
          <div className="flex items-center justify-between mb-5">
            <p className="text-slate-400 text-sm">
              Win probability and spread leans based on starting pitching matchups and park factors.
            </p>
            <button
              onClick={() => loadGamePredictions(selectedDate)}
              disabled={gamesLoading}
              className="px-4 py-1.5 bg-mlb-navy hover:bg-blue-700 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
            >
              {gamesLoading ? 'Loading...' : 'Refresh'}
            </button>
          </div>

          {gamesLoading && !gameData && (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="card animate-pulse">
                  <div className="h-4 bg-slate-800 rounded w-full mb-3" />
                  <div className="h-2 bg-slate-800 rounded-full mb-3" />
                  <div className="h-4 bg-slate-800 rounded w-32 mb-2" />
                  <div className="h-3 bg-slate-800 rounded w-full" />
                </div>
              ))}
            </div>
          )}

          {!gamesLoading && gameData && gameData.games.length === 0 && (
            <div className="text-center py-16">
              <div className="text-4xl mb-3">⚾</div>
              <div className="text-slate-300 font-medium">No games scheduled</div>
            </div>
          )}

          {gameData && gameData.games.length > 0 && (() => {
            // Best Bets: ML LOCK/HIGH, any O/U LOCK, or NRFI LOCK/HIGH
            const bestBets = gameData.games.filter(g =>
              g.confidence === 'LOCK' || g.confidence === 'HIGH' ||
              g.totalConfidence === 'LOCK' ||
              (g.nrfiPick !== null && (g.nrfiConfidence === 'LOCK' || g.nrfiConfidence === 'HIGH'))
            );
            const theRest = gameData.games.filter(g =>
              g.confidence !== 'LOCK' && g.confidence !== 'HIGH' &&
              g.totalConfidence !== 'LOCK' &&
              !(g.nrfiPick !== null && (g.nrfiConfidence === 'LOCK' || g.nrfiConfidence === 'HIGH'))
            );
            return (
              <>
                {bestBets.length > 0 && (
                  <div className="mb-7">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-yellow-400 text-sm font-bold">★ Best Bets</span>
                      <span className="text-slate-600 text-xs">{bestBets.length} game{bestBets.length !== 1 ? 's' : ''}</span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                      {bestBets.map(game => <GamePickCard key={game.gamePk} game={game} />)}
                    </div>
                  </div>
                )}
                {theRest.length > 0 && (
                  <div>
                    {bestBets.length > 0 && (
                      <div className="text-slate-600 text-xs font-medium mb-3 uppercase tracking-wide">
                        All Other Games
                      </div>
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                      {theRest.map(game => <GamePickCard key={game.gamePk} game={game} />)}
                    </div>
                  </div>
                )}
              </>
            );
          })()}
        </>
      )}

      {/* ── TRACK RECORD ─────────────────────────────────────────────────────────── */}
      {isTrackRecordView && (
        <>
          <div className="flex items-center justify-between mb-5">
            <p className="text-slate-400 text-sm">
              Accountability: every ELITE/STRONG/VALUE prop pick and every game ML/O-U/NRFI pick, graded against what actually happened.
            </p>
            <button
              onClick={loadTrackRecord}
              disabled={trackRecordLoading}
              className="px-4 py-1.5 bg-purple-900 hover:bg-purple-800 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
            >
              {trackRecordLoading ? 'Loading...' : 'Refresh'}
            </button>
          </div>

          {trackRecordLoading && !trackRecordData && (
            <div className="text-center py-16 text-slate-500 text-sm">Grading historical picks against real results…</div>
          )}

          {trackRecordData && (
            <>
              <div className="flex flex-wrap items-center bg-slate-900 border border-slate-800 rounded-lg p-1 gap-1 mb-6 w-fit">
                {(['last7', 'last30', 'allTime'] as TrackRecordWindowKey[]).map(w => (
                  <button
                    key={w}
                    onClick={() => setTrWindow(w)}
                    className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                      trWindow === w ? 'bg-mlb-navy text-white' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {w === 'last7' ? 'Last 7 Days' : w === 'last30' ? 'Last 30 Days' : 'All Time'}
                  </button>
                ))}
                <div className="w-px bg-slate-700 mx-1 self-stretch" />
                <span className="px-3 py-1 text-slate-600 text-xs self-center">
                  {trackRecordData.gradedDateCount} day{trackRecordData.gradedDateCount !== 1 ? 's' : ''} graded
                </span>
              </div>

              {trackRecordData.gradedDateCount === 0 && (
                <div className="text-center py-16">
                  <div className="text-4xl mb-3">📊</div>
                  <div className="text-slate-300 font-medium">No graded picks yet</div>
                  <div className="text-slate-500 text-sm mt-1">
                    History builds up automatically once a day&apos;s locked-in picks go final.
                  </div>
                </div>
              )}

              {trackRecordData.gradedDateCount > 0 && (() => {
                const w: TrackRecordWindow = trackRecordData.windows[trWindow];
                const gamePickLabels: Array<[GamePickType, string]> = [
                  ['ml', 'Moneyline'], ['ou', 'Over/Under'], ['nrfi', 'NRFI/YRFI'],
                ];
                return (
                  <>
                    <div className="mb-8">
                      <div className="text-slate-400 text-xs font-medium mb-3 uppercase tracking-wide">Player Props</div>
                      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                        {(['hr', 'hit', 'run', 'rbi'] as PropType[]).map(prop => (
                          <div key={prop} className="card">
                            <div className="text-white font-semibold mb-2">{PROP_LABELS[prop]}</div>
                            {(['ELITE', 'STRONG', 'VALUE'] as ConfidenceTier[]).map(tier => (
                              <HitRateRow key={tier} label={tier} bucket={w.props[prop][tier]} />
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="mb-8">
                      <div className="text-slate-400 text-xs font-medium mb-3 uppercase tracking-wide">Game Picks</div>
                      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                        {gamePickLabels.map(([pt, label]) => (
                          <div key={pt} className="card">
                            <div className="text-white font-semibold mb-2">{label}</div>
                            {(['LOCK', 'HIGH', 'MEDIUM', 'LOW'] as GameConfidenceTier[]).map(tier => (
                              <HitRateRow key={tier} label={tier} bucket={w.games[pt][tier]} />
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="mb-8">
                      <div className="text-slate-400 text-xs font-medium mb-3 uppercase tracking-wide">Recent Picks</div>
                      <div className="card overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-slate-500 text-xs uppercase text-left">
                              <th className="pb-2 pr-4">Date</th>
                              <th className="pb-2 pr-4">Category</th>
                              <th className="pb-2 pr-4">Pick</th>
                              <th className="pb-2 pr-4">Confidence</th>
                              <th className="pb-2 pr-4">Predicted</th>
                              <th className="pb-2">Result</th>
                            </tr>
                          </thead>
                          <tbody>
                            {trackRecordData.recentLog.slice(0, 50).map((entry, i) => (
                              <tr key={i} className="border-t border-slate-800">
                                <td className="py-1.5 pr-4 text-slate-400 whitespace-nowrap">{entry.date}</td>
                                <td className="py-1.5 pr-4 text-slate-300 whitespace-nowrap">
                                  {entry.category === 'prop'
                                    ? `${PROP_LABELS[entry.prop]} prop`
                                    : { ml: 'Moneyline', ou: 'Over/Under', nrfi: 'NRFI/YRFI' }[entry.pickType]}
                                </td>
                                <td className="py-1.5 pr-4 text-slate-300 whitespace-nowrap">
                                  {entry.category === 'prop' ? entry.playerName : entry.pickLabel}
                                </td>
                                <td className="py-1.5 pr-4 whitespace-nowrap">
                                  <span className={`stat-pill ${entry.category === 'prop' ? tierClass(entry.tier) : ''}`}>
                                    {entry.category === 'prop' ? entry.tier : entry.confidence}
                                  </span>
                                </td>
                                <td className="py-1.5 pr-4 text-slate-400 whitespace-nowrap">
                                  {entry.category === 'prop' ? pct(entry.predictedProbability) : '—'}
                                </td>
                                <td className="py-1.5">
                                  {entry.correct
                                    ? <span className="text-green-400 font-bold">✓</span>
                                    : <span className="text-red-400 font-bold">✗</span>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </>
                );
              })()}
            </>
          )}

          <div className="mb-6">
            <button
              onClick={() => setShowCalibration(v => !v)}
              className="text-sm text-slate-400 hover:text-white transition-colors flex items-center gap-1.5"
            >
              <span>{showCalibration ? '▾' : '▸'}</span>
              Calibration Suggestions
              <span className="text-slate-600 text-xs">(manual review only — nothing here is applied automatically)</span>
            </button>

            {showCalibration && (
              <div className="mt-3 card">
                {calibrationLoading && !calibrationData && (
                  <div className="text-slate-500 text-sm py-4">Computing suggestions from graded history…</div>
                )}
                {calibrationData && (
                  <>
                    <div className="mb-4">
                      <div className="text-slate-300 font-medium mb-2 text-sm">Probability Calibration</div>
                      <div className="space-y-2">
                        {calibrationData.propSuggestions.map(s => (
                          <div key={s.prop} className="text-sm text-slate-400 border-l-2 border-slate-700 pl-3">
                            <span className="text-white font-medium">{PROP_LABELS[s.prop]}:</span> {s.note}
                          </div>
                        ))}
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-300 font-medium mb-2 text-sm">Confidence Tier Flags</div>
                      {calibrationData.tierFlags.length === 0 ? (
                        <div className="text-sm text-slate-500">No tier ordering issues detected (or insufficient sample).</div>
                      ) : (
                        <div className="space-y-2">
                          {calibrationData.tierFlags.map((f, i) => (
                            <div key={i} className="text-sm text-amber-400 border-l-2 border-amber-700 pl-3">{f.note}</div>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
