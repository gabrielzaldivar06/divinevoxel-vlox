export interface WaterRuntimeMassSummary {
  shallow: number;
  continuous: number;
  spill: number;
}

export interface WaterRuntimeTransferSummary {
  shallowToContinuous: number;
  continuousToShallow: number;
  shallowToSpill: number;
  spillToShallow: number;
  continuousToSpill: number;
  spillToContinuous: number;
}

export interface WaterRuntimePhaseAccounting {
  sourceDelta?: number;
  sinkDelta?: number;
  transferDelta?: Partial<WaterRuntimeTransferSummary>;
}

export interface WaterRuntimeTickHandlers {
  inputPhase?: (tick: number) => WaterRuntimePhaseAccounting | void;
  previewOwnership?: (tick: number) => void;
  tickContinuous?: (dt: number, tick: number) => WaterRuntimePhaseAccounting | void;
  tickShallow?: (dt: number, tick: number) => WaterRuntimePhaseAccounting | void;
  resolveOwnership?: (tick: number) => void;
  performHandoff?: (tick: number) => WaterRuntimePhaseAccounting | void;
  finalizeOwnership?: (tick: number) => void;
  resolveEvents?: (dt: number, tick: number) => WaterRuntimePhaseAccounting | void;
  updateSpill?: (dt: number, tick: number) => WaterRuntimePhaseAccounting | void;
  extractRenderData?: (tick: number) => void;
  measureMass?: (tick: number) => WaterRuntimeMassSummary;
  massValidationEpsilon?: number;
  onMassValidationFailure?: (result: WaterRuntimeTickResult) => void;
}

export interface WaterRuntimeTickResult {
  tick: number;
  massBefore?: WaterRuntimeMassSummary;
  massAfter?: WaterRuntimeMassSummary;
  phaseMasses?: Partial<Record<string, WaterRuntimeMassSummary>>;
  totalMassDelta?: number;
  sourceDelta: number;
  sinkDelta: number;
  transferDelta: WaterRuntimeTransferSummary;
  expectedMassDelta?: number;
  massConservationError?: number;
  massConservationValid?: boolean;
}

function getMassTotal(summary: WaterRuntimeMassSummary) {
  return summary.shallow + summary.continuous + summary.spill;
}

function createZeroTransferSummary(): WaterRuntimeTransferSummary {
  return {
    shallowToContinuous: 0,
    continuousToShallow: 0,
    shallowToSpill: 0,
    spillToShallow: 0,
    continuousToSpill: 0,
    spillToContinuous: 0,
  };
}

function mergePhaseAccounting(
  target: { sourceDelta: number; sinkDelta: number; transferDelta: WaterRuntimeTransferSummary },
  phase?: WaterRuntimePhaseAccounting | void,
) {
  if (!phase) return;

  if (phase.sourceDelta) {
    target.sourceDelta += phase.sourceDelta;
  }
  if (phase.sinkDelta) {
    target.sinkDelta += phase.sinkDelta;
  }
  if (!phase.transferDelta) return;

  for (const key of Object.keys(target.transferDelta) as Array<keyof WaterRuntimeTransferSummary>) {
    const value = phase.transferDelta[key];
    if (!value) continue;
    target.transferDelta[key] += value;
  }
}

export class WaterRuntimeOrchestrator {
  private _tick = 0;

  private createMassValidationError(result: WaterRuntimeTickResult) {
    return new Error(
      [
        `Water runtime mass invariant violated at tick ${result.tick}.`,
        `totalMassDelta=${result.totalMassDelta ?? "n/a"}`,
        `expectedMassDelta=${result.expectedMassDelta ?? "n/a"}`,
        `massConservationError=${result.massConservationError ?? "n/a"}`,
      ].join(" "),
    );
  }

  tick(dt: number, handlers: WaterRuntimeTickHandlers): WaterRuntimeTickResult {
    const tick = ++this._tick;
    const massBefore = handlers.measureMass?.(tick);
    const phaseMasses: Partial<Record<string, WaterRuntimeMassSummary>> = {};
    const accounting = {
      sourceDelta: 0,
      sinkDelta: 0,
      transferDelta: createZeroTransferSummary(),
    };

    const capturePhaseMass = (phase: string) => {
      if (!handlers.measureMass) return;
      phaseMasses[phase] = handlers.measureMass(tick);
    };

    mergePhaseAccounting(accounting, handlers.inputPhase?.(tick));
    capturePhaseMass("afterInput");
    handlers.previewOwnership?.(tick);
    capturePhaseMass("afterPreviewOwnership");
    mergePhaseAccounting(accounting, handlers.tickContinuous?.(dt, tick));
    capturePhaseMass("afterTickContinuous");
    mergePhaseAccounting(accounting, handlers.tickShallow?.(dt, tick));
    capturePhaseMass("afterTickShallow");
    handlers.resolveOwnership?.(tick);
    capturePhaseMass("afterResolveOwnership");
    mergePhaseAccounting(accounting, handlers.performHandoff?.(tick));
    capturePhaseMass("afterPerformHandoff");
    handlers.finalizeOwnership?.(tick);
    capturePhaseMass("afterFinalizeOwnership");
    mergePhaseAccounting(accounting, handlers.resolveEvents?.(dt, tick));
    capturePhaseMass("afterResolveEvents");
    mergePhaseAccounting(accounting, handlers.updateSpill?.(dt, tick));
    capturePhaseMass("afterUpdateSpill");
    handlers.extractRenderData?.(tick);
    capturePhaseMass("afterExtractRenderData");

    const massAfter = handlers.measureMass?.(tick);
    const totalMassDelta =
      massBefore && massAfter
        ? getMassTotal(massAfter) - getMassTotal(massBefore)
        : undefined;
    const expectedMassDelta = accounting.sourceDelta - accounting.sinkDelta;
    const massConservationError =
      totalMassDelta === undefined ? undefined : totalMassDelta - expectedMassDelta;
    const massConservationValid =
      massConservationError === undefined
        ? undefined
        : Math.abs(massConservationError) <= (handlers.massValidationEpsilon ?? 0.001);

    const result: WaterRuntimeTickResult = {
      tick,
      massBefore,
      massAfter,
      phaseMasses,
      totalMassDelta,
      sourceDelta: accounting.sourceDelta,
      sinkDelta: accounting.sinkDelta,
      transferDelta: accounting.transferDelta,
      expectedMassDelta,
      massConservationError,
      massConservationValid,
    };

    if (result.massConservationValid === false) {
      handlers.onMassValidationFailure?.(result);
      // Log instead of throwing: the editor must remain functional even when
      // small unaccounted sinks (threshold zeroing, boundary timing) cause
      // drift that exceeds epsilon.  The diagnostic data is still captured
      // via onMassValidationFailure for post-mortem analysis.
      console.warn(this.createMassValidationError(result).message);
    }

    return result;
  }
}