import type { WaterColumnSample, WaterSectionGrid } from "../Types/WaterTypes";
import type { WaterPatchStitchContext } from "./WaterSurfaceMesher.types";

const MIN_LARGE_PATCH_SPAN = 4;
const MIN_LARGE_PATCH_AREA = 20;
const MIN_LARGE_BODY_SIGNAL = 0.42;

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
  const patchState = column.renderState.patchState;
  if (patchState.patchId <= 0 || patchState.patchType !== "openSurface") {
    return false;
  }

  const spanX = patchState.surfaceMaxX - patchState.surfaceMinX + 1;
  const spanZ = patchState.surfaceMaxZ - patchState.surfaceMinZ + 1;
  const area = spanX * spanZ;
  const largeBodySignal = sampleLargeBodyField(grid, lx, lz);
  return (
    spanX >= MIN_LARGE_PATCH_SPAN &&
    spanZ >= MIN_LARGE_PATCH_SPAN &&
    area >= MIN_LARGE_PATCH_AREA &&
    largeBodySignal >= MIN_LARGE_BODY_SIGNAL
  );
}

export function collectLargeOpenSurfacePatchIds(grid: WaterSectionGrid) {
  const patchIds = new Set<number>();

  for (let lx = 0; lx < grid.boundsX; lx++) {
    for (let lz = 0; lz < grid.boundsZ; lz++) {
      const column = grid.columns[lx * grid.boundsZ + lz];
      if (
        !column.filled ||
        !column.renderState.standardSurfaceVisible ||
        !isLargeOpenSurfacePatch(grid, column, lx, lz)
      ) {
        continue;
      }
      patchIds.add(column.renderState.patchState.patchId);
    }
  }

  return patchIds;
}

export function isLargeOpenSurfacePatchColumn(
  column: WaterColumnSample,
  patchIds: Set<number>,
) {
  return patchIds.has(column.renderState.patchState.patchId);
}

export function isLegacyOpenSurfacePatchColumn(
  column: WaterColumnSample,
  patchIds: Set<number>,
) {
  return !isLargeOpenSurfacePatchColumn(column, patchIds);
}

function getAdjacentLargeOpenSurfacePatchColumn(
  grid: WaterSectionGrid,
  lx: number,
  lz: number,
  patchIds: Set<number>,
) {
  const checks: [number, number][] = [
    [lx - 1, lz],
    [lx + 1, lz],
    [lx, lz - 1],
    [lx, lz + 1],
  ];

  for (const [nx, nz] of checks) {
    if (nx < 0 || nx >= grid.boundsX || nz < 0 || nz >= grid.boundsZ) continue;
    const neighbor = grid.columns[nx * grid.boundsZ + nz];
    if (!neighbor.filled) continue;
    if (isLargeOpenSurfacePatchColumn(neighbor, patchIds)) {
      return neighbor;
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
  if (isLargeOpenSurfacePatchColumn(column, patchIds)) {
    return column;
  }

  if (column.renderState.patchState.patchType !== "shoreBand") {
    return null;
  }

  return getAdjacentLargeOpenSurfacePatchColumn(grid, lx, lz, patchIds);
}

export function getContinuousLargePatchAnchorPatchId(
  grid: WaterSectionGrid,
  column: WaterColumnSample,
  lx: number,
  lz: number,
  patchIds: Set<number>,
) {
  return (
    getContinuousLargePatchAnchorColumn(grid, column, lx, lz, patchIds)
      ?.renderState.patchState.patchId ?? 0
  );
}

export function isContinuousLargePatchOwnedColumn(
  grid: WaterSectionGrid,
  column: WaterColumnSample,
  lx: number,
  lz: number,
  patchIds: Set<number>,
) {
  if (isLargeOpenSurfacePatchColumn(column, patchIds)) {
    return true;
  }

  if (column.renderState.patchState.patchType !== "shoreBand") {
    return false;
  }

  return !!getAdjacentLargeOpenSurfacePatchColumn(grid, lx, lz, patchIds);
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

  if (isLargeOpenSurfacePatchColumn(column, patchIds)) {
    return createLargeOpenSurfacePatchStitchContext(column);
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
