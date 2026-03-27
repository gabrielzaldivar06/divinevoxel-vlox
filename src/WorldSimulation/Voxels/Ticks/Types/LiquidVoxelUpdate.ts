import type { Vec3Array } from "@amodx/math";
import { VoxelTickUpdateRegister } from "../VoxelTickUpdateRegister";
import { VoxelCursorInterface } from "../../../../Voxels/Cursor/VoxelCursor.interface.js";
import { CardinalNeighbors3D } from "../../../../Math/CardinalNeighbors";
import { DimensionSimulation } from "../../../Dimensions/DimensionSimulation";
import { VoxelFaces } from "../../../../Math";
import { EngineSettings } from "../../../../Settings/EngineSettings";
import {
  recordHydrologyDiagonalSpill,
  recordHydrologyLateralEqualization,
  recordHydrologyLiquidRun,
  recordHydrologyTerraceHoldCandidate,
} from "../../../Hydrology/HydrologyDebugMetrics";

const floodOutChecks: Vec3Array[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
];

type LateralFlowTarget = {
  x: number;
  y: number;
  z: number;
  level: number;
  order: number;
};

type DiagonalFlowTarget = {
  x: number;
  y: number;
  z: number;
  level: number;
  sideIsAir: boolean;
  order: number;
};

function getHydraulicHead(level: number, y: number) {
  return y + level / 7;
}

function getLateralFlowTargets(
  simulation: DimensionSimulation,
  voxel: VoxelCursorInterface,
  x: number,
  y: number,
  z: number,
  currentLevel: number,
) {
  const sourceHead = getHydraulicHead(currentLevel, y);
  const targets: LateralFlowTarget[] = [];
  const rotation = Math.abs((x * 7349) ^ (y * 9151) ^ (z * 5381)) % 4;

  for (let offset = 0; offset < floodOutChecks.length; offset++) {
    const i = (rotation + offset) % floodOutChecks.length;
    const nx = floodOutChecks[i][0] + x;
    const ny = floodOutChecks[i][1] + y;
    const nz = floodOutChecks[i][2] + z;
    const nVoxel = simulation.nDataCursor.getVoxel(nx, ny, nz);
    if (!nVoxel || !(nVoxel.isSameVoxel(voxel) || nVoxel.isAir())) continue;
    if (nVoxel.getLevelState() == 2) continue;

    const targetLevel = nVoxel.isAir() ? 0 : nVoxel.getLevel();
    const targetHead = getHydraulicHead(targetLevel, y);
    if (sourceHead <= targetHead) continue;

    targets.push({ x: nx, y: ny, z: nz, level: targetLevel, order: offset });
  }

  targets.sort((a, b) => {
    const diffA = sourceHead - getHydraulicHead(a.level, y);
    const diffB = sourceHead - getHydraulicHead(b.level, y);
    if (diffB !== diffA) return diffB - diffA;
    return a.order - b.order;
  });

  return targets;
}

function getDiagonalFlowTargets(
  simulation: DimensionSimulation,
  voxel: VoxelCursorInterface,
  x: number,
  y: number,
  z: number,
  currentLevel: number,
) {
  if (y <= 0 || currentLevel <= 1) return [];

  const sourceHead = getHydraulicHead(currentLevel, y);
  const targets: DiagonalFlowTarget[] = [];
  const rotation = Math.abs((x * 7349) ^ (y * 9151) ^ (z * 5381)) % 4;

  for (let offset = 0; offset < floodOutChecks.length; offset++) {
    const i = (rotation + offset) % floodOutChecks.length;
    const nx = floodOutChecks[i][0] + x;
    const nz = floodOutChecks[i][2] + z;
    const sideVoxel = simulation.nDataCursor.getVoxel(nx, y, nz);
    if (!sideVoxel || (!sideVoxel.isAir() && !sideVoxel.isSameVoxel(voxel))) {
      continue;
    }

    const diagonalVoxel = simulation.nDataCursor.getVoxel(nx, y - 1, nz);
    if (!diagonalVoxel) continue;
    if (!(diagonalVoxel.isAir() || diagonalVoxel.isSameVoxel(voxel))) continue;
    if (diagonalVoxel.getLevelState() == 2) continue;

    const targetLevel = diagonalVoxel.isAir() ? 0 : diagonalVoxel.getLevel();
    const targetHead = getHydraulicHead(targetLevel, y - 1);
    if (sourceHead <= targetHead) continue;

    targets.push({
      x: nx,
      y: y - 1,
      z: nz,
      level: targetLevel,
      sideIsAir: sideVoxel.isAir(),
      order: offset,
    });
  }

  targets.sort((a, b) => {
    if (a.sideIsAir !== b.sideIsAir) return a.sideIsAir ? -1 : 1;
    const diffA = sourceHead - getHydraulicHead(a.level, a.y);
    const diffB = sourceHead - getHydraulicHead(b.level, b.y);
    if (diffB !== diffA) return diffB - diffA;
    return a.order - b.order;
  });

  return targets;
}

function determineLiquidLevel(
  simulation: DimensionSimulation,
  sourceVoxel: VoxelCursorInterface,
  x: number,
  y: number,
  z: number
) {
  const originalLevel = sourceVoxel.getLevel();
  const upVoxel = simulation.nDataCursor.getVoxel(x, y + 1, z);

  if (!upVoxel || !upVoxel.isSameVoxel(sourceVoxel)) {
    const downVoxel = simulation.nDataCursor.getVoxel(x, y - 1, z);
    let hasHorizontalSupport = false;
    for (let i = 0; i < floodOutChecks.length; i++) {
      const nx = x + floodOutChecks[i][0];
      const nz = z + floodOutChecks[i][2];
      const horizontalVoxel = simulation.nDataCursor.getVoxel(nx, y, nz);
      if (horizontalVoxel && horizontalVoxel.isSameVoxel(sourceVoxel)) {
        hasHorizontalSupport = true;
        break;
      }
    }

    // Any lone liquid cap sitting one voxel above the same body should
    // collapse back into the mass instead of persisting as a raised mound.
    if (downVoxel && downVoxel.isSameVoxel(sourceVoxel) && !hasHorizontalSupport) {
      return Math.max(0, originalLevel - 1);
    }
  }

  if (sourceVoxel.getLevelState() == 1) {
    if (!upVoxel || !upVoxel.isSameVoxel(sourceVoxel)) {
      return originalLevel;
    }
    return 7;
  }

  return originalLevel;
}

function hasTerraceHoldCandidate(
  simulation: DimensionSimulation,
  voxel: VoxelCursorInterface,
  x: number,
  y: number,
  z: number,
) {
  if (y <= 0 || voxel.getLevel() <= 1) return false;

  let hasConnectedBody = false;
  let hasLowerPocket = false;

  for (let i = 0; i < floodOutChecks.length; i++) {
    const nx = x + floodOutChecks[i][0];
    const nz = z + floodOutChecks[i][2];
    const sideVoxel = simulation.nDataCursor.getVoxel(nx, y, nz);
    if (sideVoxel?.isSameVoxel(voxel)) {
      hasConnectedBody = true;
    }

    const diagonalVoxel = simulation.nDataCursor.getVoxel(nx, y - 1, nz);
    if (!diagonalVoxel) continue;
    if (diagonalVoxel.isAir() || diagonalVoxel.isSameVoxel(voxel)) {
      hasLowerPocket = true;
    }
  }

  return hasConnectedBody && hasLowerPocket;
}

VoxelTickUpdateRegister.registerType({
  type: "dve_liquid",
  run(simulation, voxel, update) {
    if (!EngineSettings.doFlow) return;
    recordHydrologyLiquidRun();
    const { x, y, z } = update;
    const liquidUpdateRate = 3;

    let activeVoxel = voxel;
    let currentLevel = activeVoxel.getLevel();
    const levelState = voxel.getLevelState();
    if (levelState == 1 && currentLevel < 7) {
      // Only auto-fill if there's a same liquid source directly above (waterfall column)
      const upVoxel = simulation.nDataCursor.getVoxel(x, y + 1, z);
      if (upVoxel && upVoxel.isSameVoxel(voxel)) {
        voxel.setLevel(7);
        voxel.updateVoxel(0);
        simulation.scheduleUpdate("dve_liquid", x, y, z, liquidUpdateRate);
        simulation.bounds.updateDisplay(x, y, z);
        return;
      }
      // No source above — convert to still water, let normal drain logic handle it
      voxel.setLevelState(0);
      voxel.updateVoxel(0);
    }
    if (levelState == 2) {
      voxel.setLevelState(0);
      voxel.updateVoxel(0);
      for (let i = 0; i < CardinalNeighbors3D.length; i++) {
        const nx = x + CardinalNeighbors3D[i][0];
        const ny = y + CardinalNeighbors3D[i][1];
        const nz = z + CardinalNeighbors3D[i][2];
        const voxel = simulation.nDataCursor.getVoxel(nx, ny, nz);
        if (!voxel || !voxel.substanceTags["dve_is_liquid"]) continue;
        simulation.scheduleUpdate("dve_liquid", nx, ny, nz, 0);
      }
      return;
    }
    if (currentLevel == 0) {
      const downVoxel = simulation.nDataCursor.getVoxel(x, y - 1, z);
      if (
        downVoxel &&
        downVoxel.isSameVoxel(voxel) &&
        downVoxel.getLevelState() == 1
      ) {
        simulation.scheduleUpdate("dve_liquid", x, y - 1, z, liquidUpdateRate);
      }

      simulation.brush.setXYZ(x, y, z).erase();
      simulation.bounds.updateDisplay(x, y, z);
      for (let i = 0; i < CardinalNeighbors3D.length; i++) {
        const nx = x + CardinalNeighbors3D[i][0];
        const ny = y + CardinalNeighbors3D[i][1];
        const nz = z + CardinalNeighbors3D[i][2];
        const voxel = simulation.nDataCursor.getVoxel(nx, ny, nz);
        voxel?.updateVoxel(2);
      }
      return;
    }

    const finalLevel = determineLiquidLevel(simulation, activeVoxel, x, y, z);

    if (currentLevel !== finalLevel) {
      voxel.setLevel(finalLevel);
      voxel.updateVoxel(0);
      currentLevel = finalLevel;
      simulation.scheduleUpdate("dve_liquid", x, y, z, liquidUpdateRate);
      simulation.bounds.updateDisplay(x, y, z);
      if (currentLevel <= 0) {
        return;
      }
    }

    const downVoxel = simulation.nDataCursor.getVoxel(x, y - 1, z);
    const below = simulation.tickCursor[VoxelFaces.Down].getVoxel(x, y - 2, z);
    const isSame = downVoxel && downVoxel.isSameVoxel(activeVoxel);
    if (downVoxel && (downVoxel.isAir() || isSame)) {
      let addToTick = false;
      if (downVoxel.isAir()) {
        simulation.brush
          .setXYZ(x, y - 1, z)
          .setId(activeVoxel.getStringId())
          .setLevel((!below?.isAir() && !below?.isSameVoxel(voxel)) ? 7 : 0)
          .setLevelState((below?.isAir()||below?.isSameVoxel(voxel)) ? 1 : 0)
          .paint()
          .clear();
        addToTick = true;
      } else if (isSame) {
        const nextLevel = Math.min(7, downVoxel.getLevel() + 1);
        if (
          downVoxel.getLevel() !== nextLevel ||
          downVoxel.getLevelState() !== 0
        ) {
          downVoxel.setLevel(nextLevel);
          downVoxel.setLevelState(0);
          downVoxel.updateVoxel(0);
          addToTick = true;
        }
      }

      if (addToTick) {
        simulation.bounds.updateDisplay(x, y - 1, z);
        simulation.scheduleUpdate("dve_liquid", x, y - 1, z, liquidUpdateRate);
        // Re-acquire source cursor — brush.paint() moved the shared cursor via onPaint callback
        const sourceVoxel = simulation.getVoxelForUpdate(x, y, z);
        if (!sourceVoxel) return;
        // Drain source after donating downward — finite volume conservation
        const srcLevel = currentLevel - 1;
        sourceVoxel.setLevel(srcLevel);
        sourceVoxel.setLevelState(0);
        sourceVoxel.updateVoxel(0);
        simulation.bounds.updateDisplay(x, y, z);
        simulation.scheduleUpdate("dve_liquid", x, y, z, liquidUpdateRate);
        // Schedule horizontal neighbours so the wider body can cascade-refill this cell
        for (let i = 0; i < 4; i++) {
          const nx2 = floodOutChecks[i][0] + x;
          const nz2 = floodOutChecks[i][2] + z;
          const nv2 = simulation.nDataCursor.getVoxel(nx2, y, nz2);
          if (nv2 && nv2.isSameVoxel(activeVoxel)) {
            simulation.scheduleUpdate("dve_liquid", nx2, y, nz2, liquidUpdateRate);
          }
        }
        return;
      }
      // isSame below but nothing to do — fall through to horizontal spread
    }

    const diagonalTargets = getDiagonalFlowTargets(
      simulation,
      activeVoxel,
      x,
      y,
      z,
      currentLevel,
    );

    if (diagonalTargets.length) {
      const target = diagonalTargets[0];
      const diagonalVoxel = simulation.nDataCursor.getVoxel(target.x, target.y, target.z);
      if (diagonalVoxel) {
        let moved = false;
        if (diagonalVoxel.isAir()) {
          const belowDiagonal = simulation.nDataCursor.getVoxel(target.x, target.y - 1, target.z);
          simulation.brush
            .setXYZ(target.x, target.y, target.z)
            .setId(activeVoxel.getStringId())
            .setLevel((!belowDiagonal?.isAir() && !belowDiagonal?.isSameVoxel(voxel)) ? 7 : 0)
            .setLevelState((belowDiagonal?.isAir() || belowDiagonal?.isSameVoxel(voxel)) ? 1 : 0)
            .paint()
            .clear();
          moved = true;
        } else if (diagonalVoxel.isSameVoxel(activeVoxel)) {
          const nextLevel = Math.min(7, diagonalVoxel.getLevel() + 1);
          if (
            diagonalVoxel.getLevel() !== nextLevel ||
            diagonalVoxel.getLevelState() !== 0
          ) {
            diagonalVoxel.setLevel(nextLevel);
            diagonalVoxel.setLevelState(0);
            diagonalVoxel.updateVoxel(0);
            moved = true;
          }
        }

        if (moved) {
          recordHydrologyDiagonalSpill();
          simulation.bounds.updateDisplay(target.x, target.y, target.z);
          simulation.scheduleUpdate(
            "dve_liquid",
            target.x,
            target.y,
            target.z,
            liquidUpdateRate,
          );

          if (levelState !== 1) {
            const sourceVoxel = simulation.getVoxelForUpdate(x, y, z);
            if (!sourceVoxel) return;
            const srcLevel = currentLevel - 1;
            sourceVoxel.setLevel(srcLevel);
            sourceVoxel.setLevelState(0);
            sourceVoxel.updateVoxel(0);
            simulation.bounds.updateDisplay(x, y, z);
            activeVoxel = sourceVoxel;
            currentLevel = srcLevel;
          } else {
            const sourceVoxel = simulation.getVoxelForUpdate(x, y, z);
            if (!sourceVoxel) return;
            sourceVoxel.setLevelState(1);
            sourceVoxel.updateVoxel(0);
            simulation.bounds.updateDisplay(x, y, z);
            activeVoxel = sourceVoxel;
            currentLevel = sourceVoxel.getLevel();
          }

          simulation.scheduleUpdate("dve_liquid", x, y, z, liquidUpdateRate);

          for (let i = 0; i < floodOutChecks.length; i++) {
            const nx2 = floodOutChecks[i][0] + x;
            const nz2 = floodOutChecks[i][2] + z;
            const nv2 = simulation.nDataCursor.getVoxel(nx2, y, nz2);
            if (nv2 && nv2.isSameVoxel(activeVoxel)) {
              simulation.scheduleUpdate("dve_liquid", nx2, y, nz2, liquidUpdateRate);
            }
          }
          if (currentLevel <= 0) {
            simulation.brush.clear();
            return;
          }
        }
      }
    }

    // Source blocks (levelState === 1) are infinite: spread to all eligible neighbours
    // simultaneously without draining so water propagates outward like a real source.
    if (levelState === 1) {
      let didSpread = false;
      for (let i = 0; i < 4; i++) {
        const nx2 = x + floodOutChecks[i][0];
        const nz2 = z + floodOutChecks[i][2];
        const nv2 = simulation.nDataCursor.getVoxel(nx2, y, nz2);
        if (!nv2 || !(nv2.isSameVoxel(activeVoxel) || nv2.isAir())) continue;
        if (nv2.getLevelState() === 2) continue;
        if (nv2.getLevel() + 1 >= currentLevel) continue;
        simulation.brush
          .setId(activeVoxel.getStringId())
          .setXYZ(nx2, y, nz2)
          .setLevel(currentLevel - 1)
          .setLevelState(0)
          .paint();
        simulation.bounds.updateDisplay(nx2, y, nz2);
        simulation.scheduleUpdate("dve_liquid", nx2, y, nz2, liquidUpdateRate);
        didSpread = true;
      }
      if (didSpread) {
        // Re-acquire and restore source — brush.paint() moved the shared cursor
        const srcVoxel = simulation.getVoxelForUpdate(x, y, z);
        if (!srcVoxel) return;
        srcVoxel.setLevelState(1);
        srcVoxel.updateVoxel(0);
        simulation.bounds.updateDisplay(x, y, z);
      }
      simulation.scheduleUpdate("dve_liquid", x, y, z, liquidUpdateRate);
      simulation.brush.clear();
      return;
    }

    const lateralTargets = getLateralFlowTargets(
      simulation,
      activeVoxel,
      x,
      y,
      z,
      currentLevel,
    );

    if (lateralTargets.length) {
      const totalLateralMass = lateralTargets.reduce(
        (sum, target) => sum + target.level,
        currentLevel,
      );
      const participantCount = lateralTargets.length + 1;
      const baseLevel = Math.floor(totalLateralMass / participantCount);
      let remainder = totalLateralMass % participantCount;
      const appliedTargets: LateralFlowTarget[] = [];
      const hasAirTarget = lateralTargets.some((target) => target.level === 0);
      let sourceGoal = baseLevel;

      // Keep the first extra unit in the current voxel to avoid the remainder
      // bouncing between equally-valid neighbours and producing visible convulsions.
      // But if the liquid is opening into air, giving the extra to the source makes
      // the edge look sticky/viscous, so let the open targets absorb it instead.
      if (remainder > 0 && !hasAirTarget) {
        sourceGoal += 1;
        remainder -= 1;
      }

      for (let i = 0; i < lateralTargets.length; i++) {
        const target = lateralTargets[i];
        const targetGoal = baseLevel + (remainder > 0 ? 1 : 0);
        if (remainder > 0) {
          remainder--;
        }

        const nextTargetLevel = targetGoal;

        if (nextTargetLevel === target.level) {
          target.level = nextTargetLevel;
          continue;
        }

        simulation.brush
          .setId(activeVoxel.getStringId())
          .setXYZ(target.x, target.y, target.z)
          .setLevel(nextTargetLevel)
          .setLevelState(0)
          .paint();
        simulation.bounds.updateDisplay(target.x, target.y, target.z);
        simulation.scheduleUpdate(
          "dve_liquid",
          target.x,
          target.y,
          target.z,
          liquidUpdateRate,
        );
        target.level = nextTargetLevel;
        appliedTargets.push(target);
      }

      const remainingLevel = sourceGoal;

      if (appliedTargets.length || remainingLevel !== currentLevel) {
        recordHydrologyLateralEqualization();
        // Re-acquire source cursor — brush.paint() moved the shared cursor via onPaint callback
        const sourceVoxel = simulation.getVoxelForUpdate(x, y, z);
        if (!sourceVoxel) return;

        sourceVoxel.setLevel(remainingLevel);
        sourceVoxel.setLevelState(0);
        sourceVoxel.updateVoxel(0);
        simulation.bounds.updateDisplay(x, y, z);
        simulation.scheduleUpdate("dve_liquid", x, y, z, liquidUpdateRate);

        // Schedule horizontal neighbours so head-driven redistribution cascades through the body.
        for (let i = 0; i < floodOutChecks.length; i++) {
          const nx2 = floodOutChecks[i][0] + x;
          const nz2 = floodOutChecks[i][2] + z;
          const nv2 = simulation.nDataCursor.getVoxel(nx2, y, nz2);
          if (nv2 && nv2.isSameVoxel(activeVoxel)) {
            simulation.scheduleUpdate("dve_liquid", nx2, y, nz2, liquidUpdateRate);
          }
        }

        for (let i = 0; i < appliedTargets.length; i++) {
          const target = appliedTargets[i];
          for (let k = 0; k < floodOutChecks.length; k++) {
            const nx2 = floodOutChecks[k][0] + target.x;
            const nz2 = floodOutChecks[k][2] + target.z;
            const nv2 = simulation.nDataCursor.getVoxel(nx2, target.y, nz2);
            if (nv2 && nv2.substanceTags["dve_is_liquid"]) {
              simulation.scheduleUpdate(
                "dve_liquid",
                nx2,
                target.y,
                nz2,
                liquidUpdateRate,
              );
            }
          }
        }
        return;
      }
    }

    if (hasTerraceHoldCandidate(simulation, activeVoxel, x, y, z)) {
      recordHydrologyTerraceHoldCandidate();
    }
    simulation.brush.clear();
  },
});
