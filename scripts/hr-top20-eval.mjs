#!/usr/bin/env node
// Point-in-time top-20 HR backtest.
// Stats end the day before each slate. A hit is a top-20 name who homered
// in that day's boxscore — the same check the site draws on past dates.
//
//   npm run eval:hr
//
// Uses the shipped homeRunProbability() from scoring/hrModel.ts for "new"
// and the pre-change logit (static park table, no lineup) for "old".

import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { homeRunProbability } from '../scoring/hrModel.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = process.env.HR_EVAL_CACHE || '/tmp/hrbt-cache';
fs.mkdirSync(CACHE, { recursive: true });

const SEASON_START = '2026-03-20';
const DATES = [];
for (let d = new Date('2026-09-08T12:00:00Z'); d <= new Date('2026-09-22T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
  DATES.push(d.toISOString().slice(0, 10));
}

function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

const PARK_HR = Object.fromEntries(
  [...fs.readFileSync(path.join(ROOT, 'lib/parkFactors.ts'), 'utf8').matchAll(/venueId:\s*(\d+)[\s\S]*?hrFactor:\s*([0-9.]+)/g)]
    .map(m => [Number(m[1]), Number(m[2])]),
);

const HITTER_POS = new Set(['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'OF', 'DH', 'IF', 'TWP']);

async function getJson(url) {
  const file = path.join(CACHE, crypto.createHash('sha1').update(url).digest('hex') + '.json');
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* refetch */ }
  }
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'mlb-predictions-hr-eval' } });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      const data = await res.json();
      fs.writeFileSync(file, JSON.stringify(data));
      return data;
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

async function fetchStats(group, start, end, sit) {
  const sitQ = sit ? `&sitCodes=${sit}` : '';
  const url = `https://statsapi.mlb.com/api/v1/stats?stats=byDateRange&group=${group}&season=2026&sportId=1&playerPool=all&limit=8000${sitQ}&startDate=${start}&endDate=${end}`;
  const data = await getJson(url);
  return data.stats?.[0]?.splits ?? [];
}

function indexCounting(splits, fields) {
  const map = new Map();
  for (const sp of splits ?? []) {
    const id = sp.player?.id;
    if (!id) continue;
    const cur = map.get(id) ?? {};
    if (sp.position?.abbreviation) cur.pos = sp.position.abbreviation;
    for (const f of fields) cur[f] = (cur[f] ?? 0) + num(sp.stat?.[f]);
    map.set(id, cur);
  }
  return map;
}

const peopleCache = new Map();
async function fetchHands(ids) {
  const missing = [...new Set(ids)].filter(id => !peopleCache.has(id));
  for (let i = 0; i < missing.length; i += 80) {
    const chunk = missing.slice(i, i + 80);
    const data = await getJson(`https://statsapi.mlb.com/api/v1/people?personIds=${chunk.join(',')}`);
    for (const p of data.people ?? []) {
      const bat = p.batSide?.code?.toUpperCase();
      const thr = p.pitchHand?.code?.toUpperCase();
      peopleCache.set(p.id, {
        bat: bat === 'L' || bat === 'S' ? bat : 'R',
        thr: thr === 'L' || thr === 'S' ? thr : 'R',
      });
    }
    for (const id of chunk) if (!peopleCache.has(id)) peopleCache.set(id, { bat: 'R', thr: 'R' });
  }
}

function toHit(splits) {
  const m = indexCounting(splits, ['plateAppearances', 'homeRuns', 'atBats', 'hits', 'doubles', 'triples', 'strikeOuts', 'baseOnBalls', 'hitByPitch', 'sacFlies']);
  const out = new Map();
  for (const [id, v] of m) {
    out.set(id, {
      pa: v.plateAppearances ?? 0, hr: v.homeRuns ?? 0, ab: v.atBats ?? 0, h: v.hits ?? 0,
      doubles: v.doubles ?? 0, triples: v.triples ?? 0, k: v.strikeOuts ?? 0,
      bb: v.baseOnBalls ?? 0, hbp: v.hitByPitch ?? 0, sf: v.sacFlies ?? 0, pos: v.pos,
    });
  }
  return out;
}

function toPit(splits) {
  const m = indexCounting(splits, ['homeRuns', 'earnedRuns', 'outs']);
  const out = new Map();
  for (const [id, v] of m) out.set(id, { hr: v.homeRuns ?? 0, er: v.earnedRuns ?? 0, ip: (v.outs ?? 0) / 3 });
  return out;
}

function teamTotals(splits, numKey, denKey) {
  const m = new Map();
  for (const sp of splits ?? []) {
    const tid = sp.team?.id;
    if (!tid) continue;
    const cur = m.get(tid) ?? { num: 0, den: 0 };
    cur.num += num(sp.stat?.[numKey]);
    cur.den += num(sp.stat?.[denKey]);
    m.set(tid, cur);
  }
  return m;
}

/** Previous production HR score: additive logit, static park table, no lineup. */
function oldHrScore(p) {
  const ss = p.season;
  const paWeight = ss && ss.pa >= 10 ? Math.min(ss.pa / 150, 1) : 0;
  const regress = (v) => v * paWeight + 0.45 * (1 - paWeight);
  const hrRate = ss && ss.pa > 0 ? ss.hr / ss.pa : 0;
  const avg = ss && ss.ab > 0 ? ss.h / ss.ab : 0;
  const tb = ss ? (ss.h + ss.doubles + 2 * ss.triples + 3 * ss.hr) : 0;
  const slg = ss && ss.ab > 0 ? tb / ss.ab : 0;
  const iso = Math.max(0, slg - avg);
  const isoNorm = ss ? clamp((iso - 0.05) / 0.25, 0, 1) : 0.30;
  const slgNorm = ss ? clamp((slg - 0.25) / 0.35, 0, 1) : 0.35;
  const power = regress((isoNorm * 0.50) + (slgNorm * 0.30) + (0.35 * 0.20));
  const hitterHRRate = regress(ss && ss.pa >= 10 ? clamp(hrRate / 0.07, 0, 1) : 0.20);

  let form = 0.50;
  const rs = p.recent;
  if (rs && rs.pa >= 10) {
    const rAvg = rs.ab > 0 ? rs.h / rs.ab : 0;
    const rTb = rs.h + rs.doubles + 2 * rs.triples + 3 * rs.hr;
    const rSlg = rs.ab > 0 ? rTb / rs.ab : 0;
    form = (clamp((rAvg - 0.15) / 0.25, 0, 1) * 0.40)
      + (clamp((rSlg - 0.25) / 0.35, 0, 1) * 0.40)
      + ((rs.hr > 0 ? Math.min(rs.hr / 4, 0.3) : 0) * 0.20);
  }

  let platoon = 0.50;
  if (p.pitcherHand) {
    if (p.bat === 'S') platoon = 0.65;
    else if ((p.bat === 'L' && p.pitcherHand === 'R') || (p.bat === 'R' && p.pitcherHand === 'L')) platoon = 0.72;
    else platoon = 0.28;
  }

  let vuln = 0.50;
  if (p.pitcher && p.pitcher.ip >= 5) {
    const hrPer9 = p.pitcher.hr / p.pitcher.ip * 9;
    const era = p.pitcher.er / p.pitcher.ip * 9;
    let seasonVuln = (clamp((hrPer9 - 0.5) / 2.0, 0, 1) * 0.50) + (clamp((era - 2.0) / 4.0, 0, 1) * 0.25) + 0.125;
    const pr = p.pitcherRecent;
    if (pr && pr.ip >= 8) {
      const rHRNorm = clamp((pr.hr / pr.ip * 9 - 0.5) / 2.0, 0, 1);
      const rEraNorm = clamp((pr.er / pr.ip * 9 - 2.0) / 4.0, 0, 1);
      seasonVuln = seasonVuln * 0.70 + (rHRNorm * 0.60 + rEraNorm * 0.40) * 0.30;
    }
    vuln = seasonVuln;
  }

  const park = clamp(((p.parkHr ?? 1) - 0.80) / 0.60, 0, 1);
  const raw = (hitterHRRate * 3.0) + (power * 1.5) + (vuln * 1.8) + (park * 1.2) + 0.40 + (platoon * 0.6) + (form * 0.4);
  return sigmoid((raw - 11.41) * 0.557);
}

function newHrProb(p, leagueHrPa) {
  return homeRunProbability({
    hr: p.season?.hr ?? 0,
    pa: p.season?.pa ?? 0,
    leagueHrPa,
    parkFactor: p.empParkHr || 1,
    teamGames: p.teamGames || 0,
    lineupKnown: !!p.lineupKnown,
    lineupSpot: p.lineupSpot,
  });
}

function newHrScore(p, leagueHrPa) {
  const poolEligible = p.lineupKnown ? p.lineupSpot >= 1 : true;
  if (!poolEligible) return -1;
  return newHrProb(p, leagueHrPa);
}

function topHits(rows, scoreFn, probFn = scoreFn) {
  const ranked = [...rows].sort((a, b) => scoreFn(b) - scoreFn(a));
  const top = ranked.slice(0, 20);
  const top10 = ranked.slice(0, 10);
  const playedRows = rows.filter(r => r.played);
  let brier = 0;
  for (const r of playedRows) {
    const p = clamp(probFn(r), 0, 1);
    brier += (p - (r.homered ? 1 : 0)) ** 2;
  }
  return {
    homers: top.filter(r => r.homered).length,
    top10: top10.filter(r => r.homered).length,
    played: top.filter(r => r.played).length,
    ev: top.reduce((s, r) => s + Math.max(0, scoreFn(r)), 0),
    brier: playedRows.length ? brier / playedRows.length : 0,
  };
}

async function loadDate(date) {
  const end = addDays(date, -1);
  const recentStart = addDays(date, -14);
  const sched = await getJson(
    `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=probablePitcher,lineups,team,venue`,
  );
  const games = (sched.dates?.[0]?.games ?? []).filter(g => g.gameType === 'R' && g.status?.abstractGameState === 'Final');
  if (!games.length) return null;

  const standings = await getJson(`https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=2026&date=${end}`);
  const teamGames = new Map();
  for (const rec of standings.records ?? []) {
    for (const tr of rec.teamRecords ?? []) teamGames.set(tr.team.id, tr.gamesPlayed);
  }

  const teamIds = [...new Set(games.flatMap(g => [g.teams.away.team.id, g.teams.home.team.id]))];
  const rosters = await pool(teamIds, 8, async (id) => {
    const data = await getJson(`https://statsapi.mlb.com/api/v1/teams/${id}/roster?season=2026&date=${date}&rosterType=active`);
    return (data.roster ?? []).map(e => ({
      id: e.person.id,
      name: e.person.fullName,
      pos: (e.position?.abbreviation ?? '').toUpperCase(),
      teamId: id,
    }));
  });

  const boxscores = await pool(games, 8, async (g) => {
    const data = await getJson(`https://statsapi.mlb.com/api/v1/game/${g.gamePk}/boxscore`);
    const hrs = new Set();
    const played = new Set();
    for (const side of ['home', 'away']) {
      for (const pl of Object.values(data.teams?.[side]?.players ?? {})) {
        const b = pl.stats?.batting;
        if (!b) continue;
        if (num(b.homeRuns) > 0) hrs.add(pl.person.id);
        if (num(b.atBats) > 0 || num(b.plateAppearances) > 0 || num(b.hits) > 0) played.add(pl.person.id);
      }
    }
    return { hrs, played };
  });
  const homered = new Set(boxscores.flatMap(b => [...b.hrs]));
  const played = new Set(boxscores.flatMap(b => [...b.played]));

  const [hitSeason, hitRecent, pitSeason, pitRecent, hitHomeS, hitAwayS, pitHomeS, pitAwayS] = await Promise.all([
    fetchStats('hitting', SEASON_START, end),
    fetchStats('hitting', recentStart, end),
    fetchStats('pitching', SEASON_START, end),
    fetchStats('pitching', recentStart, end),
    fetchStats('hitting', SEASON_START, end, 'h'),
    fetchStats('hitting', SEASON_START, end, 'a'),
    fetchStats('pitching', SEASON_START, end, 'h'),
    fetchStats('pitching', SEASON_START, end, 'a'),
  ]);

  const H = toHit(hitSeason);
  const HR = toHit(hitRecent);
  const P = toPit(pitSeason);
  const PR = toPit(pitRecent);

  let lhr = 0, lpa = 0;
  for (const v of H.values()) {
    if (v.pos === 'P' || v.pa < 50) continue;
    lhr += v.hr; lpa += v.pa;
  }
  const leagueHrPa = lpa > 0 ? lhr / lpa : 0.0306;

  const hh = teamTotals(hitHomeS, 'homeRuns', 'plateAppearances');
  const ha = teamTotals(hitAwayS, 'homeRuns', 'plateAppearances');
  const ph = teamTotals(pitHomeS, 'homeRuns', 'battersFaced');
  const paAway = teamTotals(pitAwayS, 'homeRuns', 'battersFaced');
  const empPark = new Map();
  const PRIOR_PA = 2200;
  for (const tid of new Set([...hh.keys(), ...ha.keys(), ...ph.keys(), ...paAway.keys()])) {
    const homeNum = (hh.get(tid)?.num ?? 0) + (ph.get(tid)?.num ?? 0);
    const homeDen = (hh.get(tid)?.den ?? 0) + (ph.get(tid)?.den ?? 0);
    const awayNum = (ha.get(tid)?.num ?? 0) + (paAway.get(tid)?.num ?? 0);
    const awayDen = (ha.get(tid)?.den ?? 0) + (paAway.get(tid)?.den ?? 0);
    if (homeDen < 500 || awayDen < 500) continue;
    const shrunkHome = (homeNum + leagueHrPa * PRIOR_PA) / (homeDen + PRIOR_PA);
    const shrunkAway = (awayNum + leagueHrPa * PRIOR_PA) / (awayDen + PRIOR_PA);
    empPark.set(tid, clamp(shrunkHome / shrunkAway, 0.82, 1.35));
  }

  const homeTeamByTeam = new Map();
  const teamGame = new Map();
  for (const g of games) {
    const hid = g.teams.home.team.id;
    homeTeamByTeam.set(g.teams.home.team.id, hid);
    homeTeamByTeam.set(g.teams.away.team.id, hid);
    for (const side of ['away', 'home']) {
      const tid = g.teams[side].team.id;
      const prev = teamGame.get(tid);
      const lineup = g.lineups?.[side === 'home' ? 'homePlayers' : 'awayPlayers'] ?? [];
      if (!prev || ((prev.lineup?.length ?? 0) < 8 && lineup.length >= 8)) {
        const opp = side === 'home' ? 'away' : 'home';
        teamGame.set(tid, {
          lineup,
          venueId: g.venue?.id,
          pitcherId: g.teams[opp].probablePitcher?.id ?? null,
        });
      }
    }
  }

  const rosterHitters = rosters.flat().filter(r => HITTER_POS.has(r.pos));
  const ids = [
    ...rosterHitters.map(r => r.id),
    ...[...teamGame.values()].map(t => t.pitcherId).filter(Boolean),
  ];
  await fetchHands(ids);

  const rows = rosterHitters.map(r => {
    const tg = teamGame.get(r.teamId);
    const lineup = tg?.lineup ?? [];
    const lineupKnown = lineup.length >= 8;
    const idx = lineup.findIndex(p => p.id === r.id);
    const pitcherId = tg?.pitcherId ?? null;
    return {
      id: r.id,
      name: r.name,
      bat: peopleCache.get(r.id)?.bat ?? 'R',
      season: H.get(r.id) ?? null,
      recent: HR.get(r.id) ?? null,
      teamGames: teamGames.get(r.teamId) ?? 0,
      parkHr: PARK_HR[tg?.venueId] ?? 1,
      empParkHr: empPark.get(homeTeamByTeam.get(r.teamId)) ?? 1,
      pitcher: pitcherId ? (P.get(pitcherId) ?? null) : null,
      pitcherRecent: pitcherId ? (PR.get(pitcherId) ?? null) : null,
      pitcherHand: pitcherId ? (peopleCache.get(pitcherId)?.thr ?? 'R') : null,
      lineupKnown,
      lineupSpot: lineupKnown ? (idx >= 0 ? idx + 1 : 0) : null,
      homered: homered.has(r.id),
      played: played.has(r.id),
    };
  });

  return { date, rows, leagueHrPa, games: games.length };
}

const days = [];
for (const date of DATES) {
  process.stderr.write(`loading ${date}\n`);
  const slate = await loadDate(date);
  if (!slate) continue;
  const old = topHits(slate.rows, oldHrScore);
  const neu = topHits(
    slate.rows,
    (r) => newHrScore(r, slate.leagueHrPa),
    (r) => newHrProb(r, slate.leagueHrPa),
  );
  days.push({ date, games: slate.games, old, neu });
  console.log(`${date}  games=${String(slate.games).padStart(2)}  old ${old.homers}/20 (played ${old.played})   new ${neu.homers}/20 (played ${neu.played})  newEV ${neu.ev.toFixed(1)}`);
}

function avg(pick, field) {
  return days.reduce((s, d) => s + d[pick][field], 0) / days.length;
}
const full = days.filter(d => d.games >= 12);
function avgFull(pick) {
  return full.reduce((s, d) => s + d[pick].homers, 0) / full.length;
}

console.log('\nTop-20 hitters who homered, 2026-09-08 through 2026-09-22');
console.log(`days=${days.length}  full slates (12+ games)=${full.length}`);
console.log(`old model     ${avg('old', 'homers').toFixed(2)}/20   top10 ${avg('old', 'top10').toFixed(2)}/10   full-slate ${avgFull('old').toFixed(2)}/20   played ${avg('old', 'played').toFixed(1)}/20   brier ${avg('old', 'brier').toFixed(4)}`);
console.log(`new model     ${avg('neu', 'homers').toFixed(2)}/20   top10 ${avg('neu', 'top10').toFixed(2)}/10   full-slate ${avgFull('neu').toFixed(2)}/20   played ${avg('neu', 'played').toFixed(1)}/20   brier ${avg('neu', 'brier').toFixed(4)}   mean predicted sum ${avg('neu', 'ev').toFixed(2)}`);
