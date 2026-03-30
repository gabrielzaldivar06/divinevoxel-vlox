import type {
  ContinuousWaterColumn,
  ContinuousWaterSection,
} from "../Continuous/ContinuousWaterTypes.js";
import type { ShallowWaterSectionGrid } from "../Shallow/ShallowWaterTypes.js";

const DEFAULT_SECTION_SIZE = 16;
const ACTIVE_EPSILON = 0.0001;

export enum WaterPhysicalLOD {
  LOD0_FINE = 0,
  LOD1_COARSE_2 = 1,
  LOD2_COARSE_4 = 2,
  LOD3_DORMANT = 3,
}

export interface WaterLODCellSnapshot {
  active: boolean;
  mass: number;
  bedY: number;
  velocityX: number;
  velocityZ: number;
  ownershipDomain: 0 | 1 | 2;
  ownershipConfidence: number;
  ownershipTicks: number;
  bodyId: number;
}

export interface WaterLODChunkSnapshot {
  originX: number;
  originZ: number;
  sizeX: number;
  sizeZ: number;
  lod: WaterPhysicalLOD;
  downsampleFactor: 1 | 2 | 4 | 8;
  cells: WaterLODCellSnapshot[];
  totalMass: number;
  sourceRevision: number;
}

export interface WaterLODChunkRecord {
  originX: number;
  originZ: number;
  sectionSizeX: number;
  sectionSizeZ: number;
  activeLOD: WaterPhysicalLOD;
  targetLOD: WaterPhysicalLOD;
  currentSnapshot: WaterLODChunkSnapshot | null;
  lastMass: number;
  isResidentFine: boolean;
  isPersistedDormant: boolean;
  dirty: boolean;
}

export interface WaterLODManagerOptions {
  sectionSize?: number;
  lod0Radius: number;
  lod1Radius?: number;
  lod2Radius?: number;
  allowInMemoryDormancy?: boolean;
  allowPersistedDormancy?: boolean;
  coarseFactors?: {
    lod1?: 2;
    lod2?: 4 | 8;
  };
  maxSupportedLOD?: WaterPhysicalLOD;
}

export interface WaterLODContext {
  playerWorldX: number;
  playerWorldZ: number;
}

export interface WaterLODTransitionDeps {
  getContinuousSection: (originX: number, originZ: number) => ContinuousWaterSection | undefined;
  getShallowSection: (originX: number, originZ: number) => ShallowWaterSectionGrid | undefined;
  removeContinuousSection: (originX: number, originZ: number) => void;
  removeShallowSection: (originX: number, originZ: number) => void;
  getOrCreateContinuousSection: (originX: number, originZ: number) => ContinuousWaterSection;
  createEmptyContinuousColumn: () => ContinuousWaterColumn;
  sectionSize: number;
  hasPendingContinuousBoundaryState?: (originX: number, originZ: number) => boolean;
  hasPendingShallowBoundaryState?: (originX: number, originZ: number) => boolean;
  retireContinuousBoundaryState?: (originX: number, originZ: number) => void;
  retireShallowBoundaryState?: (originX: number, originZ: number) => void;
  persistDormantSnapshot?: (snapshot: WaterLODChunkSnapshot) => boolean;
  restoreDormantSnapshot?: (originX: number, originZ: number) => WaterLODChunkSnapshot | null;
}

export interface WaterLODTransitionSummary {
  promotedToFine: number;
  demotedToCoarse: number;
  putDormant: number;
  revivedFromDormant: number;
  blockedByBoundaryState: number;
  massBefore: number;
  massAfter: number;
}

export interface WaterLODManagerStats {
  totalRecords: number;
  fineRecords: number;
  coarseRecords: number;
  managedMass: number;
}

function sectionKey(originX: number, originZ: number) {
  return `${originX}_${originZ}`;
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function resetContinuousColumnPreservingBedY(
  column: ContinuousWaterColumn,
  createEmptyContinuousColumn: () => ContinuousWaterColumn,
) {
  const bedY = column.bedY;
  Object.assign(column, createEmptyContinuousColumn());
  column.bedY = bedY;
  column.surfaceY = bedY;
}

function ensureSectionColumnCount(
  section: ContinuousWaterSection,
  createEmptyContinuousColumn: () => ContinuousWaterColumn,
) {
  const expected = section.sizeX * section.sizeZ;
  while (section.columns.length < expected) {
    section.columns.push(createEmptyContinuousColumn());
  }
  if (section.columns.length > expected) {
    section.columns.length = expected;
  }
}

function clearContinuousSection(
  section: ContinuousWaterSection,
  createEmptyContinuousColumn: () => ContinuousWaterColumn,
) {
  ensureSectionColumnCount(section, createEmptyContinuousColumn);
  for (const column of section.columns) {
    resetContinuousColumnPreservingBedY(column, createEmptyContinuousColumn);
  }
  section.lastTickDt = 0;
  section.topologyVersion += 1;
}

function getColumnIndex(sizeX: number, x: number, z: number) {
  return z * sizeX + x;
}

interface WaterLODRestoreTarget {
  column: ContinuousWaterColumn;
  localX: number;
  localZ: number;
}

function resolveRequestedLOD(
  chunkCenterX: number,
  chunkCenterZ: number,
  playerX: number,
  playerZ: number,
  options: WaterLODManagerOptions,
) {
  const dx = chunkCenterX - playerX;
  const dz = chunkCenterZ - playerZ;
  const dist = Math.hypot(dx, dz);

  if (dist <= options.lod0Radius) {
    return WaterPhysicalLOD.LOD0_FINE;
  }
  if (options.lod1Radius !== undefined && dist > options.lod1Radius) {
    if (options.lod2Radius !== undefined && dist > options.lod2Radius) {
      return WaterPhysicalLOD.LOD3_DORMANT;
    }
    return WaterPhysicalLOD.LOD2_COARSE_4;
  }
  return WaterPhysicalLOD.LOD1_COARSE_2;
}

function clampTargetLOD(targetLOD: WaterPhysicalLOD, maxSupportedLOD: WaterPhysicalLOD) {
  return Math.min(targetLOD, maxSupportedLOD) as WaterPhysicalLOD;
}

function getDominantBodyId(bodyMass: Map<number, number>) {
  let bodyId = 0;
  let bestMass = -1;

  for (const [candidateId, candidateMass] of bodyMass) {
    if (candidateMass <= bestMass) continue;
    bestMass = candidateMass;
    bodyId = candidateId;
  }

  return bodyId;
}

function absorbShallowIntoContinuous(
  shallowSection: ShallowWaterSectionGrid,
  continuousSection: ContinuousWaterSection,
  createEmptyContinuousColumn: () => ContinuousWaterColumn,
) {
  const columnCount = Math.min(shallowSection.columns.length, continuousSection.columns.length);

  for (let i = 0; i < columnCount; i++) {
    const shallow = shallowSection.columns[i];
    if (!shallow.active || shallow.thickness <= ACTIVE_EPSILON) continue;

    let continuous = continuousSection.columns[i];
    if (!continuous) {
      continuous = createEmptyContinuousColumn();
      continuousSection.columns[i] = continuous;
    }

    const previousMass = Math.max(0, continuous.mass);
    const totalMass = previousMass + shallow.thickness;
    const resolvedBedY =
      Number.isFinite(continuous.bedY) && continuous.bedY !== 0
        ? Math.min(continuous.bedY, shallow.bedY)
        : shallow.bedY;
    const nextVelocityX =
      totalMass > ACTIVE_EPSILON
        ? (continuous.velocityX * previousMass + shallow.spreadVX * shallow.thickness) / totalMass
        : 0;
    const nextVelocityZ =
      totalMass > ACTIVE_EPSILON
        ? (continuous.velocityZ * previousMass + shallow.spreadVZ * shallow.thickness) / totalMass
        : 0;

    continuous.active = true;
    continuous.bedY = resolvedBedY;
    continuous.mass = totalMass;
    continuous.depth = totalMass;
    continuous.surfaceY = continuous.bedY + continuous.depth;
    continuous.velocityX = nextVelocityX;
    continuous.velocityZ = nextVelocityZ;
    continuous.pressure = continuous.depth;
    continuous.ownershipDomain = "continuous";
    continuous.ownershipConfidence = Math.max(
      clamp01(continuous.ownershipConfidence),
      clamp01(shallow.ownershipConfidence),
      0.75,
    );
    continuous.ownershipTicks = Math.max(
      continuous.ownershipTicks,
      shallow.ownershipTicks,
      1,
    );
    continuous.authority = "continuous-handoff";
    continuous.ownershipLocked = false;
    continuous.handoffPending = false;
    continuous.lastResolvedTick = Math.max(continuous.lastResolvedTick, shallow.lastResolvedTick);
  }
}

function downsampleContinuousSection(
  section: ContinuousWaterSection,
  factor: 2 | 4 | 8,
  targetLOD: WaterPhysicalLOD,
): WaterLODChunkSnapshot {
  const coarseSizeX = Math.ceil(section.sizeX / factor);
  const coarseSizeZ = Math.ceil(section.sizeZ / factor);
  const cells: WaterLODCellSnapshot[] = [];
  let totalMass = 0;

  for (let coarseZ = 0; coarseZ < coarseSizeZ; coarseZ++) {
    for (let coarseX = 0; coarseX < coarseSizeX; coarseX++) {
      let mass = 0;
      let bedY = Number.POSITIVE_INFINITY;
      let velocityXAcc = 0;
      let velocityZAcc = 0;
      let confidenceAcc = 0;
      let minTicks = Number.POSITIVE_INFINITY;
      const bodyMass = new Map<number, number>();

      for (let offsetZ = 0; offsetZ < factor; offsetZ++) {
        for (let offsetX = 0; offsetX < factor; offsetX++) {
          const fineX = coarseX * factor + offsetX;
          const fineZ = coarseZ * factor + offsetZ;
          if (fineX >= section.sizeX || fineZ >= section.sizeZ) continue;

          const column = section.columns[getColumnIndex(section.sizeX, fineX, fineZ)];
          if (!column?.active || column.mass <= ACTIVE_EPSILON) continue;

          mass += column.mass;
          bedY = Math.min(bedY, column.bedY);
          velocityXAcc += column.velocityX * column.mass;
          velocityZAcc += column.velocityZ * column.mass;
          confidenceAcc += clamp01(column.ownershipConfidence) * column.mass;
          minTicks = Math.min(minTicks, column.ownershipTicks);
          bodyMass.set(column.bodyId, (bodyMass.get(column.bodyId) ?? 0) + column.mass);
        }
      }

      const active = mass > ACTIVE_EPSILON;
      totalMass += mass;
      cells.push({
        active,
        mass,
        bedY: active ? bedY : 0,
        velocityX: active ? velocityXAcc / Math.max(mass, ACTIVE_EPSILON) : 0,
        velocityZ: active ? velocityZAcc / Math.max(mass, ACTIVE_EPSILON) : 0,
        ownershipDomain: active ? 2 : 0,
        ownershipConfidence: active ? confidenceAcc / Math.max(mass, ACTIVE_EPSILON) : 0,
        ownershipTicks: active && Number.isFinite(minTicks) ? minTicks : 0,
        bodyId: active ? getDominantBodyId(bodyMass) : 0,
      });
    }
  }

  return {
    originX: section.originX,
    originZ: section.originZ,
    sizeX: coarseSizeX,
    sizeZ: coarseSizeZ,
    lod: targetLOD,
    downsampleFactor: factor,
    cells,
    totalMass,
    sourceRevision: section.topologyVersion,
  };
}

function collectRestoreTargets(
  fineSection: ContinuousWaterSection,
  coarseX: number,
  coarseZ: number,
  factor: 1 | 2 | 4 | 8,
) {
  const targets: WaterLODRestoreTarget[] = [];

  for (let offsetZ = 0; offsetZ < factor; offsetZ++) {
    for (let offsetX = 0; offsetX < factor; offsetX++) {
      const fineX = coarseX * factor + offsetX;
      const fineZ = coarseZ * factor + offsetZ;
      if (fineX >= fineSection.sizeX || fineZ >= fineSection.sizeZ) continue;

      targets.push({
        column: fineSection.columns[getColumnIndex(fineSection.sizeX, fineX, fineZ)],
        localX: offsetX,
        localZ: offsetZ,
      });
    }
  }

  return targets;
}

function getRestoreWeights(
  source: WaterLODCellSnapshot,
  targets: WaterLODRestoreTarget[],
  factor: 1 | 2 | 4 | 8,
) {
  if (targets.length === 0) {
    return [];
  }

  let minBedY = Number.POSITIVE_INFINITY;
  let maxBedY = Number.NEGATIVE_INFINITY;
  let hasBedBias = false;

  for (const target of targets) {
    const bedY = target.column.bedY;
    if (!Number.isFinite(bedY) || bedY === 0) continue;
    minBedY = Math.min(minBedY, bedY);
    maxBedY = Math.max(maxBedY, bedY);
    hasBedBias = true;
  }

  const useBedBias = hasBedBias && maxBedY > minBedY + ACTIVE_EPSILON;
  const velocityMagnitude = Math.hypot(source.velocityX, source.velocityZ);
  const useFlowBias = velocityMagnitude > ACTIVE_EPSILON;

  if (!useBedBias && !useFlowBias) {
    return Array.from({ length: targets.length }, () => 1 / targets.length);
  }

  const centerOffset = (factor - 1) * 0.5;
  const dirX = useFlowBias ? source.velocityX / velocityMagnitude : 0;
  const dirZ = useFlowBias ? source.velocityZ / velocityMagnitude : 0;
  const bedRange = Math.max(maxBedY - minBedY, ACTIVE_EPSILON);
  const rawWeights = targets.map((target) => {
    let weight = 1;

    if (useBedBias) {
      const localBedY =
        Number.isFinite(target.column.bedY) && target.column.bedY !== 0
          ? target.column.bedY
          : maxBedY;
      const bedBias = 1 + (maxBedY - localBedY) / bedRange;
      weight *= bedBias;
    }

    if (useFlowBias) {
      const projection =
        (target.localX - centerOffset) * dirX + (target.localZ - centerOffset) * dirZ;
      const normalizedProjection = clamp01((projection + factor) / (factor * 2));
      weight *= 0.85 + normalizedProjection * 0.3;
    }

    return weight;
  });
  const weightSum = rawWeights.reduce((total, weight) => total + weight, 0);

  if (!Number.isFinite(weightSum) || weightSum <= ACTIVE_EPSILON) {
    return Array.from({ length: targets.length }, () => 1 / targets.length);
  }

  return rawWeights.map((weight) => weight / weightSum);
}

function restoreSnapshotToContinuousSection(
  snapshot: WaterLODChunkSnapshot,
  fineSection: ContinuousWaterSection,
  createEmptyContinuousColumn: () => ContinuousWaterColumn,
) {
  const factor = snapshot.downsampleFactor;

  clearContinuousSection(fineSection, createEmptyContinuousColumn);

  for (let coarseZ = 0; coarseZ < snapshot.sizeZ; coarseZ++) {
    for (let coarseX = 0; coarseX < snapshot.sizeX; coarseX++) {
      const source = snapshot.cells[getColumnIndex(snapshot.sizeX, coarseX, coarseZ)];
      if (!source.active || source.mass <= ACTIVE_EPSILON) continue;

      const targets = collectRestoreTargets(fineSection, coarseX, coarseZ, factor);
      if (targets.length === 0) continue;

      const weights = getRestoreWeights(source, targets, factor);

      for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        const column = target.column;
        const distributedMass = source.mass * weights[i];
        const resolvedBedY =
          Number.isFinite(column.bedY) && column.bedY !== 0 ? column.bedY : source.bedY;

        column.active = true;
        column.bedY = resolvedBedY;
        column.mass = distributedMass;
        column.depth = distributedMass;
        column.surfaceY = column.bedY + column.depth;
        column.velocityX = source.velocityX;
        column.velocityZ = source.velocityZ;
        column.pressure = column.depth;
        column.bodyId = source.bodyId;
        column.ownershipDomain = "continuous";
        column.ownershipConfidence = clamp01(source.ownershipConfidence);
        column.ownershipTicks = source.ownershipTicks;
        column.authority = "bootstrap";
        column.ownershipLocked = false;
        column.handoffPending = false;
        column.pendingInboundMass = 0;
        column.pendingOutboundMass = 0;
      }
    }
  }

  fineSection.topologyVersion = Math.max(fineSection.topologyVersion, snapshot.sourceRevision) + 1;
}

export class WaterLODManager {
  private readonly records = new Map<string, WaterLODChunkRecord>();

  constructor(private options: WaterLODManagerOptions) {}

  updateOptions(nextOptions: Partial<WaterLODManagerOptions>) {
    this.options = {
      ...this.options,
      ...nextOptions,
      coarseFactors: {
        ...this.options.coarseFactors,
        ...nextOptions.coarseFactors,
      },
    };
  }

  private getMaxSupportedLOD() {
    const requested = this.options.maxSupportedLOD ?? WaterPhysicalLOD.LOD1_COARSE_2;
    if (requested < WaterPhysicalLOD.LOD3_DORMANT) {
      return requested;
    }
    return this.options.allowInMemoryDormancy === true || this.options.allowPersistedDormancy === true
      ? requested
      : WaterPhysicalLOD.LOD2_COARSE_4;
  }

  private getManagedRecordMass(record: WaterLODChunkRecord) {
    if (record.currentSnapshot) {
      return record.currentSnapshot.totalMass;
    }
    return record.isPersistedDormant ? record.lastMass : 0;
  }

  private getSectionCenter(originX: number, originZ: number, sizeX: number, sizeZ: number) {
    return {
      x: originX + sizeX * 0.5,
      z: originZ + sizeZ * 0.5,
    };
  }

  private getRecordMass(
    record: WaterLODChunkRecord,
    continuous: ContinuousWaterSection | undefined,
    shallow: ShallowWaterSectionGrid | undefined,
  ) {
    if (continuous || shallow) {
      return this.measureSectionMass(continuous, shallow);
    }
    return this.getManagedRecordMass(record);
  }

  private measureSectionMass(
    continuous: ContinuousWaterSection | undefined,
    shallow: ShallowWaterSectionGrid | undefined,
  ) {
    let total = 0;

    if (continuous) {
      for (const column of continuous.columns) {
        if (!column?.active) continue;
        total += column.mass;
      }
    }

    if (shallow) {
      for (const column of shallow.columns) {
        if (!column?.active) continue;
        total += column.thickness;
      }
    }

    return total;
  }

  private shouldBlockDemotion(originX: number, originZ: number, deps: WaterLODTransitionDeps) {
    return !!(
      deps.hasPendingContinuousBoundaryState?.(originX, originZ) ||
      deps.hasPendingShallowBoundaryState?.(originX, originZ)
    );
  }

  private getTargetFactor(targetLOD: WaterPhysicalLOD): 2 | 4 | 8 {
    if (targetLOD === WaterPhysicalLOD.LOD1_COARSE_2) {
      return this.options.coarseFactors?.lod1 ?? 2;
    }
    return this.options.coarseFactors?.lod2 ?? 4;
  }

  private deleteMissingRecords() {
    for (const [key, record] of this.records) {
      if (record.currentSnapshot) continue;
      if (record.isPersistedDormant) continue;
      if (record.isResidentFine) continue;
      this.records.delete(key);
    }
  }

  updateTargets(
    continuousSections: ReadonlyMap<string, ContinuousWaterSection>,
    shallowSections: ReadonlyMap<string, ShallowWaterSectionGrid>,
    context: WaterLODContext,
  ) {
    const keys = new Set<string>([
      ...continuousSections.keys(),
      ...shallowSections.keys(),
      ...this.records.keys(),
    ]);

    for (const key of keys) {
      const continuous = continuousSections.get(key);
      const shallow = shallowSections.get(key);
      const existing = this.records.get(key);

      const originX = continuous?.originX ?? shallow?.originX ?? existing?.originX;
      const originZ = continuous?.originZ ?? shallow?.originZ ?? existing?.originZ;
      if (originX === undefined || originZ === undefined) continue;

      const sectionSizeX =
        continuous?.sizeX ?? shallow?.sizeX ?? existing?.sectionSizeX ?? this.options.sectionSize ?? DEFAULT_SECTION_SIZE;
      const sectionSizeZ =
        continuous?.sizeZ ?? shallow?.sizeZ ?? existing?.sectionSizeZ ?? this.options.sectionSize ?? DEFAULT_SECTION_SIZE;
      const center = this.getSectionCenter(originX, originZ, sectionSizeX, sectionSizeZ);
      const requestedLOD = resolveRequestedLOD(
        center.x,
        center.z,
        context.playerWorldX,
        context.playerWorldZ,
        this.options,
      );
      const targetLOD = clampTargetLOD(requestedLOD, this.getMaxSupportedLOD());
      const nextRecord: WaterLODChunkRecord =
        existing ?? {
          originX,
          originZ,
          sectionSizeX,
          sectionSizeZ,
          activeLOD: WaterPhysicalLOD.LOD0_FINE,
          targetLOD,
          currentSnapshot: null,
          lastMass: 0,
          isResidentFine: true,
          isPersistedDormant: false,
          dirty: true,
        };

      nextRecord.originX = originX;
      nextRecord.originZ = originZ;
      nextRecord.sectionSizeX = sectionSizeX;
      nextRecord.sectionSizeZ = sectionSizeZ;
      nextRecord.targetLOD = targetLOD;
      nextRecord.dirty = nextRecord.activeLOD !== targetLOD;
      this.records.set(key, nextRecord);
    }

    this.deleteMissingRecords();
  }

  applyTransitions(deps: WaterLODTransitionDeps): WaterLODTransitionSummary {
    const summary: WaterLODTransitionSummary = {
      promotedToFine: 0,
      demotedToCoarse: 0,
      putDormant: 0,
      revivedFromDormant: 0,
      blockedByBoundaryState: 0,
      massBefore: 0,
      massAfter: 0,
    };
    const recordsToDelete: string[] = [];

    for (const [key, record] of this.records) {
      const continuous = deps.getContinuousSection(record.originX, record.originZ);
      const shallow = deps.getShallowSection(record.originX, record.originZ);
      const hasResidentFine = !!continuous || !!shallow;
      const hasSnapshot = !!record.currentSnapshot;
      const hasPersistedDormant = record.isPersistedDormant;

      if (!hasResidentFine && !hasSnapshot && !hasPersistedDormant) {
        recordsToDelete.push(key);
        continue;
      }

      const massBeforeChunk = this.getRecordMass(record, continuous, shallow);
      summary.massBefore += massBeforeChunk;

      if (record.targetLOD === WaterPhysicalLOD.LOD0_FINE) {
        if (hasResidentFine && hasSnapshot) {
          record.currentSnapshot = null;
          record.activeLOD = WaterPhysicalLOD.LOD0_FINE;
          record.isResidentFine = true;
          record.isPersistedDormant = false;
          record.lastMass = this.measureSectionMass(continuous, shallow);
          summary.massAfter += record.lastMass;
          continue;
        }

        if (!hasResidentFine && !hasSnapshot && hasPersistedDormant) {
          const restoredSnapshot = deps.restoreDormantSnapshot?.(record.originX, record.originZ) ?? null;
          if (!restoredSnapshot) {
            summary.massAfter += record.lastMass;
            continue;
          }

          const fineSection = deps.getOrCreateContinuousSection(record.originX, record.originZ);
          restoreSnapshotToContinuousSection(
            restoredSnapshot,
            fineSection,
            deps.createEmptyContinuousColumn,
          );
          record.currentSnapshot = null;
          record.activeLOD = WaterPhysicalLOD.LOD0_FINE;
          record.isResidentFine = true;
          record.isPersistedDormant = false;
          record.lastMass = this.measureSectionMass(
            fineSection,
            deps.getShallowSection(record.originX, record.originZ),
          );
          summary.promotedToFine += 1;
          summary.revivedFromDormant += 1;
          summary.massAfter += record.lastMass;
          continue;
        }

        if (record.currentSnapshot) {
          const previousLOD = record.activeLOD;
          const fineSection = deps.getOrCreateContinuousSection(record.originX, record.originZ);
          restoreSnapshotToContinuousSection(
            record.currentSnapshot,
            fineSection,
            deps.createEmptyContinuousColumn,
          );
          record.currentSnapshot = null;
          record.activeLOD = WaterPhysicalLOD.LOD0_FINE;
          record.isResidentFine = true;
          record.isPersistedDormant = false;
          record.lastMass = this.measureSectionMass(
            fineSection,
            deps.getShallowSection(record.originX, record.originZ),
          );
          summary.promotedToFine += 1;
          if (previousLOD === WaterPhysicalLOD.LOD3_DORMANT) {
            summary.revivedFromDormant += 1;
          }
        } else {
          record.activeLOD = WaterPhysicalLOD.LOD0_FINE;
          record.isResidentFine = hasResidentFine;
          record.isPersistedDormant = false;
          record.lastMass = this.measureSectionMass(continuous, shallow);
        }

        summary.massAfter += record.lastMass;
        continue;
      }

      if (!hasResidentFine) {
        record.activeLOD = record.targetLOD;
        record.isResidentFine = false;
        record.lastMass = this.getManagedRecordMass(record);
        summary.massAfter += record.lastMass;
        continue;
      }

      if (this.shouldBlockDemotion(record.originX, record.originZ, deps)) {
        record.lastMass = massBeforeChunk;
        record.isResidentFine = true;
        summary.blockedByBoundaryState += 1;
        summary.massAfter += record.lastMass;
        continue;
      }

      const fineSection =
        continuous ?? deps.getOrCreateContinuousSection(record.originX, record.originZ);

      if (shallow) {
        absorbShallowIntoContinuous(shallow, fineSection, deps.createEmptyContinuousColumn);
        deps.removeShallowSection(record.originX, record.originZ);
        deps.retireShallowBoundaryState?.(record.originX, record.originZ);
      }

      const targetFactor = this.getTargetFactor(record.targetLOD);
      const nextSnapshot = downsampleContinuousSection(fineSection, targetFactor, record.targetLOD);

      deps.removeContinuousSection(record.originX, record.originZ);
      deps.retireContinuousBoundaryState?.(record.originX, record.originZ);

      if (nextSnapshot.totalMass > ACTIVE_EPSILON) {
        if (
          record.targetLOD === WaterPhysicalLOD.LOD3_DORMANT &&
          deps.persistDormantSnapshot?.(nextSnapshot)
        ) {
          record.currentSnapshot = null;
          record.activeLOD = record.targetLOD;
          record.isResidentFine = false;
          record.isPersistedDormant = true;
          record.lastMass = nextSnapshot.totalMass;
          summary.demotedToCoarse += 1;
          summary.putDormant += 1;
        } else {
          record.currentSnapshot = nextSnapshot;
          record.activeLOD = record.targetLOD;
          record.isResidentFine = false;
          record.isPersistedDormant = false;
          record.lastMass = nextSnapshot.totalMass;
          summary.demotedToCoarse += 1;
          if (record.targetLOD === WaterPhysicalLOD.LOD3_DORMANT) {
            summary.putDormant += 1;
          }
        }
      } else {
        record.currentSnapshot = null;
        record.activeLOD = record.targetLOD;
        record.isResidentFine = false;
        record.isPersistedDormant = false;
        record.lastMass = 0;
        recordsToDelete.push(key);
      }

      summary.massAfter += record.lastMass;
    }

    for (const key of recordsToDelete) {
      this.records.delete(key);
    }

    return summary;
  }

  restoreAllFine(deps: WaterLODTransitionDeps) {
    for (const record of this.records.values()) {
      record.targetLOD = WaterPhysicalLOD.LOD0_FINE;
      record.dirty = record.activeLOD !== WaterPhysicalLOD.LOD0_FINE;
    }
    return this.applyTransitions(deps);
  }

  measureManagedMass() {
    let total = 0;
    for (const record of this.records.values()) {
      if (record.isResidentFine) continue;
      total += this.getManagedRecordMass(record);
    }
    return total;
  }

  getChunkRecord(originX: number, originZ: number) {
    return this.records.get(sectionKey(originX, originZ));
  }

  getStats(): WaterLODManagerStats {
    let fineRecords = 0;
    let coarseRecords = 0;
    let managedMass = 0;

    for (const record of this.records.values()) {
      if (record.isResidentFine) {
        fineRecords += 1;
      } else {
        coarseRecords += 1;
        managedMass += this.getManagedRecordMass(record);
      }
    }

    return {
      totalRecords: this.records.size,
      fineRecords,
      coarseRecords,
      managedMass,
    };
  }

  removeChunk(originX: number, originZ: number) {
    this.records.delete(sectionKey(originX, originZ));
  }

  clear() {
    this.records.clear();
  }
}