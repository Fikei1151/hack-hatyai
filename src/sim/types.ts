// Scenario model. Field names are snake_case so they map 1:1 onto the Supabase `phases` table.

export type RainPattern = 'uniform' | 'storm_cells' | 'orographic' | 'squall_line';

export type EventType = 'surge' | 'drain_block' | 'lake_surge';

/** A discrete happening inside a phase (e.g. a canal bank overtopping at a random spot). */
export interface PhaseEvent {
  type: EventType;
  /** hours after the phase starts */
  at_hours: number;
  duration_hours: number;
  /** surge: m³/s released · drain_block: fraction of drainage lost (0–1) · lake_surge: extra metres */
  magnitude: number;
  /** local metres (surge only) */
  x?: number;
  y?: number;
  label?: string;
}

export interface Phase {
  id: string;
  name: string;
  color: string;
  duration_hours: number;
  /** hours over which parameters blend in from the previous phase */
  ramp_hours: number;
  /** domain-average rain intensity */
  rain_mm_hr: number;
  rain_pattern: RainPattern;
  rain_variability: number;
  storm_cells: number;
  /** meteorological convention: direction the wind blows FROM */
  wind_dir_deg: number;
  wind_speed_kmh: number;
  /**
   * Total river inflow entering the domain (Khlong U-Taphao + Khlong Wa + Khlong Wat), reached at
   * the END of the phase; it changes linearly through the phase so phases draw a hydrograph.
   */
  upstream_inflow_m3s: number;
  /** Songkhla Lake level (m MSL) reached at the end of the phase — downstream backwater */
  lake_level_m: number;
  /** urban storm-drain capacity in built-up areas */
  drainage_mm_hr: number;
  infiltration_mm_hr: number;
  events: PhaseEvent[];
  notes: string;
}

export type ScenarioSource = 'custom' | 'preset' | 'random' | 'forecast' | 'historical';

export interface Scenario {
  id?: string;
  slug?: string;
  name: string;
  description: string;
  source: ScenarioSource;
  seed: number;
  /** ISO timestamp of the simulation start (drives the day/night cycle and the clock) */
  start_time: string;
  settings: {
    /** multiplier applied to all rain intensities (bias-correct reanalysis data) */
    rain_bias?: number;
    /** river inflow at t = 0 (phases give the value reached at their END) */
    initial_inflow_m3s?: number;
    initial_lake_m?: number;
    /** id of the observed event this scenario replays (enables the X.44 comparison chart) */
    event_id?: string;
  };
  phases: Phase[];
}

/** Interpolated, ready-to-use forcing at a moment in simulation time. */
export interface Forcing {
  phaseIndex: number;
  phaseT: number; // seconds since the phase started
  rainMmHr: number;
  pattern: RainPattern;
  variability: number;
  stormCells: number;
  windDirDeg: number;
  windSpeedKmh: number;
  inflowM3s: number;
  lakeLevelM: number;
  drainageMmHr: number;
  infiltrationMmHr: number;
  surges: { x: number; y: number; m3s: number; label?: string }[];
}

export interface PoiReading {
  id: string;
  name: string;
  depth: number;
  maxDepth: number;
}

export interface GaugeReading {
  id: string;
  code: string;
  /** simulated water surface, m MSL */
  level: number;
}

export interface LiveStats {
  simTime: number;
  phaseIndex: number;
  rainMmHr: number;
  cumulativeRainMm: number;
  inflowM3s: number;
  floodedKm2: number; // > 10 cm
  deepKm2: number; // > 50 cm
  severeKm2: number; // > 1.5 m
  maxDepth: number;
  volumeM3: number;
  buildingsAffected: number; // > 30 cm at the footprint centroid
  buildingsSevere: number; // > 1.5 m
  pois: PoiReading[];
  gauges: GaugeReading[];
  stepsPerSecond: number;
  dt: number;
  /** share of storm-drain capacity still working (drains back up when the canals are full) */
  drainEfficiency: number;
  /** mean canal fill, 0 = empty … 1 = bank-full */
  canalFill: number;
}

export interface SeriesPoint {
  t: number; // sim seconds
  rain: number; // mm/hr
  cumRain: number;
  area: number; // km² > 10 cm
  deep: number; // km² > 50 cm
  maxDepth: number;
  volume: number;
  inflow: number;
  buildings: number;
  /** simulated water level at RID gauges, keyed by gauge id */
  gauges: Record<string, number>;
}
