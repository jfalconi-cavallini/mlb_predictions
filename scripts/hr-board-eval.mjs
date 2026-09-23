#!/usr/bin/env node
// Sep 8–22 backtest for the HR board.
//
// Stats and Statcast end the day before each slate (game date < slate date).
// A hit is a published name with a boxscore home run.
//
//   npm run eval:hr:board
//
// Prints the untouched plate-appearance top 20 (the 4.13 reference) and three
// ablations plus the ISO-proxy board the site can ship before Statcast is wired.
// Unfilled spots count as misses when the rate is quoted out of 20 or 10.

import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { homeRunProbability } from '../scoring/hrModel.ts';
import {
  buildBoards,
  contactCountsForSlate,
  ENV_GATE_OPTIONS,
  FULL_BOARD_OPTIONS,
  STATCAST_OPTIONS,
  WEATHER_NEUTRAL_VENUE_IDS,
  wideStadiumFactor,
} from '../scoring/hrBoard.ts';
import { CENTER_FIELD_BEARING, classifyWind, outComponentToward } from '../lib/wind.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = process.env.HR_EVAL_CACHE || '/tmp/hrbt-cache';
const CONTACT_DIR = process.env.HR_CONTACT_DIR || '/tmp/hr-contact/games';
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
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

const VENUE_COORDS = Object.fromEntries(
  [...fs.readFileSync(path.join(ROOT, 'lib/weather.ts'), 'utf8').matchAll(
    /(\d+):\s*\{\s*lat:\s*([-0-9.]+),\s*lon:\s*([-0-9.]+)/g,
  )].map(m => [Number(m[1]), { lat: Number(m[2]), lon: Number(m[3]) }]),
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
      const res = await fetch(url, { headers: { 'User-Agent': 'mlb-predictions-hr-board-eval' } });
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

function toHit(splits) {
  const m = indexCounting(splits, ['plateAppearances', 'homeRuns', 'atBats', 'hits', 'doubles', 'triples']);
  const out = new Map();
  for (const [id, v] of m) {
    out.set(id, {
      pa: v.plateAppearances ?? 0,
      hr: v.homeRuns ?? 0,
      ab: v.atBats ?? 0,
      h: v.hits ?? 0,
      doubles: v.doubles ?? 0,
      triples: v.triples ?? 0,
      pos: v.pos,
    });
  }
  return out;
}

function toHand(splits, paKey) {
  const m = indexCounting(splits, ['homeRuns', paKey]);
  const out = new Map();
  for (const [id, v] of m) out.set(id, { hr: v.homeRuns ?? 0, pa: v[paKey] ?? 0 });
  return out;
}

function toPit(splits) {
  const m = indexCounting(splits, ['homeRuns', 'battersFaced', 'airOuts', 'groundOuts']);
  const out = new Map();
  for (const [id, v] of m) {
    out.set(id, {
      hr: v.homeRuns ?? 0,
      bf: v.battersFaced ?? 0,
      air: v.airOuts ?? 0,
      ground: v.groundOuts ?? 0,
    });
  }
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

function loadContact() {
  const hitters = new Map();
  const pitchers = new Map();
  if (!fs.existsSync(CONTACT_DIR)) return { hitters, pitchers, games: 0 };
  const files = fs.readdirSync(CONTACT_DIR).filter(f => f.endsWith('.json') && f !== 'index.json');
  let games = 0;
  for (const file of files) {
    const g = JSON.parse(fs.readFileSync(path.join(CONTACT_DIR, file), 'utf8'));
    if (!g.date || g.date < SEASON_START) continue;
    games += 1;
    for (const [id, row] of Object.entries(g.hitters ?? {})) {
      const list = hitters.get(Number(id)) ?? [];
      const o = row.o ?? {};
      list.push({
        date: g.date,
        pa: o.pa ?? 0,
        hr: o.hr ?? 0,
        bbe: o.bbe ?? 0,
        barrel: o.barrel ?? 0,
        hard: o.hard ?? 0,
      });
      hitters.set(Number(id), list);
    }
    for (const [id, row] of Object.entries(g.pitchers ?? {})) {
      const list = pitchers.get(Number(id)) ?? [];
      const o = row.o ?? {};
      const L = row.L ?? {};
      const R = row.R ?? {};
      list.push({
        date: g.date,
        bbe: o.bbe ?? 0,
        hard: o.hard ?? 0,
        bbeL: L.bbe ?? 0,
        hardL: L.hard ?? 0,
        bbeR: R.bbe ?? 0,
        hardR: R.hard ?? 0,
      });
      pitchers.set(Number(id), list);
    }
  }
  for (const list of hitters.values()) list.sort((a, b) => a.date < b.date ? -1 : 1);
  for (const list of pitchers.values()) list.sort((a, b) => a.date < b.date ? -1 : 1);
  return { hitters, pitchers, games };
}

function sumHitter(events, slateDate, start) {
  const out = { pa: 0, hr: 0, bbe: 0, barrel: 0, hard: 0 };
  if (!events) return out;
  for (const e of events) {
    if (start && e.date < start) continue;
    if (!contactCountsForSlate(e.date, slateDate)) break;
    out.pa += e.pa;
    out.hr += e.hr;
    out.bbe += e.bbe;
    out.barrel += e.barrel;
    out.hard += e.hard;
  }
  return out;
}

function sumPitcher(events, slateDate, stand) {
  const out = { bbe: 0, hard: 0 };
  if (!events) return out;
  for (const e of events) {
    if (!contactCountsForSlate(e.date, slateDate)) break;
    if (stand === 'L') { out.bbe += e.bbeL; out.hard += e.hardL; }
    else if (stand === 'R') { out.bbe += e.bbeR; out.hard += e.hardR; }
    else { out.bbe += e.bbe; out.hard += e.hard; }
  }
  return out;
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

function weatherAt(venueId, gameDateTime) {
  if (WEATHER_NEUTRAL_VENUE_IDS.has(venueId)) {
    return { tempF: null, windMph: null, fromDeg: null, neutral: true, missing: false };
  }
  const table = wxByVenue.get(venueId);
  if (!table || !gameDateTime) return { tempF: null, windMph: null, fromDeg: null, neutral: false, missing: true };
  const hour = `${gameDateTime.slice(0, 13)}:00`;
  const row = table.get(hour);
  if (!row) return { tempF: null, windMph: null, fromDeg: null, neutral: false, missing: true };
  return { tempF: row.tempF, windMph: row.windMph, fromDeg: row.windDir, neutral: false, missing: false };
}

function pullOffset(bat, pitcher) {
  const stand = bat === 'S' ? (pitcher === 'L' ? 'R' : 'L') : bat;
  return stand === 'R' ? -45 : 45;
}

function isoOf(ss) {
  if (!ss || ss.ab < 40) return null;
  return (ss.doubles + 2 * ss.triples + 3 * ss.hr) / ss.ab;
}

async function loadDate(date, contact) {
  const end = addDays(date, -1);
  const recentStart = addDays(end, -13);
  const l30Start = addDays(end, -29);
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
    for (const side of ['home', 'away']) {
      for (const pl of Object.values(data.teams?.[side]?.players ?? {})) {
        const b = pl.stats?.batting;
        if (b && num(b.homeRuns) > 0) hrs.add(pl.person.id);
      }
    }
    return hrs;
  });
  const homered = new Set(boxscores.flatMap(b => [...b]));

  const [hitSeason, hitL14, hitL30, hitVsL, hitVsR, pitSeason, pitVsL, pitVsR, hitHomeS, hitAwayS, pitHomeS, pitAwayS] = await Promise.all([
    fetchStats('hitting', SEASON_START, end),
    fetchStats('hitting', recentStart, end),
    fetchStats('hitting', l30Start, end),
    fetchStats('hitting', SEASON_START, end, 'vl'),
    fetchStats('hitting', SEASON_START, end, 'vr'),
    fetchStats('pitching', SEASON_START, end),
    fetchStats('pitching', SEASON_START, end, 'vl'),
    fetchStats('pitching', SEASON_START, end, 'vr'),
    fetchStats('hitting', SEASON_START, end, 'h'),
    fetchStats('hitting', SEASON_START, end, 'a'),
    fetchStats('pitching', SEASON_START, end, 'h'),
    fetchStats('pitching', SEASON_START, end, 'a'),
  ]);

  const H = toHit(hitSeason);
  const L14 = toHand(hitL14, 'plateAppearances');
  const L30 = toHand(hitL30, 'plateAppearances');
  const VsL = toHand(hitVsL, 'plateAppearances');
  const VsR = toHand(hitVsR, 'plateAppearances');
  const P = toPit(pitSeason);
  const PvL = toHand(pitVsL, 'battersFaced');
  const PvR = toHand(pitVsR, 'battersFaced');

  let lhr = 0; let lpa = 0; let lab = 0; let lxb = 0;
  for (const v of H.values()) {
    if (v.pos === 'P' || v.pa < 50) continue;
    lhr += v.hr; lpa += v.pa; lab += v.ab;
    lxb += v.doubles + 2 * v.triples + 3 * v.hr;
  }
  const leagueHrPa = lpa > 0 ? lhr / lpa : 0.0306;
  const leagueIso = lab > 0 ? lxb / lab : 0.155;

  const hh = teamTotals(hitHomeS, 'homeRuns', 'plateAppearances');
  const ha = teamTotals(hitAwayS, 'homeRuns', 'plateAppearances');
  const ph = teamTotals(pitHomeS, 'homeRuns', 'battersFaced');
  const paAway = teamTotals(pitAwayS, 'homeRuns', 'battersFaced');
  const empPark = new Map();
  const stadium = new Map();
  for (const tid of new Set([...hh.keys(), ...ha.keys(), ...ph.keys(), ...paAway.keys()])) {
    const homeNum = (hh.get(tid)?.num ?? 0) + (ph.get(tid)?.num ?? 0);
    const homeDen = (hh.get(tid)?.den ?? 0) + (ph.get(tid)?.den ?? 0);
    const awayNum = (ha.get(tid)?.num ?? 0) + (paAway.get(tid)?.num ?? 0);
    const awayDen = (ha.get(tid)?.den ?? 0) + (paAway.get(tid)?.den ?? 0);
    if (homeDen < 500 || awayDen < 500) continue;
    const shrunkHome = (homeNum + leagueHrPa * 2200) / (homeDen + 2200);
    const shrunkAway = (awayNum + leagueHrPa * 2200) / (awayDen + 2200);
    empPark.set(tid, Math.max(0.82, Math.min(1.35, shrunkHome / shrunkAway)));
    const wide = wideStadiumFactor(homeNum, homeDen, awayNum, awayDen, leagueHrPa);
    if (wide != null) stadium.set(tid, wide);
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
          gamePk: g.gamePk,
          lineup,
          venueId: g.venue?.id,
          pitcherId: g.teams[opp].probablePitcher?.id ?? null,
          gameDateTime: g.gameDate,
          homeTeamId: hid,
        });
      }
    }
  }

  const rosterHitters = rosters.flat().filter(r => HITTER_POS.has(r.pos));
  await fetchHands([
    ...rosterHitters.map(r => r.id),
    ...[...teamGame.values()].map(t => t.pitcherId).filter(Boolean),
  ]);

  const l14Start = addDays(date, -14);
  const rows = rosterHitters.map(r => {
    const tg = teamGame.get(r.teamId);
    const lineup = tg?.lineup ?? [];
    const lineupKnown = lineup.length >= 8;
    const idx = lineup.findIndex(p => p.id === r.id);
    const season = H.get(r.id) ?? null;
    const l14 = L14.get(r.id);
    const pitcherId = tg?.pitcherId ?? null;
    const bat = peopleCache.get(r.id)?.bat ?? 'R';
    const pitcherHand = pitcherId ? (peopleCache.get(pitcherId)?.thr ?? 'R') : null;
    const stand = bat === 'S' ? (pitcherHand === 'L' ? 'R' : 'L') : bat;
    const split = pitcherHand === 'L' ? VsL.get(r.id) : pitcherHand === 'R' ? VsR.get(r.id) : null;
    const pit = pitcherId ? P.get(pitcherId) : null;
    const pitHand = pitcherId ? (stand === 'L' ? PvL.get(pitcherId) : PvR.get(pitcherId)) : null;
    const wx = weatherAt(tg?.venueId, tg?.gameDateTime);
    const cfBearing = CENTER_FIELD_BEARING[tg?.venueId];
    const cfOut = wx.neutral || wx.missing || wx.fromDeg == null
      ? 0
      : classifyWind(tg.venueId, wx.fromDeg, wx.windMph, false).outComponent;
    const pullOut = wx.neutral || wx.missing || cfBearing == null || wx.fromDeg == null
      ? 0
      : outComponentToward(wx.fromDeg, wx.windMph, false, cfBearing + pullOffset(bat, pitcherHand));
    const seasonContact = sumHitter(contact.hitters.get(r.id), date, null);
    const l14Contact = sumHitter(contact.hitters.get(r.id), date, l14Start);
    const pitContact = sumPitcher(contact.pitchers.get(pitcherId), date, stand);
    const gamesPlayed = teamGames.get(r.teamId) ?? 0;
    const homeId = homeTeamByTeam.get(r.teamId);
    const lineupSpot = lineupKnown ? (idx >= 0 ? idx + 1 : 0) : null;
    const base = {
      playerId: r.id,
      gamePk: tg?.gamePk ?? 0,
      teamId: r.teamId,
      batHand: bat,
      lineupSpot,
      lineupKnown,
      seasonPaPerGame: gamesPlayed > 0 && season ? season.pa / gamesPlayed : null,
      seasonHr: season?.hr ?? 0,
      seasonPa: season?.pa ?? 0,
      iso: isoOf(season),
      vsHandHr: split?.hr ?? null,
      vsHandPa: split?.pa ?? null,
      l14Hr: l14?.hr ?? 0,
      l14Pa: l14?.pa ?? 0,
      l30Pa: L30.get(r.id)?.pa ?? 0,
      xIso: null,
      pitcherKnown: pitcherId != null,
      pitcherHand,
      pitcherHr: pit?.hr ?? 0,
      pitcherBf: pit?.bf ?? 0,
      pitcherVsHandHr: pitHand?.hr ?? null,
      pitcherVsHandBf: pitHand?.pa ?? null,
      pitcherAirOuts: pit ? pit.air : null,
      pitcherGroundOuts: pit ? pit.ground : null,
      stadiumHr: stadium.get(homeId) ?? null,
      weather: {
        tempF: wx.neutral ? null : wx.tempF,
        windMph: wx.neutral ? null : wx.windMph,
        cfOut,
        pullOut,
        indoorOrRoof: wx.neutral,
        missing: wx.missing,
      },
      leagueHrPa,
      leagueIso,
      baselineProbability: homeRunProbability({
        hr: season?.hr ?? 0,
        pa: season?.pa ?? 0,
        leagueHrPa,
        parkFactor: empPark.get(homeId) ?? 1,
        teamGames: gamesPlayed,
        lineupKnown,
        lineupSpot,
      }),
      homered: homered.has(r.id),
    };
    return {
      statcast: {
        ...base,
        contactSeason: seasonContact,
        contactL14: l14Contact,
        pitcherHard: pitContact.bbe > 0 ? pitContact.hard : null,
        pitcherBbe: pitContact.bbe > 0 ? pitContact.bbe : null,
      },
      proxy: {
        ...base,
        contactSeason: null,
        contactL14: null,
        pitcherHard: null,
        pitcherBbe: null,
      },
    };
  });

  return { date, games: games.length, rows, leagueHrPa };
}

function grade(board, homered, slots) {
  const hits = board.filter(p => homered.get(p.playerId)).length;
  const predicted = board.reduce((s, p) => s + p.probability, 0);
  return {
    hits,
    size: board.length,
    perSlot: slots > 0 ? hits / slots : 0,
    hitsOutOf: hits,
    predicted,
  };
}

function baselineTop(rows) {
  const ranked = rows
    .filter(r => (r.proxy.lineupKnown ? r.proxy.lineupSpot >= 1 : true))
    .sort((a, b) => b.proxy.baselineProbability - a.proxy.baselineProbability)
    .slice(0, 20);
  return ranked.filter(r => r.proxy.homered).length;
}

process.stderr.write('loading contact\n');
const contact = loadContact();
process.stderr.write(`contact games=${contact.games} hitters=${contact.hitters.size}\n`);
await loadWeather();

const days = [];
for (const date of DATES) {
  process.stderr.write(`loading ${date}\n`);
  const slate = await loadDate(date, contact);
  if (!slate) continue;
  const homered = new Map(slate.rows.map(r => [r.proxy.playerId, r.proxy.homered]));
  const env = buildBoards(slate.rows.map(r => r.proxy), ENV_GATE_OPTIONS, addDays(date, -1));
  const stat = buildBoards(slate.rows.map(r => r.statcast), STATCAST_OPTIONS, addDays(date, -1));
  const fullStat = buildBoards(slate.rows.map(r => r.statcast), FULL_BOARD_OPTIONS, addDays(date, -1));
  const fullProxy = buildBoards(slate.rows.map(r => r.proxy), FULL_BOARD_OPTIONS, addDays(date, -1));
  const row = {
    date,
    games: slate.games,
    baseline: baselineTop(slate.rows),
    env: grade(env.full, homered, 20),
    stat: grade(stat.full, homered, 20),
    order: grade(fullStat.full, homered, 20),
    spot: grade(fullStat.spot, homered, 10),
    proxyFull: grade(fullProxy.full, homered, 20),
    proxySpot: grade(fullProxy.spot, homered, 10),
  };
  days.push(row);
  console.log(
    `${date} g=${String(slate.games).padStart(2)} base ${row.baseline}/20`
    + `  env ${row.env.hits}/${row.env.size}`
    + `  +stat ${row.stat.hits}/${row.stat.size}`
    + `  +order ${row.order.hits}/${row.order.size} spot ${row.spot.hits}/${row.spot.size}`
    + `  proxy ${row.proxyFull.hits}/${row.proxyFull.size} spot ${row.proxySpot.hits}/${row.proxySpot.size}`,
  );
}

function mean(field, sub) {
  return days.reduce((s, d) => s + d[field][sub], 0) / days.length;
}

console.log('\nSep 8–22 means. Unfilled slots count as misses for /20 and /10.');
console.log(`days=${days.length}  contactGames=${contact.games}`);
console.log(`baseline plate-appearance top 20   ${(days.reduce((s, d) => s + d.baseline, 0) / days.length).toFixed(2)}/20`);
for (const [name, key] of [['env-gate alone', 'env'], ['+Statcast (no order)', 'stat'], ['+order with Statcast', 'order'], ['shipped proxy full board', 'proxyFull']]) {
  console.log(
    `${name.padEnd(28)} hits ${mean(key, 'hits').toFixed(2)}`
    + `  size ${mean(key, 'size').toFixed(1)}`
    + `  out of 20 ${mean(key, 'hits').toFixed(2)}/20`
    + `  predicted sum ${mean(key, 'predicted').toFixed(2)}`
    + `  actual on published ${mean(key, 'hits').toFixed(2)}`,
  );
}
console.log(
  `Spot Board(10) +order/Statcast  hits ${mean('spot', 'hits').toFixed(2)}`
  + `  size ${mean('spot', 'size').toFixed(1)}`
  + `  ${mean('spot', 'hits').toFixed(2)}/10`
  + `  predicted ${mean('spot', 'predicted').toFixed(2)}`,
);
console.log(
  `Spot Board(10) shipped proxy    hits ${mean('proxySpot', 'hits').toFixed(2)}`
  + `  size ${mean('proxySpot', 'size').toFixed(1)}`
  + `  ${mean('proxySpot', 'hits').toFixed(2)}/10`
  + `  predicted ${mean('proxySpot', 'predicted').toFixed(2)}`,
);
