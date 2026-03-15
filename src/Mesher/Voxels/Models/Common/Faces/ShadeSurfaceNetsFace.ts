import { Vec3Array } from "@amodx/math";
import { VoxelModelBuilder } from "../../VoxelModelBuilder";
import { QuadVerticies } from "../../../../Geometry/Geometry.types";
import { VoxelFaces, VoxelFaceDirections } from "../../../../../Math";
import { VoxelLightData } from "../../../../../Voxels/Cursor/VoxelLightData";
import { VoxelRelativeCubeIndexPositionMap } from "../../../../../Voxels/Geometry/VoxelRelativeCubeIndex";

const lightData = new VoxelLightData();

/**
 * The 26 neighbor offsets (all combinations of {-1,0,1}^3 excluding (0,0,0)).
 * Precomputed indices into VoxelRelativeCubeIndexPositionMap.
 */
const NEIGHBOR_OFFSETS: Vec3Array[] = [];
const NEIGHBOR_POSITION_INDICES: number[] = [];
for (let i = 0; i < 27; i++) {
  const p = VoxelRelativeCubeIndexPositionMap[i];
  if (p[0] === 0 && p[1] === 0 && p[2] === 0) continue;
  NEIGHBOR_OFFSETS.push(p);
  NEIGHBOR_POSITION_INDICES.push(i);
}

/**
 * Compute AO and lighting for a Surface Nets quad.
 *
 * Unlike ShadeRulledFace which uses pre-built LUTs for axis-aligned faces,
 * this function works with arbitrary normals by sampling the hemisphere
 * around each vertex's face normal direction.
 *
 * For each of the 4 vertices:
 *  - Light: sample the light cache at the face-direction neighbor and 
 *    up to 3 gradient neighbors, take maximum per channel.
 *  - AO: count how many solid neighbors lie in the hemisphere of the quad normal.
 *    Cap at 3 to match the axis-aligned AO system.
 *
 * @param builder  The model builder with position/cache/nVoxel set up
 * @param closestFace  The dominant axis-aligned face for this quad  
 * @param positions  The 4 vertex positions (local to section)
 */
export function ShadeSurfaceNetsFace(
  builder: VoxelModelBuilder,
  closestFace: VoxelFaces,
  positions: [Vec3Array, Vec3Array, Vec3Array, Vec3Array],
) {
  const space = builder.space;
  const foundHash = space.foundHash;
  const noCastAO = space.noCastAO;
  const nVoxel = builder.nVoxel;
  const posX = builder.position.x;
  const posY = builder.position.y;
  const posZ = builder.position.z;

  const worldLight = builder.vars.light;
  const worldAO = builder.vars.ao;

  // Compute the flat normal of the quad (cross product of two edges)
  const e1x = positions[1][0] - positions[0][0];
  const e1y = positions[1][1] - positions[0][1];
  const e1z = positions[1][2] - positions[0][2];
  const e2x = positions[2][0] - positions[0][0];
  const e2y = positions[2][1] - positions[0][1];
  const e2z = positions[2][2] - positions[0][2];
  let nx = e1y * e2z - e1z * e2y;
  let ny = e1z * e2x - e1x * e2z;
  let nz = e1x * e2y - e1y * e2x;
  const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (nLen > 0) {
    nx /= nLen;
    ny /= nLen;
    nz /= nLen;
  } else {
    // Fallback to axis-aligned face direction
    const fd = VoxelFaceDirections[closestFace];
    nx = fd[0];
    ny = fd[1];
    nz = fd[2];
  }

  // Get the base light from the face direction neighbor
  const fd = VoxelFaceDirections[closestFace];
  let startLight = 0;
  const hFace = space.getHash(
    nVoxel,
    posX + fd[0],
    posY + fd[1],
    posZ + fd[2],
  );
  startLight = space.lightCache[hFace];
  if (startLight <= 0) {
    const hSelf = space.getHash(nVoxel, posX, posY, posZ);
    startLight = space.lightCache[hSelf];
  }
  if (startLight < 0) startLight = 0;

  // For each vertex, compute light + AO
  for (let v: QuadVerticies = 0 as QuadVerticies; v < 4; v++) {
    // Light: start with base light, then check gradient neighbors
    // to get max per channel (same approach as FaceDataCalc)
    let s = lightData.getS(startLight);
    let r = lightData.getR(startLight);
    let g = lightData.getG(startLight);
    let b = lightData.getB(startLight);

    // Sample 3 neighbors closest to this vertex's direction for light gradient
    // Use the vertex position relative to quad center to bias neighbor selection
    const vx = positions[v][0];
    const vy = positions[v][1];
    const vz = positions[v][2];

    // Center of the quad
    const ccx =
      (positions[0][0] + positions[1][0] + positions[2][0] + positions[3][0]) /
      4;
    const ccy =
      (positions[0][1] + positions[1][1] + positions[2][1] + positions[3][1]) /
      4;
    const ccz =
      (positions[0][2] + positions[1][2] + positions[2][2] + positions[3][2]) /
      4;

    // Bias direction = from center to vertex, projected along normal hemisphere
    const bx = vx - ccx + nx;
    const by = vy - ccy + ny;
    const bz = vz - ccz + nz;

    // Quantize bias to neighbor offsets
    const sx = bx > 0.01 ? 1 : bx < -0.01 ? -1 : 0;
    const sy = by > 0.01 ? 1 : by < -0.01 ? -1 : 0;
    const sz = bz > 0.01 ? 1 : bz < -0.01 ? -1 : 0;

    // Sample light at 3 gradient directions
    const gradientDirs: Vec3Array[] = [
      [sx, 0, 0],
      [0, sy, 0],
      [0, 0, sz],
    ];

    for (let gi = 0; gi < 3; gi++) {
      const gd = gradientDirs[gi];
      if (gd[0] === 0 && gd[1] === 0 && gd[2] === 0) continue;
      const hg = space.getHash(
        nVoxel,
        posX + gd[0],
        posY + gd[1],
        posZ + gd[2],
      );
      const nl = space.lightCache[hg];
      if (nl <= 0) continue;
      const ns = lightData.getS(nl);
      const nr = lightData.getR(nl);
      const ng = lightData.getG(nl);
      const nb = lightData.getB(nl);
      if (s < ns) s = ns;
      if (r < nr) r = nr;
      if (g < ng) g = ng;
      if (b < nb) b = nb;
    }

    worldLight.vertices[v] = lightData.createLightValue(s, r, g, b);

    // AO: count solid, full-block neighbors in the hemisphere of the normal,
    // biased toward this vertex's direction
    let aoCount = 0;
    for (let ni = 0; ni < NEIGHBOR_OFFSETS.length; ni++) {
      const np = NEIGHBOR_OFFSETS[ni];
      // Dot product with quad normal — only sample the hemisphere
      const dot = np[0] * nx + np[1] * ny + np[2] * nz;
      if (dot < 0.25) continue;

      // Further bias toward this vertex's outward direction
      const vertexDot = np[0] * bx + np[1] * by + np[2] * bz;
      if (vertexDot < 0) continue;

      const hashed = space.getHash(
        nVoxel,
        posX + np[0],
        posY + np[1],
        posZ + np[2],
      );

      if (foundHash[hashed] < 2 || noCastAO[hashed] === 1) continue;
      if (!space.fullBlock[hashed]) continue;

      if (++aoCount >= 3) break;
    }

    worldAO.vertices[v] = aoCount;
  }
}
