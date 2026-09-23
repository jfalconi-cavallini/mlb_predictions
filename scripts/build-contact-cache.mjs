#!/usr/bin/env node
// Point-in-time batted-ball cache from MLB play-by-play.
// One compact file per final game: PA, HR, barrels, hard-hit, split by pitcher hand.
// Barrels use the public Statcast zone (98 mph, 26–30°, widening to 8–50° at 116 mph).
// No season-to-date leaderboard — each slate can sum games strictly before that date.

import fs from 'fs';
import path from 'path';

const OUT = process.env.HR_CONTACT_DIR || '/tmp/hr-contact';
const START = process.env.HR_CONTACT_START || '2026-03-20';
const END = process.env.HR_CONTACT_END || '2026-09-22';
fs.mkdirSync(path.join(OUT, 'games'), { recursive: true });

const PA_EVENTS = new Set([
  'single', 'double', 'triple', 'home_run',
  'field_out', 'force_out', 'fielders_choice', 'fielders_choice_out',
  'grounded_into_double_play', 'double_play', 'triple_play',
  'sac_fly', 'sac_bunt', 'sac_fly_double_play', 'sac_bunt_double_play',
  'strikeout', 'strikeout_double_play',
  'walk', 'intent_walk', 'hit_by_pitch',
  'field_error', 'catcher_interf',
]);

function isBarrel(speed, angle) {
  if (speed == null || angle == null || speed < 98) return false;
  const s = Math.min(speed, 116);
  const lower = 26 + (s - 98) * ((8 - 26) / 18);
  const upper = 30 + (s - 98) * ((50 - 30) / 18);
  return angle >= lower && angle <= upper;
}

async function getJson(url) {
  let lastErr;
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'mlb-predictions-hr-eval' } });
      if (res.status === 429 || res.status >= 500) throw new Error(`${res.status} ${url}`);
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function listFinalGames() {
  const games = [];
  let cursor = START;
  while (cursor <= END) {
    const chunkEnd = addDays(cursor, 13);
    const end = chunkEnd < END ? chunkEnd : END;
    const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&gameType=R&startDate=${cursor}&endDate=${end}`;
    const data = await getJson(url);
    for (const day of data.dates ?? []) {
      for (const g of day.games ?? []) {
        if (g.status?.abstractGameState !== 'Final') continue;
        games.push({ gamePk: g.gamePk, date: day.date });
      }
    }
    process.stderr.write(`schedule ${cursor}..${end} games=${games.length}\n`);
    cursor = addDays(end, 1);
  }
  return games;
}

function emptySide() {
  return { pa: 0, hr: 0, bbe: 0, barrel: 0, hard: 0 };
}

function bump(map, id, side, fn) {
  if (!id) return;
  let row = map.get(id);
  if (!row) {
    row = { o: emptySide(), L: emptySide(), R: emptySide() };
    map.set(id, row);
  }
  fn(row.o);
  if (side === 'L' || side === 'R') fn(row[side]);
}

function reduceGame(data) {
  const hitters = new Map();
  const pitchers = new Map();
  for (const play of data.allPlays ?? []) {
    const event = play.result?.eventType;
    if (!PA_EVENTS.has(event)) continue;
    const batterId = play.matchup?.batter?.id;
    const pitcherId = play.matchup?.pitcher?.id;
    const throws = play.matchup?.pitchHand?.code;
    const stand = play.matchup?.batSide?.code;
    const pitchSide = throws === 'L' ? 'L' : 'R';
    const batSide = stand === 'L' ? 'L' : 'R';
    let speed = null;
    let angle = null;
    for (const ev of play.playEvents ?? []) {
      if (ev.hitData && ev.hitData.launchSpeed != null) {
        speed = ev.hitData.launchSpeed;
        angle = ev.hitData.launchAngle;
      }
    }
    const hr = event === 'home_run' ? 1 : 0;
    const bbe = speed != null ? 1 : 0;
    const barrel = isBarrel(speed, angle) ? 1 : 0;
    const hard = speed != null && speed >= 95 ? 1 : 0;
    bump(hitters, batterId, pitchSide, (s) => {
      s.pa += 1; s.hr += hr; s.bbe += bbe; s.barrel += barrel; s.hard += hard;
    });
    bump(pitchers, pitcherId, batSide, (s) => {
      s.pa += 1; s.hr += hr; s.bbe += bbe; s.barrel += barrel; s.hard += hard;
    });
  }
  function pack(map) {
    const out = {};
    for (const [id, row] of map) out[id] = row;
    return out;
  }
  return { hitters: pack(hitters), pitchers: pack(pitchers) };
}

async function pool(items, n, fn) {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: n }, worker));
}

const games = await listFinalGames();
let done = 0;
let skipped = 0;
await pool(games, 8, async (g) => {
  const file = path.join(OUT, 'games', `${g.gamePk}.json`);
  if (fs.existsSync(file)) {
    skipped++;
    done++;
    return;
  }
  const url = `https://statsapi.mlb.com/api/v1/game/${g.gamePk}/playByPlay?fields=allPlays,result,eventType,matchup,batter,id,batSide,code,pitcher,pitchHand,playEvents,hitData,launchSpeed,launchAngle`;
  try {
    const data = await getJson(url);
    const reduced = reduceGame(data);
    fs.writeFileSync(file, JSON.stringify({ gamePk: g.gamePk, date: g.date, ...reduced }));
  } catch (err) {
    process.stderr.write(`fail ${g.gamePk} ${err.message}\n`);
  }
  done++;
  if (done % 50 === 0) process.stderr.write(`pbp ${done}/${games.length} skipped ${skipped}\n`);
});

const index = [];
for (const g of games) {
  const file = path.join(OUT, 'games', `${g.gamePk}.json`);
  if (fs.existsSync(file)) index.push({ gamePk: g.gamePk, date: g.date });
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index));
process.stderr.write(`wrote ${index.length} games to ${OUT}\n`);
