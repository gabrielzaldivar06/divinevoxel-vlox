/**
 * ShallowWaterSectionState — Fase 1
 *
 * Manages the simulation state for shallow water across all active sections.
 * Each section is a 16×16 column grid.
 *
 * Simulation model (Phase 1, purely local — no large-body coupling yet):
 *  1. spread:      water flows into adjacent empty columns at spreadRate
 *  2. settling:    spreadVX/VZ decay → water calms into a pool
 *  3. evaporation: isolated thin columns lose thickness over time
 *  4. adhesion:    keeps settled water on flat terrain
 *  5. handoff:     columns with thickness >= handoffThickness are flagged
 */
import {
  type ShallowColumnState,
  type ShallowWaterSectionGrid,
  type ShallowWaterConfig,
  type ShallowWaterExternalFlowHint,
  DEFAULT_SHALLOW_WATER_CONFIG,
  createEmptyShallowColumn,
} from "./ShallowWaterTypes";

// Section size hardcoded to match DVE standard section footprint
const SECTION_SIZE = 16;

/** All active section grids, keyed by "x_z" (section origin in voxel coords). */
const sections = new Map<string, ShallowWaterSectionGrid>();

/** Flow hint grids, keyed by "x_z". */
const flowHintGrids = new Map<string, ShallowWaterExternalFlowHint[]>();

export type ShallowHandoffCallback = (
  worldX: number,
  worldZ: number,
  surfaceY: number,
  thickness: number,
  emitterId: number,
) => boolean;

let _handoffCallback: ShallowHandoffCallback | null = null;

/** Register a callback that will be invoked for each column that needs handoff to dve_liquid. */
export function setShallowWaterHandoffCallback(cb: ShallowHandoffCallback): void {
  _handoffCallback = cb;
}

/** Remove the handoff callback. */
export function clearShallowWaterHandoffCallback(): void {
  _handoffCallback = null;
}

/**
 * Register or update external flow hints for a section.
 * Called by the large-body water coupling or editor tools.
 */
export function setShallowWaterFlowHints(
  originX: number,
  originZ: number,
  hints: ShallowWaterExternalFlowHint[],
): void {
  flowHintGrids.set(sectionKey(originX, originZ), hints);
}

function sectionKey(originX: number, originZ: number) {
  return `${originX}_${originZ}`;
}

function colIdx(x: number, z: number) {
  return z * SECTION_SIZE + x;
}

/**
 * Register or reset a section at the given origin.
 * Call this when the editor places the first water seed in a section,
 * or when a section mesh is updated.
 */
export function getOrCreateShallowSection(
  originX: number,
  originZ: number,
  terrainY = 0,
): ShallowWaterSectionGrid {
  const key = sectionKey(originX, originZ);
  let grid = sections.get(key);
  if (!grid) {
    const columns: ShallowColumnState[] = [];
    for (let i = 0; i < SECTION_SIZE * SECTION_SIZE; i++) {
      columns.push(createEmptyShallowColumn());
    }
    grid = {
      originX,
      originZ,
      sizeX: SECTION_SIZE,
      sizeZ: SECTION_SIZE,
      columns,
      lastTickDt: 0,
      terrainY,
    };
    sections.set(key, grid);
  }
  return grid;
}

/**
 * Remove a section (called when the section voxel mesh is removed).
 */
export function removeShallowSection(originX: number, originZ: number) {
  sections.delete(sectionKey(originX, originZ));
}

/**
 * Place a water seed at a world-voxel position (x, z) with a given thickness.
 * This is what the editor calls instead of directly placing dve_liquid.
 */
export function placeShallowWaterSeed(
  worldX: number,
  worldZ: number,
  surfaceY: number,
  thickness = 0.15,
  emitterId = 0,
  config: ShallowWaterConfig = DEFAULT_SHALLOW_WATER_CONFIG,
) {
  const sectionOriginX = Math.floor(worldX / SECTION_SIZE) * SECTION_SIZE;
  const sectionOriginZ = Math.floor(worldZ / SECTION_SIZE) * SECTION_SIZE;
  const terrainY = surfaceY - thickness;
  const grid = getOrCreateShallowSection(sectionOriginX, sectionOriginZ, terrainY);

  const localX = ((worldX % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;
  const localZ = ((worldZ % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;
  const col = grid.columns[colIdx(localX, localZ)];

  if (!col.active) {
    col.active = true;
    col.surfaceY = surfaceY;
    col.thickness = thickness;
    // Start with a small outward burst so the water spreads visibly
    // (settled=0 keeps it unsettled until spreadVX/VZ decay naturally)
    col.spreadVX = (Math.random() - 0.5) * 0.15;
    col.spreadVZ = (Math.random() - 0.5) * 0.15;
    col.settled = 0;
    col.adhesion = 0.5;
    col.age = 0;
    col.emitterId = emitterId;
    col.handoffPending = false;
  } else {
    col.thickness = Math.min(col.thickness + thickness, config.handoffThickness * 1.2);
    col.surfaceY = grid.terrainY + col.thickness;
    col.settled = Math.max(0, col.settled - 0.15);
    col.emitterId = emitterId > 0 ? emitterId : col.emitterId;
  }
}

/**
 * Advance all shallow-water sections by dt seconds.
 *
 * Returns an array of section keys whose `handoffPending` columns need
 * to be promoted to LargeBodyWater (Phase 3).
 */
export function tickShallowWater(
  dt: number,
  config: ShallowWaterConfig = DEFAULT_SHALLOW_WATER_CONFIG,
): string[] {
  const handoffKeys: string[] = [];
  const clampedDt = Math.min(dt, 0.1); // prevent spiral on tab-out spikes

  for (const [key, grid] of sections) {
    let anyActive = false;
    let anyHandoff = false;

    _tickSectionSpread(grid, clampedDt, config);
    _tickSectionSettle(grid, clampedDt, config);
    _tickSectionEvaporation(grid, clampedDt, config);

    for (let z = 0; z < grid.sizeZ; z++) {
      for (let x = 0; x < grid.sizeX; x++) {
        const col = grid.columns[colIdx(x, z)];
        if (col.active) {
          anyActive = true;
          col.age += clampedDt;
          col.handoffPending = col.thickness >= config.handoffThickness;
          if (col.handoffPending) {
            anyHandoff = true;
            if (_handoffCallback) {
              const didHandoff = _handoffCallback(
                grid.originX + x,
                grid.originZ + z,
                col.surfaceY,
                col.thickness,
                col.emitterId,
              );
              if (didHandoff) {
                col.thickness = config.handoffThickness * 0.9;
                col.surfaceY = grid.terrainY + col.thickness;
                col.handoffPending = false;
              }
            }
          }
        }
      }
    }

    grid.lastTickDt = clampedDt;

    if (!anyActive) {
      sections.delete(key);
      continue;
    }
    if (anyHandoff) handoffKeys.push(key);
  }

  return handoffKeys;
}

/** Returns all currently active section grids. */
export function getActiveShallowSections(): ReadonlyMap<string, ShallowWaterSectionGrid> {
  return sections;
}

/** Returns the section grid at the given origin, or undefined. */
export function getShallowSection(
  originX: number,
  originZ: number,
): ShallowWaterSectionGrid | undefined {
  return sections.get(sectionKey(originX, originZ));
}

/** Flush all shallow water state (e.g. on scene dispose). */
export function clearAllShallowWater() {
  sections.clear();
  flowHintGrids.clear();
}

// ─────────────────────────────────────────────────────────────────
// Internal tick helpers
// ─────────────────────────────────────────────────────────────────

const NEIGHBORS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;

function _tickSectionSpread(
  grid: ShallowWaterSectionGrid,
  dt: number,
  config: ShallowWaterConfig,
) {
  const sz = grid.sizeX; // always 16
  const cols = grid.columns;
  const hints = flowHintGrids.get(sectionKey(grid.originX, grid.originZ));

  // Two-pass: first accumulate deltas, then apply (avoid order dependency)
  const transfer = new Float32Array(sz * sz);

  for (let z = 0; z < sz; z++) {
    for (let x = 0; x < sz; x++) {
      const srcIdx = colIdx(x, z);
      const src = cols[srcIdx];
      if (!src.active || src.thickness < 0.001) continue;

      // Phase 2: apply external flow hint if available
      const hint: ShallowWaterExternalFlowHint | undefined = hints ? hints[colIdx(x, z)] : undefined;
      if (hint) {
        const flowMag = Math.hypot(hint.flowX, hint.flowZ);
        if (flowMag > 0.001) {
          // Directional flow boost in hint direction
          const flowBoost = config.spreadRate * flowMag * dt * (1 - src.adhesion) * 0.5;
          const tnx = x + Math.round(hint.flowX);
          const tnz = z + Math.round(hint.flowZ);
          if (tnx >= 0 && tnx < sz && tnz >= 0 && tnz < sz) {
            const tIdx = colIdx(tnx, tnz);
            const tDst = cols[tIdx];
            const boost = Math.min(flowBoost, src.thickness * 0.5);
            transfer[srcIdx] -= boost;
            transfer[tIdx] += boost;
            if (!tDst.active) {
              tDst.active = true;
              tDst.surfaceY = grid.terrainY;
              tDst.emitterId = src.emitterId;
              tDst.adhesion = src.adhesion;
            }
          }
          src.spreadVX += hint.flowX * flowMag * 0.3;
          src.spreadVZ += hint.flowZ * flowMag * 0.3;
        }
        // Apply shore adhesion lerp
        const lerpT = Math.min(1, 0.05 * dt * 20);
        src.adhesion += (hint.shoreFactor * 0.9 - src.adhesion) * lerpT;
      }

      // Flow toward lower neighbors (gravity-driven spread).
      // heightDiff = src water surface - dst water surface (or terrain floor if dry).
      // src.surfaceY and dst.surfaceY are both water-surface Y (terrainY + thickness).
      // WaterBall tension-free pressure: when cell is over-compressed (thick > rest),
      // it gets an extra push. max(0,...) means no suction when thin → organic spreading.
      const SHALLOW_TAIT_REST = 0.04; // ~4cm rest film thickness
      const taitBoost = Math.max(0, 0.55 * (Math.pow(src.thickness / SHALLOW_TAIT_REST, 3) - 1));
      const effectiveSpreadRate = config.spreadRate * (1 + taitBoost);
      let totalOut = 0;
      for (const [dx, dz] of NEIGHBORS) {
        const nx = x + dx;
        const nz = z + dz;
        if (nx < 0 || nx >= sz || nz < 0 || nz >= sz) continue;
        const dst = cols[colIdx(nx, nz)];
        const dstLevel = dst.active ? dst.surfaceY : grid.terrainY;
        const heightDiff = src.surfaceY - dstLevel;
        if (heightDiff > 0.005) {
          const flowAmount = effectiveSpreadRate * heightDiff * dt * (1 - src.adhesion);
          totalOut += flowAmount;
        }
      }

      if (totalOut <= 0) continue;
      const scale = totalOut > src.thickness ? src.thickness / totalOut : 1;

      // Accumulate net flow direction for visual velocity (reset each frame in settle).
      let netVX = 0;
      let netVZ = 0;

      for (const [dx, dz] of NEIGHBORS) {
        const nx = x + dx;
        const nz = z + dz;
        if (nx < 0 || nx >= sz || nz < 0 || nz >= sz) continue;
        const dst = cols[colIdx(nx, nz)];
        const dstLevel = dst.active ? dst.surfaceY : grid.terrainY;
        const heightDiff = src.surfaceY - dstLevel;
        if (heightDiff > 0.005) {
          const flowAmount = effectiveSpreadRate * heightDiff * dt * (1 - src.adhesion) * scale;
          transfer[srcIdx] -= flowAmount;
          transfer[colIdx(nx, nz)] += flowAmount;
          netVX += dx * flowAmount;
          netVZ += dz * flowAmount;

          // Activate neighbor if it receives water
          if (!dst.active) {
            dst.active = true;
            dst.surfaceY = grid.terrainY;
            dst.emitterId = src.emitterId;
            dst.adhesion = src.adhesion;
            dst.settled = 0;
          }
        }
      }

      // Blend net flow direction into spread velocity (clamped, replaces accumulation).
      if (netVX !== 0 || netVZ !== 0) {
        const blendRate = 4.0 * dt;
        src.spreadVX += (netVX - src.spreadVX) * blendRate;
        src.spreadVZ += (netVZ - src.spreadVZ) * blendRate;
        const spd = Math.hypot(src.spreadVX, src.spreadVZ);
        if (spd > config.maxSpreadVelocity) {
          const inv = config.maxSpreadVelocity / spd;
          src.spreadVX *= inv;
          src.spreadVZ *= inv;
        }
      }
    }
  }

  // Apply transfers
  for (let i = 0; i < sz * sz; i++) {
    if (transfer[i] === 0) continue;
    const col = cols[i];
    col.thickness = Math.max(0, col.thickness + transfer[i]);
    if (col.active) {
      col.surfaceY = grid.terrainY + col.thickness;
    }
    if (col.active && col.thickness < 0.0001) {
      col.active = false;
    }
  }
}

function _tickSectionSettle(
  grid: ShallowWaterSectionGrid,
  dt: number,
  config: ShallowWaterConfig,
) {
  for (const col of grid.columns) {
    if (!col.active) continue;
    // Spread velocity decays toward zero as water settles
    const decay = Math.exp(-config.settlingRate * dt);
    col.spreadVX *= decay;
    col.spreadVZ *= decay;
    // settled increases when velocity is low
    const velocity = Math.hypot(col.spreadVX, col.spreadVZ);
    const settledTarget = velocity < 0.05 ? 1 : 0;
    col.settled += (settledTarget - col.settled) * config.settlingRate * dt;
    col.settled = Math.max(0, Math.min(1, col.settled));
  }
}

function _tickSectionEvaporation(
  grid: ShallowWaterSectionGrid,
  dt: number,
  config: ShallowWaterConfig,
) {
  const hints = flowHintGrids.get(sectionKey(grid.originX, grid.originZ));
  for (let z = 0; z < grid.sizeZ; z++) {
    for (let x = 0; x < grid.sizeX; x++) {
      const col = grid.columns[colIdx(x, z)];
      if (!col.active) continue;
      const hint: ShallowWaterExternalFlowHint | undefined = hints ? hints[colIdx(x, z)] : undefined;
      const effectiveEvapRate = hint
        ? config.evaporationRate * hint.drainageMultiplier
        : config.evaporationRate;
      // Only evaporate thin, settled columns (pooled water evaporates slower)
      const thinnessFactor = Math.max(0, 1 - col.thickness / 0.15);
      col.thickness -= effectiveEvapRate * thinnessFactor * col.settled * dt;
      if (col.thickness <= 0) {
        col.active = false;
        col.thickness = 0;
      }
    }
  }
}
