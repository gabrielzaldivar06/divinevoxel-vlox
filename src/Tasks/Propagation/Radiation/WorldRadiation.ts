import { WorldSpaces } from "../../../World/WorldSpaces";
import { VoxelUpdateTask } from "../../VoxelUpdateTask";
import { WorldRegister } from "../../../World/WorldRegister";
import { SectionCursor } from "../../../World/Cursor/SectionCursor";
import { RadiationUpdate } from "./RadiationUpdate";
import { VoxelTagsRegister } from "../../../Voxels/Data/VoxelTagsRegister";

const sectionCursor = new SectionCursor();

/**
 * World-level radiation propagation.
 * Scans all sections in a sector for radiation sources and queues them for flood-fill.
 * Follows the same pattern as WorldRGB.
 */
export function WorldRadiation(task: VoxelUpdateTask) {
  const sector = WorldRegister.sectors.get(
    task.origin[0],
    task.origin[1],
    task.origin[2],
    task.origin[3]
  );

  if (!sector) {
    console.error(
      `Tried running world radiation on a sector that does not exist ${task.origin.toString()}`
    );
    return false;
  }

  // Skip the entire sector scan if no voxel type is a radiation source
  if (VoxelTagsRegister.RadiationSourceIds.size === 0) return;

  const radiationIds = VoxelTagsRegister.RadiationSourceIds;

  for (let i = 0; i < sector.sections.length; i++) {
    const section = sector.sections[i];
    if (!section) continue;
    sectionCursor.setSection(section);
    let [minY, maxY] = section.getMinMax();
    const cx = sector.position[0];
    const cy = sector.position[1] + i * WorldSpaces.section.bounds.y;
    const cz = sector.position[2];
    const maxX = WorldSpaces.section.bounds.x + cx;
    const maxZ = WorldSpaces.section.bounds.z + cz;
    if (Math.abs(minY) == Infinity && Math.abs(maxY) == Infinity) continue;
    for (let y = cy + minY; y <= cy + maxY; y++) {
      for (let x = cx; x < maxX; x++) {
        for (let z = cz; z < maxZ; z++) {
          const voxel = sectionCursor.getVoxel(x, y, z);
          if (!voxel || voxel.isAir()) continue;
          // Fast ID check instead of per-voxel tag lookup
          if (!radiationIds.has(voxel.getVoxelId())) continue;
          const sourceVal = voxel.getRadiationSourceValue();
          if (sourceVal > 0) {
            voxel.setRadiation(sourceVal);
            task.radiation.update.push(x, y, z);
          }
        }
      }
    }
  }

  RadiationUpdate(task);
}
