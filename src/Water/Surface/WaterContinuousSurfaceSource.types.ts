import type { WaterColumnSample, WaterSectionGrid } from "../Types/WaterTypes";

// Continuous visible meshing consumes extracted surface-source data, not
// authoritative runtime solver state directly. The runtime remains upstream;
// this type names the stable handoff boundary used by the visible path.
export type ContinuousSurfaceColumnSource = WaterColumnSample;
export type ContinuousSurfaceSectionSource = WaterSectionGrid;