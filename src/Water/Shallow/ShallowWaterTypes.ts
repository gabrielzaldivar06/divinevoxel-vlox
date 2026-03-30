import type {
  WaterColumnAuthority,
  WaterOwnershipDomain,
} from "../Contracts/WaterSemanticContract.js";

/**
 * ShallowWaterLayer — Fase 1
 *
 * Represents the state of a single (x,z) column within a shallow-water section.
 * This layer is separate from LargeBodyWater and is used for:
 *  - Editor-placed water seeds
 *  - Puddles / runoff / small bodies
 *  - Thin surface films
 *
 * Physics coupling to the large-body system happens in Phase 2.
 * Handoff to dve_liquid voxels happens in Phase 3.
 */
export interface ShallowColumnState {
  /** Whether this column has active shallow water. */
  active: boolean;
  /** Water depth in world units [0, ~1]. 0 = dry. */
  thickness: number;
  /** Solid floor Y (world space) used as the local bed for this column. */
  bedY: number;
  /** Surface Y (world space) of the shallow water top. */
  surfaceY: number;
  /** Horizontal spread velocity, x direction (column units per second). */
  spreadVX: number;
  /** Horizontal spread velocity, z direction (column units per second). */
  spreadVZ: number;
  /** [0,1] how settled/calm the water is. 1 = fully settled pool. */
  settled: number;
  /** [0,1] adhesion to terrain — prevents sliding on horizontal surfaces. */
  adhesion: number;
  /** Time since this column first received water (seconds). */
  age: number;
  /**
   * Source emitter ID — maps to the editor emitter that originated this water.
   * 0 means no specific emitter.
   */
  emitterId: number;
  /** Whether this column is in the handoff zone (thickness >= handoff threshold). */
  handoffPending: boolean;
  /** Which water domain currently owns this column semantically. */
  ownershipDomain: WaterOwnershipDomain;
  /** Confidence of the last ownership resolution applied to this column. */
  ownershipConfidence: number;
  /** Consecutive ticks spent in the current ownership domain. */
  ownershipTicks: number;
  /** Most recent shallow tick that resolved this column's ownership. */
  lastResolvedTick: number;
  /** Best-known authority that introduced or most recently claimed this column. */
  authority: WaterColumnAuthority;
}

/**
 * Full state for a 16×16 grid of shallow-water columns within one section.
 */
export interface ShallowWaterSectionGrid {
  /** Section origin in world voxel X. */
  originX: number;
  /** Section origin in world voxel Z. */
  originZ: number;
  /** Column count in X. */
  sizeX: number;
  /** Column count in Z. */
  sizeZ: number;
  /** Flat array of column states, row-major: index = z * sizeX + x. */
  columns: ShallowColumnState[];
  /** Seconds since last full tick. */
  lastTickDt: number;
  /**
   * World Y fallback used to bootstrap new columns before per-column bed sampling exists.
   * This is no longer the authoritative shallow floor for active columns.
   */
  terrainY: number;
}

/**
 * Configuration constants for the ShallowWaterLayer simulation.
 */
export interface ShallowWaterConfig {
  /** Thickness (world units) at which a column triggers handoff to LargeBodyWater. */
  handoffThickness: number;
  /** How fast thickness decays per second on an isolated column (evaporation). */
  evaporationRate: number;
  /** How fast water spreads to neighboring empty columns per second. */
  spreadRate: number;
  /** Settling rate per second (settled approaches 1 as water calms). */
  settlingRate: number;
  /** Maximum spread velocity (column units per second). */
  maxSpreadVelocity: number;
}

export const DEFAULT_SHALLOW_WATER_CONFIG: ShallowWaterConfig = {
  handoffThickness: 0.75,
  evaporationRate: 0.004,
  spreadRate: 0.6,
  settlingRate: 0.3,
  maxSpreadVelocity: 2.0,
};

/**
 * Per-column external flow hint provided by the large-body water system
 * (or any other source). Used in Phase 2 to bias shallow spread direction
 * and evaporation rate.
 */
export interface ShallowWaterExternalFlowHint {
  /** Preferred flow X direction [-1, 1]. 0 = no preference. */
  flowX: number;
  /** Preferred flow Z direction [-1, 1]. 0 = no preference. */
  flowZ: number;
  /** Extra drainage rate multiplier [0, 2]. 1 = normal. */
  drainageMultiplier: number;
  /** Shore proximity factor [0, 1]. 0 = open water, 1 = at shore. */
  shoreFactor: number;
}

/**
 * Flow hint grid for one section. Aligned to the 16×16 column grid.
 */
export interface ShallowWaterFlowHintGrid {
  originX: number;
  originZ: number;
  /** Flat array, length = sizeX * sizeZ. */
  hints: ShallowWaterExternalFlowHint[];
}

/** Creates a default (inactive) ShallowColumnState. */
export function createEmptyShallowColumn(): ShallowColumnState {
  return {
    active: false,
    thickness: 0,
    bedY: 0,
    surfaceY: 0,
    spreadVX: 0,
    spreadVZ: 0,
    settled: 0,
    adhesion: 0.5,
    age: 0,
    emitterId: 0,
    handoffPending: false,
    ownershipDomain: "none",
    ownershipConfidence: 0,
    ownershipTicks: 0,
    lastResolvedTick: 0,
    authority: "bootstrap",
  };
}
