import { WaterSectionGrid } from "../Types/WaterTypes";
import { DataCursorInterface } from "../../Voxels/Cursor/DataCursor.interface";
import { SectionCursor } from "../../World/Cursor/SectionCursor";
export type WaterExtractionOptions = {
    minSurfaceY?: number;
    maxSurfaceY?: number;
};
/**
 * Extract water state from a section into a flat grid of per-column samples.
 *
 * This is a read-only pass over existing liquid simulation data.
 * It does not modify the world or any voxel state.
 *
 * @returns The shared WaterSectionGrid (reused across calls — consume before next call).
 */
export declare function extractWaterState(worldCursor: DataCursorInterface, sectionCursor: SectionCursor, options?: WaterExtractionOptions): WaterSectionGrid;
