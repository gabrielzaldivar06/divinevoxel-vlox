import type { WaterRenderState } from "./WaterRenderState.types";

export type WaterSurfaceClass = "river" | "lake" | "sea";

export interface WaterSectionGPUData {
  /** Packed per-column float data for the section interior. */
  columnBuffer: Float32Array;
  /** Number of floats per interior column entry. */
  columnStride: number;
  /** Packed per-column float data for the padded section ring. */
  paddedColumnBuffer: Float32Array;
  /** Number of floats per padded column entry. */
  paddedColumnStride: number;
  /** Packed per-column integer metadata for the section interior. */
  columnMetadata: Uint32Array;
  /** Packed per-column integer metadata for the padded section ring. */
  paddedColumnMetadata: Uint32Array;
  /** Seed particles derived from the current section columns for future GPU simulation bootstrap. */
  particleSeedBuffer: Float32Array;
  /** Number of floats per particle seed entry. */
  particleSeedStride: number;
  /** Number of valid particle seeds written to particleSeedBuffer. */
  particleSeedCount: number;
  /** Low-resolution interaction field derived from local impacts/drop events. */
  interactionField: Float32Array;
  /** Resolution of the square interaction field. */
  interactionFieldSize: number;
  /** Low-resolution field describing large-body patch coherence across the section. */
  largeBodyField: Float32Array;
  /** Resolution of the square large-body field. */
  largeBodyFieldSize: number;
  /** Packed per-patch float contract data for large visible water patches. */
  patchSummaryBuffer: Float32Array;
  /** Number of floats per patch summary entry. */
  patchSummaryStride: number;
  /** Number of valid patch summaries written to patchSummaryBuffer. */
  patchSummaryCount: number;
  /** Packed per-patch integer metadata. */
  patchMetadata: Uint32Array;
  /** Per-column 1-based lookup into the patch summary buffer. 0 means no patch. */
  columnPatchIndex: Uint16Array;
}

export interface WaterSupportLayer {
  /** Local Y index (within section) of the support liquid voxel. */
  localY: number;
  /** World-space Y of the support layer surface. */
  surfaceY: number;
  /** Liquid fill fraction [0,1] for the support layer. */
  fill: number;
  /** Voxel level (0-7) for the support layer. */
  level: number;
  /** Voxel levelState for the support layer. */
  levelState: number;
  /** The true voxel id of the support layer voxel. */
  voxelId: number;
  /** Distance in voxels from the previously captured layer above. */
  gapFromAbove: number;
}

/**
 * Per-column water sample data for a single (x,z) position within a section.
 */
export interface WaterColumnSample {
  /** Whether liquid is present in this column. */
  filled: boolean;
  /** World-space Y of the water surface. */
  surfaceY: number;
  /** Render-relaxed world-space Y used by the water heightfield mesher. */
  renderSurfaceY: number;
  /** Liquid fill fraction [0,1]. 0 = empty, 1 = fully filled cell. */
  fill: number;
  /** Voxel level (0-7) of the topmost liquid voxel. */
  level: number;
  /** Voxel levelState (0=normal flow, 1=source, 2=being erased). */
  levelState: number;
  /** Local Y index (within section) of the topmost liquid voxel. */
  localY: number;
  /** The true voxel id of the topmost liquid voxel. */
  voxelId: number;
  /** Approximate contiguous same-liquid support depth under the top surface voxel. */
  supportDepth: number;
  /** Additional vertically meaningful liquid layers below the top surface. */
  supportLayers: WaterSupportLayer[];
  /** Approximate distance to nearest non-liquid shore (in voxel units). -1 if unknown. */
  shoreDistance: number;
  /** Normalized local X flow direction derived from neighboring water state. */
  flowX: number;
  /** Normalized local Z flow direction derived from neighboring water state. */
  flowZ: number;
  /** Relative local flow intensity [0,1]. */
  flowStrength: number;
  /** Derived surface class used by later water behavior phases. */
  waterClass: WaterSurfaceClass;
  /** Structured render-state contract introduced in Sprint 1. */
  renderState: WaterRenderState;
}

/**
 * Per-section grid of water column samples.
 * Indexed as [lx * boundsZ + lz] where lx,lz are local section coordinates [0,15].
 */
export interface WaterSectionGrid {
  /** Section world-space origin X. */
  originX: number;
  /** Section world-space origin Y. */
  originY: number;
  /** Section world-space origin Z. */
  originZ: number;
  /** Section bounds (typically 16). */
  boundsX: number;
  boundsY: number;
  boundsZ: number;
  /** Flat array of column samples, length = boundsX * boundsZ. */
  columns: WaterColumnSample[];
  /** Padded sample ring for cross-section lookups. */
  paddedColumns: WaterColumnSample[];
  /** Number of padded columns available around the section. */
  paddedRadius: number;
  /** Padded X dimension, typically boundsX + paddedRadius * 2. */
  paddedBoundsX: number;
  /** Padded Z dimension, typically boundsZ + paddedRadius * 2. */
  paddedBoundsZ: number;
  /** Number of columns that have water (filled === true). */
  filledCount: number;
  /** Low-resolution section-local interaction field used for local water disturbance presentation. */
  interactionField: Float32Array;
  /** Resolution of the square interaction field. */
  interactionFieldSize: number;
  /** Low-resolution section-local field describing broad water body continuity. */
  largeBodyField: Float32Array;
  /** Resolution of the square large-body field. */
  largeBodyFieldSize: number;
  /** GPU-ready packed data derived from the extracted water state. */
  gpuData: WaterSectionGPUData;
}
