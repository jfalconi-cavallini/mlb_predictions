// Home plate → center field, degrees clockwise from north.
// From benelsen's Google-Earth bearings (gist fb330ce8302dbf7518790e26c01e6fc5).
// Citi Field is venue 2524 in the Stats API; the gist lists it as 3289, bearing 14.
// Globe Life Field (5325) is not the old Globe Life Park (13, bearing 135).
// Sutter Health Park replaced the Oakland Coliseum, so the Coliseum's 56° is not used.
// Rogers Centre, Tropicana Field, and Minute Maid Park have no open-air CF azimuth.

export const CENTER_FIELD_BEARING: Record<number, number> = {
  3309: 29,  // Nationals Park
  3313: 75,  // Yankee Stadium
  32: 130,   // American Family Field
  2681: 9,   // Citizens Bank Park
  2602: 123, // Great American Ball Park
  2680: 0,   // Petco Park
  4169: 129, // loanDepot park
  3312: 90,  // Target Field
  22: 25,   // Dodger Stadium
  7: 47,   // Kauffman Stadium
  680: 49,  // T-Mobile Park
  31: 116,  // PNC Park
  5: 359,   // Progressive Field
  4705: 149, // Truist Park
  2394: 151, // Comerica Park
  4: 127,   // Rate Field
  2: 31,    // Camden Yards
  2889: 62,  // Busch Stadium
  1: 44,    // Angel Stadium
  19: 5,    // Coors Field
  2395: 85,  // Oracle Park
  15: 0,    // Chase Field
  17: 37,   // Wrigley Field
  3: 45,    // Fenway Park
  2524: 14,  // Citi Field
};

function angleDelta(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

export type WindKind = 'out' | 'in' | 'cross' | 'calm' | 'indoor' | 'unknown';

/**
 * Meteorological degrees are where the wind comes FROM.
 * "Out to CF" means the wind is blowing toward that park's center-field azimuth.
 */
export function classifyWind(
  venueId: number,
  fromDeg: number,
  mph: number,
  indoor = false,
): { label: string; kind: WindKind; outComponent: number } {
  if (indoor) return { label: 'Indoor', kind: 'indoor', outComponent: 0 };
  if (!Number.isFinite(mph) || mph < 5) return { label: 'Calm', kind: 'calm', outComponent: 0 };
  const cf = CENTER_FIELD_BEARING[venueId];
  if (cf == null || !Number.isFinite(fromDeg)) {
    return { label: 'Wind', kind: 'unknown', outComponent: 0 };
  }
  const toward = (((fromDeg + 180) % 360) + 360) % 360;
  const delta = angleDelta(toward, cf);
  const outComponent = Math.cos((delta * Math.PI) / 180);
  if (delta <= 45) return { label: 'out to CF', kind: 'out', outComponent };
  if (delta >= 135) return { label: 'in from CF', kind: 'in', outComponent };
  return { label: 'crosswind', kind: 'cross', outComponent };
}

/**
 * +1 when the wind blows toward `targetBearing`, −1 when it blows away from it.
 * Same calm / indoor / missing-mph rules as classifyWind. A missing park
 * azimuth is the caller's problem: this uses the bearing it is given.
 */
export function outComponentToward(
  fromDeg: number,
  mph: number,
  indoor: boolean,
  targetBearing: number,
): number {
  if (indoor) return 0;
  if (!Number.isFinite(mph) || mph < 5) return 0;
  if (!Number.isFinite(fromDeg) || !Number.isFinite(targetBearing)) return 0;
  const toward = (((fromDeg + 180) % 360) + 360) % 360;
  const bearing = ((targetBearing % 360) + 360) % 360;
  const delta = angleDelta(toward, bearing);
  return Math.cos((delta * Math.PI) / 180);
}
