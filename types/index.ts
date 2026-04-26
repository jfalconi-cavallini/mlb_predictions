// ─── CANONICAL TYPE DEFINITIONS ─────────────────────────────────────────────
// Every entity flowing through the system must conform to these interfaces.
// No type coercion is permitted at validation boundaries.

export type Hand = 'L' | 'R' | 'S'; // S = switch
export type ValidationStatus = 'VALID' | 'REJECTED' | 'PENDING';
export type RejectionReason =
  | 'NO_MLB_ID'
  | 'NOT_IN_TODAYS_SLATE'
  | 'WRONG_SPORT'
  | 'NOT_A_HITTER'
  | 'INACTIVE_ROSTER'
  | 'DUPLICATE_ID'
  | 'SCHEMA_VIOLATION'
  | 'NO_GAME_TODAY';

export type ConfidenceTier = 'ELITE' | 'STRONG' | 'VALUE' | 'LOW';

export type PropType = 'hit' | 'run' | 'rbi' | 'hr';

export type LineupStatus = 'CONFIRMED' | 'PROBABLE' | 'PRE_LINEUP';

// ─── MLB SCHEDULE / GAME ─────────────────────────────────────────────────────

export interface MLBTeam {
  id: number;           // Official MLB team ID (stable, from MLB Stats API)
  name: string;
  abbreviation: string;
  franchiseName: string;
}

export interface MLBGame {
  gamePk: number;       // Official MLB game primary key
  gameDate: string;     // ISO 8601 date
  status: string;       // e.g. "Scheduled", "In Progress", "Final"
  homeTeam: MLBTeam;
  awayTeam: MLBTeam;
  venue: {
    id: number;
    name: string;
    city: string;
    state: string;
  };
  gameTime: string;     // Local game time HH:MM
  gameDateTime: string; // ISO 8601 UTC datetime (from MLB Stats API)
  probableHomePitcher: MLBPitcher | null;
  probableAwayPitcher: MLBPitcher | null;
}

export interface MLBPitcher {
  id: number;           // MLB player ID
  fullName: string;
  throwHand: Hand;
  seasonStats: PitcherSeasonStats | null;
  recentStats: PitcherRecentStats | null;
}

export interface PitcherSeasonStats {
  era: number;
  fip: number | null;
  xfip: number | null;
  whip: number;
  hrPer9: number;
  kPer9: number;
  bbPer9: number;
  hrFbRate: number | null;
  hardHitPctAllowed: number | null;
  barrelPctAllowed: number | null;
  innings: number;
}

export interface PitcherRecentStats {
  windowDays: number;   // e.g. 14 or 30
  era: number;
  hrPer9: number;
  whip: number;
  innings: number;
}

// ─── HITTER ──────────────────────────────────────────────────────────────────

export interface MLBHitter {
  id: number;           // MLB player ID — the only stable identifier
  fullName: string;
  team: MLBTeam;
  batHand: Hand;
  primaryPosition: string; // e.g. "OF", "1B", "C", "DH"
  isHitter: boolean;    // Set by validation layer, not assumed
  seasonStats: HitterSeasonStats | null;
  recentStats: HitterRecentStats | null;
  validationMeta: ValidationMeta;
}

export interface HitterSeasonStats {
  avg: number;
  obp: number;
  slg: number;
  ops: number;
  iso: number;
  woba: number | null;
  xwoba: number | null;
  barrelPct: number | null;
  hardHitPct: number | null;
  avgExitVelo: number | null;
  kPct: number;
  bbPct: number;
  hrRate: number;       // HR per PA
  paCount: number;
}

export interface HitterRecentStats {
  windowDays: number;
  avg: number;
  obp: number;
  slg: number;
  hrCount: number;
  paCount: number;
  hardHitPct: number | null;
  avgExitVelo: number | null;
}

export interface HitterSplits {
  vsLHP: SplitLine | null;
  vsRHP: SplitLine | null;
}

export interface SplitLine {
  avg: number;
  obp: number;
  slg: number;
  ops: number;
  hrRate: number;
  paCount: number;
}

// ─── VALIDATION ──────────────────────────────────────────────────────────────

export interface ValidationMeta {
  status: ValidationStatus;
  rejectionReason: RejectionReason | null;
  mlbPlayerId: number | null;
  validatedTeamId: number | null;
  validatedGamePk: number | null;
  lineupStatus: LineupStatus;
  validatedAt: string;  // ISO timestamp
  sourceChecks: {
    hasMLBId: boolean;
    isMLBRoster: boolean;
    teamPlayingToday: boolean;
    positionIsHitter: boolean;
    notDuplicated: boolean;
    notOtherSport: boolean;
  };
}

// ─── PARK + WEATHER ──────────────────────────────────────────────────────────

export interface ParkFactors {
  venueId: number;
  venueName: string;
  hrFactor: number;       // 1.0 = neutral. >1.0 = hitter-friendly for HR
  runsFactor: number;
  hitFactor: number;
  altitude: number;       // feet
}

export interface WeatherConditions {
  gamePk: number;
  tempF: number;
  windSpeedMph: number;
  windDirectionDeg: number;    // 0=N, 90=E, 180=S, 270=W
  windDirectionLabel: string;  // "out to CF", "in from CF", etc.
  humidity: number;
  isIndoor: boolean;
  dataSource: 'live' | 'forecast' | 'unavailable';
  fetchedAt: string;
}

// ─── SCORING / PREDICTIONS ───────────────────────────────────────────────────

export interface FeatureVector {
  // Hitter skill features (normalized 0–1)
  hitterContactSkill: number;    // based on AVG/OBP/K%
  hitterPowerSkill: number;      // based on ISO/barrel%/hardHit%/SLG
  hitterHRRate: number;          // season HR/PA
  hitterRecentForm: number;      // weighted recent stats
  hitterPlatoonEdge: number;     // based on handedness split
  hitterOBPSkill: number;        // OBP-based
  hitterRBIContext: number;      // ops + lineup position proxy

  // Pitcher matchup features (normalized 0–1, higher = worse for pitcher)
  pitcherVulnerabilityHR: number;    // hrPer9 + hrFbRate + hardHitAllowed
  pitcherVulnerabilityContact: number; // whip + avg allowed
  pitcherVulnerabilityRuns: number;  // era + fip

  // Context features
  parkHRFactor: number;
  parkRunsFactor: number;
  weatherHRBoost: number;       // temp + wind out + altitude
  weatherRunsBoost: number;

  // Metadata (not used in score, for explanation)
  platoonAdvantage: boolean;
  windFavorable: boolean;
  parkFavorableHR: boolean;
}

export interface PropProbabilities {
  hit: number;    // 0–1
  run: number;    // 0–1
  rbi: number;    // 0–1
  hr: number;     // 0–1
}

export interface PropExplanation {
  prop: PropType;
  probability: number;
  confidence: ConfidenceTier;
  keyDrivers: string[];   // max 4 human-readable reasons, from actual feature values
  featureContributions: Record<string, number>; // feature name → contribution to score
}

export interface HitterPrediction {
  hitter: MLBHitter;
  game: MLBGame;
  opposingPitcher: MLBPitcher | null;
  parkFactors: ParkFactors;
  weather: WeatherConditions | null;
  features: FeatureVector;
  probabilities: PropProbabilities;
  explanations: PropExplanation[];
  lineupStatus: LineupStatus;
  generatedAt: string;
}

// ─── API RESPONSE SHAPES ─────────────────────────────────────────────────────

export interface ScheduleAPIResponse {
  date: string;
  games: MLBGame[];
  totalGames: number;
  fetchedAt: string;
  sourceHealth: 'ok' | 'partial' | 'error';
  warnings: string[];
}

export interface PredictionAPIResponse {
  date: string;
  validatedHitters: number;
  rejectedHitters: number;
  predictions: HitterPrediction[];
  rejectionLog: Array<{ name: string; reason: RejectionReason }>;
  sourceHealth: DataSourceHealth;
  generatedAt: string;
  warnings: string[];
}

export interface DataSourceHealth {
  schedule: 'ok' | 'error' | 'stale';
  rosterData: 'ok' | 'error' | 'stale';
  pitcherStats: 'ok' | 'error' | 'stale';
  hitterStats: 'ok' | 'error' | 'stale';
  weather: 'ok' | 'error' | 'unavailable';
  parkFactors: 'ok' | 'error';
  lastUpdated: Record<string, string>;
}

// ─── GAME PREDICTIONS ────────────────────────────────────────────────────────

export interface GamePrediction {
  gamePk: number;
  homeTeam: MLBTeam;
  awayTeam: MLBTeam;
  homeStartingPitcher: MLBPitcher | null;
  awayStartingPitcher: MLBPitcher | null;
  homeWinProbability: number;
  awayWinProbability: number;
  homeExpectedRuns: number;
  awayExpectedRuns: number;
  spreadLean: string;
  spreadLeanSide: 'home' | 'away' | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  venue: MLBGame['venue'];
  parkFactors: ParkFactors;
  gameTime: string;
  gameDate: string;
  keyFactors: string[];
}

export interface GamePredictionAPIResponse {
  date: string;
  games: GamePrediction[];
  generatedAt: string;
  warnings: string[];
}

export interface PlayerGameResult {
  hits: number;
  atBats: number;
  runs: number;
  rbi: number;
  homeRuns: number;
  totalBases: number;
}

export interface GameResultsAPIResponse {
  date: string;
  hrHitterIds: number[];
  playerStats: Record<string, PlayerGameResult>;
  gamesChecked: number;
}

// ─── VALIDATION RESULT ───────────────────────────────────────────────────────

export interface ValidationResult {
  accepted: MLBHitter[];
  rejected: Array<{
    rawName: string;
    rawId: number | null;
    reason: RejectionReason;
    detail: string;
  }>;
  todaysTeamIds: Set<number>;
  validatedAt: string;
}
