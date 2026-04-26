# MLB Prediction Engine

A full-stack MLB player prop and game prediction tool built with **Next.js 14 (App Router)**, **TypeScript**, and the public **MLB Stats API**. It generates daily probability estimates for individual player props (HR, Hit, Run, RBI, combined Hit+Run+RBI, Total Bases) and game-level spread leans, all derived from a transparent, interpretable feature-based scoring model — no black-box ML, no training data required.

---

## Table of Contents

1. [What It Does](#what-it-does)
2. [Tech Stack](#tech-stack)
3. [Architecture Overview](#architecture-overview)
4. [Data Pipeline (Step-by-Step)](#data-pipeline-step-by-step)
5. [Prediction Engine](#prediction-engine)
6. [Derived Metrics — HRR and Total Bases](#derived-metrics--hrr-and-total-bases)
7. [Game Prediction Engine](#game-prediction-engine)
8. [Validation Layer and Security Patches](#validation-layer-and-security-patches)
9. [API Routes](#api-routes)
10. [Frontend](#frontend)
11. [Caching Strategy](#caching-strategy)
12. [Weather Integration](#weather-integration)
13. [Park Factors](#park-factors)
14. [Key Design Decisions](#key-design-decisions)
15. [Known Limitations and Next Steps](#known-limitations-and-next-steps)
16. [Running Locally](#running-locally)

---

## What It Does

Every time a user loads the page for a given date, the engine:

1. Fetches the MLB schedule from the official MLB Stats API
2. Pulls active rosters for every team playing that day
3. Runs every player through a multi-layer security validation pipeline
4. Fetches season stats, 14-day rolling stats, and batting handedness per hitter
5. Fetches probable starter stats, handedness, and ERA/WHIP/K metrics per pitcher
6. Fetches real-time weather forecasts (temperature, wind speed, wind direction) for every outdoor ballpark
7. Constructs a normalized 17-feature vector per hitter-pitcher-park-weather combination
8. Scores each hitter using a weighted linear model with logistic sigmoid output
9. Returns ranked predictions for HR, Hit, Run, RBI, combined Hit+Run+RBI (HRR), and projected Total Bases
10. Persists predictions to disk for past dates so results are locked and reviewable

The UI lets you navigate by date (past and present), switch between prop types, filter by minimum probability, view outcome overlays on past predictions, and inspect the reasoning behind each pick.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 14 — App Router, server-side API routes |
| Language | TypeScript — strict mode, no `any`, all types canonical in `types/index.ts` |
| Styling | Tailwind CSS — dark-mode-first design system |
| Primary data | MLB Stats API (`statsapi.mlb.com/api/v1`) — public, no auth |
| Weather data | Open-Meteo (`api.open-meteo.com`) — free, no API key |
| Caching | File-system JSON (`data/predictions/YYYY-MM-DD.json`) |
| Runtime | Node.js — server-side API routes run in Next.js edge-compatible handlers |

No database. No ORM. No ML framework. No paid APIs. All predictions are computed on demand from public sources using deterministic, documented math.

---

## Architecture Overview

```
Browser → GET /api/predict?date=2026-04-26
                │
                ▼
   app/api/predict/route.ts       ← Orchestration layer
         │         │
         ▼         ▼
  lib/mlbApi.ts   lib/cache.ts    ← Data fetch + past-date lock
         │
   ┌─────┴──────┐
   ▼            ▼
lib/validation  lib/weather.ts   ← Player pool + weather per game
   │
   ▼
scoring/engine.ts
  ├── extractFeatures()           → FeatureVector (17 normalized scalars)
  ├── scoreProbabilities()        → PropProbabilities { hit, run, rbi, hr }
  └── generateExplanations()     → PropExplanation[] (human-readable drivers)
         │
         ▼
   PredictionAPIResponse          ← Serialized JSON, sorted by HR prob
         │
         ▼
   app/page.tsx                  ← Client-side rendering, 4 tabs
   (HRR + xTB computed          ← Derived client-side from existing probs + stats
    from response payload)
```

---

## Data Pipeline (Step-by-Step)

### Step 1 — Schedule Fetch

**File:** `lib/mlbApi.ts → fetchTodaysGames()`

Calls:
```
GET /api/v1/schedule?sportId=1&date=YYYY-MM-DD&hydrate=probablePitcher,team,venue
```

- Parses home/away teams (stable MLB integer IDs), venue, game time
- Collects all probable pitcher IDs, then **batch-fetches all pitcher data in parallel** via `Promise.all` — this avoids a sequential waterfall that would add ~200ms per pitcher
- Each pitcher fetch runs 3 concurrent calls: season stats, 14-day recent stats, and handedness (pitch hand)
- Game time is parsed from the ISO UTC datetime into Eastern time (America/New_York)

### Step 2 — Team and Game Index Maps

The route handler (`app/api/predict/route.ts`) builds two lookup structures from the schedule:

```typescript
const teamGameMap    = new Map<number, number>();     // teamId → gamePk
const teamGameObjMap = new Map<number, MLBGame>();    // teamId → full MLBGame object
```

These enable O(1) lookups later: given any hitter's `team.id`, instantly find their game.

### Step 3 — Hitter Pool Validation

**File:** `lib/validation.ts → validateAndBuildHitterPool()`

For every team in the slate, calls `fetchActiveRoster(teamId)` to get the MLB-verified active 26-man roster. Each roster entry runs through 7 sequential checks (see [Validation Layer](#validation-layer-and-security-patches)).

For each player that passes all checks, fires 3 concurrent fetches:
- `fetchHitterSeasonStats(id, season)` — AVG, OBP, SLG, OPS, ISO, K%, BB%, HR rate, PA count
- `fetchHitterHand(id)` — bat side (L/R/S)
- `fetchHitterRecentStats(id, season, 14)` — 14-day rolling window stats

Defaults to league-average baselines if any stats are unavailable, rather than silently dropping the player.

### Step 4 — Weather Fetch

**File:** `lib/weather.ts → fetchWeather()`

Deduplicates games by `gamePk`, then fetches weather for each unique game in parallel. For each outdoor venue:
- Looks up venue lat/lon from a hardcoded table of all 30 MLB ballparks
- Calls Open-Meteo for hourly forecast data (temp, humidity, wind speed, wind direction)
- Finds the closest hourly slot to the game's scheduled start time
- Classifies wind direction relative to the ballpark as "out to CF", "in from CF", or "crosswind"

Indoor venues (Tropicana Field, Rogers Centre) receive neutral constants and skip the API call entirely.

### Step 5 — Feature Extraction and Scoring

For each validated hitter, `buildPrediction()` in `scoring/engine.ts`:
1. Calls `extractFeatures(hitter, opposingPitcher, parkFactors, weather)` — produces a `FeatureVector`
2. Calls `scoreProbabilities(featureVector)` — produces `PropProbabilities { hit, run, rbi, hr }`
3. Calls `generateExplanations()` — produces up to 4 human-readable key drivers per prop

### Step 6 — Sort, Persist, Respond

Predictions are sorted by HR probability descending and returned as `PredictionAPIResponse`. The full payload is also written to `data/predictions/YYYY-MM-DD.json` so past-date requests return instantly from cache without re-running the pipeline.

---

## Prediction Engine

**File:** `scoring/engine.ts`

### Feature Vector (17 features, all normalized 0–1)

| Feature | Derivation | Fallback if missing |
|---|---|---|
| `hitterContactSkill` | AVG (40%) + OBP (35%) + inverted K% (25%) | 0.40 (league avg) |
| `hitterPowerSkill` | ISO (50%) + SLG (30%) + hard-hit% (20%) | 0.30 |
| `hitterHRRate` | Season HR/PA normalized to 0.07 ceiling | 0.20 |
| `hitterRecentForm` | 14-day AVG (40%) + SLG (40%) + HR count boost (20%) | 0.50 (neutral) |
| `hitterPlatoonEdge` | L vs R or R vs L = 0.72; same hand = 0.28; switch = 0.65 | 0.50 |
| `hitterOBPSkill` | OBP normalized to 0.25–0.45 range | 0.40 |
| `hitterRBIContext` | OPS-proxy (60%) + power skill (40%) | 0.35 |
| `pitcherVulnerabilityHR` | HR/9 (50%) + ERA proxy (25%) + hard-hit allowed (25%) | 0.50 |
| `pitcherVulnerabilityContact` | WHIP (60%) + inverted K/9 (40%) | 0.50 |
| `pitcherVulnerabilityRuns` | ERA (60%) + BB/9 (40%) | 0.50 |
| `parkHRFactor` | HR park factor normalized around 1.0 neutral | — |
| `parkRunsFactor` | Runs park factor normalized | — |
| `weatherHRBoost` | Temperature effect + wind direction/speed + altitude | 0.40 |
| `weatherRunsBoost` | Scaled version of HR boost | 0.40 |
| `platoonAdvantage` | Boolean: hitterPlatoonEdge ≥ 0.65 | — |
| `windFavorable` | Boolean: wind blowing out at ≥ 15 mph | — |
| `parkFavorableHR` | Boolean: hrFactor ≥ 1.15 | — |

Critically: when data is missing (e.g., no pitcher stats confirmed yet, no weather available), the feature defaults to a **neutral mid-range value** rather than zero. This prevents absence of data from artificially suppressing predictions.

### Probability Scoring — The Formula

Each prop uses a weighted linear combination of features passed through a **logistic sigmoid**:

```
P(prop) = clamp(sigmoid((Σ weight_i × feature_i + intercept) × scale), 0.01, 0.95)
```

The intercept and scale are calibrated so realistic baseline probabilities match known MLB single-game averages.

**HR probability weights:**
```
hitterHRRate          × 3.0   ← strongest predictor
pitcherVulnerabilityHR × 1.8
hitterPowerSkill      × 1.5
parkHRFactor          × 1.2
weatherHRBoost        × 1.0
hitterPlatoonEdge     × 0.6
hitterRecentForm      × 0.4
Intercept: -4.5, Scale: 0.75
→ Average MLB hitter = ~5% HR/game (realistic: 30 HR/600 PA ÷ 162 games ≈ 4.9%)
```

**Hit probability weights:**
```
hitterContactSkill         × 2.2
pitcherVulnerabilityContact × 1.0
hitterPlatoonEdge          × 0.9
hitterRecentForm           × 0.8
hitterOBPSkill             × 0.5
parkHRFactor               × 0.3
Intercept: -2.8, Scale: 0.85
→ Average MLB hitter = ~26% hit probability/game
```

**Run probability weights:**
```
hitterOBPSkill             × 2.0   ← must get on base first
hitterContactSkill         × 0.8
pitcherVulnerabilityRuns   × 0.9
parkRunsFactor             × 0.7
hitterRecentForm           × 0.6
weatherRunsBoost           × 0.5
Intercept: -3.2, Scale: 0.80
```

**RBI probability weights:**
```
hitterRBIContext           × 1.8
pitcherVulnerabilityRuns   × 0.9
hitterPowerSkill           × 0.9
hitterPlatoonEdge          × 0.7
hitterRecentForm           × 0.5
parkRunsFactor             × 0.4
Intercept: -3.1, Scale: 0.80
```

### Confidence Tiers

Each prop explanation is assigned ELITE / STRONG / VALUE / LOW based on the output probability:

| Tier | HR | Hit | Run | RBI |
|---|---|---|---|---|
| ELITE | ≥ 12% | ≥ 38% | ≥ 30% | ≥ 28% |
| STRONG | ≥ 8% | ≥ 30% | ≥ 22% | ≥ 20% |
| VALUE | ≥ 5% | ≥ 22% | ≥ 15% | ≥ 13% |
| LOW | < 5% | < 22% | < 15% | < 13% |

### Explanation Generation

For each prop, `generateExplanations()` inspects the feature vector values against thresholds and emits plain-English driver strings. Example: if `pitcherVulnerabilityHR > 0.65`, it generates `"Pitcher allows elevated HR rate (1.42 HR/9)"` using the actual stat value. This makes every prediction fully auditable — the number can always be traced back to a specific data point.

---

## Derived Metrics — HRR and Total Bases

These are computed **client-side** in `app/page.tsx` from the existing `PredictionAPIResponse` payload. No additional API calls.

### HRR — Combined Hit + Run + RBI Score

```
hrrScore = P(hit) + P(run) + P(rbi)
```

Represents the expected number of hit/run/RBI prop outcomes a player contributes in a single game. Useful for DFS-style lineup decisions where all three matter. Typical range: 0.3–1.3.

Players are sorted descending by HRR score and displayed in the Hit+Run+RBI tab with a purple probability bar (normalized to 1.5 = 100%).

### Projected Total Bases (xTB)

Uses the identity: **SLG ÷ AVG = average bases per hit** (since SLG = total bases / AB and AVG = hits / AB, their ratio cancels the at-bat denominator).

```
xTB = P(hit) × (SLG / AVG)
```

This is the expected total bases a player produces in a game — a product of their hit probability and how many bases that hit is worth on average. A player hitting .280/.480 averages 1.71 bases per hit; a player hitting .260/.390 averages 1.50 per hit.

Typical range: 0.25–0.75. Bar is normalized to 0.75 = 100%.

Falls back to league-average ratio (0.42/0.26 ≈ 1.6) when season stats are not yet available.

---

## Game Prediction Engine

**File:** `scoring/gameEngine.ts`

Uses **Pythagorean Win Expectancy** — the standard sabermetric formula used across professional baseball analytics:

```
Win% = RF^1.83 / (RF^1.83 + RA^1.83)
```

Where RF (runs for) and RA (runs against) are estimated from the opposing starter's ERA and WHIP:

```
xRuns_against_pitcher = LEAGUE_RUNS_PER_GAME × (ERA_factor × 0.70 + WHIP_factor × 0.30)
```

- League baseline: 4.5 runs/game, 4.20 ERA
- Home field advantage: 4% run boost to the home team's expected runs
- Park runs factor scales both sides

Spread lean logic:
- Run differential > 0.7 → `-1.5 run line lean`
- Run differential > 0.3 → `moneyline lean`
- Near-even → `Pick'em`

Confidence (HIGH/MEDIUM/LOW) is based on the winning team's win probability (≥ 63% = HIGH, ≥ 57% = MEDIUM).

Games are sorted in the response by confidence tier first, then by most decisive win probability spread.

---

## Validation Layer and Security Patches

**File:** `lib/validation.ts`

The validation layer was audited and patched for 10 distinct vulnerabilities. Every patch is documented in the source code with the old behavior, the bug it introduced, and the fix:

| Patch | Vulnerability | Old Behavior | Fix |
|---|---|---|---|
| VULN-01 | Null status bypass | `entry.status?.code && ...` — `undefined && x` skips the `continue`, admitting inactive players | Explicit `statusCode === null → reject` |
| VULN-02 | Dead-code team check | `if (!todaysTeamIds.has(teamId))` inside `for (teamId of todaysTeamIds)` — always false | Replaced with `queriedTeamId !== outerTeamId` cross-reference |
| VULN-03 | Cache staleness | Default Next.js `fetch()` caching could serve a retired player's roster entry from hours ago | `cache: 'no-store'` on all MLB API fetches |
| VULN-04 | gamePk=0 false VALID | `teamGameMap.get(teamId) ?? 0` — undefined fallback to 0 marked player VALID with no game | Missing `gamePk` is now a hard `NO_GAME_TODAY` rejection |
| VULN-05 | No player-team cross-reference | No check that the player was actually fetched from the expected team | `queriedTeamId` stamped at fetch time, verified against outer loop variable |
| VULN-06 | Name ban case sensitivity | `NON_MLB_SPORT_NAMES.has(name)` — exact match bypassed by `"cade cunningham"`, `"CADE  CUNNINGHAM"` | Names normalized (lowercase, collapsed spaces, trimmed) before Set lookup |
| VULN-07 | Position case sensitivity | Position `"p"` (lowercase) slipped through pitcher filter | Position strings uppercased at source in `mlbApi.ts` before any check |
| VULN-08 | No date parameter validation | Arbitrary strings like `"../etc/passwd"` or `"'; DROP TABLE"` could reach downstream API calls | Regex `^\d{4}-\d{2}-\d{2}$` enforced in route handler before any use |
| VULN-09 | Vacuous deduplication test | `testDeduplication()` called `Set.has()` on a freshly constructed set — always returned `false`, making the "pass" always true | Replaced with real two-encounter simulation using actual `seenIds` pipeline |
| VULN-10 | Stale retired player via cache | Cached roster responses could serve players no longer on active rosters | Resolved by VULN-03 |

Every patch has a corresponding exported regression test function (`testRejectCadeCunningham()`, `testNormalizedNameRejection()`, `testGamePkZeroRejection()`, etc.) callable at runtime via `GET /api/validate`.

### Static Reference Data (`lib/parkFactors.ts`)

| Set | Purpose |
|---|---|
| `VALID_MLB_TEAM_IDS` | All 30 official MLB franchise IDs — rejects fantasy/invalid team IDs |
| `HITTER_POSITIONS` | C, 1B, 2B, 3B, SS, OF, DH, IF, TWP — pitchers silently filtered |
| `KNOWN_NON_MLB_IDS` | Canary IDs from other sports (Cade Cunningham = 9999991, etc.) |
| `NON_MLB_SPORT_NAMES` | ~15 prominent NBA/NFL athletes to catch cross-sport API contamination |

---

## API Routes

### `GET /api/predict?date=YYYY-MM-DD`

Runs the full prediction pipeline. Returns `PredictionAPIResponse`:
- `predictions[]` — ranked `HitterPrediction` objects, sorted by HR probability descending
- `validatedHitters` — count of players that passed all validation checks
- `rejectedHitters` — count of players that failed at least one check
- `rejectionLog[]` — every rejected player with `name` and `reason`
- `sourceHealth` — status of each data source: schedule / rosterData / hitterStats / weather / parkFactors
- `generatedAt` — ISO timestamp of when predictions were generated
- `warnings[]` — non-fatal issues (e.g., "no probable pitcher confirmed for game 12345")

For past dates, serves from file-system cache immediately. For today, always recomputes.

### `GET /api/games?date=YYYY-MM-DD`

Game-level win probability and spread lean predictions. Returns `GamePredictionAPIResponse`:
- `games[]` — each with home/away win probabilities, expected runs, spread lean, confidence, key factors, venue
- Sorted: HIGH confidence first, then by most decisive win probability differential

### `GET /api/results?date=YYYY-MM-DD`

Fetches actual HR outcomes for a past date by querying the MLB boxscore endpoint for every game. Returns the list of MLB player IDs who hit home runs. Used by the frontend to render green/red result overlays on past-day prediction cards.

### `GET /api/schedule?date=YYYY-MM-DD`

Raw schedule data — games, teams, venues, probable pitchers, game times. Useful for debugging data freshness.

### `GET /api/validate`

Runs all regression tests from `lib/validation.ts` and returns pass/fail for each. Confirms the full security patch suite is intact after any code changes.

---

## Frontend

**File:** `app/page.tsx` — single-page `'use client'` component

### Four Tabs

**HR Picks** — the core prop prediction view
- Sortable by any of the 4 props (HR / Hit / Run / RBI) via the prop selector
- Minimum probability filter (adaptive thresholds per prop type)
- Each card displays: player name/team/position/handedness, selected prop probability + confidence tier, probability bar, 4-prop grid (all props shown even when sorting by one), matchup context (pitcher, venue HR factor), season stats (AVG/OBP/SLG/ISO/K%/PA), 14-day recent form, up to 4 key driver bullets
- On past dates: green border + "HR" badge for players who actually homered; red border + "No HR" badge for misses

**Hit+Run+RBI** — combined offensive contribution
- Sorted by `P(hit) + P(run) + P(rbi)` combined score
- 3-column grid showing each individual component probability
- Purple color scheme to visually distinguish from HR picks

**Total Bases** — contact + power combination
- Sorted by `P(hit) × (SLG / AVG)` projected total bases
- Shows Hit%, xB/H (average bases per hit), and HR% in a 3-column grid
- Amber color scheme

**Game Picks** — game-level outcomes
- Side-by-side team view with starting pitcher ERAs
- Dual-color win probability bar (blue = away, red = home)
- Spread lean recommendation with HIGH/MEDIUM/LOW confidence
- Expected runs per side, venue name, key factors

### Performance — Paginated Display

All sections default to displaying **top 20** items. A "Load more (N remaining)" button appends 20 more. The display count resets to 20 whenever the user switches sections or prop types. This keeps initial render fast regardless of how many hitters the pipeline validates.

### Data Health Indicators

Status bar shows colored dots per data source:
- Green = ok, Yellow = stale or partial, Red = error, Gray = unavailable

### Shared UX
- Date navigation: back/forward arrows, date picker, max-locked to today (no future dates)
- Loading skeletons: animated placeholder cards during API calls
- Rejection log: collapsible list of every excluded player with their rejection reason
- Refresh buttons per section for manual cache bypass

---

## Caching Strategy

**File:** `lib/cache.ts`

Past-date predictions are **immutable** — the games already happened, stats won't change. On first computation, the full `PredictionAPIResponse` payload is written to `data/predictions/YYYY-MM-DD.json`. Subsequent requests for that date return the file directly, skipping the entire pipeline.

Today's predictions are always recomputed from live data. No cache check for the current date.

This is intentionally a simple file-system key-value store:
- No TTL — past predictions never expire
- Survives process restarts
- Works with zero external infrastructure
- In a production deployment, this would be replaced with Redis or cloud object storage

---

## Weather Integration

**File:** `lib/weather.ts`

Uses [Open-Meteo](https://open-meteo.com/) — free, no API key, high-accuracy hourly forecasts.

Every MLB venue has a hardcoded coordinate table (lat/lon). Fetches hourly data for temperature (°F), relative humidity, wind speed (mph), and wind direction (degrees). Selects the hour closest to game start time.

Wind direction interpretation relative to standard ballpark orientation:
- **0°–45° / 315°–360°** (out to CF): strong HR and runs boost — ball carries toward the outfield seats
- **135°–225°** (in from CF): HR penalty — wall of air pushing back toward the infield
- **45°–135° / 225°–315°** (crosswind): moderate boost — balls carry into the gaps

Temperature effect: below 60°F = penalty, 60–70°F = neutral, 70–80°F = slight boost, 80°F+ = meaningful boost (ball carries further in heat).

Altitude: Coors Field (~5,280 ft) gets a +0.10 HR weather boost on top of its already-elevated park factor.

---

## Park Factors

**File:** `lib/parkFactors.ts`

Multi-year park factor averages from Baseball Reference / FanGraphs for all 30 MLB venues, keyed by stable MLB Stats API venue ID:

| Factor | Meaning |
|---|---|
| `hrFactor` | 1.0 = neutral. Coors Field ~1.37 (extremely hitter-friendly). Petco ~0.79 (pitcher-friendly). |
| `runsFactor` | Overall run-scoring environment. Affects Run and RBI probabilities. |
| `hitFactor` | Ball-in-play hit frequency. Affects contact-based predictions. |
| `altitude` | Feet above sea level. Used for the altitude bonus in weather calculation. |

Unknown venues (neutral sites, rare scheduling) default to perfectly neutral 1.0 factors.

---

## Key Design Decisions

### Interpretable model over black-box ML

The scoring engine uses a transparent weighted linear model rather than a trained classifier. Every probability is fully traceable: given a player's output probability, you can follow it backward through the feature weights to specific stat inputs. This also means:
- No historical outcome data required — works from day 1 of a season
- Weights can be tuned manually as the season progresses
- The explanations rendered in the UI accurately reflect what actually drove the score

### Client-side derived metrics

The HRR score and xTB metric are computed client-side from the existing `PredictionAPIResponse` payload. The same API response that powers the HR tab also powers the HRR and Total Bases tabs without any additional network requests. This keeps the backend simple and avoids over-fetching.

### Parallel fetching throughout

Every place multiple independent API calls are needed uses `Promise.all`:
- All pitcher stats for the day's games fetched in one round (parallel per pitcher)
- Weather fetched for all unique games simultaneously
- Per hitter: season stats, recent stats, and handedness fetched in 3 concurrent calls

This is the critical optimization for pipeline performance. Without it, a 15-game slate with 300+ hitters would require hundreds of sequential HTTP requests.

### gamePk as the single-game identifier

The MLB Stats API uses `gamePk` (game primary key) as its stable integer game identifier. All game lookups, weather fetches, boxscore calls, and prediction keys are anchored to `gamePk`. This ensures consistency even when team rosters, schedules, or venue details are updated intraday.

### Neutral defaults over zero defaults

When data is unavailable (pitcher not yet announced, weather API unavailable, early-season stats thin), features default to a **league-average neutral value** (0.40–0.50 range) rather than zero. A zero default would make a hitter look terrible simply because their opponent's starter hasn't been named yet. Neutral defaults express genuine uncertainty rather than false pessimism.

---

## Known Limitations and Next Steps

**Statcast metrics not available** — xwOBA, barrel%, hard-hit%, and exit velocity are nullable fields in the type system but always `null` in practice. The MLB Stats API standard endpoints don't expose Statcast data. Adding a Baseball Savant scraper would be the single highest-impact improvement to prediction accuracy.

**Pre-lineup only** — confirmed batting orders are typically posted 3–4 hours before first pitch. All predictions are marked `PRE_LINEUP`. Adding a lineup polling loop (MLB `/api/v1/game/{gamePk}/lineups`) would let the system update `lineupStatus` to `CONFIRMED` and re-weight predictions for order position.

**Pitcher FIP/xFIP not in public MLB API** — the model uses ERA and WHIP as pitcher quality signals. FIP (Fielding Independent Pitching) and xFIP are better predictors of true pitcher skill but require FanGraphs or a Statcast endpoint.

**No trained weights** — feature weights are manually calibrated, not fitted on historical data. The natural next step is: build a feature pipeline over 2023–2025 game logs, export feature vectors + actual outcomes (hit/no hit, HR/no HR), fit a logistic regression or XGBoost model, replace the hardcoded weights with trained coefficients, and evaluate using Brier score / log loss.

**No lineup position** — batting order position significantly affects run and RBI probability. A leadoff hitter scores more runs; a cleanup hitter drives in more. This signal is absent until lineup confirmation is integrated.

---

## Running Locally

```bash
# Install dependencies
npm install

# Start dev server
npm run dev
```

Open `http://localhost:3000`. No environment variables required. All external APIs are public and unauthenticated.

```bash
# Type-check without building
npx tsc --noEmit

# Run validation regression tests at runtime
curl http://localhost:3000/api/validate

# Check predictions for a specific date
curl "http://localhost:3000/api/predict?date=2026-04-25"
```

### Project Structure

```
mlb_prediction/
├── app/
│   ├── api/
│   │   ├── predict/route.ts     ← Full prediction pipeline orchestration
│   │   ├── games/route.ts       ← Game-level win probability + spread leans
│   │   ├── results/route.ts     ← Past-date HR outcome fetcher (boxscores)
│   │   ├── schedule/route.ts    ← Raw schedule data
│   │   └── validate/route.ts    ← Regression test runner
│   ├── page.tsx                 ← Client UI: 4-tab prediction browser
│   ├── layout.tsx
│   └── globals.css
├── lib/
│   ├── mlbApi.ts                ← MLB Stats API client (all HTTP calls)
│   ├── validation.ts            ← 7-check player validation + 10 security patches
│   ├── parkFactors.ts           ← Park factors, valid team IDs, ban lists
│   ├── weather.ts               ← Open-Meteo integration per venue
│   └── cache.ts                 ← File-system prediction cache
├── scoring/
│   ├── engine.ts                ← Feature extraction + prop scoring + explanations
│   └── gameEngine.ts            ← Pythagorean win expectancy + spread lean
├── types/
│   └── index.ts                 ← All TypeScript interfaces (canonical source of truth)
└── data/
    └── predictions/             ← Auto-created; YYYY-MM-DD.json per past date
```
