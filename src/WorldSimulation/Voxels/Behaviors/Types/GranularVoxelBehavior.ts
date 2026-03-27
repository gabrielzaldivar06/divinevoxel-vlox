import { VoxelBehaviorsRegister } from "../VoxelBehaviorsRegister";

/**
 * Behavior for granular voxels affected by gravity (sand, gravel, dirt).
 *
 * - needUpdate: checks if below is air or liquid → schedule gravity tick
 * - onPaint: always schedule initial gravity check
 * - onErase: wake neighbors that may now be unsupported
 */

const GRANULAR_SHEAR_THRESHOLD = 30;

VoxelBehaviorsRegister.register({
  type: "dve_granular",
  needUpdate(simulation, voxel, x, y, z) {
    const downVoxel = simulation.nDataCursor.getVoxel(x, y - 1, z);
    if (!downVoxel) return false;
    if (downVoxel.isAir() || downVoxel.substanceTags["dve_is_liquid"]) {
      simulation.scheduleUpdate("dve_gravity", x, y, z, 0);
      return true;
    }
    return false;
  },
  onPaint(simulation, voxel, x, y, z) {
    simulation.scheduleUpdate("dve_gravity", x, y, z, 0);
  },
  onErase(simulation, voxel, x, y, z) {
    // Wake neighbors above that may now be unsupported
    const positions: [number, number, number][] = [
      [x, y + 1, z],
      [x + 1, y, z],
      [x - 1, y, z],
      [x, y, z + 1],
      [x, y, z - 1],
    ];
    for (const [nx, ny, nz] of positions) {
      const neighbor = simulation.nDataCursor.getVoxel(nx, ny, nz);
      if (!neighbor || neighbor.isAir()) continue;
      if (neighbor.substanceTags["dve_is_liquid"]) continue;
      const shear = neighbor.tags["dve_shear_strength"] as number;
      if (shear !== undefined && shear <= GRANULAR_SHEAR_THRESHOLD) {
        simulation.scheduleUpdate("dve_gravity", nx, ny, nz, 0);
      }
    }
  },
});
