/**
 * ShallowWaterGPUDataPacker — Fase 1
 *
 * Packs ShallowWaterSectionGrid state into Float32Arrays that can be consumed
 * by the Babylon.js renderer (DVEEditorShallowSectionRenderer or equivalent).
 *
 * Column buffer layout (stride = 10 floats per column):
 *  [0] thickness
 *  [1] surfaceY
 *  [2] terrainBottomY  (= surfaceY - thickness; water depth = thickness)
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
 */
import type { ShallowWaterSectionGrid } from "./ShallowWaterTypes";
import { DEFAULT_SHALLOW_WATER_CONFIG } from "./ShallowWaterTypes";

export const SHALLOW_COLUMN_STRIDE = 10;

export interface ShallowWaterGPUData {
  /** Float32 per-column packed data. Length = sizeX * sizeZ * SHALLOW_COLUMN_STRIDE. */
  columnBuffer: Float32Array;
  /** Uint32 per-column metadata. Length = sizeX * sizeZ. */
  columnMetadata: Uint32Array;
  /** Number of floats per column entry. */
  columnStride: number;
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
  const handoffThreshold = DEFAULT_SHALLOW_WATER_CONFIG.handoffThickness;

  let data = outData;
  if (!data || data.columnBuffer.length !== count * stride) {
    data = {
      columnBuffer: new Float32Array(count * stride),
      columnMetadata: new Uint32Array(count),
      columnStride: stride,
      originX: grid.originX,
      originZ: grid.originZ,
      sizeX: grid.sizeX,
      sizeZ: grid.sizeZ,
    };
  }

  const cb = data.columnBuffer;
  const cm = data.columnMetadata;

  for (let i = 0; i < count; i++) {
    const col = grid.columns[i];
    const base = i * stride;

    cb[base + 0] = col.thickness;
    cb[base + 1] = col.surfaceY;
    cb[base + 2] = col.active ? col.surfaceY - col.thickness : col.surfaceY;
    cb[base + 3] = col.spreadVX;
    cb[base + 4] = col.spreadVZ;
    cb[base + 5] = col.settled;
    cb[base + 6] = col.adhesion;
    cb[base + 7] = Math.min(col.age, 255);
    cb[base + 8] = col.emitterId;
    cb[base + 9] = 0; // shoreDist — filled in second pass below

    const activeFlag = col.active ? 1 : 0;
    const handoffFlag = col.handoffPending ? 2 : 0;
    const thickQ = Math.min(255, Math.round((col.thickness / handoffThreshold) * 255)) & 0xff;
    const settledQ = Math.min(255, Math.round(col.settled * 255)) & 0xff;
    const emitterQ = Math.min(255, col.emitterId) & 0xff;

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
  for (let z = 0; z < grid.sizeZ; z++) {
    for (let x = 0; x < grid.sizeX; x++) {
      const i2 = z * grid.sizeX + x;
      const col = grid.columns[i2];
      let nearLand = 0;
      if (!col.active) { cb[i2 * stride + 9] = 0; continue; }
      // left
      if (x === 0 || !grid.columns[z * grid.sizeX + (x - 1)].active) nearLand++;
      // right
      if (x === grid.sizeX - 1 || !grid.columns[z * grid.sizeX + (x + 1)].active) nearLand++;
      // back
      if (z === 0 || !grid.columns[(z - 1) * grid.sizeX + x].active) nearLand++;
      // front
      if (z === grid.sizeZ - 1 || !grid.columns[(z + 1) * grid.sizeX + x].active) nearLand++;
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
