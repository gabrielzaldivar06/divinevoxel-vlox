export type WaterEdgeType =
  | "none"
  | "shore"
  | "wallContact"
  | "drop"
  | "enclosed"
  | "thinChannel";

export interface WaterEdgeState {
  edgeType: WaterEdgeType;
  dropHeight: number;
  terrainContactNormalX: number;
  terrainContactNormalY: number;
  terrainContactNormalZ: number;
  edgeVisibility: number;
  edgeContinuity: number;
  edgeFoamPotential: number;
  edgeWaveDamping: number;
  shorelineGuidanceX: number;
  shorelineGuidanceZ: number;
  wetReach: number;
  interactionInfluence: number;
  wallContactFactor: number;
}