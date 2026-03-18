import type { SetSectionMeshTask } from "../Mesher/Types/Mesher.types";
import { LocationData } from "../Math/index.js";
import { DVESectionMeshes } from "./Classes/DVESectionMeshes";
import { SectorMesh } from "./Classes/SectorMesh";
import { SectionMesh } from "./Classes/SectionMesh";
export type SectionMeshCallback = (sectorKey: string, meshes: {
    materialId: string;
    vertices: Float32Array;
    sectionOrigin: [number, number, number];
}[]) => void;
export type SectorRemovedCallback = (sectorKey: string) => void;
export type VoxelErasedCallback = (dimensionId: number, x: number, y: number, z: number, voxelId: number) => void;
export declare class MeshManager {
    static _sectorPool: SectorMesh[];
    static _sectionPool: SectionMesh[];
    static sectorMeshes: DVESectionMeshes;
    static runningUpdate: boolean;
    static onSectionUpdated: SectionMeshCallback | null;
    static onSectorRemoved: SectorRemovedCallback | null;
    static onVoxelErased: VoxelErasedCallback | null;
    static updateSection(data: SetSectionMeshTask): void;
    static removeSector(dimensionId: number, x: number, y: number, z: number): false | undefined;
    static removeSectorAt(data: LocationData): false | undefined;
}
