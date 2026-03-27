import { WaterColumnSample } from "../Types/WaterTypes";
import {
  WaterSurfaceMesherProfile,
  WaterSurfaceMesherRegime,
} from "./WaterSurfaceMesher.types";
import { clamp01 } from "./WaterSurfaceMesher.math";

export function classifyWaterMesherRegime(
  column: WaterColumnSample,
): WaterSurfaceMesherRegime {
  const edgeState = column.renderState.edgeState;
  const patchType = column.renderState.patchState.patchType;

  if (edgeState.edgeType === "drop" || edgeState.dropHeight > 0.7) {
    return "dropEdge";
  }

  if (
    edgeState.edgeType === "wallContact" ||
    edgeState.wallContactFactor >= 0.3
  ) {
    return "wallContact";
  }

  if (
    patchType === "channelRibbon" ||
    edgeState.edgeType === "thinChannel"
  ) {
    return "channelRibbon";
  }

  if (
    patchType === "shoreBand" ||
    edgeState.edgeType === "shore"
  ) {
    return "shoreBand";
  }

  return "openSurface";
}

export function createWaterMesherProfile(
  column: WaterColumnSample,
  regime: WaterSurfaceMesherRegime,
): WaterSurfaceMesherProfile {
  const renderState = column.renderState;
  const patchState = renderState.patchState;
  const edgeState = renderState.edgeState;
  const thicknessDelta = clamp01(
    patchState.meanThickness > 0
      ? 1 - renderState.thickness / Math.max(patchState.meanThickness, 0.001)
      : 0,
  );
  const shorelineGuidance = clamp01(
    Math.hypot(edgeState.shorelineGuidanceX, edgeState.shorelineGuidanceZ),
  );

  if (regime === "shoreBand") {
    return {
      surfaceDamping: clamp01(
        thicknessDelta * 0.4 +
          edgeState.edgeWaveDamping * 0.35 +
          patchState.shoreInfluence * 0.25,
      ),
      surfaceWarp: 0.08,
      aperiodicDetailStrength: 0.08,
      flowAnisotropy: clamp01(renderState.turbulence * 0.1),
      ribbonPinch: 0,
      wallLean: clamp01(
        shorelineGuidance * 0.4 + edgeState.wetReach * 0.2,
      ),
      seamSlopeBoost: clamp01(edgeState.edgeWaveDamping * 0.45),
      seamOpenEdgeScale: 0.75,
    };
  }

  if (regime === "channelRibbon") {
    return {
      surfaceDamping: clamp01(thicknessDelta * 0.16 + patchState.shoreInfluence * 0.1),
      surfaceWarp: 0.15,
      aperiodicDetailStrength: 0.17,
      flowAnisotropy: clamp01(
        column.flowStrength * 0.64 + patchState.meanFlow * 0.44,
      ),
      ribbonPinch: clamp01(
        (1 - edgeState.edgeContinuity) * 0.62 + thicknessDelta * 0.24 + patchState.shoreInfluence * 0.08,
      ),
      wallLean: 0,
      seamSlopeBoost: clamp01(column.flowStrength * 0.48 + renderState.turbulence * 0.12),
      seamOpenEdgeScale: 0.82,
    };
  }

  if (regime === "wallContact") {
    return {
      surfaceDamping: clamp01(
        edgeState.wallContactFactor * 0.38 +
          edgeState.edgeWaveDamping * 0.16 +
          thicknessDelta * 0.15,
      ),
      surfaceWarp: 0.11,
      aperiodicDetailStrength: 0.08,
      flowAnisotropy: clamp01(
        column.flowStrength * 0.24 + edgeState.wallContactFactor * 0.18,
      ),
      ribbonPinch: clamp01(
        edgeState.wallContactFactor * 0.26 + (1 - edgeState.edgeContinuity) * 0.08,
      ),
      wallLean: clamp01(
        edgeState.wallContactFactor * 0.88 + edgeState.wetReach * 0.34,
      ),
      seamSlopeBoost: clamp01(
        edgeState.wallContactFactor * 0.88 +
          (1 - edgeState.edgeContinuity) * 0.3 +
          edgeState.wetReach * 0.14,
      ),
      seamOpenEdgeScale: 0.42,
    };
  }

  if (regime === "dropEdge") {
    return {
      surfaceDamping: clamp01(
        column.renderState.edgeState.dropHeight * 0.22 +
          column.renderState.edgeState.edgeWaveDamping * 0.18,
      ),
      surfaceWarp: 0.17,
      aperiodicDetailStrength: 0.12,
      flowAnisotropy: clamp01(column.flowStrength * 0.24),
      ribbonPinch: 0,
      wallLean: 0,
      seamSlopeBoost: clamp01(
        column.renderState.edgeState.dropHeight * 0.72 +
          column.renderState.foamClassMask.impact * 0.34,
      ),
      seamOpenEdgeScale: 0.42,
    };
  }

  return {
    surfaceDamping: 0,
    surfaceWarp: clamp01(
      0.2 +
        patchState.meanFlow * 0.35 +
        patchState.meanTurbulence * 0.25 +
        (1 - clamp01(patchState.shoreInfluence)) * 0.1,
    ),
    aperiodicDetailStrength: clamp01(
      0.36 +
        patchState.meanFlow * 0.16 +
        patchState.meanTurbulence * 0.22 +
        (1 - clamp01(patchState.shoreInfluence)) * 0.22,
    ),
    flowAnisotropy: clamp01(patchState.meanFlow * 0.08),
    ribbonPinch: 0,
    wallLean: 0,
    seamSlopeBoost: 0,
    seamOpenEdgeScale: 1,
  };
}

export function getWaterMesherDirection(column: WaterColumnSample): [number, number] {
  const renderState = column.renderState;
  const patchState = renderState.patchState;
  const rawX =
    Math.abs(patchState.dominantWaveDirectionX) > 0.0001
      ? patchState.dominantWaveDirectionX
      : Math.abs(renderState.waveDirectionX) > 0.0001
        ? renderState.waveDirectionX
        : column.flowX;
  const rawZ =
    Math.abs(patchState.dominantWaveDirectionZ) > 0.0001
      ? patchState.dominantWaveDirectionZ
      : Math.abs(renderState.waveDirectionZ) > 0.0001
        ? renderState.waveDirectionZ
        : column.flowZ;
  const magnitude = Math.hypot(rawX, rawZ);
  if (magnitude <= 0.0001) {
    return [1, 0];
  }
  return [rawX / magnitude, rawZ / magnitude];
}
