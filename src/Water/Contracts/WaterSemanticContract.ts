export type WaterOwnershipDomain =
  | "none"
  | "shallow"
  | "continuous"
  | "spill"
  | "far";

export type RuntimeWaterOwnershipDomain = Extract<
  WaterOwnershipDomain,
  "none" | "shallow" | "continuous"
>;

export type WaterColumnAuthority =
  | "bootstrap"
  | "editor"
  | "player"
  | "continuous-handoff"
  | "spill-handoff"
  | "rain";

export type WaterHandoffDisposition = "accepted" | "deferred" | "rejected";

export type ShallowHandoffResult = WaterHandoffDisposition;

export interface WaterHandoffTransferResult {
  acceptedMass: number;
  disposition: WaterHandoffDisposition;
}
