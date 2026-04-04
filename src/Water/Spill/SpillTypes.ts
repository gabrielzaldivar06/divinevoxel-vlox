import type { WaterRuntimePhaseAccounting } from "../Runtime/WaterRuntimeOrchestrator.js";

export type SpillSourceDomain = "shallow" | "continuous";
export type SpillTargetDomain = "shallow" | "continuous";
export type SpillFxProfile = "default" | "waterball";

export interface SpillEmitter {
  id: number;
  worldX: number;
  worldY: number;
  worldZ: number;
  flowRate: number;
  fallHeight: number;
  fxProfile: SpillFxProfile;
  sourceSectionKey?: string;
  targetSectionKey?: string;
}

export interface SpillTransferRequest {
  sourceDomain: SpillSourceDomain;
  targetDomain: SpillTargetDomain;
  worldX: number;
  worldY: number;
  worldZ: number;
  landingSurfaceY: number;
  mass: number;
  fallHeight?: number;
  travelTimeSeconds?: number;
  fxProfile?: SpillFxProfile;
  sourceSectionKey?: string;
  targetSectionKey?: string;
}

export interface SpillEmitterRuntime extends SpillEmitter {
  sourceDomain: SpillSourceDomain;
  targetDomain: SpillTargetDomain;
  remainingMass: number;
  landingSurfaceY: number;
  elapsedSeconds: number;
  travelTimeSeconds: number;
}

export interface SpillLandingCallbacks {
  landToShallow: (worldX: number, worldZ: number, surfaceY: number, mass: number, emitterId: number, emitter: SpillEmitterRuntime) => number;
  landToContinuous: (worldX: number, worldZ: number, surfaceY: number, mass: number, emitterId: number, emitter: SpillEmitterRuntime) => number;
}

export interface SpillWaterUpdateSummary {
  accounting: WaterRuntimePhaseAccounting;
  activeEmitterCount: number;
  pendingEmitterCount: number;
  activatedEmitterCount: number;
  completedEmitterCount: number;
  spillMass: number;
}