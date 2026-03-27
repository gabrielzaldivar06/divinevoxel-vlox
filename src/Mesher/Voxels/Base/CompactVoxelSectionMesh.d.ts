import { SetSectionMeshTask } from "../../Types/Mesher.types";
import { VoxelModelBuilder } from "../Models/VoxelModelBuilder";
import { LocationData } from "../../../Math";
import type { WaterSectionGrid } from "../../../Water/Types/WaterTypes";
export declare function CompactVoxelSectionMesh(location: LocationData, tools: VoxelModelBuilder[], waterGrid?: WaterSectionGrid, transfers?: any[]): SetSectionMeshTask;
