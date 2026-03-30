import type { WaterColumnSample, WaterSectionGrid } from "../Types/WaterTypes";
import type { WaterPatchType } from "../Types/WaterPatchState.types";
import { readWaterPatchSummaryEntry } from "../Types/WaterPatchSummaryContract";
import type { WaterPatchStitchContext } from "./WaterSurfaceMesher.types";

const MIN_LARGE_PATCH_SPAN = 4;
const MIN_LARGE_PATCH_AREA = 20;
const MIN_LARGE_BODY_SIGNAL = 0.42;

type ResolvedPatchContract = {
  key: number;
  patchType: WaterPatchType;
  surfaceMinX: number;
  surfaceMinZ: number;
  surfaceMaxX: number;
  surfaceMaxZ: number;
  meanSurfaceHeight: number;
  meanThickness: number;
  meanFlow: number;
  meanTurbulence: number;
  dominantWaveDirectionX: number;
  dominantWaveDirectionZ: number;
  shoreInfluence: number;
  connectivityMask: number;
  waterBodyId: number;
};

type PatchAnchor = {
  column: WaterColumnSample;
  lx: number;
  lz: number;
};

function getGridColumn(
  grid: WaterSectionGrid,
  lx: number,
  lz: number,
) {
  if (lx >= 0 && lx < grid.boundsX && lz >= 0 && lz < grid.boundsZ) {
    return grid.columns[getColumnIndex(grid, lx, lz)] ?? null;
  }

  const radius = grid.paddedRadius;
  if (
    lx < -radius ||
    lx > grid.boundsX + radius - 1 ||
    lz < -radius ||
    lz > grid.boundsZ + radius - 1
  ) {
    return null;
  }

  const paddedIndex = (lx + radius) * grid.paddedBoundsZ + (lz + radius);
  return grid.paddedColumns[paddedIndex] ?? null;
}

function getColumnIndex(grid: WaterSectionGrid, lx: number, lz: number) {
  return lx * grid.boundsZ + lz;
}

function resolvePatchContract(
  grid: WaterSectionGrid,
  column: WaterColumnSample,
  lx: number,
  lz: number,
): ResolvedPatchContract | null {
  const isInteriorColumn = lx >= 0 && lx < grid.boundsX && lz >= 0 && lz < grid.boundsZ;
  if (isInteriorColumn) {
    const columnIndex = getColumnIndex(grid, lx, lz);
    const patchLookup = grid.gpuData.columnPatchIndex[columnIndex] ?? 0;
    if (patchLookup > 0) {
      const summary = readWaterPatchSummaryEntry(
        grid.gpuData.patchSummaryBuffer,
        grid.gpuData.patchSummaryStride || 0,
        grid.gpuData.patchMetadata,
        grid.gpuData.patchSummaryCount,
        patchLookup - 1,
      );
      if (summary) {
        return {
          key: patchLookup,
          patchType: summary.patchType,
          surfaceMinX: summary.surfaceMinX,
          surfaceMinZ: summary.surfaceMinZ,
          surfaceMaxX: summary.surfaceMaxX,
          surfaceMaxZ: summary.surfaceMaxZ,
          meanSurfaceHeight: summary.meanSurfaceHeight,
          meanThickness: summary.meanThickness,
          meanFlow: summary.meanFlow,
          meanTurbulence: summary.meanTurbulence,
          dominantWaveDirectionX: summary.dominantWaveDirectionX,
          dominantWaveDirectionZ: summary.dominantWaveDirectionZ,
          shoreInfluence: summary.shoreInfluence,
          connectivityMask: summary.connectivityMask,
          waterBodyId: summary.waterBodyId,
        };
      }
    }
  }

  const patchState = column.renderState.patchState;
  if (patchState.patchId <= 0) {
    return null;
  }

  return {
    key: -patchState.patchId,
    patchType: patchState.patchType,
    surfaceMinX: patchState.surfaceMinX,
    surfaceMinZ: patchState.surfaceMinZ,
    surfaceMaxX: patchState.surfaceMaxX,
    surfaceMaxZ: patchState.surfaceMaxZ,
    meanSurfaceHeight: patchState.meanSurfaceHeight,
    meanThickness: patchState.meanThickness,
    meanFlow: patchState.meanFlow,
    meanTurbulence: patchState.meanTurbulence,
    dominantWaveDirectionX: patchState.dominantWaveDirectionX,
    dominantWaveDirectionZ: patchState.dominantWaveDirectionZ,
    shoreInfluence: patchState.shoreInfluence,
    connectivityMask: patchState.connectivityMask,
    waterBodyId: patchState.waterBodyId,
  };
}

function sampleLargeBodyField(
  grid: WaterSectionGrid,
  lx: number,
  lz: number,
) {
  const size = grid.largeBodyFieldSize;
  const field = grid.largeBodyField;
  if (!field.length || size <= 0) return 0;

  const sampleX = Math.max(0, Math.min(size - 1, Math.floor(((lx + 0.5) / grid.boundsX) * size)));
  const sampleZ = Math.max(0, Math.min(size - 1, Math.floor(((lz + 0.5) / grid.boundsZ) * size)));
  return field[sampleX * size + sampleZ] ?? 0;
}

function isLargeOpenSurfacePatch(
  grid: WaterSectionGrid,
  column: WaterColumnSample,
  lx: number,
  lz: number,
) {
  const patch = resolvePatchContract(grid, column, lx, lz);
  if (!patch || patch.patchType !== "openSurface") {
    return false;
  }

  const spanX = patch.surfaceMaxX - patch.surfaceMinX + 1;
  const spanZ = patch.surfaceMaxZ - patch.surfaceMinZ + 1;
  const area = spanX * spanZ;
  const isInterior = lx >= 0 && lx < grid.boundsX && lz >= 0 && lz < grid.boundsZ;
  const largeBodySignal = isInterior ? sampleLargeBodyField(grid, lx, lz) : 1;
  return (
    spanX >= MIN_LARGE_PATCH_SPAN &&
    spanZ >= MIN_LARGE_PATCH_SPAN &&
    area >= MIN_LARGE_PATCH_AREA &&
    largeBodySignal >= MIN_LARGE_BODY_SIGNAL
  );
}

export function collectLargeOpenSurfacePatchIds(grid: WaterSectionGrid) {
  const patchIds = new Set<number>();

  for (let lx = -grid.paddedRadius; lx < grid.boundsX + grid.paddedRadius; lx++) {
    for (let lz = -grid.paddedRadius; lz < grid.boundsZ + grid.paddedRadius; lz++) {
      const column = getGridColumn(grid, lx, lz);
      if (
        !column ||
        !column.filled ||
        !column.renderState.standardSurfaceVisible ||
        !isLargeOpenSurfacePatch(grid, column, lx, lz)
      ) {
        continue;
      }
      const patch = resolvePatchContract(grid, column, lx, lz);
      if (!patch) continue;
      patchIds.add(patch.key);
    }
  }

  return patchIds;
}

export function isLargeOpenSurfacePatchColumn(
  grid: WaterSectionGrid,
  column: WaterColumnSample,
  lx: number,
  lz: number,
  patchIds: Set<number>,
) {
  const patch = resolvePatchContract(grid, column, lx, lz);
  return !!patch && patch.patchType === "openSurface" && patchIds.has(patch.key);
}

export function isLegacyOpenSurfacePatchColumn(
  grid: WaterSectionGrid,
  column: WaterColumnSample,
  lx: number,
  lz: number,
  patchIds: Set<number>,
) {
  return getContinuousLargePatchAnchorPatchId(grid, column, lx, lz, patchIds) <= 0;
}

function getAdjacentLargeOpenSurfacePatchColumn(
  grid: WaterSectionGrid,
  column: WaterColumnSample,
  lx: number,
  lz: number,
  patchIds: Set<number>,
): PatchAnchor | null {
  const preferredWaterBodyId = resolvePatchContract(grid, column, lx, lz)?.waterBodyId ?? 0;
  const checks: [number, number][] = [
    [lx - 1, lz],
    [lx + 1, lz],
    [lx, lz - 1],
    [lx, lz + 1],
  ];

  for (const [nx, nz] of checks) {
    const neighbor = getGridColumn(grid, nx, nz);
    if (!neighbor?.filled) continue;
    if (isLargeOpenSurfacePatchColumn(grid, neighbor, nx, nz, patchIds)) {
      const anchor = { column: neighbor, lx: nx, lz: nz };
      if (preferredWaterBodyId <= 0) {
        return anchor;
      }
      const neighborWaterBodyId = resolvePatchContract(grid, neighbor, nx, nz)?.waterBodyId ?? 0;
      if (neighborWaterBodyId === preferredWaterBodyId) {
        return anchor;
      }
    }
  }

  return null;
}

export function getContinuousLargePatchAnchorColumn(
  grid: WaterSectionGrid,
  column: WaterColumnSample,
  lx: number,
  lz: number,
  patchIds: Set<number>,
) {
  if (isLargeOpenSurfacePatchColumn(grid, column, lx, lz, patchIds)) {
    return column;
  }

  if (resolvePatchContract(grid, column, lx, lz)?.patchType !== "shoreBand") {
    return null;
  }

  return getAdjacentLargeOpenSurfacePatchColumn(grid, column, lx, lz, patchIds)?.column ?? null;
}

export function getContinuousLargePatchAnchorPatchId(
  grid: WaterSectionGrid,
  column: WaterColumnSample,
  lx: number,
  lz: number,
  patchIds: Set<number>,
) {
  if (isLargeOpenSurfacePatchColumn(grid, column, lx, lz, patchIds)) {
    return resolvePatchContract(grid, column, lx, lz)?.key ?? 0;
  }

  const adjacentAnchor = getAdjacentLargeOpenSurfacePatchColumn(grid, column, lx, lz, patchIds);
  if (!adjacentAnchor) return 0;
  return (
    resolvePatchContract(
      grid,
      adjacentAnchor.column,
      adjacentAnchor.lx,
      adjacentAnchor.lz,
    )?.key ?? 0
  );
}

export function isContinuousLargePatchOwnedColumn(
  grid: WaterSectionGrid,
  column: WaterColumnSample,
  lx: number,
  lz: number,
  patchIds: Set<number>,
) {
  if (isLargeOpenSurfacePatchColumn(grid, column, lx, lz, patchIds)) {
    return true;
  }

  if (resolvePatchContract(grid, column, lx, lz)?.patchType !== "shoreBand") {
    return false;
  }

  return !!getAdjacentLargeOpenSurfacePatchColumn(grid, column, lx, lz, patchIds);
}

export function createContinuousLargePatchStitchContext(
  grid: WaterSectionGrid,
  column: WaterColumnSample,
  lx: number,
  lz: number,
  patchIds: Set<number>,
): WaterPatchStitchContext {
  const anchor = getContinuousLargePatchAnchorColumn(
    grid,
    column,
    lx,
    lz,
    patchIds,
  );
  if (anchor) {
    return createLargeOpenSurfacePatchStitchContext(anchor);
  }

  return createLargeOpenSurfacePatchStitchContext(column);
}

export function createLargeOpenSurfacePatchStitchContext(
  column: WaterColumnSample,
): WaterPatchStitchContext {
  const patchState = column.renderState.patchState;
  return {
    continuitySignature: patchState.continuitySignature,
    meanSurfaceHeight: patchState.meanSurfaceHeight,
    meanThickness: patchState.meanThickness,
    meanFlow: patchState.meanFlow,
    meanTurbulence: patchState.meanTurbulence,
    shoreInfluence: patchState.shoreInfluence,
    dominantWaveDirectionX: patchState.dominantWaveDirectionX,
    dominantWaveDirectionZ: patchState.dominantWaveDirectionZ,
  };
}
