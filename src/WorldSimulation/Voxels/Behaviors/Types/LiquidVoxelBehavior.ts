import { CardinalNeighbors2D, CardinalNeighbors3D } from "../../../../Math/CardinalNeighbors";
import { EngineSettings } from "../../../../Settings/EngineSettings";
import { VoxelBehaviorsRegister } from "../VoxelBehaviorsRegister";

VoxelBehaviorsRegister.register({
  type: "dve_liquid",
  needUpdate(simulation, voxel, x, y, z) {
    if (!EngineSettings.doFlow) return false;
    let scheduleUpdate = false;
    const myLevel = voxel.getLevel();
    let hasAirNeighbor = false;
    let highestSameNeighborLevel = myLevel;
    for (let i = 0; i < CardinalNeighbors2D.length; i++) {
      const nx = CardinalNeighbors2D[i][0] + x;
      const nz = CardinalNeighbors2D[i][1] + z;
      const nVoxel = simulation.nDataCursor.getVoxel(nx, y, nz);
      if (nVoxel) {
        if (!nVoxel.isSameVoxel(voxel) && nVoxel.isAir()) {
          hasAirNeighbor = true;
        }
        // Also bootstrap when adjacent same-liquid has a 2+ level gap (equalization needed)
        if (nVoxel.isSameVoxel(voxel) && myLevel - nVoxel.getLevel() >= 2) {
          scheduleUpdate = true;
          break;
        }
        if (nVoxel.isSameVoxel(voxel)) {
          highestSameNeighborLevel = Math.max(
            highestSameNeighborLevel,
            nVoxel.getLevel(),
          );
        }
      }
    }
    if (!scheduleUpdate && hasAirNeighbor) {
      // Keep calm isolated 1-level shorelines asleep, but if a fuller connected
      // body is still feeding this exposed edge then keep equalizing until it settles.
      if (myLevel > 1 || highestSameNeighborLevel > myLevel) {
        scheduleUpdate = true;
      }
    }
    if (!scheduleUpdate && myLevel > 1) {
      for (let i = 0; i < CardinalNeighbors2D.length; i++) {
        const nx = CardinalNeighbors2D[i][0] + x;
        const nz = CardinalNeighbors2D[i][1] + z;
        const sideVoxel = simulation.nDataCursor.getVoxel(nx, y, nz);
        if (!sideVoxel || (!sideVoxel.isAir() && !sideVoxel.isSameVoxel(voxel))) {
          continue;
        }
        const diagonalVoxel = simulation.nDataCursor.getVoxel(nx, y - 1, nz);
        if (!diagonalVoxel) continue;
        if (diagonalVoxel.isAir()) {
          scheduleUpdate = true;
          break;
        }
        if (diagonalVoxel.isSameVoxel(voxel) && diagonalVoxel.getLevel() + 1 < myLevel) {
          scheduleUpdate = true;
          break;
        }
      }
    }
    const downVoxel = simulation.nDataCursor.getVoxel(x, y - 1, z);
    if (downVoxel && !downVoxel.isSameVoxel(voxel) && downVoxel.isAir()) {
      scheduleUpdate = true;
    }
    if (scheduleUpdate) {
        simulation.scheduleUpdate("dve_liquid", x, y, z, 0);
    }
    return scheduleUpdate;
  },
  onPaint(simulation, voxel, x, y, z) {
    if (!EngineSettings.doFlow) return;
    simulation.scheduleUpdate("dve_liquid", x, y, z, 0);
    for (let i = 0; i < CardinalNeighbors3D.length; i++) {
      const nx = CardinalNeighbors3D[i][0] + x;
      const ny = CardinalNeighbors3D[i][1] + y;
      const nz = CardinalNeighbors3D[i][2] + z;
      const nVoxel = simulation.nDataCursor.getVoxel(nx, ny, nz);
      if (!nVoxel || !nVoxel.substanceTags["dve_is_liquid"]) continue;
      simulation.scheduleUpdate("dve_liquid", nx, ny, nz, 0);
    }
  },
  onErase(simulation, voxel, x, y, z) {
    if (!EngineSettings.doFlow) return;
    voxel.setLevelState(2);
    for (let i = 0; i < CardinalNeighbors3D.length; i++) {
      const nx = CardinalNeighbors3D[i][0] + x;
      const ny = CardinalNeighbors3D[i][1] + y;
      const nz = CardinalNeighbors3D[i][2] + z;
      const nVoxel = simulation.sDataCursor.getVoxel(nx, ny, nz);
      if (!nVoxel || !nVoxel.substanceTags["dve_is_liquid"]) continue;
      simulation.scheduleUpdate("dve_liquid", nx, ny, nz, 0);
    }
    simulation.scheduleUpdate("dve_liquid", x, y, z, 10);
  },
});
