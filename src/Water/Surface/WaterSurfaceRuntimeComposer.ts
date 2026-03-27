import { EngineSettings } from "../../Settings/EngineSettings";
import type { WaterSectionGrid } from "../Types/WaterTypes";
import type { WaterSurfaceMesherOptions } from "./WaterSurfaceMesher.types";

export type WaterSurfaceComposerDispatch = {
  meshDropEdgeWater: (
    grid: WaterSectionGrid,
    options?: WaterSurfaceMesherOptions,
  ) => boolean;
  meshContinuousLargePatchWater: (
    grid: WaterSectionGrid,
    options?: WaterSurfaceMesherOptions,
  ) => boolean;
  meshOpenSurfaceWaterLegacyFallback: (
    grid: WaterSectionGrid,
    options?: WaterSurfaceMesherOptions,
  ) => boolean;
  meshShoreBandWaterLegacyFallback: (
    grid: WaterSectionGrid,
    options?: WaterSurfaceMesherOptions,
  ) => boolean;
  meshOpenSurfaceWaterByPatchSystem: (
    grid: WaterSectionGrid,
    options?: WaterSurfaceMesherOptions,
  ) => boolean;
  meshShoreBandWaterByPatchSystem: (
    grid: WaterSectionGrid,
    options?: WaterSurfaceMesherOptions,
  ) => boolean;
  meshOpenSurfaceWater: (
    grid: WaterSectionGrid,
    options?: WaterSurfaceMesherOptions,
  ) => boolean;
  meshShoreBandWater: (
    grid: WaterSectionGrid,
    options?: WaterSurfaceMesherOptions,
  ) => boolean;
  meshChannelRibbonWater: (
    grid: WaterSectionGrid,
    options?: WaterSurfaceMesherOptions,
  ) => boolean;
  meshWallContactWater: (
    grid: WaterSectionGrid,
    options?: WaterSurfaceMesherOptions,
  ) => boolean;
};

export function meshWaterSurfaceComposer(
  grid: WaterSectionGrid,
  options: WaterSurfaceMesherOptions | undefined,
  dispatch: WaterSurfaceComposerDispatch,
): boolean {
  let emitted = false;
  emitted = dispatch.meshDropEdgeWater(grid, options) || emitted;

  if (EngineSettings.settings.water.largeWaterVisibleMode === "continuous-patch") {
    emitted = dispatch.meshContinuousLargePatchWater(grid, options) || emitted;
    emitted = dispatch.meshOpenSurfaceWaterLegacyFallback(grid, options) || emitted;
    emitted = dispatch.meshShoreBandWaterLegacyFallback(grid, options) || emitted;
  } else if (EngineSettings.settings.water.largeWaterVisibleMode === "patch-preview") {
    emitted = dispatch.meshOpenSurfaceWaterByPatchSystem(grid, options) || emitted;
    emitted = dispatch.meshOpenSurfaceWaterLegacyFallback(grid, options) || emitted;
    emitted = dispatch.meshShoreBandWaterByPatchSystem(grid, options) || emitted;
    emitted = dispatch.meshShoreBandWaterLegacyFallback(grid, options) || emitted;
  } else {
    emitted = dispatch.meshOpenSurfaceWater(grid, options) || emitted;
    emitted = dispatch.meshShoreBandWater(grid, options) || emitted;
  }

  emitted = dispatch.meshChannelRibbonWater(grid, options) || emitted;
  emitted = dispatch.meshWallContactWater(grid, options) || emitted;
  return emitted;
}