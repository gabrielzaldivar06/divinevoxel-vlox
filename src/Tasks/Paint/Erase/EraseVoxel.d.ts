import { VoxelUpdateData } from "../../../Tasks/Tasks.types.js";
import type { LocationData } from "../../../Math/Location";
/**
 * Erases a voxel at the given location.
 * Returns the trueVoxelId of the erased voxel (0 if air or not found),
 * so callers on the render thread can fire fracture events.
 */
export declare function EraseVoxel(location: LocationData, updateData: VoxelUpdateData): number;
