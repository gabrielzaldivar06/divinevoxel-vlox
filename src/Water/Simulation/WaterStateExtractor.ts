import {
  WaterColumnSample,
  WaterSectionGrid,
  WaterSurfaceClass,
} from "../Types/WaterTypes";
import { DataCursorInterface } from "../../Voxels/Cursor/DataCursor.interface";
import { WorldSpaces } from "../../World/WorldSpaces";
import { SectionCursor } from "../../World/Cursor/SectionCursor";

const WATER_HEIGHT = 6 / 7;
const FLOW_SURFACE_EPSILON = 0.01;
const FLOW_LEVEL_WEIGHT = 1 / 7;
const FLOW_SOURCE_BIAS = 0.18;
const FLOW_STRENGTH_SCALE = 1.4;
const SEA_OPEN_NEIGHBOR_THRESHOLD = 20;
const RIVER_FLOW_THRESHOLD = 0.3;
const WATER_PADDED_RADIUS = 2;
const CARDINAL_FLOW_NEIGHBORS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export type WaterExtractionOptions = {
  minSurfaceY?: number;
  maxSurfaceY?: number;
};

/**
 * Empty column sentinel — reused for non-filled slots.
 */
const EMPTY_COLUMN: Readonly<WaterColumnSample> = {
  filled: false,
  surfaceY: 0,
  fill: 0,
  level: 0,
  levelState: 0,
  localY: 0,
  voxelId: 0,
  shoreDistance: -1,
  flowX: 0,
  flowZ: 0,
  flowStrength: 0,
  waterClass: "lake",
};

/**
 * Reusable grid object to avoid allocation per section.
 */
const _grid: WaterSectionGrid = {
  originX: 0,
  originY: 0,
  originZ: 0,
  boundsX: 0,
  boundsY: 0,
  boundsZ: 0,
  columns: [],
  paddedColumns: [],
  paddedRadius: WATER_PADDED_RADIUS,
  paddedBoundsX: 0,
  paddedBoundsZ: 0,
  filledCount: 0,
};

const _columns: WaterColumnSample[] = [];
const _paddedColumns: WaterColumnSample[] = [];

function createColumnSample(): WaterColumnSample {
  return {
    filled: false,
    surfaceY: 0,
    fill: 0,
    level: 0,
    levelState: 0,
    localY: 0,
    voxelId: 0,
    shoreDistance: -1,
    flowX: 0,
    flowZ: 0,
    flowStrength: 0,
    waterClass: "lake",
  };
}

function ensureColumnsCapacity(count: number) {
  while (_columns.length < count) {
    _columns.push(createColumnSample());
  }
}

function ensurePaddedColumnsCapacity(count: number) {
  while (_paddedColumns.length < count) {
    _paddedColumns.push(createColumnSample());
  }
}

/**
 * Resets a column to the empty state.
 */
function resetColumn(col: WaterColumnSample) {
  col.filled = false;
  col.surfaceY = 0;
  col.fill = 0;
  col.level = 0;
  col.levelState = 0;
  col.localY = 0;
  col.voxelId = 0;
  col.shoreDistance = -1;
  col.flowX = 0;
  col.flowZ = 0;
  col.flowStrength = 0;
  col.waterClass = "lake";
}

function copyColumnSample(target: WaterColumnSample, source: WaterColumnSample) {
  target.filled = source.filled;
  target.surfaceY = source.surfaceY;
  target.fill = source.fill;
  target.level = source.level;
  target.levelState = source.levelState;
  target.localY = source.localY;
  target.voxelId = source.voxelId;
  target.shoreDistance = source.shoreDistance;
  target.flowX = source.flowX;
  target.flowZ = source.flowZ;
  target.flowStrength = source.flowStrength;
  target.waterClass = source.waterClass;
}

function getPaddedColumn(
  grid: WaterSectionGrid,
  lx: number,
  lz: number,
): WaterColumnSample | undefined {
  const radius = grid.paddedRadius;
  if (
    lx < -radius ||
    lx > grid.boundsX + radius - 1 ||
    lz < -radius ||
    lz > grid.boundsZ + radius - 1
  ) {
    return undefined;
  }
  return grid.paddedColumns[(lx + radius) * grid.paddedBoundsZ + (lz + radius)];
}

function getWaterClass(
  flowStrength: number,
  openNeighborCount: number,
): WaterSurfaceClass {
  if (flowStrength >= RIVER_FLOW_THRESHOLD) return "river";
  if (openNeighborCount >= SEA_OPEN_NEIGHBOR_THRESHOLD) return "sea";
  return "lake";
}

function countOpenWaterNeighbors(
  grid: WaterSectionGrid,
  lx: number,
  lz: number,
  radius: number,
) {
  let count = 0;
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (dx === 0 && dz === 0) continue;
      const neighbor = getPaddedColumn(grid, lx + dx, lz + dz);
      if (neighbor?.filled) count++;
    }
  }
  return count;
}

function computeFlowMetadata(grid: WaterSectionGrid) {
  const bx = grid.boundsX;
  const bz = grid.boundsZ;

  for (let lx = 0; lx < bx; lx++) {
    for (let lz = 0; lz < bz; lz++) {
      const column = grid.columns[lx * bz + lz];
      if (!column.filled) continue;

      let flowX = 0;
      let flowZ = 0;
      let influenceSum = 0;

      for (const [dx, dz] of CARDINAL_FLOW_NEIGHBORS) {
        const neighbor = getPaddedColumn(grid, lx + dx, lz + dz);
        if (!neighbor?.filled) continue;

        const surfaceDrop = column.surfaceY - neighbor.surfaceY;
        const levelDrop = Math.max(0, column.level - neighbor.level);
        let influence = 0;

        if (surfaceDrop > FLOW_SURFACE_EPSILON) {
          influence += surfaceDrop;
        }

        if (levelDrop > 0) {
          influence += levelDrop * FLOW_LEVEL_WEIGHT;
        }

        if (
          column.levelState === 1 &&
          neighbor.levelState !== 1 &&
          surfaceDrop >= -FLOW_SURFACE_EPSILON
        ) {
          influence += FLOW_SOURCE_BIAS;
        }

        if (influence <= 0) continue;
        flowX += dx * influence;
        flowZ += dz * influence;
        influenceSum += influence;
      }

      const magnitude = Math.sqrt(flowX * flowX + flowZ * flowZ);
      if (magnitude > 0.0001) {
        column.flowX = flowX / magnitude;
        column.flowZ = flowZ / magnitude;
        column.flowStrength = Math.min(1, influenceSum / FLOW_STRENGTH_SCALE);
      } else {
        column.flowX = 0;
        column.flowZ = 0;
        column.flowStrength = 0;
      }

      const openNeighborCount = countOpenWaterNeighbors(grid, lx, lz, 2);
      column.waterClass = getWaterClass(column.flowStrength, openNeighborCount);
    }
  }

  for (let lx = 0; lx < bx; lx++) {
    for (let lz = 0; lz < bz; lz++) {
      copyColumnSample(
        grid.paddedColumns[
          (lx + grid.paddedRadius) * grid.paddedBoundsZ + (lz + grid.paddedRadius)
        ],
        grid.columns[lx * bz + lz],
      );
    }
  }
}

function fillColumnSample(
  out: WaterColumnSample,
  worldCursor: DataCursorInterface,
  wx: number,
  wz: number,
  originY: number,
  boundsY: number,
  minSurfaceY?: number,
  maxSurfaceY?: number,
) {
  resetColumn(out);

  for (let ly = boundsY - 1; ly >= 0; ly--) {
    const wy = originY + ly;
    const voxel = worldCursor.getVoxel(wx, wy, wz);
    if (!voxel) continue;
    if (!voxel.substanceTags["dve_is_liquid"]) continue;

    const level = voxel.getLevel();
    const levelState = voxel.getLevelState();
    const voxelId = voxel.getVoxelId();

    const above = worldCursor.getVoxel(wx, wy + 1, wz);
    if (above && above.substanceTags["dve_is_liquid"]) continue;

    let fill = 0;
    let surfaceY = 0;

    if (level >= 7 || levelState === 1) {
      fill = 1;
      surfaceY = wy + WATER_HEIGHT;
    } else {
      fill = level / 7;
      surfaceY = wy + fill * WATER_HEIGHT;
    }

    if (minSurfaceY !== undefined && surfaceY < minSurfaceY) continue;
    if (maxSurfaceY !== undefined && surfaceY > maxSurfaceY) continue;

    out.filled = true;
    out.localY = ly;
    out.level = level;
    out.levelState = levelState;
    out.voxelId = voxelId;
    out.fill = fill;
    out.surfaceY = surfaceY;
    return;
  }
}

/**
 * Extract water state from a section into a flat grid of per-column samples.
 *
 * This is a read-only pass over existing liquid simulation data.
 * It does not modify the world or any voxel state.
 *
 * @returns The shared WaterSectionGrid (reused across calls — consume before next call).
 */
export function extractWaterState(
  worldCursor: DataCursorInterface,
  sectionCursor: SectionCursor,
  options?: WaterExtractionOptions,
): WaterSectionGrid {
  const bounds = WorldSpaces.section.bounds;
  const sx = sectionCursor._sectionPosition.x;
  const sy = sectionCursor._sectionPosition.y;
  const sz = sectionCursor._sectionPosition.z;

  const bx = bounds.x;
  const bz = bounds.z;
  const by = bounds.y;
  const totalCols = bx * bz;
  const paddedBoundsX = bx + WATER_PADDED_RADIUS * 2;
  const paddedBoundsZ = bz + WATER_PADDED_RADIUS * 2;
  const paddedCount = paddedBoundsX * paddedBoundsZ;
  const minSurfaceY = options?.minSurfaceY;
  const maxSurfaceY = options?.maxSurfaceY;

  ensureColumnsCapacity(totalCols);
  ensurePaddedColumnsCapacity(paddedCount);

  _grid.originX = sx;
  _grid.originY = sy;
  _grid.originZ = sz;
  _grid.boundsX = bx;
  _grid.boundsY = by;
  _grid.boundsZ = bz;
  _grid.columns = _columns;
  _grid.paddedColumns = _paddedColumns;
  _grid.paddedRadius = WATER_PADDED_RADIUS;
  _grid.paddedBoundsX = paddedBoundsX;
  _grid.paddedBoundsZ = paddedBoundsZ;
  _grid.filledCount = 0;

  // Reset all columns
  for (let i = 0; i < totalCols; i++) {
    resetColumn(_columns[i]);
  }
  for (let i = 0; i < paddedCount; i++) {
    resetColumn(_paddedColumns[i]);
  }

  // Scan each (x,z) column top-down for the topmost liquid voxel
  for (let lx = 0; lx < bx; lx++) {
    for (let lz = 0; lz < bz; lz++) {
      const colIdx = lx * bz + lz;
      const col = _columns[colIdx];
      const wx = sx + lx;
      const wz = sz + lz;
      fillColumnSample(col, worldCursor, wx, wz, sy, by, minSurfaceY, maxSurfaceY);
      if (col.filled) {
        _grid.filledCount++;
      }
    }
  }

  for (let px = -WATER_PADDED_RADIUS; px <= bx + WATER_PADDED_RADIUS - 1; px++) {
    for (let pz = -WATER_PADDED_RADIUS; pz <= bz + WATER_PADDED_RADIUS - 1; pz++) {
      const paddedIndex =
        (px + WATER_PADDED_RADIUS) * paddedBoundsZ +
        (pz + WATER_PADDED_RADIUS);
      const paddedCol = _paddedColumns[paddedIndex];

      if (px >= 0 && px < bx && pz >= 0 && pz < bz) {
        const source = _columns[px * bz + pz];
        copyColumnSample(paddedCol, source);
        continue;
      }

      fillColumnSample(
        paddedCol,
        worldCursor,
        sx + px,
        sz + pz,
        sy,
        by,
        minSurfaceY,
        maxSurfaceY,
      );
    }
  }

  // Compute shore distance for filled columns
  computeShoreDistances(_grid, worldCursor, sx, sy, sz);
  computeFlowMetadata(_grid);

  return _grid;
}

/**
 * Compute approximate shore distance for each filled water column.
 * Uses a simple Manhattan-distance flood from non-filled neighbors.
 */
function computeShoreDistances(
  grid: WaterSectionGrid,
  worldCursor: DataCursorInterface,
  sx: number,
  sy: number,
  sz: number,
): void {
  const bx = grid.boundsX;
  const bz = grid.boundsZ;
  const cols = grid.columns;

  for (let lx = 0; lx < bx; lx++) {
    for (let lz = 0; lz < bz; lz++) {
      const idx = lx * bz + lz;
      const col = cols[idx];
      if (!col.filled) continue;

      let minDist = Infinity;

      // Check cardinal neighbors (±1 in XZ) for non-water
      const checks: [number, number][] = [
        [lx - 1, lz],
        [lx + 1, lz],
        [lx, lz - 1],
        [lx, lz + 1],
      ];

      for (const [nx, nz] of checks) {
        let isShore = false;

        if (nx < 0 || nx >= bx || nz < 0 || nz >= bz) {
          // Check neighbor in adjacent section via world cursor
          const wy = sy + col.localY;
          const voxel = worldCursor.getVoxel(sx + nx, wy, sz + nz);
          if (!voxel || !voxel.substanceTags["dve_is_liquid"]) {
            isShore = true;
          }
        } else {
          const nIdx = nx * bz + nz;
          if (!cols[nIdx].filled) {
            // Verify there's terrain here (not just empty above)
            const wy = sy + col.localY;
            const voxel = worldCursor.getVoxel(sx + nx, wy, sz + nz);
            if (!voxel || !voxel.substanceTags["dve_is_liquid"]) {
              isShore = true;
            }
          }
        }

        if (isShore) {
          const dist = 1;
          if (dist < minDist) minDist = dist;
        }
      }

      // Check extended range (2 voxels)
      if (minDist > 1) {
        for (let dx = -2; dx <= 2; dx++) {
          for (let dz = -2; dz <= 2; dz++) {
            if (dx === 0 && dz === 0) continue;
            if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) continue; // already checked
            const nx = lx + dx;
            const nz = lz + dz;
            const wy = sy + col.localY;
            const voxel = worldCursor.getVoxel(sx + nx, wy, sz + nz);
            if (!voxel || !voxel.substanceTags["dve_is_liquid"]) {
              const dist = Math.abs(dx) + Math.abs(dz);
              if (dist < minDist) minDist = dist;
            }
          }
        }
      }

      col.shoreDistance = minDist === Infinity ? -1 : minDist;
    }
  }
}
