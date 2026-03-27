import { WaterSectionGrid, WaterColumnSample } from "../Types/WaterTypes";

const DEFAULT_LARGE_BODY_FIELD_SIZE = 8;
// Kept in sync with WaterPatchMeshSystem thresholds — allow all openSurface
// water to generate a body field signal, even single-cell editor placements.
const MIN_LARGE_BODY_SPAN = 1;
const MIN_LARGE_BODY_AREA = 1;

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function ensureField(grid: WaterSectionGrid) {
  const fieldSize = grid.largeBodyFieldSize || DEFAULT_LARGE_BODY_FIELD_SIZE;
  const requiredSize = fieldSize * fieldSize;
  if (grid.largeBodyField.length !== requiredSize) {
    grid.largeBodyField = new Float32Array(requiredSize);
  } else {
    grid.largeBodyField.fill(0);
  }
  grid.largeBodyFieldSize = fieldSize;
}

function isLargeBodyColumn(column: WaterColumnSample) {
  if (!column.filled) return false;
  const patchState = column.renderState.patchState;
  const spanX = patchState.surfaceMaxX - patchState.surfaceMinX + 1;
  const spanZ = patchState.surfaceMaxZ - patchState.surfaceMinZ + 1;
  const area = spanX * spanZ;
  return (
    (patchState.patchType === "openSurface" || patchState.patchType === "enclosedPatch") &&
    spanX >= MIN_LARGE_BODY_SPAN &&
    spanZ >= MIN_LARGE_BODY_SPAN &&
    area >= MIN_LARGE_BODY_AREA
  );
}

function addLargeBodyCoverage(grid: WaterSectionGrid, column: WaterColumnSample, lx: number, lz: number) {
  if (!isLargeBodyColumn(column)) {
    return;
  }

  const patchState = column.renderState.patchState;
  const size = grid.largeBodyFieldSize;
  const field = grid.largeBodyField;
  const scaleX = size / Math.max(grid.boundsX, 1);
  const scaleZ = size / Math.max(grid.boundsZ, 1);
  const spanX = patchState.surfaceMaxX - patchState.surfaceMinX + 1;
  const spanZ = patchState.surfaceMaxZ - patchState.surfaceMinZ + 1;
  const area = spanX * spanZ;
  const calmOpenFactor = clamp01((1 - patchState.shoreInfluence) * 0.75 + patchState.meanFlow * 0.25);
  const sizeFactor = clamp01(area / Math.max(grid.boundsX * grid.boundsZ, 1));
  const value = clamp01(0.35 + calmOpenFactor * 0.35 + sizeFactor * 0.4);
  const radius = Math.max(1, ((spanX * scaleX) + (spanZ * scaleZ)) * 0.2);
  const centerX = (lx + 0.5) * scaleX;
  const centerZ = (lz + 0.5) * scaleZ;

  for (let fx = 0; fx < size; fx++) {
    for (let fz = 0; fz < size; fz++) {
      const dx = fx + 0.5 - centerX;
      const dz = fz + 0.5 - centerZ;
      const distance = Math.hypot(dx, dz);
      if (distance > radius) continue;
      const falloff = clamp01(1 - distance / Math.max(radius, 0.0001));
      const nextValue = Math.max(field[fx * size + fz], value * (0.55 + falloff * 0.45));
      field[fx * size + fz] = clamp01(nextValue);
    }
  }
}

function blurField(grid: WaterSectionGrid) {
  const size = grid.largeBodyFieldSize;
  const source = grid.largeBodyField;
  const next = new Float32Array(source.length);

  for (let fx = 0; fx < size; fx++) {
    for (let fz = 0; fz < size; fz++) {
      let total = 0;
      let weight = 0;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const sx = fx + dx;
          const sz = fz + dz;
          if (sx < 0 || sx >= size || sz < 0 || sz >= size) continue;
          const sampleWeight = dx === 0 && dz === 0 ? 0.4 : Math.abs(dx) + Math.abs(dz) === 1 ? 0.12 : 0.06;
          total += source[sx * size + sz] * sampleWeight;
          weight += sampleWeight;
        }
      }
      next[fx * size + fz] = weight > 0 ? total / weight : 0;
    }
  }

  grid.largeBodyField = next;
}

export function buildWaterLargeBodyField(grid: WaterSectionGrid) {
  ensureField(grid);

  const bz = grid.boundsZ;
  for (let lx = 0; lx < grid.boundsX; lx++) {
    for (let lz = 0; lz < grid.boundsZ; lz++) {
      const column = grid.columns[lx * bz + lz];
      addLargeBodyCoverage(grid, column, lx, lz);
    }
  }

  blurField(grid);
}