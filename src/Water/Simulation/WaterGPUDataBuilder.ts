import {
  WaterColumnSample,
  WaterSectionGPUData,
  WaterSectionGrid,
  WaterSurfaceClass,
} from "../Types/WaterTypes";
import type { WaterEdgeType } from "../Types/WaterEdgeState.types";
import type { WaterPatchState, WaterPatchType } from "../Types/WaterPatchState.types";

const COLUMN_STRIDE = 8;
const PARTICLE_SEED_STRIDE = 8;
const PATCH_SUMMARY_STRIDE = 12;
const UNKNOWN_SHORE_DISTANCE = 0xff;

function createWaterSectionGPUData(): WaterSectionGPUData {
  return {
    columnBuffer: new Float32Array(0),
    columnStride: COLUMN_STRIDE,
    paddedColumnBuffer: new Float32Array(0),
    paddedColumnStride: COLUMN_STRIDE,
    columnMetadata: new Uint32Array(0),
    paddedColumnMetadata: new Uint32Array(0),
    particleSeedBuffer: new Float32Array(0),
    particleSeedStride: PARTICLE_SEED_STRIDE,
    particleSeedCount: 0,
    interactionField: new Float32Array(0),
    interactionFieldSize: 0,
    largeBodyField: new Float32Array(0),
    largeBodyFieldSize: 0,
    patchSummaryBuffer: new Float32Array(0),
    patchSummaryStride: PATCH_SUMMARY_STRIDE,
    patchSummaryCount: 0,
    patchMetadata: new Uint32Array(0),
    columnPatchIndex: new Uint16Array(0),
  };
}

function ensureFloatArrayCapacity(array: Float32Array, size: number) {
  return array.length === size ? array : new Float32Array(size);
}

function ensureUintArrayCapacity(array: Uint32Array, size: number) {
  return array.length === size ? array : new Uint32Array(size);
}

function ensureUint16ArrayCapacity(array: Uint16Array, size: number) {
  return array.length === size ? array : new Uint16Array(size);
}

function copyFloatArray(source: Float32Array, target: Float32Array) {
  const next = ensureFloatArrayCapacity(target, source.length);
  next.set(source);
  return next;
}

function getWaterClassId(waterClass: WaterSurfaceClass) {
  switch (waterClass) {
    case "river":
      return 1;
    case "sea":
      return 2;
    default:
      return 0;
  }
}

function getPatchTypeId(patchType: WaterPatchType) {
  switch (patchType) {
    case "shoreBand":
      return 1;
    case "channelRibbon":
      return 2;
    case "dropFace":
      return 3;
    case "enclosedPatch":
      return 4;
    default:
      return 0;
  }
}

function getEdgeTypeId(edgeType: WaterEdgeType) {
  switch (edgeType) {
    case "shore":
      return 1;
    case "wallContact":
      return 2;
    case "drop":
      return 3;
    case "enclosed":
      return 4;
    case "thinChannel":
      return 5;
    default:
      return 0;
  }
}

function packPatchMetadata(patchState: WaterPatchState) {
  return (
    (getPatchTypeId(patchState.patchType) & 0x7) |
    ((patchState.connectivityMask & 0xf) << 3) |
    ((Math.max(0, Math.min(0xffff, patchState.waterBodyId)) & 0xffff) << 8)
  ) >>> 0;
}

function packColumnMetadata(column: WaterColumnSample) {
  const shoreDistance =
    column.shoreDistance < 0
      ? UNKNOWN_SHORE_DISTANCE
      : Math.min(UNKNOWN_SHORE_DISTANCE - 1, column.shoreDistance);
  return (
    (column.filled ? 1 : 0) |
    ((column.level & 0x7) << 1) |
    ((column.levelState & 0xf) << 4) |
    ((getWaterClassId(column.waterClass) & 0x3) << 8) |
    ((getPatchTypeId(column.renderState.patchState.patchType) & 0x7) << 10) |
    ((getEdgeTypeId(column.renderState.edgeState.edgeType) & 0x7) << 13) |
    ((shoreDistance & 0xff) << 16) |
    ((Math.min(0xff, column.supportDepth) & 0xff) << 24)
  ) >>> 0;
}

function writeColumnToBuffer(
  target: Float32Array,
  targetIndex: number,
  column: WaterColumnSample,
) {
  target[targetIndex] = column.filled ? column.renderSurfaceY : -1;
  target[targetIndex + 1] = column.surfaceY;
  target[targetIndex + 2] = column.fill;
  target[targetIndex + 3] = column.flowX;
  target[targetIndex + 4] = column.flowZ;
  target[targetIndex + 5] = column.flowStrength;
  target[targetIndex + 6] = column.renderState.bottomHeight;
  target[targetIndex + 7] = column.renderState.turbulence;
}

function countParticleSeeds(columns: WaterColumnSample[]) {
  let count = 0;
  for (const column of columns) {
    if (!column.filled) continue;
    count += 1 + column.supportLayers.length;
  }
  return count;
}

function writeParticleSeed(
  target: Float32Array,
  entryIndex: number,
  x: number,
  y: number,
  z: number,
  velocityX: number,
  velocityY: number,
  velocityZ: number,
  radius: number,
  kind: number,
) {
  const baseIndex = entryIndex * PARTICLE_SEED_STRIDE;
  target[baseIndex] = x;
  target[baseIndex + 1] = y;
  target[baseIndex + 2] = z;
  target[baseIndex + 3] = velocityX;
  target[baseIndex + 4] = velocityY;
  target[baseIndex + 5] = velocityZ;
  target[baseIndex + 6] = radius;
  target[baseIndex + 7] = kind;
}

function fillParticleSeedBuffer(grid: WaterSectionGrid, gpuData: WaterSectionGPUData) {
  const seedCount = countParticleSeeds(grid.columns);
  gpuData.particleSeedBuffer = ensureFloatArrayCapacity(
    gpuData.particleSeedBuffer,
    seedCount * PARTICLE_SEED_STRIDE,
  );
  gpuData.particleSeedCount = seedCount;

  let entryIndex = 0;
  for (let lx = 0; lx < grid.boundsX; lx++) {
    for (let lz = 0; lz < grid.boundsZ; lz++) {
      const column = grid.columns[lx * grid.boundsZ + lz];
      if (!column.filled) continue;

      const centerX = grid.originX + lx + 0.5;
      const centerZ = grid.originZ + lz + 0.5;
      const velocityX = column.flowX * column.flowStrength;
      const velocityZ = column.flowZ * column.flowStrength;
      const radius = 0.18 + column.fill * 0.18;

      writeParticleSeed(
        gpuData.particleSeedBuffer,
        entryIndex++,
        centerX,
        Math.max(column.renderState.bottomHeight, column.renderSurfaceY - radius),
        centerZ,
        velocityX,
        0,
        velocityZ,
        radius,
        0,
      );

      for (const layer of column.supportLayers) {
        writeParticleSeed(
          gpuData.particleSeedBuffer,
          entryIndex++,
          centerX,
          Math.max(grid.originY + layer.localY, layer.surfaceY - 0.12),
          centerZ,
          velocityX * 0.65,
          0,
          velocityZ * 0.65,
          0.12 + layer.fill * 0.12,
          1,
        );
      }
    }
  }
}

function fillPatchSummaryBuffer(grid: WaterSectionGrid, gpuData: WaterSectionGPUData) {
  const patchStates: WaterPatchState[] = [];
  const patchIndexById = new Map<number, number>();

  gpuData.columnPatchIndex = ensureUint16ArrayCapacity(gpuData.columnPatchIndex, grid.columns.length);
  gpuData.columnPatchIndex.fill(0);

  for (let index = 0; index < grid.columns.length; index++) {
    const column = grid.columns[index];
    if (!column.filled) continue;

    const patchState = column.renderState.patchState;
    if (patchState.patchId <= 0) continue;

    let patchIndex = patchIndexById.get(patchState.patchId);
    if (patchIndex === undefined) {
      patchIndex = patchStates.length;
      patchIndexById.set(patchState.patchId, patchIndex);
      patchStates.push(patchState);
    }

    gpuData.columnPatchIndex[index] = patchIndex + 1;
  }

  gpuData.patchSummaryBuffer = ensureFloatArrayCapacity(
    gpuData.patchSummaryBuffer,
    patchStates.length * PATCH_SUMMARY_STRIDE,
  );
  gpuData.patchMetadata = ensureUintArrayCapacity(gpuData.patchMetadata, patchStates.length);
  gpuData.patchSummaryStride = PATCH_SUMMARY_STRIDE;
  gpuData.patchSummaryCount = patchStates.length;

  for (let index = 0; index < patchStates.length; index++) {
    const patchState = patchStates[index];
    const baseIndex = index * PATCH_SUMMARY_STRIDE;
    gpuData.patchSummaryBuffer[baseIndex] = patchState.surfaceMinX;
    gpuData.patchSummaryBuffer[baseIndex + 1] = patchState.surfaceMinZ;
    gpuData.patchSummaryBuffer[baseIndex + 2] = patchState.surfaceMaxX;
    gpuData.patchSummaryBuffer[baseIndex + 3] = patchState.surfaceMaxZ;
    gpuData.patchSummaryBuffer[baseIndex + 4] = patchState.meanSurfaceHeight;
    gpuData.patchSummaryBuffer[baseIndex + 5] = patchState.meanThickness;
    gpuData.patchSummaryBuffer[baseIndex + 6] = patchState.meanFlow;
    gpuData.patchSummaryBuffer[baseIndex + 7] = patchState.meanTurbulence;
    gpuData.patchSummaryBuffer[baseIndex + 8] = patchState.dominantWaveDirectionX;
    gpuData.patchSummaryBuffer[baseIndex + 9] = patchState.dominantWaveDirectionZ;
    gpuData.patchSummaryBuffer[baseIndex + 10] = patchState.shoreInfluence;
    gpuData.patchSummaryBuffer[baseIndex + 11] = patchState.antiPeriodicitySeed;
    gpuData.patchMetadata[index] = packPatchMetadata(patchState);
  }
}

export function buildWaterGPUData(grid: WaterSectionGrid) {
  const gpuData = grid.gpuData ?? (grid.gpuData = createWaterSectionGPUData());
  const columnCount = grid.columns.length;
  const paddedColumnCount = grid.paddedColumns.length;

  gpuData.columnBuffer = ensureFloatArrayCapacity(
    gpuData.columnBuffer,
    columnCount * COLUMN_STRIDE,
  );
  gpuData.paddedColumnBuffer = ensureFloatArrayCapacity(
    gpuData.paddedColumnBuffer,
    paddedColumnCount * COLUMN_STRIDE,
  );
  gpuData.columnMetadata = ensureUintArrayCapacity(gpuData.columnMetadata, columnCount);
  gpuData.paddedColumnMetadata = ensureUintArrayCapacity(
    gpuData.paddedColumnMetadata,
    paddedColumnCount,
  );

  for (let i = 0; i < columnCount; i++) {
    writeColumnToBuffer(gpuData.columnBuffer, i * COLUMN_STRIDE, grid.columns[i]);
    gpuData.columnMetadata[i] = packColumnMetadata(grid.columns[i]);
  }

  for (let i = 0; i < paddedColumnCount; i++) {
    writeColumnToBuffer(gpuData.paddedColumnBuffer, i * COLUMN_STRIDE, grid.paddedColumns[i]);
    gpuData.paddedColumnMetadata[i] = packColumnMetadata(grid.paddedColumns[i]);
  }

  fillParticleSeedBuffer(grid, gpuData);
  gpuData.interactionField = copyFloatArray(grid.interactionField, gpuData.interactionField);
  gpuData.interactionFieldSize = grid.interactionFieldSize;
  gpuData.largeBodyField = copyFloatArray(grid.largeBodyField, gpuData.largeBodyField);
  gpuData.largeBodyFieldSize = grid.largeBodyFieldSize;
  fillPatchSummaryBuffer(grid, gpuData);
}