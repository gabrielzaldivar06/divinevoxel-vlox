import { VoxelUpdateData } from "../../Tasks.types";
import { VoxelUpdateTask } from "../../VoxelUpdateTask";
import { canUpdate, updateArea, updatePowerTask } from "../Common";
import { PaintVoxelData } from "../../../Voxels/Types/PaintVoxelData";
import { VoxelPath } from "../../../Templates/Path/VoxelPath";
import { Vec3Array, Vector3Like } from "@amodx/math";
import { VoxelPathData } from "../../../Templates/Path/VoxelPath.types";
import { EngineSettings as ES } from "../../../Settings/EngineSettings";
import { PowerUpdate } from "../../Propagation/Power/PowerUpdate";

const tasks = new VoxelUpdateTask();
const min = Vector3Like.Create();
const max = Vector3Like.Create();

const updateBounds = (x: number, y: number, z: number) => {
  if (x < min.x) min.x = x;
  if (y < min.y) min.y = y;
  if (z < min.z) min.z = z;

  if (x > max.x) max.x = x;
  if (y > max.y) max.y = y;
  if (z > max.z) max.z = z;
};
export default function PaintVoxelPath(
  dimension: number,
  [ox, oy, oz]: Vec3Array,
  voxelPathData: VoxelPathData,
  updateData: VoxelUpdateData
) {
  tasks.setOriginAt([dimension, ox, oy, oz]);
  const path = new VoxelPath(voxelPathData);
  let needsPowerUpdate = false;

  for (let i = 0; i < path.segments.length; i++) {
    const { start, end, voxel } = path.segments[i];
    const rawVoxel = PaintVoxelData.ToRaw(voxel);
    let wroteVoxel = false;
    min.x = Infinity;
    min.y = Infinity;
    min.z = Infinity;
    max.x = -Infinity;
    max.y = -Infinity;
    max.z = -Infinity;
    const [sx, sy, sz] = start;
    const [ex, ey, ez] = end;

    const dx = ex - sx;
    const dy = ey - sy;
    const dz = ez - sz;

    const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
    if (steps === 0) {
      if (!canUpdate(sx, sy, sz, updateData)) continue;
      const voxel = tasks.nDataCursor.getVoxel(sx, sy, sz);
      if (!voxel) continue;
      voxel.setLight(0);
      voxel.setRaw(rawVoxel);
      voxel.updateVoxel(0);
      if (ES.doPower && voxel.doesVoxelAffectLogic()) {
        tasks.setOriginAt([dimension, sx, sy, sz]);
        updatePowerTask(tasks);
        tasks.power.update.push(sx, sy, sz);
        needsPowerUpdate = true;
      }
      updateArea(tasks, sx, sy, sz, sx, sy, sz);
      continue;
    }

    const stepX = dx / steps;
    const stepY = dy / steps;
    const stepZ = dz / steps;

    let x = sx;
    let y = sy;
    let z = sz;

    for (let step = 0; step <= steps; step++) {
      const vx = Math.floor(x);
      const vy = Math.floor(y);
      const vz = Math.floor(z);
      x += stepX;
      y += stepY;
      z += stepZ;
      if (!canUpdate(vx, vy, vz, updateData)) continue;

      const voxel = tasks.nDataCursor.getVoxel(vx, vy, vz);
      if (!voxel) continue;
      voxel.setLight(0);
      voxel.setRaw(rawVoxel);
      voxel.updateVoxel(0);
      if (ES.doPower && voxel.doesVoxelAffectLogic()) {
        tasks.setOriginAt([dimension, vx, vy, vz]);
        updatePowerTask(tasks);
        tasks.power.update.push(vx, vy, vz);
        needsPowerUpdate = true;
      }
      wroteVoxel = true;
      updateBounds(vx, vy, vz);
    }

    if (wroteVoxel) {
      updateArea(tasks, min.x, min.y, min.z, max.x, max.y, max.z);
    }
  }

  tasks.setOriginAt([dimension, ox, oy, oz]);
  if (needsPowerUpdate) {
    PowerUpdate(tasks);
  }
}
