import type { WaterRuntimePhaseAccounting } from "../Runtime/WaterRuntimeOrchestrator.js";
import {
  activatePendingSpillEmitters,
  clearAllSpillEmitters,
  clearSpillEmitterSectionOwnership,
  getActiveSpillEmitters as getRegisteredActiveSpillEmitters,
  getPendingSpillEmitterCount as getRegisteredPendingSpillEmitterCount,
  getPendingSpillEmitters,
  queuePendingSpillEmitter,
  removeActiveSpillEmitter,
} from "./SpillEmitterRegistry.js";
import type {
  SpillEmitter,
  SpillEmitterRuntime,
  SpillLandingCallbacks,
  SpillSourceDomain,
  SpillTargetDomain,
  SpillTransferRequest,
  SpillWaterUpdateSummary,
} from "./SpillTypes.js";

export type {
  SpillEmitter,
  SpillEmitterRuntime,
  SpillLandingCallbacks,
  SpillSourceDomain,
  SpillTargetDomain,
  SpillTransferRequest,
  SpillWaterUpdateSummary,
} from "./SpillTypes.js";

const DEFAULT_FALL_SPEED = 12;
const MIN_TRAVEL_TIME_SECONDS = 0.05;
const MAX_TRAVEL_TIME_SECONDS = 0.75;
const MIN_SPILL_MASS = 0.0001;

let spillEmitterId = 1;

function createAccounting(): WaterRuntimePhaseAccounting {
  return {
    sourceDelta: 0,
    sinkDelta: 0,
    transferDelta: {},
  };
}

function appendTransfer(
  accounting: WaterRuntimePhaseAccounting,
  key: keyof NonNullable<WaterRuntimePhaseAccounting["transferDelta"]>,
  mass: number,
) {
  if (mass <= 0) return;
  accounting.transferDelta ??= {};
  accounting.transferDelta[key] = (accounting.transferDelta[key] ?? 0) + mass;
}

function resolveTravelTimeSeconds(request: SpillTransferRequest) {
  if (request.travelTimeSeconds && request.travelTimeSeconds > 0) {
    return request.travelTimeSeconds;
  }

  const fallHeight = Math.max(0, request.fallHeight ?? 0);
  if (fallHeight <= 0) return MIN_TRAVEL_TIME_SECONDS;
  return Math.min(
    MAX_TRAVEL_TIME_SECONDS,
    Math.max(MIN_TRAVEL_TIME_SECONDS, fallHeight / DEFAULT_FALL_SPEED),
  );
}

function createEmitter(request: SpillTransferRequest): SpillEmitterRuntime {
  const id = spillEmitterId++;
  const fallHeight = Math.max(0, request.fallHeight ?? 0);
  const travelTimeSeconds = resolveTravelTimeSeconds(request);
  return {
    id,
    worldX: request.worldX,
    worldY: request.worldY,
    worldZ: request.worldZ,
    flowRate: request.mass / Math.max(travelTimeSeconds, MIN_TRAVEL_TIME_SECONDS),
    fallHeight,
    sourceSectionKey: request.sourceSectionKey,
    targetSectionKey: request.targetSectionKey,
    sourceDomain: request.sourceDomain,
    targetDomain: request.targetDomain,
    remainingMass: request.mass,
    landingSurfaceY: request.landingSurfaceY,
    elapsedSeconds: 0,
    travelTimeSeconds,
  };
}

export function queueSpillTransfer(request: SpillTransferRequest) {
  if (request.mass <= MIN_SPILL_MASS) return 0;
  const emitter = createEmitter(request);
  queuePendingSpillEmitter(emitter);
  return emitter.id;
}

export function measureSpillWaterMass() {
  let total = 0;
  for (const emitter of getPendingSpillEmitters()) {
    total += emitter.remainingMass;
  }
  const activeEmitters = getRegisteredActiveSpillEmitters();
  for (const emitter of activeEmitters.values()) {
    total += emitter.remainingMass;
  }
  return total;
}

export function getActiveSpillEmitters(): ReadonlyMap<number, SpillEmitterRuntime> {
  return getRegisteredActiveSpillEmitters();
}

export function getPendingSpillEmitterCount() {
  return getRegisteredPendingSpillEmitterCount();
}

export function removeSpillEmittersForSection(sectionKey: string) {
  // Section unload must not delete in-flight spill mass.
  clearSpillEmitterSectionOwnership(sectionKey);
}

export function clearAllSpillWater() {
  clearAllSpillEmitters();
}

export function updateSpillWater(
  dt: number,
  landingCallbacks: SpillLandingCallbacks,
): SpillWaterUpdateSummary {
  const accounting = createAccounting();
  const clampedDt = Math.max(0, Math.min(dt, 0.1));
  const activeEmitters = getRegisteredActiveSpillEmitters();

  const activatedEmitters = activatePendingSpillEmitters();
  const activatedEmitterCount = activatedEmitters.length;

  for (const emitter of activatedEmitters) {
    if (emitter.sourceDomain === "shallow") {
      appendTransfer(accounting, "shallowToSpill", emitter.remainingMass);
    } else {
      appendTransfer(accounting, "continuousToSpill", emitter.remainingMass);
    }
  }

  const emittersToDelete: number[] = [];
  let completedEmitterCount = 0;

  for (const emitter of activeEmitters.values()) {
    emitter.elapsedSeconds += clampedDt;
    if (emitter.elapsedSeconds + 1e-6 < emitter.travelTimeSeconds) {
      continue;
    }

    const acceptedMassRaw =
      emitter.targetDomain === "continuous"
        ? landingCallbacks.landToContinuous(
            emitter.worldX,
            emitter.worldZ,
            emitter.landingSurfaceY,
            emitter.remainingMass,
            emitter.id,
          )
        : landingCallbacks.landToShallow(
            emitter.worldX,
            emitter.worldZ,
            emitter.landingSurfaceY,
            emitter.remainingMass,
            emitter.id,
          );

    const acceptedMass = Math.max(0, Math.min(acceptedMassRaw, emitter.remainingMass));
    if (acceptedMass <= 0) {
      continue;
    }

    emitter.remainingMass = Math.max(0, emitter.remainingMass - acceptedMass);
    emitter.flowRate = emitter.remainingMass / Math.max(MIN_TRAVEL_TIME_SECONDS, emitter.travelTimeSeconds);

    if (emitter.targetDomain === "continuous") {
      appendTransfer(accounting, "spillToContinuous", acceptedMass);
    } else {
      appendTransfer(accounting, "spillToShallow", acceptedMass);
    }

    if (emitter.remainingMass <= MIN_SPILL_MASS) {
      emittersToDelete.push(emitter.id);
      completedEmitterCount += 1;
    } else {
      emitter.elapsedSeconds = emitter.travelTimeSeconds;
    }
  }

  for (const emitterId of emittersToDelete) {
    removeActiveSpillEmitter(emitterId);
  }

  return {
    accounting,
    activeEmitterCount: activeEmitters.size,
    pendingEmitterCount: getRegisteredPendingSpillEmitterCount(),
    activatedEmitterCount,
    completedEmitterCount,
    spillMass: measureSpillWaterMass(),
  };
}