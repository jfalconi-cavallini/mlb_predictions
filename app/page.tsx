'use client';

import { useEffect, useState, useCallback } from 'react';
import { PredictionAPIResponse, HitterPrediction, PropType, ConfidenceTier } from '../types';

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

// ─── PROP TABS ────────────────────────────────────────────────────────────────

const PROP_LABELS: Record<PropType, string> = {
  hr: 'Home Run',
  hit: 'Hit',
  run: 'Run',
  rbi: 'RBI',
};

// ─── PREDICTION CARD ──────────────────────────────────────────────────────────

function PredictionCard({
  pred,
  rank,
  activeProp,
}: {
  pred: HitterPrediction;
  rank: number;
  activeProp: PropType;
}) {
  const { hitter, game, opposingPitcher, parkFactors, probabilities, explanations, lineupStatus } = pred;
  const explanation = explanations.find(e => e.prop === activeProp);
  const prob = probabilities[activeProp];
  const isHome = game.homeTeam.id === hitter.team.id;
  const matchup = isHome
    ? `${game.awayTeam.abbreviation || game.awayTeam.name} @ ${game.homeTeam.abbreviation || game.homeTeam.name}`
    : `${game.awayTeam.abbreviation || game.awayTeam.name} @ ${game.homeTeam.abbreviation || game.homeTeam.name}`;

  return (
    <div className="card hover:border-slate-700 transition-colors">
      {/* Header row */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-3">
          <span className="text-slate-500 font-mono text-sm w-6 shrink-0">#{rank}</span>
          <div>
            <div className="font-bold text-white text-sm">{hitter.fullName}</div>
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

        {/* Main probability badge */}
        <div className="text-right shrink-0">
          <div className="font-mono text-xl font-bold text-white">{pct(prob)}</div>
          {explanation && (
            <span className={`stat-pill text-xs ${tierClass(explanation.confidence)}`}>
              {explanation.confidence}
            </span>
          )}
        </div>
      </div>

      {/* Probability bar */}
      <div className="h-1.5 bg-slate-800 rounded-full mb-3 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${probBarColor(prob)}`}
          style={{ width: `${Math.min(prob * 6, 1) * 100}%` }}
        />
      </div>

      {/* All 4 prop probabilities */}
      <div className="grid grid-cols-4 gap-1.5 mb-3">
        {(['hr', 'hit', 'run', 'rbi'] as PropType[]).map(p => {
          const ex = explanations.find(e => e.prop === p);
          return (
            <div
              key={p}
              className={`text-center p-1.5 rounded-lg ${activeProp === p ? 'bg-slate-800 ring-1 ring-slate-600' : 'bg-slate-900'}`}
            >
              <div className="text-slate-400 text-xs uppercase tracking-wider">{p}</div>
              <div className="font-mono font-bold text-sm text-white">{pct(probabilities[p])}</div>
              {ex && (
                <span className={`stat-pill text-[10px] ${tierClass(ex.confidence)}`}>
                  {ex.confidence}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Matchup context */}
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

      {/* Season stats */}
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

      {/* Key drivers */}
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

export default function Home() {
  const [data, setData] = useState<PredictionAPIResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeProp, setActiveProp] = useState<PropType>('hr');
  const [showRejected, setShowRejected] = useState(false);
  const [minProb, setMinProb] = useState(0);
  const [selectedDate, setSelectedDate] = useState<string>(getTodayET());

  const today = getTodayET();
  const isToday = selectedDate === today;

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

  useEffect(() => { loadPredictions(selectedDate); }, [loadPredictions, selectedDate]);

  function goToDate(date: string) {
    if (date > today) return;
    setSelectedDate(date);
    setData(null);
  }

  // Re-sort predictions based on active prop
  const sortedPredictions = data
    ? [...data.predictions].sort((a, b) => b.probabilities[activeProp] - a.probabilities[activeProp])
    : [];

  const filteredPredictions = sortedPredictions.filter(
    p => p.probabilities[activeProp] >= minProb,
  );

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

      {/* Controls bar */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        {/* Prop selector */}
        <div className="flex bg-slate-900 border border-slate-800 rounded-lg p-1 gap-1">
          {(['hr', 'hit', 'run', 'rbi'] as PropType[]).map(p => (
            <button
              key={p}
              onClick={() => setActiveProp(p)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                activeProp === p
                  ? 'bg-mlb-navy text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {PROP_LABELS[p]}
            </button>
          ))}
        </div>

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

      {/* Error state */}
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
                {[...Array(4)].map((_, j) => (
                  <div key={j} className="h-12 bg-slate-800 rounded-lg" />
                ))}
              </div>
              <div className="space-y-2">
                <div className="h-3 bg-slate-800 rounded w-full" />
                <div className="h-3 bg-slate-800 rounded w-4/5" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* No games */}
      {!loading && data && data.predictions.length === 0 && (
        <div className="text-center py-16">
          <div className="text-4xl mb-3">⚾</div>
          <div className="text-slate-300 font-medium">No predictions available</div>
          <div className="text-slate-500 text-sm mt-1">
            {data.warnings[0] ?? 'No games may be scheduled for today'}
          </div>
        </div>
      )}

      {/* No results after filter */}
      {!loading && data && data.predictions.length > 0 && filteredPredictions.length === 0 && (
        <div className="text-center py-10">
          <div className="text-slate-400">No hitters meet the minimum probability filter.</div>
          <button
            onClick={() => setMinProb(0)}
            className="mt-2 text-blue-400 text-sm hover:underline"
          >
            Clear filter
          </button>
        </div>
      )}

      {/* Prediction grid */}
      {!loading && filteredPredictions.length > 0 && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filteredPredictions.map((pred, i) => (
              <PredictionCard
                key={`${pred.hitter.id}-${pred.game.gamePk}`}
                pred={pred}
                rank={i + 1}
                activeProp={activeProp}
              />
            ))}
          </div>

          {/* Rejection log toggle */}
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
    </div>
  );
}
