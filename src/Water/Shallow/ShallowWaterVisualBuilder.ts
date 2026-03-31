import { DEFAULT_SHALLOW_WATER_CONFIG } from "./ShallowWaterTypes";
import type {
  ShallowColumnState,
  ShallowEdgeFieldSectionRenderData,
  ShallowFilmSectionRenderData,
  ShallowWaterPatchColumnMetrics,
  ShallowRenderSectionSnapshot,
  ShallowVisualColumnState,
  ShallowWaterSectionGrid,
} from "./ShallowWaterTypes";
import type { ShallowGhostColumnSet } from "./ShallowBoundaryFluxRegistry.js";
import { buildShallowWaterPatchMetrics } from "./ShallowWaterPatchMetrics";

const SHORE_DISTANCE_MAX = 4;
const MIN_FILM_THICKNESS = 0.006;
const MAX_FILM_THICKNESS = 0.085;
const MIN_VISUAL_COVERAGE = 0.12;
const MAX_STABLE_FOAM = 0.52;
const MAX_STABLE_RIPPLE = 0.46;

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function lerp(start: number, end: number, alpha: number) {
  return start + (end - start) * alpha;
}

function makeEmptyVisualColumn(): ShallowVisualColumnState {
  return {
    active: false,
    patchId: -1,
    patchTotalMass: 0,
    patchArea: 0,
    patchActiveArea: 0,
    patchAverageThickness: 0,
    patchMaxThickness: 0,
    patchConnectivity: 0,
    patchCompactness: 0,
    patchBoundaryRatio: 0,
    patchHandoffReady: false,
    localNeighborCount: 0,
    localCore: 0,
    thickness: 0,
    bedY: 0,
    surfaceY: 0,
    visualSurfaceY: 0,
    filmThickness: 0,
    filmOpacity: 0,
    spreadVX: 0,
    spreadVZ: 0,
    flowX: 0,
    flowZ: 0,
    flowSpeed: 0,
    settled: 0,
    adhesion: 0,
    age: 0,
    shoreDist: 0,
    coverage: 0,
    edgeStrength: 0,
    foam: 0,
    wetness: 0,
    breakup: 0,
    microRipple: 0,
    mergeBlend: 0,
    deepBlend: 0,
    handoffBlend: 0,
    emitterId: 0,
    handoffPending: false,
    ownershipDomain: "none",
    authority: "bootstrap",
  };
}

type VisualNeighborhood = {
  totalWeight: number;
  weightedBedY: number;
  weightedCoverage: number;
  weightedWetness: number;
  weightedFoam: number;
  weightedEdge: number;
  weightedRipple: number;
  weightedFlowX: number;
  weightedFlowZ: number;
  weightedFlowSpeed: number;
  weightedMergeBlend: number;
  weightedDeepBlend: number;
  weightedHandoffBlend: number;
  weightedLocalCore: number;
  maxCoverage: number;
  dominantAuthority: ShallowVisualColumnState["authority"];
  dominantEmitterId: number;
};

function makeEmptyEdgeField(
  originX: number,
  originZ: number,
  sizeX: number,
  sizeZ: number,
  previous?: ShallowEdgeFieldSectionRenderData,
): ShallowEdgeFieldSectionRenderData {
  const splats =
    previous &&
    previous.originX === originX &&
    previous.originZ === originZ &&
    previous.sizeX === sizeX &&
    previous.sizeZ === sizeZ
      ? previous.splats
      : [];
  splats.length = 0;
  return {
    originX,
    originZ,
    sizeX,
    sizeZ,
    splats,
    activeSplatCount: 0,
  };
}

function getColumnIndex(sizeX: number, x: number, z: number) {
  return z * sizeX + x;
}

function getVisualColumn(
  columns: ShallowVisualColumnState[],
  sizeX: number,
  sizeZ: number,
  x: number,
  z: number,
) {
  if (x < 0 || z < 0 || x >= sizeX || z >= sizeZ) return null;
  return columns[getColumnIndex(sizeX, x, z)] ?? null;
}

function sampleVisualNeighborhood(
  columns: ShallowVisualColumnState[],
  sizeX: number,
  sizeZ: number,
  x: number,
  z: number,
): VisualNeighborhood {
  const out: VisualNeighborhood = {
    totalWeight: 0,
    weightedBedY: 0,
    weightedCoverage: 0,
    weightedWetness: 0,
    weightedFoam: 0,
    weightedEdge: 0,
    weightedRipple: 0,
    weightedFlowX: 0,
    weightedFlowZ: 0,
    weightedFlowSpeed: 0,
    weightedMergeBlend: 0,
    weightedDeepBlend: 0,
    weightedHandoffBlend: 0,
    weightedLocalCore: 0,
    maxCoverage: 0,
    dominantAuthority: "bootstrap",
    dominantEmitterId: 0,
  };

  let dominantWeight = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const neighbor = getVisualColumn(columns, sizeX, sizeZ, x + dx, z + dz);
      if (!neighbor?.active || neighbor.coverage <= 0) continue;
      const weight =
        (dx === 0 && dz === 0 ? 0.42 : dx === 0 || dz === 0 ? 0.14 : 0.08) *
        Math.max(0.08, neighbor.coverage + neighbor.wetness * 0.25);
      out.totalWeight += weight;
      out.weightedBedY += neighbor.bedY * weight;
      out.weightedCoverage += neighbor.coverage * weight;
      out.weightedWetness += neighbor.wetness * weight;
      out.weightedFoam += neighbor.foam * weight;
      out.weightedEdge += neighbor.edgeStrength * weight;
      out.weightedRipple += neighbor.microRipple * weight;
      out.weightedFlowX += neighbor.flowX * weight;
      out.weightedFlowZ += neighbor.flowZ * weight;
      out.weightedFlowSpeed += neighbor.flowSpeed * weight;
      out.weightedMergeBlend += neighbor.mergeBlend * weight;
      out.weightedDeepBlend += neighbor.deepBlend * weight;
      out.weightedHandoffBlend += neighbor.handoffBlend * weight;
      out.weightedLocalCore += neighbor.localCore * weight;
      out.maxCoverage = Math.max(out.maxCoverage, neighbor.coverage);
      if (weight > dominantWeight) {
        dominantWeight = weight;
        out.dominantAuthority = neighbor.authority;
        out.dominantEmitterId = neighbor.emitterId;
      }
    }
  }

  return out;
}

function getGhostNeighbor(
  ghosts: ShallowGhostColumnSet | null | undefined,
  grid: ShallowWaterSectionGrid,
  x: number,
  z: number,
  dx: number,
  dz: number,
) {
  if (!ghosts) return null;
  if (dx < 0 && x === 0) return ghosts.west[z] ?? null;
  if (dx > 0 && x === grid.sizeX - 1) return ghosts.east[z] ?? null;
  if (dz < 0 && z === 0) return ghosts.north[x] ?? null;
  if (dz > 0 && z === grid.sizeZ - 1) return ghosts.south[x] ?? null;
  return null;
}

function countShallowNeighbors(
  grid: ShallowWaterSectionGrid,
  x: number,
  z: number,
  ghosts?: ShallowGhostColumnSet | null,
) {
  let shallowCount = 0;
  const check = (nx: number, nz: number, dx: number, dz: number) => {
    if (nx < 0 || nz < 0 || nx >= grid.sizeX || nz >= grid.sizeZ) {
      const ghost = getGhostNeighbor(ghosts, grid, x, z, dx, dz);
      if (ghost?.active && ghost.thickness > 0.0001) {
        shallowCount += 1;
      }
      return;
    }
    const neighbor = grid.columns[getColumnIndex(grid.sizeX, nx, nz)];
    if (neighbor.active && neighbor.ownershipDomain === "shallow" && neighbor.thickness > 0) {
      shallowCount += 1;
    }
  };
  check(x - 1, z, -1, 0);
  check(x + 1, z, 1, 0);
  check(x, z - 1, 0, -1);
  check(x, z + 1, 0, 1);
  return shallowCount;
}

function countDiagonalShallowNeighbors(
  grid: ShallowWaterSectionGrid,
  x: number,
  z: number,
) {
  let shallowCount = 0;
  const check = (nx: number, nz: number) => {
    if (nx < 0 || nz < 0 || nx >= grid.sizeX || nz >= grid.sizeZ) {
      return;
    }
    const neighbor = grid.columns[getColumnIndex(grid.sizeX, nx, nz)];
    if (neighbor.active && neighbor.ownershipDomain === "shallow" && neighbor.thickness > 0) {
      shallowCount += 1;
    }
  };
  check(x - 1, z - 1);
  check(x + 1, z - 1);
  check(x - 1, z + 1);
  check(x + 1, z + 1);
  return shallowCount;
}

function computeShoreDist(
  grid: ShallowWaterSectionGrid,
  x: number,
  z: number,
  ghosts?: ShallowGhostColumnSet | null,
) {
  const column = grid.columns[getColumnIndex(grid.sizeX, x, z)];
  if (!column.active || column.ownershipDomain !== "shallow" || column.thickness <= 0) {
    return 0;
  }
  const shallowNeighbors = countShallowNeighbors(grid, x, z, ghosts);
  return clamp(SHORE_DISTANCE_MAX - shallowNeighbors, 0, SHORE_DISTANCE_MAX);
}

function buildVisualColumn(
  grid: ShallowWaterSectionGrid,
  column: ShallowColumnState,
  patch: ShallowWaterPatchColumnMetrics,
  x: number,
  z: number,
  out: ShallowVisualColumnState,
  ghosts?: ShallowGhostColumnSet | null,
) {
  const active = column.active && column.ownershipDomain === "shallow" && column.thickness > 0;
  const bedY = Number.isFinite(column.bedY) ? column.bedY : grid.terrainY;
  const surfaceY = active ? (Number.isFinite(column.surfaceY) ? column.surfaceY : bedY + column.thickness) : bedY;
  const shoreDist = computeShoreDist(grid, x, z, ghosts);
  const diagonalNeighbors = countDiagonalShallowNeighbors(grid, x, z);
  const thickness = active ? Math.max(0, column.thickness) : 0;
  const thickness01 = clamp01(thickness / Math.max(0.0001, DEFAULT_SHALLOW_WATER_CONFIG.handoffThickness));
  const flowVX = active ? column.spreadVX : 0;
  const flowVZ = active ? column.spreadVZ : 0;
  const flowSpeed = Math.hypot(flowVX, flowVZ);
  const flowDenom = Math.max(0.0001, DEFAULT_SHALLOW_WATER_CONFIG.maxSpreadVelocity);
  const flow01 = clamp01(flowSpeed / flowDenom);
  const shore01 = clamp01(shoreDist / SHORE_DISTANCE_MAX);
  const edgeProximity = 1 - shore01;
  const calmness = clamp01(column.settled);
  const motion = clamp01(flow01);
  const thinness = 1 - thickness01;
  const localCore = patch.localCore;
  const diagonalContinuity = clamp01(diagonalNeighbors / 4);
  const coverage = active
    ? clamp01(
        thickness01 * 0.74 +
          patch.mergeBlend * 0.18 +
          patch.deepBlend * 0.08 +
          localCore * 0.06 +
          patch.seamContinuity * 0.04 +
          diagonalContinuity * (0.04 + patch.mergeBlend * 0.02),
      )
    : 0;
  const edgeStrength = active
    ? clamp01(
        (edgeProximity * 0.44 + motion * 0.24 + thinness * 0.18 + (1 - calmness) * 0.14) *
          (1 -
            patch.deepBlend * 0.38 -
            patch.handoffBlend * 0.14 -
            patch.seamContinuity * 0.08 -
            diagonalContinuity * 0.1) +
          patch.mergeBlend * 0.08,
      )
    : 0;
  const foam = active
    ? clamp01(
        edgeStrength *
          (0.3 + motion * 0.36 + patch.handoffBlend * 0.08) *
          (1 - calmness * 0.52),
      )
    : 0;
  const wetness = active
    ? clamp01(
        coverage * (0.38 + calmness * 0.42) +
          patch.mergeBlend * 0.14 +
          patch.deepBlend * 0.12,
      )
    : 0;
  const breakup = active
    ? clamp01(
        (edgeStrength * 0.5 + motion * 0.42) *
          (1 - calmness * 0.46) *
          (1 - patch.deepBlend * 0.4),
      )
    : 0;
  const microRipple = active
    ? clamp01(
        (motion * 0.5 + breakup * 0.32 + patch.mergeBlend * 0.12) *
          (1 - calmness * 0.62),
      )
    : 0;
  const filmThickness = active
    ? clamp(
        MIN_FILM_THICKNESS +
          thickness *
            (0.02 +
              patch.mergeBlend * 0.018 +
              patch.deepBlend * 0.026 +
              patch.handoffBlend * 0.018 +
              patch.seamContinuity * 0.008) +
          coverage * (0.02 + patch.mergeBlend * 0.024 + patch.deepBlend * 0.01) +
          edgeStrength * (0.008 - patch.mergeBlend * 0.003) +
          diagonalContinuity * 0.004,
        MIN_FILM_THICKNESS,
        MAX_FILM_THICKNESS,
      )
    : 0;
  const filmOpacity = active
    ? clamp01(
        0.18 +
          wetness * 0.44 +
          foam * 0.1 +
          patch.mergeBlend * 0.08 +
          patch.deepBlend * 0.14 +
          patch.handoffBlend * 0.08,
      )
    : 0;

  out.active = active;
  out.patchId = patch.patchId;
  out.patchTotalMass = patch.totalMass;
  out.patchArea = patch.area;
  out.patchActiveArea = patch.activeArea;
  out.patchAverageThickness = patch.averageThickness;
  out.patchMaxThickness = patch.maxThickness;
  out.patchConnectivity = patch.connectivity;
  out.patchCompactness = patch.compactness;
  out.patchBoundaryRatio = patch.boundaryRatio;
  out.patchHandoffReady = patch.handoffReady;
  out.localNeighborCount = patch.localNeighborCount;
  out.localCore = patch.localCore;
  out.thickness = thickness;
  out.bedY = bedY;
  out.surfaceY = surfaceY;
  const targetVolumeSurface = active
    ? Math.min(
        surfaceY,
        bedY +
          filmThickness +
          thickness *
            (0.08 +
              patch.mergeBlend * 0.16 +
              patch.deepBlend * 0.22 +
              patch.handoffBlend * 0.12),
      )
    : bedY;
  out.visualSurfaceY = active
    ? lerp(
        bedY + filmThickness,
        targetVolumeSurface,
        clamp01(patch.mergeBlend * 0.34 + patch.deepBlend * 0.42 + patch.handoffBlend * 0.24),
      )
    : bedY;
  out.filmThickness = filmThickness;
  out.filmOpacity = filmOpacity;
  out.spreadVX = flowVX;
  out.spreadVZ = flowVZ;
  out.flowX = flowSpeed > 0 ? flowVX / flowSpeed : 0;
  out.flowZ = flowSpeed > 0 ? flowVZ / flowSpeed : 0;
  out.flowSpeed = flowSpeed;
  out.settled = calmness;
  out.adhesion = active ? clamp01(column.adhesion) : 0;
  out.age = active ? Math.max(0, column.age) : 0;
  out.shoreDist = shoreDist;
  out.coverage = coverage;
  out.edgeStrength = edgeStrength;
  out.foam = foam;
  out.wetness = wetness;
  out.breakup = breakup;
  out.microRipple = microRipple;
  out.mergeBlend = patch.mergeBlend;
  out.deepBlend = patch.deepBlend;
  out.handoffBlend = patch.handoffBlend;
  out.emitterId = active ? Math.max(0, column.emitterId) : 0;
  out.handoffPending = active ? column.handoffPending : false;
  out.ownershipDomain = column.ownershipDomain;
  out.authority = column.authority;
}

/**
 * Build the terrain-conforming film payload for a shallow-water section.
 * The output is stable and reusable across frames when a compatible previous
 * payload is provided.
 */
export function buildShallowWaterFilmSectionRenderData(
  grid: ShallowWaterSectionGrid,
  previous?: ShallowFilmSectionRenderData,
  ghosts?: ShallowGhostColumnSet | null,
): ShallowFilmSectionRenderData {
  const patchMetrics = buildShallowWaterPatchMetrics(grid, undefined, ghosts);
  const count = grid.sizeX * grid.sizeZ;
  const columns =
    previous &&
    previous.originX === grid.originX &&
    previous.originZ === grid.originZ &&
    previous.sizeX === grid.sizeX &&
    previous.sizeZ === grid.sizeZ
      ? previous.columns
      : new Array<ShallowVisualColumnState>(count);

  for (let i = 0; i < count; i++) {
    columns[i] = columns[i] ?? makeEmptyVisualColumn();
  }

  let activeColumnCount = 0;
  for (let z = 0; z < grid.sizeZ; z++) {
    for (let x = 0; x < grid.sizeX; x++) {
      const index = getColumnIndex(grid.sizeX, x, z);
      const out = columns[index];
      buildVisualColumn(
        grid,
        grid.columns[index],
        patchMetrics.columns[index],
        x,
        z,
        out,
        ghosts,
      );
      if (out.active) activeColumnCount += 1;
    }
  }

  for (let z = 0; z < grid.sizeZ; z++) {
    for (let x = 0; x < grid.sizeX; x++) {
      const index = getColumnIndex(grid.sizeX, x, z);
      const column = columns[index];
      const neighborhood = sampleVisualNeighborhood(columns, grid.sizeX, grid.sizeZ, x, z);
      if (neighborhood.totalWeight <= 0.0001) continue;

      const neighborhoodCoverage = clamp01(neighborhood.weightedCoverage / neighborhood.totalWeight);
      const neighborhoodWetness = clamp01(neighborhood.weightedWetness / neighborhood.totalWeight);
      const neighborhoodFoam = clamp01(neighborhood.weightedFoam / neighborhood.totalWeight);
      const neighborhoodEdge = clamp01(neighborhood.weightedEdge / neighborhood.totalWeight);
      const neighborhoodRipple = clamp01(neighborhood.weightedRipple / neighborhood.totalWeight);
      const neighborhoodFlowX = neighborhood.weightedFlowX / neighborhood.totalWeight;
      const neighborhoodFlowZ = neighborhood.weightedFlowZ / neighborhood.totalWeight;
      const neighborhoodFlowSpeed = Math.max(
        0,
        neighborhood.weightedFlowSpeed / neighborhood.totalWeight,
      );
      const neighborhoodMergeBlend = clamp01(
        neighborhood.weightedMergeBlend / neighborhood.totalWeight,
      );
      const neighborhoodDeepBlend = clamp01(
        neighborhood.weightedDeepBlend / neighborhood.totalWeight,
      );
      const neighborhoodHandoffBlend = clamp01(
        neighborhood.weightedHandoffBlend / neighborhood.totalWeight,
      );
      const neighborhoodLocalCore = clamp01(
        neighborhood.weightedLocalCore / neighborhood.totalWeight,
      );
      const neighborhoodBedY = neighborhood.weightedBedY / neighborhood.totalWeight;

      if (column.active && column.coverage > 0) {
        const continuityBias = clamp01(
          0.42 + column.mergeBlend * 0.22 + column.deepBlend * 0.12,
        );
        const visualCoverage = clamp01(
          Math.max(
            lerp(column.coverage, neighborhoodCoverage, continuityBias),
            Math.min(
              0.4,
              MIN_VISUAL_COVERAGE +
                column.coverage * (0.34 + column.mergeBlend * 0.28),
            ),
          ),
        );

        column.coverage = visualCoverage;
        column.wetness = clamp01(
          lerp(column.wetness, neighborhoodWetness, 0.32 + column.mergeBlend * 0.08),
        );
        column.foam = clamp01(
          Math.min(
            MAX_STABLE_FOAM,
            lerp(
              column.foam * 0.78,
              neighborhoodFoam * 0.5,
              0.24 + column.edgeStrength * 0.12,
            ),
          ),
        );
        column.edgeStrength = clamp01(
          lerp(
            column.edgeStrength,
            neighborhoodEdge,
            0.28 - column.mergeBlend * 0.05 + column.patchBoundaryRatio * 0.04,
          ),
        );
        column.microRipple = clamp01(
          Math.min(
            MAX_STABLE_RIPPLE,
            lerp(
              column.microRipple,
              neighborhoodRipple,
              0.18 + column.deepBlend * 0.06,
            ),
          ),
        );
        column.filmThickness = clamp(
          MIN_FILM_THICKNESS +
            column.thickness * (0.026 + column.deepBlend * 0.014) +
            column.coverage * (0.028 + column.mergeBlend * 0.02 + column.deepBlend * 0.012) +
            column.edgeStrength * 0.003,
          MIN_FILM_THICKNESS,
          MAX_FILM_THICKNESS,
        );
        column.filmOpacity = clamp01(
          lerp(
            column.filmOpacity,
            0.18 +
              column.coverage * (0.26 + column.mergeBlend * 0.1) +
              column.wetness * 0.16 -
              column.handoffBlend * 0.06,
            0.42,
          ),
        );
        const targetVolumeSurface = Math.min(
          column.surfaceY,
          column.bedY +
            column.filmThickness +
            column.thickness *
              (0.08 + column.mergeBlend * 0.18 + column.deepBlend * 0.16 + column.handoffBlend * 0.12),
        );
        column.visualSurfaceY = lerp(
          column.bedY + column.filmThickness,
          targetVolumeSurface,
          clamp01(column.mergeBlend * 0.42 + column.deepBlend * 0.33 + column.handoffBlend * 0.25),
        );
        continue;
      }

      if (
        neighborhoodCoverage < 0.1 ||
        (neighborhood.maxCoverage < 0.14 && neighborhoodLocalCore < 0.34)
      ) {
        column.active = false;
        continue;
      }

      column.active = true;
      column.thickness = 0;
      column.bedY = neighborhoodBedY;
      column.surfaceY = neighborhoodBedY;
      column.coverage = clamp01(neighborhoodCoverage * 0.66);
      column.wetness = clamp01(neighborhoodWetness * 0.82);
      column.foam = clamp01(Math.min(MAX_STABLE_FOAM * 0.45, neighborhoodFoam * 0.18));
      column.edgeStrength = clamp01(neighborhoodEdge * 0.68 + 0.08);
      column.microRipple = clamp01(Math.min(MAX_STABLE_RIPPLE * 0.6, neighborhoodRipple * 0.56));
      column.flowX = neighborhoodFlowX;
      column.flowZ = neighborhoodFlowZ;
      column.flowSpeed = neighborhoodFlowSpeed * 0.72;
      column.spreadVX = neighborhoodFlowX * column.flowSpeed;
      column.spreadVZ = neighborhoodFlowZ * column.flowSpeed;
      column.settled = clamp01(0.68 + neighborhoodWetness * 0.18);
      column.adhesion = clamp01(0.82);
      column.age = 0;
      column.shoreDist = SHORE_DISTANCE_MAX;
      column.breakup = clamp01(neighborhoodEdge * 0.3);
      column.patchId = -1;
      column.patchTotalMass = 0;
      column.patchArea = 0;
      column.patchActiveArea = 0;
      column.patchAverageThickness = 0;
      column.patchMaxThickness = 0;
      column.patchConnectivity = 0;
      column.patchCompactness = 0;
      column.patchBoundaryRatio = 0;
      column.patchHandoffReady = false;
      column.localNeighborCount = 0;
      column.localCore = neighborhoodLocalCore * 0.72;
      column.mergeBlend = neighborhoodMergeBlend * 0.68;
      column.deepBlend = neighborhoodDeepBlend * 0.52;
      column.handoffBlend = neighborhoodHandoffBlend * 0.28;
      column.filmThickness = clamp(
        MIN_FILM_THICKNESS +
          column.coverage * (0.024 + column.mergeBlend * 0.022 + column.deepBlend * 0.014) +
          column.edgeStrength * 0.003,
        MIN_FILM_THICKNESS,
        0.044,
      );
      column.filmOpacity = clamp01(
        0.1 +
          column.coverage * 0.22 +
          column.wetness * 0.12 +
          column.mergeBlend * 0.08 +
          column.deepBlend * 0.06,
      );
      column.visualSurfaceY =
        column.bedY +
        column.filmThickness +
        neighborhoodDeepBlend * 0.004 +
        neighborhoodMergeBlend * 0.002;
      column.emitterId = neighborhood.dominantEmitterId;
      column.handoffPending = false;
      column.ownershipDomain = "shallow";
      column.authority = neighborhood.dominantAuthority;
      activeColumnCount += 1;
    }
  }

  columns.length = count;

  return {
    originX: grid.originX,
    originZ: grid.originZ,
    sizeX: grid.sizeX,
    sizeZ: grid.sizeZ,
    terrainY: grid.terrainY,
    lastTickDt: grid.lastTickDt,
    columns,
    activeColumnCount,
  };
}

/**
 * Build a stable shallow render snapshot. The edge field is initialized with a
 * reusable empty shell so the caller can fill it with edge splats in a separate
 * pass without reallocating the parent contract.
 */
export function buildShallowWaterVisualSnapshot(
  grid: ShallowWaterSectionGrid,
  previous?: ShallowRenderSectionSnapshot,
  ghosts?: ShallowGhostColumnSet | null,
): ShallowRenderSectionSnapshot {
  const film = buildShallowWaterFilmSectionRenderData(grid, previous?.film, ghosts);
  const edgeField = makeEmptyEdgeField(
    grid.originX,
    grid.originZ,
    grid.sizeX,
    grid.sizeZ,
    previous?.edgeField,
  );
  return { film, edgeField };
}
