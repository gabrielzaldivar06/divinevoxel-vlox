/**
 * Per-column water sample data for a single (x,z) position within a section.
 */
export interface WaterColumnSample {
    /** Whether liquid is present in this column. */
    filled: boolean;
    /** World-space Y of the water surface. */
    surfaceY: number;
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
    /** Approximate distance to nearest non-liquid shore (in voxel units). -1 if unknown. */
    shoreDistance: number;
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
    /** Number of columns that have water (filled === true). */
    filledCount: number;
}
