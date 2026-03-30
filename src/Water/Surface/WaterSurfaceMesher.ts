import { WaterColumnSample, WaterSectionGrid, WaterSupportLayer } from "../Types/WaterTypes";
import { RenderedMaterials } from "../../Mesher/Voxels/Models/RenderedMaterials";
import { VoxelMeshVertexConstants } from "../../Mesher/Voxels/Geometry/VoxelMeshVertexStructCursor";
import { VoxelShaderData } from "../../Mesher/Voxels/Geometry/VoxelShaderData";
import { VoxelLUT } from "../../Voxels/Data/VoxelLUT";
import { GeometryLUT } from "../../Voxels/Data/GeometryLUT";
import { EngineSettings } from "../../Settings/EngineSettings";
import {
  collectLargeOpenSurfacePatchIds,
  createContinuousLargePatchStitchContext,
  createLargeOpenSurfacePatchStitchContext,
  getContinuousLargePatchAnchorPatchId,
  isLargeOpenSurfacePatchColumn,
  isLegacyOpenSurfacePatchColumn,
} from "./WaterPatchMeshSystem";
import {
  collectContinuousLargePatchRenderSnapshot,
  collectContinuousLargePatchRenderableCellKeys,
  meshContinuousLargePatchSurface,
  type ContinuousLargePatchRenderSnapshot,
  type ContinuousPatchMesherPrimitives,
} from "./WaterContinuousPatchMesher";
import {
  meshWaterSurfaceComposer as runWaterSurfaceComposer,
  type WaterSurfaceComposerDispatch,
} from "./WaterSurfaceRuntimeComposer";
import type {
  WaterPatchStitchContext,
  WaterPreparedCellRenderData,
  WaterPoint,
  WaterSurfaceColumnSelector,
  WaterSurfaceMesherOptions,
  WaterSurfaceMesherProfile,
  WaterSurfaceMesherRegime,
  WaterSurfaceSpline,
  WaterSurfaceVertexPayload,
  WaterVertexContext,
} from "./WaterSurfaceMesher.types";
import {
  CLASS_NEIGHBOR_BLEND_RADIUS,
  COASTAL_BLEND_DISTANCE,
  MAX_LAYERED_SEAM_OPEN_EDGE,
  MIN_LAYERED_SEAM_DEPTH,
  MIN_LAYERED_SEAM_FILL,
  MIN_LAYERED_SEAM_SLOPE,
  RIVER_FLOW_BLEND_END,
  RIVER_FLOW_BLEND_START,
  SEA_LEVEL_BAND,
  SEA_OPEN_BLEND_END,
  SEA_OPEN_BLEND_START,
  VERTEX_SIZE,
  WATER_CORNER_SAMPLE_RADIUS,
  WATER_SEAM_EPSILON,
  WATER_UNIFORM_SUBDIVISIONS,
} from "./WaterSurfaceMesher.types";
import {
  bilerp,
  catmullRom,
  clamp01,
  computeWaterCrestOffset,
  computeWaterCrestStrength,
  encodeWaterClassValue,
  getDeterministicSurfaceScalar,
  getNonGridSurfaceNoise,
  getStableHeightNoise,
  hash2D,
  lerp,
  packWaterClassAndTurbidity,
  sampleSeamCurvePoint,
  sampleSeamCurveValue,
  smoothstep,
  waterHash,
  waterHashCell,
} from "./WaterSurfaceMesher.math";
import {
  classifyWaterMesherRegime,
  createWaterMesherProfile,
  getWaterMesherDirection,
} from "./WaterSurfaceMesher.regimes";

export type {
  WaterSurfaceMesherOptions,
  WaterSurfaceMesherRegime,
} from "./WaterSurfaceMesher.types";

// ──────────────────────────────────────────────────────────────────────────
// Phase 0 — Baseline control and performance telemetry
// ──────────────────────────────────────────────────────────────────────────

/** Switch to true once the GPU water path is ready to replace CPU meshing. */
export const USE_GPU_WATER = true;

// Per-subset performance counters — reset at the start of each
// meshWaterSurfaceSubset call. Read via getWaterMesherPerf().
let _perfCellCount = 0;
let _perfSurfaceEmits = 0;
let _perfTimeSampling = 0;
let _perfTimeSeams = 0;
let _perfTimeVertex = 0;
const ENABLE_WATER_MESHER_TELEMETRY = false;

/**
 * Returns telemetry counters from the most recent meshWaterSurfaceSubset call.
 * Use for baseline measurement and regression detection.
 */
export function getWaterMesherPerf() {
  return {
    cells: _perfCellCount,
    surfaceEmits: _perfSurfaceEmits,
    samplingMs: _perfTimeSampling,
    seamsMs: _perfTimeSeams,
    vertexMs: _perfTimeVertex,
  };
}

/**
 * Resolves the still-water texture index for a given voxel ID.
 * Falls back to 0 if not found.
 */
function resolveWaterTexture(voxelId: number): number {
  const geometryInputStateIndex = VoxelLUT.getGeometryInputIndex(voxelId, 0);
  const geometryInputPaletteIds =
    GeometryLUT.geometryInputsIndex[geometryInputStateIndex];
  if (!geometryInputPaletteIds?.length) return 0;

  for (const geometryInputPaletteId of geometryInputPaletteIds) {
    const nodeInputs = GeometryLUT.geometryInputs[geometryInputPaletteId];
    if (!nodeInputs) continue;

    for (const args of nodeInputs) {
      if (!args) continue;
      if (typeof args.stillTexture === "number") return args.stillTexture;
      if (typeof args.texture === "number") return args.texture;
      if (Array.isArray(args) && typeof args[1] === "number") return args[1];
    }
  }

  return 0;
}

function createWaterVertexPayload(
  column: WaterColumnSample,
  stableSurfaceHeight: number,
): WaterSurfaceVertexPayload {
  const foam = column.renderState.foamClassMask;
  const edgeState = column.renderState.edgeState;
  const seamFactor = stableSurfaceHeight < 0 ? 1.15 : 1;
  const breakerBoost = clamp01(
    1 +
      edgeState.edgeWaveDamping * 0.22 +
      edgeState.wetReach * 0.18 +
      (1 - edgeState.edgeContinuity) * 0.12,
  );

  return {
    dropHeight: clamp01(edgeState.dropHeight / 2.5),
    foamCrest: clamp01(foam.crest * seamFactor),
    foamEdge: clamp01(Math.max(foam.edge, edgeState.edgeFoamPotential) * breakerBoost * seamFactor),
    foamImpact: clamp01((foam.impact + edgeState.edgeFoamPotential * 0.18) * seamFactor),
  };
}

function isInteriorColumn(grid: WaterSectionGrid, lx: number, lz: number) {
  return lx >= 0 && lx < grid.boundsX && lz >= 0 && lz < grid.boundsZ;
}

function isCompatibleWithStitchContext(
  grid: WaterSectionGrid,
  col: WaterColumnSample,
  lx: number,
  lz: number,
  stitchContext?: WaterPatchStitchContext,
) {
  if (!stitchContext) return true;
  if (isInteriorColumn(grid, lx, lz)) return true;

  const patchState = col.renderState.patchState;
  if (
    patchState.patchType !== "openSurface" &&
    patchState.patchType !== "enclosedPatch" &&
    patchState.patchType !== "shoreBand"
  ) {
    return false;
  }

  if (
    stitchContext.continuitySignature !== 0 &&
    patchState.continuitySignature !== 0 &&
    (stitchContext.continuitySignature & patchState.continuitySignature) === 0
  ) {
    return false;
  }

  const heightDelta = Math.abs(col.renderSurfaceY - stitchContext.meanSurfaceHeight);
  const thicknessDelta = Math.abs(
    patchState.meanThickness - stitchContext.meanThickness,
  );
  const flowDelta = Math.abs(patchState.meanFlow - stitchContext.meanFlow);
  const turbulenceDelta = Math.abs(
    patchState.meanTurbulence - stitchContext.meanTurbulence,
  );
  const shoreDelta = Math.abs(
    patchState.shoreInfluence - stitchContext.shoreInfluence,
  );

  const candidateDirLength = Math.hypot(
    patchState.dominantWaveDirectionX,
    patchState.dominantWaveDirectionZ,
  );
  const anchorDirLength = Math.hypot(
    stitchContext.dominantWaveDirectionX,
    stitchContext.dominantWaveDirectionZ,
  );
  const directionDot =
    candidateDirLength > 0.0001 && anchorDirLength > 0.0001
      ? (patchState.dominantWaveDirectionX * stitchContext.dominantWaveDirectionX +
          patchState.dominantWaveDirectionZ * stitchContext.dominantWaveDirectionZ) /
        (candidateDirLength * anchorDirLength)
      : 1;

  return (
    heightDelta <= 1.2 &&
    thicknessDelta <= 0.75 &&
    flowDelta <= 0.45 &&
    turbulenceDelta <= 0.45 &&
    shoreDelta <= 0.55 &&
    directionDot >= 0.15
  );
}

function getMesherDirectionForSample(
  grid: WaterSectionGrid,
  col: WaterColumnSample,
  lx: number,
  lz: number,
  stitchContext?: WaterPatchStitchContext,
): [number, number] {
  if (stitchContext && !isInteriorColumn(grid, lx, lz)) {
    const magnitude = Math.hypot(
      stitchContext.dominantWaveDirectionX,
      stitchContext.dominantWaveDirectionZ,
    );
    if (magnitude > 0.0001) {
      return [
        stitchContext.dominantWaveDirectionX / magnitude,
        stitchContext.dominantWaveDirectionZ / magnitude,
      ];
    }
  }

  return getWaterMesherDirection(col);
}

/**
 * Compute a corner payload by averaging the foam/drop values of the up to 4
 * columns that share this grid corner. This ensures that corner values match
 * between adjacent cells (eliminating cell-boundary jumps in foam attributes).
 */
function sampleCornerPayload(
  grid: WaterSectionGrid,
  cornerX: number,
  cornerZ: number,
  fallback: WaterSurfaceVertexPayload,
  stitchContext?: WaterPatchStitchContext,
): WaterSurfaceVertexPayload {
  let totalCrest = 0, totalEdge = 0, totalImpact = 0, totalDrop = 0;
  let count = 0;
  for (let cx = cornerX - 1; cx <= cornerX; cx++) {
    for (let cz = cornerZ - 1; cz <= cornerZ; cz++) {
      const col = getFilledColumn(grid, cx, cz);
      if (!col) continue;
      if (!isCompatibleWithStitchContext(grid, col, cx, cz, stitchContext)) {
        continue;
      }
      const foam = col.renderState.foamClassMask;
      const edgeState = col.renderState.edgeState;
      totalCrest += foam.crest;
      totalEdge += Math.max(foam.edge, edgeState.edgeFoamPotential);
      totalImpact += foam.impact;
      totalDrop += edgeState.dropHeight / 2.5;
      count++;
    }
  }
  if (count === 0) return fallback;
  return {
    foamCrest: clamp01(totalCrest / count),
    foamEdge: clamp01(totalEdge / count),
    foamImpact: clamp01(totalImpact / count),
    dropHeight: clamp01(totalDrop / count),
  };
}

/**
 * Precomputed voxelData vectors for each quad vertex (full light=15, no AO, no animation).
 */
const _voxelData = [
  { x: 0, y: 0, z: 0, w: 0 },
  { x: 0, y: 0, z: 0, w: 0 },
  { x: 0, y: 0, z: 0, w: 0 },
  { x: 0, y: 0, z: 0, w: 0 },
];

function initVoxelData() {
  for (let vi = 0; vi < 4; vi++) {
    const ref = _voxelData[vi];
    // Pack: light1=15 in x, light2=15 in y, light3=15|vertexIndex in z, light4=15 in w
    let x = 0;
    x |= (15 & VoxelShaderData.LightMask) << 0; // light1 = 15
    // ao all 0
    ref.x = x;
    let y = 0;
    y |= (15 & VoxelShaderData.LightMask) << 0; // light2 = 15
    ref.y = y;
    let z = 0;
    z |= (15 & VoxelShaderData.LightMask) << 0; // light3 = 15
    z |= (vi & VoxelShaderData.VertexMask) << 16; // vertexIndex
    ref.z = z;
    let w = 0;
    w |= (15 & VoxelShaderData.LightMask) << 0; // light4 = 15
    ref.w = w;
  }
}

// Initialize once at module load
initVoxelData();

/**
 * Write a single water vertex into the proto mesh buffer.
 */
function writeWaterVertex(
  array: Float32Array,
  localIndex: number,
  px: number,
  py: number,
  pz: number,
  nx: number,
  ny: number,
  nz: number,
  u: number,
  v: number,
  textureIndex: number,
  voxelData: { x: number; y: number; z: number; w: number },
  fillFactor: number,
  heightNorm: number,
  shoreDistance: number,
  openEdgeFactor: number,
  interactionInfluence: number,
  slope: number,
  flowX: number,
  flowZ: number,
  flowStrength: number,
  waterClassValue: number,
  stableSurfaceHeight: number,
  payload: WaterSurfaceVertexPayload,
  gradX: number,
  gradZ: number,
  curvature: number,
) {
  const i = localIndex * VERTEX_SIZE;
  const shoreFactor = computeShoreFactor(shoreDistance);
  const shoreDistanceNormalized = computeShoreDistanceNormalized(shoreDistance);
  const crestStrength =
    stableSurfaceHeight >= 0
      ? computeWaterCrestStrength(
          fillFactor,
          shoreDistance,
          openEdgeFactor,
          slope,
          flowStrength,
          interactionInfluence,
        )
      : 0;

  // Position (offset 0-2)
  array[i + VoxelMeshVertexConstants.PositionOffset] = px;
  array[i + VoxelMeshVertexConstants.PositionOffset + 1] = py;
  array[i + VoxelMeshVertexConstants.PositionOffset + 2] = pz;
  // Water Sprint 4 payload packed into auxiliary floats.
  array[i + 3] = payload.dropHeight;
  array[i + 7] = payload.foamEdge;
  array[i + 11] = payload.foamImpact;
  array[i + 17] = Math.max(crestStrength, payload.foamCrest);

  // Normal (offset 4-6)
  array[i + VoxelMeshVertexConstants.NormalOffset] = nx;
  array[i + VoxelMeshVertexConstants.NormalOffset + 1] = ny;
  array[i + VoxelMeshVertexConstants.NormalOffset + 2] = nz;

  // TextureIndex (offset 8-10)
  array[i + VoxelMeshVertexConstants.TextureIndexOffset] =
    VoxelShaderData.createTextureIndex(textureIndex, 0);
  array[i + VoxelMeshVertexConstants.TextureIndexOffset + 1] =
    VoxelShaderData.createTextureIndex(0, 0);
  array[i + VoxelMeshVertexConstants.TextureIndexOffset + 2] =
    VoxelShaderData.createTextureIndex(0, 0);

  // UV (offset 12-13)
  array[i + VoxelMeshVertexConstants.UVOffset] = u;
  array[i + VoxelMeshVertexConstants.UVOffset + 1] = v;

  // Color / WorldContext (offset 14-16)
  // x = fill factor
  // y = shore factor (1 near coast, 0 offshore)
  // z = edge openness / boundary factor
  array[i + VoxelMeshVertexConstants.ColorOffset] = fillFactor;
  array[i + VoxelMeshVertexConstants.ColorOffset + 1] = shoreFactor;
  array[i + VoxelMeshVertexConstants.ColorOffset + 2] = openEdgeFactor;

  // VoxelData (offset 18-21)
  array[i + VoxelMeshVertexConstants.VoxelDataOFfset] = voxelData.x;
  array[i + VoxelMeshVertexConstants.VoxelDataOFfset + 1] = voxelData.y;
  array[i + VoxelMeshVertexConstants.VoxelDataOFfset + 2] = voxelData.z;
  array[i + VoxelMeshVertexConstants.VoxelDataOFfset + 3] = voxelData.w;

  // Metadata (offset 22-25): dedicated water flow payload
  //   x = normalized flow X
  //   y = normalized flow Z
  //   z = flow strength [0,1]
  //   w = water class encoded (river=0, lake=0.5, sea=1)
  array[i + VoxelMeshVertexConstants.MetadataOffset] = flowX;
  array[i + VoxelMeshVertexConstants.MetadataOffset + 1] = flowZ;
  array[i + VoxelMeshVertexConstants.MetadataOffset + 2] = flowStrength;
  array[i + VoxelMeshVertexConstants.MetadataOffset + 3] = waterClassValue;

  // Stable water surface context.
  // Top-surface quads store a constant world-space surface Y.
  // Vertical seam quads store -1 to disable underside shading.
  array[i + 26] = stableSurfaceHeight;
  // PhNormalized (offset 27): shoreline distance normalized [0,1]
  //   0 = coast-adjacent water
  //   1 = offshore / no nearby shore within the encoded radius
  array[i + 27] = shoreDistanceNormalized;

  // Phase 3 \u2014 Surface gradient and curvature (offsets 28\u201330).
  // Allows GPU shaders to reconstruct surface derivatives without CPU preprocessing.
  // \u2022 WaterGradientX = \u2212nx/ny  = local dY/dX (surface slope in X)
  // \u2022 WaterGradientZ = \u2212nz/ny  = local dY/dZ (surface slope in Z)
  // \u2022 WaterCurvature = cell-slope scalar \u2208 [0,1] (curvature proxy)
  // Uses pre-averaged gradX/gradZ/curvature from emitWaterQuad so that all 4
  // corners carry the same value — prevents diagonal band artifact from varying.
  array[i + VoxelMeshVertexConstants.WaterGradientXOffset] = gradX;
  array[i + VoxelMeshVertexConstants.WaterGradientZOffset] = gradZ;
  array[i + VoxelMeshVertexConstants.WaterCurvatureOffset] = curvature;
}

function computeShoreFactor(shoreDistance: number) {
  return shoreDistance >= 0 ? Math.max(0, 1 - Math.min(shoreDistance / 4, 1)) : 0;
}

function computeShoreDistanceNormalized(shoreDistance: number) {
  return shoreDistance >= 0 ? Math.min(shoreDistance / 8, 1) : 1;
}

function computeOpenEdgeFactor(
  grid: WaterSectionGrid,
  lx: number,
  lz: number,
  stitchContext?: WaterPatchStitchContext,
) {
  const checks: [number, number][] = [
    [lx - 1, lz],
    [lx + 1, lz],
    [lx, lz - 1],
    [lx, lz + 1],
  ];
  let openSides = 0;
  for (const [nx, nz] of checks) {
    const neighbor = getFilledColumn(grid, nx, nz);
    if (!neighbor) {
      openSides++;
    }
  }
  const openness = openSides / checks.length;
  if (!stitchContext) {
    return openness;
  }

  const continuousEdgeDamping = clamp01(
    0.12 +
      stitchContext.meanFlow * 0.18 +
      stitchContext.meanTurbulence * 0.12 +
      (1 - clamp01(stitchContext.shoreInfluence)) * 0.18,
  );
  return openness * continuousEdgeDamping;
}

function getFilledColumn(
  grid: WaterSectionGrid,
  lx: number,
  lz: number,
) {
  if (lx >= 0 && lx < grid.boundsX && lz >= 0 && lz < grid.boundsZ) {
    const col = grid.columns[lx * grid.boundsZ + lz];
    return col.filled ? col : null;
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
  const col = grid.paddedColumns[paddedIndex];
  return col.filled ? col : null;
}

function getOpenNeighborCount(
  grid: WaterSectionGrid,
  lx: number,
  lz: number,
  radius: number,
) {
  let count = 0;
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (dx === 0 && dz === 0) continue;
      if (getFilledColumn(grid, lx + dx, lz + dz)) {
        count++;
      }
    }
  }
  return count;
}

function getRawWaterClassValue(
  grid: WaterSectionGrid,
  col: WaterColumnSample,
  lx: number,
  lz: number,
) {
  const seaLevel = (EngineSettings.settings.terrain as any).seaLevel ?? 32;
  const openNeighborCount = getOpenNeighborCount(grid, lx, lz, 2);
  const openEdgeFactor = computeOpenEdgeFactor(grid, lx, lz);
  const shoreDistance =
    col.shoreDistance >= 0 ? col.shoreDistance : COASTAL_BLEND_DISTANCE + 2;
  const shoreDistanceNormalized = clamp01(
    shoreDistance / COASTAL_BLEND_DISTANCE,
  );
  const coastalBand = 1 - shoreDistanceNormalized;
  const nearSeaLevel =
    1 -
    smoothstep(
      SEA_LEVEL_BAND + 0.75,
      SEA_LEVEL_BAND + 5,
      Math.abs(col.surfaceY - seaLevel),
    );
  const openness = smoothstep(
    SEA_OPEN_BLEND_START,
    SEA_OPEN_BLEND_END,
    openNeighborCount,
  );
  const riverFlow = smoothstep(
    RIVER_FLOW_BLEND_START,
    RIVER_FLOW_BLEND_END,
    col.flowStrength,
  );

  let seaWeight = Math.max(
    col.waterClass === "sea" ? 0.55 : 0,
    nearSeaLevel *
      (openness * 0.85 +
        openEdgeFactor * 0.35 +
        shoreDistanceNormalized * 0.2),
  );
  seaWeight *= 1 - riverFlow * 0.35;

  let riverWeight = Math.max(
    col.waterClass === "river" ? 0.55 : 0,
    riverFlow *
      (1 - seaWeight * 0.7) *
      (0.9 - shoreDistanceNormalized * 0.25 + coastalBand * 0.1),
  );

  let lakeWeight = Math.max(
    col.waterClass === "lake" ? 0.35 : 0,
    0.25 + (1 - riverFlow) * 0.4 + (1 - seaWeight) * 0.25,
  );

  const total = seaWeight + riverWeight + lakeWeight;
  if (total <= 0.0001) {
    return encodeWaterClassValue(col.waterClass);
  }

  seaWeight /= total;
  riverWeight /= total;
  lakeWeight /= total;

  return clamp01(riverWeight * 0 + lakeWeight * 0.5 + seaWeight);
}

function computeWaterClassValue(
  grid: WaterSectionGrid,
  col: WaterColumnSample,
  lx: number,
  lz: number,
) {
  const centerValue = getRawWaterClassValue(grid, col, lx, lz);
  let total = centerValue;
  let count = 1;

  for (
    let dx = -CLASS_NEIGHBOR_BLEND_RADIUS;
    dx <= CLASS_NEIGHBOR_BLEND_RADIUS;
    dx++
  ) {
    for (
      let dz = -CLASS_NEIGHBOR_BLEND_RADIUS;
      dz <= CLASS_NEIGHBOR_BLEND_RADIUS;
      dz++
    ) {
      if (dx === 0 && dz === 0) continue;
      const neighbor = getFilledColumn(grid, lx + dx, lz + dz);
      if (!neighbor) continue;
      total += getRawWaterClassValue(grid, neighbor, lx + dx, lz + dz);
      count++;
    }
  }

  const neighborhoodValue = total / count;
  return clamp01(centerValue * 0.65 + neighborhoodValue * 0.35);
}

// Grid-scoped height cache — cleared per meshWaterSurfaceSubset call.
// Corner vertices are shared between adjacent cells; caching avoids O(r²)
// weighted sampling for the same (vx, vz) position multiple times per frame.
// Only used when stitchContext is undefined (cross-cell sharing is safe).
let _hcData: Float64Array = new Float64Array(0);
let _hcStride = 0;
let _hcOX = 0;
let _hcOZ = 0;

function _initHeightCache(bx: number, bz: number): void {
  const margin = WATER_CORNER_SAMPLE_RADIUS + 1;
  const w = bx + 2 * margin + 2;
  const h = bz + 2 * margin + 2;
  const size = w * h;
  if (_hcData.length < size) _hcData = new Float64Array(size);
  _hcData.fill(NaN, 0, size);
  _hcStride = h;
  _hcOX = margin;
  _hcOZ = margin;
}

// Phase 1a — Per-corner WaterVertexContext cache.
// At interior corners each position is touched by up to 4 cells; caching
// saves 3 redundant createWaterVertexContext calls per interior corner.
let _cornerCtxPool: (WaterVertexContext | null)[] = [];
let _cornerCtxStride = 0;

function _initCornerCtxCache(bx: number, bz: number): void {
  const w = bx + 2;
  const h = bz + 2;
  const size = w * h;
  if (_cornerCtxPool.length < size) {
    _cornerCtxPool = new Array(size).fill(null);
  } else {
    _cornerCtxPool.fill(null, 0, size);
  }
  _cornerCtxStride = h;
}

function _getCornerCtxCacheIndex(
  vx: number, vz: number, stitchContext: WaterPatchStitchContext | undefined,
): number {
  // Only cache when stitchContext is absent: presence implies patch-specific
  // state that cannot be safely shared between cells.
  if (stitchContext !== undefined) return -1;
  return (vx + 1) * _cornerCtxStride + (vz + 1);
}

function sampleCornerLocalSurfaceY(
  grid: WaterSectionGrid,
  vertexX: number,
  vertexZ: number,
  fallbackY: number,
  stitchContext?: WaterPatchStitchContext,
) {
  // Fast cache path: skip repeated O(r²) sampling for shared corner vertices.
  const ci = stitchContext === undefined
    ? (vertexX + _hcOX) * _hcStride + (vertexZ + _hcOZ)
    : -1;
  if (ci >= 0) {
    const cached = _hcData[ci];
    if (!isNaN(cached)) return cached;
  }

  // Restore a wider weighted corner neighborhood so coastlines do not collapse
  // back into per-cell squares when nearby columns diverge in height.
  let weightedTotal = 0;
  let weightTotal = 0;
  let minY = Number.POSITIVE_INFINITY, maxY = Number.NEGATIVE_INFINITY;
  for (let cx = vertexX - WATER_CORNER_SAMPLE_RADIUS; cx <= vertexX + WATER_CORNER_SAMPLE_RADIUS - 1; cx++) {
    for (let cz = vertexZ - WATER_CORNER_SAMPLE_RADIUS; cz <= vertexZ + WATER_CORNER_SAMPLE_RADIUS - 1; cz++) {
      const col = getFilledColumn(grid, cx, cz);
      if (!col || !isCompatibleWithStitchContext(grid, col, cx, cz, stitchContext)) continue;
      const sy = col.renderSurfaceY - grid.originY;
      const dx = cx + 0.5 - vertexX;
      const dz = cz + 0.5 - vertexZ;
      const distSq = dx * dx + dz * dz;
      let weight = 1 / (1 + distSq * 1.75);
      if (Math.abs(dx) <= 0.5 && Math.abs(dz) <= 0.5) {
        weight *= 1.6;
      }
      weightedTotal += sy * weight;
      weightTotal += weight;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
    }
  }
  let result: number;
  if (weightTotal <= 0) {
    result = fallbackY;
  } else {
    const baseY = weightedTotal / weightTotal;
    const variation = maxY > minY ? maxY - minY : 0;
    const noiseWeight = 1 - smoothstep(0.05, 0.22, variation);
    result = baseY + getStableHeightNoise(grid, vertexX, vertexZ) * noiseWeight * 0.65;
  }
  if (ci >= 0) _hcData[ci] = result;
  return result;
}

function createWaterSurfaceSpline(
  grid: WaterSectionGrid,
  lx: number,
  lz: number,
  fallbackY: number,
  topNE: WaterPoint,
  topNW: WaterPoint,
  topSW: WaterPoint,
  topSE: WaterPoint,
  stitchContext?: WaterPatchStitchContext,
): WaterSurfaceSpline {
  const heights: WaterSurfaceSpline["heights"] = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];

  for (let zOffset = 0; zOffset < 4; zOffset++) {
    for (let xOffset = 0; xOffset < 4; xOffset++) {
      heights[zOffset][xOffset] = sampleCornerLocalSurfaceY(
        grid,
        lx + xOffset - 1,
        lz + zOffset - 1,
        fallbackY,
        stitchContext,
      );
    }
  }

  heights[1][1] = topNW[1];
  heights[1][2] = topNE[1];
  heights[2][1] = topSW[1];
  heights[2][2] = topSE[1];

  return { heights };
}

function sampleCornerColumnAverage(
  grid: WaterSectionGrid,
  vertexX: number,
  vertexZ: number,
  fallbackValue: number,
  sample: (col: WaterColumnSample, lx: number, lz: number) => number,
  stitchContext?: WaterPatchStitchContext,
) {
  let total = 0;
  let count = 0;
  for (let cx = vertexX - 1; cx <= vertexX; cx++) {
    for (let cz = vertexZ - 1; cz <= vertexZ; cz++) {
      const col = getFilledColumn(grid, cx, cz);
      if (!col || !isCompatibleWithStitchContext(grid, col, cx, cz, stitchContext)) continue;
      total += sample(col, cx, cz);
      count++;
    }
  }
  return count ? total / count : fallbackValue;
}

function sampleInterpolatedSurfaceY(
  surfaceSpline: WaterSurfaceSpline,
  tx: number,
  tz: number,
) {
  const row0 = catmullRom(
    surfaceSpline.heights[0][0],
    surfaceSpline.heights[0][1],
    surfaceSpline.heights[0][2],
    surfaceSpline.heights[0][3],
    tx,
  );
  const row1 = catmullRom(
    surfaceSpline.heights[1][0],
    surfaceSpline.heights[1][1],
    surfaceSpline.heights[1][2],
    surfaceSpline.heights[1][3],
    tx,
  );
  const row2 = catmullRom(
    surfaceSpline.heights[2][0],
    surfaceSpline.heights[2][1],
    surfaceSpline.heights[2][2],
    surfaceSpline.heights[2][3],
    tx,
  );
  const row3 = catmullRom(
    surfaceSpline.heights[3][0],
    surfaceSpline.heights[3][1],
    surfaceSpline.heights[3][2],
    surfaceSpline.heights[3][3],
    tx,
  );
  return catmullRom(row0, row1, row2, row3, tz);
}

function sampleInterpolatedPoint(
  topNE: WaterPoint,
  topNW: WaterPoint,
  topSW: WaterPoint,
  topSE: WaterPoint,
  surfaceSpline: WaterSurfaceSpline,
  tx: number,
  tz: number,
): WaterPoint {

  const baseX = bilerp(topNW[0], topNE[0], topSW[0], topSE[0], tx, tz);
  const baseZ = bilerp(topNW[2], topNE[2], topSW[2], topSE[2], tx, tz);
  const y = sampleInterpolatedSurfaceY(surfaceSpline, tx, tz);

  // ROOT CAUSE FIX (continuous patch mesher): warp/jitter used local section
  // coordinates (0–8) in sin/cos/hash2D. Adjacent sections produce different
  // values for the same world vertex → geometric gap at boundaries.
  // GPU vertex shader handles all XZ deformation; CPU must output clean positions.
  return [baseX, y, baseZ];
}

function sampleInterpolatedVertexContext(
  contexts: [WaterVertexContext, WaterVertexContext, WaterVertexContext, WaterVertexContext],
  tx: number,
  tz: number,
): WaterVertexContext {
  const [ne, nw, sw, se] = contexts;
  return {
    fillFactor: bilerp(nw.fillFactor, ne.fillFactor, sw.fillFactor, se.fillFactor, tx, tz),
    shoreDistance: bilerp(
      nw.shoreDistance,
      ne.shoreDistance,
      sw.shoreDistance,
      se.shoreDistance,
      tx,
      tz,
    ),
    openEdgeFactor: bilerp(
      nw.openEdgeFactor,
      ne.openEdgeFactor,
      sw.openEdgeFactor,
      se.openEdgeFactor,
      tx,
      tz,
    ),
    interactionInfluence: bilerp(
      nw.interactionInfluence,
      ne.interactionInfluence,
      sw.interactionInfluence,
      se.interactionInfluence,
      tx,
      tz,
    ),
    surfaceWarp: bilerp(nw.surfaceWarp, ne.surfaceWarp, sw.surfaceWarp, se.surfaceWarp, tx, tz),
    flowX: bilerp(nw.flowX, ne.flowX, sw.flowX, se.flowX, tx, tz),
    flowZ: bilerp(nw.flowZ, ne.flowZ, sw.flowZ, se.flowZ, tx, tz),
    flowStrength: bilerp(nw.flowStrength, ne.flowStrength, sw.flowStrength, se.flowStrength, tx, tz),
    waterClassValue: bilerp(nw.waterClassValue, ne.waterClassValue, sw.waterClassValue, se.waterClassValue, tx, tz),
  };
}

function sampleInterpolatedNormal(
  surfaceSpline: WaterSurfaceSpline,
  tx: number,
  tz: number,
): WaterPoint {
  const sampleStep = 0.18;
  const leftX = Math.max(0, tx - sampleStep);
  const rightX = Math.min(1, tx + sampleStep);
  const northZ = Math.max(0, tz - sampleStep);
  const southZ = Math.min(1, tz + sampleStep);
  const leftY = sampleInterpolatedSurfaceY(surfaceSpline, leftX, tz);
  const rightY = sampleInterpolatedSurfaceY(surfaceSpline, rightX, tz);
  const northY = sampleInterpolatedSurfaceY(surfaceSpline, tx, northZ);
  const southY = sampleInterpolatedSurfaceY(surfaceSpline, tx, southZ);
  return normalizeWaterNormal(leftY - rightY, Math.max(0.12, (rightX - leftX) + (southZ - northZ)), northY - southY);
}

function getTopSurfaceDiagonalOverride(
  pNE: WaterPoint,
  pNW: WaterPoint,
  pSW: WaterPoint,
  pSE: WaterPoint,
  parityPrimaryDiagonal: boolean,
) {
  // Primary diagonal: NE-SW  (V0-V2)
  // Alternate diagonal: NW-SE (V1-V3)
  const primaryHeightError   = Math.abs(pNE[1] - pSW[1]);
  const alternateHeightError = Math.abs(pNW[1] - pSE[1]);

  // Gradient of each diagonal: slope across the diagonal edge.
  // The "gradient cost" of a diagonal is the slope it imposes on
  // both triangles that share it — we want the flatter shared edge.
  const primaryGradX   = pNE[0] - pSW[0]; const primaryGradZ   = pNE[2] - pSW[2];
  const alternateGradX = pNW[0] - pSE[0]; const alternateGradZ = pNW[2] - pSE[2];
  const primaryDiagLen   = Math.max(0.001, Math.sqrt(primaryGradX * primaryGradX   + primaryGradZ   * primaryGradZ));
  const alternateDiagLen = Math.max(0.001, Math.sqrt(alternateGradX * alternateGradX + alternateGradZ * alternateGradZ));
  const primarySlope   = primaryHeightError   / primaryDiagLen;
  const alternateSlope = alternateHeightError / alternateDiagLen;

  // Choose the diagonal whose shared edge has the smallest slope.
  // This places the crease where the surface is flattest, minimising
  // visible shading discontinuity.
  const slopeDiff = Math.abs(primarySlope - alternateSlope);
  if (slopeDiff > 0.005) {
    // Clear winner: use the flatter diagonal.
    return primarySlope <= alternateSlope;
  }

  // Nearly planar: fall back to parity to maintain stable triangulation.
  return parityPrimaryDiagonal;
}

function computeWaterCellSlope(
  topNE: WaterPoint,
  topNW: WaterPoint,
  topSW: WaterPoint,
  topSE: WaterPoint,
) {
  return Math.max(
    Math.abs(topNE[1] - topNW[1]),
    Math.abs(topSE[1] - topSW[1]),
    Math.abs(topNW[1] - topSW[1]),
    Math.abs(topNE[1] - topSE[1]),
    Math.abs(topNE[1] - topSW[1]) * 0.7,
    Math.abs(topNW[1] - topSE[1]) * 0.7,
  );
}

// Fused flow-direction corner sample: iterates the 4 surrounding cells once instead
// of twice (avoids calling getMesherDirectionForSample separately for X and Z).
function _sampleCornerFlowDir(
  grid: WaterSectionGrid,
  vertexX: number,
  vertexZ: number,
  fallbackX: number,
  fallbackZ: number,
  stitchContext?: WaterPatchStitchContext,
): [number, number] {
  let tx = 0, tz = 0, count = 0;
  for (let cx = vertexX - 1; cx <= vertexX; cx++) {
    for (let cz = vertexZ - 1; cz <= vertexZ; cz++) {
      const col = getFilledColumn(grid, cx, cz);
      if (!col || !isCompatibleWithStitchContext(grid, col, cx, cz, stitchContext)) continue;
      const [fx, fz] = getMesherDirectionForSample(grid, col, cx, cz, stitchContext);
      tx += fx; tz += fz; count++;
    }
  }
  return count ? [tx / count, tz / count] : [fallbackX, fallbackZ];
}

function createWaterVertexContext(
  grid: WaterSectionGrid,
  vertexX: number,
  vertexZ: number,
  fillFactor: number,
  shoreDistance: number,
  openEdgeFactor: number,
  flowX: number,
  flowZ: number,
  flowStrength: number,
  waterClassValue: number,
  stitchContext?: WaterPatchStitchContext,
): WaterVertexContext {
  // Phase 1a — return cached context if available (avoids ~7 sampleCornerColumnAverage
  // calls for corners shared between adjacent cells).
  const ci = _getCornerCtxCacheIndex(vertexX, vertexZ, stitchContext);
  if (ci >= 0 && _cornerCtxPool[ci] !== null) return _cornerCtxPool[ci]!;

  const shoreFallback = shoreDistance >= 0 ? shoreDistance : 8;
  const [sampledFlowX, sampledFlowZ] = _sampleCornerFlowDir(
    grid, vertexX, vertexZ, flowX, flowZ, stitchContext,
  );
  const ctx: WaterVertexContext = {
    fillFactor: sampleCornerColumnAverage(
      grid, vertexX, vertexZ, fillFactor,
      (col) => Math.max(0, Math.min(1, col.fill)), stitchContext,
    ),
    shoreDistance: sampleCornerColumnAverage(
      grid, vertexX, vertexZ, shoreFallback,
      (col) => (col.shoreDistance >= 0 ? col.shoreDistance : 8), stitchContext,
    ),
    openEdgeFactor: sampleCornerColumnAverage(
      grid, vertexX, vertexZ, openEdgeFactor,
      (_col, lx, lz) => computeOpenEdgeFactor(grid, lx, lz, stitchContext), stitchContext,
    ),
    interactionInfluence: sampleCornerColumnAverage(
      grid, vertexX, vertexZ, 0,
      (col) => col.renderState.edgeState.interactionInfluence, stitchContext,
    ),
    surfaceWarp: 0,
    flowX: sampledFlowX,
    flowZ: sampledFlowZ,
    flowStrength: sampleCornerColumnAverage(
      grid, vertexX, vertexZ, flowStrength,
      (col) => col.flowStrength, stitchContext,
    ),
    waterClassValue: sampleCornerColumnAverage(
      grid, vertexX, vertexZ, waterClassValue,
      (col, lx, lz) =>
        packWaterClassAndTurbidity(
          computeWaterClassValue(grid, col, lx, lz),
          col.renderState.turbidity,
        ),
      stitchContext,
    ),
  };
  if (ci >= 0) _cornerCtxPool[ci] = ctx;
  return ctx;
}

function getWaterNormalSlope(normal: WaterPoint) {
  return clamp01(1 - Math.abs(normal[1]));
}

function getColumnSeamBaseLocalY(
  grid: WaterSectionGrid,
  col: WaterColumnSample,
  fillFactor: number,
  shoreDist: number,
  openEdgeFactor: number,
) {
  const rawBaseY = col.localY;
  const surfaceLocalY = col.renderSurfaceY - grid.originY;
  const columnDepth = surfaceLocalY - rawBaseY;
  if (columnDepth <= WATER_SEAM_EPSILON) {
    return rawBaseY;
  }

  const unsupportedWeight = clamp01((3 - col.supportDepth) / 3);
  const shallowWeight = 1 - clamp01(fillFactor);
  const shorelineFactor = shoreDist >= 0 ? clamp01(1 - shoreDist / 3) : 0;
  const liftWeight = clamp01(
    unsupportedWeight * 0.42 +
      shallowWeight * 0.28 +
      shorelineFactor * 0.18 +
      clamp01(openEdgeFactor) * 0.12,
  );
  const minimumDepth = Math.max(
    0.08,
    Math.min(columnDepth, 0.16 + fillFactor * 0.22 + (1 - shorelineFactor) * 0.08),
  );
  const retainedDepth = Math.max(
    minimumDepth,
    columnDepth * (1 - liftWeight * 0.82),
  );

  return Math.max(rawBaseY, surfaceLocalY - retainedDepth);
}

function sampleCornerSeamBaseLocalY(
  grid: WaterSectionGrid,
  vertexX: number,
  vertexZ: number,
  fallbackBaseY: number,
  stitchContext?: WaterPatchStitchContext,
) {
  return sampleCornerColumnAverage(
    grid,
    vertexX,
    vertexZ,
    fallbackBaseY,
    (col, lx, lz) =>
      getColumnSeamBaseLocalY(
        grid,
        col,
        clamp01(col.fill),
        col.shoreDistance,
        computeOpenEdgeFactor(grid, lx, lz, stitchContext),
      ),
    stitchContext,
  );
}

function getCompressedSeamBottomY(
  topY: number,
  baseY: number,
  fillFactor: number,
  shoreDist: number,
  openEdgeFactor: number,
  edgeSlope: number,
) {
  const maxDepth = topY - baseY;
  if (maxDepth <= WATER_SEAM_EPSILON) {
    return topY;
  }

  const shorelineFactor = shoreDist >= 0 ? clamp01(1 - shoreDist / 2.5) : 0;
  const slopeFactor = clamp01(edgeSlope / 0.35);
  const shallowFactor = 1 - clamp01(fillFactor);
  const closedBoundaryFactor = 1 - clamp01(openEdgeFactor);
  const compression = clamp01(
    shorelineFactor * 0.5 +
      slopeFactor * 0.45 +
      shallowFactor * 0.3 +
      closedBoundaryFactor * 0.2,
  ) / 1.45;
  const compressedDepth = Math.min(
    maxDepth * (1 - compression * 0.72),
    0.2 + fillFactor * 0.28 + (1 - shorelineFactor) * 0.14,
  );

  return Math.max(baseY, topY - Math.max(0.08, compressedDepth));
}

function getSupportLayerLocalSurfaceY(
  grid: WaterSectionGrid,
  layer: WaterSupportLayer,
) {
  return layer.surfaceY - grid.originY;
}

function getSupportLayerBands(
  grid: WaterSectionGrid,
  col: WaterColumnSample,
  baseY: number,
) {
  const bands: number[] = [];
  for (const layer of col.supportLayers) {
    const layerY = getSupportLayerLocalSurfaceY(grid, layer);
    if (layerY <= baseY + WATER_SEAM_EPSILON) continue;
    if (bands.length > 0 && Math.abs(bands[bands.length - 1] - layerY) <= WATER_SEAM_EPSILON) {
      continue;
    }
    bands.push(layerY);
  }
  return bands;
}

function shouldUseLayeredSeams(
  grid: WaterSectionGrid,
  col: WaterColumnSample,
  supportBands: number[],
  fillFactor: number,
  openEdgeFactor: number,
  slope: number,
  baseY: number,
) {
  if (!supportBands.length) return false;
  if (col.supportDepth < 3) return false;
  if (fillFactor < MIN_LAYERED_SEAM_FILL) return false;
  if (slope < MIN_LAYERED_SEAM_SLOPE) return false;
  if (openEdgeFactor > MAX_LAYERED_SEAM_OPEN_EDGE) return false;

  const surfaceLocalY = col.renderSurfaceY - grid.originY;
  const topDepth = surfaceLocalY - baseY;
  if (topDepth < MIN_LAYERED_SEAM_DEPTH) return false;

  return true;
}

// ─── Seam Pipeline ───────────────────────────────────────────────────────────
// Separated into three layers:
//   1. Geometry builders  (buildXSeamSegments)  — pure geometry, no mesh writes
//   2. Interpolation      (interpolateWaterContext / createContextLerp)
//   3. Emission           (emitSeamSegments / emitSeamSegmentQuad)

type SeamSegment = {
  topA: WaterPoint;
  topB: WaterPoint;
  bottomA: WaterPoint;
  bottomB: WaterPoint;
  /** Normalized edge position of the A side for context interpolation [0,1] */
  t0: number;
  /** Normalized edge position of the B side for context interpolation [0,1] */
  t1: number;
};

function interpolateWaterContext(
  a: WaterVertexContext,
  b: WaterVertexContext,
  t: number,
): WaterVertexContext {
  return {
    fillFactor: lerp(a.fillFactor, b.fillFactor, t),
    shoreDistance: lerp(a.shoreDistance, b.shoreDistance, t),
    openEdgeFactor: lerp(a.openEdgeFactor, b.openEdgeFactor, t),
    interactionInfluence: lerp(a.interactionInfluence, b.interactionInfluence, t),
    surfaceWarp: lerp(a.surfaceWarp, b.surfaceWarp, t),
    flowX: lerp(a.flowX, b.flowX, t),
    flowZ: lerp(a.flowZ, b.flowZ, t),
    flowStrength: lerp(a.flowStrength, b.flowStrength, t),
    waterClassValue: lerp(a.waterClassValue, b.waterClassValue, t),
  };
}

function createContextLerp(a: WaterVertexContext, b: WaterVertexContext) {
  return {
    sample(t: number): WaterVertexContext {
      return interpolateWaterContext(a, b, t);
    },
  };
}

// ─── Geometry builders ───────────────────────────────────────────────────────

function buildAdaptiveSeamSegments(
  contextA: WaterVertexContext,
  contextB: WaterVertexContext,
  topPrev: WaterPoint,
  topA: WaterPoint,
  topB: WaterPoint,
  topNext: WaterPoint,
  basePrev: number,
  baseA: number,
  baseB: number,
  baseNext: number,
  edgeSlope: number,
  subdivisions: number,
): SeamSegment[] {
  if (subdivisions <= 0) return [];
  const segments: SeamSegment[] = [];
  const lerpCtx = createContextLerp(contextA, contextB);
  for (let i = 0; i < subdivisions; i++) {
    const t0 = i / subdivisions;
    const t1 = (i + 1) / subdivisions;
    const segTopA = sampleSeamCurvePoint(topPrev, topA, topB, topNext, t0);
    const segTopB = sampleSeamCurvePoint(topPrev, topA, topB, topNext, t1);
    const segBaseA = sampleSeamCurveValue(basePrev, baseA, baseB, baseNext, t0);
    const segBaseB = sampleSeamCurveValue(basePrev, baseA, baseB, baseNext, t1);
    const ctx0 = lerpCtx.sample(t0);
    const ctx1 = lerpCtx.sample(t1);
    const segBottomYA = getCompressedSeamBottomY(
      segTopA[1], segBaseA, ctx0.fillFactor, ctx0.shoreDistance, ctx0.openEdgeFactor, edgeSlope,
    );
    const segBottomYB = getCompressedSeamBottomY(
      segTopB[1], segBaseB, ctx1.fillFactor, ctx1.shoreDistance, ctx1.openEdgeFactor, edgeSlope,
    );
    const bottomA: WaterPoint = [segTopA[0], segBottomYA, segTopA[2]];
    const bottomB: WaterPoint = [segTopB[0], segBottomYB, segTopB[2]];
    if (!shouldEmitSeam(segTopA[1], segTopB[1], bottomA[1], bottomB[1])) continue;
    segments.push({ topA: segTopA, topB: segTopB, bottomA, bottomB, t0, t1 });
  }
  return segments;
}

function buildDropSeamSegments(
  contextA: WaterVertexContext,
  contextB: WaterVertexContext,
  topPrev: WaterPoint,
  topA: WaterPoint,
  topB: WaterPoint,
  topNext: WaterPoint,
  basePrev: number,
  baseA: number,
  baseB: number,
  baseNext: number,
  col: WaterColumnSample,
  subdivisions: number,
  outwardX: number,
  outwardZ: number,
  flowStrength: number,
): SeamSegment[] {
  if (subdivisions <= 0) return [];
  const segments: SeamSegment[] = [];
  const dropHeight = Math.max(
    col.renderState.edgeState.dropHeight,
    Math.max(topA[1] - baseA, topB[1] - baseB),
  );
  const segmentCount = Math.max(subdivisions, Math.min(6, Math.max(2, Math.ceil(dropHeight * 2))));
  const lipDepth = Math.min(0.22, 0.06 + dropHeight * 0.08);
  const lipFalloff = Math.min(0.08, dropHeight * 0.05);
  const curtainDrift = lipDepth * 0.55 + clamp01(flowStrength) * 0.04;

  // Lip geometry (pushed outward + lowered)
  const lipTopA: WaterPoint = [topA[0] + outwardX * lipDepth, topA[1] - lipFalloff, topA[2] + outwardZ * lipDepth];
  const lipTopB: WaterPoint = [topB[0] + outwardX * lipDepth, topB[1] - lipFalloff, topB[2] + outwardZ * lipDepth];
  const lipPrev: WaterPoint = [topPrev[0] + outwardX * lipDepth, topPrev[1] - lipFalloff, topPrev[2] + outwardZ * lipDepth];
  const lipNext: WaterPoint = [topNext[0] + outwardX * lipDepth, topNext[1] - lipFalloff, topNext[2] + outwardZ * lipDepth];
  const lipSegments = Math.max(2, Math.min(4, Math.ceil(dropHeight * 2)));

  // Lip segments: top = original edge curve, bottom = lip curve; context interpolated at t0/t1
  for (let i = 0; i < lipSegments; i++) {
    const t0 = i / lipSegments;
    const t1 = (i + 1) / lipSegments;
    const segTopA = sampleSeamCurvePoint(topPrev, topA, topB, topNext, t0);
    const segTopB = sampleSeamCurvePoint(topPrev, topA, topB, topNext, t1);
    const segLipA = sampleSeamCurvePoint(lipPrev, lipTopA, lipTopB, lipNext, t0);
    const segLipB = sampleSeamCurvePoint(lipPrev, lipTopA, lipTopB, lipNext, t1);
    if (!shouldEmitSeam(segTopA[1], segTopB[1], segLipA[1], segLipB[1])) continue;
    segments.push({ topA: segTopA, topB: segTopB, bottomA: segLipA, bottomB: segLipB, t0, t1 });
  }

  // Curtain segments: top = lip curve, bottom = landing point.
  // t0=0, t1=1 so emitSeamSegments always uses full contextA/contextB per curtain side.
  for (let i = 0; i < segmentCount; i++) {
    const tSeg0 = i / segmentCount;
    const tSeg1 = (i + 1) / segmentCount;
    const segTopA = sampleSeamCurvePoint(lipPrev, lipTopA, lipTopB, lipNext, tSeg0);
    const segTopB = sampleSeamCurvePoint(lipPrev, lipTopA, lipTopB, lipNext, tSeg1);
    const seamBaseA = sampleSeamCurveValue(basePrev, baseA, baseB, baseNext, tSeg0);
    const seamBaseB = sampleSeamCurveValue(basePrev, baseA, baseB, baseNext, tSeg1);
    const landingYA = Math.min(seamBaseA, segTopA[1] - dropHeight);
    const landingYB = Math.min(seamBaseB, segTopB[1] - dropHeight);
    const landingDriftA = curtainDrift * (0.5 + tSeg0 * 0.5);
    const landingDriftB = curtainDrift * (0.5 + tSeg1 * 0.5);
    const bottomA: WaterPoint = [segTopA[0] + outwardX * landingDriftA, landingYA, segTopA[2] + outwardZ * landingDriftA];
    const bottomB: WaterPoint = [segTopB[0] + outwardX * landingDriftB, landingYB, segTopB[2] + outwardZ * landingDriftB];
    if (!shouldEmitSeam(segTopA[1], segTopB[1], bottomA[1], bottomB[1])) continue;
    segments.push({ topA: segTopA, topB: segTopB, bottomA, bottomB, t0: 0, t1: 1 });
  }

  return segments;
}

function buildLayeredSeamSegments(
  contextA: WaterVertexContext,
  contextB: WaterVertexContext,
  topPrev: WaterPoint,
  topA: WaterPoint,
  topB: WaterPoint,
  topNext: WaterPoint,
  basePrev: number,
  baseA: number,
  baseB: number,
  baseNext: number,
  edgeSlope: number,
  subdivisions: number,
  supportBands: number[],
): SeamSegment[] {
  if (subdivisions <= 0) return [];
  const segments: SeamSegment[] = [];
  let currentTopA = topA;
  let currentTopB = topB;

  for (const bandY of supportBands) {
    const nextTopA: WaterPoint = [currentTopA[0], Math.min(currentTopA[1], bandY), currentTopA[2]];
    const nextTopB: WaterPoint = [currentTopB[0], Math.min(currentTopB[1], bandY), currentTopB[2]];
    if (
      Math.abs(currentTopA[1] - nextTopA[1]) <= WATER_SEAM_EPSILON &&
      Math.abs(currentTopB[1] - nextTopB[1]) <= WATER_SEAM_EPSILON
    ) {
      currentTopA = nextTopA;
      currentTopB = nextTopB;
      continue;
    }
    segments.push(...buildAdaptiveSeamSegments(
      contextA, contextB,
      topPrev, currentTopA, currentTopB, topNext,
      basePrev, bandY, bandY, baseNext,
      edgeSlope, subdivisions,
    ));
    currentTopA = nextTopA;
    currentTopB = nextTopB;
  }

  segments.push(...buildAdaptiveSeamSegments(
    contextA, contextB,
    topPrev, currentTopA, currentTopB, topNext,
    basePrev, baseA, baseB, baseNext,
    edgeSlope, subdivisions,
  ));

  return segments;
}

// ─── Emission ────────────────────────────────────────────────────────────────

/**
 * Emit a single seam quad. ctxA/ctxB are already-interpolated vertex contexts
 * for the A and B sides of the segment.
 */
function emitSeamSegmentQuad(
  mesh: any,
  waterTexture: number,
  heightNorm: number,
  flowX: number,
  flowZ: number,
  flowStrength: number,
  waterClassValue: number,
  segment: SeamSegment,
  ctxA: WaterVertexContext,
  ctxB: WaterVertexContext,
  vertexPayload: WaterSurfaceVertexPayload,
) {
  emitWaterQuad(
    mesh,
    waterTexture,
    heightNorm,
    flowX,
    flowZ,
    flowStrength,
    waterClassValue,
    [ctxA, ctxB, ctxB, ctxA],
    segment.topA,
    segment.topB,
    segment.bottomB,
    segment.bottomA,
    -1,
    vertexPayload,
  );
}

/**
 * Iterate over a SeamSegment array, interpolate contextA/contextB at each
 * segment's t0/t1, apply openEdgeFactorCap, and emit each quad.
 */
function emitSeamSegments(
  mesh: any,
  waterTexture: number,
  heightNorm: number,
  flowX: number,
  flowZ: number,
  flowStrength: number,
  waterClassValue: number,
  segments: SeamSegment[],
  contextA: WaterVertexContext,
  contextB: WaterVertexContext,
  vertexPayload: WaterSurfaceVertexPayload,
  openEdgeFactorCap = 0.2,
) {
  const lerpCtx = createContextLerp(contextA, contextB);
  for (const seg of segments) {
    const ctxA = lerpCtx.sample(seg.t0);
    const ctxB = lerpCtx.sample(seg.t1);
    const ctxAClamped: WaterVertexContext = {
      ...ctxA,
      openEdgeFactor: Math.min(ctxA.openEdgeFactor, openEdgeFactorCap),
    };
    const ctxBClamped: WaterVertexContext = {
      ...ctxB,
      openEdgeFactor: Math.min(ctxB.openEdgeFactor, openEdgeFactorCap),
    };
    emitSeamSegmentQuad(
      mesh, waterTexture, heightNorm, flowX, flowZ, flowStrength, waterClassValue,
      seg, ctxAClamped, ctxBClamped, vertexPayload,
    );
  }
}

// ─── Backward-compatible wrappers (used by ContinuousPatchMesherPrimitives) ──

function shouldEmitSeam(topA: number, topB: number, bottomA: number, bottomB: number) {
  return (
    Math.abs(topA - bottomA) > WATER_SEAM_EPSILON ||
    Math.abs(topB - bottomB) > WATER_SEAM_EPSILON
  );
}

function emitAdaptiveWaterEdgeSeam(
  mesh: any,
  waterTexture: number,
  heightNorm: number,
  flowX: number,
  flowZ: number,
  flowStrength: number,
  waterClassValue: number,
  contextA: WaterVertexContext,
  contextB: WaterVertexContext,
  topPrev: WaterPoint,
  topA: WaterPoint,
  topB: WaterPoint,
  topNext: WaterPoint,
  basePrev: number,
  baseA: number,
  baseB: number,
  baseNext: number,
  edgeSlope: number,
  subdivisions: number,
  vertexPayload: WaterSurfaceVertexPayload,
) {
  const segments = buildAdaptiveSeamSegments(
    contextA, contextB, topPrev, topA, topB, topNext,
    basePrev, baseA, baseB, baseNext, edgeSlope, subdivisions,
  );
  emitSeamSegments(
    mesh, waterTexture, heightNorm, flowX, flowZ, flowStrength, waterClassValue,
    segments, contextA, contextB, vertexPayload, 0.2,
  );
}

function emitDropEdgeWaterSeam(
  mesh: any,
  waterTexture: number,
  heightNorm: number,
  flowX: number,
  flowZ: number,
  flowStrength: number,
  waterClassValue: number,
  contextA: WaterVertexContext,
  contextB: WaterVertexContext,
  topPrev: WaterPoint,
  topA: WaterPoint,
  topB: WaterPoint,
  topNext: WaterPoint,
  basePrev: number,
  baseA: number,
  baseB: number,
  baseNext: number,
  col: WaterColumnSample,
  subdivisions: number,
  outwardX: number,
  outwardZ: number,
  vertexPayload: WaterSurfaceVertexPayload,
) {
  const segments = buildDropSeamSegments(
    contextA, contextB, topPrev, topA, topB, topNext,
    basePrev, baseA, baseB, baseNext,
    col, subdivisions, outwardX, outwardZ, flowStrength,
  );
  emitSeamSegments(
    mesh, waterTexture, heightNorm, flowX, flowZ, flowStrength, waterClassValue,
    segments, contextA, contextB, vertexPayload, 0.18,
  );
}

function emitLayeredWaterEdgeSeam(
  mesh: any,
  waterTexture: number,
  heightNorm: number,
  flowX: number,
  flowZ: number,
  flowStrength: number,
  waterClassValue: number,
  contextA: WaterVertexContext,
  contextB: WaterVertexContext,
  topPrev: WaterPoint,
  topA: WaterPoint,
  topB: WaterPoint,
  topNext: WaterPoint,
  basePrev: number,
  baseA: number,
  baseB: number,
  baseNext: number,
  edgeSlope: number,
  subdivisions: number,
  supportBands: number[],
  vertexPayload: WaterSurfaceVertexPayload,
) {
  const segments = buildLayeredSeamSegments(
    contextA, contextB, topPrev, topA, topB, topNext,
    basePrev, baseA, baseB, baseNext,
    edgeSlope, subdivisions, supportBands,
  );
  emitSeamSegments(
    mesh, waterTexture, heightNorm, flowX, flowZ, flowStrength, waterClassValue,
    segments, contextA, contextB, vertexPayload, 0.2,
  );
}

// Phase 2a \u2014 Unified seam mode: replaces DROP / LAYERED / ADAPTIVE branching.
// Uses continuous factor blending \u2014 no hard switch, parameters drive behavior.
//
// resolveSeamMode returns DROP for waterfall edges, UNIFIED for all others.
const SEAM_MODE_DROP    = 0 as const;
const SEAM_MODE_UNIFIED = 3 as const;
type SeamMode = 0 | 3;

type UnifiedSeamParams = {
  /** 0 = no drop behaviour, 1 = full waterfall lip + curtain. */
  dropFactor: number;
  /** 0 = flat seam, 1 = deep layered shore seam. */
  layerFactor: number;
  /** 0 = flat surface, 1 = steep edge. */
  slopeFactor: number;
};

function resolveUnifiedSeamParams(
  grid: WaterSectionGrid,
  col: WaterColumnSample,
  supportBands: number[],
  fillFactor: number,
  openEdgeFactor: number,
  slope: number,
  baseY: number,
): UnifiedSeamParams {
  const edgeState = col.renderState.edgeState;
  const dropFactor = clamp01(edgeState.dropHeight / 2.5);
  const surfaceLocalY = col.renderSurfaceY - grid.originY;
  const topDepth = surfaceLocalY - baseY;
  const canUseLayeredSeams = shouldUseLayeredSeams(
    grid,
    col,
    supportBands,
    fillFactor,
    openEdgeFactor,
    slope,
    baseY,
  );
  const layerFactor = canUseLayeredSeams
    ? clamp01(
        smoothstep(MIN_LAYERED_SEAM_FILL, 1, fillFactor) *
        smoothstep(MIN_LAYERED_SEAM_SLOPE, 0.4, slope) *
        smoothstep(MIN_LAYERED_SEAM_DEPTH, 1.5, topDepth),
      )
    : 0;
  const slopeFactor = clamp01(slope / 0.25);
  return { dropFactor, layerFactor, slopeFactor };
}

function emitUnifiedWaterSeam(
  mesh: any,
  waterTexture: number,
  heightNorm: number,
  flowX: number,
  flowZ: number,
  flowStrength: number,
  waterClassValue: number,
  ctxA: WaterVertexContext,
  ctxB: WaterVertexContext,
  topPrev: WaterPoint,
  topA: WaterPoint,
  topB: WaterPoint,
  topNext: WaterPoint,
  basePrev: number,
  baseA: number,
  baseB: number,
  baseNext: number,
  slope: number,
  subdivisions: number,
  supportBands: number[],
  vertexPayload: WaterSurfaceVertexPayload,
  params: UnifiedSeamParams,
) {
  // Blend base depths continuously using drop/layer factors \u2014 no branching.
  const dropLift = params.dropFactor *
    Math.min(0.4, (topA[1] - baseA + topB[1] - baseB) * 0.25);
  const blendedBasePrev  = basePrev  + dropLift;
  const blendedBaseA     = baseA     + dropLift;
  const blendedBaseB     = baseB     + dropLift;
  const blendedBaseNext  = baseNext  + dropLift;
  const blendedSlope = slope * (1 + params.slopeFactor * 0.25 + params.layerFactor * 0.15);
  // Drop seams get a tighter open-edge cap to maintain the curtain silhouette.
  const openEdgeCap = params.dropFactor > 0.3 ? 0.18 : 0.2;
  // Phase 5 — CPU seam geometry is disabled when USE_GPU_WATER = true.
  // When GPU is active, edge depth is encoded in CUSTOM_VERTEX_UPDATE_POSITION of
  // DVEWaterMaterialPlugin instead of explicit seam face geometry.
  // buildAdaptiveSeamSegments is inside the gate to avoid unnecessary allocation.
  if (!USE_GPU_WATER) {
    const segments = params.layerFactor > 0
      ? buildLayeredSeamSegments(
          ctxA, ctxB,
          topPrev, topA, topB, topNext,
          blendedBasePrev, blendedBaseA, blendedBaseB, blendedBaseNext,
          blendedSlope, subdivisions, supportBands,
        )
      : buildAdaptiveSeamSegments(
          ctxA, ctxB,
          topPrev, topA, topB, topNext,
          blendedBasePrev, blendedBaseA, blendedBaseB, blendedBaseNext,
          blendedSlope, subdivisions,
        );
    emitSeamSegments(
      mesh, waterTexture, heightNorm, flowX, flowZ, flowStrength, waterClassValue,
      segments, ctxA, ctxB, vertexPayload, openEdgeCap,
    );
  }
}

/** Resolves seam mode.
 * Drop-edge cells get SEAM_MODE_DROP (waterfall curtain geometry, not gated by
 * USE_GPU_WATER). All other cells return UNIFIED which is gated out when
 * USE_GPU_WATER = true (GPU vertex shader drives edge displacement instead).
 */
function resolveSeamMode(col: WaterColumnSample): SeamMode {
  const edgeState = col.renderState.edgeState;
  if (edgeState.edgeType === "drop" || edgeState.dropHeight > 0.7) {
    return SEAM_MODE_DROP;
  }
  return SEAM_MODE_UNIFIED;
}

// Module-level scratch: avoids per-cell heap allocation in the 4-direction loop.
// _seamFlat layout: corner i → offsets [i*3, i*3+1, i*3+2]  (NE=0, NW=1, SW=2, SE=3)
// Safe: build* functions only READ WaterPoint inputs; they never store input refs.
const _seamFlat     = new Float64Array(12);
const _seamBaseFlat = new Float64Array(4);
const _sPrev: WaterPoint = [0, 0, 0];
const _sA:    WaterPoint = [0, 0, 0];
const _sB:    WaterPoint = [0, 0, 0];
const _sNext: WaterPoint = [0, 0, 0];

// Per-direction seam dispatch table.
// Corner indices: NE=0, NW=1, SW=2, SE=3 (matches _seamFlat / _seamBaseFlat layout).
// Columns: [dx, dz, ctxAi, ctxBi, iPrev, iA, iB, iNext, outX, outZ]
const SEAM_DIRECTIONS = [
  [ 1,  0,  0, 3,  1, 0, 3, 2,  1,  0],  // +X face (east)
  [-1,  0,  1, 2,  0, 1, 2, 3, -1,  0],  // -X face (west)
  [ 0, -1,  0, 1,  3, 0, 1, 2,  0, -1],  // -Z face (north)
  [ 0,  1,  2, 3,  1, 2, 3, 0,  0,  1],  // +Z face (south)
] as const;

function emitWaterSeamByMode(
  mesh: any,
  grid: WaterSectionGrid,
  waterTexture: number,
  heightNorm: number,
  flowX: number,
  flowZ: number,
  flowStrength: number,
  waterClassValue: number,
  ctxA: WaterVertexContext,
  ctxB: WaterVertexContext,
  topPrev: WaterPoint,
  topA: WaterPoint,
  topB: WaterPoint,
  topNext: WaterPoint,
  basePrev: number,
  baseA: number,
  baseB: number,
  baseNext: number,
  col: WaterColumnSample,
  slope: number,
  subdivisions: number,
  supportBands: number[],
  vertexPayload: WaterSurfaceVertexPayload,
  outX: number,
  outZ: number,
  mode: SeamMode,
) {
  switch (mode) {
    case SEAM_MODE_UNIFIED: {
      const baseY = Math.min(baseA, baseB, basePrev, baseNext);
      const fillFactor = Math.max(ctxA.fillFactor, ctxB.fillFactor);
      const openEdgeFactor = Math.max(ctxA.openEdgeFactor, ctxB.openEdgeFactor);
      const params = resolveUnifiedSeamParams(
        grid,
        col,
        supportBands,
        fillFactor,
        openEdgeFactor,
        slope,
        baseY,
      );
      emitUnifiedWaterSeam(
        mesh, waterTexture, heightNorm, flowX, flowZ, flowStrength, waterClassValue,
        ctxA, ctxB,
        topPrev, topA, topB, topNext,
        basePrev, baseA, baseB, baseNext,
        slope, subdivisions, supportBands, vertexPayload, params,
      );
      return;
    }
    case SEAM_MODE_DROP:
      emitDropEdgeWaterSeam(
        mesh, waterTexture, heightNorm, flowX, flowZ, flowStrength, waterClassValue,
        ctxA, ctxB,
        topPrev, topA, topB, topNext,
        basePrev, baseA, baseB, baseNext,
        col, subdivisions, outX, outZ, vertexPayload,
      );
      return;
  }
}

function emitVisibleWaterSeams(
  mesh: any,
  grid: WaterSectionGrid,
  waterTexture: number,
  col: WaterColumnSample,
  lx: number,
  lz: number,
  fillFactor: number,
  heightNorm: number,
  shoreDist: number,
  openEdgeFactor: number,
  flowX: number,
  flowZ: number,
  flowStrength: number,
  waterClassValue: number,
  vertexPayload: WaterSurfaceVertexPayload,
  slope: number,
  subdivisions: number,
  topContexts: [WaterVertexContext, WaterVertexContext, WaterVertexContext, WaterVertexContext],
  topNE: [number, number, number],
  topNW: [number, number, number],
  topSW: [number, number, number],
  topSE: [number, number, number],
  stitchContext?: WaterPatchStitchContext,
) {
  const baseY = getColumnSeamBaseLocalY(
    grid,
    col,
    fillFactor,
    shoreDist,
    openEdgeFactor,
  );
  const seamBaseNE = sampleCornerSeamBaseLocalY(grid, lx + 1, lz, baseY, stitchContext);
  const seamBaseNW = sampleCornerSeamBaseLocalY(grid, lx, lz, baseY, stitchContext);
  const seamBaseSW = sampleCornerSeamBaseLocalY(grid, lx, lz + 1, baseY, stitchContext);
  const seamBaseSE = sampleCornerSeamBaseLocalY(grid, lx + 1, lz + 1, baseY, stitchContext);
  const supportBands = getSupportLayerBands(grid, col, baseY);
  // B: precompute once — no per-direction re-evaluation
  const seamMode = resolveSeamMode(col);

  // C: fill contiguous flat buffers (cache-friendly, SIMD/WASM-ready)
  // Corner order: NE=0, NW=1, SW=2, SE=3 → flat offset = i * 3
  _seamFlat[ 0] = topNE[0]; _seamFlat[ 1] = topNE[1]; _seamFlat[ 2] = topNE[2];
  _seamFlat[ 3] = topNW[0]; _seamFlat[ 4] = topNW[1]; _seamFlat[ 5] = topNW[2];
  _seamFlat[ 6] = topSW[0]; _seamFlat[ 7] = topSW[1]; _seamFlat[ 8] = topSW[2];
  _seamFlat[ 9] = topSE[0]; _seamFlat[10] = topSE[1]; _seamFlat[11] = topSE[2];
  _seamBaseFlat[0] = seamBaseNE; _seamBaseFlat[1] = seamBaseNW;
  _seamBaseFlat[2] = seamBaseSW; _seamBaseFlat[3] = seamBaseSE;

  for (const [dx, dz, ctxAi, ctxBi, iPrev, iA, iB, iNext, outX, outZ] of SEAM_DIRECTIONS) {
    if (!getFilledColumn(grid, lx + dx, lz + dz)) {
      // A: populate scratch WaterPoints from flat buffer (no allocation)
      const p = iPrev * 3, a = iA * 3, b = iB * 3, n = iNext * 3;
      _sPrev[0] = _seamFlat[p];   _sPrev[1] = _seamFlat[p+1]; _sPrev[2] = _seamFlat[p+2];
      _sA[0]    = _seamFlat[a];   _sA[1]    = _seamFlat[a+1]; _sA[2]    = _seamFlat[a+2];
      _sB[0]    = _seamFlat[b];   _sB[1]    = _seamFlat[b+1]; _sB[2]    = _seamFlat[b+2];
      _sNext[0] = _seamFlat[n];   _sNext[1] = _seamFlat[n+1]; _sNext[2] = _seamFlat[n+2];
      emitWaterSeamByMode(
        mesh, grid, waterTexture, heightNorm, flowX, flowZ, flowStrength, waterClassValue,
        topContexts[ctxAi], topContexts[ctxBi],
        _sPrev, _sA, _sB, _sNext,
        _seamBaseFlat[iPrev], _seamBaseFlat[iA], _seamBaseFlat[iB], _seamBaseFlat[iNext],
        col, slope, subdivisions, supportBands, vertexPayload,
        outX, outZ, seamMode,
      );
    }
  }
}

function emitAdaptiveWaterSurface(
  mesh: any,
  waterTexture: number,
  cellX: number,
  cellZ: number,
  heightNorm: number,
  flowX: number,
  flowZ: number,
  flowStrength: number,
  waterClassValue: number,
  worldSurfaceY: number,
  topNE: WaterPoint,
  topNW: WaterPoint,
  topSW: WaterPoint,
  topSE: WaterPoint,
  surfaceSpline: WaterSurfaceSpline,
  vertexContexts: [WaterVertexContext, WaterVertexContext, WaterVertexContext, WaterVertexContext],
  subdivisions: number,
  _surfaceWarp: number,
  cornerPayloads: [WaterSurfaceVertexPayload, WaterSurfaceVertexPayload, WaterSurfaceVertexPayload, WaterSurfaceVertexPayload],
) {
  if (subdivisions <= 0) return;
  const surfaceSubdivisions = Math.max(subdivisions, 3);
  // CPU generates a clean, uniform Catmull-Rom "bed" — NO warp or jitter.
  // All visual deformation (waves, flow displacement) is handled by the GPU vertex shader
  // using the flow data already written into vertex attributes (metadata offset 22-25).

  // cornerPayloads order: [NE, NW, SW, SE] matching vertexContexts convention.
  const [payloadNE, payloadNW, payloadSW, payloadSE] = cornerPayloads;
  const stride = surfaceSubdivisions + 1;
  const invSubdivisions = 1 / surfaceSubdivisions;
  const latticeCount = stride * stride;
  _ensureWaterSurfaceLatticeCapacity(latticeCount);

  for (let z = 0; z <= surfaceSubdivisions; z++) {
    const tz = z * invSubdivisions;
    const rowOffset = z * stride;
    for (let x = 0; x <= surfaceSubdivisions; x++) {
      const tx = x * invSubdivisions;
      const index = rowOffset + x;
      _fillSubPoint(topNE, topNW, topSW, topSE, surfaceSpline, tx, tz, _surfaceLatticePoints[index]);
      _fillInterpolatedVertexContext(vertexContexts, tx, tz, _surfaceLatticeContexts[index]);
      _fillInterpolatedNormal(surfaceSpline, tx, tz, _surfaceLatticeNormals[index]);
    }
  }

  for (let zStep = 0; zStep < surfaceSubdivisions; zStep++) {
    const z0 = zStep * invSubdivisions;
    const z1 = (zStep + 1) * invSubdivisions;
    const northRow = zStep * stride;
    const southRow = northRow + stride;
    for (let xStep = 0; xStep < surfaceSubdivisions; xStep++) {
      const parityPrimaryDiagonal = ((cellX + xStep) + (cellZ + zStep)) % 2 === 0;
      const x0 = xStep * invSubdivisions;
      const x1 = (xStep + 1) * invSubdivisions;
      const nwIndex = northRow + xStep;
      const neIndex = nwIndex + 1;
      const swIndex = southRow + xStep;
      const seIndex = swIndex + 1;

      _pScratch[0] = _surfaceLatticePoints[neIndex];
      _pScratch[1] = _surfaceLatticePoints[nwIndex];
      _pScratch[2] = _surfaceLatticePoints[swIndex];
      _pScratch[3] = _surfaceLatticePoints[seIndex];
      _quadCtxScratch[0] = _surfaceLatticeContexts[neIndex];
      _quadCtxScratch[1] = _surfaceLatticeContexts[nwIndex];
      _quadCtxScratch[2] = _surfaceLatticeContexts[swIndex];
      _quadCtxScratch[3] = _surfaceLatticeContexts[seIndex];
      _quadNormalScratch[0] = _surfaceLatticeNormals[neIndex];
      _quadNormalScratch[1] = _surfaceLatticeNormals[nwIndex];
      _quadNormalScratch[2] = _surfaceLatticeNormals[swIndex];
      _quadNormalScratch[3] = _surfaceLatticeNormals[seIndex];
      const diagonalOverride = getTopSurfaceDiagonalOverride(
        _pScratch[0],
        _pScratch[1],
        _pScratch[2],
        _pScratch[3],
        parityPrimaryDiagonal,
      );

      // Bilerp payload at sub-quad center into scratch.
      const pcx = (x0 + x1) * 0.5;
      const pcz = (z0 + z1) * 0.5;
      _subPayloadScratch.dropHeight = bilerp(payloadNW.dropHeight, payloadNE.dropHeight, payloadSW.dropHeight, payloadSE.dropHeight, pcx, pcz);
      _subPayloadScratch.foamCrest  = bilerp(payloadNW.foamCrest,  payloadNE.foamCrest,  payloadSW.foamCrest,  payloadSE.foamCrest,  pcx, pcz);
      _subPayloadScratch.foamEdge   = bilerp(payloadNW.foamEdge,   payloadNE.foamEdge,   payloadSW.foamEdge,   payloadSE.foamEdge,   pcx, pcz);
      _subPayloadScratch.foamImpact = bilerp(payloadNW.foamImpact, payloadNE.foamImpact, payloadSW.foamImpact, payloadSE.foamImpact, pcx, pcz);

      emitWaterQuad(
        mesh,
        waterTexture,
        heightNorm,
        flowX,
        flowZ,
        flowStrength,
        waterClassValue,
        _quadCtxScratch,
        _pScratch[0],
        _pScratch[1],
        _pScratch[2],
        _pScratch[3],
        worldSurfaceY,
        _subPayloadScratch,
        _quadNormalScratch,
        diagonalOverride,
      );
    }
  }
}

function normalizeWaterNormal(nx: number, ny: number, nz: number): WaterPoint {
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (length > 0.0001) {
    return [nx / length, ny / length, nz / length];
  }
  return [0, 1, 0];
}

// Scratch objects for emitAdaptiveWaterSurface — reused every sub-quad to eliminate GC pressure.
const _qCtx0: WaterVertexContext = { fillFactor:0, shoreDistance:0, openEdgeFactor:0, interactionInfluence:0, surfaceWarp:0, flowX:0, flowZ:0, flowStrength:0, waterClassValue:0 };
const _qCtx1: WaterVertexContext = { fillFactor:0, shoreDistance:0, openEdgeFactor:0, interactionInfluence:0, surfaceWarp:0, flowX:0, flowZ:0, flowStrength:0, waterClassValue:0 };
const _qCtx2: WaterVertexContext = { fillFactor:0, shoreDistance:0, openEdgeFactor:0, interactionInfluence:0, surfaceWarp:0, flowX:0, flowZ:0, flowStrength:0, waterClassValue:0 };
const _qCtx3: WaterVertexContext = { fillFactor:0, shoreDistance:0, openEdgeFactor:0, interactionInfluence:0, surfaceWarp:0, flowX:0, flowZ:0, flowStrength:0, waterClassValue:0 };
const _quadCtxScratch: [WaterVertexContext, WaterVertexContext, WaterVertexContext, WaterVertexContext] = [_qCtx0, _qCtx1, _qCtx2, _qCtx3];
const _qNrm0: WaterPoint = [0, 1, 0];
const _qNrm1: WaterPoint = [0, 1, 0];
const _qNrm2: WaterPoint = [0, 1, 0];
const _qNrm3: WaterPoint = [0, 1, 0];
const _quadNormalScratch: [WaterPoint, WaterPoint, WaterPoint, WaterPoint] = [_qNrm0, _qNrm1, _qNrm2, _qNrm3];
const _subPayloadScratch: WaterSurfaceVertexPayload = { dropHeight: 0, foamCrest: 0, foamEdge: 0, foamImpact: 0 };
const _pScratch: [WaterPoint, WaterPoint, WaterPoint, WaterPoint] = [[0,0,0],[0,0,0],[0,0,0],[0,0,0]];
let _surfaceLatticePoints: WaterPoint[] = [];
let _surfaceLatticeContexts: WaterVertexContext[] = [];
let _surfaceLatticeNormals: WaterPoint[] = [];

function _ensureWaterSurfaceLatticeCapacity(nodeCount: number) {
  while (_surfaceLatticePoints.length < nodeCount) {
    _surfaceLatticePoints.push([0, 0, 0]);
    _surfaceLatticeNormals.push([0, 1, 0]);
    _surfaceLatticeContexts.push({
      fillFactor: 0,
      shoreDistance: 0,
      openEdgeFactor: 0,
      interactionInfluence: 0,
      surfaceWarp: 0,
      flowX: 0,
      flowZ: 0,
      flowStrength: 0,
      waterClassValue: 0,
    });
  }
}

// Write-into versions of interpolation helpers — zero heap allocation per call.
function _fillInterpolatedVertexContext(
  contexts: [WaterVertexContext, WaterVertexContext, WaterVertexContext, WaterVertexContext],
  tx: number, tz: number,
  out: WaterVertexContext,
): void {
  const [ne, nw, sw, se] = contexts;
  out.fillFactor           = bilerp(nw.fillFactor,           ne.fillFactor,           sw.fillFactor,           se.fillFactor,           tx, tz);
  out.shoreDistance        = bilerp(nw.shoreDistance,        ne.shoreDistance,        sw.shoreDistance,        se.shoreDistance,        tx, tz);
  out.openEdgeFactor       = bilerp(nw.openEdgeFactor,       ne.openEdgeFactor,       sw.openEdgeFactor,       se.openEdgeFactor,       tx, tz);
  out.interactionInfluence = bilerp(nw.interactionInfluence, ne.interactionInfluence, sw.interactionInfluence, se.interactionInfluence, tx, tz);
  out.surfaceWarp          = bilerp(nw.surfaceWarp,          ne.surfaceWarp,          sw.surfaceWarp,          se.surfaceWarp,          tx, tz);
  out.flowX                = bilerp(nw.flowX,                ne.flowX,                sw.flowX,                se.flowX,                tx, tz);
  out.flowZ                = bilerp(nw.flowZ,                ne.flowZ,                sw.flowZ,                se.flowZ,                tx, tz);
  out.flowStrength         = bilerp(nw.flowStrength,         ne.flowStrength,         sw.flowStrength,         se.flowStrength,         tx, tz);
  out.waterClassValue      = bilerp(nw.waterClassValue,      ne.waterClassValue,      sw.waterClassValue,      se.waterClassValue,      tx, tz);
}

function _fillInterpolatedNormal(
  surfaceSpline: WaterSurfaceSpline,
  tx: number, tz: number,
  out: WaterPoint,
): void {
  // Use unclamped tx/tz so that border nodes (tx=0, tx=1, tz=0, tz=1) get
  // bilateral finite differences via the Catmull-Rom ghost control points
  // (heights[0] and heights[3]).  Clamping made border normals half-sided,
  // causing a gradient discontinuity at every cell boundary that showed up
  // as a visible crease at the shared edge vertex between adjacent cells.
  const sampleStep = 0.18;
  const leftX  = tx - sampleStep;
  const rightX = tx + sampleStep;
  const northZ = tz - sampleStep;
  const southZ = tz + sampleStep;
  const leftY  = sampleInterpolatedSurfaceY(surfaceSpline, leftX,  tz);
  const rightY = sampleInterpolatedSurfaceY(surfaceSpline, rightX, tz);
  const northY = sampleInterpolatedSurfaceY(surfaceSpline, tx, northZ);
  const southY = sampleInterpolatedSurfaceY(surfaceSpline, tx, southZ);
  const nx = leftY - rightY;
  const ny = Math.max(0.12, (rightX - leftX) + (southZ - northZ));
  const nz = northY - southY;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len > 0.0001) { out[0] = nx / len; out[1] = ny / len; out[2] = nz / len; }
  else              { out[0] = 0;        out[1] = 1;        out[2] = 0;        }
}

// Fills a sub-quad position by bilinear interpolation of corner XZ and Catmull-Rom Y.
function _fillSubPoint(
  topNE: WaterPoint, topNW: WaterPoint, topSW: WaterPoint, topSE: WaterPoint,
  surfaceSpline: WaterSurfaceSpline,
  tx: number, tz: number,
  out: WaterPoint,
): void {
  out[0] = bilerp(topNW[0], topNE[0], topSW[0], topSE[0], tx, tz);
  out[1] = sampleInterpolatedSurfaceY(surfaceSpline, tx, tz);
  out[2] = bilerp(topNW[2], topNE[2], topSW[2], topSE[2], tx, tz);
}

function sampleCornerSurfaceDamping(
  grid: WaterSectionGrid,
  vertexX: number,
  vertexZ: number,
  stitchContext?: WaterPatchStitchContext,
) {
  let weightedTotal = 0;
  let weightTotal = 0;
  for (let cx = vertexX - 1; cx <= vertexX; cx++) {
    for (let cz = vertexZ - 1; cz <= vertexZ; cz++) {
      const col = getFilledColumn(grid, cx, cz);
      if (!col || !isCompatibleWithStitchContext(grid, col, cx, cz, stitchContext)) continue;
      const regime = classifyWaterMesherRegime(col);
      const profile = createWaterMesherProfile(col, regime);
      const dx = cx + 0.5 - vertexX;
      const dz = cz + 0.5 - vertexZ;
      const distSq = dx * dx + dz * dz;
      const weight = 1 / (1 + distSq * 1.5);
      const shoreInfluence = clamp01(col.renderState.patchState.shoreInfluence);
      const damping = clamp01(
        profile.surfaceDamping +
        shoreInfluence * 0.45 +
        profile.wallLean * 0.15 +
        profile.seamSlopeBoost * 0.1,
      );
      weightedTotal += damping * weight;
      weightTotal += weight;
    }
  }

  return weightTotal > 0 ? weightedTotal / weightTotal : 0;
}

function sampleCornerShorelineInset(
  grid: WaterSectionGrid,
  vertexX: number,
  vertexZ: number,
  stitchContext?: WaterPatchStitchContext,
) {
  let dirX = 0;
  let dirZ = 0;
  let strengthTotal = 0;
  let weightTotal = 0;

  for (let cx = vertexX - 1; cx <= vertexX; cx++) {
    for (let cz = vertexZ - 1; cz <= vertexZ; cz++) {
      const col = getFilledColumn(grid, cx, cz);
      if (!col || !isCompatibleWithStitchContext(grid, col, cx, cz, stitchContext)) continue;

      const edgeState = col.renderState.edgeState;
      const guidanceMagnitude = Math.hypot(
        edgeState.shorelineGuidanceX,
        edgeState.shorelineGuidanceZ,
      );
      const openEdge = computeOpenEdgeFactor(grid, cx, cz, stitchContext);
      const shoreDistance = col.shoreDistance >= 0 ? col.shoreDistance : 8;
      const shoreFactor = clamp01(1 - shoreDistance / 3.5);
      const shorelineTypeWeight =
        edgeState.edgeType === "shore"
          ? 1
          : edgeState.edgeType === "thinChannel"
            ? 0.92
            : edgeState.edgeType === "wallContact"
              ? 0.72
              : edgeState.edgeType === "drop"
                ? 0.46
                : 0;
      const weight = clamp01(
        shorelineTypeWeight * 0.52 +
          shoreFactor * 0.34 +
          openEdge * 0.28 +
          edgeState.wetReach * 0.18 +
          (1 - edgeState.edgeContinuity) * 0.14,
      ) * Math.max(guidanceMagnitude, shorelineTypeWeight > 0 ? 1 : 0);
      if (weight <= 0.0001) continue;

      dirX += edgeState.shorelineGuidanceX * weight;
      dirZ += edgeState.shorelineGuidanceZ * weight;
      strengthTotal +=
        clamp01(
          shoreFactor * 0.38 +
            openEdge * 0.2 +
            edgeState.edgeWaveDamping * 0.16 +
            edgeState.edgeFoamPotential * 0.14 +
            edgeState.wetReach * 0.12 +
            (1 - edgeState.edgeContinuity) * 0.08,
        ) * weight;
      weightTotal += weight;
    }
  }

  if (weightTotal <= 0.0001) return null;

  const length = Math.hypot(dirX, dirZ);
  if (length <= 0.0001) return null;

  const strength = strengthTotal / weightTotal;
  return {
    dirX: dirX / length,
    dirZ: dirZ / length,
    insetDistance: Math.min(0.34, 0.04 + strength * 0.3),
  };
}

function applyCornerShorelineInset(
  grid: WaterSectionGrid,
  lx: number,
  lz: number,
  column: WaterColumnSample,
  openEdgeFactor: number,
  topNE: WaterPoint,
  topNW: WaterPoint,
  topSW: WaterPoint,
  topSE: WaterPoint,
  stitchContext?: WaterPatchStitchContext,
) {
  const points: [WaterPoint, WaterPoint, WaterPoint, WaterPoint] = [
    [...topNE],
    [...topNW],
    [...topSW],
    [...topSE],
  ];
  const edgeState = column.renderState.edgeState;
  const cellBreakerScale = clamp01(
    openEdgeFactor * 0.32 +
      edgeState.edgeWaveDamping * 0.22 +
      edgeState.edgeFoamPotential * 0.18 +
      edgeState.wetReach * 0.14 +
      (1 - edgeState.edgeContinuity) * 0.14,
  );
  const cornerInsets = [
    sampleCornerShorelineInset(grid, lx + 1, lz, stitchContext),
    sampleCornerShorelineInset(grid, lx, lz, stitchContext),
    sampleCornerShorelineInset(grid, lx, lz + 1, stitchContext),
    sampleCornerShorelineInset(grid, lx + 1, lz + 1, stitchContext),
  ];

  for (let i = 0; i < points.length; i++) {
    const inset = cornerInsets[i];
    if (!inset) continue;
    const insetDistance = inset.insetDistance * (0.9 + cellBreakerScale * 0.18);
    points[i][0] += inset.dirX * insetDistance;
    points[i][2] += inset.dirZ * insetDistance;
  }

  return {
    topNE: points[0],
    topNW: points[1],
    topSW: points[2],
    topSE: points[3],
    stableSurfaceHeight:
      grid.originY +
      (points[0][1] + points[1][1] + points[2][1] + points[3][1]) / 4,
  };
}

function applyWaterMesherProfile(
  grid: WaterSectionGrid,
  lx: number,
  lz: number,
  topNE: WaterPoint,
  topNW: WaterPoint,
  topSW: WaterPoint,
  topSE: WaterPoint,
  stitchContext?: WaterPatchStitchContext,
) {
  const points: [WaterPoint, WaterPoint, WaterPoint, WaterPoint] = [
    [...topNE],
    [...topNW],
    [...topSW],
    [...topSE],
  ];

  const stableSurfaceHeight =
    grid.originY +
    (points[0][1] + points[1][1] + points[2][1] + points[3][1]) / 4;

  const cornerDamping = [
    sampleCornerSurfaceDamping(grid, lx + 1, lz, stitchContext),
    sampleCornerSurfaceDamping(grid, lx, lz, stitchContext),
    sampleCornerSurfaceDamping(grid, lx, lz + 1, stitchContext),
    sampleCornerSurfaceDamping(grid, lx + 1, lz + 1, stitchContext),
  ];

  for (let i = 0; i < points.length; i++) {
    const damping = clamp01(cornerDamping[i] * 0.85);
    if (damping <= 0.0001) continue;
    const currentY = points[i][1];
    const smoothedY = lerp(
      currentY,
      lerp(currentY, stableSurfaceHeight - grid.originY, 0.55),
      damping,
    );
    points[i][1] = lerp(currentY, smoothedY, 0.85);
  }

  const recomputedStableSurfaceHeight =
    grid.originY +
    (points[0][1] + points[1][1] + points[2][1] + points[3][1]) / 4;

  return {
    topNE: points[0],
    topNW: points[1],
    topSW: points[2],
    topSE: points[3],
    stableSurfaceHeight: recomputedStableSurfaceHeight,
  };
}

function prepareWaterCellRenderData(
  grid: WaterSectionGrid,
  regime: WaterSurfaceMesherRegime,
  column: WaterColumnSample,
  lx: number,
  lz: number,
  options?: WaterSurfaceMesherOptions,
  stitchContext?: WaterPatchStitchContext,
): WaterPreparedCellRenderData | null {
  const worldSurfaceY = column.renderSurfaceY;

  if (options?.minSurfaceY !== undefined && worldSurfaceY < options.minSurfaceY) {
    return null;
  }
  if (options?.maxSurfaceY !== undefined && worldSurfaceY > options.maxSurfaceY) {
    return null;
  }

  const localSurfaceY = worldSurfaceY - grid.originY;
  const heightNorm = clamp01((worldSurfaceY - 16) / 112);
  const fillFactor = clamp01(column.fill);
  const shoreDistance = column.shoreDistance;
  const openEdgeFactor = computeOpenEdgeFactor(grid, lx, lz);
  const [flowX, flowZ] = getWaterMesherDirection(column);
  const flowStrength = column.flowStrength;
  const waterClassValue = packWaterClassAndTurbidity(
    computeWaterClassValue(grid, column, lx, lz),
    column.renderState.turbidity,
  );

  const rawTopNE: WaterPoint = [
    lx + 1,
    sampleCornerLocalSurfaceY(grid, lx + 1, lz, localSurfaceY, stitchContext),
    lz,
  ];
  const rawTopNW: WaterPoint = [
    lx,
    sampleCornerLocalSurfaceY(grid, lx, lz, localSurfaceY, stitchContext),
    lz,
  ];
  const rawTopSW: WaterPoint = [
    lx,
    sampleCornerLocalSurfaceY(grid, lx, lz + 1, localSurfaceY, stitchContext),
    lz + 1,
  ];
  const rawTopSE: WaterPoint = [
    lx + 1,
    sampleCornerLocalSurfaceY(grid, lx + 1, lz + 1, localSurfaceY, stitchContext),
    lz + 1,
  ];

  const shorelineInsetTop = applyCornerShorelineInset(
    grid,
    lx,
    lz,
    column,
    openEdgeFactor,
    rawTopNE,
    rawTopNW,
    rawTopSW,
    rawTopSE,
    stitchContext,
  );
  const adjustedTop = applyWaterMesherProfile(
    grid,
    lx,
    lz,
    shorelineInsetTop.topNE,
    shorelineInsetTop.topNW,
    shorelineInsetTop.topSW,
    shorelineInsetTop.topSE,
    stitchContext,
  );
  const surfaceSpline = createWaterSurfaceSpline(
    grid,
    lx,
    lz,
    localSurfaceY,
    adjustedTop.topNE,
    adjustedTop.topNW,
    adjustedTop.topSW,
    adjustedTop.topSE,
    stitchContext,
  );
  const vertexPayload = createWaterVertexPayload(
    column,
    adjustedTop.stableSurfaceHeight,
  );
  const cornerPayloads: [
    WaterSurfaceVertexPayload,
    WaterSurfaceVertexPayload,
    WaterSurfaceVertexPayload,
    WaterSurfaceVertexPayload,
  ] = [
    sampleCornerPayload(grid, lx + 1, lz, vertexPayload, stitchContext),
    sampleCornerPayload(grid, lx, lz, vertexPayload, stitchContext),
    sampleCornerPayload(grid, lx, lz + 1, vertexPayload, stitchContext),
    sampleCornerPayload(grid, lx + 1, lz + 1, vertexPayload, stitchContext),
  ];
  const vertexContexts: [
    WaterVertexContext,
    WaterVertexContext,
    WaterVertexContext,
    WaterVertexContext,
  ] = [
    createWaterVertexContext(
      grid,
      lx + 1,
      lz,
      fillFactor,
      shoreDistance,
      openEdgeFactor,
      flowX,
      flowZ,
      flowStrength,
      waterClassValue,
      stitchContext,
    ),
    createWaterVertexContext(
      grid,
      lx,
      lz,
      fillFactor,
      shoreDistance,
      openEdgeFactor,
      flowX,
      flowZ,
      flowStrength,
      waterClassValue,
      stitchContext,
    ),
    createWaterVertexContext(
      grid,
      lx,
      lz + 1,
      fillFactor,
      shoreDistance,
      openEdgeFactor,
      flowX,
      flowZ,
      flowStrength,
      waterClassValue,
      stitchContext,
    ),
    createWaterVertexContext(
      grid,
      lx + 1,
      lz + 1,
      fillFactor,
      shoreDistance,
      openEdgeFactor,
      flowX,
      flowZ,
      flowStrength,
      waterClassValue,
      stitchContext,
    ),
  ];
  const cellSlopeBase = computeWaterCellSlope(
    adjustedTop.topNE,
    adjustedTop.topNW,
    adjustedTop.topSW,
    adjustedTop.topSE,
  );
  const profile = createWaterMesherProfile(column, regime);
  const cellSlope = cellSlopeBase + profile.seamSlopeBoost * 0.08;
  const cellSurfaceWarp = 0;
  const subdivisions = WATER_UNIFORM_SUBDIVISIONS;

  return {
    column,
    heightNorm,
    fillFactor,
    shoreDistance,
    openEdgeFactor,
    flowX,
    flowZ,
    flowStrength,
    waterClassValue,
    profile,
    vertexPayload,
    cornerPayloads,
    vertexContexts,
    adjustedTop,
    surfaceSpline,
    cellSlope,
    cellSurfaceWarp,
    subdivisions,
  };
}

export function meshWaterSurfaceSubset(
  grid: WaterSectionGrid,
  regime: WaterSurfaceMesherRegime,
  selector: WaterSurfaceColumnSelector,
  options?: WaterSurfaceMesherOptions,
  getStitchContext?: (
    column: WaterColumnSample,
    lx: number,
    lz: number,
  ) => WaterPatchStitchContext | undefined,
): boolean {
  if (grid.filledCount === 0) return false;

  const builder = RenderedMaterials.meshersMap.get("dve_liquid");
  if (!builder) return false;

  const mesh = builder.mesh;
  const bx = grid.boundsX;
  const bz = grid.boundsZ;
  const cols = grid.columns;
  _initHeightCache(bx, bz);
  // Phase 1a — reset per-corner context cache.
  _initCornerCtxCache(bx, bz);
  // Phase 0 — reset telemetry counters for this subset.
  _perfCellCount = 0; _perfSurfaceEmits = 0;
  _perfTimeSampling = 0; _perfTimeSeams = 0; _perfTimeVertex = 0;

  let waterTexture = 0;
  for (let i = 0; i < bx * bz; i++) {
    if (cols[i].filled) {
      waterTexture = resolveWaterTexture(cols[i].voxelId);
      break;
    }
  }

  let emitted = false;

  for (let lx = 0; lx < bx; lx++) {
    for (let lz = 0; lz < bz; lz++) {
      const idx = lx * bz + lz;
      const col = cols[idx];
      if (!col.filled || !selector(col, lx, lz)) continue;
      const stitchContext = getStitchContext?.(col, lx, lz);

      // Phase 0 — sampling timer.
      let prepared: WaterPreparedCellRenderData | null;
      if (ENABLE_WATER_MESHER_TELEMETRY) {
        const _t0 = performance.now();
        prepared = prepareWaterCellRenderData(
          grid, regime, col, lx, lz, options, stitchContext,
        );
        _perfTimeSampling += performance.now() - _t0;
      } else {
        prepared = prepareWaterCellRenderData(
          grid, regime, col, lx, lz, options, stitchContext,
        );
      }
      if (!prepared) continue;
      _perfCellCount++;

      // Phase 0 — vertex timer (surface quad emit).
      if (ENABLE_WATER_MESHER_TELEMETRY) {
        const _t1 = performance.now();
        emitAdaptiveWaterSurface(
          mesh,
          waterTexture,
          lx,
          lz,
          prepared.heightNorm,
          prepared.flowX,
          prepared.flowZ,
          prepared.flowStrength,
          prepared.waterClassValue,
          prepared.adjustedTop.stableSurfaceHeight,
          prepared.adjustedTop.topNE,
          prepared.adjustedTop.topNW,
          prepared.adjustedTop.topSW,
          prepared.adjustedTop.topSE,
          prepared.surfaceSpline,
          prepared.vertexContexts,
          prepared.subdivisions,
          prepared.cellSurfaceWarp,
          prepared.cornerPayloads,
        );
        _perfTimeVertex += performance.now() - _t1;
      } else {
        emitAdaptiveWaterSurface(
          mesh,
          waterTexture,
          lx,
          lz,
          prepared.heightNorm,
          prepared.flowX,
          prepared.flowZ,
          prepared.flowStrength,
          prepared.waterClassValue,
          prepared.adjustedTop.stableSurfaceHeight,
          prepared.adjustedTop.topNE,
          prepared.adjustedTop.topNW,
          prepared.adjustedTop.topSW,
          prepared.adjustedTop.topSE,
          prepared.surfaceSpline,
          prepared.vertexContexts,
          prepared.subdivisions,
          prepared.cellSurfaceWarp,
          prepared.cornerPayloads,
        );
      }
      _perfSurfaceEmits++;

      // Phase 0 — seam timer.
      if (ENABLE_WATER_MESHER_TELEMETRY) {
        const _t2 = performance.now();
        emitVisibleWaterSeams(
          mesh,
          grid,
          waterTexture,
          prepared.column,
          lx,
          lz,
          prepared.fillFactor,
          prepared.heightNorm,
          prepared.shoreDistance,
          prepared.openEdgeFactor * prepared.profile.seamOpenEdgeScale,
          prepared.flowX,
          prepared.flowZ,
          prepared.flowStrength,
          prepared.waterClassValue,
          prepared.vertexPayload,
          prepared.cellSlope,
          prepared.subdivisions,
          prepared.vertexContexts,
          prepared.adjustedTop.topNE,
          prepared.adjustedTop.topNW,
          prepared.adjustedTop.topSW,
          prepared.adjustedTop.topSE,
          stitchContext,
        );
        _perfTimeSeams += performance.now() - _t2;
      } else {
        emitVisibleWaterSeams(
          mesh,
          grid,
          waterTexture,
          prepared.column,
          lx,
          lz,
          prepared.fillFactor,
          prepared.heightNorm,
          prepared.shoreDistance,
          prepared.openEdgeFactor * prepared.profile.seamOpenEdgeScale,
          prepared.flowX,
          prepared.flowZ,
          prepared.flowStrength,
          prepared.waterClassValue,
          prepared.vertexPayload,
          prepared.cellSlope,
          prepared.subdivisions,
          prepared.vertexContexts,
          prepared.adjustedTop.topNE,
          prepared.adjustedTop.topNW,
          prepared.adjustedTop.topSW,
          prepared.adjustedTop.topSE,
          stitchContext,
        );
      }
      emitted = true;
    }
  }

  return emitted;
}

export function meshOpenSurfaceWater(
  grid: WaterSectionGrid,
  options?: WaterSurfaceMesherOptions,
): boolean {
  return meshWaterSurfaceSubset(
    grid,
    "openSurface",
    (column) => classifyWaterMesherRegime(column) === "openSurface",
    options,
  );
}

export function meshOpenSurfaceWaterByPatchSystem(
  grid: WaterSectionGrid,
  options?: WaterSurfaceMesherOptions,
): boolean {
  const largePatchIds = collectLargeOpenSurfacePatchIds(grid);
  if (!largePatchIds.size) return false;

  return meshWaterSurfaceSubset(
    grid,
    "openSurface",
    (column, lx, lz) =>
      classifyWaterMesherRegime(column) === "openSurface" &&
      isLargeOpenSurfacePatchColumn(grid, column, lx, lz, largePatchIds),
    options,
    (column, lx, lz) => createContinuousLargePatchStitchContext(grid, column, lx, lz, largePatchIds),
  );
}

export function meshContinuousLargePatchWater(
  grid: WaterSectionGrid,
  options?: WaterSurfaceMesherOptions,
  continuousSnapshot?: ContinuousLargePatchRenderSnapshot,
): boolean {
  const r = meshContinuousLargePatchSurface(
    grid,
    options,
    continuousPatchMesherPrimitives,
    continuousSnapshot,
  );
  return r;
}

export function meshOpenSurfaceWaterLegacyFallback(
  grid: WaterSectionGrid,
  options?: WaterSurfaceMesherOptions,
  continuousSnapshot?: ContinuousLargePatchRenderSnapshot,
): boolean {
  const continuousOwnershipPatchIds =
    continuousSnapshot
      ? continuousSnapshot.patchIds
      : EngineSettings.settings.water.largeWaterVisibleMode === "continuous-patch"
      ? collectLargeOpenSurfacePatchIds(grid)
      : null;
  const continuousRenderableCellKeys =
    continuousSnapshot
      ? continuousSnapshot.renderableCellKeys
      : EngineSettings.settings.water.largeWaterVisibleMode === "continuous-patch"
      ? collectContinuousLargePatchRenderableCellKeys(
          grid,
          options,
          continuousPatchMesherPrimitives,
        )
      : null;
  const largePatchIds =
    continuousRenderableCellKeys === null
      ? collectLargeOpenSurfacePatchIds(grid)
      : null;
  if ((continuousRenderableCellKeys && !continuousRenderableCellKeys.size) || (!continuousRenderableCellKeys && !largePatchIds?.size)) {
    const r = meshOpenSurfaceWater(grid, options);

    return r;
  }

  const r = meshWaterSurfaceSubset(
    grid,
    "openSurface",
    (column, lx, lz) =>
      classifyWaterMesherRegime(column) === "openSurface" &&
      (continuousRenderableCellKeys
        ? !continuousRenderableCellKeys.has(`${lx}_${lz}`)
        : isLegacyOpenSurfacePatchColumn(grid, column, lx, lz, largePatchIds!)),
    options,
    continuousRenderableCellKeys && continuousOwnershipPatchIds
      ? (column, lx, lz) =>
          createContinuousLargePatchStitchContext(
            grid,
            column,
            lx,
            lz,
            continuousOwnershipPatchIds,
          )
      : undefined,
  );

  return r;
}

export function meshShoreBandWater(
  grid: WaterSectionGrid,
  options?: WaterSurfaceMesherOptions,
): boolean {
  return meshWaterSurfaceSubset(
    grid,
    "shoreBand",
    (column) => classifyWaterMesherRegime(column) === "shoreBand",
    options,
  );
}

export function meshShoreBandWaterByPatchSystem(
  grid: WaterSectionGrid,
  options?: WaterSurfaceMesherOptions,
): boolean {
  const largePatchIds = collectLargeOpenSurfacePatchIds(grid);
  if (!largePatchIds.size) return false;

  return meshWaterSurfaceSubset(
    grid,
    "shoreBand",
    (column, lx, lz) =>
      classifyWaterMesherRegime(column) === "shoreBand" &&
      getContinuousLargePatchAnchorPatchId(grid, column, lx, lz, largePatchIds) > 0,
    options,
    (column, lx, lz) => createContinuousLargePatchStitchContext(grid, column, lx, lz, largePatchIds),
  );
}

export function meshShoreBandWaterLegacyFallback(
  grid: WaterSectionGrid,
  options?: WaterSurfaceMesherOptions,
  continuousSnapshot?: ContinuousLargePatchRenderSnapshot,
): boolean {
  const continuousOwnershipPatchIds =
    continuousSnapshot
      ? continuousSnapshot.patchIds
      : EngineSettings.settings.water.largeWaterVisibleMode === "continuous-patch"
      ? collectLargeOpenSurfacePatchIds(grid)
      : null;
  const continuousRenderableCellKeys =
    continuousSnapshot
      ? continuousSnapshot.renderableCellKeys
      : EngineSettings.settings.water.largeWaterVisibleMode === "continuous-patch"
      ? collectContinuousLargePatchRenderableCellKeys(
          grid,
          options,
          continuousPatchMesherPrimitives,
        )
      : null;
  const largePatchIds =
    continuousRenderableCellKeys === null
      ? collectLargeOpenSurfacePatchIds(grid)
      : null;
  if ((continuousRenderableCellKeys && !continuousRenderableCellKeys.size) || (!continuousRenderableCellKeys && !largePatchIds?.size)) {
    return meshShoreBandWater(grid, options);
  }

  return meshWaterSurfaceSubset(
    grid,
    "shoreBand",
    (column, lx, lz) =>
      classifyWaterMesherRegime(column) === "shoreBand" &&
      (continuousRenderableCellKeys
        ? !continuousRenderableCellKeys.has(`${lx}_${lz}`)
        : isLegacyOpenSurfacePatchColumn(grid, column, lx, lz, largePatchIds!)),
    options,
    continuousRenderableCellKeys && continuousOwnershipPatchIds
      ? (column, lx, lz) =>
          createContinuousLargePatchStitchContext(
            grid,
            column,
            lx,
            lz,
            continuousOwnershipPatchIds,
          )
      : undefined,
  );
}

export function meshChannelRibbonWater(
  grid: WaterSectionGrid,
  options?: WaterSurfaceMesherOptions,
): boolean {
  return meshWaterSurfaceSubset(
    grid,
    "channelRibbon",
    (column) => classifyWaterMesherRegime(column) === "channelRibbon",
    options,
  );
}

export function meshWallContactWater(
  grid: WaterSectionGrid,
  options?: WaterSurfaceMesherOptions,
): boolean {
  return meshWaterSurfaceSubset(
    grid,
    "wallContact",
    (column) => classifyWaterMesherRegime(column) === "wallContact",
    options,
  );
}

export function meshDropEdgeWater(
  grid: WaterSectionGrid,
  options?: WaterSurfaceMesherOptions,
): boolean {
  return meshWaterSurfaceSubset(
    grid,
    "dropEdge",
    (column) => classifyWaterMesherRegime(column) === "dropEdge",
    options,
  );
}

export function meshWaterSurfaceComposer(
  grid: WaterSectionGrid,
  options?: WaterSurfaceMesherOptions,
): boolean {
  const continuousSnapshot =
    EngineSettings.settings.water.largeWaterVisibleMode === "continuous-patch"
      ? collectContinuousLargePatchRenderSnapshot(
          grid,
          options,
          continuousPatchMesherPrimitives,
        )
      : undefined;

  return runWaterSurfaceComposer(
    grid,
    options,
    createWaterSurfaceComposerDispatch(continuousSnapshot),
  );
}

const continuousPatchMesherPrimitives: ContinuousPatchMesherPrimitives = {
  resolveWaterTexture,
  computeOpenEdgeFactor,
  getWaterMesherDirection,
  computePackedWaterClassValue: (grid, column, lx, lz) =>
    packWaterClassAndTurbidity(
      computeWaterClassValue(grid, column, lx, lz),
      column.renderState.turbidity,
    ),
  sampleCornerLocalSurfaceY,
  applyCornerShorelineInset,
  createWaterSurfaceSpline,
  createWaterVertexPayload,
  sampleCornerPayload,
  createWaterVertexContext,
  computeWaterCellSlope,
  createWaterMesherProfile,
  sampleInterpolatedPoint,
  sampleInterpolatedVertexContext,
  sampleInterpolatedNormal,
  emitWaterQuad: (mesh, waterTexture, prepared, quadContexts, pNE, pNW, pSW, pSE, payload, vertexNormals, forcePrimaryDiagonal) => {
    emitWaterQuad(
      mesh,
      waterTexture,
      prepared.heightNorm,
      prepared.flowX,
      prepared.flowZ,
      prepared.flowStrength,
      prepared.waterClassValue,
      quadContexts,
      pNE,
      pNW,
      pSW,
      pSE,
      prepared.adjustedTop.stableSurfaceHeight,
      payload,
      vertexNormals,
      forcePrimaryDiagonal,
    );
  },
  getFilledColumn,
  getColumnSeamBaseLocalY,
  sampleCornerSeamBaseLocalY,
  getSupportLayerBands,
  shouldUseLayeredSeams,
  emitAdaptiveWaterEdgeSeam,
  emitDropEdgeWaterSeam,
  emitLayeredWaterEdgeSeam,
};

const waterSurfaceComposerDispatch: WaterSurfaceComposerDispatch = {
  meshDropEdgeWater,
  meshContinuousLargePatchWater,
  meshOpenSurfaceWaterLegacyFallback,
  meshShoreBandWaterLegacyFallback,
  meshOpenSurfaceWaterByPatchSystem,
  meshShoreBandWaterByPatchSystem,
  meshOpenSurfaceWater,
  meshShoreBandWater,
  meshChannelRibbonWater,
  meshWallContactWater,
};

function createWaterSurfaceComposerDispatch(
  continuousSnapshot?: ContinuousLargePatchRenderSnapshot,
): WaterSurfaceComposerDispatch {
  if (!continuousSnapshot) {
    return waterSurfaceComposerDispatch;
  }

  return {
    ...waterSurfaceComposerDispatch,
    meshContinuousLargePatchWater: (grid, options) =>
      meshContinuousLargePatchWater(grid, options, continuousSnapshot),
    meshOpenSurfaceWaterLegacyFallback: (grid, options) =>
      meshOpenSurfaceWaterLegacyFallback(grid, options, continuousSnapshot),
    meshShoreBandWaterLegacyFallback: (grid, options) =>
      meshShoreBandWaterLegacyFallback(grid, options, continuousSnapshot),
  };
}

function emitWaterQuad(
  mesh: any,
  waterTexture: number,
  heightNorm: number,
  flowX: number,
  flowZ: number,
  flowStrength: number,
  waterClassValue: number,
  vertexContexts: [WaterVertexContext, WaterVertexContext, WaterVertexContext, WaterVertexContext],
  p0: WaterPoint,
  p1: WaterPoint,
  p2: WaterPoint,
  p3: WaterPoint,
  stableSurfaceHeight: number,
  vertexPayload: WaterSurfaceVertexPayload,
  vertexNormals?: [WaterPoint, WaterPoint, WaterPoint, WaterPoint],
  forcePrimaryDiagonal?: boolean,
) {
  const flatNormal: WaterPoint = [0, 1, 0];
  const resolvedNormals: [WaterPoint, WaterPoint, WaterPoint, WaterPoint] = vertexNormals ?? [
    flatNormal,
    flatNormal,
    flatNormal,
    flatNormal,
  ];
  const slopes: [number, number, number, number] = [
    getWaterNormalSlope(resolvedNormals[0]),
    getWaterNormalSlope(resolvedNormals[1]),
    getWaterNormalSlope(resolvedNormals[2]),
    getWaterNormalSlope(resolvedNormals[3]),
  ];

  // Average the 4 corner normals to produce a single gradient value for all
  // vertices. This prevents dveWaterGradient from varying across corners,
  // which would create a visible diagonal seam at the triangle boundary.
  const avgNX = (resolvedNormals[0][0] + resolvedNormals[1][0] + resolvedNormals[2][0] + resolvedNormals[3][0]) / 4;
  const avgNY = (resolvedNormals[0][1] + resolvedNormals[1][1] + resolvedNormals[2][1] + resolvedNormals[3][1]) / 4;
  const avgNZ = (resolvedNormals[0][2] + resolvedNormals[1][2] + resolvedNormals[2][2] + resolvedNormals[3][2]) / 4;
  const safeAvgNY = Math.abs(avgNY) > 0.001 ? avgNY : 0.001;
  const avgGradX = -avgNX / safeAvgNY;
  const avgGradZ = -avgNZ / safeAvgNY;
  const avgCurvature = (slopes[0] + slopes[1] + slopes[2] + slopes[3]) / 4;

  const primaryDiagonalError = Math.abs(p0[1] - p2[1]);
  const alternateDiagonalError = Math.abs(p1[1] - p3[1]);
  const usePrimaryDiagonal = forcePrimaryDiagonal ?? (primaryDiagonalError <= alternateDiagonalError);

  const baseVert = mesh.vertexCount;

  mesh.buffer.setIndex(baseVert);
  writeWaterVertex(
    mesh.buffer.currentArray,
    mesh.buffer.curentIndex,
    p0[0], p0[1], p0[2],
    resolvedNormals[0][0], resolvedNormals[0][1], resolvedNormals[0][2],
    1, 0,
    waterTexture,
    _voxelData[0],
    vertexContexts[0].fillFactor,
    heightNorm,
    vertexContexts[0].shoreDistance,
    vertexContexts[0].openEdgeFactor,
    vertexContexts[0].interactionInfluence,
    slopes[0],
    vertexContexts[0].flowX, vertexContexts[0].flowZ, vertexContexts[0].flowStrength, vertexContexts[0].waterClassValue, stableSurfaceHeight, vertexPayload,
    avgGradX, avgGradZ, avgCurvature,
  );

  mesh.buffer.setIndex(baseVert + 1);
  writeWaterVertex(
    mesh.buffer.currentArray,
    mesh.buffer.curentIndex,
    p1[0], p1[1], p1[2],
    resolvedNormals[1][0], resolvedNormals[1][1], resolvedNormals[1][2],
    0, 0,
    waterTexture,
    _voxelData[1],
    vertexContexts[1].fillFactor,
    heightNorm,
    vertexContexts[1].shoreDistance,
    vertexContexts[1].openEdgeFactor,
    vertexContexts[1].interactionInfluence,
    slopes[1],
    vertexContexts[1].flowX, vertexContexts[1].flowZ, vertexContexts[1].flowStrength, vertexContexts[1].waterClassValue, stableSurfaceHeight, vertexPayload,
    avgGradX, avgGradZ, avgCurvature,
  );

  mesh.buffer.setIndex(baseVert + 2);
  writeWaterVertex(
    mesh.buffer.currentArray,
    mesh.buffer.curentIndex,
    p2[0], p2[1], p2[2],
    resolvedNormals[2][0], resolvedNormals[2][1], resolvedNormals[2][2],
    0, 1,
    waterTexture,
    _voxelData[2],
    vertexContexts[2].fillFactor,
    heightNorm,
    vertexContexts[2].shoreDistance,
    vertexContexts[2].openEdgeFactor,
    vertexContexts[2].interactionInfluence,
    slopes[2],
    vertexContexts[2].flowX, vertexContexts[2].flowZ, vertexContexts[2].flowStrength, vertexContexts[2].waterClassValue, stableSurfaceHeight, vertexPayload,
    avgGradX, avgGradZ, avgCurvature,
  );

  mesh.buffer.setIndex(baseVert + 3);
  writeWaterVertex(
    mesh.buffer.currentArray,
    mesh.buffer.curentIndex,
    p3[0], p3[1], p3[2],
    resolvedNormals[3][0], resolvedNormals[3][1], resolvedNormals[3][2],
    1, 1,
    waterTexture,
    _voxelData[3],
    vertexContexts[3].fillFactor,
    heightNorm,
    vertexContexts[3].shoreDistance,
    vertexContexts[3].openEdgeFactor,
    vertexContexts[3].interactionInfluence,
    slopes[3],
    vertexContexts[3].flowX, vertexContexts[3].flowZ, vertexContexts[3].flowStrength, vertexContexts[3].waterClassValue, stableSurfaceHeight, vertexPayload,
    avgGradX, avgGradZ, avgCurvature,
  );

  const indBase = mesh.indicieCount;
  const indices = mesh.indices;

  if (usePrimaryDiagonal) {
    indices.setIndex(indBase).currentArray[indices.curentIndex] = baseVert;
    indices.setIndex(indBase + 1).currentArray[indices.curentIndex] = baseVert + 1;
    indices.setIndex(indBase + 2).currentArray[indices.curentIndex] = baseVert + 2;
    indices.setIndex(indBase + 3).currentArray[indices.curentIndex] = baseVert + 2;
    indices.setIndex(indBase + 4).currentArray[indices.curentIndex] = baseVert + 3;
    indices.setIndex(indBase + 5).currentArray[indices.curentIndex] = baseVert;
  } else {
    indices.setIndex(indBase).currentArray[indices.curentIndex] = baseVert;
    indices.setIndex(indBase + 1).currentArray[indices.curentIndex] = baseVert + 1;
    indices.setIndex(indBase + 2).currentArray[indices.curentIndex] = baseVert + 3;
    indices.setIndex(indBase + 3).currentArray[indices.curentIndex] = baseVert + 1;
    indices.setIndex(indBase + 4).currentArray[indices.curentIndex] = baseVert + 2;
    indices.setIndex(indBase + 5).currentArray[indices.curentIndex] = baseVert + 3;
  }

  mesh.addVerticies(4, 6);

  const minX = Math.min(p0[0], p1[0], p2[0], p3[0]);
  const minY = Math.min(p0[1], p1[1], p2[1], p3[1]);
  const minZ = Math.min(p0[2], p1[2], p2[2], p3[2]);
  const maxX = Math.max(p0[0], p1[0], p2[0], p3[0]);
  const maxY = Math.max(p0[1], p1[1], p2[1], p3[1]);
  const maxZ = Math.max(p0[2], p1[2], p2[2], p3[2]);

  if (minX < mesh.minBounds.x) mesh.minBounds.x = minX;
  if (minY < mesh.minBounds.y) mesh.minBounds.y = minY;
  if (minZ < mesh.minBounds.z) mesh.minBounds.z = minZ;
  if (maxX > mesh.maxBounds.x) mesh.maxBounds.x = maxX;
  if (maxY > mesh.maxBounds.y) mesh.maxBounds.y = maxY;
  if (maxZ > mesh.maxBounds.z) mesh.maxBounds.z = maxZ;
}

/**
 * Generate a dedicated water top-surface mesh for the given section grid.
 *
 * Writes quads directly into the "dve_liquid" material builder's ProtoMesh.
 * This replaces the Surface Nets fluid emission path.
 *
 * @returns true if any water quads were emitted.
 */
export function meshWaterSurface(
  grid: WaterSectionGrid,
  options?: WaterSurfaceMesherOptions,
): boolean {
  const result = meshWaterSurfaceComposer(grid, options);
  return result;
}
