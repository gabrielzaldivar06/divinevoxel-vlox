type HydrologyMetricsSnapshot = {
  flowEnabled: boolean;
  tickCount: number;
  lastTickMs: number;
  avgTickMs: number;
  pendingVoxelUpdates: number;
  liquidRuns: number;
  liquidSchedules: number;
  diagonalSpills: number;
  lateralEqualizations: number;
  terraceHoldCandidates: number;
  worldFlowActivations: number;
  settledTickStreak: number;
  settled: boolean;
  equilibriumTimeMs: number | null;
  worldAgeMs: number;
};

type HydrologyMetricsState = HydrologyMetricsSnapshot & {
  worldStartMs: number;
  lastTickStartMs: number;
  lastActiveWorldAgeMs: number;
};

const state: HydrologyMetricsState = {
  flowEnabled: false,
  tickCount: 0,
  lastTickMs: 0,
  avgTickMs: 0,
  pendingVoxelUpdates: 0,
  liquidRuns: 0,
  liquidSchedules: 0,
  diagonalSpills: 0,
  lateralEqualizations: 0,
  terraceHoldCandidates: 0,
  worldFlowActivations: 0,
  settledTickStreak: 0,
  settled: false,
  equilibriumTimeMs: null,
  worldAgeMs: 0,
  worldStartMs: 0,
  lastTickStartMs: 0,
  lastActiveWorldAgeMs: 0,
};

export function resetHydrologyDebugMetrics(flowEnabled = false) {
  state.flowEnabled = flowEnabled;
  state.tickCount = 0;
  state.lastTickMs = 0;
  state.avgTickMs = 0;
  state.pendingVoxelUpdates = 0;
  state.liquidRuns = 0;
  state.liquidSchedules = 0;
  state.diagonalSpills = 0;
  state.lateralEqualizations = 0;
  state.terraceHoldCandidates = 0;
  state.worldFlowActivations = 0;
  state.settledTickStreak = 0;
  state.settled = false;
  state.equilibriumTimeMs = null;
  state.worldAgeMs = 0;
  state.worldStartMs = 0;
  state.lastTickStartMs = 0;
  state.lastActiveWorldAgeMs = 0;
}

export function setHydrologyDebugWorldStart(nowMs: number, flowEnabled: boolean) {
  state.worldStartMs = nowMs;
  state.lastTickStartMs = nowMs;
  state.flowEnabled = flowEnabled;
}

export function beginHydrologyDebugTick(nowMs: number) {
  state.lastTickStartMs = nowMs;
  state.liquidRuns = 0;
  state.liquidSchedules = 0;
  state.diagonalSpills = 0;
  state.lateralEqualizations = 0;
  state.terraceHoldCandidates = 0;
  state.worldFlowActivations = 0;
}

export function recordHydrologyLiquidRun() {
  state.liquidRuns++;
}

export function recordHydrologyLiquidSchedule() {
  state.liquidSchedules++;
}

export function recordHydrologyDiagonalSpill() {
  state.diagonalSpills++;
}

export function recordHydrologyLateralEqualization() {
  state.lateralEqualizations++;
}

export function recordHydrologyTerraceHoldCandidate() {
  state.terraceHoldCandidates++;
}

export function recordHydrologyWorldFlowActivation() {
  state.worldFlowActivations++;
}

export function endHydrologyDebugTick(nowMs: number, pendingVoxelUpdates: number) {
  state.tickCount++;
  state.lastTickMs = Math.max(0, nowMs - state.lastTickStartMs);
  state.avgTickMs += (state.lastTickMs - state.avgTickMs) / state.tickCount;
  state.pendingVoxelUpdates = pendingVoxelUpdates;
  state.worldAgeMs = state.worldStartMs > 0 ? Math.max(0, nowMs - state.worldStartMs) : 0;

  const active =
    pendingVoxelUpdates > 0 ||
    state.liquidRuns > 0 ||
    state.liquidSchedules > 0 ||
    state.diagonalSpills > 0 ||
    state.lateralEqualizations > 0 ||
    state.terraceHoldCandidates > 0 ||
    state.worldFlowActivations > 0;

  if (active) {
    state.settledTickStreak = 0;
    state.settled = false;
    state.lastActiveWorldAgeMs = state.worldAgeMs;
    return;
  }

  state.settledTickStreak++;
  if (state.settledTickStreak >= 10) {
    state.settled = true;
    if (state.equilibriumTimeMs == null) {
      state.equilibriumTimeMs = state.worldAgeMs;
    }
  }
}

export function getHydrologyDebugMetricsSnapshot(): HydrologyMetricsSnapshot {
  return {
    flowEnabled: state.flowEnabled,
    tickCount: state.tickCount,
    lastTickMs: state.lastTickMs,
    avgTickMs: state.avgTickMs,
    pendingVoxelUpdates: state.pendingVoxelUpdates,
    liquidRuns: state.liquidRuns,
    liquidSchedules: state.liquidSchedules,
    diagonalSpills: state.diagonalSpills,
    lateralEqualizations: state.lateralEqualizations,
    terraceHoldCandidates: state.terraceHoldCandidates,
    worldFlowActivations: state.worldFlowActivations,
    settledTickStreak: state.settledTickStreak,
    settled: state.settled,
    equilibriumTimeMs: state.equilibriumTimeMs,
    worldAgeMs: state.worldAgeMs,
  };
}