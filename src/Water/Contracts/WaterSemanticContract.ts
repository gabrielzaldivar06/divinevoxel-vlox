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

export type ShallowHandoffResult = "accepted" | "deferred" | "rejected";