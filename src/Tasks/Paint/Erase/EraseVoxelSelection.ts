import { EraseVoxelTemplateTask, VoxelUpdateData } from "../../Tasks.types";
import { VoxelUpdateTask } from "../../VoxelUpdateTask";
import { canUpdate, updateArea } from "../Common";
import { VoxelTemplateRegister } from "../../../Templates/VoxelTemplateRegister";
import { RawVoxelData } from "../../../Voxels";
import { Vec3Array } from "@amodx/math";
import { IVoxelSelectionData } from "../../../Templates/Selection/VoxelSelection";
import { EngineSettings as ES } from "../../../Settings/EngineSettings";
import { PowerRemove, PowerUpdate } from "../../Propagation/Power/PowerUpdate";

const tasks = new VoxelUpdateTask();


export default function EraseVoxelSelection(
  dimension: number,
  [ox, oy, oz]: Vec3Array,
  selectionData: IVoxelSelectionData<any>,
  updateData: VoxelUpdateData
) {
  const selection = VoxelTemplateRegister.createSelection(selectionData);
  tasks.setOriginAt([dimension, ox, oy, oz]);
  let needsPowerRemove = false;

  const { x: sx, y: sy, z: sz } = selection.bounds.size;
  for (let x = 0; x < sx; x++) {
    for (let y = 0; y < sy; y++) {
      for (let z = 0; z < sz; z++) {
        const tx = ox + x;
        const ty = oy + y;
        const tz = oz + z;
        if (!selection.isSelected(tx, ty, tz)) continue;
        if (!canUpdate(tx, ty, tz, updateData)) continue;
        if (!tasks.sDataCursor.inBounds(tx, ty, tz)) continue;
        const voxel = tasks.sDataCursor.getVoxel(tx, ty, tz);
        if (!voxel || voxel.isAir()) continue;
        const foundPower = ES.doPower ? voxel.getPower() : -1;
        voxel.ids[voxel._index] = 0;
        voxel.level[voxel._index] = 0;
        voxel.secondary[voxel._index] = 0;
        voxel.light[voxel._index] = 0;
        voxel.updateVoxel(1);
        if (ES.doPower && foundPower > -1) {
          const v = tasks.sDataCursor.getVoxel(tx, ty, tz);
          if (v) {
            v.setLevel(foundPower);
            tasks.power.remove.push(tx, ty, tz);
            needsPowerRemove = true;
          }
        }
      }
    }
  }

  updateArea(tasks, ox, oy, oz, ox + sx, oy + sy, oz + sz);
  if (needsPowerRemove) {
    PowerRemove(tasks);
    PowerUpdate(tasks);
  }
}
