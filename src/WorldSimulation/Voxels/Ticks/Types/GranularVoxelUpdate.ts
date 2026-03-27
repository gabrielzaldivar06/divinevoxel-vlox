import type { Vec3Array } from "@amodx/math";
import { VoxelTickUpdateRegister } from "../VoxelTickUpdateRegister";
import { DimensionSimulation } from "../../../Dimensions/DimensionSimulation";
import { VoxelCursorInterface } from "../../../../Voxels/Cursor/VoxelCursor.interface";
import { EngineSettings } from "../../../../Settings/EngineSettings";

/**
 * Gravity tick update for granular voxels (sand, gravel, dirt).
 *
 * Cellular-automata falling-sand rules adapted for 3D:
 *   1. Fall straight down into air
 *   2. Displace liquid below (swap: sand sinks, liquid rises)
 *   3. Diagonal settling when directly-below is blocked
 *
 * Shear-strength tag gates which voxels are granular.
 */

const gravityUpdateRate = 2;

/** Low shear-strength threshold: voxels at or below this value are granular. */
const GRANULAR_SHEAR_THRESHOLD = 30;

/** Diagonal-settle offsets: try 4 cardinal directions + down */
const diagonalOffsets: Vec3Array[] = [
  [1, -1, 0],
  [-1, -1, 0],
  [0, -1, 1],
  [0, -1, -1],
];

function shuffleDiagonals(): Vec3Array[] {
  // Fisher-Yates to avoid directional bias
  const arr = diagonalOffsets.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

VoxelTickUpdateRegister.registerType({
  type: "dve_gravity",
  run(simulation, voxel, update) {
    if (!EngineSettings.doGravity) return;
    const { x, y, z } = update;

    const voxelId = voxel.getStringId();
    if (!voxelId) return;

    // --- 1. Try to fall straight down ---
    const downVoxel = simulation.nDataCursor.getVoxel(x, y - 1, z);
    if (!downVoxel) return; // bottom of world or unloaded

    if (downVoxel.isAir()) {
      // Move self down: paint at (x, y-1, z), erase at (x, y, z)
      simulation.brush
        .setXYZ(x, y - 1, z)
        .setId(voxelId)
        .setLevel(voxel.getLevel())
        .setLevelState(voxel.getLevelState())
        .paint()
        .clear();

      simulation.brush.setXYZ(x, y, z).erase();

      simulation.bounds.updateDisplay(x, y, z);
      simulation.bounds.updateDisplay(x, y - 1, z);

      // Continue falling
      simulation.scheduleUpdate("dve_gravity", x, y - 1, z, gravityUpdateRate);

      // Wake neighbors that might now be unsupported
      wakeNeighborsAbove(simulation, x, y, z);
      return;
    }

    // --- 2. Displace liquid below (sand sinks through water) ---
    if (downVoxel.substanceTags["dve_is_liquid"]) {
      const liquidId = downVoxel.getStringId();
      const liquidLevel = downVoxel.getLevel();
      const liquidLevelState = downVoxel.getLevelState();

      // Paint self at liquid's position
      simulation.brush
        .setXYZ(x, y - 1, z)
        .setId(voxelId)
        .setLevel(voxel.getLevel())
        .setLevelState(voxel.getLevelState())
        .paint()
        .clear();

      // Paint liquid at our old position
      simulation.brush
        .setXYZ(x, y, z)
        .setId(liquidId)
        .setLevel(liquidLevel)
        .setLevelState(liquidLevelState)
        .paint()
        .clear();

      simulation.bounds.updateDisplay(x, y, z);
      simulation.bounds.updateDisplay(x, y - 1, z);

      // Continue falling and re-tick the displaced liquid
      simulation.scheduleUpdate("dve_gravity", x, y - 1, z, gravityUpdateRate);
      simulation.scheduleUpdate("dve_liquid", x, y, z, 0);

      wakeNeighborsAbove(simulation, x, y, z);
      return;
    }

    // --- 3. Diagonal settling ---
    const shuffled = shuffleDiagonals();
    for (let i = 0; i < shuffled.length; i++) {
      const nx = x + shuffled[i][0];
      const ny = y + shuffled[i][1];
      const nz = z + shuffled[i][2];

      const diagVoxel = simulation.nDataCursor.getVoxel(nx, ny, nz);
      if (!diagVoxel) continue;

      if (diagVoxel.isAir()) {
        // Also check that the horizontal neighbor at same Y is not blocking a "wall"
        const sideVoxel = simulation.nDataCursor.getVoxel(
          nx,
          y,
          nz
        );
        if (sideVoxel && !sideVoxel.isAir() && !sideVoxel.substanceTags["dve_is_liquid"]) continue;

        // Move diagonally
        simulation.brush
          .setXYZ(nx, ny, nz)
          .setId(voxelId)
          .setLevel(voxel.getLevel())
          .setLevelState(voxel.getLevelState())
          .paint()
          .clear();

        simulation.brush.setXYZ(x, y, z).erase();

        simulation.bounds.updateDisplay(x, y, z);
        simulation.bounds.updateDisplay(nx, ny, nz);

        simulation.scheduleUpdate(
          "dve_gravity",
          nx,
          ny,
          nz,
          gravityUpdateRate
        );

        wakeNeighborsAbove(simulation, x, y, z);
        return;
      }

      // Diagonal + liquid displacement
      if (diagVoxel.substanceTags["dve_is_liquid"]) {
        const sideVoxel = simulation.nDataCursor.getVoxel(nx, y, nz);
        if (sideVoxel && !sideVoxel.isAir() && !sideVoxel.substanceTags["dve_is_liquid"]) continue;

        const liquidId = diagVoxel.getStringId();
        const liquidLevel = diagVoxel.getLevel();
        const liquidLevelState = diagVoxel.getLevelState();

        simulation.brush
          .setXYZ(nx, ny, nz)
          .setId(voxelId)
          .setLevel(voxel.getLevel())
          .setLevelState(voxel.getLevelState())
          .paint()
          .clear();

        simulation.brush
          .setXYZ(x, y, z)
          .setId(liquidId)
          .setLevel(liquidLevel)
          .setLevelState(liquidLevelState)
          .paint()
          .clear();

        simulation.bounds.updateDisplay(x, y, z);
        simulation.bounds.updateDisplay(nx, ny, nz);

        simulation.scheduleUpdate(
          "dve_gravity",
          nx,
          ny,
          nz,
          gravityUpdateRate
        );
        simulation.scheduleUpdate("dve_liquid", x, y, z, 0);

        wakeNeighborsAbove(simulation, x, y, z);
        return;
      }
    }

    // Fully settled — do nothing
  },
});

/** Wake voxels above and cardinally adjacent that might now be unsupported. */
function wakeNeighborsAbove(
  simulation: DimensionSimulation,
  x: number,
  y: number,
  z: number
) {
  const positions: Vec3Array[] = [
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
      simulation.scheduleUpdate("dve_gravity", nx, ny, nz, gravityUpdateRate);
    }
  }
}
