import { DEFAULT_SHALLOW_WATER_CONFIG } from "./ShallowWaterTypes.js";
import type {
  ShallowWaterPatchColumnMetrics,
  ShallowWaterPatchMetrics,
  ShallowWaterSectionGrid,
} from "./ShallowWaterTypes.js";
import type { ShallowGhostColumnSet } from "./ShallowBoundaryFluxRegistry.js";

type PatchBuildCell = {
  x: number;
  z: number;
  thickness: number;
  handoffPending: boolean;
  localNeighborCount: number;
};

export interface ShallowWaterPatchMetricsResult {
  patches: ShallowWaterPatchMetrics[];
  columns: ShallowWaterPatchColumnMetrics[];
}

const CARDINAL_STEPS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function getIndex(sizeX: number, x: number, z: number) {
  return z * sizeX + x;
}

function isPatchActiveCell(grid: ShallowWaterSectionGrid, index: number) {
  const column = grid.columns[index];
  return !!column?.active && column.ownershipDomain === "shallow" && column.thickness > 0.0001;
}

function createEmptyColumnMetrics(): ShallowWaterPatchColumnMetrics {
  return {
    patchId: -1,
    totalMass: 0,
    effectiveTotalMass: 0,
    area: 0,
    activeArea: 0,
    effectiveActiveArea: 0,
    averageThickness: 0,
    maxThickness: 0,
    connectivity: 0,
    compactness: 0,
    boundaryRatio: 0,
    seamContinuity: 0,
    handoffReady: false,
    localNeighborCount: 0,
    localCore: 0,
    mergeBlend: 0,
    deepBlend: 0,
    handoffBlend: 0,
  };
}

function smoothstep(edge0: number, edge1: number, value: number) {
  if (!Number.isFinite(value)) return 0;
  if (edge0 === edge1) {
    return value >= edge1 ? 1 : 0;
  }
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function countLocalNeighbors(
  grid: ShallowWaterSectionGrid,
  x: number,
  z: number,
  ghosts?: ShallowGhostColumnSet | null,
) {
  let count = 0;
  let seamCount = 0;
  for (const [dx, dz] of CARDINAL_STEPS) {
    const nx = x + dx;
    const nz = z + dz;
    if (nx < 0 || nz < 0 || nx >= grid.sizeX || nz >= grid.sizeZ) {
      const ghost = getGhostNeighbor(ghosts, grid, x, z, dx, dz);
      if (ghost?.active && ghost.thickness > 0.0001) {
        count += 1;
        seamCount += 1;
      }
      continue;
    }
    if (isPatchActiveCell(grid, getIndex(grid.sizeX, nx, nz))) {
      count += 1;
    }
  }
  return { count, seamCount };
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

function buildPatchMetrics(
  patchId: number,
  cells: PatchBuildCell[],
  spanX: number,
  spanZ: number,
  perimeterEdges: number,
  seamNeighborLinks: number,
  seamTouchCells: number,
) {
  const activeArea = cells.length;
  const area = Math.max(1, spanX * spanZ);
  const effectiveArea = activeArea + seamTouchCells * 0.45;
  let totalMass = 0;
  let maxThickness = 0;
  let handoffMembers = 0;
  let totalNeighborCount = 0;

  for (const cell of cells) {
    totalMass += cell.thickness;
    maxThickness = Math.max(maxThickness, cell.thickness);
    if (cell.handoffPending) handoffMembers += 1;
    totalNeighborCount += cell.localNeighborCount;
  }

  const averageThickness = activeArea > 0 ? totalMass / activeArea : 0;
  const seamMassProxy = averageThickness * seamTouchCells * 0.38;
  const effectiveTotalMass = totalMass + seamMassProxy;
  const effectiveActiveArea = activeArea + seamTouchCells * 0.45;
  const density = effectiveArea / area;
  const compactness = clamp01(density);
  const neighborDensity = activeArea > 0 ? totalNeighborCount / (activeArea * 4) : 0;
  const seamContinuity = clamp01(seamNeighborLinks / Math.max(1, activeArea * 2));
  const connectivity = clamp01(
    compactness * 0.42 + neighborDensity * 0.4 + seamContinuity * 0.18,
  );
  const boundaryRatio = clamp01(perimeterEdges / Math.max(1, activeArea * 4));

  const handoffThicknessRef = Math.max(
    0.0001,
    DEFAULT_SHALLOW_WATER_CONFIG.handoffThickness,
  );
  const averageThickness01 = clamp01(
    averageThickness / (handoffThicknessRef * 0.64),
  );
  const maxThickness01 = clamp01(
    maxThickness / (handoffThicknessRef * 0.88),
  );
  const sizeScale = smoothstep(1.0, 8.5, activeArea + seamTouchCells * 0.8);
  const massScale = smoothstep(
    handoffThicknessRef * 0.16,
    handoffThicknessRef * 2.2,
    effectiveTotalMass,
  );
  const connectivityScale = smoothstep(0.16, 0.74, connectivity);
  const mergeSignal =
    sizeScale * 0.24 +
    massScale * 0.34 +
    averageThickness01 * 0.14 +
    connectivityScale * 0.22 +
    seamContinuity * 0.06;
  const mergeBlend = clamp01(smoothstep(0.12, 0.8, mergeSignal));
  const deepSignal =
    mergeBlend * 0.18 +
    massScale * 0.28 +
    averageThickness01 * 0.22 +
    maxThickness01 * 0.2 +
    connectivityScale * 0.08 +
    seamContinuity * 0.04;
  const deepBlend = clamp01(smoothstep(0.2, 0.78, deepSignal));
  const handoffSignal =
    deepBlend * 0.22 +
    maxThickness01 * 0.2 +
    averageThickness01 * 0.12 +
    massScale * 0.28 +
    connectivityScale * 0.12 +
    sizeScale * 0.06 +
    seamContinuity * 0.08 +
    Math.max(0, 1 - boundaryRatio) * 0.08;
  const handoffBlend = clamp01(smoothstep(0.28, 0.78, handoffSignal));
  const handoffReady =
    handoffBlend >= 0.44 &&
    effectiveTotalMass >= handoffThicknessRef * 0.58 &&
    averageThickness >= handoffThicknessRef * 0.28 &&
    maxThickness >= handoffThicknessRef * 0.42 &&
    connectivity >= 0.2 &&
    effectiveActiveArea >= 2;
  const existingHandoffBias = activeArea > 0 ? handoffMembers / activeArea : 0;
  const stabilizedHandoffBlend = clamp01(
    Math.max(handoffBlend, existingHandoffBias * 0.55 + handoffBlend * 0.45),
  );

  const metrics: ShallowWaterPatchMetrics = {
    patchId,
    totalMass,
    effectiveTotalMass,
    area,
    activeArea,
    effectiveActiveArea,
    averageThickness,
    maxThickness,
    connectivity,
    compactness,
    boundaryRatio,
    seamContinuity,
    mergeBlend,
    deepBlend,
    handoffBlend: stabilizedHandoffBlend,
    handoffReady,
  };

  return metrics;
}

export function buildShallowWaterPatchMetrics(
  grid: ShallowWaterSectionGrid,
  previous?: ShallowWaterPatchMetricsResult,
  ghosts?: ShallowGhostColumnSet | null,
): ShallowWaterPatchMetricsResult {
  const cellCount = grid.sizeX * grid.sizeZ;
  const columns =
    previous && previous.columns.length === cellCount
      ? previous.columns
      : Array.from({ length: cellCount }, () => createEmptyColumnMetrics());

  for (let i = 0; i < cellCount; i++) {
    const target = columns[i] ?? createEmptyColumnMetrics();
    columns[i] = target;
    target.patchId = -1;
    target.totalMass = 0;
    target.effectiveTotalMass = 0;
    target.area = 0;
    target.activeArea = 0;
    target.effectiveActiveArea = 0;
    target.averageThickness = 0;
    target.maxThickness = 0;
    target.connectivity = 0;
    target.compactness = 0;
    target.boundaryRatio = 0;
    target.seamContinuity = 0;
    target.handoffReady = false;
    target.localNeighborCount = 0;
    target.localCore = 0;
    target.mergeBlend = 0;
    target.deepBlend = 0;
    target.handoffBlend = 0;
  }

  const visited = new Uint8Array(cellCount);
  const patches: ShallowWaterPatchMetrics[] = [];
  let nextPatchId = 1;

  for (let z = 0; z < grid.sizeZ; z++) {
    for (let x = 0; x < grid.sizeX; x++) {
      const startIndex = getIndex(grid.sizeX, x, z);
      if (visited[startIndex] || !isPatchActiveCell(grid, startIndex)) continue;

      const queue = [startIndex];
      visited[startIndex] = 1;
      const cells: PatchBuildCell[] = [];
      let minX = x;
      let maxX = x;
      let minZ = z;
      let maxZ = z;
      let perimeterEdges = 0;
      let seamNeighborLinks = 0;
      let seamTouchCells = 0;

      while (queue.length) {
        const index = queue.pop() as number;
        const cellX = index % grid.sizeX;
        const cellZ = Math.floor(index / grid.sizeX);
        const column = grid.columns[index];
        const localNeighbors = countLocalNeighbors(grid, cellX, cellZ, ghosts);
        cells.push({
          x: cellX,
          z: cellZ,
          thickness: column.thickness,
          handoffPending: column.handoffPending,
          localNeighborCount: localNeighbors.count,
        });
        minX = Math.min(minX, cellX);
        maxX = Math.max(maxX, cellX);
        minZ = Math.min(minZ, cellZ);
        maxZ = Math.max(maxZ, cellZ);
        if (localNeighbors.seamCount > 0) {
          seamTouchCells += 1;
          seamNeighborLinks += localNeighbors.seamCount;
        }

        for (const [dx, dz] of CARDINAL_STEPS) {
          const nx = cellX + dx;
          const nz = cellZ + dz;
          if (nx < 0 || nz < 0 || nx >= grid.sizeX || nz >= grid.sizeZ) {
            const ghost = getGhostNeighbor(ghosts, grid, cellX, cellZ, dx, dz);
            if (!ghost?.active || ghost.thickness <= 0.0001) {
              perimeterEdges += 1;
            }
            continue;
          }
          const neighborIndex = getIndex(grid.sizeX, nx, nz);
          if (!isPatchActiveCell(grid, neighborIndex)) {
            perimeterEdges += 1;
            continue;
          }
          if (visited[neighborIndex]) continue;
          visited[neighborIndex] = 1;
          queue.push(neighborIndex);
        }
      }

      const metrics = buildPatchMetrics(
        nextPatchId,
        cells,
        maxX - minX + 1,
        maxZ - minZ + 1,
        perimeterEdges,
        seamNeighborLinks,
        seamTouchCells,
      );
      patches.push(metrics);

      for (const cell of cells) {
        const index = getIndex(grid.sizeX, cell.x, cell.z);
        const target = columns[index];
        target.patchId = metrics.patchId;
        target.totalMass = metrics.totalMass;
        target.effectiveTotalMass = metrics.effectiveTotalMass;
        target.area = metrics.area;
        target.activeArea = metrics.activeArea;
        target.effectiveActiveArea = metrics.effectiveActiveArea;
        target.averageThickness = metrics.averageThickness;
        target.maxThickness = metrics.maxThickness;
        target.connectivity = metrics.connectivity;
        target.compactness = metrics.compactness;
        target.boundaryRatio = metrics.boundaryRatio;
        target.seamContinuity = metrics.seamContinuity;
        target.handoffReady = metrics.handoffReady;
        target.localNeighborCount = cell.localNeighborCount;
        const localConnectivity = clamp01(cell.localNeighborCount / 4);
        const localDepth = clamp01(
          cell.thickness / Math.max(0.0001, metrics.maxThickness),
        );
        const localCore = clamp01(localConnectivity * 0.56 + localDepth * 0.44);
        target.localCore = localCore;
        target.mergeBlend = clamp01(
          metrics.mergeBlend *
            (0.68 +
              localConnectivity * 0.16 +
              localDepth * 0.1 +
              metrics.seamContinuity * 0.06),
        );
        target.deepBlend = clamp01(
          metrics.deepBlend *
            (0.4 + localCore * 0.54 + metrics.seamContinuity * 0.06),
        );
        const thicknessGate = smoothstep(
          DEFAULT_SHALLOW_WATER_CONFIG.handoffThickness * 0.14,
          DEFAULT_SHALLOW_WATER_CONFIG.handoffThickness * 0.72,
          cell.thickness,
        );
        target.handoffBlend = clamp01(
          metrics.handoffBlend *
            (0.26 + localCore * 0.68 + metrics.seamContinuity * 0.06) *
            thicknessGate,
        );
      }

      nextPatchId += 1;
    }
  }

  return { patches, columns };
}
