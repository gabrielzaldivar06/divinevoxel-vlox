import { VoxelUpdateTask } from "../../VoxelUpdateTask";
import { CardinalNeighbors3D } from "../../../Math/CardinalNeighbors";

/**
 * Radiation flood-fill propagation.
 * Follows the same pattern as PowerUpdate but uses a dedicated radiation Uint8Array
 * instead of packing into the level byte.
 * Falloff: 1 per block. Blocked by opaque voxels.
 */
export function RadiationUpdate(tasks: VoxelUpdateTask) {
  const queue = tasks.radiation.update;
  const sDataCursor = tasks.sDataCursor;
  const nDataCursor = tasks.nDataCursor;
  const bounds = tasks.bounds;

  let queueIndex = 0;

  while (queueIndex < queue.length) {
    const x = queue[queueIndex++];
    const y = queue[queueIndex++];
    const z = queue[queueIndex++];

    const voxel = sDataCursor.getVoxel(x, y, z);
    if (!voxel) continue;

    let sl = voxel.getRadiation();
    if (voxel.isRadiationSource()) {
      const sourceVal = voxel.getRadiationSourceValue();
      if (sourceVal > sl) {
        sl = sourceVal;
        voxel.setRadiation(sl);
      }
    }
    if (sl <= 0) continue;

    for (let i = 0; i < 6; i++) {
      const nx = CardinalNeighbors3D[i][0] + x;
      const ny = CardinalNeighbors3D[i][1] + y;
      const nz = CardinalNeighbors3D[i][2] + z;
      if (!nDataCursor.inBounds(nx, ny, nz)) continue;
      const nVoxel = nDataCursor.getVoxel(nx, ny, nz);
      if (!nVoxel) continue;
      if (nVoxel.isOpaque() && !nVoxel.isRadiationSource()) continue;

      const nl = nVoxel.getRadiation();
      const propagated = sl - 1;
      if (propagated > nl) {
        nVoxel.setRadiation(propagated);
        queue.push(nx, ny, nz);
      }
    }

    bounds.updateDisplay(x, y, z);
  }

  queue.length = 0;
}

export function RadiationRemove(tasks: VoxelUpdateTask) {
  const remove = tasks.radiation.remove;
  const update = tasks.radiation.update;
  const removeMap = tasks.radiation.removeMap;
  const updateMap = tasks.radiation.updateMap;
  const sDataCursor = tasks.sDataCursor;
  const nDataCursor = tasks.nDataCursor;
  const bounds = tasks.bounds;

  let removeIndex = 0;

  while (removeIndex < remove.length) {
    const x = remove[removeIndex++];
    const y = remove[removeIndex++];
    const z = remove[removeIndex++];

    if (removeMap.has(x, y, z)) continue;
    removeMap.add(x, y, z);

    const voxel = sDataCursor.getVoxel(x, y, z);
    if (!voxel) continue;
    const sl = voxel.getRadiation();
    if (sl <= 0) continue;

    for (let i = 0; i < 6; i++) {
      const nx = CardinalNeighbors3D[i][0] + x;
      const ny = CardinalNeighbors3D[i][1] + y;
      const nz = CardinalNeighbors3D[i][2] + z;
      if (!nDataCursor.inBounds(nx, ny, nz)) continue;
      const nVoxel = nDataCursor.getVoxel(nx, ny, nz);
      if (!nVoxel) continue;

      const nl = nVoxel.getRadiation();
      if (nl > 0 && nl < sl) {
        remove.push(nx, ny, nz);
        if (nVoxel.isRadiationSource()) {
          update.push(nx, ny, nz);
        }
      } else if (nl > 0 && nl >= sl && !updateMap.has(nx, ny, nz)) {
        updateMap.add(nx, ny, nz);
        update.push(nx, ny, nz);
      }
    }

    bounds.updateDisplay(x, y, z);
    voxel.setRadiation(0);
  }

  remove.length = 0;
  removeMap.clear();
}
