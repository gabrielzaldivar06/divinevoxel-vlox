export type WaterPatchType =
  | "openSurface"
  | "shoreBand"
  | "channelRibbon"
  | "dropFace"
  | "enclosedPatch";

export interface WaterPatchState {
  patchId: number;
  waterBodyId: number;
  continuitySignature: number;
  patchType: WaterPatchType;
  surfaceMinX: number;
  surfaceMinZ: number;
  surfaceMaxX: number;
  surfaceMaxZ: number;
  meanSurfaceHeight: number;
  meanThickness: number;
  meanFlow: number;
  meanTurbulence: number;
  connectivityMask: number;
  dominantWaveDirectionX: number;
  dominantWaveDirectionZ: number;
  antiPeriodicitySeed: number;
  shoreInfluence: number;
}