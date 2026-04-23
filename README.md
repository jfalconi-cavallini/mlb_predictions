# MLB Daily Predictor

Real-data MLB hitter prediction app. Every player shown is validated against today's MLB slate.

## Architecture

```
mlb-predictor/
├── app/
│   ├── api/
│   │   ├── predict/route.ts    ← Main orchestration endpoint
│   │   ├── schedule/route.ts   ← Today's schedule
│   │   └── validate/route.ts   ← Validation report + regression tests
│   ├── page.tsx                ← Client UI
│   ├── layout.tsx
│   └── globals.css
├── lib/
│   ├── mlbApi.ts               ← MLB Stats API client (stats.mlb.com)
│   ├── validation.ts           ← Hard player validation layer
│   └── parkFactors.ts          ← Park HR factors + canary IDs
├── scoring/
│   └── engine.ts               ← Feature extraction + probabilistic model
├── types/
│   └── index.ts                ← Canonical TypeScript types
└── tests/
    └── validation.test.js      ← Validation test suite (23 tests)
```

## Data Sources

| Source | What | Auth |
|--------|------|------|
| stats.mlb.com (MLB Stats API) | Schedule, rosters, player IDs, stats | None (public) |
| Local hardcoded | Park HR factors (3yr Statcast base) | N/A |
| Statcast / Baseball Savant | xwOBA, barrel%, EV | **Not yet wired** — see Known Limitations |
| Weather API (NWS/OpenWeather) | Wind, temp for each ballpark | **Stubbed** |

## Prediction Model

Feature-based logistic scoring — interpretable and traceable:

1. **Feature extraction** from hitter stats, pitcher stats, park, weather
2. **Weighted linear combination** per prop (HR, Hit, Run, RBI)
3. **Sigmoid transform** → calibrated probability (0–1)
4. **Explanation generation** from actual feature values

See `scoring/engine.ts` for all weights and their documentation.

### Model calibration targets
- Average MLB hitter (1 game): Hit ~0.27, Run ~0.18, RBI ~0.14, HR ~0.04–0.05
- Elite spot (power hitter, bad pitcher, hot park, wind out): HR ~0.12–0.15

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Copy env
cp .env.example .env.local

# 3. Run validation tests (no deps, pure Node)
node tests/validation.test.js

# 4. Start dev server
npm run dev
```

Open http://localhost:3000

## Validation Layer

The validation layer (`lib/validation.ts`) enforces these checks in order:

1. **Has valid MLB player ID** (positive integer from MLB Stats API)
2. **Not a known cross-sport ID** (canary set of non-MLB sport player IDs)
3. **Not a known cross-sport name** (e.g. Cade Cunningham, Victor Wembanyama)
4. **Position is a hitter position** (C, 1B, 2B, 3B, SS, OF, DH, TWP — not P/SP/RP)
5. **Team is playing today** (team ID in today's validated schedule set)
6. **Team ID is a valid MLB franchise** (hardcoded set of 30 MLB team IDs)
7. **Not a duplicate** (deduplication by MLB player ID across all teams)

**A player failing any check is permanently excluded from predictions.**

The rejection log is available in the UI and via `/api/validate`.

## API Endpoints

```
GET /api/predict?date=YYYY-MM-DD   → Full predictions + rejection log
GET /api/schedule?date=YYYY-MM-DD  → Today's games only
GET /api/validate?date=YYYY-MM-DD  → Validation report + regression test results
```

## Running Tests

```bash
node tests/validation.test.js
```

23 tests covering:
- Cade Cunningham rejection (regression test — must always pass)
- Cross-sport contamination by ID and by name
- MLB player ID validation (null, 0, negative, float)
- Position filtering (hitter vs pitcher vs basketball/football)
- Team validation (today's slate, valid franchise IDs, 30 teams)
- Deduplication by player ID
- Empty schedule handling

## Known Limitations

1. **Weather: stubbed** — real NWS API integration would improve HR probability significantly. Add your API key in `.env.local` as `WEATHER_API_KEY`.

2. **Statcast data not wired** — xwOBA, barrel%, hard-hit%, exit velo are null in all predictions. The model falls back to AVG/OBP/SLG/ISO. Add a Statcast scraper or FanGraphs API for these fields.

3. **Pitcher FIP/xFIP not available** from the public MLB Stats API. Would need FanGraphs or Baseball Reference API for better pitcher vulnerability scoring.

4. **Pre-lineup only** — confirmed batting orders are typically posted 3–4 hours before first pitch. The app correctly marks all predictions as `PRE_LINEUP`. Add a lineup polling endpoint to update `lineupStatus` to `CONFIRMED`.

5. **No historical training data** — the model uses manually calibrated weights, not trained weights. To train: build a feature pipeline over 2023–2025 game logs, export feature vectors + actual outcomes, train XGBoost or logistic regression, export weights.

6. **Pitcher handedness sometimes defaults to R** when the MLB Stats API doesn't return it on the schedule endpoint. The full handedness fetch runs but some pitchers may not have data yet early in the season.

## Next Steps for Better Accuracy

1. Wire Statcast data (barrel%, EV) from baseballsavant.mlb.com
2. Wire NWS weather API for all venues
3. Build outcome logging (yesterday's predictions → actual results)
4. Train logistic regression on 2023–2025 feature + outcome pairs
5. Compute Brier score and log loss per prop type weekly
6. Add lineup confirmation polling (update PRE_LINEUP → CONFIRMED)
7. Add FanGraphs API for FIP/xFIP on pitchers

## .env.example

See `.env.example` for all environment variables.
