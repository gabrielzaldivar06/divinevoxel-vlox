import {
  WaterColumnSample,
  WaterSectionGrid,
  WaterSupportLayer,
  WaterSurfaceClass,
} from "../Types/WaterTypes";
import { WaterRenderState } from "../Types/WaterRenderState.types";
import { WaterEdgeState } from "../Types/WaterEdgeState.types";
import { WaterPatchState, WaterPatchType } from "../Types/WaterPatchState.types";
import { buildWaterInteractionField } from "./WaterInteractionFieldBuilder";
import { buildWaterLargeBodyField } from "./WaterLargeBodyFieldBuilder";
import { buildWaterEcologyField } from "./WaterEcologyFieldBuilder";
import { buildWaterWetnessField } from "./WaterWetnessFieldBuilder";
import { buildWaterGPUData } from "./WaterGPUDataBuilder";
import { DataCursorInterface } from "../../Voxels/Cursor/DataCursor.interface";
import { WorldSpaces } from "../../World/WorldSpaces";
import { SectionCursor } from "../../World/Cursor/SectionCursor";
import { EngineSettings } from "../../Settings/EngineSettings";

const WATER_HEIGHT = 6 / 7;
const FLOW_SURFACE_EPSILON = 0.01;
const FLOW_LEVEL_WEIGHT = 1 / 7;
const FLOW_SOURCE_BIAS = 0.18;
const FLOW_STRENGTH_SCALE = 1.4;
const SEA_OPEN_NEIGHBOR_THRESHOLD = 20;
const SEA_COAST_OPEN_NEIGHBOR_THRESHOLD = 8;
const SEA_LEVEL_BAND = 2.5;
const RIVER_FLOW_THRESHOLD = 0.3;
// Must be >= WATER_CORNER_SAMPLE_RADIUS + 1 (currently 2+1=3) so that
// Catmull-Rom spline boundary cells can fully resolve their outermost
// sampleCornerLocalSurfaceY lookups.  Radius 2 caused height discontinuity
// at section boundaries → visible sector-level grid in open sea.
const WATER_PADDED_RADIUS = 3;
const MIN_RENDER_RELIEF = 0.12;
const MAX_RENDER_SUPPORT_DEPTH = 4;
const MAX_RENDER_SUPPORT_LAYERS = 2;
const MAX_SUPPORT_LAYER_SCAN_DEPTH = 8;
const MIN_SUPPORT_LAYER_REQUIRED_DEPTH = 3;
const MIN_SUPPORT_LAYER_REQUIRED_GAP = 2;
const MIN_SUPPORT_LAYER_SURFACE_DELTA = 0.32;
const MIN_SUPPORT_LAYER_FILL_DELTA = 0.26;
const CARDINAL_FLOW_NEIGHBORS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const PATCH_NOT_ASSIGNED = -1;

export type WaterExtractionOptions = {
  minSurfaceY?: number;
  maxSurfaceY?: number;
};

function createWaterEdgeState(): WaterEdgeState {
  return {
    edgeType: "none",
    dropHeight: 0,
    terrainContactNormalX: 0,
    terrainContactNormalY: 1,
    terrainContactNormalZ: 0,
    edgeVisibility: 0,
    edgeContinuity: 1,
    edgeFoamPotential: 0,
    edgeWaveDamping: 0,
    shorelineGuidanceX: 0,
    shorelineGuidanceZ: 0,
    wetReach: 0,
    interactionInfluence: 0,
    wallContactFactor: 0,
  };
}

function createWaterPatchState(): WaterPatchState {
  return {
    patchId: PATCH_NOT_ASSIGNED,
    waterBodyId: PATCH_NOT_ASSIGNED,
    continuitySignature: 0,
    patchType: "openSurface",
    surfaceMinX: 0,
    surfaceMinZ: 0,
    surfaceMaxX: 0,
    surfaceMaxZ: 0,
    meanSurfaceHeight: 0,
    meanThickness: 0,
    meanFlow: 0,
    meanTurbulence: 0,
    connectivityMask: 0,
    dominantWaveDirectionX: 0,
    dominantWaveDirectionZ: 0,
    antiPeriodicitySeed: 0,
    shoreInfluence: 0,
  };
}

function createWaterRenderState(): WaterRenderState {
  return {
    bottomHeight: 0,
    thickness: 0,
    bankSlope: 0,
    turbulence: 0,
    foamPotential: 0,
    foamClassMask: {
      crest: 0,
      edge: 0,
      impact: 0,
    },
    surfaceWetness: 0,
    wetnessPotential: 0,
    wetnessAge: 0,
    dryingRate: 0,
    openWaterEvaporation: 0,
    soilEvaporation: 0,
    drainage: 0,
    transpirationPotential: 0,
    flowAccumulation: 0,
    erosionPotential: 0,
    depositionPotential: 0,
    turbidity: 0,
    porosityClass: "unknown",
    waterBodyId: PATCH_NOT_ASSIGNED,
    waterBodyType: "lake",
    waveDirectionX: 0,
    waveDirectionZ: 0,
    antiPeriodicityDomain: 0,
    standardSurfaceVisible: true,
    transientSurfaceActive: false,
    edgeState: createWaterEdgeState(),
    patchState: createWaterPatchState(),
  };
}

/**
 * Empty column sentinel — reused for non-filled slots.
 */
const EMPTY_COLUMN: Readonly<WaterColumnSample> = {
  filled: false,
  surfaceY: 0,
  renderSurfaceY: 0,
  fill: 0,
  level: 0,
  levelState: 0,
  localY: 0,
  voxelId: 0,
  supportDepth: 0,
  supportLayers: [],
  shoreDistance: -1,
  flowX: 0,
  flowZ: 0,
  flowStrength: 0,
  waterClass: "lake",
  renderState: createWaterRenderState(),
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
  interactionField: new Float32Array(0),
  interactionFieldSize: 8,
  largeBodyField: new Float32Array(0),
  largeBodyFieldSize: 8,
  gpuData: {
    columnBuffer: new Float32Array(0),
    columnStride: 8,
    paddedColumnBuffer: new Float32Array(0),
    paddedColumnStride: 8,
    columnMetadata: new Uint32Array(0),
    paddedColumnMetadata: new Uint32Array(0),
    particleSeedBuffer: new Float32Array(0),
    particleSeedStride: 8,
    particleSeedCount: 0,
    interactionField: new Float32Array(0),
    interactionFieldSize: 0,
    largeBodyField: new Float32Array(0),
    largeBodyFieldSize: 0,
    patchSummaryBuffer: new Float32Array(0),
    patchSummaryStride: 12,
    patchSummaryCount: 0,
    patchMetadata: new Uint32Array(0),
    columnPatchIndex: new Uint16Array(0),
  },
};

const _columns: WaterColumnSample[] = [];
const _paddedColumns: WaterColumnSample[] = [];

function createColumnSample(): WaterColumnSample {
  return {
    filled: false,
    surfaceY: 0,
    renderSurfaceY: 0,
    fill: 0,
    level: 0,
    levelState: 0,
    localY: 0,
    voxelId: 0,
    supportDepth: 0,
    supportLayers: [],
    shoreDistance: -1,
    flowX: 0,
    flowZ: 0,
    flowStrength: 0,
    waterClass: "lake",
    renderState: createWaterRenderState(),
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
  col.renderSurfaceY = 0;
  col.fill = 0;
  col.level = 0;
  col.levelState = 0;
  col.localY = 0;
  col.voxelId = 0;
  col.supportDepth = 0;
  col.supportLayers.length = 0;
  col.shoreDistance = -1;
  col.flowX = 0;
  col.flowZ = 0;
  col.flowStrength = 0;
  col.waterClass = "lake";
  resetRenderState(col.renderState);
}

function resetRenderState(renderState: WaterRenderState) {
  renderState.bottomHeight = 0;
  renderState.thickness = 0;
  renderState.bankSlope = 0;
  renderState.turbulence = 0;
  renderState.foamPotential = 0;
  renderState.foamClassMask.crest = 0;
  renderState.foamClassMask.edge = 0;
  renderState.foamClassMask.impact = 0;
  renderState.surfaceWetness = 0;
  renderState.wetnessPotential = 0;
  renderState.wetnessAge = 0;
  renderState.dryingRate = 0;
  renderState.openWaterEvaporation = 0;
  renderState.soilEvaporation = 0;
  renderState.drainage = 0;
  renderState.transpirationPotential = 0;
  renderState.flowAccumulation = 0;
  renderState.erosionPotential = 0;
  renderState.depositionPotential = 0;
  renderState.turbidity = 0;
  renderState.porosityClass = "unknown";
  renderState.waterBodyId = PATCH_NOT_ASSIGNED;
  renderState.waterBodyType = "lake";
  renderState.waveDirectionX = 0;
  renderState.waveDirectionZ = 0;
  renderState.antiPeriodicityDomain = 0;
  renderState.standardSurfaceVisible = true;
  renderState.transientSurfaceActive = false;
  resetEdgeState(renderState.edgeState);
  resetPatchState(renderState.patchState);
}

function resetEdgeState(edgeState: WaterEdgeState) {
  edgeState.edgeType = "none";
  edgeState.dropHeight = 0;
  edgeState.terrainContactNormalX = 0;
  edgeState.terrainContactNormalY = 1;
  edgeState.terrainContactNormalZ = 0;
  edgeState.edgeVisibility = 0;
  edgeState.edgeContinuity = 1;
  edgeState.edgeFoamPotential = 0;
  edgeState.edgeWaveDamping = 0;
  edgeState.shorelineGuidanceX = 0;
  edgeState.shorelineGuidanceZ = 0;
  edgeState.wetReach = 0;
  edgeState.interactionInfluence = 0;
  edgeState.wallContactFactor = 0;
}

function resetPatchState(patchState: WaterPatchState) {
  patchState.patchId = PATCH_NOT_ASSIGNED;
  patchState.waterBodyId = PATCH_NOT_ASSIGNED;
  patchState.continuitySignature = 0;
  patchState.patchType = "openSurface";
  patchState.surfaceMinX = 0;
  patchState.surfaceMinZ = 0;
  patchState.surfaceMaxX = 0;
  patchState.surfaceMaxZ = 0;
  patchState.meanSurfaceHeight = 0;
  patchState.meanThickness = 0;
  patchState.meanFlow = 0;
  patchState.meanTurbulence = 0;
  patchState.connectivityMask = 0;
  patchState.dominantWaveDirectionX = 0;
  patchState.dominantWaveDirectionZ = 0;
  patchState.antiPeriodicitySeed = 0;
  patchState.shoreInfluence = 0;
}

function copyColumnSample(target: WaterColumnSample, source: WaterColumnSample) {
  target.filled = source.filled;
  target.surfaceY = source.surfaceY;
  target.renderSurfaceY = source.renderSurfaceY;
  target.fill = source.fill;
  target.level = source.level;
  target.levelState = source.levelState;
  target.localY = source.localY;
  target.voxelId = source.voxelId;
  target.supportDepth = source.supportDepth;
  target.supportLayers.length = source.supportLayers.length;
  for (let i = 0; i < source.supportLayers.length; i++) {
    const sourceLayer = source.supportLayers[i];
    const targetLayer = target.supportLayers[i] ?? (target.supportLayers[i] = {
      localY: 0,
      surfaceY: 0,
      fill: 0,
      level: 0,
      levelState: 0,
      voxelId: 0,
      gapFromAbove: 0,
    });
    targetLayer.localY = sourceLayer.localY;
    targetLayer.surfaceY = sourceLayer.surfaceY;
    targetLayer.fill = sourceLayer.fill;
    targetLayer.level = sourceLayer.level;
    targetLayer.levelState = sourceLayer.levelState;
    targetLayer.voxelId = sourceLayer.voxelId;
    targetLayer.gapFromAbove = sourceLayer.gapFromAbove;
  }
  target.shoreDistance = source.shoreDistance;
  target.flowX = source.flowX;
  target.flowZ = source.flowZ;
  target.flowStrength = source.flowStrength;
  target.waterClass = source.waterClass;
  copyRenderState(target.renderState, source.renderState);
}

function copyRenderState(target: WaterRenderState, source: WaterRenderState) {
  target.bottomHeight = source.bottomHeight;
  target.thickness = source.thickness;
  target.bankSlope = source.bankSlope;
  target.turbulence = source.turbulence;
  target.foamPotential = source.foamPotential;
  target.foamClassMask.crest = source.foamClassMask.crest;
  target.foamClassMask.edge = source.foamClassMask.edge;
  target.foamClassMask.impact = source.foamClassMask.impact;
  target.surfaceWetness = source.surfaceWetness;
  target.wetnessPotential = source.wetnessPotential;
  target.wetnessAge = source.wetnessAge;
  target.dryingRate = source.dryingRate;
  target.openWaterEvaporation = source.openWaterEvaporation;
  target.soilEvaporation = source.soilEvaporation;
  target.drainage = source.drainage;
  target.transpirationPotential = source.transpirationPotential;
  target.flowAccumulation = source.flowAccumulation;
  target.erosionPotential = source.erosionPotential;
  target.depositionPotential = source.depositionPotential;
  target.turbidity = source.turbidity;
  target.porosityClass = source.porosityClass;
  target.waterBodyId = source.waterBodyId;
  target.waterBodyType = source.waterBodyType;
  target.waveDirectionX = source.waveDirectionX;
  target.waveDirectionZ = source.waveDirectionZ;
  target.antiPeriodicityDomain = source.antiPeriodicityDomain;
  target.standardSurfaceVisible = source.standardSurfaceVisible;
  target.transientSurfaceActive = source.transientSurfaceActive;
  copyEdgeState(target.edgeState, source.edgeState);
  copyPatchState(target.patchState, source.patchState);
}

function copyEdgeState(target: WaterEdgeState, source: WaterEdgeState) {
  target.edgeType = source.edgeType;
  target.dropHeight = source.dropHeight;
  target.terrainContactNormalX = source.terrainContactNormalX;
  target.terrainContactNormalY = source.terrainContactNormalY;
  target.terrainContactNormalZ = source.terrainContactNormalZ;
  target.edgeVisibility = source.edgeVisibility;
  target.edgeContinuity = source.edgeContinuity;
  target.edgeFoamPotential = source.edgeFoamPotential;
  target.edgeWaveDamping = source.edgeWaveDamping;
  target.shorelineGuidanceX = source.shorelineGuidanceX;
  target.shorelineGuidanceZ = source.shorelineGuidanceZ;
  target.wetReach = source.wetReach;
  target.interactionInfluence = source.interactionInfluence;
  target.wallContactFactor = source.wallContactFactor;
}

function copyPatchState(target: WaterPatchState, source: WaterPatchState) {
  target.patchId = source.patchId;
  target.waterBodyId = source.waterBodyId;
  target.continuitySignature = source.continuitySignature;
  target.patchType = source.patchType;
  target.surfaceMinX = source.surfaceMinX;
  target.surfaceMinZ = source.surfaceMinZ;
  target.surfaceMaxX = source.surfaceMaxX;
  target.surfaceMaxZ = source.surfaceMaxZ;
  target.meanSurfaceHeight = source.meanSurfaceHeight;
  target.meanThickness = source.meanThickness;
  target.meanFlow = source.meanFlow;
  target.meanTurbulence = source.meanTurbulence;
  target.connectivityMask = source.connectivityMask;
  target.dominantWaveDirectionX = source.dominantWaveDirectionX;
  target.dominantWaveDirectionZ = source.dominantWaveDirectionZ;
  target.antiPeriodicitySeed = source.antiPeriodicitySeed;
  target.shoreInfluence = source.shoreInfluence;
}

function getLiquidFill(level: number, levelState: number) {
  if (level >= 7 || levelState === 1) {
    return 1;
  }
  return level / 7;
}

function getLiquidSurfaceY(wy: number, level: number, levelState: number) {
  return wy + getLiquidFill(level, levelState) * WATER_HEIGHT;
}

function setSupportLayer(
  target: WaterSupportLayer,
  localY: number,
  surfaceY: number,
  fill: number,
  level: number,
  levelState: number,
  voxelId: number,
  gapFromAbove: number,
) {
  target.localY = localY;
  target.surfaceY = surfaceY;
  target.fill = fill;
  target.level = level;
  target.levelState = levelState;
  target.voxelId = voxelId;
  target.gapFromAbove = gapFromAbove;
}

function captureSupportLayers(
  out: WaterColumnSample,
  worldCursor: DataCursorInterface,
  wx: number,
  originY: number,
  wz: number,
) {
  out.supportLayers.length = 0;
  if (out.supportDepth < MIN_SUPPORT_LAYER_REQUIRED_DEPTH) {
    return;
  }

  const scanStart = out.localY - Math.max(1, out.supportDepth - 1);
  const scanEnd = Math.max(0, out.localY - MAX_SUPPORT_LAYER_SCAN_DEPTH);
  let previousLocalY = out.localY;
  let previousSurfaceY = out.surfaceY;
  let previousFill = out.fill;

  for (let ly = scanStart; ly >= scanEnd; ly--) {
    const wy = originY + ly;
    const voxel = worldCursor.getVoxel(wx, wy, wz);
    if (!voxel || !voxel.substanceTags["dve_is_liquid"]) {
      continue;
    }

    const level = voxel.getLevel();
    const levelState = voxel.getLevelState();
    const voxelId = voxel.getVoxelId();
    const fill = getLiquidFill(level, levelState);
    const surfaceY = getLiquidSurfaceY(wy, level, levelState);
    const gapFromAbove = Math.max(1, previousLocalY - ly);
    const surfaceDelta = Math.abs(previousSurfaceY - surfaceY);
    const fillDelta = Math.abs(previousFill - fill);
    const strongGap = gapFromAbove >= MIN_SUPPORT_LAYER_REQUIRED_GAP;
    const strongSurfaceBreak = surfaceDelta >= MIN_SUPPORT_LAYER_SURFACE_DELTA;
    const strongFillBreak = fillDelta >= MIN_SUPPORT_LAYER_FILL_DELTA;
    const shapeBreak =
      levelState !== out.levelState &&
      surfaceDelta >= MIN_SUPPORT_LAYER_SURFACE_DELTA * 0.7;
    const shouldCapture =
      strongGap ||
      strongSurfaceBreak ||
      strongFillBreak ||
      (voxelId !== out.voxelId && strongSurfaceBreak) ||
      shapeBreak;

    if (!shouldCapture) {
      continue;
    }

    const layer = out.supportLayers[out.supportLayers.length] ?? {
      localY: 0,
      surfaceY: 0,
      fill: 0,
      level: 0,
      levelState: 0,
      voxelId: 0,
      gapFromAbove: 0,
    };
    setSupportLayer(
      layer,
      ly,
      surfaceY,
      fill,
      level,
      levelState,
      voxelId,
      gapFromAbove,
    );
    out.supportLayers[out.supportLayers.length] = layer;
    previousLocalY = ly;
    previousSurfaceY = surfaceY;
    previousFill = fill;

    if (out.supportLayers.length >= MAX_RENDER_SUPPORT_LAYERS) {
      break;
    }
  }
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
  surfaceY: number,
): WaterSurfaceClass {
  const seaLevel = (EngineSettings.settings.terrain as any).seaLevel ?? 32;
  if (flowStrength >= RIVER_FLOW_THRESHOLD) return "river";
  if (openNeighborCount >= SEA_OPEN_NEIGHBOR_THRESHOLD) return "sea";
  if (
    openNeighborCount >= SEA_COAST_OPEN_NEIGHBOR_THRESHOLD &&
    Math.abs(surfaceY - seaLevel) <= SEA_LEVEL_BAND
  ) {
    return "sea";
  }
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

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function computePatchAperiodicSeed(
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  averageSurfaceHeight: number,
  averageFlow: number,
  averageTurbulence: number,
  boundaryMask: number,
) {
  const surfaceQuantized = Math.round(averageSurfaceHeight * 32);
  const flowQuantized = Math.round(averageFlow * 1000);
  const turbulenceQuantized = Math.round(averageTurbulence * 1000);
  let hash = 2166136261;
  const values = [
    minX + 1,
    minZ + 1,
    maxX + 1,
    maxZ + 1,
    surfaceQuantized,
    flowQuantized,
    turbulenceQuantized,
    boundaryMask + 1,
  ];

  for (const value of values) {
    hash ^= value >>> 0;
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function computeOpenEdgeFactor(grid: WaterSectionGrid, lx: number, lz: number) {
  let openCount = 0;
  for (const [dx, dz] of CARDINAL_FLOW_NEIGHBORS) {
    const neighbor = getPaddedColumn(grid, lx + dx, lz + dz);
    if (!neighbor?.filled) {
      openCount++;
    }
  }
  return clamp01(openCount / 4);
}

function getSupportDepth(
  worldCursor: DataCursorInterface,
  wx: number,
  wy: number,
  wz: number,
  voxelId: number,
) {
  let depth = 1;
  for (let dy = 1; dy < MAX_RENDER_SUPPORT_DEPTH; dy++) {
    const below = worldCursor.getVoxel(wx, wy - dy, wz);
    if (!below || !below.substanceTags["dve_is_liquid"]) {
      break;
    }
    if (below.getVoxelId() !== voxelId) {
      break;
    }
    depth++;
  }
  return depth;
}

function getRenderableSurfaceTarget(
  grid: WaterSectionGrid,
  col: WaterColumnSample,
  lx: number,
  lz: number,
) {
  const actualSurfaceY = col.surfaceY;
  let lowerNeighborCount = 0;
  let lowerNeighborSum = 0;
  let openSides = 0;

  for (const [dx, dz] of CARDINAL_FLOW_NEIGHBORS) {
    const neighbor = getPaddedColumn(grid, lx + dx, lz + dz);
    if (!neighbor?.filled) {
      openSides++;
      continue;
    }
    const drop = actualSurfaceY - neighbor.surfaceY;
    if (drop > MIN_RENDER_RELIEF) {
      lowerNeighborSum += neighbor.surfaceY;
      lowerNeighborCount++;
    }
  }

  const openEdgeDrop =
    openSides > 0
      ? WATER_HEIGHT *
        (0.16 + (1 - clamp01(col.fill)) * 0.28) *
        Math.min(1, openSides / 2)
      : 0;

  if (lowerNeighborCount === 0 && openEdgeDrop <= MIN_RENDER_RELIEF) {
    return actualSurfaceY;
  }

  const lowerNeighborAverage =
    lowerNeighborCount > 0
      ? lowerNeighborSum / lowerNeighborCount
      : actualSurfaceY - openEdgeDrop;
  const relief = actualSurfaceY - lowerNeighborAverage;
  if (relief <= MIN_RENDER_RELIEF) {
    return actualSurfaceY;
  }

  const unsupportedWeight = clamp01((3 - col.supportDepth) / 3);
  const shallowWeight = clamp01(1 - col.fill);
  const edgeWeight = clamp01((lowerNeighborCount + openSides * 1.25) / 4);
  const sourceResistance = col.levelState === 1 ? 0.45 : 1;
  const relaxation =
    clamp01((relief - MIN_RENDER_RELIEF) / 0.65) *
    (0.34 + unsupportedWeight * 0.28 + shallowWeight * 0.24 + edgeWeight * 0.22) *
    sourceResistance;

  if (relaxation <= 0.0001) {
    return actualSurfaceY;
  }

  const minimumSurfaceY = grid.originY + col.localY + Math.max(0.08, col.fill * 0.2);
  const targetSurfaceY =
    lowerNeighborCount > 0
      ? Math.max(
          minimumSurfaceY,
          lowerNeighborAverage + Math.min(0.22, 0.08 + col.fill * 0.16),
        )
      : Math.max(
          minimumSurfaceY,
          actualSurfaceY - openEdgeDrop,
        );

  return actualSurfaceY + (targetSurfaceY - actualSurfaceY) * relaxation;
}

function computeRenderableSurfaceHeights(grid: WaterSectionGrid) {
  for (let lx = 0; lx < grid.boundsX; lx++) {
    for (let lz = 0; lz < grid.boundsZ; lz++) {
      const col = grid.columns[lx * grid.boundsZ + lz];
      if (!col.filled) continue;
      col.renderSurfaceY = getRenderableSurfaceTarget(grid, col, lx, lz);
    }
  }

  for (let lx = -grid.paddedRadius; lx <= grid.boundsX + grid.paddedRadius - 1; lx++) {
    for (let lz = -grid.paddedRadius; lz <= grid.boundsZ + grid.paddedRadius - 1; lz++) {
      if (lx >= 0 && lx < grid.boundsX && lz >= 0 && lz < grid.boundsZ) {
        continue;
      }
      const col = getPaddedColumn(grid, lx, lz);
      if (!col?.filled) continue;
      col.renderSurfaceY = getRenderableSurfaceTarget(grid, col, lx, lz);
    }
  }
}

function computeFlowMetadataForColumn(
  grid: WaterSectionGrid,
  column: WaterColumnSample,
  lx: number,
  lz: number,
) {
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
  column.waterClass = getWaterClass(
    column.flowStrength,
    openNeighborCount,
    column.surfaceY,
  );
}

function computeFlowMetadata(grid: WaterSectionGrid) {
  const bx = grid.boundsX;
  const bz = grid.boundsZ;

  for (let lx = 0; lx < bx; lx++) {
    for (let lz = 0; lz < bz; lz++) {
      const column = grid.columns[lx * bz + lz];
      if (!column.filled) continue;
      computeFlowMetadataForColumn(grid, column, lx, lz);
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

  for (let lx = -grid.paddedRadius; lx <= bx + grid.paddedRadius - 1; lx++) {
    for (let lz = -grid.paddedRadius; lz <= bz + grid.paddedRadius - 1; lz++) {
      if (lx >= 0 && lx < bx && lz >= 0 && lz < bz) {
        continue;
      }

      const column = getPaddedColumn(grid, lx, lz);
      if (!column?.filled) continue;
      computeFlowMetadataForColumn(grid, column, lx, lz);
    }
  }
}

function computeRenderStateMetadataForColumn(
  grid: WaterSectionGrid,
  column: WaterColumnSample,
  lx: number,
  lz: number,
) {
  const renderState = column.renderState;
  const bottomHeight = grid.originY + Math.max(0, column.localY - column.supportDepth + 1);
  const openEdgeFactor = computeOpenEdgeFactor(grid, lx, lz);
  let slopeAccumulator = 0;
  let slopeSamples = 0;
  let shorelineX = 0;
  let shorelineZ = 0;
  let maxDropHeight = 0;
  let missingNeighbors = 0;

  for (const [dx, dz] of CARDINAL_FLOW_NEIGHBORS) {
    const neighbor = getPaddedColumn(grid, lx + dx, lz + dz);
    if (!neighbor?.filled) {
      missingNeighbors++;
      shorelineX -= dx;
      shorelineZ -= dz;
      slopeAccumulator += 1;
      slopeSamples++;
      continue;
    }

    slopeAccumulator += Math.min(1, Math.abs(column.renderSurfaceY - neighbor.renderSurfaceY));
    slopeSamples++;
    maxDropHeight = Math.max(maxDropHeight, column.renderSurfaceY - neighbor.renderSurfaceY);
  }

  const bankSlope = slopeSamples > 0 ? clamp01(slopeAccumulator / slopeSamples) : 0;
  const turbulence = clamp01(column.flowStrength * 0.65 + openEdgeFactor * 0.2 + bankSlope * 0.15);
  const foamPotential = clamp01(turbulence * 0.6 + (column.shoreDistance === 1 ? 0.25 : 0) + openEdgeFactor * 0.15);
  const shorelineMagnitude = Math.sqrt(shorelineX * shorelineX + shorelineZ * shorelineZ);
  const shoreGuidanceX = shorelineMagnitude > 0.0001 ? shorelineX / shorelineMagnitude : 0;
  const shoreGuidanceZ = shorelineMagnitude > 0.0001 ? shorelineZ / shorelineMagnitude : 0;

  renderState.bottomHeight = bottomHeight;
  renderState.thickness = Math.max(0, column.surfaceY - bottomHeight);
  renderState.bankSlope = bankSlope;
  renderState.turbulence = turbulence;
  renderState.foamPotential = foamPotential;
  renderState.foamClassMask.crest = clamp01(turbulence * 1.1);
  renderState.foamClassMask.edge = clamp01(foamPotential);
  renderState.foamClassMask.impact = clamp01(maxDropHeight / 1.25);
  renderState.surfaceWetness = 0;
  renderState.wetnessPotential = clamp01(foamPotential * 0.55 + openEdgeFactor * 0.25 + column.flowStrength * 0.2);
  renderState.wetnessAge = 0;
  renderState.dryingRate = 0;
  renderState.porosityClass = "unknown";
  renderState.waterBodyType = column.waterClass;
  renderState.waveDirectionX = column.flowX;
  renderState.waveDirectionZ = column.flowZ;

  const edgeState = renderState.edgeState;
  let edgeType: WaterEdgeState["edgeType"] = "none";
  if (maxDropHeight > 0.7) {
    edgeType = "drop";
  } else if (missingNeighbors > 0 && column.shoreDistance === 1 && column.flowStrength > 0.28 && column.supportDepth <= 2) {
    edgeType = "thinChannel";
  } else if (missingNeighbors > 0 && column.supportDepth >= 2 && bankSlope > 0.7) {
    edgeType = "wallContact";
  } else if (missingNeighbors > 0) {
    edgeType = "shore";
  }

  edgeState.edgeType = edgeType;
  edgeState.dropHeight = Math.max(0, maxDropHeight);
  edgeState.terrainContactNormalX = shoreGuidanceX;
  edgeState.terrainContactNormalY = 1 - clamp01(bankSlope * 0.35);
  edgeState.terrainContactNormalZ = shoreGuidanceZ;
  edgeState.edgeVisibility = Math.max(openEdgeFactor, edgeType === "drop" ? 1 : 0);
  edgeState.edgeContinuity = 1 - clamp01(bankSlope * 0.75 + openEdgeFactor * 0.25);
  edgeState.edgeFoamPotential = clamp01(renderState.foamClassMask.edge + renderState.foamClassMask.impact * 0.35);
  edgeState.edgeWaveDamping = clamp01((column.shoreDistance > 0 ? 1 / Math.max(1, column.shoreDistance) : 0) + openEdgeFactor * 0.35);
  edgeState.shorelineGuidanceX = shoreGuidanceX;
  edgeState.shorelineGuidanceZ = shoreGuidanceZ;
  edgeState.wetReach = clamp01(renderState.wetnessPotential * 1.15);
  edgeState.interactionInfluence = 0;
  edgeState.wallContactFactor = edgeType === "wallContact" ? clamp01(bankSlope * 0.75 + column.supportDepth * 0.08) : 0;
}

function computeRenderStateMetadata(grid: WaterSectionGrid) {
  const bx = grid.boundsX;
  const bz = grid.boundsZ;

  for (let lx = 0; lx < bx; lx++) {
    for (let lz = 0; lz < bz; lz++) {
      const column = grid.columns[lx * bz + lz];
      if (!column.filled) continue;
      computeRenderStateMetadataForColumn(grid, column, lx, lz);
    }
  }

  for (let lx = -grid.paddedRadius; lx <= bx + grid.paddedRadius - 1; lx++) {
    for (let lz = -grid.paddedRadius; lz <= bz + grid.paddedRadius - 1; lz++) {
      if (lx >= 0 && lx < bx && lz >= 0 && lz < bz) {
        continue;
      }

      const column = getPaddedColumn(grid, lx, lz);
      if (!column?.filled) continue;
      computeRenderStateMetadataForColumn(grid, column, lx, lz);
    }
  }
}

function getPatchType(
  width: number,
  depth: number,
  averageShoreDistance: number,
  averageFlow: number,
): WaterPatchType {
  if (Math.min(width, depth) <= 2 && averageFlow >= 0.2) {
    return "channelRibbon";
  }
  if (averageShoreDistance > 0 && averageShoreDistance <= 1.25) {
    return "shoreBand";
  }
  return "openSurface";
}

const CONTINUITY_TILE_SIZE = 4;
const CONTINUITY_SIGNATURE_BITS = 32;

function hashContinuityTile(
  tileX: number,
  tileZ: number,
  heightBand: number,
  patchType: WaterPatchType,
) {
  let hash = Math.imul(tileX, 73856093) ^ Math.imul(tileZ, 19349663) ^ Math.imul(heightBand, 83492791);
  hash ^= Math.imul(patchType === "openSurface" ? 1 : patchType === "enclosedPatch" ? 2 : 3, 2654435761);
  return (hash >>> 0) % CONTINUITY_SIGNATURE_BITS;
}

function computePatchContinuitySignature(
  grid: WaterSectionGrid,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  averageSurfaceHeight: number,
  patchType: WaterPatchType,
) {
  const worldMinX = grid.originX + minX;
  const worldMinZ = grid.originZ + minZ;
  const worldMaxX = grid.originX + maxX;
  const worldMaxZ = grid.originZ + maxZ;
  const tileMinX = Math.floor(worldMinX / CONTINUITY_TILE_SIZE);
  const tileMaxX = Math.floor(worldMaxX / CONTINUITY_TILE_SIZE);
  const tileMinZ = Math.floor(worldMinZ / CONTINUITY_TILE_SIZE);
  const tileMaxZ = Math.floor(worldMaxZ / CONTINUITY_TILE_SIZE);
  const heightBand = Math.max(0, Math.floor(averageSurfaceHeight / 2));

  let signature = 0;
  for (let tileX = tileMinX; tileX <= tileMaxX; tileX++) {
    for (let tileZ = tileMinZ; tileZ <= tileMaxZ; tileZ++) {
      signature |= 1 << hashContinuityTile(tileX, tileZ, heightBand, patchType);
    }
  }

  if (!signature) {
    signature = 1 << hashContinuityTile(tileMinX, tileMinZ, heightBand, patchType);
  }

  return signature >>> 0;
}

function computePatchStates(grid: WaterSectionGrid) {
  const bx = grid.boundsX;
  const bz = grid.boundsZ;
  const radius = grid.paddedRadius;
  const pbx = grid.paddedBoundsX;
  const pbz = grid.paddedBoundsZ;

  const visited = new Uint8Array(pbx * pbz);
  const queue = new Int32Array(pbx * pbz);
  let nextPatchId = 1;

  for (let startLX = -radius; startLX <= bx + radius - 1; startLX++) {
    for (let startLZ = -radius; startLZ <= bz + radius - 1; startLZ++) {
      const startPIdx = (startLX + radius) * pbz + (startLZ + radius);
      if (visited[startPIdx]) continue;

      const startColumn = grid.paddedColumns[startPIdx];
      if (!startColumn.filled) continue;

      let queueStart = 0;
      let queueEnd = 0;
      queue[queueEnd++] = startPIdx;
      visited[startPIdx] = 1;

      const patchMembers: number[] = [];
      let minX = startLX;
      let maxX = startLX;
      let minZ = startLZ;
      let maxZ = startLZ;
      let surfaceSum = 0;
      let thicknessSum = 0;
      let flowSum = 0;
      let turbulenceSum = 0;
      let shoreDistanceSum = 0;
      let waveXSum = 0;
      let waveZSum = 0;
      let boundaryMask = 0;

      while (queueStart < queueEnd) {
        const pIdx = queue[queueStart++];
        patchMembers.push(pIdx);

        const lx = Math.floor(pIdx / pbz) - radius;
        const lz = (pIdx % pbz) - radius;
        const column = grid.paddedColumns[pIdx];
        const renderState = column.renderState;

        minX = Math.min(minX, lx);
        maxX = Math.max(maxX, lx);
        minZ = Math.min(minZ, lz);
        maxZ = Math.max(maxZ, lz);
        surfaceSum += column.renderSurfaceY;
        thicknessSum += renderState.thickness;
        flowSum += column.flowStrength;
        turbulenceSum += renderState.turbulence;
        shoreDistanceSum += column.shoreDistance > 0 ? column.shoreDistance : 4;
        waveXSum += renderState.waveDirectionX;
        waveZSum += renderState.waveDirectionZ;

        if (lx === -radius) boundaryMask |= 1;
        if (lx === bx + radius - 1) boundaryMask |= 2;
        if (lz === -radius) boundaryMask |= 4;
        if (lz === bz + radius - 1) boundaryMask |= 8;

        for (const [dx, dz] of CARDINAL_FLOW_NEIGHBORS) {
          const nx = lx + dx;
          const nz = lz + dz;
          if (
            nx < -radius ||
            nx >= bx + radius ||
            nz < -radius ||
            nz >= bz + radius
          )
            continue;

          const neighborPIdx = (nx + radius) * pbz + (nz + radius);
          if (visited[neighborPIdx]) continue;
          if (!grid.paddedColumns[neighborPIdx].filled) continue;
          visited[neighborPIdx] = 1;
          queue[queueEnd++] = neighborPIdx;
        }
      }

      const memberCount = patchMembers.length;
      const averageSurfaceHeight = surfaceSum / memberCount;
      const averageThickness = thicknessSum / memberCount;
      const averageFlow = flowSum / memberCount;
      const averageTurbulence = turbulenceSum / memberCount;
      const averageShoreDistance = shoreDistanceSum / memberCount;
      const waveMagnitude = Math.sqrt(waveXSum * waveXSum + waveZSum * waveZSum);
      const dominantWaveDirectionX =
        waveMagnitude > 0.0001 ? waveXSum / waveMagnitude : 0;
      const dominantWaveDirectionZ =
        waveMagnitude > 0.0001 ? waveZSum / waveMagnitude : 0;
      const patchAperiodicSeed = computePatchAperiodicSeed(
        minX,
        minZ,
        maxX,
        maxZ,
        averageSurfaceHeight,
        averageFlow,
        averageTurbulence,
        boundaryMask,
      );
      const patchAperiodicDomain = (patchAperiodicSeed % 29) + 1;
      const patchType = getPatchType(
        maxX - minX + 1,
        maxZ - minZ + 1,
        averageShoreDistance,
        averageFlow,
      );
      const continuitySignature = computePatchContinuitySignature(
        grid,
        minX,
        minZ,
        maxX,
        maxZ,
        averageSurfaceHeight,
        patchType,
      );

      for (const pIdx of patchMembers) {
        const column = grid.paddedColumns[pIdx];
        const renderState = column.renderState;
        renderState.waterBodyId = nextPatchId;
        renderState.waveDirectionX = dominantWaveDirectionX;
        renderState.waveDirectionZ = dominantWaveDirectionZ;
        renderState.antiPeriodicityDomain = patchAperiodicDomain;

        const patchState = renderState.patchState;
        patchState.patchId = nextPatchId;
        patchState.waterBodyId = nextPatchId;
        patchState.continuitySignature = continuitySignature;
        patchState.patchType = patchType;
        patchState.surfaceMinX = minX;
        patchState.surfaceMinZ = minZ;
        patchState.surfaceMaxX = maxX;
        patchState.surfaceMaxZ = maxZ;
        patchState.meanSurfaceHeight = averageSurfaceHeight;
        patchState.meanThickness = averageThickness;
        patchState.meanFlow = averageFlow;
        patchState.meanTurbulence = averageTurbulence;
        patchState.connectivityMask = boundaryMask;
        patchState.dominantWaveDirectionX = dominantWaveDirectionX;
        patchState.dominantWaveDirectionZ = dominantWaveDirectionZ;
        patchState.antiPeriodicitySeed = patchAperiodicSeed;
        patchState.shoreInfluence = clamp01(1 - averageShoreDistance / 4);
      }

      nextPatchId++;
    }
  }

  for (let lx = 0; lx < bx; lx++) {
    for (let lz = 0; lz < bz; lz++) {
      copyColumnSample(
        grid.columns[lx * bz + lz],
        grid.paddedColumns[
          (lx + grid.paddedRadius) * grid.paddedBoundsZ + (lz + grid.paddedRadius)
        ],
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

    const fill = getLiquidFill(level, levelState);
    const surfaceY = getLiquidSurfaceY(wy, level, levelState);

    if (minSurfaceY !== undefined && surfaceY < minSurfaceY) continue;
    if (maxSurfaceY !== undefined && surfaceY > maxSurfaceY) continue;

    out.filled = true;
    out.localY = ly;
    out.level = level;
    out.levelState = levelState;
    out.voxelId = voxelId;
    out.supportDepth = getSupportDepth(worldCursor, wx, wy, wz, voxelId);
    out.fill = fill;
    out.surfaceY = surfaceY;
    out.renderSurfaceY = surfaceY;
    captureSupportLayers(out, worldCursor, wx, originY, wz);
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
  computeRenderableSurfaceHeights(_grid);
  computeFlowMetadata(_grid);
  computeRenderStateMetadata(_grid);
  computePatchStates(_grid);
  buildWaterLargeBodyField(_grid);
  buildWaterInteractionField(_grid);
  buildWaterWetnessField(_grid);
  buildWaterEcologyField(_grid);
  buildWaterGPUData(_grid);

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

  for (let lx = -grid.paddedRadius; lx <= bx + grid.paddedRadius - 1; lx++) {
    for (let lz = -grid.paddedRadius; lz <= bz + grid.paddedRadius - 1; lz++) {
      if (lx >= 0 && lx < bx && lz >= 0 && lz < bz) {
        continue;
      }

      const col = getPaddedColumn(grid, lx, lz);
      if (!col?.filled) continue;

      let minDist = Infinity;

      for (const [nx, nz] of CARDINAL_FLOW_NEIGHBORS) {
        if (!getPaddedColumn(grid, lx + nx, lz + nz)?.filled) {
          minDist = 1;
          break;
        }
      }

      if (minDist > 1) {
        for (let dx = -2; dx <= 2; dx++) {
          for (let dz = -2; dz <= 2; dz++) {
            if (dx === 0 && dz === 0) continue;
            if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) continue;
            if (!getPaddedColumn(grid, lx + dx, lz + dz)?.filled) {
              minDist = Math.min(minDist, Math.abs(dx) + Math.abs(dz));
            }
          }
        }
      }

      col.shoreDistance = minDist === Infinity ? -1 : minDist;
    }
  }
}
