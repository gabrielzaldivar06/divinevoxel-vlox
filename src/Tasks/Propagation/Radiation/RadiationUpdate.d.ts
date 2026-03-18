import { VoxelUpdateTask } from "../../VoxelUpdateTask";
/**
 * Radiation flood-fill propagation.
 * Follows the same pattern as PowerUpdate but uses a dedicated radiation Uint8Array
 * instead of packing into the level byte.
 * Falloff: 1 per block. Blocked by opaque voxels.
 */
export declare function RadiationUpdate(tasks: VoxelUpdateTask): void;
export declare function RadiationRemove(tasks: VoxelUpdateTask): void;
