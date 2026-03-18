import { LocationData } from "../../../Math";
import type { SetSectionMeshTask } from "../../Types/Mesher.types";
import { SectionCursor } from "../../../World/Cursor/SectionCursor.js";
import { WorldVoxelCursor } from "../../../World/Cursor/WorldVoxelCursor";
import { DataCursorInterface } from "../../../Voxels/Cursor/DataCursor.interface";
export declare function meshVoxel(x: number, y: number, z: number, voxel: WorldVoxelCursor, worldCursor: DataCursorInterface, sectionCursor: SectionCursor): boolean;
export declare function MeshSectionBase(worldCursor: DataCursorInterface, sectionCursor: SectionCursor, location: LocationData, transfers?: any[]): SetSectionMeshTask | null;
