import { Vec3Array } from "@amodx/math";
import { canUpdate, updateArea, updatePowerTask } from "../Common";
import { VoxelTemplateRegister } from "../../../Templates/VoxelTemplateRegister";
import { IVoxelTemplateData } from "../../../Templates/VoxelTemplates.types";
import { RawVoxelData } from "../../../Voxels/Types/Voxel.types";
import { WorldSimulation } from "../../../WorldSimulation";
import { VoxelBehaviorsRegister } from "../../../WorldSimulation/Voxels/Behaviors";
import { VoxelTagsRegister } from "../../../Voxels/Data/VoxelTagsRegister";
import { VoxelUpdateData } from "../../Tasks.types";
import { VoxelUpdateTask } from "../../VoxelUpdateTask";
import { EngineSettings as ES } from "../../../Settings/EngineSettings";
import { PowerRemove, PowerUpdate } from "../../Propagation/Power/PowerUpdate";

const tasks = new VoxelUpdateTask();
const raw: RawVoxelData = [0, 0, 0, 0];

function getBehavior(voxelId: number) {
  if (!voxelId) return null;
  const tags = VoxelTagsRegister.VoxelTags[voxelId];
  if (!tags) return null;
  return VoxelBehaviorsRegister.get(tags["dve_simulation_behavior"] || "default");
}

export default function ReplaceVoxelTemplate(
  dimension: number,
  [ox, oy, oz]: Vec3Array,
  templateData: IVoxelTemplateData<any>,
  updateData: VoxelUpdateData,
) {
  const voxelTemplate = VoxelTemplateRegister.create(templateData);
  tasks.setOriginAt([dimension, ox, oy, oz]);
  const simulation = WorldSimulation.getDimension(dimension).simulation;
  let needsPowerRemove = false;
  let needsPowerUpdate = false;

  const { x: sx, y: sy, z: sz } = voxelTemplate.bounds.size;

  for (let x = 0; x < sx; x++) {
    for (let y = 0; y < sy; y++) {
      for (let z = 0; z < sz; z++) {
        const tx = ox + x;
        const ty = oy + y;
        const tz = oz + z;
        const index = voxelTemplate.getIndex(x, y, z);
        if (!voxelTemplate.isIncluded(index)) continue;
        if (!canUpdate(tx, ty, tz, updateData)) continue;
        if (!tasks.sDataCursor.inBounds(tx, ty, tz)) continue;

        const voxel = tasks.sDataCursor.getVoxel(tx, ty, tz);
        if (!voxel) continue;

        const previousRaw = voxel.getRaw();
        const previousId = previousRaw[0];
        const previousBehavior = getBehavior(previousId);

        voxelTemplate.getRaw(index, raw);

        const changed =
          previousRaw[0] !== raw[0] ||
          previousRaw[1] !== raw[1] ||
          previousRaw[2] !== raw[2] ||
          previousRaw[3] !== raw[3];
        if (!changed) continue;

        // Power removal for old voxel
        const oldPower = ES.doPower ? voxel.getPower() : -1;

        if (previousId !== 0 && previousBehavior) {
          previousBehavior.onErase(simulation, tx, ty, tz);
        }

        voxel.setRaw(raw);
        voxel.updateVoxel(raw[0] === 0 ? 1 : 0);

        if (ES.doPower) {
          // Remove power from old voxel if it had any
          if (oldPower > -1) {
            const v = tasks.sDataCursor.getVoxel(tx, ty, tz);
            if (v) {
              v.setLevel(oldPower);
              tasks.power.remove.push(tx, ty, tz);
              needsPowerRemove = true;
            }
          }
          // Update power for new voxel if it affects logic
          if (raw[0] !== 0) {
            const v = tasks.sDataCursor.getVoxel(tx, ty, tz);
            if (v && v.doesVoxelAffectLogic()) {
              tasks.setOriginAt([dimension, tx, ty, tz]);
              updatePowerTask(tasks);
              tasks.power.update.push(tx, ty, tz);
              needsPowerUpdate = true;
            }
          }
        }

        const nextBehavior = getBehavior(raw[0]);
        if (raw[0] !== 0 && nextBehavior) {
          nextBehavior.onPaint(simulation, tx, ty, tz);
        }
      }
    }
  }

  tasks.setOriginAt([dimension, ox, oy, oz]);
  updateArea(tasks, ox, oy, oz, ox + sx, oy + sy, oz + sz);
  if (needsPowerRemove) {
    PowerRemove(tasks);
  }
  if (needsPowerRemove || needsPowerUpdate) {
    PowerUpdate(tasks);
  }
}