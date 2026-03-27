import { WaterColumnSample, WaterSectionGrid } from "../Types/WaterTypes";

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function getWaterBodyEvaporationScale(column: WaterColumnSample) {
  switch (column.waterClass) {
    case "sea":
      return 0.96;
    case "river":
      return 0.78;
    default:
      return 0.64;
  }
}

function computeOpenWaterEvaporation(column: WaterColumnSample) {
  const renderState = column.renderState;
  const patchState = renderState.patchState;
  const openness =
    column.shoreDistance >= 0 ? clamp01(column.shoreDistance / 5) : 1;
  const exposure = clamp01(
    openness * 0.52 +
      (1 - patchState.shoreInfluence) * 0.28 +
      column.flowStrength * 0.12 +
      renderState.thickness * 0.05,
  );
  return clamp01(exposure * getWaterBodyEvaporationScale(column));
}

function computeDrainage(column: WaterColumnSample) {
  const renderState = column.renderState;
  const edgeState = renderState.edgeState;
  const slopeRelease = renderState.bankSlope;
  const shallowRelease = clamp01(1 - Math.min(column.supportDepth, 4) / 4);
  const edgeRelease = clamp01(edgeState.edgeWaveDamping * 0.45 + edgeState.wallContactFactor * 0.2);
  return clamp01(slopeRelease * 0.56 + shallowRelease * 0.24 + edgeRelease * 0.2);
}

function computeSoilEvaporation(column: WaterColumnSample, openWaterEvaporation: number, drainage: number) {
  const renderState = column.renderState;
  return clamp01(
    renderState.surfaceWetness * (0.34 + renderState.dryingRate * 0.28) +
      openWaterEvaporation * 0.18 +
      drainage * 0.22,
  );
}

function computeTranspirationPlaceholder(column: WaterColumnSample, drainage: number) {
  const renderState = column.renderState;
  const patchState = renderState.patchState;
  const porosityBoost =
    renderState.porosityClass === "high"
      ? 0.28
      : renderState.porosityClass === "medium"
        ? 0.18
        : renderState.porosityClass === "low"
          ? 0.08
          : 0.04;

  return clamp01(
    renderState.surfaceWetness * 0.22 +
      patchState.shoreInfluence * 0.24 +
      porosityBoost -
      drainage * 0.16,
  );
}

function computeFlowAccumulation(column: WaterColumnSample) {
  const renderState = column.renderState;
  const patchState = renderState.patchState;
  return clamp01(
    column.flowStrength * 0.48 +
      patchState.meanFlow * 0.28 +
      renderState.thickness * 0.08 +
      renderState.turbulence * 0.12 +
      renderState.edgeState.interactionInfluence * 0.08,
  );
}

function computeErosionPotential(
  column: WaterColumnSample,
  flowAccumulation: number,
  drainage: number,
) {
  const renderState = column.renderState;
  const edgeState = renderState.edgeState;
  return clamp01(
    flowAccumulation * 0.34 +
      renderState.turbulence * 0.24 +
      renderState.bankSlope * 0.2 +
      clamp01(edgeState.dropHeight / 1.4) * 0.16 +
      drainage * 0.06,
  );
}

function computeDepositionPotential(
  column: WaterColumnSample,
  drainage: number,
  flowAccumulation: number,
) {
  const renderState = column.renderState;
  return clamp01(
    renderState.surfaceWetness * 0.26 +
      renderState.thickness * 0.18 +
      (1 - renderState.bankSlope) * 0.14 +
      (1 - renderState.turbulence) * 0.16 +
      (1 - drainage) * 0.16 +
      (1 - flowAccumulation) * 0.1,
  );
}

function applyEcologyToColumn(column: WaterColumnSample) {
  const renderState = column.renderState;
  const edgeState = renderState.edgeState;
  const openWaterEvaporation = computeOpenWaterEvaporation(column);
  const drainage = computeDrainage(column);
  const soilEvaporation = computeSoilEvaporation(column, openWaterEvaporation, drainage);
  const transpirationPotential = computeTranspirationPlaceholder(column, drainage);
  const flowAccumulation = computeFlowAccumulation(column);
  const erosionPotential = computeErosionPotential(column, flowAccumulation, drainage);
  const depositionPotential = computeDepositionPotential(column, drainage, flowAccumulation);
  const turbidity = clamp01(
    erosionPotential * 0.72 + flowAccumulation * 0.2 - depositionPotential * 0.18,
  );

  renderState.openWaterEvaporation = openWaterEvaporation;
  renderState.soilEvaporation = soilEvaporation;
  renderState.drainage = drainage;
  renderState.transpirationPotential = transpirationPotential;
  renderState.flowAccumulation = flowAccumulation;
  renderState.erosionPotential = erosionPotential;
  renderState.depositionPotential = depositionPotential;
  renderState.turbidity = turbidity;

  renderState.wetnessPotential = clamp01(
    Math.max(
      renderState.wetnessPotential,
      renderState.surfaceWetness * 0.44 +
        soilEvaporation * 0.2 +
        transpirationPotential * 0.1 +
        depositionPotential * 0.08,
    ),
  );

  const ecologyFoamBoost = clamp01(
    erosionPotential * 0.34 + turbidity * 0.18 + flowAccumulation * 0.12,
  );
  renderState.foamPotential = clamp01(Math.max(renderState.foamPotential, ecologyFoamBoost));
  renderState.foamClassMask.edge = clamp01(
    Math.max(renderState.foamClassMask.edge, ecologyFoamBoost * 0.92),
  );
  renderState.foamClassMask.impact = clamp01(
    Math.max(renderState.foamClassMask.impact, turbidity * 0.38 + erosionPotential * 0.18),
  );
  edgeState.edgeFoamPotential = clamp01(
    Math.max(edgeState.edgeFoamPotential, ecologyFoamBoost * 0.9 + turbidity * 0.08),
  );
}

export function buildWaterEcologyField(grid: WaterSectionGrid) {
  for (const column of grid.columns) {
    if (!column.filled) continue;
    applyEcologyToColumn(column);
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
      applyEcologyToColumn(column);
    }
  }
}