import type { WaterRuntimePhaseAccounting } from "./WaterRuntimeOrchestrator.js";

export interface WaterRuntimeGate {
  id: string;
  worldX: number;
  worldZ: number;
  width: number;
  invertHeight: number;
  openness: number;
  maxDischargeRate: number;
}

export interface WaterGateState {
  gate: WaterRuntimeGate;
  accumulatedDischarge: number;
  lastUpstreamPressure: number;
  lastDownstreamHeight: number;
  lastDischargeRate: number;
  activeTicks: number;
}

export interface WaterGateDischargeRequest {
  gateId: string;
  worldX: number;
  worldZ: number;
  landingSurfaceY: number;
  dischargeMass: number;
  fallHeight: number;
}

export interface WaterGateTickDeps {
  getUpstreamPressure: (worldX: number, worldZ: number) => number;
  getDownstreamSurfaceY: (worldX: number, worldZ: number) => number;
  getUpstreamSurfaceY: (worldX: number, worldZ: number) => number;
  removeContinuousMass: (worldX: number, worldZ: number, mass: number) => number;
  queueSpillTransfer: (
    worldX: number,
    worldZ: number,
    landingSurfaceY: number,
    mass: number,
    fallHeight: number,
  ) => void;
}

const GRAVITY = 9.81;
const DISCHARGE_COEFFICIENT = 0.61;
const MIN_DISCHARGE_MASS = 0.0001;
const MIN_HEAD_DIFFERENCE = 0.02;

const gates = new Map<string, WaterGateState>();

export function addGate(gate: WaterRuntimeGate): void {
  gates.set(gate.id, {
    gate: { ...gate },
    accumulatedDischarge: 0,
    lastUpstreamPressure: 0,
    lastDownstreamHeight: 0,
    lastDischargeRate: 0,
    activeTicks: 0,
  });
}

export function removeGate(gateId: string): void {
  gates.delete(gateId);
}

export function getGate(gateId: string): WaterGateState | undefined {
  return gates.get(gateId);
}

export function setGateOpenness(gateId: string, openness: number): void {
  const state = gates.get(gateId);
  if (!state) return;
  state.gate.openness = Math.max(0, Math.min(1, openness));
}

export function getActiveGates(): ReadonlyMap<string, WaterGateState> {
  return gates;
}

export function getGateCount(): number {
  return gates.size;
}

export function clearAllGates(): void {
  gates.clear();
}

/**
 * Compute discharge rate for a gate using a simplified weir/orifice formula.
 *
 * Q = Cd * openness * width * sqrt(2 * g * headDifference)
 *
 * The result is clamped to the gate's maxDischargeRate and the upstream
 * available mass to prevent over-extraction.
 */
export function computeGateDischarge(
  gate: WaterRuntimeGate,
  upstreamPressure: number,
  upstreamSurfaceY: number,
  downstreamSurfaceY: number,
  dt: number,
): number {
  if (gate.openness <= 0) return 0;

  const headDifference = upstreamSurfaceY - Math.max(downstreamSurfaceY, gate.invertHeight);
  if (headDifference < MIN_HEAD_DIFFERENCE) return 0;

  const effectiveHead = headDifference + upstreamPressure * 0.1;
  const flowRate =
    DISCHARGE_COEFFICIENT *
    gate.openness *
    gate.width *
    Math.sqrt(2 * GRAVITY * Math.max(0, effectiveHead));

  const dischargeMass = Math.min(flowRate * dt, gate.maxDischargeRate * dt);
  return dischargeMass;
}

/**
 * Tick all gates: compute discharge, remove mass from upstream, queue spill
 * transfers for downstream delivery. Returns phase accounting.
 */
export function tickGates(
  dt: number,
  deps: WaterGateTickDeps,
): WaterRuntimePhaseAccounting {
  const accounting: WaterRuntimePhaseAccounting = {
    sourceDelta: 0,
    sinkDelta: 0,
    transferDelta: {},
  };

  for (const [, state] of gates) {
    const { gate } = state;

    const upstreamPressure = deps.getUpstreamPressure(gate.worldX, gate.worldZ);
    const upstreamSurfaceY = deps.getUpstreamSurfaceY(gate.worldX, gate.worldZ);
    const downstreamSurfaceY = deps.getDownstreamSurfaceY(gate.worldX, gate.worldZ);

    state.lastUpstreamPressure = upstreamPressure;
    state.lastDownstreamHeight = downstreamSurfaceY;

    const dischargeMass = computeGateDischarge(
      gate,
      upstreamPressure,
      upstreamSurfaceY,
      downstreamSurfaceY,
      dt,
    );

    if (dischargeMass < MIN_DISCHARGE_MASS) {
      state.lastDischargeRate = 0;
      continue;
    }

    const actualRemoved = deps.removeContinuousMass(gate.worldX, gate.worldZ, dischargeMass);
    if (actualRemoved < MIN_DISCHARGE_MASS) {
      state.lastDischargeRate = 0;
      continue;
    }

    const fallHeight = Math.max(0, upstreamSurfaceY - downstreamSurfaceY);
    deps.queueSpillTransfer(
      gate.worldX,
      gate.worldZ,
      downstreamSurfaceY,
      actualRemoved,
      fallHeight,
    );

    state.accumulatedDischarge += actualRemoved;
    state.lastDischargeRate = actualRemoved / dt;
    state.activeTicks++;

    accounting.transferDelta ??= {};
    accounting.transferDelta.continuousToSpill =
      (accounting.transferDelta.continuousToSpill ?? 0) + actualRemoved;
  }

  return accounting;
}
