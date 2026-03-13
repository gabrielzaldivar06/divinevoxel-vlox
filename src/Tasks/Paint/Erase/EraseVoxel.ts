import { EngineSettings as ES } from "../../../Settings/EngineSettings.js";
import { VoxelUpdateTask } from "../../VoxelUpdateTask.js";
import { canUpdate, updateArea } from "../Common.js";
import {
  PowerRemove,
  PowerUpdate,
} from "../../Propagation/Power/PowerUpdate.js";
import { VoxelUpdateData } from "../../../Tasks/Tasks.types.js";
import type { LocationData } from "../../../Math/Location";
const tasks = new VoxelUpdateTask();

/**
 * Erases a voxel at the given location.
 * Returns the trueVoxelId of the erased voxel (0 if air or not found),
 * so callers on the render thread can fire fracture events.
 */
export function EraseVoxel(
  location: LocationData,
  updateData: VoxelUpdateData
): number {
  const [dimension, x, y, z] = location;
  if (!canUpdate(x, y, z, updateData)) return 0;
  tasks.setOriginAt(location);
  let voxel = tasks.sDataCursor.getVoxel(x, y, z);
  if (!voxel) return 0;

  // Capture voxel info before zeroing so the caller can use it for fracture splats
  const erasedVoxelId = voxel.getVoxelId();

  const foundPower = voxel.getPower();
  voxel.ids[voxel._index] = 0;
  voxel.level[voxel._index] = 0;
  voxel.secondary[voxel._index] = 0;
  voxel.light[voxel._index] = 0;
  voxel.updateVoxel(1);
  updateArea(tasks, x - 1, y - 1, z - 1, x + 1, y + 1, z + 1);

  voxel = tasks.sDataCursor.getVoxel(x, y, z)!;

  if (ES.doPower) {
    if (foundPower > -1) {
      voxel.setLevel(foundPower);
      tasks.power.remove.push(x, y, z);
      PowerRemove(tasks);
      PowerUpdate(tasks);
    }
  }

  tasks.bounds.markDisplayDirty();

  return erasedVoxelId;
}
