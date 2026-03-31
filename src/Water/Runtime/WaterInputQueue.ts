export interface WaterRuntimeInputEvent {
  kind:
    | "terrain-carve"
    | "terrain-fill"
    | "add-mass"
    | "remove-mass"
    | "pressure-impulse"
    | "flow-obstruction"
    | "emitter-update"
    | "breach"
    | "gate-control";
  worldX: number;
  worldY: number;
  worldZ: number;
  radius?: number;
  massDelta?: number;
  pressureDelta?: number;
  gateId?: string;
  gateOpenness?: number;
}

const pendingEvents: WaterRuntimeInputEvent[] = [];

export function enqueueWaterRuntimeInputEvent(event: WaterRuntimeInputEvent) {
  pendingEvents.push({ ...event });
}

export function drainWaterRuntimeInputEvents() {
  const drained = pendingEvents.slice();
  pendingEvents.length = 0;
  return drained;
}

export function clearWaterRuntimeInputEvents() {
  pendingEvents.length = 0;
}

export function getPendingWaterRuntimeInputEventCount() {
  return pendingEvents.length;
}