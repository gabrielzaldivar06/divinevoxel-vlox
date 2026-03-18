import { WaterColumnSample, WaterSectionGrid } from "../Types/WaterTypes";
import { RenderedMaterials } from "../../Mesher/Voxels/Models/RenderedMaterials";
import { VoxelMeshVertexConstants } from "../../Mesher/Voxels/Geometry/VoxelMeshVertexStructCursor";
import { VoxelShaderData } from "../../Mesher/Voxels/Geometry/VoxelShaderData";
import { VoxelLUT } from "../../Voxels/Data/VoxelLUT";
import { GeometryLUT } from "../../Voxels/Data/GeometryLUT";

export type WaterSurfaceMesherOptions = {
  minSurfaceY?: number;
  maxSurfaceY?: number;
};

const VERTEX_SIZE = VoxelMeshVertexConstants.VertexFloatSize;
const WATER_SEAM_EPSILON = 0.0001;

function encodeWaterClassValue(waterClass: WaterColumnSample["waterClass"]) {
  if (waterClass === "river") return 0;
  if (waterClass === "sea") return 1;
  return 0.5;
}

/**
 * Resolves the still-water texture index for a given voxel ID.
 * Falls back to 0 if not found.
 */
function resolveWaterTexture(voxelId: number): number {
  const stateIndex = VoxelLUT.getStateIndex(
    voxelId,
    0,
    VoxelLUT.totalRelationalVoxelIds
  );
  const geoInputIdx = VoxelLUT.geometryInputsIndex[stateIndex];
  if (geoInputIdx === undefined) return 0;
  const nodeInputs = GeometryLUT.geometryInputs[geoInputIdx];
  if (!nodeInputs || !nodeInputs[0]) return 0;
  const args = nodeInputs[0];
  if (typeof args.stillTexture === "number") return args.stillTexture;
  if (typeof args.texture === "number") return args.texture;
  return 0;
}

/**
 * Precomputed voxelData vectors for each quad vertex (full light=15, no AO, no animation).
 */
const _voxelData = [
  { x: 0, y: 0, z: 0, w: 0 },
  { x: 0, y: 0, z: 0, w: 0 },
  { x: 0, y: 0, z: 0, w: 0 },
  { x: 0, y: 0, z: 0, w: 0 },
];

function initVoxelData() {
  for (let vi = 0; vi < 4; vi++) {
    const ref = _voxelData[vi];
    // Pack: light1=15 in x, light2=15 in y, light3=15|vertexIndex in z, light4=15 in w
    let x = 0;
    x |= (15 & VoxelShaderData.LightMask) << 0; // light1 = 15
    // ao all 0
    ref.x = x;
    let y = 0;
    y |= (15 & VoxelShaderData.LightMask) << 0; // light2 = 15
    ref.y = y;
    let z = 0;
    z |= (15 & VoxelShaderData.LightMask) << 0; // light3 = 15
    z |= (vi & VoxelShaderData.VertexMask) << 16; // vertexIndex
    ref.z = z;
    let w = 0;
    w |= (15 & VoxelShaderData.LightMask) << 0; // light4 = 15
    ref.w = w;
  }
}

// Initialize once at module load
initVoxelData();

/**
 * Write a single water vertex into the proto mesh buffer.
 */
function writeWaterVertex(
  array: Float32Array,
  localIndex: number,
  px: number,
  py: number,
  pz: number,
  nx: number,
  ny: number,
  nz: number,
  u: number,
  v: number,
  textureIndex: number,
  voxelData: { x: number; y: number; z: number; w: number },
  fillFactor: number,
  heightNorm: number,
  shoreDistance: number,
  openEdgeFactor: number,
  slope: number,
  flowX: number,
  flowZ: number,
  flowStrength: number,
  waterClassValue: number,
) {
  const i = localIndex * VERTEX_SIZE;
  const shoreFactor = computeShoreFactor(shoreDistance);
  const shoreDistanceNormalized = computeShoreDistanceNormalized(shoreDistance);

  // Position (offset 0-2)
  array[i + VoxelMeshVertexConstants.PositionOffset] = px;
  array[i + VoxelMeshVertexConstants.PositionOffset + 1] = py;
  array[i + VoxelMeshVertexConstants.PositionOffset + 2] = pz;
  // Dissolution padding = 0 (offsets 3, 7, 11, 17)
  array[i + 3] = 0;
  array[i + 7] = 0;
  array[i + 11] = 0;
  array[i + 17] = 0;

  // Normal (offset 4-6)
  array[i + VoxelMeshVertexConstants.NormalOffset] = nx;
  array[i + VoxelMeshVertexConstants.NormalOffset + 1] = ny;
  array[i + VoxelMeshVertexConstants.NormalOffset + 2] = nz;

  // TextureIndex (offset 8-10)
  array[i + VoxelMeshVertexConstants.TextureIndexOffset] =
    VoxelShaderData.createTextureIndex(textureIndex, 0);
  array[i + VoxelMeshVertexConstants.TextureIndexOffset + 1] =
    VoxelShaderData.createTextureIndex(0, 0);
  array[i + VoxelMeshVertexConstants.TextureIndexOffset + 2] =
    VoxelShaderData.createTextureIndex(0, 0);

  // UV (offset 12-13)
  array[i + VoxelMeshVertexConstants.UVOffset] = u;
  array[i + VoxelMeshVertexConstants.UVOffset + 1] = v;

  // Color / WorldContext (offset 14-16)
  // x = fill factor
  // y = shore factor (1 near coast, 0 offshore)
  // z = edge openness / boundary factor
  array[i + VoxelMeshVertexConstants.ColorOffset] = fillFactor;
  array[i + VoxelMeshVertexConstants.ColorOffset + 1] = shoreFactor;
  array[i + VoxelMeshVertexConstants.ColorOffset + 2] = openEdgeFactor;

  // VoxelData (offset 18-21)
  array[i + VoxelMeshVertexConstants.VoxelDataOFfset] = voxelData.x;
  array[i + VoxelMeshVertexConstants.VoxelDataOFfset + 1] = voxelData.y;
  array[i + VoxelMeshVertexConstants.VoxelDataOFfset + 2] = voxelData.z;
  array[i + VoxelMeshVertexConstants.VoxelDataOFfset + 3] = voxelData.w;

  // Metadata (offset 22-25): dedicated water flow payload
  //   x = normalized flow X
  //   y = normalized flow Z
  //   z = flow strength [0,1]
  //   w = water class encoded (river=0, lake=0.5, sea=1)
  array[i + VoxelMeshVertexConstants.MetadataOffset] = flowX;
  array[i + VoxelMeshVertexConstants.MetadataOffset + 1] = flowZ;
  array[i + VoxelMeshVertexConstants.MetadataOffset + 2] = flowStrength;
  array[i + VoxelMeshVertexConstants.MetadataOffset + 3] = waterClassValue;

  // SubdivAO (offset 26): 0.5 = neutral
  array[i + 26] = 0.5;
  // PhNormalized (offset 27): shoreline distance normalized [0,1]
  //   0 = coast-adjacent water
  //   1 = offshore / no nearby shore within the encoded radius
  array[i + 27] = shoreDistanceNormalized;
}

function computeShoreFactor(shoreDistance: number) {
  return shoreDistance >= 0 ? Math.max(0, 1 - Math.min(shoreDistance / 4, 1)) : 0;
}

function computeShoreDistanceNormalized(shoreDistance: number) {
  return shoreDistance >= 0 ? Math.min(shoreDistance / 8, 1) : 1;
}

function computeOpenEdgeFactor(
  grid: WaterSectionGrid,
  lx: number,
  lz: number,
) {
  const checks: [number, number][] = [
    [lx - 1, lz],
    [lx + 1, lz],
    [lx, lz - 1],
    [lx, lz + 1],
  ];
  let openSides = 0;
  for (const [nx, nz] of checks) {
    const neighbor = getFilledColumn(grid, nx, nz);
    if (!neighbor) {
      openSides++;
    }
  }
  return openSides / checks.length;
}

function getFilledColumn(
  grid: WaterSectionGrid,
  lx: number,
  lz: number,
) {
  if (lx >= 0 && lx < grid.boundsX && lz >= 0 && lz < grid.boundsZ) {
    const col = grid.columns[lx * grid.boundsZ + lz];
    return col.filled ? col : null;
  }

  if (lx < -1 || lx > grid.boundsX || lz < -1 || lz > grid.boundsZ) return null;
  const paddedIndex = (lx + 1) * grid.paddedBoundsZ + (lz + 1);
  const col = grid.paddedColumns[paddedIndex];
  return col.filled ? col : null;
}

function sampleCornerLocalSurfaceY(
  grid: WaterSectionGrid,
  vertexX: number,
  vertexZ: number,
  fallbackY: number,
) {
  let total = 0;
  let count = 0;
  const cells: [number, number][] = [
    [vertexX - 1, vertexZ - 1],
    [vertexX - 1, vertexZ],
    [vertexX, vertexZ - 1],
    [vertexX, vertexZ],
  ];
  for (const [cx, cz] of cells) {
    const col = getFilledColumn(grid, cx, cz);
    if (!col) continue;
    total += col.surfaceY - grid.originY;
    count++;
  }
  return count ? total / count : fallbackY;
}

function getColumnBaseLocalY(col: WaterColumnSample) {
  return col.localY;
}

function shouldEmitSeam(topA: number, topB: number, bottomA: number, bottomB: number) {
  return (
    Math.abs(topA - bottomA) > WATER_SEAM_EPSILON ||
    Math.abs(topB - bottomB) > WATER_SEAM_EPSILON
  );
}

function emitVisibleWaterSeams(
  mesh: any,
  grid: WaterSectionGrid,
  waterTexture: number,
  col: WaterColumnSample,
  lx: number,
  lz: number,
  fillFactor: number,
  heightNorm: number,
  shoreDist: number,
  openEdgeFactor: number,
  flowX: number,
  flowZ: number,
  flowStrength: number,
  waterClassValue: number,
  topNE: [number, number, number],
  topNW: [number, number, number],
  topSW: [number, number, number],
  topSE: [number, number, number],
) {
  const baseY = getColumnBaseLocalY(col);
  const seamOpenEdgeFactor = Math.max(openEdgeFactor, 0.5);

  const eastX = lx + 1;
  if (!getFilledColumn(grid, lx + 1, lz)) {
    const bottomNE: [number, number, number] = [eastX, baseY, lz];
    const bottomSE: [number, number, number] = [eastX, baseY, lz + 1];
    if (shouldEmitSeam(topNE[1], topSE[1], bottomNE[1], bottomSE[1])) {
      emitWaterQuad(
        mesh,
        waterTexture,
        fillFactor,
        heightNorm,
        shoreDist,
        seamOpenEdgeFactor,
        flowX,
        flowZ,
        flowStrength,
        waterClassValue,
        topSE,
        topNE,
        bottomNE,
        bottomSE,
      );
    }
  }

  const westX = lx;
  if (!getFilledColumn(grid, lx - 1, lz)) {
    const bottomNW: [number, number, number] = [westX, baseY, lz];
    const bottomSW: [number, number, number] = [westX, baseY, lz + 1];
    if (shouldEmitSeam(topNW[1], topSW[1], bottomNW[1], bottomSW[1])) {
      emitWaterQuad(
        mesh,
        waterTexture,
        fillFactor,
        heightNorm,
        shoreDist,
        seamOpenEdgeFactor,
        flowX,
        flowZ,
        flowStrength,
        waterClassValue,
        topNW,
        topSW,
        bottomSW,
        bottomNW,
      );
    }
  }

  const northZ = lz;
  if (!getFilledColumn(grid, lx, lz - 1)) {
    const bottomNE: [number, number, number] = [lx + 1, baseY, northZ];
    const bottomNW: [number, number, number] = [lx, baseY, northZ];
    if (shouldEmitSeam(topNE[1], topNW[1], bottomNE[1], bottomNW[1])) {
      emitWaterQuad(
        mesh,
        waterTexture,
        fillFactor,
        heightNorm,
        shoreDist,
        seamOpenEdgeFactor,
        flowX,
        flowZ,
        flowStrength,
        waterClassValue,
        topNE,
        topNW,
        bottomNW,
        bottomNE,
      );
    }
  }

  const southZ = lz + 1;
  if (!getFilledColumn(grid, lx, lz + 1)) {
    const bottomSW: [number, number, number] = [lx, baseY, southZ];
    const bottomSE: [number, number, number] = [lx + 1, baseY, southZ];
    if (shouldEmitSeam(topSW[1], topSE[1], bottomSW[1], bottomSE[1])) {
      emitWaterQuad(
        mesh,
        waterTexture,
        fillFactor,
        heightNorm,
        shoreDist,
        seamOpenEdgeFactor,
        flowX,
        flowZ,
        flowStrength,
        waterClassValue,
        topSW,
        topSE,
        bottomSE,
        bottomSW,
      );
    }
  }
}

function emitWaterQuad(
  mesh: any,
  waterTexture: number,
  fillFactor: number,
  heightNorm: number,
  shoreDist: number,
  openEdgeFactor: number,
  flowX: number,
  flowZ: number,
  flowStrength: number,
  waterClassValue: number,
  p0: [number, number, number],
  p1: [number, number, number],
  p2: [number, number, number],
  p3: [number, number, number],
) {
  const ux = p1[0] - p0[0];
  const uy = p1[1] - p0[1];
  const uz = p1[2] - p0[2];
  const vx = p2[0] - p0[0];
  const vy = p2[1] - p0[1];
  const vz = p2[2] - p0[2];

  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const normalLength = Math.hypot(nx, ny, nz);
  if (normalLength > 0.0001) {
    nx /= normalLength;
    ny /= normalLength;
    nz /= normalLength;
  } else {
    nx = 0;
    ny = 1;
    nz = 0;
  }
  const slope = Math.max(0, Math.min(1, 1 - Math.abs(ny)));

  const baseVert = mesh.vertexCount;

  mesh.buffer.setIndex(baseVert);
  writeWaterVertex(
    mesh.buffer.currentArray,
    mesh.buffer.curentIndex,
    p0[0], p0[1], p0[2],
    nx, ny, nz,
    1, 0,
    waterTexture, _voxelData[0], fillFactor, heightNorm, shoreDist, openEdgeFactor, slope,
    flowX, flowZ, flowStrength, waterClassValue,
  );

  mesh.buffer.setIndex(baseVert + 1);
  writeWaterVertex(
    mesh.buffer.currentArray,
    mesh.buffer.curentIndex,
    p1[0], p1[1], p1[2],
    nx, ny, nz,
    0, 0,
    waterTexture, _voxelData[1], fillFactor, heightNorm, shoreDist, openEdgeFactor, slope,
    flowX, flowZ, flowStrength, waterClassValue,
  );

  mesh.buffer.setIndex(baseVert + 2);
  writeWaterVertex(
    mesh.buffer.currentArray,
    mesh.buffer.curentIndex,
    p2[0], p2[1], p2[2],
    nx, ny, nz,
    0, 1,
    waterTexture, _voxelData[2], fillFactor, heightNorm, shoreDist, openEdgeFactor, slope,
    flowX, flowZ, flowStrength, waterClassValue,
  );

  mesh.buffer.setIndex(baseVert + 3);
  writeWaterVertex(
    mesh.buffer.currentArray,
    mesh.buffer.curentIndex,
    p3[0], p3[1], p3[2],
    nx, ny, nz,
    1, 1,
    waterTexture, _voxelData[3], fillFactor, heightNorm, shoreDist, openEdgeFactor, slope,
    flowX, flowZ, flowStrength, waterClassValue,
  );

  const indBase = mesh.indicieCount;
  const indices = mesh.indices;

  indices.setIndex(indBase).currentArray[indices.curentIndex] = baseVert;
  indices.setIndex(indBase + 1).currentArray[indices.curentIndex] = baseVert + 1;
  indices.setIndex(indBase + 2).currentArray[indices.curentIndex] = baseVert + 2;
  indices.setIndex(indBase + 3).currentArray[indices.curentIndex] = baseVert + 2;
  indices.setIndex(indBase + 4).currentArray[indices.curentIndex] = baseVert + 3;
  indices.setIndex(indBase + 5).currentArray[indices.curentIndex] = baseVert;

  indices.setIndex(indBase + 6).currentArray[indices.curentIndex] = baseVert;
  indices.setIndex(indBase + 7).currentArray[indices.curentIndex] = baseVert + 3;
  indices.setIndex(indBase + 8).currentArray[indices.curentIndex] = baseVert + 2;
  indices.setIndex(indBase + 9).currentArray[indices.curentIndex] = baseVert + 2;
  indices.setIndex(indBase + 10).currentArray[indices.curentIndex] = baseVert + 1;
  indices.setIndex(indBase + 11).currentArray[indices.curentIndex] = baseVert;

  mesh.addVerticies(4, 12);

  const minX = Math.min(p0[0], p1[0], p2[0], p3[0]);
  const minY = Math.min(p0[1], p1[1], p2[1], p3[1]);
  const minZ = Math.min(p0[2], p1[2], p2[2], p3[2]);
  const maxX = Math.max(p0[0], p1[0], p2[0], p3[0]);
  const maxY = Math.max(p0[1], p1[1], p2[1], p3[1]);
  const maxZ = Math.max(p0[2], p1[2], p2[2], p3[2]);

  if (minX < mesh.minBounds.x) mesh.minBounds.x = minX;
  if (minY < mesh.minBounds.y) mesh.minBounds.y = minY;
  if (minZ < mesh.minBounds.z) mesh.minBounds.z = minZ;
  if (maxX > mesh.maxBounds.x) mesh.maxBounds.x = maxX;
  if (maxY > mesh.maxBounds.y) mesh.maxBounds.y = maxY;
  if (maxZ > mesh.maxBounds.z) mesh.maxBounds.z = maxZ;
}

/**
 * Generate a dedicated water top-surface mesh for the given section grid.
 *
 * Writes quads directly into the "dve_liquid" material builder's ProtoMesh.
 * This replaces the Surface Nets fluid emission path.
 *
 * @returns true if any water quads were emitted.
 */
export function meshWaterSurface(
  grid: WaterSectionGrid,
  options?: WaterSurfaceMesherOptions,
): boolean {
  if (grid.filledCount === 0) return false;

  const builder = RenderedMaterials.meshersMap.get("dve_liquid");
  if (!builder) return false;

  const mesh = builder.mesh;
  const bx = grid.boundsX;
  const bz = grid.boundsZ;
  const cols = grid.columns;
  const minSurfaceY = options?.minSurfaceY;
  const maxSurfaceY = options?.maxSurfaceY;

  // Resolve texture once from the first filled column's voxel
  let waterTexture = 0;
  for (let i = 0; i < bx * bz; i++) {
    if (cols[i].filled) {
      waterTexture = resolveWaterTexture(cols[i].voxelId);
      break;
    }
  }

  let emitted = false;

  for (let lx = 0; lx < bx; lx++) {
    for (let lz = 0; lz < bz; lz++) {
      const idx = lx * bz + lz;
      const col = cols[idx];
      if (!col.filled) continue;

      const worldSurfaceY = col.surfaceY;

      if (minSurfaceY !== undefined && worldSurfaceY < minSurfaceY) continue;
      if (maxSurfaceY !== undefined && worldSurfaceY > maxSurfaceY) continue;

      const localSurfaceY = worldSurfaceY - grid.originY;

      // Height normalized for metadata
      const heightNorm = Math.max(0, Math.min(1, (worldSurfaceY - 16) / 112));
      const fillFactor = Math.max(0, Math.min(1, col.fill));
      const shoreDist = col.shoreDistance;
      const openEdgeFactor = computeOpenEdgeFactor(grid, lx, lz);
      const flowX = col.flowX;
      const flowZ = col.flowZ;
      const flowStrength = col.flowStrength;
      const waterClassValue = encodeWaterClassValue(col.waterClass);

      // Quad corners (top-surface, up-facing):
      //   v0 = (wx+1, sy, wz)     top-right
      //   v1 = (wx,   sy, wz)     top-left
      //   v2 = (wx,   sy, wz+1)   bottom-left
      //   v3 = (wx+1, sy, wz+1)   bottom-right

      // Smooth water top across neighboring filled columns using shared corner heights.
      const y00 = sampleCornerLocalSurfaceY(grid, lx, lz, localSurfaceY);
      const y10 = sampleCornerLocalSurfaceY(grid, lx + 1, lz, localSurfaceY);
      const y01 = sampleCornerLocalSurfaceY(grid, lx, lz + 1, localSurfaceY);
      const y11 = sampleCornerLocalSurfaceY(grid, lx + 1, lz + 1, localSurfaceY);
      const topNE: [number, number, number] = [lx + 1, y10, lz];
      const topNW: [number, number, number] = [lx, y00, lz];
      const topSW: [number, number, number] = [lx, y01, lz + 1];
      const topSE: [number, number, number] = [lx + 1, y11, lz + 1];

      emitWaterQuad(
        mesh,
        waterTexture,
        fillFactor,
        heightNorm,
        shoreDist,
        openEdgeFactor,
        flowX,
        flowZ,
        flowStrength,
        waterClassValue,
        topNE,
        topNW,
        topSW,
        topSE,
      );
      emitVisibleWaterSeams(
        mesh,
        grid,
        waterTexture,
        col,
        lx,
        lz,
        fillFactor,
        heightNorm,
        shoreDist,
        openEdgeFactor,
        flowX,
        flowZ,
        flowStrength,
        waterClassValue,
        topNE,
        topNW,
        topSW,
        topSE,
      );
      emitted = true;
    }
  }

  return emitted;
}
