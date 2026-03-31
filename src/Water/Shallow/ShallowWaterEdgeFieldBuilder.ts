import { DEFAULT_SHALLOW_WATER_CONFIG } from "./ShallowWaterTypes";
import type {
  ShallowEdgeFieldSectionRenderData,
  ShallowEdgeSplat,
  ShallowFilmSectionRenderData,
  ShallowVisualColumnState,
} from "./ShallowWaterTypes";

const SHORE_DISTANCE_MAX = 4;
const MIN_SPLAT_SCORE = 0.3;

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function normalize2(x: number, z: number) {
  const len = Math.hypot(x, z);
  if (len <= 0.000001) return { x: 0, z: 0, length: 0 };
  return { x: x / len, z: z / len, length: len };
}

function normalize3(x: number, y: number, z: number) {
  const len = Math.hypot(x, y, z);
  if (len <= 0.000001) return { x: 0, y: 1, z: 0, length: 0 };
  return { x: x / len, y: y / len, z: z / len, length: len };
}

function getIndex(sizeX: number, x: number, z: number) {
  return z * sizeX + x;
}

function sampleColumn(
  columns: ShallowVisualColumnState[],
  sizeX: number,
  sizeZ: number,
  x: number,
  z: number,
  fallback: ShallowVisualColumnState,
) {
  if (x < 0 || z < 0 || x >= sizeX || z >= sizeZ) {
    return fallback;
  }
  return columns[getIndex(sizeX, x, z)] ?? fallback;
}

function makeEmptySplat(): ShallowEdgeSplat {
  return {
    x: 0,
    y: 0,
    z: 0,
    normalX: 0,
    normalY: 1,
    normalZ: 0,
    dirX: 1,
    dirZ: 0,
    radius: 0,
    stretch: 0,
    alpha: 0,
    foam: 0,
    age: 0,
    thickness: 0,
    shoreDist: 0,
    flowSpeed: 0,
    settling: 0,
    breakup: 0,
    mergeBlend: 0,
    deepBlend: 0,
    handoffBlend: 0,
    emitterId: 0,
  };
}

function buildSplatFromColumn(
  film: ShallowFilmSectionRenderData,
  x: number,
  z: number,
  column: ShallowVisualColumnState,
  out: ShallowEdgeSplat,
) {
  const fallback = column;
  const left = sampleColumn(film.columns, film.sizeX, film.sizeZ, x - 1, z, fallback);
  const right = sampleColumn(film.columns, film.sizeX, film.sizeZ, x + 1, z, fallback);
  const back = sampleColumn(film.columns, film.sizeX, film.sizeZ, x, z - 1, fallback);
  const front = sampleColumn(film.columns, film.sizeX, film.sizeZ, x, z + 1, fallback);

  const gradientX = left.visualSurfaceY - right.visualSurfaceY;
  const gradientZ = back.visualSurfaceY - front.visualSurfaceY;
  const normal = normalize3(gradientX, 2, gradientZ);

  const shoreFactor = 1 - clamp01(column.shoreDist / SHORE_DISTANCE_MAX);
  const motion = clamp01(column.flowSpeed / Math.max(0.0001, DEFAULT_SHALLOW_WATER_CONFIG.maxSpreadVelocity));
  const unsettled = 1 - clamp01(column.settled);
  const thinness = 1 - clamp01(column.coverage);
  const breakup = clamp01(column.breakup);
  const foam = clamp01(column.foam);
  const edgeScore = clamp01(
    shoreFactor * 0.42 +
      column.edgeStrength * 0.24 +
      motion * 0.17 +
      thinness * 0.09 +
      unsettled * 0.08,
  ) * (1 - column.mergeBlend * 0.24 - column.deepBlend * 0.34 - column.handoffBlend * 0.22);

  const flowX = column.flowX + gradientX * 0.35;
  const flowZ = column.flowZ + gradientZ * 0.35;
  const flowDir = normalize2(flowX, flowZ);
  const fallbackDir = normalize2(gradientX, gradientZ);
  const dirX = flowDir.length > 0 ? flowDir.x : fallbackDir.length > 0 ? fallbackDir.x : 1;
  const dirZ = flowDir.length > 0 ? flowDir.z : fallbackDir.length > 0 ? fallbackDir.z : 0;
  const alpha = clamp01(
    edgeScore *
      (0.22 + foam * 0.22 + column.wetness * 0.1 + column.mergeBlend * 0.08) *
      (1 - column.deepBlend * 0.22 - column.handoffBlend * 0.16),
  );
  const radius = clamp(
    0.14 +
      edgeScore * (0.16 - column.deepBlend * 0.04) +
      foam * 0.05 +
      motion * 0.04 +
      column.mergeBlend * 0.08 +
      column.deepBlend * 0.1 +
      column.handoffBlend * 0.08,
    0.1,
    0.72,
  );
  const stretch = clamp01(
    0.24 +
      motion * 0.34 +
      breakup * 0.18 +
      column.mergeBlend * 0.04 -
      column.deepBlend * 0.1 -
      column.handoffBlend * 0.06,
  );

  out.x = film.originX + x + 0.5 + dirX * 0.06;
  out.y = column.visualSurfaceY + foam * 0.01;
  out.z = film.originZ + z + 0.5 + dirZ * 0.06;
  out.normalX = normal.x;
  out.normalY = normal.y;
  out.normalZ = normal.z;
  out.dirX = dirX;
  out.dirZ = dirZ;
  out.radius = radius;
  out.stretch = stretch;
  out.alpha = alpha;
  out.foam = clamp01(foam * (0.55 + edgeScore * 0.45));
  out.age = Math.max(0, column.age);
  out.thickness = Math.max(0, column.thickness);
  out.shoreDist = column.shoreDist;
  out.flowSpeed = column.flowSpeed;
  out.settling = clamp01(column.settled);
  out.breakup = breakup;
  out.mergeBlend = clamp01(column.mergeBlend);
  out.deepBlend = clamp01(column.deepBlend);
  out.handoffBlend = clamp01(column.handoffBlend);
  out.emitterId = Math.max(0, column.emitterId);
}

/**
 * Build the edge field for a shallow-water film snapshot.
 * The output is stable and reuses compatible splat objects when possible.
 */
export function buildShallowWaterEdgeFieldSectionRenderData(
  film: ShallowFilmSectionRenderData,
  previous?: ShallowEdgeFieldSectionRenderData,
): ShallowEdgeFieldSectionRenderData {
  const columns = film.columns;
  const count = film.sizeX * film.sizeZ;
  const splats =
    previous &&
    previous.originX === film.originX &&
    previous.originZ === film.originZ &&
    previous.sizeX === film.sizeX &&
    previous.sizeZ === film.sizeZ
      ? previous.splats
      : [];

  let activeSplatCount = 0;

  for (let z = 0; z < film.sizeZ; z++) {
    for (let x = 0; x < film.sizeX; x++) {
      const index = getIndex(film.sizeX, x, z);
      if (index >= count) continue;
      const column = columns[index];
      if (!column.active || column.coverage <= 0 || column.thickness <= 0.002) continue;

      const shoreFactor = 1 - clamp01(column.shoreDist / SHORE_DISTANCE_MAX);
      const motion = clamp01(column.flowSpeed / Math.max(0.0001, DEFAULT_SHALLOW_WATER_CONFIG.maxSpreadVelocity));
      const unsettled = 1 - clamp01(column.settled);
      const thinness = 1 - clamp01(column.coverage);
      const rawScore = clamp01(
        shoreFactor * 0.42 +
          column.edgeStrength * 0.24 +
          motion * 0.17 +
          thinness * 0.09 +
          unsettled * 0.08,
      ) * (1 - column.mergeBlend * 0.24 - column.deepBlend * 0.34 - column.handoffBlend * 0.22);

      if (rawScore < MIN_SPLAT_SCORE) continue;

      const splat = splats[activeSplatCount] ?? makeEmptySplat();
      splats[activeSplatCount] = splat;
      buildSplatFromColumn(film, x, z, column, splat);
      activeSplatCount += 1;
    }
  }

  splats.length = activeSplatCount;

  return {
    originX: film.originX,
    originZ: film.originZ,
    sizeX: film.sizeX,
    sizeZ: film.sizeZ,
    splats,
    activeSplatCount,
  };
}
