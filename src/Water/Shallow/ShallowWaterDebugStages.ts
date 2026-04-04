import {
  DEFAULT_SHALLOW_WATER_CONFIG,
  type ShallowWaterConfig,
} from "./ShallowWaterTypes.js";

/**
 * Ordered debug ladder for isolating shallow water from seed placement up to
 * the full runtime + visual stack. The sequence is intentionally coarse so the
 * lab can answer one question at a time:
 *  - does seeding work?
 *  - does local spread work?
 *  - does the full shallow physics work?
 *  - do visuals add artifacts?
 *  - does handoff to continuous reintroduce issues?
 */
export const SHALLOW_WATER_DEBUG_STAGE_ORDER = [
  "seed",
  "spread",
  "physics",
  "visual",
  "full",
] as const;

export type ShallowWaterDebugStage =
  (typeof SHALLOW_WATER_DEBUG_STAGE_ORDER)[number];

export interface ShallowWaterDebugVisualProfile {
  enableEdgeSplats: boolean;
  enableLocalFluid: boolean;
  enableHybridInjection: boolean;
  enableHandoffTransitions: boolean;
}

export interface ShallowWaterDebugStageProfile {
  id: ShallowWaterDebugStage;
  label: string;
  description: string;
  runtimeConfig: ShallowWaterConfig;
  allowContinuousHandoff: boolean;
  visuals: ShallowWaterDebugVisualProfile;
}

function cloneRuntimeConfig(
  overrides: Partial<ShallowWaterConfig>,
): ShallowWaterConfig {
  return {
    ...DEFAULT_SHALLOW_WATER_CONFIG,
    ...overrides,
  };
}

const DISABLED_HANDOFF_THICKNESS = 1_000_000;

const FILM_ONLY_VISUALS: ShallowWaterDebugVisualProfile = {
  enableEdgeSplats: false,
  enableLocalFluid: false,
  enableHybridInjection: false,
  enableHandoffTransitions: false,
};

const FULL_VISUALS: ShallowWaterDebugVisualProfile = {
  enableEdgeSplats: true,
  enableLocalFluid: true,
  enableHybridInjection: true,
  enableHandoffTransitions: true,
};

const STAGE_PROFILES: Record<ShallowWaterDebugStage, ShallowWaterDebugStageProfile> = {
  seed: {
    id: "seed",
    label: "Seed Only",
    description:
      "Acepta seeds de shallow pero congela spread, settling, evaporacion y handoff. Solo queda la lamina base para validar soporte y siembra.",
    runtimeConfig: cloneRuntimeConfig({
      handoffThickness: DISABLED_HANDOFF_THICKNESS,
      evaporationRate: 0,
      spreadRate: 0,
      settlingRate: 0,
      maxSpreadVelocity: 0.0001,
      gravity: 0,
      frictionCoefficient: 1,
    }),
    allowContinuousHandoff: false,
    visuals: FILM_ONLY_VISUALS,
  },
  spread: {
    id: "spread",
    label: "Spread Only",
    description:
      "Activa la propagacion local shallow, pero mantiene evaporacion, handoff y extras visuales apagados para revisar solamente flujo sobre el plano.",
    runtimeConfig: cloneRuntimeConfig({
      handoffThickness: DISABLED_HANDOFF_THICKNESS,
      evaporationRate: 0,
      settlingRate: 0,
    }),
    allowContinuousHandoff: false,
    visuals: FILM_ONLY_VISUALS,
  },
  physics: {
    id: "physics",
    label: "Full Shallow Physics",
    description:
      "Activa toda la fisica local de shallow, pero mantiene desactivado el handoff a continuous y los extras visuales para aislar el runtime shallow puro.",
    runtimeConfig: cloneRuntimeConfig({
      handoffThickness: DISABLED_HANDOFF_THICKNESS,
    }),
    allowContinuousHandoff: false,
    visuals: FILM_ONLY_VISUALS,
  },
  visual: {
    id: "visual",
    label: "Shallow Visual Stack",
    description:
      "Mantiene el runtime shallow completo y enciende edge splats, local fluid e inyeccion visual, pero todavia sin handoff a continuous.",
    runtimeConfig: cloneRuntimeConfig({
      handoffThickness: DISABLED_HANDOFF_THICKNESS,
    }),
    allowContinuousHandoff: false,
    visuals: FULL_VISUALS,
  },
  full: {
    id: "full",
    label: "Full Runtime",
    description:
      "Activa el stack completo: shallow fisico, visuales, transiciones y handoff hacia continuous.",
    runtimeConfig: cloneRuntimeConfig({}),
    allowContinuousHandoff: true,
    visuals: FULL_VISUALS,
  },
};

export function isShallowWaterDebugStage(
  value: string | null | undefined,
): value is ShallowWaterDebugStage {
  if (!value) return false;
  return (SHALLOW_WATER_DEBUG_STAGE_ORDER as readonly string[]).includes(value);
}

export function normalizeShallowWaterDebugStage(
  value: string | null | undefined,
  fallback: ShallowWaterDebugStage = "full",
): ShallowWaterDebugStage {
  return isShallowWaterDebugStage(value) ? value : fallback;
}

export function getShallowWaterDebugStageProfile(
  value: string | null | undefined,
  fallback: ShallowWaterDebugStage = "full",
): ShallowWaterDebugStageProfile {
  return STAGE_PROFILES[normalizeShallowWaterDebugStage(value, fallback)];
}