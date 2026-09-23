#!/usr/bin/env node
// Dev / holdout comparison for the HR spot ranker.
//
// Stats, barrels, and weather end the day before each slate. Barrels come
// from cached play-by-play (scripts/build-contact-cache.mjs), not from a
// season-to-date Savant file.
//
// Decision rule, fixed before looking at Sep 8–22 variant scores:
//   1. On 2026-07-01 through 2026-09-07, pick the best of
//      matchup / contact / spot by top-20 homers.
//   2. Ship it only if it beats the current plate-appearance model by >= 0.20.
//   3. Then try two selection rules on that winner only (max 4 per game,
//      and drop below-league HR/PA). Keep a rule only if it adds >= 0.25.
//   4. Report that frozen choice once on 2026-09-08 through 2026-09-22.
//
//   node --experimental-strip-types scripts/hr-spot-research.mjs --from 2026-07-01 --to 2026-09-07
//   node --experimental-strip-types scripts/hr-spot-research.mjs --from 2026-09-08 --to 2026-09-22 --modes baseline

import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  homeRunProbability,
  spotHomeRunProbability,
  empiricalParkFactor,
  regressedHrPerPa,
  HR_PER_BARREL_THROUGH_JUNE,
  WEATHER_NEUTRAL_VENUE_IDS,
} from '../scoring/hrModel.ts';
import { classifyWind } from '../lib/wind.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENUE_COORDS = Object.fromEntries(
  [...fs.readFileSync(path.join(ROOT, 'lib/weather.ts'), 'utf8').matchAll(
    /(\d+):\s*\{\s*lat:\s*([-0-9.]+),\s*lon:\s*([-0-9.]+)/g,
  )].map(m => [Number(m[1]), { lat: Number(m[2]), lon: Number(m[3]) }]),
);
const CACHE = process.env.HR_EVAL_CACHE || '/tmp/hrbt-cache';
const ROW_CACHE = '/tmp/hr-spot-rows/v1';
const CONTACT_DIR = process.env.HR_CONTACT_DIR || '/tmp/hr-contact/games';
const SEASON_START = '2026-03-20';
fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(ROW_CACHE, { recursive: true });

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const FROM = flag('--from', '2026-07-01');
const TO = flag('--to', '2026-09-07');
const MODE_FILTER = new Set((flag('--modes', 'baseline,matchup,contact,spot')).split(',').filter(Boolean));

const DATES = [];
for (let d = new Date(`${FROM}T12:00:00Z`); d <= new Date(`${TO}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
  DATES.push(d.toISOString().slice(0, 10));
}

function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

const HITTER_POS = new Set(['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'OF', 'DH', 'IF', 'TWP']);

async function getJson(url) {
  const file = path.join(CACHE, crypto.createHash('sha1').update(url).digest('hex') + '.json');
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* refetch */ }
  }
  let lastErr;
  for (let i = 0; i < 5; i++) {
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
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, () => worker()));
  return out;
}

function loadContactGames() {
  if (!fs.existsSync(CONTACT_DIR)) {
    process.stderr.write('no contact cache — barrel modes fall back to HR/PA. Run scripts/build-contact-cache.mjs\n');
    return [];
  }
  const files = fs.readdirSync(CONTACT_DIR).filter(f => f.endsWith('.json'));
  if (files.length < 2000) {
    throw new Error(`contact cache has ${files.length} games; run scripts/build-contact-cache.mjs first`);
  }
  const games = [];
  let hr = 0;
  let barrels = 0;
  for (const name of files) {
    const g = JSON.parse(fs.readFileSync(path.join(CONTACT_DIR, name), 'utf8'));
    games.push(g);
    if (g.date <= '2026-06-30') {
      for (const row of Object.values(g.hitters)) {
        hr += row.o.hr;
        barrels += row.o.barrel;
      }
    }
  }
  const k = barrels > 0 ? hr / barrels : null;
  process.stderr.write(`contact games=${games.length} june hr/barrel=${k?.toFixed(4)} frozen=${HR_PER_BARREL_THROUGH_JUNE.toFixed(4)}\n`);
  return games;
}

function emptySide() {
  return { pa: 0, hr: 0, barrel: 0 };
}
function addSide(map, id, row) {
  const key = Number(id);
  let cur = map.get(key);
  if (!cur) {
    cur = { o: emptySide(), L: emptySide(), R: emptySide() };
    map.set(key, cur);
  }
  for (const side of ['o', 'L', 'R']) {
    cur[side].pa += row[side]?.pa ?? 0;
    cur[side].hr += row[side]?.hr ?? 0;
    cur[side].barrel += row[side]?.barrel ?? 0;
  }
}

function contactThrough(games, endExclusive) {
  const hitters = new Map();
  const pitchers = new Map();
  let pa = 0;
  let barrels = 0;
  for (const g of games) {
    if (g.date >= endExclusive || g.date < SEASON_START) continue;
    for (const [id, row] of Object.entries(g.hitters)) {
      addSide(hitters, id, row);
      pa += row.o.pa;
      barrels += row.o.barrel;
    }
    for (const [id, row] of Object.entries(g.pitchers)) addSide(pitchers, id, row);
  }
  return { hitters, pitchers, leagueBarrelPa: pa > 0 ? barrels / pa : 0.05 };
}

const wxByVenue = new Map();
async function loadWeather() {
  const venues = Object.entries(VENUE_COORDS);
  await pool(venues, 6, async ([id, coords]) => {
    const venueId = Number(id);
    if (WEATHER_NEUTRAL_VENUE_IDS.has(venueId)) return;
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${coords.lat}&longitude=${coords.lon}`
      + `&start_date=2026-07-01&end_date=2026-09-22`
      + `&hourly=temperature_2m,wind_speed_10m,wind_direction_10m`
      + `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=UTC`;
    const data = await getJson(url);
    const table = new Map();
    const times = data.hourly?.time ?? [];
    for (let i = 0; i < times.length; i++) {
      table.set(times[i], {
        tempF: data.hourly.temperature_2m[i],
        windMph: data.hourly.wind_speed_10m[i],
        windDir: data.hourly.wind_direction_10m[i],
      });
    }
    wxByVenue.set(venueId, table);
  });
  process.stderr.write(`weather venues=${wxByVenue.size}\n`);
}

function weatherFor(venueId, gameDateTime) {
  if (WEATHER_NEUTRAL_VENUE_IDS.has(venueId)) {
    return { tempF: null, windMph: null, outComponent: 0, indoor: true, suppress: true };
  }
  const table = wxByVenue.get(venueId);
  if (!table || !gameDateTime) {
    return { tempF: null, windMph: null, outComponent: 0, indoor: false, suppress: true };
  }
  const hour = `${gameDateTime.slice(0, 13)}:00`;
  const row = table.get(hour);
  if (!row) return { tempF: null, windMph: null, outComponent: 0, indoor: false, suppress: true };
  const wind = classifyWind(venueId, row.windDir, row.windMph, false);
  return {
    tempF: row.tempF,
    windMph: row.windMph,
    outComponent: wind.outComponent,
    indoor: false,
    suppress: false,
  };
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

async function loadDate(date, contactGames) {
  const cacheFile = path.join(ROW_CACHE, `${date}.json`);
  if (fs.existsSync(cacheFile)) {
    try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* rebuild */ }
  }

  const end = addDays(date, -1);
  const recentStart = addDays(date, -45);
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

  const [hitSeason, hitVsL, hitVsR, hitRecent, pitSeason, hitHomeS, hitAwayS, pitHomeS, pitAwayS] = await Promise.all([
    fetchStats('hitting', SEASON_START, end),
    fetchStats('hitting', SEASON_START, end, 'vl'),
    fetchStats('hitting', SEASON_START, end, 'vr'),
    fetchStats('hitting', recentStart, end),
    fetchStats('pitching', SEASON_START, end),
    fetchStats('hitting', SEASON_START, end, 'h'),
    fetchStats('hitting', SEASON_START, end, 'a'),
    fetchStats('pitching', SEASON_START, end, 'h'),
    fetchStats('pitching', SEASON_START, end, 'a'),
  ]);

  const H = indexCounting(hitSeason, ['plateAppearances', 'homeRuns']);
  const VL = indexCounting(hitVsL, ['plateAppearances', 'homeRuns']);
  const VR = indexCounting(hitVsR, ['plateAppearances', 'homeRuns']);
  const REC = indexCounting(hitRecent, ['plateAppearances', 'homeRuns']);
  const P = indexCounting(pitSeason, ['homeRuns', 'battersFaced']);

  let lhr = 0;
  let lpa = 0;
  for (const v of H.values()) {
    if (v.pos === 'P' || (v.plateAppearances ?? 0) < 50) continue;
    lhr += v.homeRuns ?? 0;
    lpa += v.plateAppearances ?? 0;
  }
  const leagueHrPa = lpa > 0 ? lhr / lpa : 0.0306;

  const hh = teamTotals(hitHomeS, 'homeRuns', 'plateAppearances');
  const ha = teamTotals(hitAwayS, 'homeRuns', 'plateAppearances');
  const ph = teamTotals(pitHomeS, 'homeRuns', 'battersFaced');
  const paAway = teamTotals(pitAwayS, 'homeRuns', 'battersFaced');
  const empPark = new Map();
  for (const tid of new Set([...hh.keys(), ...ha.keys(), ...ph.keys(), ...paAway.keys()])) {
    const factor = empiricalParkFactor(
      (hh.get(tid)?.num ?? 0) + (ph.get(tid)?.num ?? 0),
      (hh.get(tid)?.den ?? 0) + (ph.get(tid)?.den ?? 0),
      (ha.get(tid)?.num ?? 0) + (paAway.get(tid)?.num ?? 0),
      (ha.get(tid)?.den ?? 0) + (paAway.get(tid)?.den ?? 0),
      leagueHrPa,
    );
    if (factor != null) empPark.set(tid, factor);
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
          gamePk: g.gamePk,
          gameDate: g.gameDate,
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

  const contact = contactThrough(contactGames, date);
  const pack = (row) => (row ? { pa: row.pa, hr: row.hr, barrel: row.barrel } : null);

  const rows = rosterHitters.map(r => {
    const tg = teamGame.get(r.teamId);
    const lineup = tg?.lineup ?? [];
    const lineupKnown = lineup.length >= 8;
    const idx = lineup.findIndex(p => p.id === r.id);
    const pitcherId = tg?.pitcherId ?? null;
    const season = H.get(r.id);
    const vsL = VL.get(r.id);
    const vsR = VR.get(r.id);
    const recent = REC.get(r.id);
    const pit = pitcherId ? P.get(pitcherId) : null;
    const c = contact.hitters.get(r.id) ?? null;
    const pc = pitcherId ? (contact.pitchers.get(pitcherId) ?? null) : null;
    const venueId = tg?.venueId ?? 0;
    return {
      id: r.id,
      name: r.name,
      gamePk: tg?.gamePk ?? 0,
      season: season ? { hr: season.homeRuns ?? 0, pa: season.plateAppearances ?? 0 } : null,
      vsL: vsL ? { hr: vsL.homeRuns ?? 0, pa: vsL.plateAppearances ?? 0 } : null,
      vsR: vsR ? { hr: vsR.homeRuns ?? 0, pa: vsR.plateAppearances ?? 0 } : null,
      recent: recent ? { hr: recent.homeRuns ?? 0, pa: recent.plateAppearances ?? 0 } : null,
      teamGames: teamGames.get(r.teamId) ?? 0,
      empParkHr: empPark.get(homeTeamByTeam.get(r.teamId)) ?? 1,
      pitcher: pit ? { hr: pit.homeRuns ?? 0, bf: pit.battersFaced ?? 0 } : null,
      pitcherHand: pitcherId ? (peopleCache.get(pitcherId)?.thr ?? 'R') : null,
      lineupKnown,
      lineupSpot: lineupKnown ? (idx >= 0 ? idx + 1 : 0) : null,
      contact: c ? { o: pack(c.o), L: pack(c.L), R: pack(c.R) } : null,
      pitcherContact: pc ? { o: pack(pc.o) } : null,
      weather: weatherFor(venueId, tg?.gameDate),
      homered: homered.has(r.id),
      played: played.has(r.id),
    };
  });

  const slate = {
    date,
    games: games.length,
    leagueHrPa,
    leagueBarrelPa: contact.leagueBarrelPa,
    rows,
  };
  fs.writeFileSync(cacheFile, JSON.stringify(slate));
  return slate;
}

function spotInput(row, slate) {
  const hand = row.pitcherHand === 'L' ? row.vsL : row.pitcherHand === 'R' ? row.vsR : null;
  const side = row.pitcherHand === 'L' ? row.contact?.L : row.pitcherHand === 'R' ? row.contact?.R : null;
  return {
    hr: row.season?.hr ?? 0,
    pa: row.season?.pa ?? 0,
    leagueHrPa: slate.leagueHrPa,
    parkFactor: row.empParkHr || 1,
    teamGames: row.teamGames || 0,
    lineupKnown: !!row.lineupKnown,
    lineupSpot: row.lineupSpot,
    handHr: hand?.hr ?? null,
    handPa: hand?.pa ?? null,
    pitcherHr: row.pitcher && row.pitcher.bf > 0 ? row.pitcher.hr : null,
    pitcherBf: row.pitcher && row.pitcher.bf > 0 ? row.pitcher.bf : null,
    barrels: row.contact?.o?.barrel ?? null,
    barrelPa: row.contact?.o?.pa ?? null,
    handBarrels: side?.barrel ?? null,
    handBarrelPa: side?.pa ?? null,
    pitcherBarrels: row.pitcherContact?.o?.barrel ?? null,
    pitcherBarrelBf: row.pitcherContact?.o?.pa ?? null,
    leagueBarrelPa: slate.leagueBarrelPa,
    hrPerBarrel: HR_PER_BARREL_THROUGH_JUNE,
    recentHr: row.recent?.pa ? row.recent.hr : null,
    recentPa: row.recent?.pa ?? null,
    tempF: row.weather?.tempF ?? null,
    windMph: row.weather?.windMph ?? null,
    windOutComponent: row.weather?.outComponent ?? 0,
    indoor: !!row.weather?.indoor,
    suppressWeather: !!row.weather?.suppress,
  };
}

function eligible(row, score) {
  if (row.lineupKnown && !(row.lineupSpot >= 1)) return -1;
  return score;
}

function baselineProb(row, slate) {
  return homeRunProbability({
    hr: row.season?.hr ?? 0,
    pa: row.season?.pa ?? 0,
    leagueHrPa: slate.leagueHrPa,
    parkFactor: row.empParkHr || 1,
    teamGames: row.teamGames || 0,
    lineupKnown: !!row.lineupKnown,
    lineupSpot: row.lineupSpot,
  });
}

const MODES = {
  baseline(row, slate) {
    return eligible(row, baselineProb(row, slate));
  },
  matchup(row, slate) {
    return eligible(row, spotHomeRunProbability(spotInput(row, slate), 'matchup'));
  },
  contact(row, slate) {
    return eligible(row, spotHomeRunProbability(spotInput(row, slate), 'contact'));
  },
  spot(row, slate) {
    return eligible(row, spotHomeRunProbability(spotInput(row, slate), 'spot'));
  },
};

function pickTop(rows, slate, mode, { cap = 0, power = false } = {}) {
  const scoreFn = MODES[mode];
  const probFn = mode === 'baseline'
    ? (row) => baselineProb(row, slate)
    : (row) => spotHomeRunProbability(spotInput(row, slate), mode);
  const ranked = rows.map(row => {
    let score = scoreFn(row, slate);
    if (power) {
      const rate = regressedHrPerPa(row.season?.hr ?? 0, row.season?.pa ?? 0, slate.leagueHrPa);
      if (!(rate >= slate.leagueHrPa)) score = -1;
    }
    return { row, score };
  }).sort((a, b) => b.score - a.score || a.row.id - b.row.id);

  const picked = [];
  const perGame = new Map();
  for (const item of ranked) {
    if (cap > 0) {
      const n = perGame.get(item.row.gamePk) ?? 0;
      if (n >= cap) continue;
      perGame.set(item.row.gamePk, n + 1);
    }
    picked.push(item.row);
    if (picked.length === 20) break;
  }
  const top10 = [];
  const perGame10 = new Map();
  for (const item of ranked) {
    if (cap > 0) {
      const n = perGame10.get(item.row.gamePk) ?? 0;
      if (n >= cap) continue;
      perGame10.set(item.row.gamePk, n + 1);
    }
    top10.push(item.row);
    if (top10.length === 10) break;
  }
  return {
    homers: picked.filter(r => r.homered).length,
    top10: top10.filter(r => r.homered).length,
    played: picked.filter(r => r.played).length,
    ev: picked.reduce((s, r) => s + Math.max(0, probFn(r)), 0),
    ids: picked.map(r => r.id),
  };
}

function average(days, key) {
  const n = days.length || 1;
  const sum = (field) => days.reduce((s, d) => s + d.scores[key][field], 0);
  return {
    homers: sum('homers') / n,
    top10: sum('top10') / n,
    ev: sum('ev') / n,
    played: sum('played') / n,
  };
}

function overlapReport(days, mode) {
  let onlyNew = 0;
  let onlyNewHr = 0;
  let onlyOld = 0;
  let onlyOldHr = 0;
  let slots = 0;
  for (const day of days) {
    const a = new Set(day.scores.baseline.ids);
    const b = day.scores[mode].ids;
    const rowById = new Map(day.rows.map(r => [r.id, r]));
    for (const id of b) {
      slots++;
      if (a.has(id)) continue;
      onlyNew++;
      if (rowById.get(id)?.homered) onlyNewHr++;
    }
    for (const id of a) {
      if (b.includes(id)) continue;
      onlyOld++;
      if (rowById.get(id)?.homered) onlyOldHr++;
    }
  }
  return {
    replacedPerDay: onlyNew / (days.length || 1),
    newHomers: onlyNew ? onlyNewHr / onlyNew : 0,
    oldHomers: onlyOld ? onlyOldHr / onlyOld : 0,
    slots,
  };
}

const contactGames = loadContactGames();
await loadWeather();

const loaded = await pool(DATES, 3, async (date) => {
  process.stderr.write(`loading ${date}\n`);
  const slate = await loadDate(date, contactGames);
  if (!slate) {
    process.stderr.write(`skip ${date}\n`);
    return null;
  }
  const scores = {};
  for (const mode of MODE_FILTER) {
    if (!MODES[mode]) continue;
    scores[mode] = pickTop(slate.rows, slate, mode);
  }
  const bits = [...MODE_FILTER].filter(m => scores[m]).map(m => `${m} ${scores[m].homers}`).join('  ');
  console.log(`${date}  games=${String(slate.games).padStart(2)}  ${bits}`);
  return { date, games: slate.games, leagueHrPa: slate.leagueHrPa, rows: slate.rows, scores };
});
const days = loaded.filter(Boolean).sort((a, b) => a.date < b.date ? -1 : 1);

function report(label, subset) {
  if (!subset.length) return;
  console.log(`\n${label}  days=${subset.length}`);
  for (const mode of MODE_FILTER) {
    if (!subset[0].scores[mode]) continue;
    const a = average(subset, mode);
    console.log(
      `${mode.padEnd(10)} ${a.homers.toFixed(2)}/20   top10 ${a.top10.toFixed(2)}/10   `
      + `played ${a.played.toFixed(1)}/20   predicted sum ${a.ev.toFixed(2)}`,
    );
  }
  if (subset[0].scores.baseline) {
    for (const mode of MODE_FILTER) {
      if (mode === 'baseline' || !subset[0].scores[mode]) continue;
      const o = overlapReport(subset, mode);
      console.log(
        `  ${mode} replaced ${o.replacedPerDay.toFixed(1)}/20 names; `
        + `those homered ${(100 * o.newHomers).toFixed(1)}% vs ${(100 * o.oldHomers).toFixed(1)}% for the names they replaced`,
      );
    }
  }
}

const full = days.filter(d => d.games >= 12);
report(`Top-20 hitters who homered, ${FROM} through ${TO}`, days);
report('Full slates only (12+ games)', full);
const july = days.filter(d => d.date < '2026-08-01');
const august = days.filter(d => d.date >= '2026-08-01' && d.date <= '2026-09-07');
if (july.length && august.length) {
  report('July only', july);
  report('Aug 1–Sep 7 only', august);
}
