'use client';

import { useEffect, useState, useCallback } from 'react';
import { PredictionAPIResponse, HitterPrediction, PropType, ConfidenceTier, GamePredictionAPIResponse, GamePrediction, GameResultsAPIResponse, PlayerGameResult } from '../types';

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
  if (prob >= 0.12) return 'bg-yellow-400';
  if (prob >= 0.08) return 'bg-green-500';
  if (prob >= 0.05) return 'bg-blue-500';
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
          style={{ width: `${Math.min(prob * 6, 1) * 100}%` }}
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
  const mlIsLock  = game.confidence === 'LOCK';
  const ouIsLock  = game.totalConfidence === 'LOCK';
  const anyLock   = mlIsLock || ouIsLock;
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
          {mlIsLock && (
            <span className="ml-auto text-yellow-600 text-xs">{pct(mlPct)} win prob</span>
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
      <div className="flex items-center justify-between gap-2 mb-3">
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

// ─── HEALTH INDICATOR ─────────────────────────────────────────────────────────

function HealthDot({ status }: { status: string }) {
  const cls = status === 'ok' ? 'bg-green-500' :
              status === 'partial' || status === 'stale' ? 'bg-yellow-500' :
              status === 'unavailable' ? 'bg-slate-600' : 'bg-red-500';
  return <span className={`inline-block w-2 h-2 rounded-full ${cls}`} />;
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
// hrr/totalbases show their own card types. games shows game picks.
type ActiveView = 'hr' | 'hit' | 'run' | 'rbi' | 'hrr' | 'totalbases' | 'games';

const PROP_VIEWS: PropType[] = ['hr', 'hit', 'run', 'rbi'];

const PROP_LABELS: Record<PropType, string> = {
  hr: 'Home Run',
  hit: 'Hit',
  run: 'Run',
  rbi: 'RBI',
};

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

  const today = getTodayET();
  const isToday = selectedDate === today;
  const isPastDate = selectedDate < today;

  // Derived flags
  const isGamesView = activeView === 'games';
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

  useEffect(() => {
    loadPredictions(selectedDate);
    loadGamePredictions(selectedDate);
    if (selectedDate < getTodayET()) {
      loadHrResults(selectedDate);
    } else {
      setPlayerResults({});
    }
  }, [loadPredictions, loadGamePredictions, loadHrResults, selectedDate]);

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

  return (
    <div>
      {/* Date navigation */}
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

      {/* ── TOP NAV: Hitter Picks | Game Picks ─────────────────────────────────── */}
      <div className="flex flex-wrap bg-slate-900 border border-slate-800 rounded-lg p-1 gap-1 mb-3 w-fit">
        <button
          onClick={() => { if (isGamesView) setActiveView('hr'); }}
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
            !isGamesView ? 'bg-mlb-navy text-white' : 'text-slate-400 hover:text-white'
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
      </div>

      {/* ── SUB-NAV: shown when in any hitter view ──────────────────────────────── */}
      {!isGamesView && (
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
                    <option value={0.05}>5%+</option>
                    <option value={0.08}>8%+</option>
                    <option value={0.12}>12%+</option>
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
            // Best Bets: ML LOCK/HIGH or any O/U LOCK
            const bestBets = gameData.games.filter(g =>
              g.confidence === 'LOCK' || g.confidence === 'HIGH' || g.totalConfidence === 'LOCK'
            );
            const theRest = gameData.games.filter(g =>
              g.confidence !== 'LOCK' && g.confidence !== 'HIGH' && g.totalConfidence !== 'LOCK'
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
    </div>
  );
}
