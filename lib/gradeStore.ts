// ─── GRADE STORE ─────────────────────────────────────────────────────────────
// Bridges locked-in predictions (data/predictions, data/game-predictions) with
// real outcomes (MLB Stats API) via scoring/grading.ts, persists the graded
// result per date (data/grades/YYYY-MM-DD.json), and aggregates hit rates for
// the Track Record tab and the calibration report.

import {
  PropType, ConfidenceTier, GamePickType, GameConfidenceTier,
  PredictionAPIResponse, GamePredictionAPIResponse, GameActual, DateGrade,
  TrackRecordWindow, HitRateBucket, TrackRecordLogEntry,
} from '../types';
import { getCached, saveCache, listCachedDates } from './cache';
import { fetchTodaysGames, fetchGameBoxscore, fetchGameLinescore } from './mlbApi';
import { gradeProp, gradeGame } from '../scoring/grading';

const PROP_TYPES: PropType[] = ['hit', 'run', 'rbi', 'hr'];
const PROP_TIERS: ConfidenceTier[] = ['ELITE', 'STRONG', 'VALUE', 'LOW'];
const GAME_PICK_TYPES: GamePickType[] = ['ml', 'ou', 'nrfi'];
const GAME_TIERS: GameConfidenceTier[] = ['LOCK', 'HIGH', 'MEDIUM', 'LOW'];

function getTodayET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ─── DATE DISCOVERY ───────────────────────────────────────────────────────────

export function getGradableDates(): string[] {
  const today = getTodayET();
  const propDates = listCachedDates('predictions');
  const gameDates = listCachedDates('game-predictions');
  const union = new Set([...propDates, ...gameDates]);
  return [...union].filter(d => d < today).sort();
}

// ─── COMPUTE A SINGLE DATE'S GRADE ────────────────────────────────────────────

async function computeGrade(date: string): Promise<DateGrade> {
  const season = date.slice(0, 4);
  const { games } = await fetchTodaysGames(date, season);

  const propsCache = getCached('predictions', date) as unknown as PredictionAPIResponse | null;
  const gamesCache = getCached('game-predictions', date) as unknown as GamePredictionAPIResponse | null;

  if (games.length === 0) {
    return { date, allFinal: true, gradedAt: new Date().toISOString(), propGrades: [], gameGrades: [] };
  }

  const allFinal = games.every(g => g.status === 'Final');

  // ── Actual per-game outcomes (final score + first-inning runs) ─────────────
  const linescores = await Promise.all(games.map(g => fetchGameLinescore(g.gamePk)));
  const actualByGamePk = new Map<number, GameActual>();
  games.forEach((g, i) => {
    const ls = linescores[i];
    actualByGamePk.set(g.gamePk, {
      gamePk: g.gamePk,
      isFinal: g.status === 'Final' && ls !== null,
      homeRuns: ls?.homeRuns ?? 0,
      awayRuns: ls?.awayRuns ?? 0,
      homeFirstInningRuns: ls?.homeFirstInningRuns ?? 0,
      awayFirstInningRuns: ls?.awayFirstInningRuns ?? 0,
    });
  });

  // ── Actual player batting lines (same source as /api/results) ──────────────
  const boxscores = await Promise.all(games.map(g => fetchGameBoxscore(g.gamePk)));
  const playerStats: Record<number, { hits: number; atBats: number; runs: number; rbi: number; homeRuns: number; totalBases: number }> = {};
  for (const r of boxscores) {
    for (const [idStr, stats] of Object.entries(r.playerStats)) {
      const id = Number(idStr);
      const existing = playerStats[id];
      if (existing) {
        existing.hits += stats.hits;
        existing.atBats += stats.atBats;
        existing.runs += stats.runs;
        existing.rbi += stats.rbi;
        existing.homeRuns += stats.homeRuns;
        existing.totalBases += stats.totalBases;
      } else {
        playerStats[id] = { ...stats };
      }
    }
  }

  // ── Grade props ─────────────────────────────────────────────────────────────
  const propGrades = [];
  for (const prediction of propsCache?.predictions ?? []) {
    for (const propType of PROP_TYPES) {
      const grade = gradeProp(date, prediction, propType, playerStats[prediction.hitter.id]);
      if (grade) propGrades.push(grade);
    }
  }

  // ── Grade games ──────────────────────────────────────────────────────────────
  const gameGrades = [];
  for (const prediction of gamesCache?.games ?? []) {
    const actual = actualByGamePk.get(prediction.gamePk);
    if (!actual) continue;
    const { ml, ou, nrfi } = gradeGame(date, prediction, actual);
    if (ml) gameGrades.push(ml);
    if (ou) gameGrades.push(ou);
    if (nrfi) gameGrades.push(nrfi);
  }

  return { date, allFinal, gradedAt: new Date().toISOString(), propGrades, gameGrades };
}

export async function loadOrComputeGrade(date: string): Promise<DateGrade> {
  const cached = getCached('grades', date) as unknown as DateGrade | null;
  if (cached && cached.allFinal) return cached;

  const grade = await computeGrade(date);
  saveCache('grades', date, grade as unknown as Record<string, unknown>);
  return grade;
}

export async function loadAllGrades(): Promise<DateGrade[]> {
  const dates = getGradableDates();
  const grades = await Promise.all(dates.map(loadOrComputeGrade));
  return grades;
}

// ─── AGGREGATION ──────────────────────────────────────────────────────────────

function emptyBucket(): HitRateBucket {
  return { wins: 0, total: 0, rate: null };
}

function bump(bucket: HitRateBucket, correct: boolean) {
  bucket.total += 1;
  if (correct) bucket.wins += 1;
  bucket.rate = bucket.total > 0 ? bucket.wins / bucket.total : null;
}

function emptyWindow(): TrackRecordWindow {
  const props = {} as TrackRecordWindow['props'];
  for (const p of PROP_TYPES) {
    props[p] = {} as Record<ConfidenceTier, HitRateBucket>;
    for (const t of PROP_TIERS) props[p][t] = emptyBucket();
  }
  const games = {} as TrackRecordWindow['games'];
  for (const gp of GAME_PICK_TYPES) {
    games[gp] = {} as Record<GameConfidenceTier, HitRateBucket>;
    for (const t of GAME_TIERS) games[gp][t] = emptyBucket();
  }
  return { props, games };
}

export function aggregateWindow(grades: DateGrade[], sinceDate: string | null): TrackRecordWindow {
  const window = emptyWindow();
  for (const dateGrade of grades) {
    if (sinceDate && dateGrade.date < sinceDate) continue;
    for (const pg of dateGrade.propGrades) {
      bump(window.props[pg.prop][pg.tier], pg.correct);
    }
    for (const gg of dateGrade.gameGrades) {
      bump(window.games[gg.pickType][gg.confidence], gg.correct);
    }
  }
  return window;
}

function daysAgoISO(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function buildRecentLog(grades: DateGrade[], limit: number): TrackRecordLogEntry[] {
  const entries: TrackRecordLogEntry[] = [];
  for (const dateGrade of grades) {
    for (const pg of dateGrade.propGrades) entries.push({ category: 'prop', ...pg });
    for (const gg of dateGrade.gameGrades) entries.push({ category: 'game', ...gg });
  }
  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return entries.slice(0, limit);
}

export async function getTrackRecord() {
  const grades = await loadAllGrades();
  return {
    windows: {
      last7: aggregateWindow(grades, daysAgoISO(7)),
      last30: aggregateWindow(grades, daysAgoISO(30)),
      allTime: aggregateWindow(grades, null),
    },
    recentLog: buildRecentLog(grades, 300),
    gradedDateCount: grades.length,
  };
}
