import type { SpillEmitterRuntime } from "./SpillTypes.js";

const pendingTransfers: SpillEmitterRuntime[] = [];
const activeEmitters = new Map<number, SpillEmitterRuntime>();
const trackedEmitters = new Map<number, SpillEmitterRuntime>();
const sectionToEmitterIds = new Map<string, Set<number>>();

function linkSection(sectionKey: string | undefined, emitterId: number) {
  if (!sectionKey) return;
  let emitterIds = sectionToEmitterIds.get(sectionKey);
  if (!emitterIds) {
    emitterIds = new Set<number>();
    sectionToEmitterIds.set(sectionKey, emitterIds);
  }
  emitterIds.add(emitterId);
}

function unlinkSection(sectionKey: string | undefined, emitterId: number) {
  if (!sectionKey) return;
  const emitterIds = sectionToEmitterIds.get(sectionKey);
  if (!emitterIds) return;
  emitterIds.delete(emitterId);
  if (emitterIds.size === 0) {
    sectionToEmitterIds.delete(sectionKey);
  }
}

function trackEmitter(emitter: SpillEmitterRuntime) {
  trackedEmitters.set(emitter.id, emitter);
  linkSection(emitter.sourceSectionKey, emitter.id);
  linkSection(emitter.targetSectionKey, emitter.id);
}

function untrackEmitter(emitter: SpillEmitterRuntime) {
  trackedEmitters.delete(emitter.id);
  unlinkSection(emitter.sourceSectionKey, emitter.id);
  unlinkSection(emitter.targetSectionKey, emitter.id);
}

export function queuePendingSpillEmitter(emitter: SpillEmitterRuntime) {
  pendingTransfers.push(emitter);
  trackEmitter(emitter);
}

export function activatePendingSpillEmitters() {
  const activated: SpillEmitterRuntime[] = [];
  while (pendingTransfers.length > 0) {
    const emitter = pendingTransfers.shift()!;
    activeEmitters.set(emitter.id, emitter);
    activated.push(emitter);
  }
  return activated;
}

export function getPendingSpillEmitters() {
  return pendingTransfers;
}

export function getPendingSpillEmitterCount() {
  return pendingTransfers.length;
}

export function getActiveSpillEmitters(): ReadonlyMap<number, SpillEmitterRuntime> {
  return activeEmitters;
}

export function removeActiveSpillEmitter(emitterId: number) {
  const emitter = activeEmitters.get(emitterId);
  if (!emitter) return false;
  activeEmitters.delete(emitterId);
  untrackEmitter(emitter);
  return true;
}

export function clearSpillEmitterSectionOwnership(sectionKey: string) {
  const emitterIds = Array.from(sectionToEmitterIds.get(sectionKey) ?? []);
  if (!emitterIds.length) return;

  for (const emitterId of emitterIds) {
    const emitter = trackedEmitters.get(emitterId);
    if (!emitter) continue;

    if (emitter.sourceSectionKey === sectionKey) {
      unlinkSection(sectionKey, emitter.id);
      emitter.sourceSectionKey = undefined;
    }
    if (emitter.targetSectionKey === sectionKey) {
      unlinkSection(sectionKey, emitter.id);
      emitter.targetSectionKey = undefined;
    }
  }
}

export function clearAllSpillEmitters() {
  pendingTransfers.length = 0;
  activeEmitters.clear();
  trackedEmitters.clear();
  sectionToEmitterIds.clear();
}