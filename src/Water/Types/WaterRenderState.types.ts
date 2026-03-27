import type { WaterSurfaceClass } from "./WaterTypes";
import type { WaterEdgeState } from "./WaterEdgeState.types";
import type { WaterPatchState } from "./WaterPatchState.types";

export type WaterPorosityClass = "unknown" | "low" | "medium" | "high";

export interface WaterFoamClassMask {
  crest: number;
  edge: number;
  impact: number;
}

export interface WaterRenderState {
  bottomHeight: number;
  thickness: number;
  bankSlope: number;
  turbulence: number;
  foamPotential: number;
  foamClassMask: WaterFoamClassMask;
  surfaceWetness: number;
  wetnessPotential: number;
  wetnessAge: number;
  dryingRate: number;
  openWaterEvaporation: number;
  soilEvaporation: number;
  drainage: number;
  transpirationPotential: number;
  flowAccumulation: number;
  erosionPotential: number;
  depositionPotential: number;
  turbidity: number;
  porosityClass: WaterPorosityClass;
  waterBodyId: number;
  waterBodyType: WaterSurfaceClass;
  waveDirectionX: number;
  waveDirectionZ: number;
  antiPeriodicityDomain: number;
  edgeState: WaterEdgeState;
  patchState: WaterPatchState;
}