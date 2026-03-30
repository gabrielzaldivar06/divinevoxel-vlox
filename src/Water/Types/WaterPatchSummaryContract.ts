import type { WaterPatchState, WaterPatchType } from "./WaterPatchState.types";

export const WATER_PATCH_SUMMARY_STRIDE = 12;
export const WATER_PATCH_SUMMARY_SURFACE_MIN_X_INDEX = 0;
export const WATER_PATCH_SUMMARY_SURFACE_MIN_Z_INDEX = 1;
export const WATER_PATCH_SUMMARY_SURFACE_MAX_X_INDEX = 2;
export const WATER_PATCH_SUMMARY_SURFACE_MAX_Z_INDEX = 3;
export const WATER_PATCH_SUMMARY_MEAN_SURFACE_HEIGHT_INDEX = 4;
export const WATER_PATCH_SUMMARY_MEAN_THICKNESS_INDEX = 5;
export const WATER_PATCH_SUMMARY_MEAN_FLOW_INDEX = 6;
export const WATER_PATCH_SUMMARY_MEAN_TURBULENCE_INDEX = 7;
export const WATER_PATCH_SUMMARY_WAVE_DIRECTION_X_INDEX = 8;
export const WATER_PATCH_SUMMARY_WAVE_DIRECTION_Z_INDEX = 9;
export const WATER_PATCH_SUMMARY_SHORE_INFLUENCE_INDEX = 10;
export const WATER_PATCH_SUMMARY_ANTI_PERIODICITY_SEED_INDEX = 11;

export type WaterPatchSummaryEntry = {
  patchType: WaterPatchType;
  connectivityMask: number;
  waterBodyId: number;
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
  antiPeriodicitySeed: number;
};

export function encodeWaterPatchTypeId(patchType: WaterPatchType) {
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

export function decodeWaterPatchTypeId(typeId: number): WaterPatchType {
  switch (typeId & 0x7) {
    case 1:
      return "shoreBand";
    case 2:
      return "channelRibbon";
    case 3:
      return "dropFace";
    case 4:
      return "enclosedPatch";
    default:
      return "openSurface";
  }
}

export function packWaterPatchMetadata(
  patch: Pick<WaterPatchState, "patchType" | "connectivityMask" | "waterBodyId">,
) {
  return (
    (encodeWaterPatchTypeId(patch.patchType) & 0x7) |
    ((patch.connectivityMask & 0xf) << 3) |
    ((Math.max(0, Math.min(0xffff, patch.waterBodyId)) & 0xffff) << 8)
  ) >>> 0;
}

export function unpackWaterPatchMetadata(metadata: number) {
  return {
    patchType: decodeWaterPatchTypeId(metadata & 0x7),
    connectivityMask: (metadata >>> 3) & 0xf,
    waterBodyId: (metadata >>> 8) & 0xffff,
  };
}

export function readWaterPatchSummaryEntry(
  patchSummaryBuffer: Float32Array,
  patchSummaryStride: number,
  patchMetadata: Uint32Array,
  patchSummaryCount: number,
  summaryIndex: number,
): WaterPatchSummaryEntry | null {
  if (
    patchSummaryStride < WATER_PATCH_SUMMARY_STRIDE ||
    summaryIndex < 0 ||
    summaryIndex >= patchSummaryCount ||
    summaryIndex >= patchMetadata.length
  ) {
    return null;
  }

  const baseIndex = summaryIndex * patchSummaryStride;
  if (baseIndex + WATER_PATCH_SUMMARY_ANTI_PERIODICITY_SEED_INDEX >= patchSummaryBuffer.length) {
    return null;
  }

  const metadata = unpackWaterPatchMetadata(patchMetadata[summaryIndex] ?? 0);
  return {
    ...metadata,
    surfaceMinX: patchSummaryBuffer[baseIndex + WATER_PATCH_SUMMARY_SURFACE_MIN_X_INDEX] ?? 0,
    surfaceMinZ: patchSummaryBuffer[baseIndex + WATER_PATCH_SUMMARY_SURFACE_MIN_Z_INDEX] ?? 0,
    surfaceMaxX: patchSummaryBuffer[baseIndex + WATER_PATCH_SUMMARY_SURFACE_MAX_X_INDEX] ?? 0,
    surfaceMaxZ: patchSummaryBuffer[baseIndex + WATER_PATCH_SUMMARY_SURFACE_MAX_Z_INDEX] ?? 0,
    meanSurfaceHeight:
      patchSummaryBuffer[baseIndex + WATER_PATCH_SUMMARY_MEAN_SURFACE_HEIGHT_INDEX] ?? 0,
    meanThickness: patchSummaryBuffer[baseIndex + WATER_PATCH_SUMMARY_MEAN_THICKNESS_INDEX] ?? 0,
    meanFlow: patchSummaryBuffer[baseIndex + WATER_PATCH_SUMMARY_MEAN_FLOW_INDEX] ?? 0,
    meanTurbulence:
      patchSummaryBuffer[baseIndex + WATER_PATCH_SUMMARY_MEAN_TURBULENCE_INDEX] ?? 0,
    dominantWaveDirectionX:
      patchSummaryBuffer[baseIndex + WATER_PATCH_SUMMARY_WAVE_DIRECTION_X_INDEX] ?? 0,
    dominantWaveDirectionZ:
      patchSummaryBuffer[baseIndex + WATER_PATCH_SUMMARY_WAVE_DIRECTION_Z_INDEX] ?? 0,
    shoreInfluence:
      patchSummaryBuffer[baseIndex + WATER_PATCH_SUMMARY_SHORE_INFLUENCE_INDEX] ?? 0,
    antiPeriodicitySeed:
      patchSummaryBuffer[baseIndex + WATER_PATCH_SUMMARY_ANTI_PERIODICITY_SEED_INDEX] ?? 0,
  };
}