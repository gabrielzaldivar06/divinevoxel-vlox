import { WaterSectionGrid, WaterColumnSample } from "../Types/WaterTypes";

const DEFAULT_INTERACTION_FIELD_SIZE = 8;

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function ensureField(grid: WaterSectionGrid) {
  const fieldSize = grid.interactionFieldSize || DEFAULT_INTERACTION_FIELD_SIZE;
  const requiredSize = fieldSize * fieldSize;
  if (grid.interactionField.length !== requiredSize) {
    grid.interactionField = new Float32Array(requiredSize);
  } else {
    grid.interactionField.fill(0);
  }
  grid.interactionFieldSize = fieldSize;
}

function addFieldImpulse(
  grid: WaterSectionGrid,
  centerX: number,
  centerZ: number,
  radius: number,
  intensity: number,
  directionX = 0,
  directionZ = 0,
) {
  const field = grid.interactionField;
  const size = grid.interactionFieldSize;
  const cellScaleX = size / Math.max(grid.boundsX, 1);
  const cellScaleZ = size / Math.max(grid.boundsZ, 1);
  const fieldCenterX = centerX * cellScaleX;
  const fieldCenterZ = centerZ * cellScaleZ;
  const fieldRadius = Math.max(0.75, radius * ((cellScaleX + cellScaleZ) * 0.5));
  const anisotropy = Math.hypot(directionX, directionZ) > 0.0001 ? 0.24 : 0;

  for (let fx = 0; fx < size; fx++) {
    for (let fz = 0; fz < size; fz++) {
      const dx = fx + 0.5 - fieldCenterX;
      const dz = fz + 0.5 - fieldCenterZ;
      const radialDistance = Math.hypot(dx, dz);
      if (radialDistance > fieldRadius) continue;

      const directionalBias =
        anisotropy > 0
          ? ((dx * directionX + dz * directionZ) / Math.max(fieldRadius, 0.0001)) * anisotropy
          : 0;
      const falloff = clamp01(1 - radialDistance / Math.max(fieldRadius, 0.0001));
      const ripple = 0.72 + Math.sin((dx + dz) * 1.2) * 0.12 + directionalBias;
      const nextValue = field[fx * size + fz] + intensity * falloff * ripple;
      field[fx * size + fz] = clamp01(nextValue);
    }
  }
}

function emitStepImpactEvent(grid: WaterSectionGrid, column: WaterColumnSample, lx: number, lz: number) {
  const renderState = column.renderState;
  const edgeState = renderState.edgeState;
  const shoreFactor = column.shoreDistance >= 0 ? clamp01(1 - column.shoreDistance / 3) : 0;
  const impactEnergy = clamp01(
    renderState.turbulence * 0.42 +
      column.flowStrength * 0.28 +
      shoreFactor * 0.22 +
      (edgeState.edgeType === "thinChannel" ? 0.2 : 0) +
      (edgeState.edgeType === "shore" ? 0.08 : 0),
  );
  if (impactEnergy < 0.16) return;

  addFieldImpulse(
    grid,
    lx + 0.5,
    lz + 0.5,
    0.85 + impactEnergy * 0.8,
    impactEnergy,
    column.flowX,
    column.flowZ,
  );
}

function emitShorelineBreakEvent(grid: WaterSectionGrid, column: WaterColumnSample, lx: number, lz: number) {
  const renderState = column.renderState;
  const edgeState = renderState.edgeState;
  if (edgeState.edgeType !== "shore" && edgeState.edgeType !== "thinChannel") return;

  const guidanceMagnitude = Math.hypot(edgeState.shorelineGuidanceX, edgeState.shorelineGuidanceZ);
  const shorelineEnergy = clamp01(
    renderState.foamClassMask.edge * 0.42 +
      renderState.turbulence * 0.22 +
      column.flowStrength * 0.18 +
      guidanceMagnitude * 0.18,
  );
  if (shorelineEnergy < 0.14) return;

  const dirX = guidanceMagnitude > 0.0001 ? edgeState.shorelineGuidanceX / guidanceMagnitude : column.flowX;
  const dirZ = guidanceMagnitude > 0.0001 ? edgeState.shorelineGuidanceZ / guidanceMagnitude : column.flowZ;
  const breakOffset = 0.42 + shorelineEnergy * 0.6;
  addFieldImpulse(
    grid,
    lx + 0.5 + dirX * breakOffset,
    lz + 0.5 + dirZ * breakOffset,
    0.9 + shorelineEnergy * 0.9,
    shorelineEnergy,
    dirX,
    dirZ,
  );
}

function emitActorImpactEvent(grid: WaterSectionGrid, column: WaterColumnSample, lx: number, lz: number) {
  const renderState = column.renderState;
  const edgeState = renderState.edgeState;
  const impactEnergy = clamp01(
    renderState.foamClassMask.impact * 0.58 +
      edgeState.dropHeight * 0.18 +
      renderState.turbulence * 0.12 +
      column.flowStrength * 0.08,
  );
  if (impactEnergy < 0.12) return;

  const dirX = Math.abs(column.flowX) > 0.0001 ? column.flowX : edgeState.shorelineGuidanceX;
  const dirZ = Math.abs(column.flowZ) > 0.0001 ? column.flowZ : edgeState.shorelineGuidanceZ;
  addFieldImpulse(
    grid,
    lx + 0.5,
    lz + 0.5,
    0.72 + impactEnergy * 0.82,
    impactEnergy,
    dirX,
    dirZ,
  );
}

function emitWaterfallLandingEvent(grid: WaterSectionGrid, column: WaterColumnSample, lx: number, lz: number) {
  const edgeState = column.renderState.edgeState;
  if (edgeState.edgeType !== "drop") return;

  const dropEnergy = clamp01(edgeState.dropHeight / 1.5 + column.flowStrength * 0.2);
  if (dropEnergy < 0.16) return;

  const dirX = edgeState.shorelineGuidanceX;
  const dirZ = edgeState.shorelineGuidanceZ;
  const landingDistance = 0.85 + dropEnergy * 1.2;
  addFieldImpulse(
    grid,
    lx + 0.5 + dirX * landingDistance,
    lz + 0.5 + dirZ * landingDistance,
    1.05 + dropEnergy,
    clamp01(dropEnergy * 1.1),
    dirX,
    dirZ,
  );
  addFieldImpulse(
    grid,
    lx + 0.5,
    lz + 0.5,
    0.7 + dropEnergy * 0.4,
    dropEnergy * 0.35,
    dirX,
    dirZ,
  );
}

function blurInteractionField(grid: WaterSectionGrid) {
  const size = grid.interactionFieldSize;
  const source = grid.interactionField;
  const next = new Float32Array(source.length);

  for (let fx = 0; fx < size; fx++) {
    for (let fz = 0; fz < size; fz++) {
      let total = 0;
      let weight = 0;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const sx = fx + dx;
          const sz = fz + dz;
          if (sx < 0 || sx >= size || sz < 0 || sz >= size) continue;
          const sampleWeight = dx === 0 && dz === 0 ? 0.4 : Math.abs(dx) + Math.abs(dz) === 1 ? 0.12 : 0.06;
          total += source[sx * size + sz] * sampleWeight;
          weight += sampleWeight;
        }
      }
      next[fx * size + fz] = weight > 0 ? total / weight : 0;
    }
  }

  grid.interactionField = next;
}

function sampleInteractionField(grid: WaterSectionGrid, sampleX: number, sampleZ: number) {
  const size = grid.interactionFieldSize;
  const field = grid.interactionField;
  const fx = clamp01(sampleX / Math.max(grid.boundsX, 1)) * (size - 1);
  const fz = clamp01(sampleZ / Math.max(grid.boundsZ, 1)) * (size - 1);
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const x1 = Math.min(size - 1, x0 + 1);
  const z1 = Math.min(size - 1, z0 + 1);
  const tx = fx - x0;
  const tz = fz - z0;
  const v00 = field[x0 * size + z0];
  const v10 = field[x1 * size + z0];
  const v01 = field[x0 * size + z1];
  const v11 = field[x1 * size + z1];
  const north = v00 + (v10 - v00) * tx;
  const south = v01 + (v11 - v01) * tx;
  return clamp01(north + (south - north) * tz);
}

export function buildWaterInteractionField(grid: WaterSectionGrid) {
  ensureField(grid);

  const bz = grid.boundsZ;
  for (let lx = 0; lx < grid.boundsX; lx++) {
    for (let lz = 0; lz < grid.boundsZ; lz++) {
      const column = grid.columns[lx * bz + lz];
      if (!column.filled) continue;
      emitStepImpactEvent(grid, column, lx, lz);
      emitShorelineBreakEvent(grid, column, lx, lz);
      emitActorImpactEvent(grid, column, lx, lz);
      emitWaterfallLandingEvent(grid, column, lx, lz);
    }
  }

  blurInteractionField(grid);

  for (let lx = 0; lx < grid.boundsX; lx++) {
    for (let lz = 0; lz < grid.boundsZ; lz++) {
      const column = grid.columns[lx * bz + lz];
      if (!column.filled) continue;
      column.renderState.edgeState.interactionInfluence = sampleInteractionField(
        grid,
        lx + 0.5,
        lz + 0.5,
      );
    }
  }
}