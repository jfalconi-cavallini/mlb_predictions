import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyWind } from '../lib/wind.ts';

test('wind blowing toward Yankee Stadium CF is out', () => {
  // CF azimuth 75°. A 255° wind comes from the WSW and blows toward 75°.
  const wind = classifyWind(3313, 255, 12, false);
  assert.equal(wind.kind, 'out');
  assert.equal(wind.label, 'out to CF');
});

test('wind blowing from Yankee Stadium CF is in', () => {
  const wind = classifyWind(3313, 75, 12, false);
  assert.equal(wind.kind, 'in');
  assert.equal(wind.label, 'in from CF');
});

test('a north wind is not out to CF at every park', () => {
  // The old classifier treated 0° as out to CF everywhere. Wrigley's CF is 37°.
  const wrigley = classifyWind(17, 0, 12, false);
  assert.notEqual(wrigley.label, 'out to CF');
  // Petco's CF is due north, so a north wind blows in.
  const petco = classifyWind(2680, 0, 12, false);
  assert.equal(petco.label, 'in from CF');
});

test('a south wind at Wrigley blows out toward CF', () => {
  const wind = classifyWind(17, 180, 14, false);
  assert.equal(wind.label, 'out to CF');
});

test('indoor and unknown orientations stay neutral', () => {
  assert.equal(classifyWind(14, 180, 20, true).label, 'Indoor');
  assert.equal(classifyWind(12, 10, 3, false).label, 'Calm');
  // Globe Life Field has no stored CF azimuth. Do not copy the old park's 135°.
  assert.equal(classifyWind(5325, 0, 15, false).label, 'Wind');
  assert.equal(classifyWind(2529, 180, 12, false).kind, 'unknown');
});
