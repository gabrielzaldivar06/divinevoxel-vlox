import {
  performContinuousWaterHandoffs,
  type ContinuousWaterHandoffSummary,
} from "../Continuous/ContinuousWaterSectionState.js";
import type { ContinuousToShallowCallback } from "../Continuous/ContinuousWaterTypes.js";
import {
  performShallowBoundaryFluxes,
  performShallowWaterHandoffsWithResolver,
  type ShallowHandoffCallback,
  type ShallowWaterHandoffSummary,
} from "../Shallow/ShallowWaterSectionState.js";
import type { ShallowBoundaryFluxRegistry } from "../Shallow/ShallowBoundaryFluxRegistry.js";
import {
  DEFAULT_CONTINUOUS_WATER_CONFIG,
  type ContinuousWaterConfig,
} from "../Continuous/ContinuousWaterTypes.js";
import type { WaterRuntimePhaseAccounting } from "./WaterRuntimeOrchestrator.js";

export interface WaterTransferResolverHandlers {
  shallowToContinuous: ShallowHandoffCallback;
  continuousToShallow: ContinuousToShallowCallback;
}

export interface WaterTransferResolverSummary {
  shallow: ShallowWaterHandoffSummary;
  continuous: ContinuousWaterHandoffSummary;
  accounting: WaterRuntimePhaseAccounting;
}

export class WaterTransferResolver {
  constructor(private readonly handlers: WaterTransferResolverHandlers) {}

  resolve(
    shallowBoundaryRegistry: ShallowBoundaryFluxRegistry,
    options: {
      continuousConfig?: ContinuousWaterConfig;
    } = {},
  ): WaterTransferResolverSummary {
    const continuous = performContinuousWaterHandoffs(
      options.continuousConfig ?? DEFAULT_CONTINUOUS_WATER_CONFIG,
      this.handlers.continuousToShallow,
    );
    const shallow = performShallowWaterHandoffsWithResolver(
      this.handlers.shallowToContinuous,
    );
    performShallowBoundaryFluxes(shallowBoundaryRegistry);

    return {
      shallow,
      continuous,
      accounting: {
        transferDelta: {
          shallowToContinuous: shallow.transferredMassToContinuous,
          continuousToShallow: continuous.transferredMassToShallow,
        },
      },
    };
  }
}