import { Vec3Array } from "@amodx/math";
import type { WaterSectionGPUData } from "../../Water/Types/WaterTypes";
export interface WaterSectionUpdateTask {
  originX: number;
  originZ: number;
  boundsX: number;
  boundsZ: number;
  paddedBoundsX: number;
  paddedBoundsZ: number;
  gpuData: WaterSectionGPUData;
}
export interface SetSectionMeshTask {
  meshBuffer: ArrayBuffer;
  waterUpdate?: WaterSectionUpdateTask;
}
export declare function getSetSectionMeshTaskTransfers(task: SetSectionMeshTask): ArrayBufferLike[];
export type CompactSubMesh = [
    materialId: string,
    vertexBuffer: Float32Array,
    indexBuffer: Uint32Array | Uint16Array,
    minBounds: Vec3Array,
    maxBounds: Vec3Array
];
export type CompactMeshData = CompactSubMesh[];
/**
 * old web gpu data
 [
      type: 1,
      vertexBuffer: ArrayBuffer,
      indexBuffer: Uint32Array,
      bvhTreeBuffer: Float32Array,
      bvhIndexBuffer: Uint32Array,
      minBounds: Vec3Array,
      maxBounds: Vec3Array,
    ];

 *
 */
