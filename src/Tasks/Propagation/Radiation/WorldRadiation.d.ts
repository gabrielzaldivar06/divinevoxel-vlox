import { VoxelUpdateTask } from "../../VoxelUpdateTask";
/**
 * World-level radiation propagation.
 * Scans all sections in a sector for radiation sources and queues them for flood-fill.
 * Follows the same pattern as WorldRGB.
 */
export declare function WorldRadiation(task: VoxelUpdateTask): false | undefined;
