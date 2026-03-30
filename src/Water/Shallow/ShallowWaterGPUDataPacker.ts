/**
 * ShallowWaterGPUDataPacker — Fase 1
 *
 * Packs ShallowWaterSectionGrid state into Float32Arrays that can be consumed
 * by the Babylon.js renderer (DVEEditorShallowSectionRenderer or equivalent).
 *
 * This is a shallow-domain-specific render contract. It is not the universal
 * water runtime format for all water systems in the engine.
 *
 * Column buffer layout (stride = 10 floats per column):
 *  [0] thickness
 *  [1] surfaceY
 *  [2] bedY  (actual shallow-domain floor for this column)
 *  [3] spreadVX
 *  [4] spreadVZ
 *  [5] settled
 *  [6] adhesion
 *  [7] age (capped at 255s for packing)
 *  [8] emitterId (float)
 *  [9] shoreDist (column-distance to nearest inactive neighbor, 0-4+)
 *
 * Column metadata layout (stride = 1 uint32 per column):
 *  bits  0-7:  active flag (1) + handoffPending flag (2)
 *  bits  8-15: thickness quantized to 0-255 (thickness / handoffThreshold * 255)
 *  bits 16-23: settled quantized to 0-255
 *  bits 24-31: emitterId (0-255)
 *
 * Debug buffer layout (stride = 5 floats per column):
 *  [0] bedY
 *  [1] ownershipConfidence
 *  [2] ownershipTicks
 *  [3] ownershipDomainCode
 *  [4] authorityCode
 *
 * The primary render contract stays fixed at stride 10 so existing Babylon
 * consumers remain binary-compatible. Ownership diagnostics live in the debug
 * buffer instead of widening the render stride.
 */
import type { ShallowWaterSectionGrid } from "./ShallowWaterTypes";
import { DEFAULT_SHALLOW_WATER_CONFIG } from "./ShallowWaterTypes";

export const SHALLOW_COLUMN_STRIDE = 10;
export const SHALLOW_DEBUG_COLUMN_STRIDE = 5;

function encodeOwnershipDomainCode(domain: ShallowWaterSectionGrid["columns"][number]["ownershipDomain"]) {
  switch (domain) {
    case "shallow":
      return 1;
    case "continuous":
      return 2;
    default:
      return 0;
  }
}

function encodeAuthorityCode(authority: ShallowWaterSectionGrid["columns"][number]["authority"]) {
  switch (authority) {
    case "editor":
      return 1;
    case "player":
      return 2;
    case "continuous-handoff":
      return 3;
    case "spill-handoff":
      return 4;
    case "rain":
      return 5;
    default:
      return 0;
  }
}

export interface ShallowWaterGPUData {
  /** Float32 per-column packed data. Length = sizeX * sizeZ * SHALLOW_COLUMN_STRIDE. */
  columnBuffer: Float32Array;
  /** Uint32 per-column metadata. Length = sizeX * sizeZ. */
  columnMetadata: Uint32Array;
  /** Float32 per-column shallow runtime diagnostics. Length = sizeX * sizeZ * SHALLOW_DEBUG_COLUMN_STRIDE. */
  debugColumnBuffer: Float32Array;
  /** Number of columns currently render-owned by the shallow domain. */
  activeColumnCount: number;
  /** Number of floats per column entry. */
  columnStride: number;
  /** Number of floats per debug column entry. */
  debugColumnStride: number;
  /** World origin X of the section. */
  originX: number;
  /** World origin Z of the section. */
  originZ: number;
  /** Section column count (always 16). */
  sizeX: number;
  /** Section column count (always 16). */
  sizeZ: number;
}

/**
 * Pack a ShallowWaterSectionGrid into GPU-ready buffers.
 *
 * This is called once per frame per section that has changed state.
 * @param grid       The source grid to pack.
 * @param outData    Optional existing ShallowWaterGPUData to write into (avoid allocation).
 */
export function packShallowWaterSection(
  grid: ShallowWaterSectionGrid,
  outData?: ShallowWaterGPUData,
): ShallowWaterGPUData {
  const count = grid.sizeX * grid.sizeZ;
  const stride = SHALLOW_COLUMN_STRIDE;
  const debugStride = SHALLOW_DEBUG_COLUMN_STRIDE;
  const handoffThreshold = DEFAULT_SHALLOW_WATER_CONFIG.handoffThickness;

  let data = outData;
  if (
    !data ||
    data.columnBuffer.length !== count * stride ||
    (data.debugColumnBuffer?.length ?? 0) !== count * debugStride
  ) {
    data = {
      columnBuffer: new Float32Array(count * stride),
      columnMetadata: new Uint32Array(count),
      debugColumnBuffer: new Float32Array(count * debugStride),
      activeColumnCount: 0,
      columnStride: stride,
      debugColumnStride: debugStride,
      originX: grid.originX,
      originZ: grid.originZ,
      sizeX: grid.sizeX,
      sizeZ: grid.sizeZ,
    };
  }

  const cb = data.columnBuffer;
  const cm = data.columnMetadata;
  const debug = data.debugColumnBuffer;
  let activeColumnCount = 0;

  for (let i = 0; i < count; i++) {
    const col = grid.columns[i];
    const base = i * stride;
    const debugBase = i * debugStride;
    const renderActive = col.active && col.ownershipDomain === "shallow";

    cb[base + 0] = renderActive ? col.thickness : 0;
    cb[base + 1] = renderActive ? col.surfaceY : col.bedY;
    cb[base + 2] = col.bedY;
    cb[base + 3] = renderActive ? col.spreadVX : 0;
    cb[base + 4] = renderActive ? col.spreadVZ : 0;
    cb[base + 5] = renderActive ? col.settled : 0;
    cb[base + 6] = renderActive ? col.adhesion : 0;
    cb[base + 7] = renderActive ? Math.min(col.age, 255) : 0;
    cb[base + 8] = renderActive ? col.emitterId : 0;
    cb[base + 9] = 0; // shoreDist — filled in second pass below

    debug[debugBase + 0] = col.bedY;
    debug[debugBase + 1] = Number.isFinite(col.ownershipConfidence) ? col.ownershipConfidence : 0;
    debug[debugBase + 2] = col.ownershipTicks;
    debug[debugBase + 3] = encodeOwnershipDomainCode(col.ownershipDomain);
    debug[debugBase + 4] = encodeAuthorityCode(col.authority);

    if (renderActive) activeColumnCount += 1;

    const activeFlag = renderActive ? 1 : 0;
    const handoffFlag = renderActive && col.handoffPending ? 2 : 0;
    const thickQ = renderActive
      ? Math.min(255, Math.round((col.thickness / handoffThreshold) * 255)) & 0xff
      : 0;
    const settledQ = renderActive ? Math.min(255, Math.round(col.settled * 255)) & 0xff : 0;
    const emitterQ = renderActive ? Math.min(255, col.emitterId) & 0xff : 0;

    cm[i] =
      (activeFlag | handoffFlag) |
      (thickQ << 8) |
      (settledQ << 16) |
      (emitterQ << 24);
  }

  // ── Second pass: compute shoreDist (Manhattan distance to nearest inactive column) ──
  // Simple 1-pass approximation: count inactive cardinal neighbours (0–4).
  // More accurate multi-pass BFS is expensive; cardinal-count is sufficient for
  // wave-attenuation and foam-band gradients.
  data.activeColumnCount = activeColumnCount;
  for (let z = 0; z < grid.sizeZ; z++) {
    for (let x = 0; x < grid.sizeX; x++) {
      const i2 = z * grid.sizeX + x;
      const col = grid.columns[i2];
      let nearLand = 0;
      const renderActive = col.active && col.ownershipDomain === "shallow";
      if (!renderActive) { cb[i2 * stride + 9] = 0; continue; }
      // left
      if (
        x === 0 ||
        !grid.columns[z * grid.sizeX + (x - 1)].active ||
        grid.columns[z * grid.sizeX + (x - 1)].ownershipDomain !== "shallow"
      ) nearLand++;
      // right
      if (
        x === grid.sizeX - 1 ||
        !grid.columns[z * grid.sizeX + (x + 1)].active ||
        grid.columns[z * grid.sizeX + (x + 1)].ownershipDomain !== "shallow"
      ) nearLand++;
      // back
      if (
        z === 0 ||
        !grid.columns[(z - 1) * grid.sizeX + x].active ||
        grid.columns[(z - 1) * grid.sizeX + x].ownershipDomain !== "shallow"
      ) nearLand++;
      // front
      if (
        z === grid.sizeZ - 1 ||
        !grid.columns[(z + 1) * grid.sizeX + x].active ||
        grid.columns[(z + 1) * grid.sizeX + x].ownershipDomain !== "shallow"
      ) nearLand++;
      // shoreDist = 0 if touching land, up to 4 if surrounded by water
      // Invert: store distance-from-shore (0 = at shore, 4 = far from shore)
      cb[i2 * stride + 9] = nearLand === 0 ? 4.0 : (4.0 - nearLand);
    }
  }

  return data;
}

/**
 * Decode a single column metadata uint32 back to readable fields
 * (useful in the renderer / debug).
 */
export function decodeShallowColumnMetadata(meta: number) {
  return {
    active: (meta & 1) !== 0,
    handoffPending: (meta & 2) !== 0,
    thicknessFraction: ((meta >>> 8) & 0xff) / 255,
    settledFraction: ((meta >>> 16) & 0xff) / 255,
    emitterId: (meta >>> 24) & 0xff,
  };
}
