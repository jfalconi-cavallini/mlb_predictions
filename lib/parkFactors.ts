// ─── PARK FACTORS + STATIC REFERENCE DATA ────────────────────────────────────
// hrFactor  : 1.0 = neutral. >1.0 = hitter-friendly for home runs.
// runsFactor: 1.0 = neutral. >1.0 = high run-scoring environment.
// hitFactor : 1.0 = neutral. >1.0 = more hits (larger field = more singles, etc.)
// altitude  : feet above sea level (Coors effect)
//
// Source: multi-year park factor averages from Baseball Reference / FanGraphs.

import { ParkFactors } from '../types';

// ─── HITTER POSITIONS ─────────────────────────────────────────────────────────
// Any position abbreviation in this set qualifies the player as a hitter.
// VULN-07 FIX: validation.ts uppercases position strings before checking this set.
export const HITTER_POSITIONS = new Set([
  'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'OF', 'DH', 'IF', 'TWP',
]);

// ─── NON-MLB SPORT NAME BAN LIST ─────────────────────────────────────────────
// Canary names: if the data source returns any of these, reject immediately.
// VULN-06 FIX: validation.ts normalizes these (lowercase, collapsed spaces)
// before checking, so variants like "cade cunningham" or "CADE CUNNINGHAM" are caught.
export const NON_MLB_SPORT_NAMES = new Set([
  'Cade Cunningham',
  'Victor Wembanyama',
  'LeBron James',
  'Patrick Mahomes',
  'Nikola Jokic',
  'Luka Doncic',
  'Jayson Tatum',
  'Stephen Curry',
  'Kevin Durant',
  'Giannis Antetokounmpo',
  'Travis Kelce',
  'Josh Allen',
  'Lamar Jackson',
  'Justin Jefferson',
  'Davante Adams',
]);

// ─── VALID MLB TEAM IDS ───────────────────────────────────────────────────────
// Official MLB team IDs from the MLB Stats API. These are stable integer IDs.
// 30 franchises; OAK (133) retained even after Sacramento relocation.
export const VALID_MLB_TEAM_IDS = new Set<number>([
  108, // LAA – Los Angeles Angels
  109, // ARI – Arizona Diamondbacks
  110, // BAL – Baltimore Orioles
  111, // BOS – Boston Red Sox
  112, // CHC – Chicago Cubs
  113, // CIN – Cincinnati Reds
  114, // CLE – Cleveland Guardians
  115, // COL – Colorado Rockies
  116, // DET – Detroit Tigers
  117, // HOU – Houston Astros
  118, // KC  – Kansas City Royals
  119, // LAD – Los Angeles Dodgers
  120, // WSH – Washington Nationals
  121, // NYM – New York Mets
  133, // OAK – Athletics (Sacramento)
  134, // PIT – Pittsburgh Pirates
  135, // SD  – San Diego Padres
  136, // SEA – Seattle Mariners
  137, // SF  – San Francisco Giants
  138, // STL – St. Louis Cardinals
  139, // TB  – Tampa Bay Rays
  140, // TEX – Texas Rangers
  141, // TOR – Toronto Blue Jays
  142, // MIN – Minnesota Twins
  143, // PHI – Philadelphia Phillies
  144, // ATL – Atlanta Braves
  145, // CWS – Chicago White Sox
  146, // MIA – Miami Marlins
  147, // NYY – New York Yankees
  158, // MIL – Milwaukee Brewers
]);

// ─── PARK FACTORS TABLE ───────────────────────────────────────────────────────
// Keyed by MLB Stats API venue ID.
// Venue IDs sourced from: https://statsapi.mlb.com/api/v1/venues
const PARK_FACTORS_TABLE: ParkFactors[] = [
  // ── American League East ─────────────────────────────────────────────────
  {
    venueId: 2,     venueName: 'Oriole Park at Camden Yards',  // BAL
    hrFactor: 1.10, runsFactor: 1.04, hitFactor: 1.01, altitude: 20,
  },
  {
    venueId: 3,     venueName: 'Fenway Park',                  // BOS
    hrFactor: 1.04, runsFactor: 1.06, hitFactor: 1.08, altitude: 20,
  },
  {
    venueId: 3313,  venueName: 'Yankee Stadium',               // NYY
    hrFactor: 1.14, runsFactor: 1.08, hitFactor: 1.01, altitude: 55,
  },
  {
    venueId: 2524,  venueName: 'Citi Field',                   // NYM
    hrFactor: 0.90, runsFactor: 0.93, hitFactor: 0.96, altitude: 20,
  },
  {
    venueId: 14,    venueName: 'Rogers Centre',                // TOR — indoor
    hrFactor: 1.06, runsFactor: 1.05, hitFactor: 1.02, altitude: 251,
  },

  // ── American League Central ───────────────────────────────────────────────
  {
    venueId: 4,     venueName: 'Guaranteed Rate Field',        // CWS
    hrFactor: 1.08, runsFactor: 1.04, hitFactor: 1.00, altitude: 595,
  },
  {
    venueId: 5,     venueName: 'Progressive Field',            // CLE
    hrFactor: 0.97, runsFactor: 0.96, hitFactor: 0.99, altitude: 659,
  },
  {
    venueId: 2394,  venueName: 'Comerica Park',                // DET
    hrFactor: 0.87, runsFactor: 0.93, hitFactor: 0.97, altitude: 585,
  },
  {
    venueId: 7,     venueName: 'Kauffman Stadium',             // KC
    hrFactor: 0.92, runsFactor: 0.95, hitFactor: 0.99, altitude: 910,
  },
  {
    venueId: 3312,  venueName: 'Target Field',                 // MIN
    hrFactor: 1.02, runsFactor: 1.00, hitFactor: 1.01, altitude: 815,
  },

  // ── American League West ──────────────────────────────────────────────────
  {
    venueId: 1,     venueName: 'Angel Stadium',                // LAA
    hrFactor: 0.95, runsFactor: 0.96, hitFactor: 0.98, altitude: 160,
  },
  {
    venueId: 2392,  venueName: 'Minute Maid Park',             // HOU — retractable roof
    hrFactor: 1.09, runsFactor: 1.06, hitFactor: 1.03, altitude: 43,
  },
  {
    venueId: 10,    venueName: 'Sutter Health Park',           // OAK (Sacramento)
    hrFactor: 1.05, runsFactor: 1.00, hitFactor: 1.01, altitude: 30,
  },
  {
    venueId: 680,   venueName: 'T-Mobile Park',                // SEA
    hrFactor: 0.94, runsFactor: 0.95, hitFactor: 0.98, altitude: 0,
  },
  {
    venueId: 5325,  venueName: 'Globe Life Field',             // TEX — retractable roof
    hrFactor: 1.16, runsFactor: 1.10, hitFactor: 1.02, altitude: 551,
  },

  // ── National League East ──────────────────────────────────────────────────
  {
    venueId: 4705,  venueName: 'Truist Park',                  // ATL
    hrFactor: 1.12, runsFactor: 1.07, hitFactor: 1.02, altitude: 1050,
  },
  {
    venueId: 4169,  venueName: 'loanDepot park',               // MIA — retractable roof
    hrFactor: 0.89, runsFactor: 0.88, hitFactor: 0.95, altitude: 6,
  },
  {
    venueId: 2681,  venueName: 'Citizens Bank Park',           // PHI
    hrFactor: 1.19, runsFactor: 1.12, hitFactor: 1.05, altitude: 20,
  },
  {
    venueId: 31,    venueName: 'PNC Park',                     // PIT
    hrFactor: 0.94, runsFactor: 0.94, hitFactor: 0.97, altitude: 730,
  },
  {
    venueId: 3309,  venueName: 'Nationals Park',               // WSH
    hrFactor: 1.07, runsFactor: 1.03, hitFactor: 1.01, altitude: 25,
  },

  // ── National League Central ───────────────────────────────────────────────
  {
    venueId: 17,    venueName: 'Wrigley Field',                // CHC
    hrFactor: 1.09, runsFactor: 1.06, hitFactor: 1.03, altitude: 595,
  },
  {
    venueId: 2602,  venueName: 'Great American Ball Park',     // CIN
    hrFactor: 1.23, runsFactor: 1.16, hitFactor: 1.05, altitude: 550,
  },
  {
    venueId: 19,    venueName: 'Coors Field',                  // COL — extreme hitter park
    hrFactor: 1.38, runsFactor: 1.32, hitFactor: 1.18, altitude: 5280,
  },
  {
    venueId: 32,    venueName: 'American Family Field',        // MIL — retractable roof
    hrFactor: 1.05, runsFactor: 1.02, hitFactor: 1.00, altitude: 635,
  },
  {
    venueId: 2889,  venueName: 'Busch Stadium',                // STL
    hrFactor: 0.95, runsFactor: 0.96, hitFactor: 0.99, altitude: 465,
  },

  // ── National League West ──────────────────────────────────────────────────
  {
    venueId: 15,    venueName: 'Chase Field',                  // ARI — retractable roof
    hrFactor: 1.11, runsFactor: 1.07, hitFactor: 1.03, altitude: 1082,
  },
  {
    venueId: 22,    venueName: 'Dodger Stadium',               // LAD
    hrFactor: 0.91, runsFactor: 0.94, hitFactor: 0.97, altitude: 515,
  },
  {
    venueId: 2395,  venueName: 'Oracle Park',                  // SF
    hrFactor: 0.84, runsFactor: 0.90, hitFactor: 0.96, altitude: 0,
  },
  {
    venueId: 2680,  venueName: 'Petco Park',                   // SD
    hrFactor: 0.88, runsFactor: 0.91, hitFactor: 0.96, altitude: 20,
  },
  {
    venueId: 12,    venueName: 'Tropicana Field',              // TB — indoor
    hrFactor: 0.97, runsFactor: 0.95, hitFactor: 0.99, altitude: 15,
  },
];

const PARK_FACTORS_MAP = new Map<number, ParkFactors>(
  PARK_FACTORS_TABLE.map(pf => [pf.venueId, pf]),
);

const NEUTRAL_PARK: Omit<ParkFactors, 'venueId' | 'venueName'> = {
  hrFactor: 1.00,
  runsFactor: 1.00,
  hitFactor: 1.00,
  altitude: 0,
};

export function getParkFactors(venueId: number, venueName = 'Unknown Venue'): ParkFactors {
  return PARK_FACTORS_MAP.get(venueId) ?? { venueId, venueName, ...NEUTRAL_PARK };
}
