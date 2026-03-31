import type { ContinuousWaterColumn, ContinuousWaterSection } from "../Continuous/ContinuousWaterTypes.js";
import type { WaterRuntimePhaseAccounting } from "./WaterRuntimeOrchestrator.js";

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export type WaterEventKind =
  | "breach"
  | "pressure-release"
  | "rupture"
  | "gate-discharge";

export interface WaterEvent {
  kind: WaterEventKind;
  worldX: number;
  worldZ: number;
  originX: number;
  originZ: number;
  columnIndex: number;
  mass: number;
  pressure: number;
  tick: number;
}

// ---------------------------------------------------------------------------
// Rule system
// ---------------------------------------------------------------------------

export interface WaterEventConditionContext {
  column: ContinuousWaterColumn;
  section: ContinuousWaterSection;
  columnIndex: number;
  worldX: number;
  worldZ: number;
  tick: number;
  neighborPressures: number[];
}

export interface WaterEventRule {
  id: string;
  kind: WaterEventKind;
  enabled: boolean;
  evaluate: (ctx: WaterEventConditionContext) => boolean;
  computeMass: (ctx: WaterEventConditionContext) => number;
}

export interface WaterEventResolverDeps {
  getContinuousSections: () => Iterable<[string, ContinuousWaterSection]>;
  getNeighborPressures: (
    section: ContinuousWaterSection,
    x: number,
    z: number,
  ) => number[];
  removeContinuousMass: (
    originX: number,
    originZ: number,
    columnIndex: number,
    mass: number,
  ) => number;
  queueSpillTransfer: (
    worldX: number,
    worldZ: number,
    surfaceY: number,
    mass: number,
    fallHeight: number,
  ) => void;
  sectionSize: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const rules: WaterEventRule[] = [];
const recentEvents: WaterEvent[] = [];
let maxRecentEvents = 128;

// ---------------------------------------------------------------------------
// Rule management
// ---------------------------------------------------------------------------

export function registerEventRule(rule: WaterEventRule): void {
  const existing = rules.findIndex((r) => r.id === rule.id);
  if (existing >= 0) {
    rules[existing] = rule;
  } else {
    rules.push(rule);
  }
}

export function removeEventRule(ruleId: string): void {
  const idx = rules.findIndex((r) => r.id === ruleId);
  if (idx >= 0) rules.splice(idx, 1);
}

export function getRegisteredRules(): readonly WaterEventRule[] {
  return rules;
}

export function getRecentEvents(): readonly WaterEvent[] {
  return recentEvents;
}

export function clearRecentEvents(): void {
  recentEvents.length = 0;
}

export function clearAllRules(): void {
  rules.length = 0;
}

export function setMaxRecentEvents(max: number): void {
  maxRecentEvents = Math.max(1, max);
}

// ---------------------------------------------------------------------------
// Built-in rules
// ---------------------------------------------------------------------------

const BREACH_PRESSURE_THRESHOLD = 2.5;
const BREACH_MIN_DEPTH = 1.2;
const BREACH_MASS_FRACTION = 0.35;

const PRESSURE_RELEASE_THRESHOLD = 4.0;
const PRESSURE_RELEASE_MASS_FRACTION = 0.2;

const RUPTURE_CONFINEMENT_MIN = 3;
const RUPTURE_PRESSURE_THRESHOLD = 3.5;
const RUPTURE_MASS_FRACTION = 0.25;

export const BUILTIN_BREACH_RULE: WaterEventRule = {
  id: "builtin:breach",
  kind: "breach",
  enabled: true,
  evaluate(ctx) {
    return (
      ctx.column.pressure >= BREACH_PRESSURE_THRESHOLD &&
      ctx.column.depth >= BREACH_MIN_DEPTH
    );
  },
  computeMass(ctx) {
    return ctx.column.mass * BREACH_MASS_FRACTION;
  },
};

export const BUILTIN_PRESSURE_RELEASE_RULE: WaterEventRule = {
  id: "builtin:pressure-release",
  kind: "pressure-release",
  enabled: true,
  evaluate(ctx) {
    return ctx.column.pressure >= PRESSURE_RELEASE_THRESHOLD;
  },
  computeMass(ctx) {
    return ctx.column.mass * PRESSURE_RELEASE_MASS_FRACTION;
  },
};

export const BUILTIN_RUPTURE_RULE: WaterEventRule = {
  id: "builtin:rupture",
  kind: "rupture",
  enabled: true,
  evaluate(ctx) {
    const confinedNeighborCount = ctx.neighborPressures.filter(
      (p) => p >= ctx.column.pressure * 0.7,
    ).length;
    return (
      confinedNeighborCount >= RUPTURE_CONFINEMENT_MIN &&
      ctx.column.pressure >= RUPTURE_PRESSURE_THRESHOLD
    );
  },
  computeMass(ctx) {
    return ctx.column.mass * RUPTURE_MASS_FRACTION;
  },
};

// ---------------------------------------------------------------------------
// Tick — evaluate all rules across all continuous sections
// ---------------------------------------------------------------------------

const MIN_EVENT_MASS = 0.001;

export function resolveEvents(
  tick: number,
  deps: WaterEventResolverDeps,
): WaterRuntimePhaseAccounting {
  const accounting: WaterRuntimePhaseAccounting = {
    sourceDelta: 0,
    sinkDelta: 0,
    transferDelta: {},
  };

  const enabledRules = rules.filter((r) => r.enabled);
  if (enabledRules.length === 0) return accounting;

  for (const [, section] of deps.getContinuousSections()) {
    for (let z = 0; z < section.sizeZ; z++) {
      for (let x = 0; x < section.sizeX; x++) {
        const columnIndex = z * section.sizeX + x;
        const column = section.columns[columnIndex];
        if (!column.active || column.mass <= 0) continue;

        const worldX = section.originX + x;
        const worldZ = section.originZ + z;
        const neighborPressures = deps.getNeighborPressures(section, x, z);

        const ctx: WaterEventConditionContext = {
          column,
          section,
          columnIndex,
          worldX,
          worldZ,
          tick,
          neighborPressures,
        };

        for (const rule of enabledRules) {
          if (!rule.evaluate(ctx)) continue;

          const mass = rule.computeMass(ctx);
          if (mass < MIN_EVENT_MASS) continue;

          const actualRemoved = deps.removeContinuousMass(
            section.originX,
            section.originZ,
            columnIndex,
            mass,
          );
          if (actualRemoved < MIN_EVENT_MASS) continue;

          const fallHeight = Math.max(0, column.surfaceY - column.bedY);
          deps.queueSpillTransfer(
            worldX,
            worldZ,
            column.bedY,
            actualRemoved,
            fallHeight,
          );

          const event: WaterEvent = {
            kind: rule.kind,
            worldX,
            worldZ,
            originX: section.originX,
            originZ: section.originZ,
            columnIndex,
            mass: actualRemoved,
            pressure: column.pressure,
            tick,
          };

          if (recentEvents.length >= maxRecentEvents) {
            recentEvents.shift();
          }
          recentEvents.push(event);

          accounting.transferDelta ??= {};
          accounting.transferDelta.continuousToSpill =
            (accounting.transferDelta.continuousToSpill ?? 0) + actualRemoved;

          break;
        }
      }
    }
  }

  return accounting;
}
