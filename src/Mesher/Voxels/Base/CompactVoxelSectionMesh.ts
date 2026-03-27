import { SetSectionMeshTask, WaterSectionUpdateTask } from "../../Types/Mesher.types";
import { VoxelModelBuilder } from "../Models/VoxelModelBuilder";
import { VoxelMeshVertexStructCursor } from "../Geometry/VoxelMeshVertexStructCursor";
import { LocationData } from "../../../Math";
import {
  CompactedSectionVoxelMesh,
  CompactedMeshData,
} from "../Geometry/CompactedSectionVoxelMesh";
import type { WaterSectionGrid } from "../../../Water/Types/WaterTypes";

const meshData = new CompactedMeshData();
const compactedMesh = new CompactedSectionVoxelMesh();

/** Utility to ensure a value is aligned to 4 bytes. */
function align4(value: number) {
  return (value + 3) & ~3;
}

export function CompactVoxelSectionMesh(
  location: LocationData,
  tools: VoxelModelBuilder[],
  waterGrid?: WaterSectionGrid,
  transfers: any[] = []
): SetSectionMeshTask {
  // 1) First compute how large the final buffer needs to be (with 4-byte alignment).
  let headerSize = CompactedSectionVoxelMesh.GetHeaderByteSize(tools.length);

  // Make the header itself 4-byte aligned
  headerSize = align4(headerSize);

  let totalByteCount = headerSize;

  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];

    // Add the vertex data
    const vertexByteSize =
      tool.mesh.vertexCount * VoxelMeshVertexStructCursor.VertexByteSize;
    totalByteCount += vertexByteSize;
    // Align after writing vertex data
    totalByteCount = align4(totalByteCount);

    // Add the index data
    const indexByteSize = tool.mesh.indicieCount * 4;

    totalByteCount += indexByteSize;
    // Align after writing index data
    totalByteCount = align4(totalByteCount);
  }

  // 2) Allocate the final buffer
  const buffer = new ArrayBuffer(totalByteCount);

  compactedMesh.setData(buffer);
  compactedMesh.setLocation(...location);
  compactedMesh.setTotalMeshes(tools.length);

  // We'll track our position in the buffer here
  let byteCount = headerSize;
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];

    // Fill out the meshData structure
    meshData.materialId = tool.id;

    const minBounds = tool.mesh.minBounds;
    const maxBounds = tool.mesh.maxBounds;
    meshData.minBounds[0] = minBounds.x;
    meshData.minBounds[1] = minBounds.y;
    meshData.minBounds[2] = minBounds.z;
    meshData.maxBounds[0] = maxBounds.x;
    meshData.maxBounds[1] = maxBounds.y;
    meshData.maxBounds[2] = maxBounds.z;

    // Vertex info
    const totalVertFloats =
      tool.mesh.vertexCount * VoxelMeshVertexStructCursor.VertexFloatSize;
    const vertexByteCount = totalVertFloats * 4;

    meshData.vertexIndex[0] = byteCount;
    meshData.vertexIndex[1] = totalVertFloats;

    // Now move the pointer
    byteCount += vertexByteCount;
    // Align to 4 bytes again before writing indices
    byteCount = align4(byteCount);

    // Index info
    meshData.indiceIndex[0] = byteCount;
    meshData.indiceIndex[1] = tool.mesh.indicieCount;

    const indexByteCount = tool.mesh.indicieCount * 4;

    byteCount += indexByteCount;
    // Align to 4 bytes for the next iteration (or final)
    byteCount = align4(byteCount);

    // Store the meta info
    compactedMesh.setMeshData(i, meshData);

    // Write vertex data
    const vertexArray = new Float32Array(
      buffer,
      meshData.vertexIndex[0],
      totalVertFloats
    );

    const vertexBuffers = tool.mesh.buffer._buffers;
    let start = 0;
    let done = false;
    for (let b = 0; b < vertexBuffers.length; b++) {
      const buf = vertexBuffers[b];
      for (let j = 0; j < buf.length; j++) {
        vertexArray[start] = buf[j];
        start++;
        if (start >= totalVertFloats) {
          done = true;
          break;
        }
      }
      if (done) break;
    }

    // Write index data
    const indicesArray = new Uint32Array(
      buffer,
      meshData.indiceIndex[0],
      tool.mesh.indicieCount
    );

    const indiceBuffers = tool.mesh.indices._buffers;
    start = 0;
    done = false;
    for (let b = 0; b < indiceBuffers.length; b++) {
      const buf = indiceBuffers[b];
      for (let j = 0; j < buf.length; j++) {
        indicesArray[start] = buf[j];
        start++;
        if (start >= tool.mesh.indicieCount) {
          done = true;
          break;
        }
      }
      if (done) break;
    }
  }

  // Transfer the ArrayBuffer to your worker if needed
  const task: SetSectionMeshTask = {
    meshBuffer: buffer,
  };

  transfers.push(buffer);

  if (waterGrid && waterGrid.filledCount > 0) {
    const waterUpdate: WaterSectionUpdateTask = {
      originX: waterGrid.originX,
      originZ: waterGrid.originZ,
      boundsX: waterGrid.boundsX,
      boundsZ: waterGrid.boundsZ,
      paddedBoundsX: waterGrid.paddedBoundsX,
      paddedBoundsZ: waterGrid.paddedBoundsZ,
      gpuData: {
        columnBuffer: waterGrid.gpuData.columnBuffer.slice(),
        columnStride: waterGrid.gpuData.columnStride,
        paddedColumnBuffer: waterGrid.gpuData.paddedColumnBuffer.slice(),
        paddedColumnStride: waterGrid.gpuData.paddedColumnStride,
        columnMetadata: waterGrid.gpuData.columnMetadata.slice(),
        paddedColumnMetadata: waterGrid.gpuData.paddedColumnMetadata.slice(),
        particleSeedBuffer: waterGrid.gpuData.particleSeedBuffer.slice(),
        particleSeedStride: waterGrid.gpuData.particleSeedStride,
        particleSeedCount: waterGrid.gpuData.particleSeedCount,
        interactionField: waterGrid.gpuData.interactionField.slice(),
        interactionFieldSize: waterGrid.gpuData.interactionFieldSize,
        largeBodyField: waterGrid.gpuData.largeBodyField.slice(),
        largeBodyFieldSize: waterGrid.gpuData.largeBodyFieldSize,
        patchSummaryBuffer: waterGrid.gpuData.patchSummaryBuffer.slice(),
        patchSummaryStride: waterGrid.gpuData.patchSummaryStride,
        patchSummaryCount: waterGrid.gpuData.patchSummaryCount,
        patchMetadata: waterGrid.gpuData.patchMetadata.slice(),
        columnPatchIndex: waterGrid.gpuData.columnPatchIndex.slice(),
      },
    };
    task.waterUpdate = waterUpdate;
    transfers.push(
      waterUpdate.gpuData.columnBuffer.buffer,
      waterUpdate.gpuData.paddedColumnBuffer.buffer,
      waterUpdate.gpuData.columnMetadata.buffer,
      waterUpdate.gpuData.paddedColumnMetadata.buffer,
      waterUpdate.gpuData.particleSeedBuffer.buffer,
      waterUpdate.gpuData.interactionField.buffer,
      waterUpdate.gpuData.largeBodyField.buffer,
      waterUpdate.gpuData.patchSummaryBuffer.buffer,
      waterUpdate.gpuData.patchMetadata.buffer,
      waterUpdate.gpuData.columnPatchIndex.buffer,
    );
  }

  return task;
}
