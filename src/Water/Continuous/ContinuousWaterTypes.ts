import type {
  WaterColumnAuthority,
  WaterOwnershipDomain,
} from "../Contracts/WaterSemanticContract.js";

export interface ContinuousWaterColumn {
  active: boolean;
  mass: number;
  bedY: number;
  surfaceY: number;
  depth: number;
  velocityX: number;
  velocityZ: number;
  pressure: number;
  bodyId: number;
  openWaterFactor: number;
  shoreFactor: number;
  ownershipLocked: boolean;
  turbulence: number;
  foamPotential: number;
  handoffPending: boolean;
  pendingInboundMass: number;
  pendingOutboundMass: number;
  lastResolvedTick: number;
  ownershipDomain: WaterOwnershipDomain;
  ownershipConfidence: number;
  ownershipTicks: number;
  authority: WaterColumnAuthority;
}

export type ContinuousToShallowCallback = (
  worldX: number,
  worldZ: number,
  bedY: number,
  surfaceY: number,
  depth: number,
  bodyId: number,
) => number;

export interface ContinuousWaterSection {
  originX: number;
  originZ: number;
  sizeX: number;
  sizeZ: number;
  columns: ContinuousWaterColumn[];
  lastTickDt: number;
  topologyVersion: number;
}

export interface ContinuousWaterConfig {
  conductance: number;
  maxFluxPerTickRatio: number;
  velocityDamping: number;
  minActiveDepth: number;
  promoteDepth: number;
  demoteDepth: number;
}

export const DEFAULT_CONTINUOUS_WATER_CONFIG: ContinuousWaterConfig = {
  conductance: 0.85,
  maxFluxPerTickRatio: 0.28,
  velocityDamping: 0.9,
  minActiveDepth: 0.01,
  promoteDepth: 0.5,
  demoteDepth: 0.18,
};

export function createEmptyContinuousColumn(): ContinuousWaterColumn {
  return {
    active: false,
    mass: 0,
    bedY: 0,
    surfaceY: 0,
    depth: 0,
    velocityX: 0,
    velocityZ: 0,
    pressure: 0,
    bodyId: 0,
    openWaterFactor: 0,
    shoreFactor: 0,
    ownershipLocked: false,
    turbulence: 0,
    foamPotential: 0,
    handoffPending: false,
    pendingInboundMass: 0,
    pendingOutboundMass: 0,
    lastResolvedTick: 0,
    ownershipDomain: "none",
    ownershipConfidence: 0,
    ownershipTicks: 0,
    authority: "bootstrap",
  };
}