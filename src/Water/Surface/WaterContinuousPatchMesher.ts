import { RenderedMaterials } from "../../Mesher/Voxels/Models/RenderedMaterials";
import type { WaterColumnSample, WaterSectionGrid } from "../Types/WaterTypes";
import {
  collectLargeOpenSurfacePatchIds,
  createContinuousLargePatchStitchContext,
  getContinuousLargePatchAnchorPatchId,
  isContinuousLargePatchOwnedColumn,
} from "./WaterPatchMeshSystem";
import { classifyWaterMesherRegime } from "./WaterSurfaceMesher.regimes";
import type {
  WaterPatchStitchContext,
  WaterPoint,
  WaterSurfaceMesherOptions,
  WaterSurfaceMesherProfile,
  WaterSurfaceMesherRegime,
  WaterSurfaceSpline,
  WaterSurfaceVertexPayload,
  WaterVertexContext,
} from "./WaterSurfaceMesher.types";
import { WATER_UNIFORM_SUBDIVISIONS } from "./WaterSurfaceMesher.types";
import { USE_GPU_WATER } from "./WaterSurfaceMesher";

type ContinuousPatchCellRenderData = {
  column: WaterColumnSample;
  heightNorm: number;
  fillFactor: number;
  shoreDistance: number;
  openEdgeFactor: number;
  flowX: number;
  flowZ: number;
  flowStrength: number;
  waterClassValue: number;
  profile: WaterSurfaceMesherProfile;
  vertexPayload: WaterSurfaceVertexPayload;
  cornerPayloads: [
    WaterSurfaceVertexPayload,
    WaterSurfaceVertexPayload,
    WaterSurfaceVertexPayload,
    WaterSurfaceVertexPayload,
  ];
  vertexContexts: [
    WaterVertexContext,
    WaterVertexContext,
    WaterVertexContext,
    WaterVertexContext,
  ];
  adjustedTop: {
    topNE: WaterPoint;
    topNW: WaterPoint;
    topSW: WaterPoint;
    topSE: WaterPoint;
    stableSurfaceHeight: number;
  };
  surfaceSpline: WaterSurfaceSpline;
  cellSlope: number;
  subdivisions: number;
};

type PreparedContinuousPatchCell = {
  lx: number;
  lz: number;
  stitchContext: WaterPatchStitchContext;
  prepared: ContinuousPatchCellRenderData;
};

export type ContinuousPatchMesherPrimitives = {
  resolveWaterTexture: (voxelId: number) => number;
  computeOpenEdgeFactor: (
    grid: WaterSectionGrid,
    lx: number,
    lz: number,
    stitchContext?: WaterPatchStitchContext,
  ) => number;
  getWaterMesherDirection: (column: WaterColumnSample) => [number, number];
  computePackedWaterClassValue: (
    grid: WaterSectionGrid,
    column: WaterColumnSample,
    lx: number,
    lz: number,
  ) => number;
  sampleCornerLocalSurfaceY: (
    grid: WaterSectionGrid,
    vertexX: number,
    vertexZ: number,
    fallbackY: number,
    stitchContext?: WaterPatchStitchContext,
  ) => number;
  applyCornerShorelineInset: (
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
  ) => {
    topNE: WaterPoint;
    topNW: WaterPoint;
    topSW: WaterPoint;
    topSE: WaterPoint;
    stableSurfaceHeight: number;
  };
  createWaterSurfaceSpline: (
    grid: WaterSectionGrid,
    lx: number,
    lz: number,
    fallbackY: number,
    topNE: WaterPoint,
    topNW: WaterPoint,
    topSW: WaterPoint,
    topSE: WaterPoint,
    stitchContext?: WaterPatchStitchContext,
  ) => WaterSurfaceSpline;
  createWaterVertexPayload: (
    column: WaterColumnSample,
    stableSurfaceHeight: number,
  ) => WaterSurfaceVertexPayload;
  sampleCornerPayload: (
    grid: WaterSectionGrid,
    cornerX: number,
    cornerZ: number,
    fallback: WaterSurfaceVertexPayload,
    stitchContext?: WaterPatchStitchContext,
  ) => WaterSurfaceVertexPayload;
  createWaterVertexContext: (
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
  ) => WaterVertexContext;
  computeWaterCellSlope: (
    topNE: WaterPoint,
    topNW: WaterPoint,
    topSW: WaterPoint,
    topSE: WaterPoint,
  ) => number;
  createWaterMesherProfile: (
    column: WaterColumnSample,
    regime: WaterSurfaceMesherRegime,
  ) => WaterSurfaceMesherProfile;
  sampleInterpolatedPoint: (
    topNE: WaterPoint,
    topNW: WaterPoint,
    topSW: WaterPoint,
    topSE: WaterPoint,
    surfaceSpline: WaterSurfaceSpline,
    tx: number,
    tz: number,
  ) => WaterPoint;
  sampleInterpolatedVertexContext: (
    vertexContexts: ContinuousPatchCellRenderData["vertexContexts"],
    tx: number,
    tz: number,
  ) => WaterVertexContext;
  sampleInterpolatedNormal: (
    surfaceSpline: WaterSurfaceSpline,
    tx: number,
    tz: number,
  ) => WaterPoint;
  emitWaterQuad: (
    mesh: any,
    waterTexture: number,
    prepared: ContinuousPatchCellRenderData,
    quadContexts: [WaterVertexContext, WaterVertexContext, WaterVertexContext, WaterVertexContext],
    pNE: WaterPoint,
    pNW: WaterPoint,
    pSW: WaterPoint,
    pSE: WaterPoint,
    payload: WaterSurfaceVertexPayload,
    vertexNormals?: [WaterPoint, WaterPoint, WaterPoint, WaterPoint],
    forcePrimaryDiagonal?: boolean,
  ) => void;
  getFilledColumn: (
    grid: WaterSectionGrid,
    lx: number,
    lz: number,
  ) => WaterColumnSample | null;
  getColumnSeamBaseLocalY: (
    grid: WaterSectionGrid,
    col: WaterColumnSample,
    fillFactor: number,
    shoreDist: number,
    openEdgeFactor: number,
  ) => number;
  sampleCornerSeamBaseLocalY: (
    grid: WaterSectionGrid,
    vertexX: number,
    vertexZ: number,
    fallbackBaseY: number,
    stitchContext?: WaterPatchStitchContext,
  ) => number;
  getSupportLayerBands: (
    grid: WaterSectionGrid,
    col: WaterColumnSample,
    baseY: number,
  ) => number[];
  shouldUseLayeredSeams: (
    grid: WaterSectionGrid,
    col: WaterColumnSample,
    supportBands: number[],
    fillFactor: number,
    openEdgeFactor: number,
    slope: number,
    baseY: number,
  ) => boolean;
  emitAdaptiveWaterEdgeSeam: (
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
  ) => void;
  emitDropEdgeWaterSeam: (
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
  ) => void;
  emitLayeredWaterEdgeSeam: (
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
  ) => void;
};

function prepareContinuousPatchCell(
  grid: WaterSectionGrid,
  regime: WaterSurfaceMesherRegime,
  column: WaterColumnSample,
  lx: number,
  lz: number,
  options: WaterSurfaceMesherOptions | undefined,
  stitchContext: WaterPatchStitchContext,
  primitives: ContinuousPatchMesherPrimitives,
): ContinuousPatchCellRenderData | null {
  const worldSurfaceY = column.renderSurfaceY;
  if (options?.minSurfaceY !== undefined && worldSurfaceY < options.minSurfaceY) return null;
  if (options?.maxSurfaceY !== undefined && worldSurfaceY > options.maxSurfaceY) return null;

  const localSurfaceY = worldSurfaceY - grid.originY;
  const heightNorm = Math.max(0, Math.min(1, (worldSurfaceY - 16) / 112));
  const fillFactor = Math.max(0, Math.min(1, column.fill));
  const shoreDistance = column.shoreDistance;
  const openEdgeFactor = primitives.computeOpenEdgeFactor(grid, lx, lz, stitchContext);
  const [flowX, flowZ] = primitives.getWaterMesherDirection(column);
  const flowStrength = column.flowStrength;
  const waterClassValue = primitives.computePackedWaterClassValue(grid, column, lx, lz);

  const rawTopNE: WaterPoint = [lx + 1, primitives.sampleCornerLocalSurfaceY(grid, lx + 1, lz, localSurfaceY, stitchContext), lz];
  const rawTopNW: WaterPoint = [lx, primitives.sampleCornerLocalSurfaceY(grid, lx, lz, localSurfaceY, stitchContext), lz];
  const rawTopSW: WaterPoint = [lx, primitives.sampleCornerLocalSurfaceY(grid, lx, lz + 1, localSurfaceY, stitchContext), lz + 1];
  const rawTopSE: WaterPoint = [lx + 1, primitives.sampleCornerLocalSurfaceY(grid, lx + 1, lz + 1, localSurfaceY, stitchContext), lz + 1];
  const adjustedTop = primitives.applyCornerShorelineInset(
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
  const surfaceSpline = primitives.createWaterSurfaceSpline(grid, lx, lz, localSurfaceY, adjustedTop.topNE, adjustedTop.topNW, adjustedTop.topSW, adjustedTop.topSE, stitchContext);
  const vertexPayload = primitives.createWaterVertexPayload(column, adjustedTop.stableSurfaceHeight);
  const cornerPayloads: ContinuousPatchCellRenderData["cornerPayloads"] = [
    primitives.sampleCornerPayload(grid, lx + 1, lz, vertexPayload, stitchContext),
    primitives.sampleCornerPayload(grid, lx, lz, vertexPayload, stitchContext),
    primitives.sampleCornerPayload(grid, lx, lz + 1, vertexPayload, stitchContext),
    primitives.sampleCornerPayload(grid, lx + 1, lz + 1, vertexPayload, stitchContext),
  ];
  const vertexContexts: ContinuousPatchCellRenderData["vertexContexts"] = [
    primitives.createWaterVertexContext(grid, lx + 1, lz, fillFactor, shoreDistance, openEdgeFactor, flowX, flowZ, flowStrength, waterClassValue, stitchContext),
    primitives.createWaterVertexContext(grid, lx, lz, fillFactor, shoreDistance, openEdgeFactor, flowX, flowZ, flowStrength, waterClassValue, stitchContext),
    primitives.createWaterVertexContext(grid, lx, lz + 1, fillFactor, shoreDistance, openEdgeFactor, flowX, flowZ, flowStrength, waterClassValue, stitchContext),
    primitives.createWaterVertexContext(grid, lx + 1, lz + 1, fillFactor, shoreDistance, openEdgeFactor, flowX, flowZ, flowStrength, waterClassValue, stitchContext),
  ];
  const profile = primitives.createWaterMesherProfile(column, regime);
  const cellSlopeBase = primitives.computeWaterCellSlope(adjustedTop.topNE, adjustedTop.topNW, adjustedTop.topSW, adjustedTop.topSE);

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
    cellSlope: cellSlopeBase + profile.seamSlopeBoost * 0.08,
    subdivisions: WATER_UNIFORM_SUBDIVISIONS,
  };
}

function sampleSubdividedPayload(prepared: ContinuousPatchCellRenderData, tx: number, tz: number): WaterSurfaceVertexPayload {
  const [payloadNE, payloadNW, payloadSW, payloadSE] = prepared.cornerPayloads;
  const north = {
    dropHeight: payloadNW.dropHeight + (payloadNE.dropHeight - payloadNW.dropHeight) * tx,
    foamCrest: payloadNW.foamCrest + (payloadNE.foamCrest - payloadNW.foamCrest) * tx,
    foamEdge: payloadNW.foamEdge + (payloadNE.foamEdge - payloadNW.foamEdge) * tx,
    foamImpact: payloadNW.foamImpact + (payloadNE.foamImpact - payloadNW.foamImpact) * tx,
  };
  const south = {
    dropHeight: payloadSW.dropHeight + (payloadSE.dropHeight - payloadSW.dropHeight) * tx,
    foamCrest: payloadSW.foamCrest + (payloadSE.foamCrest - payloadSW.foamCrest) * tx,
    foamEdge: payloadSW.foamEdge + (payloadSE.foamEdge - payloadSW.foamEdge) * tx,
    foamImpact: payloadSW.foamImpact + (payloadSE.foamImpact - payloadSW.foamImpact) * tx,
  };
  return {
    dropHeight: north.dropHeight + (south.dropHeight - north.dropHeight) * tz,
    foamCrest: north.foamCrest + (south.foamCrest - north.foamCrest) * tz,
    foamEdge: north.foamEdge + (south.foamEdge - north.foamEdge) * tz,
    foamImpact: north.foamImpact + (south.foamImpact - north.foamImpact) * tz,
  };
}

function getTopSurfaceDiagonalOverride(
  pNE: WaterPoint,
  pNW: WaterPoint,
  pSW: WaterPoint,
  pSE: WaterPoint,
  parityPrimaryDiagonal: boolean,
) {
  const primaryHeightError   = Math.abs(pNE[1] - pSW[1]);
  const alternateHeightError = Math.abs(pNW[1] - pSE[1]);

  const primaryGradX   = pNE[0] - pSW[0]; const primaryGradZ   = pNE[2] - pSW[2];
  const alternateGradX = pNW[0] - pSE[0]; const alternateGradZ = pNW[2] - pSE[2];
  const primaryDiagLen   = Math.max(0.001, Math.sqrt(primaryGradX * primaryGradX   + primaryGradZ   * primaryGradZ));
  const alternateDiagLen = Math.max(0.001, Math.sqrt(alternateGradX * alternateGradX + alternateGradZ * alternateGradZ));
  const primarySlope   = primaryHeightError   / primaryDiagLen;
  const alternateSlope = alternateHeightError / alternateDiagLen;

  const slopeDiff = Math.abs(primarySlope - alternateSlope);
  if (slopeDiff > 0.005) {
    return primarySlope <= alternateSlope;
  }

  return parityPrimaryDiagonal;
}

function emitContinuousPatchTopSurface(mesh: any, waterTexture: number, lx: number, lz: number, prepared: ContinuousPatchCellRenderData, primitives: ContinuousPatchMesherPrimitives) {
  const { adjustedTop, surfaceSpline, vertexContexts, subdivisions } = prepared;
  const surfaceSubdivisions = Math.max(subdivisions, 3);
  for (let zStep = 0; zStep < surfaceSubdivisions; zStep++) {
    const z0 = zStep / surfaceSubdivisions;
    const z1 = (zStep + 1) / surfaceSubdivisions;
    for (let xStep = 0; xStep < surfaceSubdivisions; xStep++) {
      const parityPrimaryDiagonal = ((lx + xStep) + (lz + zStep)) % 2 === 0;
      const x0 = xStep / surfaceSubdivisions;
      const x1 = (xStep + 1) / surfaceSubdivisions;
      const pNE = primitives.sampleInterpolatedPoint(adjustedTop.topNE, adjustedTop.topNW, adjustedTop.topSW, adjustedTop.topSE, surfaceSpline, x1, z0);
      const pNW = primitives.sampleInterpolatedPoint(adjustedTop.topNE, adjustedTop.topNW, adjustedTop.topSW, adjustedTop.topSE, surfaceSpline, x0, z0);
      const pSW = primitives.sampleInterpolatedPoint(adjustedTop.topNE, adjustedTop.topNW, adjustedTop.topSW, adjustedTop.topSE, surfaceSpline, x0, z1);
      const pSE = primitives.sampleInterpolatedPoint(adjustedTop.topNE, adjustedTop.topNW, adjustedTop.topSW, adjustedTop.topSE, surfaceSpline, x1, z1);
      const diagonalOverride = getTopSurfaceDiagonalOverride(
        pNE,
        pNW,
        pSW,
        pSE,
        parityPrimaryDiagonal,
      );
      const quadContexts: [WaterVertexContext, WaterVertexContext, WaterVertexContext, WaterVertexContext] = [
        primitives.sampleInterpolatedVertexContext(vertexContexts, x1, z0),
        primitives.sampleInterpolatedVertexContext(vertexContexts, x0, z0),
        primitives.sampleInterpolatedVertexContext(vertexContexts, x0, z1),
        primitives.sampleInterpolatedVertexContext(vertexContexts, x1, z1),
      ];
      const quadNormals: [WaterPoint, WaterPoint, WaterPoint, WaterPoint] = [
        primitives.sampleInterpolatedNormal(surfaceSpline, x1, z0),
        primitives.sampleInterpolatedNormal(surfaceSpline, x0, z0),
        primitives.sampleInterpolatedNormal(surfaceSpline, x0, z1),
        primitives.sampleInterpolatedNormal(surfaceSpline, x1, z1),
      ];
      const payload = sampleSubdividedPayload(prepared, (x0 + x1) * 0.5, (z0 + z1) * 0.5);
      primitives.emitWaterQuad(mesh, waterTexture, prepared, quadContexts, pNE, pNW, pSW, pSE, payload, quadNormals, diagonalOverride);
    }
  }
}

function emitContinuousPatchSeams(mesh: any, grid: WaterSectionGrid, waterTexture: number, prepared: ContinuousPatchCellRenderData, lx: number, lz: number, stitchContext: WaterPatchStitchContext, primitives: ContinuousPatchMesherPrimitives) {
  if (USE_GPU_WATER) return;
  const col = prepared.column;
  const baseY = primitives.getColumnSeamBaseLocalY(grid, col, prepared.fillFactor, prepared.shoreDistance, prepared.openEdgeFactor);
  const seamBaseNE = primitives.sampleCornerSeamBaseLocalY(grid, lx + 1, lz, baseY, stitchContext);
  const seamBaseNW = primitives.sampleCornerSeamBaseLocalY(grid, lx, lz, baseY, stitchContext);
  const seamBaseSW = primitives.sampleCornerSeamBaseLocalY(grid, lx, lz + 1, baseY, stitchContext);
  const seamBaseSE = primitives.sampleCornerSeamBaseLocalY(grid, lx + 1, lz + 1, baseY, stitchContext);
  const supportBands = primitives.getSupportLayerBands(grid, col, baseY);
  const useLayeredSeams = primitives.shouldUseLayeredSeams(grid, col, supportBands, prepared.fillFactor, prepared.openEdgeFactor, prepared.cellSlope, baseY);
  const useDropSeams = col.renderState.edgeState.edgeType === "drop" && col.renderState.edgeState.dropHeight > 0.7;
  const { topNE, topNW, topSW, topSE } = prepared.adjustedTop;
  const topContexts = prepared.vertexContexts;

  const emitEdge = (hasNeighbor: boolean, contextA: WaterVertexContext, contextB: WaterVertexContext, prev: WaterPoint, topA: WaterPoint, topB: WaterPoint, next: WaterPoint, basePrev: number, baseA: number, baseB: number, baseNext: number, outwardX: number, outwardZ: number) => {
    if (hasNeighbor) return;
    if (useDropSeams) {
      primitives.emitDropEdgeWaterSeam(mesh, waterTexture, prepared.heightNorm, prepared.flowX, prepared.flowZ, prepared.flowStrength, prepared.waterClassValue, contextA, contextB, prev, topA, topB, next, basePrev, baseA, baseB, baseNext, col, prepared.subdivisions, outwardX, outwardZ, prepared.vertexPayload);
      return;
    }
    if (useLayeredSeams) {
      primitives.emitLayeredWaterEdgeSeam(mesh, waterTexture, prepared.heightNorm, prepared.flowX, prepared.flowZ, prepared.flowStrength, prepared.waterClassValue, contextA, contextB, prev, topA, topB, next, basePrev, baseA, baseB, baseNext, prepared.cellSlope, prepared.subdivisions, supportBands, prepared.vertexPayload);
      return;
    }
    primitives.emitAdaptiveWaterEdgeSeam(mesh, waterTexture, prepared.heightNorm, prepared.flowX, prepared.flowZ, prepared.flowStrength, prepared.waterClassValue, contextA, contextB, prev, topA, topB, next, basePrev, baseA, baseB, baseNext, prepared.cellSlope, prepared.subdivisions, prepared.vertexPayload);
  };

  emitEdge(!!primitives.getFilledColumn(grid, lx + 1, lz), topContexts[0], topContexts[3], topNW, topNE, topSE, topSW, seamBaseNW, seamBaseNE, seamBaseSE, seamBaseSW, 1, 0);
  emitEdge(!!primitives.getFilledColumn(grid, lx - 1, lz), topContexts[1], topContexts[2], topNE, topNW, topSW, topSE, seamBaseNE, seamBaseNW, seamBaseSW, seamBaseSE, -1, 0);
  emitEdge(!!primitives.getFilledColumn(grid, lx, lz - 1), topContexts[0], topContexts[1], topSE, topNE, topNW, topSW, seamBaseSE, seamBaseNE, seamBaseNW, seamBaseSW, 0, -1);
  emitEdge(!!primitives.getFilledColumn(grid, lx, lz + 1), topContexts[2], topContexts[3], topNW, topSW, topSE, topNE, seamBaseNW, seamBaseSW, seamBaseSE, seamBaseNE, 0, 1);
}

function getContinuousPatchRegime(column: WaterColumnSample) {
  const regime = classifyWaterMesherRegime(column);
  if (regime === "openSurface" || regime === "shoreBand") return regime;
  return null;
}

function collectPreparedContinuousPatchCells(grid: WaterSectionGrid, options: WaterSurfaceMesherOptions | undefined, primitives: ContinuousPatchMesherPrimitives, patchIds: Set<number>) {
  const patchCells = new Map<number, PreparedContinuousPatchCell[]>();
  const bz = grid.boundsZ;
  for (let lx = 0; lx < grid.boundsX; lx++) {
    for (let lz = 0; lz < bz; lz++) {
      const column = grid.columns[lx * bz + lz];
      if (!column.filled || !column.renderState.standardSurfaceVisible) continue;
      const regime = getContinuousPatchRegime(column);
      if (!regime) continue;
      if (!isContinuousLargePatchOwnedColumn(grid, column, lx, lz, patchIds)) continue;
      const anchorPatchId = getContinuousLargePatchAnchorPatchId(grid, column, lx, lz, patchIds);
      if (anchorPatchId <= 0) continue;
      const stitchContext = createContinuousLargePatchStitchContext(grid, column, lx, lz, patchIds);
      const prepared = prepareContinuousPatchCell(grid, regime, column, lx, lz, options, stitchContext, primitives);
      if (!prepared) continue;
      const cells = patchCells.get(anchorPatchId) ?? [];
      cells.push({ lx, lz, stitchContext, prepared });
      patchCells.set(anchorPatchId, cells);
    }
  }
  return patchCells;
}

export function collectContinuousLargePatchRenderableIds(
  grid: WaterSectionGrid,
  options: WaterSurfaceMesherOptions | undefined,
  primitives: ContinuousPatchMesherPrimitives,
) {
  const largePatchIds = collectLargeOpenSurfacePatchIds(grid);
  if (!largePatchIds.size) return largePatchIds;

  const patchCells = collectPreparedContinuousPatchCells(
    grid,
    options,
    primitives,
    largePatchIds,
  );

  return new Set<number>(patchCells.keys());
}

export function meshContinuousLargePatchSurface(grid: WaterSectionGrid, options: WaterSurfaceMesherOptions | undefined, primitives: ContinuousPatchMesherPrimitives): boolean {
  if (grid.filledCount === 0) return false;
  const largePatchIds = collectLargeOpenSurfacePatchIds(grid);
  if (!largePatchIds.size) return false;
  const builder = RenderedMaterials.meshersMap.get("dve_liquid");
  if (!builder) return false;
  const patchCells = collectPreparedContinuousPatchCells(grid, options, primitives, largePatchIds);
  if (!patchCells.size) return false;

  const mesh = builder.mesh;
  let emitted = false;
  for (const cells of patchCells.values()) {
    cells.sort((a, b) => (a.lx - b.lx) || (a.lz - b.lz));
    const waterTexture = primitives.resolveWaterTexture(cells[0].prepared.column.voxelId);
    for (const cell of cells) {
      emitContinuousPatchTopSurface(mesh, waterTexture, cell.lx, cell.lz, cell.prepared, primitives);
      emitted = true;
    }
    for (const cell of cells) {
      emitContinuousPatchSeams(mesh, grid, waterTexture, cell.prepared, cell.lx, cell.lz, cell.stitchContext, primitives);
    }
  }
  return emitted;
}
