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
  handoffGraceTicks?: number;
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
  handoffGraceTicks?: number;
}

export interface PersistedContinuousSection {
  kind: "continuous";
  version: 1 | 2;
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
  version: 1 | 2;
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

// ── Binary codec: compact ArrayBuffer format with version header + CRC-32 ──
// Layout: [magic:u32][version:u16][kind:u8][reserved:u8][payloadLen:u32][payload...][crc32:u32]
// Kind: 0=continuous, 1=shallow, 2=lod_snapshot
// This is ~4-8× smaller than JSON for large sections and avoids parsing overhead.
const BINARY_MAGIC = 0x44564557; // "DVEW"
const BINARY_VERSION = 2;
const BINARY_HEADER_BYTES = 12; // magic(4) + version(2) + kind(1) + reserved(1) + payloadLen(4)
const BINARY_FOOTER_BYTES = 4; // crc32(4)

function computeCRC32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function kindToByte(kind: string): number {
  if (kind === "continuous") return 0;
  if (kind === "shallow") return 1;
  return 2; // lod_snapshot
}

function byteToKind(byte: number): "continuous" | "shallow" | "lod_snapshot" {
  if (byte === 0) return "continuous";
  if (byte === 1) return "shallow";
  return "lod_snapshot";
}

// Continuous cell v2:
// index(i32) mass(f32) bedY(f32) vx(f32) vz(f32) ownerDomain(u8) ownerConf(f32)
// ownerTicks(i32) bodyId(i32) pressure(f32) turbulence(f32) foamPotential(f32)
// authority(u8) ownerLocked(u8) handoffGraceTicks(i32) padding(u8) = 52 bytes
const CONT_CELL_BYTES = 52;
// Shallow cell v2:
// index(i32) thickness(f32) bedY(f32) svx(f32) svz(f32) settled(f32)
// adhesion(f32) age(f32) emitterId(i32) ownerDomain(u8) ownerConf(f32) ownerTicks(i32)
// authority(u8) handoffGraceTicks(i32) padding(2) = 52 bytes
const SHALLOW_CELL_BYTES = 52;
// LOD cell: index(i32) active(u8) padding(3) mass(f32) bedY(f32) vx(f32) vz(f32)
// ownerDomain(u8) ownerConf(f32) ownerTicks(i32) bodyId(i32) = 40 bytes
const LOD_CELL_BYTES = 40;
// Section header: originX(f64) originZ(f64) sizeX(i32) sizeZ(i32) lastTickDt(f64)
// totalMass(f64) cellCount(i32) = 44 bytes
// + continuous: topologyVersion(i32) = 48
// + shallow: terrainY(f64) = 52
// + lod: lod(u8) downsampleFactor(u8) padding(2) sourceRevision(i32) = 52
const CONT_HEADER_BYTES = 48;
const SHALLOW_HEADER_BYTES = 52;
const LOD_HEADER_BYTES = 52;

function encodeAuthorityByte(authority: WaterColumnAuthority): number {
  if (authority === "bootstrap") return 0;
  if (authority === "editor") return 1;
  if (authority === "player") return 2;
  if (authority === "continuous-handoff") return 3;
  if (authority === "spill-handoff") return 4;
  if (authority === "rain") return 5;
  return 0;
}

function decodeAuthorityByte(byte: number): WaterColumnAuthority {
  if (byte === 1) return "editor";
  if (byte === 2) return "player";
  if (byte === 3) return "continuous-handoff";
  if (byte === 4) return "spill-handoff";
  if (byte === 5) return "rain";
  return "bootstrap";
}

export class BinaryWaterPersistenceCodec implements WaterPersistenceCodec<ArrayBuffer> {
  encode(input: PersistedWaterChunkState): ArrayBuffer {
    const kindByte = kindToByte(input.kind);
    let payloadSize: number;

    if (input.kind === "continuous") {
      payloadSize = CONT_HEADER_BYTES + input.cells.length * CONT_CELL_BYTES;
    } else if (input.kind === "shallow") {
      payloadSize = SHALLOW_HEADER_BYTES + input.cells.length * SHALLOW_CELL_BYTES;
    } else {
      payloadSize = LOD_HEADER_BYTES + input.cells.length * LOD_CELL_BYTES;
    }

    const totalSize = BINARY_HEADER_BYTES + payloadSize + BINARY_FOOTER_BYTES;
    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    let offset = 0;

    // Header
    view.setUint32(offset, BINARY_MAGIC, true); offset += 4;
    view.setUint16(offset, BINARY_VERSION, true); offset += 2;
    view.setUint8(offset, kindByte); offset += 1;
    view.setUint8(offset, 0); offset += 1; // reserved
    view.setUint32(offset, payloadSize, true); offset += 4;

    // Payload: section header
    if (input.kind === "continuous") {
      view.setFloat64(offset, input.originX, true); offset += 8;
      view.setFloat64(offset, input.originZ, true); offset += 8;
      view.setInt32(offset, input.sizeX, true); offset += 4;
      view.setInt32(offset, input.sizeZ, true); offset += 4;
      view.setFloat64(offset, input.lastTickDt, true); offset += 8;
      view.setFloat64(offset, input.totalMass, true); offset += 8;
      view.setInt32(offset, input.cells.length, true); offset += 4;
      view.setInt32(offset, input.topologyVersion, true); offset += 4;

      for (const cell of input.cells) {
        view.setInt32(offset, cell.index, true); offset += 4;
        view.setFloat32(offset, cell.mass, true); offset += 4;
        view.setFloat32(offset, cell.bedY, true); offset += 4;
        view.setFloat32(offset, cell.velocityX, true); offset += 4;
        view.setFloat32(offset, cell.velocityZ, true); offset += 4;
        view.setUint8(offset, cell.ownershipDomain); offset += 1;
        view.setFloat32(offset + 0, cell.ownershipConfidence, true); offset += 4;
        // Note: offset already advanced by 1 for domain
        view.setInt32(offset, cell.ownershipTicks, true); offset += 4;
        view.setInt32(offset, cell.bodyId, true); offset += 4;
        view.setFloat32(offset, cell.pressure, true); offset += 4;
        view.setFloat32(offset, cell.turbulence, true); offset += 4;
        view.setFloat32(offset, cell.foamPotential, true); offset += 4;
        view.setUint8(offset, encodeAuthorityByte(cell.authority)); offset += 1;
        view.setUint8(offset, cell.ownershipLocked ? 1 : 0); offset += 1;
        view.setInt32(offset, Math.max(0, cell.handoffGraceTicks ?? 0), true); offset += 4;
        view.setUint8(offset, 0); offset += 1; // padding
      }
    } else if (input.kind === "shallow") {
      view.setFloat64(offset, input.originX, true); offset += 8;
      view.setFloat64(offset, input.originZ, true); offset += 8;
      view.setInt32(offset, input.sizeX, true); offset += 4;
      view.setInt32(offset, input.sizeZ, true); offset += 4;
      view.setFloat64(offset, input.lastTickDt, true); offset += 8;
      view.setFloat64(offset, input.totalMass, true); offset += 8;
      view.setInt32(offset, input.cells.length, true); offset += 4;
      view.setFloat64(offset, input.terrainY, true); offset += 8;

      for (const cell of input.cells) {
        view.setInt32(offset, cell.index, true); offset += 4;
        view.setFloat32(offset, cell.thickness, true); offset += 4;
        view.setFloat32(offset, cell.bedY, true); offset += 4;
        view.setFloat32(offset, cell.spreadVX, true); offset += 4;
        view.setFloat32(offset, cell.spreadVZ, true); offset += 4;
        view.setFloat32(offset, cell.settled, true); offset += 4;
        view.setFloat32(offset, cell.adhesion, true); offset += 4;
        view.setFloat32(offset, cell.age, true); offset += 4;
        view.setInt32(offset, cell.emitterId, true); offset += 4;
        view.setUint8(offset, cell.ownershipDomain); offset += 1;
        view.setFloat32(offset + 0, cell.ownershipConfidence, true); offset += 4;
        view.setInt32(offset, cell.ownershipTicks, true); offset += 4;
        view.setUint8(offset, encodeAuthorityByte(cell.authority)); offset += 1;
        view.setInt32(offset, Math.max(0, cell.handoffGraceTicks ?? 0), true); offset += 4;
        offset += 2; // padding
      }
    } else {
      // lod_snapshot
      view.setFloat64(offset, input.originX, true); offset += 8;
      view.setFloat64(offset, input.originZ, true); offset += 8;
      view.setInt32(offset, input.sizeX, true); offset += 4;
      view.setInt32(offset, input.sizeZ, true); offset += 4;
      view.setFloat64(offset, 0, true); offset += 8; // reserved slot (LOD has no lastTickDt)
      view.setFloat64(offset, input.totalMass, true); offset += 8;
      view.setInt32(offset, input.cells.length, true); offset += 4;
      view.setUint8(offset, input.lod); offset += 1;
      view.setUint8(offset, input.downsampleFactor); offset += 1;
      offset += 2; // padding
      view.setInt32(offset, input.sourceRevision, true); offset += 4;

      for (const cell of input.cells) {
        view.setInt32(offset, cell.index, true); offset += 4;
        view.setUint8(offset, cell.active ? 1 : 0); offset += 1;
        offset += 3; // padding
        view.setFloat32(offset, cell.mass, true); offset += 4;
        view.setFloat32(offset, cell.bedY, true); offset += 4;
        view.setFloat32(offset, cell.velocityX, true); offset += 4;
        view.setFloat32(offset, cell.velocityZ, true); offset += 4;
        view.setUint8(offset, cell.ownershipDomain); offset += 1;
        view.setFloat32(offset + 0, cell.ownershipConfidence, true); offset += 4;
        view.setInt32(offset, cell.ownershipTicks, true); offset += 4;
        view.setInt32(offset, cell.bodyId, true); offset += 4;
      }
    }

    // CRC-32 footer over header + payload
    const payloadBytes = new Uint8Array(buffer, 0, BINARY_HEADER_BYTES + payloadSize);
    const crc = computeCRC32(payloadBytes);
    view.setUint32(BINARY_HEADER_BYTES + payloadSize, crc, true);

    return buffer;
  }

  decode(input: ArrayBuffer): PersistedWaterChunkState {
    const view = new DataView(input);
    let offset = 0;

    const magic = view.getUint32(offset, true); offset += 4;
    if (magic !== BINARY_MAGIC) {
      throw new Error(`Invalid binary water persistence magic: 0x${magic.toString(16)}`);
    }
    const version = view.getUint16(offset, true); offset += 2;
    if (version > BINARY_VERSION) {
      throw new Error(`Unsupported binary water persistence version: ${version}`);
    }
    const kindByte = view.getUint8(offset); offset += 1;
    offset += 1; // reserved
    const payloadSize = view.getUint32(offset, true); offset += 4;

    // Verify CRC-32
    const payloadBytes = new Uint8Array(input, 0, BINARY_HEADER_BYTES + payloadSize);
    const expectedCRC = computeCRC32(payloadBytes);
    const storedCRC = view.getUint32(BINARY_HEADER_BYTES + payloadSize, true);
    if (expectedCRC !== storedCRC) {
      throw new Error(`CRC-32 mismatch: expected 0x${expectedCRC.toString(16)}, got 0x${storedCRC.toString(16)}`);
    }

    const kind = byteToKind(kindByte);

    if (kind === "continuous") {
      const originX = view.getFloat64(offset, true); offset += 8;
      const originZ = view.getFloat64(offset, true); offset += 8;
      const sizeX = view.getInt32(offset, true); offset += 4;
      const sizeZ = view.getInt32(offset, true); offset += 4;
      const lastTickDt = view.getFloat64(offset, true); offset += 8;
      const totalMass = view.getFloat64(offset, true); offset += 8;
      const cellCount = view.getInt32(offset, true); offset += 4;
      const topologyVersion = view.getInt32(offset, true); offset += 4;

      const cells: PersistedContinuousCell[] = [];
      for (let i = 0; i < cellCount; i++) {
        const index = view.getInt32(offset, true); offset += 4;
        const mass = view.getFloat32(offset, true); offset += 4;
        const bedY = view.getFloat32(offset, true); offset += 4;
        const velocityX = view.getFloat32(offset, true); offset += 4;
        const velocityZ = view.getFloat32(offset, true); offset += 4;
        const ownershipDomain = view.getUint8(offset) as 0 | 1 | 2; offset += 1;
        const ownershipConfidence = view.getFloat32(offset, true); offset += 4;
        const ownershipTicks = view.getInt32(offset, true); offset += 4;
        const bodyId = view.getInt32(offset, true); offset += 4;
        const pressure = view.getFloat32(offset, true); offset += 4;
        const turbulence = view.getFloat32(offset, true); offset += 4;
        const foamPotential = view.getFloat32(offset, true); offset += 4;
        const authority = decodeAuthorityByte(view.getUint8(offset)); offset += 1;
        const ownershipLocked = view.getUint8(offset) !== 0; offset += 1;
        const handoffGraceTicks =
          version >= 2 ? Math.max(0, view.getInt32(offset, true)) : 0;
        if (version >= 2) {
          offset += 4;
          offset += 1; // padding
        } else {
          offset += 1; // padding
        }
        cells.push({
          index, mass, bedY, velocityX, velocityZ,
          ownershipDomain, ownershipConfidence, ownershipTicks, bodyId,
          pressure, turbulence, foamPotential, authority, ownershipLocked,
          handoffGraceTicks,
        });
      }

      return {
        kind: "continuous", version: version >= 2 ? 2 : 1, originX, originZ, sizeX, sizeZ,
        lastTickDt, topologyVersion, totalMass, cells,
      };
    }

    if (kind === "shallow") {
      const originX = view.getFloat64(offset, true); offset += 8;
      const originZ = view.getFloat64(offset, true); offset += 8;
      const sizeX = view.getInt32(offset, true); offset += 4;
      const sizeZ = view.getInt32(offset, true); offset += 4;
      const lastTickDt = view.getFloat64(offset, true); offset += 8;
      const totalMass = view.getFloat64(offset, true); offset += 8;
      const cellCount = view.getInt32(offset, true); offset += 4;
      const terrainY = view.getFloat64(offset, true); offset += 8;

      const cells: PersistedShallowCell[] = [];
      for (let i = 0; i < cellCount; i++) {
        const index = view.getInt32(offset, true); offset += 4;
        const thickness = view.getFloat32(offset, true); offset += 4;
        const bedY = view.getFloat32(offset, true); offset += 4;
        const spreadVX = view.getFloat32(offset, true); offset += 4;
        const spreadVZ = view.getFloat32(offset, true); offset += 4;
        const settled = view.getFloat32(offset, true); offset += 4;
        const adhesion = view.getFloat32(offset, true); offset += 4;
        const age = view.getFloat32(offset, true); offset += 4;
        const emitterId = view.getInt32(offset, true); offset += 4;
        const ownershipDomain = view.getUint8(offset) as 0 | 1 | 2; offset += 1;
        const ownershipConfidence = view.getFloat32(offset, true); offset += 4;
        const ownershipTicks = view.getInt32(offset, true); offset += 4;
        const authority = decodeAuthorityByte(view.getUint8(offset)); offset += 1;
        const handoffGraceTicks =
          version >= 2 ? Math.max(0, view.getInt32(offset, true)) : 0;
        if (version >= 2) {
          offset += 4;
          offset += 2; // padding
        } else {
          offset += 3; // padding
        }
        cells.push({
          index, thickness, bedY, spreadVX, spreadVZ, settled, adhesion,
          age, emitterId, ownershipDomain, ownershipConfidence, ownershipTicks, authority,
          handoffGraceTicks,
        });
      }

      return {
        kind: "shallow", version: version >= 2 ? 2 : 1, originX, originZ, sizeX, sizeZ,
        lastTickDt, terrainY, totalMass, cells,
      };
    }

    // lod_snapshot
    const originX = view.getFloat64(offset, true); offset += 8;
    const originZ = view.getFloat64(offset, true); offset += 8;
    const sizeX = view.getInt32(offset, true); offset += 4;
    const sizeZ = view.getInt32(offset, true); offset += 4;
    /* lastTickDt not in LOD persisted interface, skip */ offset += 8;
    const totalMass = view.getFloat64(offset, true); offset += 8;
    const cellCount = view.getInt32(offset, true); offset += 4;
    const lod = view.getUint8(offset) as WaterPhysicalLOD; offset += 1;
    const downsampleFactor = view.getUint8(offset) as 1 | 2 | 4 | 8; offset += 1;
    offset += 2; // padding
    const sourceRevision = view.getInt32(offset, true); offset += 4;

    const cells: PersistedLODCell[] = [];
    for (let i = 0; i < cellCount; i++) {
      const index = view.getInt32(offset, true); offset += 4;
      const active = view.getUint8(offset) !== 0; offset += 1;
      offset += 3; // padding
      const mass = view.getFloat32(offset, true); offset += 4;
      const bedY = view.getFloat32(offset, true); offset += 4;
      const velocityX = view.getFloat32(offset, true); offset += 4;
      const velocityZ = view.getFloat32(offset, true); offset += 4;
      const ownershipDomain = view.getUint8(offset) as 0 | 1 | 2; offset += 1;
      const ownershipConfidence = view.getFloat32(offset, true); offset += 4;
      const ownershipTicks = view.getInt32(offset, true); offset += 4;
      const bodyId = view.getInt32(offset, true); offset += 4;
      cells.push({
        index, active, mass, bedY, velocityX, velocityZ,
        ownershipDomain, ownershipConfidence, ownershipTicks, bodyId,
      });
    }

    return {
      kind: "lod_snapshot", version: 1, originX, originZ, sizeX, sizeZ,
      lod, downsampleFactor, totalMass, sourceRevision, cells,
    };
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
        handoffGraceTicks: Math.max(0, column.handoffGraceTicks ?? 0),
      });
    }

    return {
      kind: "continuous",
      version: 2,
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
        handoffGraceTicks: Math.max(0, column.handoffGraceTicks ?? 0),
      });
    }

    return {
      kind: "shallow",
      version: 2,
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
      column.handoffGraceTicks = Math.max(0, cell.handoffGraceTicks ?? 0);
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
      column.handoffGraceTicks = Math.max(0, cell.handoffGraceTicks ?? 0);
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

/* ------------------------------------------------------------------ */
/*  Durable Persistence Backend                                        */
/* ------------------------------------------------------------------ */

export interface WaterWorldPersistenceBackend {
  store(originX: number, originZ: number, encoded: string): Promise<boolean>;
  load(originX: number, originZ: number): Promise<string | null>;
  remove(originX: number, originZ: number): Promise<void>;
  clear(): Promise<void>;
  dispose(): void;
}

const IDB_DB_NAME = "dve-water-persistence";
const IDB_STORE_NAME = "dormant-snapshots";
const IDB_VERSION = 1;

function idbKey(originX: number, originZ: number) {
  return `${originX}_${originZ}`;
}

export class IndexedDBWaterPersistenceBackend implements WaterWorldPersistenceBackend {
  private _db: IDBDatabase | null = null;
  private _opening: Promise<IDBDatabase | null> | null = null;

  private openDB(): Promise<IDBDatabase | null> {
    if (this._db) return Promise.resolve(this._db);
    if (this._opening) return this._opening;

    if (typeof indexedDB === "undefined") {
      return Promise.resolve(null);
    }

    this._opening = new Promise<IDBDatabase | null>((resolve) => {
      try {
        const request = indexedDB.open(IDB_DB_NAME, IDB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
            db.createObjectStore(IDB_STORE_NAME);
          }
        };
        request.onsuccess = () => {
          this._db = request.result;
          this._opening = null;
          resolve(this._db);
        };
        request.onerror = () => {
          this._opening = null;
          resolve(null);
        };
      } catch {
        this._opening = null;
        resolve(null);
      }
    });

    return this._opening;
  }

  async store(originX: number, originZ: number, encoded: string): Promise<boolean> {
    const db = await this.openDB();
    if (!db) return false;

    return new Promise<boolean>((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE_NAME, "readwrite");
        const store = tx.objectStore(IDB_STORE_NAME);
        store.put(encoded, idbKey(originX, originZ));
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }

  async load(originX: number, originZ: number): Promise<string | null> {
    const db = await this.openDB();
    if (!db) return null;

    return new Promise<string | null>((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE_NAME, "readonly");
        const store = tx.objectStore(IDB_STORE_NAME);
        const request = store.get(idbKey(originX, originZ));
        request.onsuccess = () => {
          const value = request.result;
          resolve(typeof value === "string" ? value : null);
        };
        request.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async remove(originX: number, originZ: number): Promise<void> {
    const db = await this.openDB();
    if (!db) return;

    return new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE_NAME, "readwrite");
        const store = tx.objectStore(IDB_STORE_NAME);
        store.delete(idbKey(originX, originZ));
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  async clear(): Promise<void> {
    const db = await this.openDB();
    if (!db) return;

    return new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE_NAME, "readwrite");
        const store = tx.objectStore(IDB_STORE_NAME);
        store.clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  dispose(): void {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
    this._opening = null;
  }
}

export class InMemoryWaterPersistenceBackend implements WaterWorldPersistenceBackend {
  private readonly _cache = new Map<string, string>();

  async store(originX: number, originZ: number, encoded: string): Promise<boolean> {
    this._cache.set(idbKey(originX, originZ), encoded);
    return true;
  }

  async load(originX: number, originZ: number): Promise<string | null> {
    return this._cache.get(idbKey(originX, originZ)) ?? null;
  }

  async remove(originX: number, originZ: number): Promise<void> {
    this._cache.delete(idbKey(originX, originZ));
  }

  async clear(): Promise<void> {
    this._cache.clear();
  }

  dispose(): void {
    this._cache.clear();
  }
}
