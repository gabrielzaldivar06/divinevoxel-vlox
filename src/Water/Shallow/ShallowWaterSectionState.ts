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
import type { ShallowHandoffResult } from "../Contracts/WaterSemanticContract.js";
import type { WaterBoundaryDirection } from "../Runtime/WaterBoundaryFluxBuffer.js";
import {
  shouldSimulateShallowColumn,
  type WaterOwnershipPreview,
} from "../Runtime/WaterOwnershipResolver.js";
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

/** All active section grids, keyed by "x_z" (section origin in voxel coords). */
const sections = new Map<string, ShallowWaterSectionGrid>();

/** Flow hint grids, keyed by "x_z". */
const flowHintGrids = new Map<string, ShallowWaterExternalFlowHint[]>();

export type ShallowHandoffCallback = (
  worldX: number,
  worldZ: number,
  surfaceY: number,
  thickness: number,
  emitterId: number,
) => ShallowHandoffResult;

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
    column.ownershipConfidence >= MIN_TRANSFER_CONFIDENCE &&
    column.ownershipTicks >= MIN_STABLE_OWNERSHIP_TICKS
  );
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
) {
  if (thickness <= 0) return 0;

  const sectionOriginX = Math.floor(worldX / SECTION_SIZE) * SECTION_SIZE;
  const sectionOriginZ = Math.floor(worldZ / SECTION_SIZE) * SECTION_SIZE;
  const terrainY = surfaceY - thickness;
  const grid = getOrCreateShallowSection(sectionOriginX, sectionOriginZ, terrainY);

  const localX = ((worldX % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;
  const localZ = ((worldZ % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;
  const col = grid.columns[colIdx(localX, localZ)];
  let addedThickness = thickness;

  if (!col.active) {
    col.active = true;
    col.bedY = terrainY;
    col.thickness = thickness;
    col.surfaceY = col.bedY + col.thickness;
    // Start with a small outward burst so the water spreads visibly
    // (settled=0 keeps it unsettled until spreadVX/VZ decay naturally)
    col.spreadVX = (Math.random() - 0.5) * 0.15;
    col.spreadVZ = (Math.random() - 0.5) * 0.15;
    col.settled = 0;
    col.adhesion = 0.5;
    col.age = 0;
    col.emitterId = emitterId;
    col.handoffPending = false;
    setLocalShallowOwnership(col, 1, _shallowTick, "editor", true);
  } else {
    const previousThickness = col.thickness;
    col.bedY = terrainY;
    col.thickness = Math.min(col.thickness + thickness, config.handoffThickness * 1.2);
    col.surfaceY = col.bedY + col.thickness;
    col.settled = Math.max(0, col.settled - 0.15);
    col.emitterId = emitterId > 0 ? emitterId : col.emitterId;
    setLocalShallowOwnership(col, 1, _shallowTick, "editor");
    addedThickness = Math.max(0, col.thickness - previousThickness);
  }

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
    _tickSectionSettle(grid, clampedDt, config, ownershipPreview);
    evaporatedMass += _tickSectionEvaporation(grid, clampedDt, config, ownershipPreview);

    for (let z = 0; z < grid.sizeZ; z++) {
      for (let x = 0; x < grid.sizeX; x++) {
        const col = grid.columns[colIdx(x, z)];
        if (!col.active) continue;

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
        col.handoffPending = canShallowColumnHandoff(col) && col.thickness >= config.handoffThickness;

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
          col.surfaceY,
          col.thickness,
          col.emitterId,
        );

        col.lastResolvedTick = _shallowTick;

        if (handoffResult === "accepted") {
          transferredMassToContinuous += col.thickness;
          acceptedCount += 1;
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
          continue;
        }

        const fallbackConfidence =
          handoffResult === "deferred"
            ? Math.max(0.55, col.ownershipConfidence * 0.9)
            : Math.max(0.35, col.ownershipConfidence * 0.55);
        setLocalShallowOwnership(col, fallbackConfidence, _shallowTick, col.authority);
        col.handoffPending = forceContinuousTransfer || handoffResult === "deferred";
        if (handoffResult === "deferred") {
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

  // Two-pass: first accumulate deltas, then apply (avoid order dependency)
  const transfer = new Float32Array(sz * sz);

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

      // Phase 2: apply external flow hint if available
      const hint: ShallowWaterExternalFlowHint | undefined = hints ? hints[colIdx(x, z)] : undefined;
      if (hint) {
        const flowMag = Math.hypot(hint.flowX, hint.flowZ);
        if (flowMag > 0.001) {
          // Directional flow boost in hint direction
          const flowBoost =
            config.spreadRate * flowMag * dt * (1 - src.adhesion) * 0.5 * sourceFlowScale;
          const tnx = x + Math.round(hint.flowX);
          const tnz = z + Math.round(hint.flowZ);
          if (tnx >= 0 && tnx < sz && tnz >= 0 && tnz < sz) {
            if (
              !shouldSimulateShallowColumn(
                ownershipPreview,
                grid.originX,
                grid.originZ,
                tnx,
                tnz,
                grid.sizeX,
              )
            ) {
              continue;
            }
            const tIdx = colIdx(tnx, tnz);
            const tDst = cols[tIdx];
            const boost = Math.min(flowBoost, src.thickness * 0.5);
            transfer[srcIdx] -= boost;
            transfer[tIdx] += boost;
            if (!tDst.active) {
              tDst.active = true;
              tDst.surfaceY = tDst.bedY;
              tDst.emitterId = src.emitterId;
              tDst.adhesion = src.adhesion;
              setLocalShallowOwnership(
                tDst,
                Math.max(0.55, (Number.isFinite(src.ownershipConfidence) ? src.ownershipConfidence : 1) * 0.85),
                resolvedTick,
                src.authority,
                true,
              );
            }
          }
          src.spreadVX += hint.flowX * flowMag * 0.3;
          src.spreadVZ += hint.flowZ * flowMag * 0.3;
        }
        // Apply shore adhesion lerp
        const lerpT = Math.min(1, 0.05 * dt * 20);
        src.adhesion += (hint.shoreFactor * 0.9 - src.adhesion) * lerpT;
      }

      // Flow toward lower neighbors (gravity-driven spread).
      // heightDiff = src water surface - dst water surface (or terrain floor if dry).
      // src.surfaceY and dst.surfaceY are both water-surface Y (terrainY + thickness).
      // WaterBall tension-free pressure: when cell is over-compressed (thick > rest),
      // it gets an extra push. max(0,...) means no suction when thin → organic spreading.
      const SHALLOW_TAIT_REST = 0.04; // ~4cm rest film thickness
      const taitBoost = Math.max(0, 0.55 * (Math.pow(src.thickness / SHALLOW_TAIT_REST, 3) - 1));
      const effectiveSpreadRate = config.spreadRate * (1 + taitBoost) * sourceFlowScale;
      let totalOut = 0;
      for (const [dx, dz] of NEIGHBORS) {
        const nx = x + dx;
        const nz = z + dz;
        let dstLevel = src.bedY;

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
          const dst = cols[colIdx(nx, nz)];
          dstLevel = dst.active ? dst.surfaceY : dst.bedY;
        } else {
          if (!boundaryRegistry) continue;
          const direction = getBoundaryDirection(dx, dz);
          const neighborOrigin = getNeighborSectionOrigin(grid.originX, grid.originZ, direction);
          const targetX = direction === "west" ? grid.sizeX - 1 : direction === "east" ? 0 : x;
          const targetZ = direction === "north" ? grid.sizeZ - 1 : direction === "south" ? 0 : z;
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
          const boundaryIndex = getBoundaryIndex(direction, x, z);
          const ghost = getGhostColumn(ghosts, direction, boundaryIndex);
          dstLevel = ghost ? (ghost.active ? ghost.surfaceY : ghost.bedY) : src.bedY;
        }

        const heightDiff = src.surfaceY - dstLevel;
        if (heightDiff > 0.005) {
          const flowAmount = effectiveSpreadRate * heightDiff * dt * (1 - src.adhesion);
          totalOut += flowAmount;
        }
      }

      if (totalOut <= 0) continue;
      const scale = totalOut > src.thickness ? src.thickness / totalOut : 1;

      // Accumulate net flow direction for visual velocity (reset each frame in settle).
      let netVX = 0;
      let netVZ = 0;

      for (const [dx, dz] of NEIGHBORS) {
        const nx = x + dx;
        const nz = z + dz;
        let dstLevel = src.bedY;
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
        } else {
          if (!boundaryRegistry) continue;
          boundaryDirection = getBoundaryDirection(dx, dz);
          const neighborOrigin = getNeighborSectionOrigin(
            grid.originX,
            grid.originZ,
            boundaryDirection,
          );
          const targetX =
            boundaryDirection === "west"
              ? grid.sizeX - 1
              : boundaryDirection === "east"
                ? 0
                : x;
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
        }

        const heightDiff = src.surfaceY - dstLevel;
        if (heightDiff > 0.005) {
          const flowAmount = effectiveSpreadRate * heightDiff * dt * (1 - src.adhesion) * scale;
          transfer[srcIdx] -= flowAmount;
          netVX += dx * flowAmount;
          netVZ += dz * flowAmount;

          if (!dst && boundaryRegistry && boundaryDirection) {
            const neighborOrigin = getNeighborSectionOrigin(
              grid.originX,
              grid.originZ,
              boundaryDirection,
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
              boundaryDirection,
              boundaryIndex,
              flowAmount,
              dx * flowAmount,
              dz * flowAmount,
              resolvedTick,
              src.bedY,
            );
            continue;
          }

          transfer[colIdx(nx, nz)] += flowAmount;

          // Activate neighbor if it receives water
          if (dst && !dst.active) {
            dst.active = true;
            dst.surfaceY = dst.bedY;
            dst.emitterId = src.emitterId;
            dst.adhesion = src.adhesion;
            dst.settled = 0;
            setLocalShallowOwnership(
              dst,
              Math.max(0.55, (Number.isFinite(src.ownershipConfidence) ? src.ownershipConfidence : 1) * 0.85),
              resolvedTick,
              src.authority,
              true,
            );
          }
        }
      }

      // Blend net flow direction into spread velocity (clamped, replaces accumulation).
      if (netVX !== 0 || netVZ !== 0) {
        const blendRate = 4.0 * dt;
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
    }
  }
}

function _tickSectionSettle(
  grid: ShallowWaterSectionGrid,
  dt: number,
  config: ShallowWaterConfig,
  ownershipPreview?: WaterOwnershipPreview,
) {
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
    // Spread velocity decays toward zero as water settles
      const decay = Math.exp(-config.settlingRate * dt);
      col.spreadVX *= decay;
      col.spreadVZ *= decay;
      const velocity = Math.hypot(col.spreadVX, col.spreadVZ);
      const settledTarget = velocity < 0.05 ? 1 : 0;
      col.settled += (settledTarget - col.settled) * config.settlingRate * dt;
      col.settled = Math.max(0, Math.min(1, col.settled));
    }
  }
}

function _tickSectionEvaporation(
  grid: ShallowWaterSectionGrid,
  dt: number,
  config: ShallowWaterConfig,
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
      const effectiveEvapRate = hint
        ? config.evaporationRate * hint.drainageMultiplier
        : config.evaporationRate;
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
      } else {
        col.surfaceY = col.bedY + col.thickness;
      }
    }
  }
  return evaporatedMass;
}
