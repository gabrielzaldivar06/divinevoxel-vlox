import type { WaterSectionUpdateTask } from "../../Mesher/Types/Mesher.types.js";
import { readWaterPatchSummaryEntry } from "../Types/WaterPatchSummaryContract";
import {
  DEFAULT_CONTINUOUS_WATER_CONFIG,
  createEmptyContinuousColumn,
  type ContinuousToShallowCallback,
  type ContinuousWaterColumn,
  type ContinuousWaterConfig,
  type ContinuousWaterSection,
} from "./ContinuousWaterTypes.js";
import type { WaterBoundaryDirection } from "../Runtime/WaterBoundaryFluxBuffer.js";
import type {
  WaterBoundaryFluxSnapshot,
  WaterChunkRegistry,
  WaterGhostColumnSet,
} from "../Runtime/WaterChunkRegistry.js";
import {
  shouldSimulateContinuousColumn,
  type WaterOwnershipPreview,
} from "../Runtime/WaterOwnershipResolver.js";
import type { WaterRuntimePhaseAccounting } from "../Runtime/WaterRuntimeOrchestrator.js";

const DEFAULT_SECTION_SIZE = 16;
const UNKNOWN_SHORE_DISTANCE = 0xff;
const MIN_TRANSFER_CONFIDENCE = 0.6;
const MIN_CONFIDENCE_FLOW_SCALE = 0.2;
const MIN_LOCKED_FLOW_SCALE = 0.2;
const MIN_STABLE_OWNERSHIP_TICKS = 3;
const HANDOFF_GRACE_TICKS = MIN_STABLE_OWNERSHIP_TICKS;
const UPSTREAM_BIAS_WEIGHT = 0.12;
const CONFINEMENT_WEIGHT = 0.08;
const sections = new Map<string, ContinuousWaterSection>();
let _continuousTick = 0;

export interface ContinuousWaterTickSummary {
  activeKeys: string[];
  accounting: WaterRuntimePhaseAccounting;
}

const CARDINAL_STEPS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;

function sectionKey(originX: number, originZ: number) {
  return `${originX}_${originZ}`;
}

function colIdx(sizeX: number, x: number, z: number) {
  return z * sizeX + x;
}

function resetContinuousColumn(column: ContinuousWaterColumn) {
  const bedY = column.bedY;
  Object.assign(column, createEmptyContinuousColumn());
  column.bedY = bedY;
  column.surfaceY = bedY;
}

function createSection(
  originX: number,
  originZ: number,
  sizeX: number,
  sizeZ: number,
): ContinuousWaterSection {
  const columns: ContinuousWaterColumn[] = [];
  for (let i = 0; i < sizeX * sizeZ; i++) {
    columns.push(createEmptyContinuousColumn());
  }
  return {
    originX,
    originZ,
    sizeX,
    sizeZ,
    columns,
    lastTickDt: 0,
    topologyVersion: 0,
  };
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

function getGhostColumn(
  ghosts: WaterGhostColumnSet | null,
  direction: WaterBoundaryDirection,
  index: number,
) {
  return ghosts?.[direction]?.[index] ?? null;
}

function getShoreFactor(metadata: number) {
  const shoreDistance = (metadata >>> 16) & 0xff;
  if (shoreDistance === UNKNOWN_SHORE_DISTANCE) return 0;
  return Math.max(0, 1 - Math.min(shoreDistance, 8) / 8);
}

function getConfidenceFlowScale(confidence: number) {
  if (!Number.isFinite(confidence) || confidence <= 0) {
    return MIN_CONFIDENCE_FLOW_SCALE;
  }
  if (confidence >= MIN_TRANSFER_CONFIDENCE) {
    return 1;
  }
  return Math.max(MIN_CONFIDENCE_FLOW_SCALE, confidence / MIN_TRANSFER_CONFIDENCE);
}

function getOwnershipTickScale(ownershipTicks: number) {
  if (ownershipTicks <= 0) {
    return 0.35;
  }
  return Math.max(0.35, Math.min(1, ownershipTicks / MIN_STABLE_OWNERSHIP_TICKS));
}

function getLockedFlowScale(column: ContinuousWaterColumn) {
  if (!column.ownershipLocked) return 1;
  const confidence = Number.isFinite(column.ownershipConfidence)
    ? Math.max(0, Math.min(1, column.ownershipConfidence))
    : 0;
  return MIN_LOCKED_FLOW_SCALE + (1 - MIN_LOCKED_FLOW_SCALE) * confidence;
}

function canContinuousColumnHandoff(column: ContinuousWaterColumn) {
  return (
    column.handoffGraceTicks <= 0 &&
    !column.ownershipLocked &&
    column.ownershipConfidence >= MIN_TRANSFER_CONFIDENCE &&
    column.ownershipTicks >= MIN_STABLE_OWNERSHIP_TICKS
  );
}

export interface ContinuousWaterSeedOptions {
  bedY?: number;
  authority?: ContinuousWaterColumn["authority"];
  ownershipConfidence?: number;
  ownershipTicks?: number;
  ownershipLocked?: boolean;
  handoffGraceTicks?: number;
}

function getColumnFlowScale(column: ContinuousWaterColumn) {
  return Math.min(
    1,
    getConfidenceFlowScale(column.ownershipConfidence) *
      getOwnershipTickScale(column.ownershipTicks) *
      getLockedFlowScale(column),
  );
}

function applyInboundFluxes(
  section: ContinuousWaterSection,
  inbound: WaterBoundaryFluxSnapshot | null,
  tick: number,
) {
  if (!inbound) return;

  const applyFlux = (
    direction: WaterBoundaryDirection,
    entries: WaterBoundaryFluxSnapshot[WaterBoundaryDirection],
  ) => {
    for (let i = 0; i < entries.length; i++) {
      const flux = entries[i];
      if (flux.mass <= 0) continue;
      // Allow flux from the previous tick: finalizeTick delivers with the
      // producer's tick (N) but consumption runs on tick N+1.
      if (flux.tick !== 0 && flux.tick !== tick && flux.tick !== tick - 1) continue;

      const x = direction === "west" ? 0 : direction === "east" ? section.sizeX - 1 : i;
      const z = direction === "north" ? 0 : direction === "south" ? section.sizeZ - 1 : i;
      const column = section.columns[colIdx(section.sizeX, x, z)];
      if (!column.active && Number.isFinite(flux.bedY)) {
        column.bedY = flux.bedY;
        column.surfaceY = flux.bedY;
      }
      column.active = true;
      column.pendingInboundMass += flux.mass;
      column.mass += flux.mass;
      column.depth = column.mass;
      column.surfaceY = column.bedY + column.depth;
      column.velocityX = (column.velocityX + flux.velocityX) * 0.5;
      column.velocityZ = (column.velocityZ + flux.velocityZ) * 0.5;
      column.pressure = column.depth;
      column.lastResolvedTick = tick;
      column.ownershipTicks = Math.max(1, column.ownershipTicks);
      if (column.authority === "bootstrap") {
        column.authority = "continuous-handoff";
        column.ownershipLocked = false;
      }
    }
  };

  applyFlux("north", inbound.north);
  applyFlux("south", inbound.south);
  applyFlux("east", inbound.east);
  applyFlux("west", inbound.west);
}

export function getOrCreateContinuousSection(
  originX: number,
  originZ: number,
  sizeX = DEFAULT_SECTION_SIZE,
  sizeZ = DEFAULT_SECTION_SIZE,
): ContinuousWaterSection {
  const key = sectionKey(originX, originZ);
  const existing = sections.get(key);
  if (existing && existing.sizeX === sizeX && existing.sizeZ === sizeZ) {
    return existing;
  }

  const next = createSection(originX, originZ, sizeX, sizeZ);
  sections.set(key, next);
  return next;
}

export function getContinuousSection(originX: number, originZ: number) {
  return sections.get(sectionKey(originX, originZ));
}

export function getActiveContinuousSections(): ReadonlyMap<string, ContinuousWaterSection> {
  return sections;
}

export function removeContinuousSection(originX: number, originZ: number) {
  sections.delete(sectionKey(originX, originZ));
}

export function clearAllContinuousWater() {
  sections.clear();
}

export function measureContinuousWaterMass() {
  let total = 0;
  for (const section of sections.values()) {
    for (const column of section.columns) {
      if (!column.active) continue;
      total += column.mass;
    }
  }
  return total;
}

export function addContinuousWaterSeed(
  worldX: number,
  worldZ: number,
  surfaceY: number,
  depth: number,
  bodyId = 1,
  options: ContinuousWaterSeedOptions = {},
) {
  if (depth <= 0) return 0;

  const sizeX = DEFAULT_SECTION_SIZE;
  const sizeZ = DEFAULT_SECTION_SIZE;
  const originX = Math.floor(worldX / sizeX) * sizeX;
  const originZ = Math.floor(worldZ / sizeZ) * sizeZ;
  const section = getOrCreateContinuousSection(originX, originZ, sizeX, sizeZ);
  const localX = ((worldX % sizeX) + sizeX) % sizeX;
  const localZ = ((worldZ % sizeZ) + sizeZ) % sizeZ;
  const column = section.columns[colIdx(section.sizeX, localX, localZ)];
  const bedY = Number.isFinite(options.bedY) ? (options.bedY as number) : surfaceY - depth;
  const authority = options.authority ?? "continuous-handoff";
  const ownershipConfidence = options.ownershipConfidence ?? 1;
  const ownershipTicks =
    options.ownershipTicks !== undefined ? Math.max(0, options.ownershipTicks) : null;
  const handoffGraceTicks = Math.max(0, options.handoffGraceTicks ?? 0);

  for (const candidate of section.columns) {
    if (candidate.active) continue;
    if (candidate.bedY !== 0 || candidate.surfaceY !== 0) continue;
    candidate.bedY = bedY;
    candidate.surfaceY = bedY;
  }

  if (!column.active || !Number.isFinite(column.bedY)) {
    column.bedY = bedY;
  }
  column.active = true;
  column.mass += depth;
  column.depth = column.mass;
  column.surfaceY = column.bedY + column.depth;
  column.pressure = column.depth;
  column.bodyId = Math.max(bodyId, column.bodyId, 1);
  column.openWaterFactor = Math.max(column.openWaterFactor, Math.min(1, column.depth));
  column.ownershipLocked = options.ownershipLocked ?? false;
  column.turbulence = Math.max(column.turbulence, 0.1);
  column.foamPotential = Math.max(column.foamPotential, 0.1);
  column.handoffPending = false;
  column.ownershipDomain = "continuous";
  column.ownershipConfidence = ownershipConfidence;
  column.ownershipTicks =
    ownershipTicks ?? Math.max(1, column.ownershipTicks);
  column.authority = authority;
  column.lastResolvedTick = _continuousTick;
  column.handoffGraceTicks = handoffGraceTicks;
  section.topologyVersion += 1;
  return depth;
}

export function syncContinuousSectionFromGPUData(
  update: WaterSectionUpdateTask,
  config: ContinuousWaterConfig = DEFAULT_CONTINUOUS_WATER_CONFIG,
) {
  const section = getOrCreateContinuousSection(
    update.originX,
    update.originZ,
    update.boundsX,
    update.boundsZ,
  );
  const { columnBuffer, columnMetadata, columnPatchIndex, columnStride } = update.gpuData;

  for (let i = 0; i < section.columns.length; i++) {
    const column = section.columns[i];
    const meta = columnMetadata[i] ?? 0;
    if (column.active && column.authority !== "bootstrap") {
      continue;
    }
    const base = i * columnStride;
    const filled = (meta & 0x1) !== 0;
    const surfaceY = columnBuffer[base + 1] ?? 0;
    const fill = columnBuffer[base + 2] ?? 0;
    const bottomHeight = columnBuffer[base + 6] ?? surfaceY;
    const depth = Math.max(0, surfaceY - bottomHeight);

    if (!filled || depth <= config.minActiveDepth) {
      resetContinuousColumn(column);
      column.bedY = bottomHeight;
      column.surfaceY = bottomHeight;
      column.authority = "bootstrap";
      continue;
    }

    const flowStrength = columnBuffer[base + 5] ?? 0;
    column.active = true;
    column.mass = depth;
    column.bedY = bottomHeight;
    column.depth = depth;
    column.surfaceY = surfaceY;
    column.velocityX = (columnBuffer[base + 3] ?? 0) * flowStrength;
    column.velocityZ = (columnBuffer[base + 4] ?? 0) * flowStrength;
    column.pressure = depth;
    const patchLookup = columnPatchIndex[i] ?? 0;
    const patchSummary =
      patchLookup > 0
        ? readWaterPatchSummaryEntry(
            update.gpuData.patchSummaryBuffer,
            update.gpuData.patchSummaryStride,
            update.gpuData.patchMetadata,
            update.gpuData.patchSummaryCount,
            patchLookup - 1,
          )
        : null;
    column.bodyId = patchSummary?.waterBodyId ?? 0;
    column.openWaterFactor = Math.min(1, fill);
    column.shoreFactor = getShoreFactor(meta);
    column.ownershipLocked = true;
    column.turbulence = columnBuffer[base + 7] ?? 0;
    column.foamPotential = Math.min(1, column.turbulence * 0.6 + column.shoreFactor * 0.4);
    column.handoffPending = false;
    column.pendingInboundMass = 0;
    column.pendingOutboundMass = 0;
    column.lastResolvedTick = _continuousTick;
    column.ownershipDomain = "continuous";
    column.ownershipTicks = Math.max(1, column.ownershipTicks);
    column.authority = "bootstrap";
  }

  section.topologyVersion += 1;
  return section;
}

/**
 * Compute upstream bias and confinement-adjusted pressure for every active
 * column in a section.
 *
 * pressure = depth + upstreamBias + confinementFactor
 *
 * upstreamBias: weighted average of neighbor pressures that exceed ours,
 *   scaled to propagate hydraulic "head" from dammed / confined regions.
 * confinementFactor: fraction of neighbors with equal-or-higher pressure,
 *   representing how boxed-in the column is.
 */
function accumulateSectionPressure(section: ContinuousWaterSection) {
  const { sizeX, sizeZ, columns } = section;

  for (let z = 0; z < sizeZ; z++) {
    for (let x = 0; x < sizeX; x++) {
      const idx = z * sizeX + x;
      const col = columns[idx];
      if (!col.active) continue;

      let upstreamSum = 0;
      let upstreamCount = 0;
      let confinedCount = 0;
      let neighborCount = 0;

      for (const [dx, dz] of CARDINAL_STEPS) {
        const nx = x + dx;
        const nz = z + dz;
        if (nx < 0 || nx >= sizeX || nz < 0 || nz >= sizeZ) continue;
        const neighbor = columns[nz * sizeX + nx];
        if (!neighbor.active) continue;
        neighborCount++;

        if (neighbor.depth >= col.depth) {
          confinedCount++;
        }
        if (neighbor.depth > col.depth) {
          upstreamSum += neighbor.depth - col.depth;
          upstreamCount++;
        }
      }

      const upstreamBias =
        upstreamCount > 0
          ? (upstreamSum / upstreamCount) * UPSTREAM_BIAS_WEIGHT
          : 0;
      const confinementFactor =
        neighborCount > 0
          ? (confinedCount / neighborCount) * col.depth * CONFINEMENT_WEIGHT
          : 0;

      col.pressure = col.depth + upstreamBias + confinementFactor;
    }
  }
}

/**
 * Return the cardinal neighbor pressures for a column. Used by the event
 * resolver to evaluate confinement rules.
 */
export function getNeighborPressures(
  section: ContinuousWaterSection,
  x: number,
  z: number,
): number[] {
  const result: number[] = [];
  for (const [dx, dz] of CARDINAL_STEPS) {
    const nx = x + dx;
    const nz = z + dz;
    if (nx < 0 || nx >= section.sizeX || nz < 0 || nz >= section.sizeZ) continue;
    const neighbor = section.columns[nz * section.sizeX + nx];
    if (!neighbor.active) continue;
    result.push(neighbor.pressure);
  }
  return result;
}

export function tickContinuousWater(
  dt: number,
  registry?: WaterChunkRegistry,
  config: ContinuousWaterConfig = DEFAULT_CONTINUOUS_WATER_CONFIG,
  ownershipPreview?: WaterOwnershipPreview,
): ContinuousWaterTickSummary {
  const activeKeys: string[] = [];
  const sectionsToRemove: Array<{ key: string; originX: number; originZ: number }> = [];
  const clampedDt = Math.min(dt, 0.1);
  const tick = ++_continuousTick;
  let prunedMass = 0;
  let clampedNegativeMass = 0;
  const massBeforeColumns = measureContinuousWaterMass();
  const massBeforeBuffered = registry?.measureBufferedMass() ?? 0;

  registry?.beginTick(sections, tick);

  for (const [key, section] of sections) {
    applyInboundFluxes(section, registry?.consumeInboundFlux(section.originX, section.originZ) ?? null, tick);
    const transfer = new Float64Array(section.columns.length);
    const velocityXDelta = new Float64Array(section.columns.length);
    const velocityZDelta = new Float64Array(section.columns.length);
    const ghosts = registry?.getGhostColumns(section.originX, section.originZ) ?? null;

    let anyActive = false;

    for (let z = 0; z < section.sizeZ; z++) {
      for (let x = 0; x < section.sizeX; x++) {
        const sourceIndex = colIdx(section.sizeX, x, z);
        const source = section.columns[sourceIndex];
        if (!source.active || source.mass <= config.minActiveDepth) continue;
        if (
          !shouldSimulateContinuousColumn(
            ownershipPreview,
            section.originX,
            section.originZ,
            x,
            z,
            section.sizeX,
          )
        ) {
          source.handoffPending = false;
          anyActive = true;
          continue;
        }

        anyActive = true;
        const sourceFlowScale = getColumnFlowScale(source);
        source.pendingOutboundMass = 0;

        const flowCandidates: Array<{
          neighborIndex: number;
          direction: WaterBoundaryDirection;
          boundaryIndex: number;
          ghostActive: boolean;
          velocityX: number;
          velocityZ: number;
          wantedMass: number;
        }> = [];
        let totalWantedMass = 0;

        for (const [dx, dz] of CARDINAL_STEPS) {
          const nx = x + dx;
          const nz = z + dz;
          const direction = getBoundaryDirection(dx, dz);
          let neighborSurfaceY = 0;
          let neighborIndex = -1;
          let ghostActive = false;

          if (nx >= 0 && nx < section.sizeX && nz >= 0 && nz < section.sizeZ) {
            if (
              !shouldSimulateContinuousColumn(
                ownershipPreview,
                section.originX,
                section.originZ,
                nx,
                nz,
                section.sizeX,
              )
            ) {
              continue;
            }
            neighborIndex = colIdx(section.sizeX, nx, nz);
            const neighbor = section.columns[neighborIndex];
            neighborSurfaceY = neighbor.active ? neighbor.surfaceY : neighbor.bedY;
          } else {
            const boundaryIndex = getBoundaryIndex(direction, x, z);
            const neighborOrigin = registry
              ? (() => {
                  switch (direction) {
                    case "north":
                      return { originX: section.originX, originZ: section.originZ - section.sizeZ };
                    case "south":
                      return { originX: section.originX, originZ: section.originZ + section.sizeZ };
                    case "east":
                      return { originX: section.originX + section.sizeX, originZ: section.originZ };
                    case "west":
                      return { originX: section.originX - section.sizeX, originZ: section.originZ };
                  }
                })()
              : null;
            const targetX = direction === "west" ? section.sizeX - 1 : direction === "east" ? 0 : x;
            const targetZ = direction === "north" ? section.sizeZ - 1 : direction === "south" ? 0 : z;
            if (
              neighborOrigin &&
              !shouldSimulateContinuousColumn(
                ownershipPreview,
                neighborOrigin.originX,
                neighborOrigin.originZ,
                targetX,
                targetZ,
                section.sizeX,
              )
            ) {
              continue;
            }
            const ghost = getGhostColumn(ghosts, direction, boundaryIndex);
            if (!ghost?.active) continue;
            neighborSurfaceY = ghost.surfaceY;
            ghostActive = true;
          }

          const gradient = source.surfaceY - neighborSurfaceY;
          if (gradient <= 0.001) continue;

          let flowScale = sourceFlowScale;
          if (neighborIndex >= 0) {
            const neighbor = section.columns[neighborIndex];
            if (neighbor.active) {
              flowScale = Math.min(flowScale, getColumnFlowScale(neighbor));
            }
          }

          const wantedMass = gradient * config.conductance * clampedDt * 0.25 * flowScale;
          if (wantedMass <= 0.0001) continue;

          flowCandidates.push({
            neighborIndex,
            direction,
            boundaryIndex: getBoundaryIndex(direction, x, z),
            ghostActive,
            velocityX: dx,
            velocityZ: dz,
            wantedMass,
          });
          totalWantedMass += wantedMass;
        }

        if (flowCandidates.length === 0 || totalWantedMass <= 0) {
          continue;
        }

        const maxOutboundMass = Math.min(
          source.mass,
          source.mass * config.maxFluxPerTickRatio * sourceFlowScale,
        );
        const flowScale = Math.min(1, maxOutboundMass / totalWantedMass);
        if (flowScale <= 0) {
          continue;
        }

        for (const candidate of flowCandidates) {
          const fluxMass = candidate.wantedMass * flowScale;
          if (fluxMass <= 0.0001) continue;

          transfer[sourceIndex] -= fluxMass;
          velocityXDelta[sourceIndex] -= candidate.velocityX * fluxMass;
          velocityZDelta[sourceIndex] -= candidate.velocityZ * fluxMass;
          source.pendingOutboundMass += fluxMass;

          if (candidate.ghostActive) {
            registry?.recordOutboundFlux(
              section.originX,
              section.originZ,
              candidate.direction,
              candidate.boundaryIndex,
              fluxMass,
              candidate.velocityX * fluxMass,
              candidate.velocityZ * fluxMass,
              tick,
            );
            continue;
          }

          transfer[candidate.neighborIndex] += fluxMass;
          velocityXDelta[candidate.neighborIndex] += candidate.velocityX * fluxMass;
          velocityZDelta[candidate.neighborIndex] += candidate.velocityZ * fluxMass;
        }
      }
    }

    for (let i = 0; i < section.columns.length; i++) {
      const column = section.columns[i];
      const x = i % section.sizeX;
      const z = Math.floor(i / section.sizeX);
      if (column.active && column.handoffGraceTicks > 0) {
        column.handoffGraceTicks -= 1;
      }
      if (
        !shouldSimulateContinuousColumn(
          ownershipPreview,
          section.originX,
          section.originZ,
          x,
          z,
          section.sizeX,
        )
      ) {
        if (column.active) {
          anyActive = true;
          column.surfaceY = column.bedY + column.depth;
          column.pressure = column.depth;
          column.pendingInboundMass = 0;
          column.lastResolvedTick = tick;
          column.handoffPending = false;
        }
        continue;
      }

      const tentativeMass = column.mass + transfer[i];
      if (tentativeMass < 0) {
        clampedNegativeMass += -tentativeMass;
      }
      const nextMass = Math.max(0, tentativeMass);
      column.mass = nextMass;
      column.depth = nextMass;
      column.surfaceY = column.bedY + column.depth;
      column.pressure = column.depth;
      column.velocityX = column.velocityX * config.velocityDamping + velocityXDelta[i];
      column.velocityZ = column.velocityZ * config.velocityDamping + velocityZDelta[i];
      column.turbulence = Math.min(
        1,
        column.turbulence * 0.85 + Math.min(1, Math.hypot(column.velocityX, column.velocityZ)),
      );
      column.foamPotential = Math.min(1, column.foamPotential * 0.8 + column.turbulence * 0.2);
      column.pendingInboundMass = 0;
      column.lastResolvedTick = tick;

      if (nextMass <= config.minActiveDepth) {
        prunedMass += nextMass;
        resetContinuousColumn(column);
        continue;
      }

      column.active = true;
      column.ownershipDomain = "continuous";
      column.handoffPending =
        canContinuousColumnHandoff(column) &&
        column.depth > 0 &&
        column.depth < config.demoteDepth;
    }

    section.lastTickDt = clampedDt;

    // Second pass: accumulate upstream bias and confinement into pressure.
    accumulateSectionPressure(section);

    if (!section.columns.some((column) => column.active)) {
      sectionsToRemove.push({ key, originX: section.originX, originZ: section.originZ });
      continue;
    }

    activeKeys.push(key);
  }

  registry?.finalizeTick();
  for (const section of sectionsToRemove) {
    if (registry?.hasPendingBoundaryState(section.originX, section.originZ)) {
      continue;
    }
    sections.delete(section.key);
    registry?.removeSection(section.originX, section.originZ);
  }

  const massAfterColumns = measureContinuousWaterMass();
  const massAfterBuffered = registry?.measureBufferedMass() ?? 0;
  const totalMassDelta =
    massAfterColumns + massAfterBuffered - (massBeforeColumns + massBeforeBuffered);
  if (Math.abs(totalMassDelta + prunedMass) > 0.001 || clampedNegativeMass > 0.001) {
    (globalThis as any).__DVE_CONTINUOUS_RUNTIME_DIAGNOSTICS__ = {
      tick,
      massBeforeColumns,
      massBeforeBuffered,
      massAfterColumns,
      massAfterBuffered,
      totalMassDelta,
      prunedMass,
      clampedNegativeMass,
    };
  }

  return {
    activeKeys,
    accounting: {
      sourceDelta: clampedNegativeMass,
      sinkDelta: prunedMass,
      transferDelta: {},
    },
  };
}

export interface ContinuousWaterHandoffSummary {
  handoffKeys: string[];
  acceptedCount: number;
  rejectedCount: number;
  transferredMassToShallow: number;
}

export function performContinuousWaterHandoffs(
  config: ContinuousWaterConfig = DEFAULT_CONTINUOUS_WATER_CONFIG,
  transferToShallow: ContinuousToShallowCallback,
) {
  const handoffKeys: string[] = [];
  let acceptedCount = 0;
  let rejectedCount = 0;
  let transferredMassToShallow = 0;

  for (const [key, section] of sections) {
    let didHandoff = false;
    for (let z = 0; z < section.sizeZ; z++) {
      for (let x = 0; x < section.sizeX; x++) {
        const column = section.columns[colIdx(section.sizeX, x, z)];
        const forceShallowTransfer =
          (column.pendingOwnershipDomain ?? column.ownershipDomain) === "shallow";
        if (
          !column.active ||
          !canContinuousColumnHandoff(column) ||
          (!forceShallowTransfer &&
            (!column.handoffPending ||
              column.authority === "bootstrap" ||
              column.depth >= config.demoteDepth))
        ) {
          continue;
        }

        const acceptedMass = transferToShallow(
          section.originX + x,
          section.originZ + z,
          column.bedY,
          column.surfaceY,
          column.depth,
          column.bodyId,
        );
        if (acceptedMass <= 0.0001) {
          column.handoffPending = forceShallowTransfer || column.handoffPending;
          column.pendingOwnershipDomain = "continuous";
          rejectedCount += 1;
          continue;
        }

        transferredMassToShallow += acceptedMass;
        acceptedCount += 1;

        if (acceptedMass >= column.mass - 0.0001) {
          resetContinuousColumn(column);
        } else {
          column.mass = Math.max(0, column.mass - acceptedMass);
          column.depth = column.mass;
          column.surfaceY = column.bedY + column.depth;
          column.pressure = column.depth;
          column.handoffPending = false;
          column.pendingOwnershipDomain = "continuous";
          column.ownershipTicks = 0;
          column.handoffGraceTicks = HANDOFF_GRACE_TICKS;
        }
        didHandoff = true;
      }
    }

    if (didHandoff) {
      handoffKeys.push(key);
    }
  }

  return {
    handoffKeys,
    acceptedCount,
    rejectedCount,
    transferredMassToShallow,
  };
}
