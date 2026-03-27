import { VoxelTagIds } from "../../Voxels/Data/VoxelTag.types";
import { VoxelTagsRegister } from "../../Voxels/Data/VoxelTagsRegister";
import { WaterSectionGrid, WaterColumnSample } from "../Types/WaterTypes";
import { WaterPorosityClass } from "../Types/WaterRenderState.types";

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function getVoxelPorosity(voxelId: number) {
  const tags = VoxelTagsRegister.VoxelTags[voxelId];
  return clamp01((tags?.[VoxelTagIds.porosity] as number) ?? 0);
}

function getPorosityClass(porosity: number): WaterPorosityClass {
  if (porosity >= 0.66) return "high";
  if (porosity >= 0.33) return "medium";
  if (porosity > 0.01) return "low";
  return "unknown";
}

function getPorosityRetention(porosityClass: WaterPorosityClass) {
  switch (porosityClass) {
    case "high":
      return 0.84;
    case "medium":
      return 0.66;
    case "low":
      return 0.44;
    default:
      return 0.32;
  }
}

function computeDirectContact(column: WaterColumnSample) {
  const renderState = column.renderState;
  const edgeState = renderState.edgeState;
  const shoreContact =
    column.shoreDistance >= 0 ? clamp01(1 - column.shoreDistance / 3.5) : 0;
  const splashContact = clamp01(edgeState.dropHeight / 1.4);
  const wallContact = clamp01(edgeState.wallContactFactor);

  return clamp01(
    renderState.wetnessPotential * 0.34 +
      edgeState.wetReach * 0.24 +
      shoreContact * 0.18 +
      column.flowStrength * 0.12 +
      splashContact * 0.08 +
      wallContact * 0.04,
  );
}

function computeRetainedMoisture(
  column: WaterColumnSample,
  porosityRetention: number,
) {
  const renderState = column.renderState;
  const edgeState = renderState.edgeState;
  const patchState = renderState.patchState;
  const supportRetention = clamp01(column.supportDepth / 4);
  const shelteredBank = clamp01(edgeState.edgeContinuity * 0.7 + supportRetention * 0.3);
  const bankHold =
    column.shoreDistance >= 0 ? clamp01(1 - column.shoreDistance / 5) : 0;

  return clamp01(
    porosityRetention * 0.42 +
      shelteredBank * 0.22 +
      patchState.shoreInfluence * 0.16 +
      bankHold * 0.12 +
      clamp01(renderState.foamPotential) * 0.08,
  );
}

function applyWetnessToColumn(column: WaterColumnSample) {
  const renderState = column.renderState;
  const edgeState = renderState.edgeState;
  const porosity = getVoxelPorosity(column.voxelId);
  const porosityClass = getPorosityClass(porosity);
  const porosityRetention = getPorosityRetention(porosityClass);
  const directContact = computeDirectContact(column);
  const retainedMoisture = computeRetainedMoisture(column, porosityRetention);
  const thicknessFactor = clamp01(renderState.thickness / 2.4);

  const surfaceWetness = clamp01(
    directContact * (0.68 + porosity * 0.22) +
      retainedMoisture * 0.32 +
      thicknessFactor * 0.08,
  );
  const dryingRate = clamp01(
    0.82 - porosityRetention * 0.44 - edgeState.wallContactFactor * 0.12 - thicknessFactor * 0.08,
  );
  const wetnessAge = clamp01(
    (1 - directContact) * (0.22 + dryingRate * 0.48) +
      retainedMoisture * 0.24 +
      (1 - surfaceWetness) * 0.08,
  );
  const wetReach = clamp01(
    surfaceWetness * (0.72 + porosity * 0.2 + edgeState.wallContactFactor * 0.12),
  );

  renderState.surfaceWetness = surfaceWetness;
  renderState.wetnessPotential = clamp01(
    Math.max(renderState.wetnessPotential, directContact * 0.74 + retainedMoisture * 0.26),
  );
  renderState.wetnessAge = wetnessAge;
  renderState.dryingRate = dryingRate;
  renderState.porosityClass = porosityClass;
  edgeState.wetReach = Math.max(edgeState.wetReach, wetReach);
}

export function buildWaterWetnessField(grid: WaterSectionGrid) {
  for (const column of grid.columns) {
    if (!column.filled) continue;
    applyWetnessToColumn(column);
  }

  for (let lx = -grid.paddedRadius; lx <= grid.boundsX + grid.paddedRadius - 1; lx++) {
    for (let lz = -grid.paddedRadius; lz <= grid.boundsZ + grid.paddedRadius - 1; lz++) {
      if (lx >= 0 && lx < grid.boundsX && lz >= 0 && lz < grid.boundsZ) {
        continue;
      }

      const column = grid.paddedColumns[
        (lx + grid.paddedRadius) * grid.paddedBoundsZ + (lz + grid.paddedRadius)
      ];
      if (!column?.filled) continue;
      applyWetnessToColumn(column);
    }
  }
}