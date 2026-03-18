import { WaterSectionGrid } from "../Types/WaterTypes";
import { DataCursorInterface } from "../../Voxels/Cursor/DataCursor.interface";
export type WaterSurfaceMesherOptions = {
    minSurfaceY?: number;
    maxSurfaceY?: number;
};
/**
 * Generate a dedicated water top-surface mesh for the given section grid.
 *
 * Writes quads directly into the "dve_liquid" material builder's ProtoMesh.
 * This replaces the Surface Nets fluid emission path.
 *
 * @returns true if any water quads were emitted.
 */
export declare function meshWaterSurface(grid: WaterSectionGrid, worldCursor: DataCursorInterface, options?: WaterSurfaceMesherOptions): boolean;
