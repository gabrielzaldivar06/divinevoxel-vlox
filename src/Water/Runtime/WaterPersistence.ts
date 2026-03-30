import type {
  ContinuousWaterColumn,
  ContinuousWaterSection,
} from "../Continuous/ContinuousWaterTypes.js";
import type { WaterColumnAuthority } from "../Contracts/WaterSemanticContract.js";
import type {
  ShallowColumnState,
  ShallowWaterSectionGrid,
} from "../Shallow/ShallowWaterTypes.js";
import {
  WaterPhysicalLOD,
  type WaterLODCellSnapshot,
  type WaterLODChunkSnapshot,
} from "./WaterLODManager.js";

const ACTIVE_EPSILON = 0.0001;

export interface PersistedContinuousCell {
  index: number;
  mass: number;
  bedY: number;
  velocityX: number;
  velocityZ: number;
  ownershipDomain: 0 | 1 | 2;
  ownershipConfidence: number;
  ownershipTicks: number;
  bodyId: number;
  pressure: number;
  turbulence: number;
  foamPotential: number;
  authority: WaterColumnAuthority;
  ownershipLocked: boolean;
}

export interface PersistedShallowCell {
  index: number;
  thickness: number;
  bedY: number;
  spreadVX: number;
  spreadVZ: number;
  settled: number;
  adhesion: number;
  age: number;
  emitterId: number;
  ownershipDomain: 0 | 1 | 2;
  ownershipConfidence: number;
  ownershipTicks: number;
  authority: WaterColumnAuthority;
}

export interface PersistedContinuousSection {
  kind: "continuous";
  version: 1;
  originX: number;
  originZ: number;
  sizeX: number;
  sizeZ: number;
  lastTickDt: number;
  topologyVersion: number;
  totalMass: number;
  cells: PersistedContinuousCell[];
}

export interface PersistedShallowSection {
  kind: "shallow";
  version: 1;
  originX: number;
  originZ: number;
  sizeX: number;
  sizeZ: number;
  lastTickDt: number;
  terrainY: number;
  totalMass: number;
  cells: PersistedShallowCell[];
}

export interface PersistedLODCell {
  index: number;
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

export interface PersistedLODChunkSnapshot {
  kind: "lod_snapshot";
  version: 1;
  originX: number;
  originZ: number;
  sizeX: number;
  sizeZ: number;
  lod: WaterPhysicalLOD;
  downsampleFactor: 1 | 2 | 4 | 8;
  totalMass: number;
  sourceRevision: number;
  cells: PersistedLODCell[];
}

export type PersistedWaterChunkState =
  | PersistedContinuousSection
  | PersistedShallowSection
  | PersistedLODChunkSnapshot;

export type WaterPersistenceSerializableInput =
  | ContinuousWaterSection
  | ShallowWaterSectionGrid
  | WaterLODChunkSnapshot
  | PersistedLODChunkSnapshot;

export interface WaterPersistenceCodec<TSerialized = string> {
  encode(input: PersistedWaterChunkState): TSerialized;
  decode(input: TSerialized): PersistedWaterChunkState;
}

export interface WaterPersistenceBoundaryStateDeps {
  hasPendingContinuousBoundaryState?: (originX: number, originZ: number) => boolean;
  hasPendingShallowBoundaryState?: (originX: number, originZ: number) => boolean;
}

export interface WaterPersistenceBoundaryCheckResult {
  canPersist: boolean;
  blockedBy: "none" | "continuous-boundary-state" | "shallow-boundary-state";
}

export class JsonWaterPersistenceCodec implements WaterPersistenceCodec<string> {
  encode(input: PersistedWaterChunkState): string {
    return JSON.stringify(input);
  }

  decode(input: string): PersistedWaterChunkState {
    return JSON.parse(input) as PersistedWaterChunkState;
  }
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function encodeOwnershipDomain(domain: string | undefined): 0 | 1 | 2 {
  if (domain === "shallow") return 1;
  if (domain === "continuous") return 2;
  return 0;
}

function decodeOwnershipDomain(code: number): "none" | "shallow" | "continuous" {
  if (code === 1) return "shallow";
  if (code === 2) return "continuous";
  return "none";
}

function sumContinuousMass(section: ContinuousWaterSection) {
  let total = 0;
  for (const column of section.columns) {
    if (!column?.active) continue;
    total += column.mass || 0;
  }
  return total;
}

function sumShallowMass(section: ShallowWaterSectionGrid) {
  let total = 0;
  for (const column of section.columns) {
    if (!column?.active) continue;
    total += column.thickness || 0;
  }
  return total;
}

function createInactiveLODCell(): WaterLODCellSnapshot {
  return {
    active: false,
    mass: 0,
    bedY: 0,
    velocityX: 0,
    velocityZ: 0,
    ownershipDomain: 0,
    ownershipConfidence: 0,
    ownershipTicks: 0,
    bodyId: 0,
  };
}

function restoreContinuousSurface(column: ContinuousWaterColumn) {
  column.depth = Math.max(0, column.mass);
  column.surfaceY = column.bedY + column.depth;
  column.pressure = isFiniteNumber(column.pressure) ? column.pressure : column.depth;
}

function restoreShallowSurface(column: ShallowColumnState) {
  column.surfaceY = column.bedY + Math.max(0, column.thickness);
}

function isPersistedLODChunkSnapshot(
  input: WaterPersistenceSerializableInput,
): input is PersistedLODChunkSnapshot {
  return (input as PersistedLODChunkSnapshot).kind === "lod_snapshot";
}

function isRuntimeLODChunkSnapshot(
  input: WaterPersistenceSerializableInput,
): input is WaterLODChunkSnapshot {
  return (
    !isPersistedLODChunkSnapshot(input) &&
    Array.isArray((input as WaterLODChunkSnapshot).cells) &&
    isFiniteNumber((input as WaterLODChunkSnapshot).downsampleFactor) &&
    isFiniteNumber((input as WaterLODChunkSnapshot).lod)
  );
}

function isContinuousWaterSection(
  input: WaterPersistenceSerializableInput,
): input is ContinuousWaterSection {
  return (
    Array.isArray((input as ContinuousWaterSection).columns) &&
    isFiniteNumber((input as ContinuousWaterSection).topologyVersion)
  );
}

function isShallowWaterSectionGrid(
  input: WaterPersistenceSerializableInput,
): input is ShallowWaterSectionGrid {
  return (
    Array.isArray((input as ShallowWaterSectionGrid).columns) &&
    isFiniteNumber((input as ShallowWaterSectionGrid).terrainY)
  );
}

export class WaterPersistence {
  canPersistChunkState(
    originX: number,
    originZ: number,
    deps: WaterPersistenceBoundaryStateDeps,
  ): WaterPersistenceBoundaryCheckResult {
    if (deps.hasPendingContinuousBoundaryState?.(originX, originZ)) {
      return {
        canPersist: false,
        blockedBy: "continuous-boundary-state",
      };
    }
    if (deps.hasPendingShallowBoundaryState?.(originX, originZ)) {
      return {
        canPersist: false,
        blockedBy: "shallow-boundary-state",
      };
    }
    return {
      canPersist: true,
      blockedBy: "none",
    };
  }

  serializeContinuousSection(section: ContinuousWaterSection): PersistedContinuousSection {
    const cells: PersistedContinuousCell[] = [];

    for (let i = 0; i < section.columns.length; i++) {
      const column = section.columns[i];
      if (!column?.active || column.mass <= ACTIVE_EPSILON) continue;

      cells.push({
        index: i,
        mass: column.mass,
        bedY: column.bedY,
        velocityX: column.velocityX,
        velocityZ: column.velocityZ,
        ownershipDomain: encodeOwnershipDomain(column.ownershipDomain),
        ownershipConfidence: clamp01(column.ownershipConfidence ?? 0),
        ownershipTicks: Math.max(0, column.ownershipTicks ?? 0),
        bodyId: column.bodyId ?? 0,
        pressure: column.pressure ?? column.depth ?? column.mass,
        turbulence: clamp01(column.turbulence ?? 0),
        foamPotential: clamp01(column.foamPotential ?? 0),
        authority: column.authority ?? "bootstrap",
        ownershipLocked: !!column.ownershipLocked,
      });
    }

    return {
      kind: "continuous",
      version: 1,
      originX: section.originX,
      originZ: section.originZ,
      sizeX: section.sizeX,
      sizeZ: section.sizeZ,
      lastTickDt: section.lastTickDt,
      topologyVersion: section.topologyVersion,
      totalMass: sumContinuousMass(section),
      cells,
    };
  }

  serializeShallowSection(section: ShallowWaterSectionGrid): PersistedShallowSection {
    const cells: PersistedShallowCell[] = [];

    for (let i = 0; i < section.columns.length; i++) {
      const column = section.columns[i];
      if (!column?.active || column.thickness <= ACTIVE_EPSILON) continue;

      cells.push({
        index: i,
        thickness: column.thickness,
        bedY: column.bedY,
        spreadVX: column.spreadVX,
        spreadVZ: column.spreadVZ,
        settled: clamp01(column.settled ?? 0),
        adhesion: clamp01(column.adhesion ?? 0.5),
        age: Math.max(0, column.age ?? 0),
        emitterId: column.emitterId ?? 0,
        ownershipDomain: encodeOwnershipDomain(column.ownershipDomain),
        ownershipConfidence: clamp01(column.ownershipConfidence ?? 0),
        ownershipTicks: Math.max(0, column.ownershipTicks ?? 0),
        authority: column.authority ?? "bootstrap",
      });
    }

    return {
      kind: "shallow",
      version: 1,
      originX: section.originX,
      originZ: section.originZ,
      sizeX: section.sizeX,
      sizeZ: section.sizeZ,
      lastTickDt: section.lastTickDt,
      terrainY: section.terrainY,
      totalMass: sumShallowMass(section),
      cells,
    };
  }

  serializeLODChunkSnapshot(
    snapshot: WaterLODChunkSnapshot | PersistedLODChunkSnapshot,
  ): PersistedLODChunkSnapshot {
    if (isPersistedLODChunkSnapshot(snapshot)) {
      return {
        ...snapshot,
        kind: "lod_snapshot",
        version: 1,
        totalMass:
          snapshot.totalMass ??
          snapshot.cells.reduce((total, cell) => total + (cell.active ? cell.mass : 0), 0),
        cells: snapshot.cells.filter((cell) => cell.active && cell.mass > ACTIVE_EPSILON),
      };
    }

    const cells: PersistedLODCell[] = [];
    for (let i = 0; i < snapshot.cells.length; i++) {
      const cell = snapshot.cells[i];
      if (!cell.active || cell.mass <= ACTIVE_EPSILON) continue;
      cells.push({
        index: i,
        active: true,
        mass: cell.mass,
        bedY: cell.bedY,
        velocityX: cell.velocityX,
        velocityZ: cell.velocityZ,
        ownershipDomain: cell.ownershipDomain,
        ownershipConfidence: clamp01(cell.ownershipConfidence),
        ownershipTicks: Math.max(0, cell.ownershipTicks),
        bodyId: cell.bodyId,
      });
    }

    return {
      kind: "lod_snapshot",
      version: 1,
      originX: snapshot.originX,
      originZ: snapshot.originZ,
      sizeX: snapshot.sizeX,
      sizeZ: snapshot.sizeZ,
      lod: snapshot.lod,
      downsampleFactor: snapshot.downsampleFactor,
      totalMass:
        snapshot.totalMass ??
        snapshot.cells.reduce((total, cell) => total + (cell.active ? cell.mass : 0), 0),
      sourceRevision: snapshot.sourceRevision,
      cells,
    };
  }

  hydrateContinuousSection(
    persisted: PersistedContinuousSection,
    target: ContinuousWaterSection,
    createEmptyContinuousColumn: () => ContinuousWaterColumn,
  ): ContinuousWaterSection {
    target.originX = persisted.originX;
    target.originZ = persisted.originZ;
    target.sizeX = persisted.sizeX;
    target.sizeZ = persisted.sizeZ;
    target.lastTickDt = persisted.lastTickDt;
    target.topologyVersion = persisted.topologyVersion;

    const expectedLength = persisted.sizeX * persisted.sizeZ;
    if (!Array.isArray(target.columns) || target.columns.length !== expectedLength) {
      target.columns = Array.from({ length: expectedLength }, () => createEmptyContinuousColumn());
    } else {
      for (let i = 0; i < target.columns.length; i++) {
        const bedY = target.columns[i]?.bedY ?? 0;
        target.columns[i] = createEmptyContinuousColumn();
        target.columns[i].bedY = bedY;
        target.columns[i].surfaceY = bedY;
      }
    }

    for (const cell of persisted.cells) {
      if (cell.index < 0 || cell.index >= target.columns.length) continue;
      const column = target.columns[cell.index];

      column.active = true;
      column.mass = Math.max(0, cell.mass);
      column.bedY = cell.bedY;
      column.velocityX = cell.velocityX;
      column.velocityZ = cell.velocityZ;
      column.ownershipDomain = decodeOwnershipDomain(cell.ownershipDomain);
      column.ownershipConfidence = clamp01(cell.ownershipConfidence);
      column.ownershipTicks = Math.max(0, cell.ownershipTicks);
      column.bodyId = cell.bodyId;
      column.pressure = cell.pressure;
      column.turbulence = clamp01(cell.turbulence);
      column.foamPotential = clamp01(cell.foamPotential);
      column.authority = cell.authority;
      column.ownershipLocked = !!cell.ownershipLocked;
      column.handoffPending = false;
      column.pendingInboundMass = 0;
      column.pendingOutboundMass = 0;
      column.lastResolvedTick = 0;
      restoreContinuousSurface(column);
    }

    return target;
  }

  hydrateShallowSection(
    persisted: PersistedShallowSection,
    target: ShallowWaterSectionGrid,
    createEmptyShallowColumn: () => ShallowColumnState,
  ): ShallowWaterSectionGrid {
    target.originX = persisted.originX;
    target.originZ = persisted.originZ;
    target.sizeX = persisted.sizeX;
    target.sizeZ = persisted.sizeZ;
    target.lastTickDt = persisted.lastTickDt;
    target.terrainY = persisted.terrainY;

    const expectedLength = persisted.sizeX * persisted.sizeZ;
    if (!Array.isArray(target.columns) || target.columns.length !== expectedLength) {
      target.columns = Array.from({ length: expectedLength }, () => createEmptyShallowColumn());
    } else {
      for (let i = 0; i < target.columns.length; i++) {
        const bedY = target.columns[i]?.bedY ?? persisted.terrainY ?? 0;
        target.columns[i] = createEmptyShallowColumn();
        target.columns[i].bedY = bedY;
        target.columns[i].surfaceY = bedY;
      }
    }

    for (const cell of persisted.cells) {
      if (cell.index < 0 || cell.index >= target.columns.length) continue;
      const column = target.columns[cell.index];

      column.active = true;
      column.thickness = Math.max(0, cell.thickness);
      column.bedY = cell.bedY;
      column.spreadVX = cell.spreadVX;
      column.spreadVZ = cell.spreadVZ;
      column.settled = clamp01(cell.settled);
      column.adhesion = clamp01(cell.adhesion);
      column.age = Math.max(0, cell.age);
      column.emitterId = cell.emitterId;
      column.ownershipDomain = decodeOwnershipDomain(cell.ownershipDomain);
      column.ownershipConfidence = clamp01(cell.ownershipConfidence);
      column.ownershipTicks = Math.max(0, cell.ownershipTicks);
      column.authority = cell.authority;
      column.handoffPending = false;
      column.lastResolvedTick = 0;
      restoreShallowSurface(column);
    }

    return target;
  }

  hydrateLODChunkSnapshot(
    persisted: PersistedLODChunkSnapshot,
  ): WaterLODChunkSnapshot {
    const expectedLength = persisted.sizeX * persisted.sizeZ;
    const cells = Array.from({ length: expectedLength }, () => createInactiveLODCell());

    for (const cell of persisted.cells) {
      if (cell.index < 0 || cell.index >= cells.length) continue;
      cells[cell.index] = {
        active: cell.active,
        mass: Math.max(0, cell.mass),
        bedY: cell.bedY,
        velocityX: cell.velocityX,
        velocityZ: cell.velocityZ,
        ownershipDomain: cell.ownershipDomain,
        ownershipConfidence: clamp01(cell.ownershipConfidence),
        ownershipTicks: Math.max(0, cell.ownershipTicks),
        bodyId: cell.bodyId,
      };
    }

    return {
      originX: persisted.originX,
      originZ: persisted.originZ,
      sizeX: persisted.sizeX,
      sizeZ: persisted.sizeZ,
      lod: persisted.lod,
      downsampleFactor: persisted.downsampleFactor,
      cells,
      totalMass: persisted.totalMass,
      sourceRevision: persisted.sourceRevision,
    };
  }

  cloneLODChunkSnapshot(persisted: PersistedLODChunkSnapshot): PersistedLODChunkSnapshot {
    return {
      kind: "lod_snapshot",
      version: 1,
      originX: persisted.originX,
      originZ: persisted.originZ,
      sizeX: persisted.sizeX,
      sizeZ: persisted.sizeZ,
      lod: persisted.lod,
      downsampleFactor: persisted.downsampleFactor,
      totalMass: persisted.totalMass,
      sourceRevision: persisted.sourceRevision,
      cells: persisted.cells.map((cell) => ({ ...cell })),
    };
  }

  serializeChunkState(input: WaterPersistenceSerializableInput): PersistedWaterChunkState {
    if (isPersistedLODChunkSnapshot(input) || isRuntimeLODChunkSnapshot(input)) {
      return this.serializeLODChunkSnapshot(input);
    }
    if (isContinuousWaterSection(input)) {
      return this.serializeContinuousSection(input);
    }
    if (isShallowWaterSectionGrid(input)) {
      return this.serializeShallowSection(input);
    }
    throw new Error("Unsupported water runtime state for serialization.");
  }

  totalMassOfPersisted(state: PersistedWaterChunkState) {
    return state.totalMass;
  }

  validatePersistedMass(
    state: PersistedWaterChunkState,
    epsilon = 0.001,
  ): { valid: boolean; declared: number; recomputed: number; error: number } {
    let recomputed = 0;

    switch (state.kind) {
      case "continuous":
        recomputed = state.cells.reduce((total, cell) => total + cell.mass, 0);
        break;
      case "shallow":
        recomputed = state.cells.reduce((total, cell) => total + cell.thickness, 0);
        break;
      case "lod_snapshot":
        recomputed = state.cells.reduce(
          (total, cell) => total + (cell.active ? cell.mass : 0),
          0,
        );
        break;
    }

    const declared = state.totalMass;
    const error = recomputed - declared;
    return {
      valid: Math.abs(error) <= epsilon,
      declared,
      recomputed,
      error,
    };
  }
}