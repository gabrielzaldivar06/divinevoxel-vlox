/**
 * ShallowWaterSectionState — Fase 1
 *
 * Manages the simulation state for shallow water across all active sections.
 * Each section is a 16×16 column grid.
 *
 * Simulation model (Phase 1, purely local — no large-body coupling yet):
 *  1. spread:      water flows into adjacent empty columns at spreadRate
 *  2. settling:    spreadVX/VZ decay → water calms into a pool
 *  3. evaporation: isolated thin columns lose thickness over time
 *  4. adhesion:    keeps settled water on flat terrain
 *  5. handoff:     columns with thickness >= handoffThickness are flagged
 */
import {
  type ShallowColumnState,
  type ShallowWaterSectionGrid,
  type ShallowWaterConfig,
  type ShallowWaterExternalFlowHint,
  DEFAULT_SHALLOW_WATER_CONFIG,
  createEmptyShallowColumn,
} from "./ShallowWaterTypes";
import type { WaterHandoffTransferResult } from "../Contracts/WaterSemanticContract.js";
import type { WaterBoundaryDirection } from "../Runtime/WaterBoundaryFluxBuffer.js";
import {
  shouldSimulateShallowColumn,
  type WaterOwnershipPreview,
} from "../Runtime/WaterOwnershipResolver.js";
import { buildShallowWaterPatchMetrics } from "./ShallowWaterPatchMetrics.js";
import type { WaterRuntimePhaseAccounting } from "../Runtime/WaterRuntimeOrchestrator.js";
import type {
  ShallowBoundaryFluxSnapshot,
  ShallowBoundaryFluxRegistry,
  ShallowGhostColumnSet,
} from "./ShallowBoundaryFluxRegistry.js";

// Section size hardcoded to match DVE standard section footprint
const SECTION_SIZE = 16;
const MIN_TRANSFER_CONFIDENCE = 0.6;
const MIN_CONFIDENCE_FLOW_SCALE = 0.2;
const MIN_STABLE_OWNERSHIP_TICKS = 3;
const HANDOFF_GRACE_TICKS = MIN_STABLE_OWNERSHIP_TICKS;

/** All active section grids, keyed by "x_z" (section origin in voxel coords). */
const sections = new Map<string, ShallowWaterSectionGrid>();

/** Flow hint grids, keyed by "x_z". */
const flowHintGrids = new Map<string, ShallowWaterExternalFlowHint[]>();

export type ShallowHandoffCallback = (
  worldX: number,
  worldZ: number,
  bedY: number,
  surfaceY: number,
  thickness: number,
  emitterId: number,
) => WaterHandoffTransferResult;

export interface ShallowWaterSeedOptions {
  bedY?: number;
  authority?: ShallowColumnState["authority"];
  ownershipConfidence?: number;
  ownershipTicks?: number;
  handoffGraceTicks?: number;
}

export interface ShallowWaterHandoffSummary {
  handoffKeys: string[];
  acceptedCount: number;
  deferredCount: number;
  rejectedCount: number;
  transferredMassToContinuous: number;
}

export interface ShallowWaterTickSummary {
  handoffKeys: string[];
  accounting: WaterRuntimePhaseAccounting;
}

let _shallowTick = 0;

function getOwnershipTickScale(ownershipTicks: number) {
  if (ownershipTicks <= 0) {
    return 0.35;
  }
  return Math.max(0.35, Math.min(1, ownershipTicks / MIN_STABLE_OWNERSHIP_TICKS));
}

function clampOwnershipConfidence(confidence: number) {
  return Math.max(0, Math.min(1, confidence));
}

function setLocalShallowOwnership(
  column: ShallowColumnState,
  confidence: number,
  resolvedTick: number,
  authority: ShallowColumnState["authority"] = column.authority,
  resetTicks = false,
) {
  const wasShallow = column.ownershipDomain === "shallow";
  column.ownershipDomain = "shallow";
  column.ownershipConfidence = clampOwnershipConfidence(confidence);
  column.ownershipTicks = !wasShallow || resetTicks ? 1 : Math.max(1, column.ownershipTicks);
  column.lastResolvedTick = resolvedTick;
  column.authority = authority;
}

function getInboundBedY(grid: ShallowWaterSectionGrid, column: ShallowColumnState, bedYHint: number) {
  if (Number.isFinite(bedYHint)) {
    return bedYHint;
  }
  if (column.bedY !== 0) {
    return column.bedY;
  }
  if (grid.terrainY !== 0) {
    return grid.terrainY;
  }
  return column.bedY;
}

function canShallowColumnHandoff(column: ShallowColumnState) {
  return (
    column.handoffGraceTicks <= 0 &&
    column.ownershipConfidence >= MIN_TRANSFER_CONFIDENCE &&
    column.ownershipTicks >= MIN_STABLE_OWNERSHIP_TICKS
  );
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/**
 * Register or update external flow hints for a section.
 * Called by the large-body water coupling or editor tools.
 */
export function setShallowWaterFlowHints(
  originX: number,
  originZ: number,
  hints: ShallowWaterExternalFlowHint[],
): void {
  flowHintGrids.set(sectionKey(originX, originZ), hints);
}

function sectionKey(originX: number, originZ: number) {
  return `${originX}_${originZ}`;
}

function colIdx(x: number, z: number) {
  return z * SECTION_SIZE + x;
}

function getBoundaryDirection(dx: number, dz: number): WaterBoundaryDirection {
  if (dx < 0) return "west";
  if (dx > 0) return "east";
  if (dz < 0) return "north";
  return "south";
}

function getBoundaryIndex(direction: WaterBoundaryDirection, x: number, z: number) {
  return direction === "north" || direction === "south" ? x : z;
}

function getNeighborSectionOrigin(
  originX: number,
  originZ: number,
  direction: WaterBoundaryDirection,
) {
  switch (direction) {
    case "north":
      return { originX, originZ: originZ - SECTION_SIZE };
    case "south":
      return { originX, originZ: originZ + SECTION_SIZE };
    case "east":
      return { originX: originX + SECTION_SIZE, originZ };
    case "west":
      return { originX: originX - SECTION_SIZE, originZ };
  }
}

function getGhostColumn(
  ghosts: ShallowGhostColumnSet | null,
  direction: WaterBoundaryDirection,
  index: number,
) {
  return ghosts?.[direction]?.[index] ?? null;
}

function applyInboundBoundaryFluxes(
  grid: ShallowWaterSectionGrid,
  inbound: ShallowBoundaryFluxSnapshot | null,
  resolvedTick: number,
) {
  if (!inbound) return;

  const applyFlux = (
    direction: WaterBoundaryDirection,
    entries: ShallowBoundaryFluxSnapshot[WaterBoundaryDirection],
  ) => {
    for (let i = 0; i < entries.length; i++) {
      const flux = entries[i];
      if (flux.mass <= 0) continue;
      // Allow flux from the previous tick: finalizeTick delivers with the
      // producer's tick (N) but consumption runs on tick N+1.
      if (flux.tick !== 0 && flux.tick !== resolvedTick && flux.tick !== resolvedTick - 1) continue;

      const x = direction === "west" ? 0 : direction === "east" ? grid.sizeX - 1 : i;
      const z = direction === "north" ? 0 : direction === "south" ? grid.sizeZ - 1 : i;
      const column = grid.columns[colIdx(x, z)];
      const bedY = getInboundBedY(grid, column, flux.bedY);
      const wasActive = column.active;
      if (!column.active) {
        column.active = true;
        column.bedY = bedY;
        column.surfaceY = bedY;
      } else if ((column.bedY === 0 || column.thickness <= 0.0001) && Number.isFinite(bedY)) {
        column.bedY = bedY;
        column.surfaceY = bedY + column.thickness;
      }

      column.thickness += flux.mass;
      column.surfaceY = column.bedY + column.thickness;
      column.spreadVX = (column.spreadVX + flux.velocityX) * 0.5;
      column.spreadVZ = (column.spreadVZ + flux.velocityZ) * 0.5;
      column.settled = Math.max(0, column.settled - 0.15);
      column.handoffPending = false;
      setLocalShallowOwnership(
        column,
        Number.isFinite(flux.bedY) ? 0.95 : 0.8,
        resolvedTick,
        column.authority === "bootstrap" ? "editor" : column.authority,
        !wasActive,
      );
    }
  };

  applyFlux("north", inbound.north);
  applyFlux("south", inbound.south);
  applyFlux("east", inbound.east);
  applyFlux("west", inbound.west);
}

/**
 * Register or reset a section at the given origin.
 * Call this when the editor places the first water seed in a section,
 * or when a section mesh is updated.
 */
export function getOrCreateShallowSection(
  originX: number,
  originZ: number,
  fallbackBedY = 0,
): ShallowWaterSectionGrid {
  const key = sectionKey(originX, originZ);
  let grid = sections.get(key);
  if (!grid) {
    const columns: ShallowColumnState[] = [];
    for (let i = 0; i < SECTION_SIZE * SECTION_SIZE; i++) {
      const column = createEmptyShallowColumn();
      column.bedY = fallbackBedY;
      column.surfaceY = fallbackBedY;
      columns.push(column);
    }
    grid = {
      originX,
      originZ,
      sizeX: SECTION_SIZE,
      sizeZ: SECTION_SIZE,
      columns,
      lastTickDt: 0,
      terrainY: fallbackBedY,
    };
    sections.set(key, grid);
  } else if (fallbackBedY !== 0 && grid.terrainY !== fallbackBedY) {
    const hadActiveColumns = grid.columns.some((column) => column.active);
    if (!hadActiveColumns || grid.terrainY === 0) {
      const previousTerrainY = grid.terrainY;
      grid.terrainY = fallbackBedY;
      for (const column of grid.columns) {
        if (column.active) continue;
        if (column.bedY !== previousTerrainY && column.bedY !== 0) continue;
        column.bedY = fallbackBedY;
        column.surfaceY = fallbackBedY;
      }
    }
  }
  return grid;
}

/**
 * Remove a section (called when the section voxel mesh is removed).
 */
export function removeShallowSection(originX: number, originZ: number) {
  sections.delete(sectionKey(originX, originZ));
}

/**
 * Place a water seed at a world-voxel position (x, z) with a given thickness.
 * This is what the editor calls instead of directly placing dve_liquid.
 */
export function placeShallowWaterSeed(
  worldX: number,
  worldZ: number,
  surfaceY: number,
  thickness = 0.15,
  emitterId = 0,
  config: ShallowWaterConfig = DEFAULT_SHALLOW_WATER_CONFIG,
  options: ShallowWaterSeedOptions = {},
) {
  if (thickness <= 0) return 0;

  const sectionOriginX = Math.floor(worldX / SECTION_SIZE) * SECTION_SIZE;
  const sectionOriginZ = Math.floor(worldZ / SECTION_SIZE) * SECTION_SIZE;
  const terrainY = Number.isFinite(options.bedY) ? (options.bedY as number) : surfaceY - thickness;
  const grid = getOrCreateShallowSection(sectionOriginX, sectionOriginZ, terrainY);

  const localX = ((worldX % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;
  const localZ = ((worldZ % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;
  const col = grid.columns[colIdx(localX, localZ)];
  let addedThickness = thickness;
  const authority = options.authority ?? "editor";
  const ownershipConfidence = options.ownershipConfidence ?? 1;
  const ownershipTicks =
    options.ownershipTicks !== undefined ? Math.max(0, options.ownershipTicks) : null;
  const handoffGraceTicks = Math.max(0, options.handoffGraceTicks ?? 0);

  if (!col.active) {
    col.active = true;
    col.bedY = terrainY;
    col.thickness = thickness;
    col.surfaceY = col.bedY + col.thickness;
    // New shallow seeds should let terrain slope drive the motion instead of
    // starting with a strong random burst that reads as noise.
    col.spreadVX = 0;
    col.spreadVZ = 0;
    col.settled = 0;
    col.adhesion = 0.16;
    col.age = 0;
    col.emitterId = emitterId;
    col.handoffPending = false;
    setLocalShallowOwnership(col, ownershipConfidence, _shallowTick, authority, true);
  } else {
    const previousThickness = col.thickness;
    if (!Number.isFinite(col.bedY)) {
      col.bedY = terrainY;
    }
    col.thickness = Math.min(col.thickness + thickness, config.handoffThickness * 1.2);
    col.surfaceY = col.bedY + col.thickness;
    col.settled = Math.max(0, col.settled - 0.22);
    col.adhesion = Math.min(col.adhesion, 0.18);
    col.emitterId = emitterId > 0 ? emitterId : col.emitterId;
    setLocalShallowOwnership(col, ownershipConfidence, _shallowTick, authority);
    addedThickness = Math.max(0, col.thickness - previousThickness);
  }

  if (ownershipTicks !== null) {
    col.ownershipTicks = ownershipTicks;
  }
  col.handoffGraceTicks = handoffGraceTicks;

  return addedThickness;
}

/**
 * Advance all shallow-water sections by dt seconds.
 *
 * Returns an array of section keys whose `handoffPending` columns need
 * to be promoted to LargeBodyWater (Phase 3).
 */
export function tickShallowWater(
  dt: number,
  config: ShallowWaterConfig = DEFAULT_SHALLOW_WATER_CONFIG,
  boundaryRegistry?: ShallowBoundaryFluxRegistry,
  ownershipPreview?: WaterOwnershipPreview,
): ShallowWaterTickSummary {
  const handoffKeys: string[] = [];
  const sectionsToDelete: string[] = [];
  const clampedDt = Math.min(dt, 0.1); // prevent spiral on tab-out spikes
  const resolvedTick = ++_shallowTick;
  let evaporatedMass = 0;

  boundaryRegistry?.beginTick(sections, resolvedTick);

  for (const [key, grid] of sections) {
    let anyActive = false;
    let anyHandoff = false;
    const ghosts = boundaryRegistry?.getGhostColumns(grid.originX, grid.originZ) ?? null;

    applyInboundBoundaryFluxes(
      grid,
      boundaryRegistry?.consumeInboundFlux(grid.originX, grid.originZ) ?? null,
      resolvedTick,
    );

    _tickSectionSpread(
      grid,
      clampedDt,
      config,
      boundaryRegistry,
      resolvedTick,
      ownershipPreview,
    );
    _tickSectionSettle(grid, clampedDt, config, ghosts, ownershipPreview);
    evaporatedMass += _tickSectionEvaporation(
      grid,
      clampedDt,
      config,
      ghosts,
      ownershipPreview,
    );
    const patchMetrics = buildShallowWaterPatchMetrics(grid, undefined, ghosts);

    for (let z = 0; z < grid.sizeZ; z++) {
      for (let x = 0; x < grid.sizeX; x++) {
        const col = grid.columns[colIdx(x, z)];
        if (!col.active) continue;
        if (col.handoffGraceTicks > 0) {
          col.handoffGraceTicks -= 1;
        }

        const canSimulate = shouldSimulateShallowColumn(
          ownershipPreview,
          grid.originX,
          grid.originZ,
          x,
          z,
          grid.sizeX,
        );

        if (!canSimulate) {
          col.surfaceY = col.bedY + col.thickness;
          col.handoffPending = false;
          anyActive = true;
          anyHandoff = col.handoffPending;
          col.lastResolvedTick = resolvedTick;
          continue;
        }

        col.age += clampedDt;
        col.surfaceY = col.bedY + col.thickness;
        const patch = patchMetrics.columns[colIdx(x, z)];
        const patchDrivenMinThickness = patch
          ? Math.max(
              config.handoffThickness * 0.14,
              Math.min(
                config.handoffThickness * 0.58,
                patch.averageThickness * (0.62 - patch.localCore * 0.24),
              ),
            )
          : config.handoffThickness;
        const patchSupportsHandoff =
          !!patch &&
          patch.handoffReady &&
          patch.handoffBlend >= 0.34 &&
          patch.deepBlend >= 0.2 &&
          patch.connectivity >= 0.2 &&
          patch.effectiveTotalMass >= config.handoffThickness * 0.48;
        col.handoffPending =
          canShallowColumnHandoff(col) &&
          patchSupportsHandoff &&
          (
            col.thickness >= patchDrivenMinThickness ||
            (patch.localCore >= 0.58 && col.thickness >= config.handoffThickness * 0.14) ||
            (patch.localNeighborCount >= 2 && patch.averageThickness >= config.handoffThickness * 0.3)
          );

        anyActive = true;
        if (col.handoffPending) anyHandoff = true;
        col.lastResolvedTick = resolvedTick;
      }
    }

    grid.lastTickDt = clampedDt;

    if (!anyActive && !boundaryRegistry) {
      sectionsToDelete.push(key);
      continue;
    }
    if (anyHandoff) handoffKeys.push(key);
  }

  for (const key of sectionsToDelete) {
    sections.delete(key);
  }

  return {
    handoffKeys,
    accounting: {
      sourceDelta: 0,
      sinkDelta: evaporatedMass,
      transferDelta: {},
    },
  };
}

export function performShallowWaterHandoffs(
  handoffResolver: ShallowHandoffCallback,
): ShallowWaterHandoffSummary {
  return performShallowWaterHandoffsWithResolver(handoffResolver);
}

export function performShallowWaterHandoffsWithResolver(
  handoffResolver: ShallowHandoffCallback,
): ShallowWaterHandoffSummary {
  const handoffKeys: string[] = [];
  let acceptedCount = 0;
  let deferredCount = 0;
  let rejectedCount = 0;
  let transferredMassToContinuous = 0;

  for (const [key, grid] of sections) {
    let anyHandoff = false;

    for (let z = 0; z < grid.sizeZ; z++) {
      for (let x = 0; x < grid.sizeX; x++) {
        const col = grid.columns[colIdx(x, z)];
        if (!col.active) continue;

        const forceContinuousTransfer = col.ownershipDomain === "continuous";
        if (!col.handoffPending && !forceContinuousTransfer) continue;

        if (!canShallowColumnHandoff(col)) {
          col.handoffPending = forceContinuousTransfer || col.handoffPending;
          deferredCount += 1;
          continue;
        }

        anyHandoff = true;
        const handoffResult = handoffResolver(
          grid.originX + x,
          grid.originZ + z,
          col.bedY,
          col.surfaceY,
          col.thickness,
          col.emitterId,
        );
        const acceptedMass = Math.max(
          0,
          Math.min(col.thickness, handoffResult.acceptedMass ?? 0),
        );

        col.lastResolvedTick = _shallowTick;

        if (acceptedMass > 0.0001) {
          transferredMassToContinuous += acceptedMass;
          acceptedCount += 1;
          if (acceptedMass >= col.thickness - 0.0001) {
            col.active = false;
            col.thickness = 0;
            col.surfaceY = col.bedY;
            col.spreadVX = 0;
            col.spreadVZ = 0;
            col.handoffPending = false;
            col.ownershipDomain = "continuous";
            col.ownershipConfidence = 1;
            col.ownershipTicks = 0;
            col.authority = "continuous-handoff";
            col.handoffGraceTicks = 0;
          } else {
            col.thickness = Math.max(0, col.thickness - acceptedMass);
            col.surfaceY = col.bedY + col.thickness;
            col.settled = Math.max(0, col.settled - 0.12);
            col.spreadVX *= 0.75;
            col.spreadVZ *= 0.75;
            setLocalShallowOwnership(
              col,
              Math.max(0.8, col.ownershipConfidence),
              _shallowTick,
              col.authority,
            );
            col.ownershipTicks = Math.max(col.ownershipTicks, HANDOFF_GRACE_TICKS);
            col.handoffPending = false;
            col.handoffGraceTicks = HANDOFF_GRACE_TICKS;
          }
          continue;
        }

        const fallbackConfidence =
          handoffResult.disposition === "deferred"
            ? Math.max(0.55, col.ownershipConfidence * 0.9)
            : Math.max(0.35, col.ownershipConfidence * 0.55);
        setLocalShallowOwnership(col, fallbackConfidence, _shallowTick, col.authority);
        col.handoffPending = forceContinuousTransfer || handoffResult.disposition === "deferred";
        col.handoffGraceTicks =
          handoffResult.disposition === "rejected" ? HANDOFF_GRACE_TICKS : 0;
        if (handoffResult.disposition === "deferred") {
          deferredCount += 1;
        } else {
          rejectedCount += 1;
        }
      }
    }

    if (anyHandoff) {
      handoffKeys.push(key);
    }
  }

  return {
    handoffKeys,
    acceptedCount,
    deferredCount,
    rejectedCount,
    transferredMassToContinuous,
  };
}

export function performShallowBoundaryFluxes(registry: ShallowBoundaryFluxRegistry) {
  const sectionsToDelete: Array<{ key: string; originX: number; originZ: number }> = [];

  registry.materializePendingSections((originX, originZ, bedYHint) => {
    getOrCreateShallowSection(originX, originZ, bedYHint);
  });
  registry.finalizeTick();

  for (const [key, grid] of sections) {
    const hasActiveColumns = grid.columns.some((column) => column.active);
    if (hasActiveColumns) continue;
    if (registry.hasPendingTransfers(grid.originX, grid.originZ)) continue;
    sectionsToDelete.push({ key, originX: grid.originX, originZ: grid.originZ });
  }

  for (const section of sectionsToDelete) {
    sections.delete(section.key);
    registry.removeSection(section.originX, section.originZ);
  }
}

/** Returns all currently active section grids. */
export function getActiveShallowSections(): ReadonlyMap<string, ShallowWaterSectionGrid> {
  return sections;
}

/** Returns the section grid at the given origin, or undefined. */
export function getShallowSection(
  originX: number,
  originZ: number,
): ShallowWaterSectionGrid | undefined {
  return sections.get(sectionKey(originX, originZ));
}

/** Flush all shallow water state (e.g. on scene dispose). */
export function clearAllShallowWater() {
  sections.clear();
  flowHintGrids.clear();
}

export function measureShallowWaterMass() {
  let total = 0;
  for (const grid of sections.values()) {
    for (const column of grid.columns) {
      if (!column.active) continue;
      total += column.thickness;
    }
  }
  return total;
}

// ─────────────────────────────────────────────────────────────────
// Internal tick helpers
// ─────────────────────────────────────────────────────────────────

const NEIGHBORS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;

const FLOW_NEIGHBORS = [
  { dx: -1, dz: 0, distanceWeight: 1, diagonal: false },
  { dx: 1, dz: 0, distanceWeight: 1, diagonal: false },
  { dx: 0, dz: -1, distanceWeight: 1, diagonal: false },
  { dx: 0, dz: 1, distanceWeight: 1, diagonal: false },
  { dx: -1, dz: -1, distanceWeight: 0.78, diagonal: true },
  { dx: 1, dz: -1, distanceWeight: 0.78, diagonal: true },
  { dx: -1, dz: 1, distanceWeight: 0.78, diagonal: true },
  { dx: 1, dz: 1, distanceWeight: 0.78, diagonal: true },
] as const;

function countConnectedNeighbors(
  grid: ShallowWaterSectionGrid,
  x: number,
  z: number,
  ghosts: ShallowGhostColumnSet | null = null,
) {
  let count = 0;
  for (const [dx, dz] of NEIGHBORS) {
    const nx = x + dx;
    const nz = z + dz;
    if (nx < 0 || nz < 0 || nx >= grid.sizeX || nz >= grid.sizeZ) {
      const direction = getBoundaryDirection(dx, dz);
      const boundaryIndex = getBoundaryIndex(direction, x, z);
      const ghost = getGhostColumn(ghosts, direction, boundaryIndex);
      if (ghost?.active && ghost.thickness > 0.0001) {
        count += 1;
      }
      continue;
    }
    const neighbor = grid.columns[colIdx(nx, nz)];
    if (!neighbor.active || neighbor.ownershipDomain !== "shallow" || neighbor.thickness <= 0.0001) {
      continue;
    }
    count += 1;
  }
  return count;
}

function _tickSectionSpread(
  grid: ShallowWaterSectionGrid,
  dt: number,
  config: ShallowWaterConfig,
  boundaryRegistry?: ShallowBoundaryFluxRegistry,
  resolvedTick = 0,
  ownershipPreview?: WaterOwnershipPreview,
) {
  const sz = grid.sizeX; // always 16
  const cols = grid.columns;
  const hints = flowHintGrids.get(sectionKey(grid.originX, grid.originZ));
  const ghosts = boundaryRegistry?.getGhostColumns(grid.originX, grid.originZ) ?? null;

  // Two-pass: first accumulate deltas, then apply (avoid order dependency).
  // Keep this as Float64 to avoid magnifying rounding drift over many local transfers.
  const transfer = new Float64Array(sz * sz);

  for (let z = 0; z < sz; z++) {
    for (let x = 0; x < sz; x++) {
      const srcIdx = colIdx(x, z);
      const src = cols[srcIdx];
      if (!src.active || src.thickness < 0.001) continue;
      if (
        !shouldSimulateShallowColumn(
          ownershipPreview,
          grid.originX,
          grid.originZ,
          x,
          z,
          grid.sizeX,
        )
      ) {
        src.handoffPending = src.thickness > 0.0001;
        continue;
      }
      const sourceFlowScale =
        (
          !Number.isFinite(src.ownershipConfidence) || src.ownershipConfidence >= MIN_TRANSFER_CONFIDENCE
            ? 1
            : Math.max(MIN_CONFIDENCE_FLOW_SCALE, src.ownershipConfidence / MIN_TRANSFER_CONFIDENCE)
        ) * getOwnershipTickScale(src.ownershipTicks);
      const hint: ShallowWaterExternalFlowHint | undefined = hints ? hints[colIdx(x, z)] : undefined;
      let terrainGuideX = 0;
      let terrainGuideZ = 0;
      let terrainGuideWeight = 0;
      let maxTerrainDrop = 0;

      // Phase 2: apply external flow hint if available
      if (hint) {
        const flowMag = Math.hypot(hint.flowX, hint.flowZ);
        if (flowMag > 0.001) {
          // External hints bias direction and calmness only. Actual mass transfer
          // must remain inside the single conserved spread solve below.
          src.spreadVX += hint.flowX * flowMag * 0.3;
          src.spreadVZ += hint.flowZ * flowMag * 0.3;
          src.settled = Math.max(0, src.settled - flowMag * 0.06);
        }
        // Apply shore adhesion lerp
        const lerpT = Math.min(1, 0.05 * dt * 20);
        const targetAdhesion = 0.14 + hint.shoreFactor * 0.38;
        src.adhesion += (targetAdhesion - src.adhesion) * lerpT;
      }

      // Flow toward lower neighbors (gravity-driven spread).
      // heightDiff = src water surface - dst water surface (or terrain floor if dry).
      // src.surfaceY and dst.surfaceY are both water-surface Y (terrainY + thickness).
      // WaterBall tension-free pressure: when cell is over-compressed (thick > rest),
      // it gets an extra push. max(0,...) means no suction when thin → organic spreading.
      const SHALLOW_TAIT_REST = 0.04; // ~4cm rest film thickness
      const taitBoost = Math.max(0, 0.55 * (Math.pow(src.thickness / SHALLOW_TAIT_REST, 3) - 1));
      let effectiveSpreadRate = config.spreadRate * (1 + taitBoost) * sourceFlowScale;
      let effectiveAdhesion = src.adhesion;
      const preferredFlowX = src.spreadVX + (hint?.flowX ?? 0) * 0.9;
      const preferredFlowZ = src.spreadVZ + (hint?.flowZ ?? 0) * 0.9;
      const preferredFlowLength = Math.hypot(preferredFlowX, preferredFlowZ);
      const flowCandidates: Array<{
        dx: number;
        dz: number;
        distanceWeight: number;
        diagonal: boolean;
        nx: number;
        nz: number;
        dst: ShallowColumnState | null;
        boundaryDirection: WaterBoundaryDirection | null;
        boundaryIndex: number;
        heightDiff: number;
        terrainDrop: number;
      }> = [];

      for (const { dx, dz, distanceWeight, diagonal } of FLOW_NEIGHBORS) {
        const nx = x + dx;
        const nz = z + dz;
        let dstLevel = src.bedY;
        let dstBed = src.bedY;
        let dst: ShallowColumnState | null = null;
        let boundaryDirection: WaterBoundaryDirection | null = null;
        let boundaryIndex = -1;

        if (nx >= 0 && nx < sz && nz >= 0 && nz < sz) {
          if (
            !shouldSimulateShallowColumn(
              ownershipPreview,
              grid.originX,
              grid.originZ,
              nx,
              nz,
              grid.sizeX,
            )
          ) {
            continue;
          }
          dst = cols[colIdx(nx, nz)];
          dstLevel = dst.active ? dst.surfaceY : dst.bedY;
          dstBed = dst.bedY;
        } else {
          if (!boundaryRegistry || diagonal) continue;
          boundaryDirection = getBoundaryDirection(dx, dz);
          const neighborOrigin = getNeighborSectionOrigin(
            grid.originX,
            grid.originZ,
            boundaryDirection,
          );
          const targetX =
            boundaryDirection === "west" ? grid.sizeX - 1 : boundaryDirection === "east" ? 0 : x;
          const targetZ =
            boundaryDirection === "north"
              ? grid.sizeZ - 1
              : boundaryDirection === "south"
                ? 0
                : z;
          if (
            !shouldSimulateShallowColumn(
              ownershipPreview,
              neighborOrigin.originX,
              neighborOrigin.originZ,
              targetX,
              targetZ,
              grid.sizeX,
            )
          ) {
            continue;
          }
          boundaryIndex = getBoundaryIndex(boundaryDirection, x, z);
          const ghost = getGhostColumn(ghosts, boundaryDirection, boundaryIndex);
          dstLevel = ghost ? (ghost.active ? ghost.surfaceY : ghost.bedY) : src.bedY;
          dstBed = ghost?.bedY ?? src.bedY;
        }

        const terrainDrop = src.bedY - dstBed;
        if (terrainDrop > 0.001) {
          terrainGuideX += dx * terrainDrop;
          terrainGuideZ += dz * terrainDrop;
          terrainGuideWeight += terrainDrop;
          maxTerrainDrop = Math.max(maxTerrainDrop, terrainDrop);
        }

        const heightDiff = src.surfaceY - dstLevel;
        if (heightDiff > 0.005) {
          flowCandidates.push({
            dx,
            dz,
            distanceWeight,
            diagonal,
            nx,
            nz,
            dst,
            boundaryDirection,
            boundaryIndex,
            heightDiff,
            terrainDrop,
          });
        }
      }

      if (terrainGuideWeight > 0.0001) {
        const terrainSlope01 = clamp01(maxTerrainDrop / Math.max(0.02, src.thickness + 0.04));
        effectiveSpreadRate *= 1 + terrainSlope01 * 0.82;
        effectiveAdhesion = Math.max(0.04, src.adhesion - terrainSlope01 * 0.12);
      }
      src.adhesion = effectiveAdhesion;

      if (flowCandidates.length === 0) continue;

      let totalOut = 0;
      const plannedFlows = new Float64Array(flowCandidates.length);
      for (let i = 0; i < flowCandidates.length; i++) {
        const candidate = flowCandidates[i];
        const directionLength = candidate.diagonal ? Math.SQRT2 : 1;
        const alignment =
          preferredFlowLength > 0.0001
            ? clamp01(
                ((preferredFlowX * candidate.dx + preferredFlowZ * candidate.dz) /
                  (preferredFlowLength * directionLength) +
                  1) *
                  0.5,
              )
            : 0.5;
        const slopeBias =
          candidate.terrainDrop > 0.001 ? 1 + Math.min(0.68, candidate.terrainDrop * 0.38) : 1;
        const directionBias =
          0.72 + alignment * 0.46 + (hint ? clamp01(hint.shoreFactor) * 0.08 : 0);
        const flowAmount =
          effectiveSpreadRate *
          candidate.heightDiff *
          dt *
          (1 - effectiveAdhesion) *
          candidate.distanceWeight *
          (candidate.diagonal ? 0.82 : 1) *
          directionBias *
          slopeBias;
        const safeFlowAmount = Math.max(0, flowAmount);
        plannedFlows[i] = safeFlowAmount;
        totalOut += safeFlowAmount;
      }

      if (totalOut <= 0) continue;
      const scale = totalOut > src.thickness ? src.thickness / totalOut : 1;

      // Accumulate net flow direction for visual velocity (reset each frame in settle).
      let netVX = 0;
      let netVZ = 0;

      for (let i = 0; i < flowCandidates.length; i++) {
        const candidate = flowCandidates[i];
        const flowAmount = plannedFlows[i] * scale;
        if (flowAmount <= 0) continue;

        transfer[srcIdx] -= flowAmount;
        netVX += candidate.dx * flowAmount;
        netVZ += candidate.dz * flowAmount;

        if (!candidate.dst && boundaryRegistry && candidate.boundaryDirection) {
          const neighborOrigin = getNeighborSectionOrigin(
            grid.originX,
            grid.originZ,
            candidate.boundaryDirection,
          );
          boundaryRegistry.queueReceiverSection(
            neighborOrigin.originX,
            neighborOrigin.originZ,
            src.bedY,
            grid.sizeX,
            grid.sizeZ,
          );
          boundaryRegistry.recordOutboundFlux(
            grid.originX,
            grid.originZ,
            candidate.boundaryDirection,
            candidate.boundaryIndex,
            flowAmount,
            candidate.dx * flowAmount,
            candidate.dz * flowAmount,
            resolvedTick,
            src.bedY,
          );
          continue;
        }

        transfer[colIdx(candidate.nx, candidate.nz)] += flowAmount;

        // Activate neighbor if it receives water.
        if (candidate.dst && !candidate.dst.active) {
          candidate.dst.active = true;
          candidate.dst.surfaceY = candidate.dst.bedY;
          candidate.dst.emitterId = src.emitterId;
          candidate.dst.adhesion = src.adhesion;
          candidate.dst.settled = 0;
          setLocalShallowOwnership(
            candidate.dst,
            Math.max(
              0.55,
              (Number.isFinite(src.ownershipConfidence) ? src.ownershipConfidence : 1) * 0.85,
            ),
            resolvedTick,
            src.authority,
            true,
          );
        }
      }

      if (terrainGuideWeight > 0.0001) {
        const invGuide = 1 / terrainGuideWeight;
        netVX += terrainGuideX * invGuide * src.thickness * 0.44;
        netVZ += terrainGuideZ * invGuide * src.thickness * 0.44;
      }

      // Blend net flow direction into spread velocity (clamped, replaces accumulation).
      if (netVX !== 0 || netVZ !== 0) {
        const slopeBlendBoost =
          terrainGuideWeight > 0.0001 ? clamp01(maxTerrainDrop / 0.22) * 3.1 : 0;
        const blendRate = (4.0 + slopeBlendBoost) * dt;
        src.spreadVX += (netVX - src.spreadVX) * blendRate;
        src.spreadVZ += (netVZ - src.spreadVZ) * blendRate;
        const spd = Math.hypot(src.spreadVX, src.spreadVZ);
        if (spd > config.maxSpreadVelocity) {
          const inv = config.maxSpreadVelocity / spd;
          src.spreadVX *= inv;
          src.spreadVZ *= inv;
        }
      }
    }
  }

  // Apply transfers
  for (let i = 0; i < sz * sz; i++) {
    if (transfer[i] === 0) continue;
    const col = cols[i];
    col.thickness = Math.max(0, col.thickness + transfer[i]);
    if (col.active) {
      col.surfaceY = col.bedY + col.thickness;
    }
    if (col.active && col.thickness < 0.0001) {
      col.active = false;
      col.thickness = 0;
      col.surfaceY = col.bedY;
          col.handoffPending = false;
          col.ownershipDomain = "none";
          col.spreadVX = 0;
          col.spreadVZ = 0;
          col.handoffGraceTicks = 0;
        }
      }
    }

function _tickSectionSettle(
  grid: ShallowWaterSectionGrid,
  dt: number,
  config: ShallowWaterConfig,
  ghosts: ShallowGhostColumnSet | null,
  ownershipPreview?: WaterOwnershipPreview,
) {
  const hints = flowHintGrids.get(sectionKey(grid.originX, grid.originZ));
  for (let z = 0; z < grid.sizeZ; z++) {
    for (let x = 0; x < grid.sizeX; x++) {
      const col = grid.columns[colIdx(x, z)];
      if (!col.active) continue;
      if (
        !shouldSimulateShallowColumn(
          ownershipPreview,
          grid.originX,
          grid.originZ,
          x,
          z,
          grid.sizeX,
        )
      ) {
        continue;
      }
      const hint = hints ? hints[colIdx(x, z)] : undefined;
      const flowHintMag = hint ? Math.hypot(hint.flowX, hint.flowZ) : 0;
      const connectedNeighbors = countConnectedNeighbors(grid, x, z, ghosts);
      const connectedness = clamp01(connectedNeighbors / 4);
      const dynamicSettlingRate =
        config.settlingRate *
        (1 - clamp01(flowHintMag) * 0.44) *
        (1 - clamp01(col.thickness / Math.max(0.0001, config.handoffThickness)) * 0.18) *
        (1 - connectedness * 0.22);
      // Spread velocity decays toward zero as water settles
      const decay = Math.exp(-Math.max(0.02, dynamicSettlingRate) * dt);
      col.spreadVX *= decay;
      col.spreadVZ *= decay;
      const velocity = Math.hypot(col.spreadVX, col.spreadVZ);
      const dynamicRestVelocity = 0.045 + flowHintMag * 0.08;
      const settledTarget = velocity < dynamicRestVelocity ? 1 : 0;
      col.settled += (settledTarget - col.settled) * Math.max(0.02, dynamicSettlingRate) * dt;
      col.settled = Math.max(0, Math.min(1, col.settled));
    }
  }
}

function _tickSectionEvaporation(
  grid: ShallowWaterSectionGrid,
  dt: number,
  config: ShallowWaterConfig,
  ghosts: ShallowGhostColumnSet | null,
  ownershipPreview?: WaterOwnershipPreview,
) {
  let evaporatedMass = 0;
  const hints = flowHintGrids.get(sectionKey(grid.originX, grid.originZ));
  for (let z = 0; z < grid.sizeZ; z++) {
    for (let x = 0; x < grid.sizeX; x++) {
      const col = grid.columns[colIdx(x, z)];
      if (!col.active) continue;
      if (
        !shouldSimulateShallowColumn(
          ownershipPreview,
          grid.originX,
          grid.originZ,
          x,
          z,
          grid.sizeX,
        )
      ) {
        continue;
      }
      const hint: ShallowWaterExternalFlowHint | undefined = hints ? hints[colIdx(x, z)] : undefined;
      const connectedNeighbors = countConnectedNeighbors(grid, x, z, ghosts);
      const connectedness = clamp01(connectedNeighbors / 4);
      const effectiveEvapRate = (hint
        ? config.evaporationRate * hint.drainageMultiplier
        : config.evaporationRate) * (1 - connectedness * 0.78);
      // Only evaporate thin, settled columns (pooled water evaporates slower)
      const thinnessFactor = Math.max(0, 1 - col.thickness / 0.15);
      const evaporated = Math.max(
        0,
        Math.min(col.thickness, effectiveEvapRate * thinnessFactor * col.settled * dt),
      );
      col.thickness -= evaporated;
      evaporatedMass += evaporated;
      if (col.thickness <= 0) {
        col.active = false;
        col.thickness = 0;
        col.surfaceY = col.bedY;
        col.handoffPending = false;
        col.ownershipDomain = "none";
        col.spreadVX = 0;
        col.spreadVZ = 0;
        col.handoffGraceTicks = 0;
      } else {
        col.surfaceY = col.bedY + col.thickness;
      }
    }
  }
  return evaporatedMass;
}
