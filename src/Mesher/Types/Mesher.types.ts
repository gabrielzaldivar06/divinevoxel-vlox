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

export function getSetSectionMeshTaskTransfers(task: SetSectionMeshTask) {
  const transfers: ArrayBufferLike[] = [task.meshBuffer];
  if (!task.waterUpdate) {
    return transfers;
  }
  const { gpuData } = task.waterUpdate;
  transfers.push(gpuData.columnBuffer.buffer as ArrayBufferLike);
  transfers.push(gpuData.paddedColumnBuffer.buffer as ArrayBufferLike);
  transfers.push(gpuData.columnMetadata.buffer as ArrayBufferLike);
  transfers.push(gpuData.paddedColumnMetadata.buffer as ArrayBufferLike);
  transfers.push(gpuData.particleSeedBuffer.buffer as ArrayBufferLike);
  transfers.push(gpuData.interactionField.buffer as ArrayBufferLike);
  transfers.push(gpuData.largeBodyField.buffer as ArrayBufferLike);
  transfers.push(gpuData.patchSummaryBuffer.buffer as ArrayBufferLike);
  transfers.push(gpuData.patchMetadata.buffer as ArrayBufferLike);
  transfers.push(gpuData.columnPatchIndex.buffer as ArrayBufferLike);
  return transfers;
}

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
