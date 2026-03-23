import { EraseVoxelPathTask, VoxelUpdateData } from "../../Tasks.types";
import { VoxelUpdateTask } from "../../VoxelUpdateTask";
import { canUpdate, updateArea } from "../Common";

import { Vec3Array, Vector3Like } from "@amodx/math";
import { VoxelPath } from "../../../Templates/Path/VoxelPath";
import { VoxelPathData } from "../../../Templates/Path/VoxelPath.types";
import { EngineSettings as ES } from "../../../Settings/EngineSettings";
import { PowerRemove, PowerUpdate } from "../../Propagation/Power/PowerUpdate";

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

function eraseAndTrackPower(
  tasks: VoxelUpdateTask,
  dimension: number,
  vx: number,
  vy: number,
  vz: number,
): boolean {
  const voxel = tasks.nDataCursor.getVoxel(vx, vy, vz);
  if (!voxel) return false;
  const foundPower = ES.doPower ? voxel.getPower() : -1;
  voxel.ids[voxel._index] = 0;
  voxel.level[voxel._index] = 0;
  voxel.secondary[voxel._index] = 0;
  voxel.light[voxel._index] = 0;
  voxel.updateVoxel(1);
  if (ES.doPower && foundPower > -1) {
    const v = tasks.nDataCursor.getVoxel(vx, vy, vz);
    if (v) {
      v.setLevel(foundPower);
      tasks.power.remove.push(vx, vy, vz);
      return true;
    }
  }
  return false;
}

export default function EraseVoxelPath(
  dimension: number,
  [ox,oy,oz]: Vec3Array,
  voxelPathData: VoxelPathData,
  updateData: VoxelUpdateData
) {
  tasks.setOriginAt([dimension, ox, oy, oz]);
  const path = new VoxelPath(voxelPathData);
  let needsPowerRemove = false;

  for (let i = 0; i < path.segments.length; i++) {
    const { start, end, voxel } = path.segments[i];
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
      if (eraseAndTrackPower(tasks, dimension, sx, sy, sz)) {
        needsPowerRemove = true;
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
    let wroteVoxel = false;

    for (let step = 0; step <= steps; step++) {
      const vx = Math.floor(x);
      const vy = Math.floor(y);
      const vz = Math.floor(z);
      x += stepX;
      y += stepY;
      z += stepZ;
      if (!canUpdate(vx, vy, vz, updateData)) continue;
      if (eraseAndTrackPower(tasks, dimension, vx, vy, vz)) {
        needsPowerRemove = true;
      }
      wroteVoxel = true;
      updateBounds(vx, vy, vz);
    }

    if (wroteVoxel) {
      updateArea(tasks, min.x, min.y, min.z, max.x, max.y, max.z);
    }
  }

  tasks.setOriginAt([dimension, ox, oy, oz]);
  if (needsPowerRemove) {
    PowerRemove(tasks);
    PowerUpdate(tasks);
  }
}
