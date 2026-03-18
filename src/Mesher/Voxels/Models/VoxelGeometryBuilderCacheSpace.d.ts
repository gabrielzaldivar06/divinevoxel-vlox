import { DataCursorInterface } from "../../../Voxels/Cursor/DataCursor.interface";
import { Vec3Array, Vector3Like } from "@amodx/math";
import { VoxelCursor } from "../../../Voxels/Cursor/VoxelCursor";
export declare class VoxelGeometryBuilderCacheSpace {
    bounds: Vector3Like;
    foundHash: Uint8Array;
    voxelCache: Uint16Array;
    lightCache: Int32Array;
    trueVoxelCache: Uint16Array;
    reltionalVoxelCache: Uint16Array;
    reltionalStateCache: Uint16Array;
    noCastAO: Uint8Array;
    fullBlock: Uint8Array;
    levelCache: Uint8Array;
    liquidCache: Uint8Array;
    offset: Vec3Array;
    outOfBoundsIndex: number;
    voxelCursor: VoxelCursor;
    constructor(bounds: Vector3Like);
    start(x: number, y: number, z: number): void;
    isInBounds(x: number, y: number, z: number): boolean;
    getIndex(x: number, y: number, z: number): number;
    getHash(dataCursor: DataCursorInterface, x: number, y: number, z: number): number;
    private hashState;
}
