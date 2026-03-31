import type { ContinuousWaterSection } from "../Continuous/ContinuousWaterTypes.js";
import type { ShallowWaterSectionGrid } from "../Shallow/ShallowWaterTypes.js";
import type { WaterRuntimePhaseAccounting } from "./WaterRuntimeOrchestrator.js";

// ---------------------------------------------------------------------------
// Deps — injected by the renderer
// ---------------------------------------------------------------------------

export interface WaterTerrainEditDeps {
  getContinuousSection: (
    originX: number,
    originZ: number,
  ) => ContinuousWaterSection | undefined;
  getShallowSection: (
    originX: number,
    originZ: number,
  ) => ShallowWaterSectionGrid | undefined;
  getRuntimeSectionOrigin: (world: number) => number;
  getRuntimeLocalCoord: (world: number) => number;
}

// ---------------------------------------------------------------------------
// Terrain carve — solid block removed (dig)
// ---------------------------------------------------------------------------

/**
 * A solid voxel at (worldX, worldY, worldZ) was removed.
 *
 * If the removal lowers the terrain surface below a water column's bedY:
 *  - bedY drops to the new terrain surface (worldY)
 *  - mass is conserved — depth stays the same, surfaceY adjusts downward
 *  - turbulence is injected at the affected column
 *
 * Mass conservation: the volume opens up but no water is created or destroyed.
 * The water physically "falls" into the new gap; the continuous solver will
 * redistribute on the next tick.
 */
export function processTerrainCarve(
  worldX: number,
  worldY: number,
  worldZ: number,
  deps: WaterTerrainEditDeps,
): WaterRuntimePhaseAccounting {
  const originX = deps.getRuntimeSectionOrigin(worldX);
  const originZ = deps.getRuntimeSectionOrigin(worldZ);
  const localX = deps.getRuntimeLocalCoord(worldX);
  const localZ = deps.getRuntimeLocalCoord(worldZ);

  // --- Continuous domain ---
  const contSection = deps.getContinuousSection(originX, originZ);
  if (contSection) {
    const colIdx = localZ * contSection.sizeX + localX;
    const col = contSection.columns[colIdx];
    if (col?.active && worldY < col.bedY) {
      // Floor dropped — mass stays, surfaceY drops
      col.bedY = worldY;
      col.surfaceY = col.bedY + col.depth;
      col.turbulence = Math.min(1, col.turbulence + 0.3);
    }
  }

  // --- Shallow domain ---
  const shallowSection = deps.getShallowSection(originX, originZ);
  if (shallowSection) {
    const colIdx = localZ * shallowSection.sizeX + localX;
    const col = shallowSection.columns[colIdx];
    if (col?.active && worldY < col.bedY) {
      col.bedY = worldY;
      col.surfaceY = col.bedY + col.thickness;
    }
  }

  // No mass created or destroyed — carving only changes geometry
  return {};
}

// ---------------------------------------------------------------------------
// Terrain fill — solid block placed (block / fill)
// ---------------------------------------------------------------------------

/**
 * A solid voxel was placed at (worldX, worldY, worldZ).
 * The new terrain surface at this column is worldY + 1 (block top).
 *
 * If the new bed exceeds the current bedY:
 *  - If it exceeds surfaceY the column is fully displaced (mass is explicit sink)
 *  - Otherwise bedY rises, depth shrinks, displaced mass is explicit sink
 *
 * Allowed by the plan: "terrain carve or fill that displaces water"
 * is a legitimate mass conservation exception.
 */
export function processTerrainFill(
  worldX: number,
  worldY: number,
  worldZ: number,
  deps: WaterTerrainEditDeps,
): WaterRuntimePhaseAccounting {
  const newBedY = worldY + 1; // top of placed block
  const originX = deps.getRuntimeSectionOrigin(worldX);
  const originZ = deps.getRuntimeSectionOrigin(worldZ);
  const localX = deps.getRuntimeLocalCoord(worldX);
  const localZ = deps.getRuntimeLocalCoord(worldZ);

  let sinkDelta = 0;

  // --- Continuous domain ---
  const contSection = deps.getContinuousSection(originX, originZ);
  if (contSection) {
    const colIdx = localZ * contSection.sizeX + localX;
    const col = contSection.columns[colIdx];
    if (col?.active && newBedY > col.bedY) {
      const oldMass = col.mass;

      if (newBedY >= col.surfaceY) {
        // Fully displaced — deactivate
        sinkDelta += col.mass;
        col.mass = 0;
        col.depth = 0;
        col.bedY = newBedY;
        col.surfaceY = newBedY;
        col.active = false;
        col.pressure = 0;
        col.velocityX = 0;
        col.velocityZ = 0;
        col.turbulence = 0;
      } else {
        // Partially displaced — shrink depth
        col.bedY = newBedY;
        col.depth = col.surfaceY - col.bedY;
        col.mass = col.depth;
        sinkDelta += oldMass - col.mass;
        col.turbulence = Math.min(1, col.turbulence + 0.2);
      }
    }
  }

  // --- Shallow domain ---
  const shallowSection = deps.getShallowSection(originX, originZ);
  if (shallowSection) {
    const colIdx = localZ * shallowSection.sizeX + localX;
    const col = shallowSection.columns[colIdx];
    if (col?.active && newBedY > col.bedY) {
      const oldThickness = col.thickness;

      if (newBedY >= col.surfaceY) {
        // Fully displaced
        sinkDelta += col.thickness;
        col.thickness = 0;
        col.bedY = newBedY;
        col.surfaceY = newBedY;
        col.active = false;
      } else {
        // Partially displaced
        col.bedY = newBedY;
        col.thickness = col.surfaceY - col.bedY;
        sinkDelta += oldThickness - col.thickness;
      }
    }
  }

  return { sinkDelta };
}
