import { Vec3Array, Vector3Like } from "@amodx/math";
import { Quad } from "../../../../../Geometry/Primitives/Quad";
import { addVoxelQuad } from "../../../../Geometry/VoxelGeometryBuilder";
import { VoxelMeshVertexConstants } from "../../../../Geometry/VoxelMeshVertexStructCursor";
import { VoxelModelBuilder } from "../../../VoxelModelBuilder";
import { VoxelFaces, VoxelFaceDirections } from "../../../../../../Math";
import { VoxelTagIds } from "../../../../../../Voxels/Data/VoxelTag.types";
import { VoxelTagsRegister } from "../../../../../../Voxels/Data/VoxelTagsRegister";
import { EngineSettings } from "../../../../../../Settings/EngineSettings";
import { GetTexture } from "../../../Common/GetTexture";
import { QuadVerticies } from "../../../../../Geometry/Geometry.types";

// ------------------------------------------------------------------
//  Constants
// ------------------------------------------------------------------
const STRIDE = VoxelMeshVertexConstants.VertexFloatSize; // 28

/** Max pull displacement in voxel-space units. */
const MAX_PULL = 0.45;

/** Base pull scale factor (adhesion drives this much extra pull). */
const PULL_SCALE = 0.5;

/** Gravity bias scale for adhesive materials (visible droop). */
const GRAVITY_BIAS = 0.5;

/**
 * Base outward bulge along face normal for organic surfaces.
 * Moderate value — enough curvature to break the cubic silhouette
 * without distorting geometry or opening gaps. 0.25 = 25% of a voxel.
 */
const BASE_BULGE = 0.24;

/** Displacement scale for edge-midpoint sub-vertices (vs 1.0 for interior).
 * High value ensures strong curvature at block boundaries — visually fuses adjacent blocks. */
const EDGE_DISPLACE_FACTOR = 0.82;

/** Displacement scale for corner sub-vertices — shared by up to 4 adjacent voxels. */
const CORNER_DISPLACE_FACTOR = 0.52;

/** Depression scale for air-exposed edges/corners (pulls INWARD below surface).
 * Set to 0 to keep exposed edge vertices at the block boundary — prevents visible
 * seams/gaps at mixed-type block boundaries (stone/water, stone/sand, etc.).
 * The organic pillow effect is preserved via EDGE_DISPLACE_FACTOR on inter-voxel edges. */
const AIR_DEPRESS_FACTOR = 0.0;
// R06: AO ray directions for vertex-baked ambient occlusion.
// 5 short downward/diagonal rays cast into the voxel grid per sub-vertex.
// Covers the hemisphere most relevant for organic ground-facing surfaces.
const AO_RAY_DIRS: readonly [number, number, number][] = [
  [0, -1,  0],  // straight down
  [1, -1,  0],  // diagonal SE
  [-1, -1,  0], // diagonal SW
  [0, -1,  1],  // diagonal SN
  [0, -1, -1],  // diagonal SS
];
/** Cardinal direction offsets — MUST match VoxelFaces enum order:
 *  0=Up, 1=Down, 2=North, 3=South, 4=East, 5=West */
const cardinalOffsets: readonly [number, number, number][] = [
  [0, 1, 0],   // 0 = Up
  [0, -1, 0],  // 1 = Down
  [0, 0, 1],   // 2 = North
  [0, 0, -1],  // 3 = South
  [1, 0, 0],   // 4 = East
  [-1, 0, 0],  // 5 = West
];

// Reusable vectors to avoid allocation in hot loop
const _pullVector = Vector3Like.Create();

// ------------------------------------------------------------------
//  Edge adjacency table for gap-free edge pull direction blending.
//  For each face, stores which face shares each parametric edge:
//  [j=N (top), i=N (right), j=0 (bottom), i=0 (left)]
//  Both faces sharing an edge will pull their vertices along the
//  bisector of their normals — closing the gap between them.
// ------------------------------------------------------------------
const edgeAdjacency: readonly [VoxelFaces, VoxelFaces, VoxelFaces, VoxelFaces][] = [
  //                      [j=N (top),       i=N (right),      j=0 (bottom),     i=0 (left)]
  /* Up=0    */          [VoxelFaces.North, VoxelFaces.East,  VoxelFaces.South, VoxelFaces.West ],
  /* Down=1  */          [VoxelFaces.North, VoxelFaces.West,  VoxelFaces.South, VoxelFaces.East ],
  /* North=2 */          [VoxelFaces.Up,    VoxelFaces.East,  VoxelFaces.Down,  VoxelFaces.West ],
  /* South=3 */          [VoxelFaces.Up,    VoxelFaces.East,  VoxelFaces.Down,  VoxelFaces.West ],
  /* East=4  */          [VoxelFaces.Up,    VoxelFaces.North, VoxelFaces.Down,  VoxelFaces.South],
  /* West=5  */          [VoxelFaces.Up,    VoxelFaces.South, VoxelFaces.Down,  VoxelFaces.North],
];

// ------------------------------------------------------------------
//  Organic material tokens (same set as QuadVoxelGeometryNode)
// ------------------------------------------------------------------
const organicTokens = new Set([
  "grass",
  "dirt",
  "soil",
  "sand",
  "mud",
  "clay",
  "moss",
  "earth",
  "leaves",
  "vine",
  "wheat",
  "log",
  "wood",
  "stone",
  "gravel",
  "sandstone",
]);

const woodTokens = new Set(["log", "wood"]);
const sedimentaryRockTokens = new Set(["gravel", "sandstone"]);

// ------------------------------------------------------------------
//  Quílez-style noise with analytic derivatives for erosion fBM
//  ref: iquilezles.org/articles/morenoise
// ------------------------------------------------------------------
function noised(x: number, y: number, z: number): [number, number, number, number] {
  // Floor + fract
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;

  // Quintic interpolation + derivative
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const dux = 30 * fx * fx * (fx * (fx - 2) + 1);
  const duy = 30 * fy * fy * (fy * (fy - 2) + 1);
  const duz = 30 * fz * fz * (fz * (fz - 2) + 1);

  // Hash helper (integer → pseudo-random float)
  const h = (a: number, b: number, c: number) => {
    let n = ((a * 73856093) ^ (b * 19349663) ^ (c * 83492791)) | 0;
    n = ((n >> 13) ^ n);
    n = (n * (n * n * 15731 + 789221) + 1376312589) | 0;
    return (n & 0x7fffffff) / 0x7fffffff;
  };

  // 8 corner values
  const v000 = h(ix, iy, iz), v100 = h(ix + 1, iy, iz);
  const v010 = h(ix, iy + 1, iz), v110 = h(ix + 1, iy + 1, iz);
  const v001 = h(ix, iy, iz + 1), v101 = h(ix + 1, iy, iz + 1);
  const v011 = h(ix, iy + 1, iz + 1), v111 = h(ix + 1, iy + 1, iz + 1);

  // Trilinear + derivatives
  const k0 = v000, k1 = v100 - v000, k2 = v010 - v000, k3 = v001 - v000;
  const k4 = v000 - v100 - v010 + v110;
  const k5 = v000 - v010 - v001 + v011;
  const k6 = v000 - v100 - v001 + v101;
  const k7 = -v000 + v100 + v010 - v110 + v001 - v101 - v011 + v111;

  const val = k0 + k1 * ux + k2 * uy + k3 * uz + k4 * ux * uy + k5 * uy * uz + k6 * ux * uz + k7 * ux * uy * uz;
  const dx_ = dux * (k1 + k4 * uy + k6 * uz + k7 * uy * uz);
  const dy_ = duy * (k2 + k4 * ux + k5 * uz + k7 * ux * uz);
  const dz_ = duz * (k3 + k5 * uy + k6 * ux + k7 * ux * uy);

  return [val, dx_, dy_, dz_];
}

/**
 * Quílez erosion fBM with analytic derivative accumulation.
 * Slopes erode directionally: divide by (1 + dot(d,d)).
 * Returns erosion factor in [0.7 .. 1.3] range.
 */
function erosionFBM(px: number, py: number, pz: number, weathering: number): number {
  let a = 0;
  let b = 1;
  let dx = 0, dy = 0, dz = 0;
  const G = 0.5; // gain
  let sx = px * 0.7, sy = py * 0.7, sz = pz * 0.7;

  for (let i = 0; i < 3; i++) {
    const [val, ddx, ddy, ddz] = noised(sx, sy, sz);
    dx += ddx;
    dy += ddy;
    dz += ddz;
    a += b * val / (1 + dx * dx + dy * dy + dz * dz);
    b *= G;
    sx *= 2;
    sy *= 2;
    sz *= 2;
  }

  return 0.7 + a * 0.6 * (0.5 + weathering * 0.5);
}

// ------------------------------------------------------------------
//  Simple deterministic hash for grain direction per-voxel
// ------------------------------------------------------------------
function hash3f(x: number, y: number, z: number): Vec3Array {
  // fast integer-like hash producing pseudo-random direction
  let h = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
  h = ((h >> 13) ^ h) * 0x45d9f3b;
  const a = ((h & 0xff) / 127.5 - 1.0);
  const b = (((h >> 8) & 0xff) / 127.5 - 1.0);
  const c = (((h >> 16) & 0xff) / 127.5 - 1.0);
  const len = Math.sqrt(a * a + b * b + c * c) || 1;
  return [a / len, b / len, c / len];
}

// ------------------------------------------------------------------
//  Bilinear interpolation helpers
// ------------------------------------------------------------------
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function bilinearVec3(
  p00: Vec3Array,
  p10: Vec3Array,
  p01: Vec3Array,
  p11: Vec3Array,
  s: number,
  t: number,
  out: Vec3Array
): Vec3Array {
  out[0] = lerp(lerp(p00[0], p10[0], s), lerp(p01[0], p11[0], s), t);
  out[1] = lerp(lerp(p00[1], p10[1], s), lerp(p01[1], p11[1], s), t);
  out[2] = lerp(lerp(p00[2], p10[2], s), lerp(p01[2], p11[2], s), t);
  return out;
}

function bilinearUV(
  uv00: [number, number],
  uv10: [number, number],
  uv01: [number, number],
  uv11: [number, number],
  s: number,
  t: number
): [number, number] {
  return [
    lerp(lerp(uv00[0], uv10[0], s), lerp(uv01[0], uv11[0], s), t),
    lerp(lerp(uv00[1], uv10[1], s), lerp(uv01[1], uv11[1], s), t),
  ];
}

// ------------------------------------------------------------------
//  Pull target computation (same-material neighbor averaging)
// ------------------------------------------------------------------

interface PullConfig {
  adhesion: number;
  porosity: number;
  shearStrength: number;
  friction: number;
  ph: number;
  isWood: boolean;
  isSedimentaryRock: boolean;
}

/**
 * Compute the grain direction for anisotropic pull.
 * Wood → vertical (Y). Sedimentary rock → horizontal (XZ). Everything else → hash(pos).
 */
function getGrainDirection(
  config: PullConfig,
  px: number,
  py: number,
  pz: number
): Vec3Array {
  if (config.isWood) return [0, 1, 0];
  if (config.isSedimentaryRock) {
    const len = Math.SQRT1_2; // 1/√2
    return [len, 0, len];
  }
  return hash3f(px | 0, py | 0, pz | 0);
}

// ------------------------------------------------------------------
//  Helper: read a neighbour voxel's effective pull strength.
//  Used for Gaussian corner blending (Idea 2) — called ≤4 times per face.
// ------------------------------------------------------------------
function getNeighborPull(
  builder: VoxelModelBuilder,
  dx: number, dy: number, dz: number
): number {
  const pos = builder.position;
  const hashed = builder.space.getHash(builder.nVoxel, pos.x + dx, pos.y + dy, pos.z + dz);
  if (builder.space.foundHash[hashed] < 2) return 0;
  const neighborId = builder.space.trueVoxelCache[hashed];
  const tags = VoxelTagsRegister.VoxelTags[neighborId];
  if (!tags) return 0;
  const adhesion = (tags[VoxelTagIds.adhesion] as number) ?? 0;
  const shearStrength = (tags[VoxelTagIds.shearStrength] as number) ?? 100;
  const porosity = (tags[VoxelTagIds.porosity] as number) ?? 0;
  const densityFactor = 1 - Math.min(shearStrength / 5000, 0.6);
  const porosityBoost = 1.0 + porosity * 0.4;
  const intensityMult = (EngineSettings.settings.terrain as any).dissolutionIntensity ?? 1.0;
  return Math.min((BASE_BULGE + adhesion * PULL_SCALE * densityFactor) * porosityBoost * intensityMult, MAX_PULL);
}

// ------------------------------------------------------------------
//  Core: buildSubdividedFace
// ------------------------------------------------------------------
/**
 * Replaces a single quad with a subdivided grid (2×2 or 3×3)
 * with vertex pulling applied to interior sub-vertices.
 *
 * @param builder      - VoxelModelBuilder context
 * @param quad         - Original quad (4 corner positions + normals + UVs)
 * @param face         - Which face of the voxel (Up, North, etc.)
 * @param subdivLevel  - 2 for 2×2, 3 for 3×3
 * @param texture      - Texture arg for GetTexture
 * @param pullConfig   - Physics properties of this voxel
 * @param exposedFaces - Per-direction boolean: true = air/different material neighbour
 */
export function buildSubdividedFace(
  builder: VoxelModelBuilder,
  quad: Quad,
  face: VoxelFaces,
  subdivLevel: number,
  texture: any,
  pullConfig: PullConfig,
  exposedFaces: boolean[]
) {
  // R04: LOD — cap subdivision grid size by camera distance so distant sections use fewer triangles.
  // Camera position is supplied each frame via (EngineSettings.settings.terrain as any).lodCameraPos.
  let N = subdivLevel;
  {
    const lodCamPos: [number, number, number] | null =
      (EngineSettings.settings.terrain as any).lodCameraPos ?? null;
    if (lodCamPos) {
      const dx = builder.position.x - lodCamPos[0];
      const dy = builder.position.y - lodCamPos[1];
      const dz = builder.position.z - lodCamPos[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // dist > 96 → N capped at 1; dist > 48 → 2; dist > 16 → 3; nearer → no cap
      const maxNFromDist = dist > 96 ? 1 : dist > 48 ? 2 : dist > 16 ? 3 : N;
      N = Math.min(N, Math.max(maxNFromDist, 1));
    }
  }

  // Derive scalar edgeBoundary from per-direction exposure
  let _airCount = 0;
  for (let k = 0; k < 6; k++) if (exposedFaces[k]) _airCount++;
  const edgeBoundary = _airCount / 6;

  // Corner positions from the original quad (TopRight=0, TopLeft=1, BottomLeft=2, BottomRight=3)
  const p00 = quad.positions.toVec3Array()[2]; // BottomLeft
  const p10 = quad.positions.toVec3Array()[3]; // BottomRight
  const p01 = quad.positions.toVec3Array()[1]; // TopLeft
  const p11 = quad.positions.toVec3Array()[0]; // TopRight

  // Corner UVs
  const uv00: [number, number] = [
    quad.uvs.vertices[QuadVerticies.BottomLeft].x,
    quad.uvs.vertices[QuadVerticies.BottomLeft].y,
  ];
  const uv10: [number, number] = [
    quad.uvs.vertices[QuadVerticies.BottomRight].x,
    quad.uvs.vertices[QuadVerticies.BottomRight].y,
  ];
  const uv01: [number, number] = [
    quad.uvs.vertices[QuadVerticies.TopLeft].x,
    quad.uvs.vertices[QuadVerticies.TopLeft].y,
  ];
  const uv11: [number, number] = [
    quad.uvs.vertices[QuadVerticies.TopRight].x,
    quad.uvs.vertices[QuadVerticies.TopRight].y,
  ];

  // ------------------------------------------------------------------
  //  Compute pull parameters (shared for all sub-vertices of this face)
  // ------------------------------------------------------------------

  // Face normal direction — sub-vertices will bulge outward along this
  const faceNormal = VoxelFaceDirections[face];

  // Pull amount: base bulge + adhesion-driven bonus
  // shearStrength serves as density proxy — use gentler curve so even stone (150) gets significant pull
  const densityFactor = 1 - Math.min(pullConfig.shearStrength / 5000, 0.6);
  const intensityMult = (EngineSettings.settings.terrain as any).dissolutionIntensity ?? 1.0;
  // Porosity boost: porous materials (sand=0.4, snow=0.9) get extra curvature
  const porosityBoost = 1.0 + pullConfig.porosity * 0.4;
  // R01: Per-voxel bulge variation via world-position hash
  const voxX = builder.position.x | 0;
  const voxY = builder.position.y | 0;
  const voxZ = builder.position.z | 0;
  const bulgeHash = Math.abs(Math.sin(voxX * 12.9898 + voxY * 78.233 + voxZ * 45.164) * 43758.5453) % 1;
  const bulgeVariation = 0.7 + bulgeHash * 0.6; // range [0.7, 1.3]
  // Base bulge is always applied to every organic face for visible curvature
  const adhesionBonus = pullConfig.adhesion * PULL_SCALE * densityFactor;
  // totalPullBase: material-only pull (no per-block bulgeVariation hash).
  // Used at block-boundary vertices so both sides of a shared edge compute
  // the same displacement → zero-gap seams.
  const totalPullBase = Math.min((BASE_BULGE + adhesionBonus) * porosityBoost * intensityMult, MAX_PULL);
  // totalPull: adds per-block organic variation — used only for interior sub-vertices.
  const totalPull = Math.min((BASE_BULGE * bulgeVariation + adhesionBonus) * porosityBoost * intensityMult, MAX_PULL);

  // Grain direction for anisotropic pull
  const grainDir = getGrainDirection(
    pullConfig,
    builder.position.x,
    builder.position.y,
    builder.position.z
  );

  // subdivLevel encoded 0-1 for padding[11]: ramp with N
  // N=3 → 0.6, N=4 → 0.8, N=5 → 1.0
  const subdivLevelNorm = Math.min(N / 5, 1.0);

  // pH normalized (0-14 → 0-1) for padding[27]
  const phNorm = Math.min(pullConfig.ph / 14, 1);

  // pH erosion multiplier: acid (pH < 5) accelerates erosion
  const phErosionMult = pullConfig.ph < 5 ? 1 + (5 - pullConfig.ph) * 0.2 : 1;

  // Weathering factor from topExposure-like data
  // We approximate: edgeBoundary serves as exposure proxy
  const weathering = edgeBoundary;

  // ------------------------------------------------------------------
  //  Idea 1 — Asymmetric pillow constants (one set per face, not per vertex).
  //  dve_asymBiasS/T shift the interior bump peak off-centre via hash,
  //  so every block has a uniquely shaped bulge instead of a perfect pillow.
  //  pH drives curve sharpness: acid (low phNorm) → sharp power-ridge.
  //  High adhesion → gooey smoothstep mound (mud, clay, moss).
  // ------------------------------------------------------------------
  const dve_asymBiasS = Math.sin(voxX * 7.31 + voxZ * 13.17 + voxY * 3.7) * 0.50;  // [-0.5, +0.5]
  const dve_asymBiasT = Math.sin(voxZ * 11.73 + voxY * 5.31 + voxX * 19.1) * 0.50;
  const dve_phSharpness = 0.5 + (1.0 - phNorm) * 2.5; // 0.5 (pH14 pillow) … 3.0 (pH0 sharp ridge)
  const dve_isGooey = pullConfig.adhesion > 0.4;

  // ------------------------------------------------------------------
  //  Idea 2 — Gaussian corner blending: precompute pull of the 4 cardinal
  //  face-adjacent neighbours so corner sub-vertices can inherit pull from
  //  adjacent organic blocks, fusing geometry into continuous organic lobes.
  // ------------------------------------------------------------------
  const adj4 = edgeAdjacency[face];
  const _c0 = cardinalOffsets[adj4[0]];
  const _c1 = cardinalOffsets[adj4[1]];
  const _c2 = cardinalOffsets[adj4[2]];
  const _c3 = cardinalOffsets[adj4[3]];
  const adjPulls: number[] = [
    getNeighborPull(builder, _c0[0], _c0[1], _c0[2]),
    getNeighborPull(builder, _c1[0], _c1[1], _c1[2]),
    getNeighborPull(builder, _c2[0], _c2[1], _c2[2]),
    getNeighborPull(builder, _c3[0], _c3[1], _c3[2]),
  ];

  // ------------------------------------------------------------------
  //  Generate (N+1) × (N+1) grid of sub-vertex positions
  // ------------------------------------------------------------------
  const gridSize = N + 1;
  const subPositions: Vec3Array[] = new Array(gridSize * gridSize);
  const subUVs: [number, number][] = new Array(gridSize * gridSize);
  const subPullStrength: number[] = new Array(gridSize * gridSize);
  const subDissolutionProximity: number[] = new Array(gridSize * gridSize);
  const subVertAO: number[] = new Array(gridSize * gridSize); // R06
  const _pos: Vec3Array = [0, 0, 0];

  for (let j = 0; j < gridSize; j++) {
    const t = j / N;
    for (let i = 0; i < gridSize; i++) {
      const s = i / N;
      const idx = j * gridSize + i;

      bilinearVec3(p00, p10, p01, p11, s, t, _pos);
      const baseUV = bilinearUV(uv00, uv10, uv01, uv11, s, t);

      // R01: UV jitter for interior sub-vertices to break grid repetition
      const isCorner = (i === 0 || i === N) && (j === 0 || j === N);
      const isOnEdge = !isCorner && (i === 0 || i === N || j === 0 || j === N);
      if (!isCorner && !isOnEdge) {
        // Interior vertex — apply small UV jitter based on world position hash
        const wx = builder.position.x + _pos[0];
        const wz = builder.position.z + _pos[2];
        const jitterU = (Math.sin(wx * 37.17 + wz * 59.63) * 0.5 + 0.5 - 0.5) * 0.012;
        const jitterV = (Math.sin(wz * 43.29 + wx * 71.41) * 0.5 + 0.5 - 0.5) * 0.012;
        baseUV[0] += jitterU;
        baseUV[1] += jitterV;
      }
      subUVs[idx] = baseUV;

      // ----------------------------------------------------------
      //  Pull direction + displacement factor for continuity / depression
      //  - Inter-voxel edge/corner: pull along FACE NORMAL (both adjacent
      //    voxels agree → seamless join across voxel boundaries).
      //  - Air-exposed edge: pull along NEGATIVE BISECTOR (depression).
      //    Both faces of the same voxel compute the same bisector
      //    (A+B = B+A) → gap-free depressed ridge.
      //  - Air-exposed corner: pull along -faceNormal (depression).
      //  - Interior: full pillow displacement along faceNormal.
      // ----------------------------------------------------------
      const adj = edgeAdjacency[face];
      let displaceFactor: number;
      // activePull: pull used in the final displacement formula.
      // Interior vertices use totalPull (with hash variation);
      // boundary vertices use totalPullBase or neighbor-averaged value.
      let activePull = totalPull;
      let pullDirX = faceNormal[0];
      let pullDirY = faceNormal[1];
      let pullDirZ = faceNormal[2];
      // R16: Sedimentary rock (sandstone, gravel) uses sharper corners for angular
      // stratified appearance — rounded pillow factor 0.08 vs organic default 0.22.
      const dve_cornerFactor = pullConfig.isSedimentaryRock ? 0.08 : CORNER_DISPLACE_FACTOR;

      if (isCorner) {
        const jAdj = j === N ? adj[0] : adj[2];
        const iAdj = i === N ? adj[1] : adj[3];
        const jExp = exposedFaces[jAdj];
        const iExp = exposedFaces[iAdj];
        if (jExp && iExp) {
          // Fully air-exposed corner → depress
          displaceFactor = AIR_DEPRESS_FACTOR * 1.0;
          pullDirX = -faceNormal[0];
          pullDirY = -faceNormal[1];
          pullDirZ = -faceNormal[2];
        } else if (!jExp && !iExp) {
          // Inter-voxel corner: all 4 blocks sharing this corner must land at the
          // exact same vertex position.
          //
          // Direction: faceNormal only.
          //   Any bisector (3-way or otherwise) uses the SAME BLOCK's adjacent face
          //   directions (East, North...) — which are OPPOSITE (+X vs -X) when seen
          //   from the neighboring block. This creates symmetric divergence = gap.
          //   faceNormal is identical for all blocks sharing this corner. ✓
          //
          // Magnitude: equal-weight average of all 4 surrounding blocks' pulls.
          //   Block A: (A+B+C+D)/4; Block B: (B+A+D+C)/4 = same ✓
          const jAdjIdx = j === N ? 0 : 2;
          const iAdjIdx = i === N ? 1 : 3;
          const pullJ = adjPulls[jAdjIdx];
          const pullI = adjPulls[iAdjIdx];
          const jDir = cardinalOffsets[adj[jAdjIdx]];
          const iDir = cardinalOffsets[adj[iAdjIdx]];
          const pullD = getNeighborPull(builder, jDir[0] + iDir[0], jDir[1] + iDir[1], jDir[2] + iDir[2]);
          activePull = (totalPullBase + pullJ + pullI + pullD) * 0.25;
          displaceFactor = dve_cornerFactor;
          // pullDir stays as faceNormal (set at the top of the loop) — no change needed.
        } else {
          // Mixed corner: one neighbor air, one solid — apply half of corner factor.
          displaceFactor = dve_cornerFactor * 0.4;
          activePull = totalPullBase;
          // pullDir stays as faceNormal — neutral direction, no divergence.
        }
      } else if (isOnEdge) {
        let adjFace: VoxelFaces;
        if (j === N)      adjFace = adj[0];
        else if (i === N) adjFace = adj[1];
        else if (j === 0) adjFace = adj[2];
        else              adjFace = adj[3]; // i === 0

        if (exposedFaces[adjFace]) {
          // Air-exposed edge → depress along negative bisector
          displaceFactor = AIR_DEPRESS_FACTOR;
          const adjNormal = VoxelFaceDirections[adjFace];
          const bx = faceNormal[0] + adjNormal[0];
          const by = faceNormal[1] + adjNormal[1];
          const bz = faceNormal[2] + adjNormal[2];
          const bLen = Math.sqrt(bx * bx + by * by + bz * bz);
          if (bLen > 0.001) {
            pullDirX = -bx / bLen;
            pullDirY = -by / bLen;
            pullDirZ = -bz / bLen;
          } else {
            pullDirX = -faceNormal[0];
            pullDirY = -faceNormal[1];
            pullDirZ = -faceNormal[2];
          }
        } else {
          // Inter-voxel edge: pull along faceNormal only.
          //   A bisector normalize(faceNormal + East) from block A =  [+0.707, 0.707, 0]
          //   A bisector normalize(faceNormal + West) from block B = [-0.707, 0.707, 0]
          //   The X components DIVERGE → permanent gap.
          //   faceNormal = [0,1,0] from both sides → always same direction. ✓
          displaceFactor = EDGE_DISPLACE_FACTOR;
          // pullDir already set to faceNormal at the top of the loop — no change needed.
          const edgeAdjDir = cardinalOffsets[adjFace];
          const edgeNeighborPull = getNeighborPull(builder, edgeAdjDir[0], edgeAdjDir[1], edgeAdjDir[2]);
          activePull = (totalPullBase + edgeNeighborPull) * 0.5;
        }
      } else {
        // Interior vertex → full displacement
        displaceFactor = 1.0;
      }

      // Dissolution proximity: distance to nearest quad edge (0=center, 1=edge)
      // Edge sub-vertices have max proximity, interior have low proximity
      const edgeDistS = Math.min(s, 1 - s) * 2; // 0 at edges, 1 at center
      const edgeDistT = Math.min(t, 1 - t) * 2;
      const rawProximity = 1 - Math.min(edgeDistS, edgeDistT);
      // The face being rendered IS exposed to air. Sub-vertices at the face's
      // edges are literally AT the air boundary. Use a high base proximity
      // so shader effects (blue noise discard, erosion color, SSS, fresnel,
      // capillary band, splats) are clearly visible.
      // edgeBoundary boosts further for corner voxels (more exposed = more dissolution).
      const worldX = builder.position.x + _pos[0];
      const worldY = builder.position.y + _pos[1];
      const worldZ = builder.position.z + _pos[2];
      // Friction scales noise frequency — rough surfaces (friction=0.8) erode with larger features
      const frictionScale = 0.6 + pullConfig.friction * 0.8;
      const erosionFactor = erosionFBM(worldX * frictionScale, worldY * frictionScale, worldZ * frictionScale, weathering);
      // High base proximity so shader effects (dissolution, SSS, fresnel, capillary) always fire.
      // Porosity amplifies: porous materials dissolve MORE (snow=0.9 → 1.72× boost)
      const exposureFactor = 0.75 + edgeBoundary * 0.35;
      const porosityDissolveMult = 1.0 + pullConfig.porosity * 1.0;
      const dissolveProx = Math.min(
        Math.max(rawProximity * exposureFactor * erosionFactor * phErosionMult * porosityDissolveMult, 0),
        1
      );
      subDissolutionProximity[idx] = dissolveProx;

      // R06: Vertex-baked AO — cast short rays to count solid voxel neighbors.
      // worldX/Y/Z are the pre-pull positions; round to integer voxel coordinates.
      const aoVx = Math.round(worldX);
      const aoVy = Math.round(worldY);
      const aoVz = Math.round(worldZ);
      let aoOccluded = 0;
      for (let ri = 0; ri < AO_RAY_DIRS.length; ri++) {
        const [rdx, rdy, rdz] = AO_RAY_DIRS[ri];
        const hashed = builder.space.getHash(builder.nVoxel, aoVx + rdx, aoVy + rdy, aoVz + rdz);
        if (builder.space.foundHash[hashed] >= 2) aoOccluded++;
      }
      subVertAO[idx] = 1.0 - aoOccluded / AO_RAY_DIRS.length;

      if (displaceFactor > 0.001 && totalPull > 0.001) {
        // Outward bulge along face normal with noise variation
        // "Pillow" shape: max bulge at center of face, tapering to edges
        const centerDist = Math.min(edgeDistS, edgeDistT); // 0 at edge, 1 at center

      // Idea 1 — Asymmetric interior bulge: shift the pillow peak off-centre.
      // Bias is strongest at face centre (s=t=0.5), fades to 0 at edges so
      // edge/corner vertices always connect cleanly to neighbouring faces.
      let pillowSq: number;
      if (isOnEdge || isCorner) {
        pillowSq = 1.0;
      } else {
        const sBias = dve_asymBiasS * (0.5 - Math.abs(s - 0.5)) * 2.0;
        const tBias = dve_asymBiasT * (0.5 - Math.abs(t - 0.5)) * 2.0;
        const sShifted = Math.max(0.01, Math.min(0.99, s + sBias));
        const tShifted = Math.max(0.01, Math.min(0.99, t + tBias));
        const shiftedEdgeS = Math.min(sShifted, 1.0 - sShifted) * 2.0;
        const shiftedEdgeT = Math.min(tShifted, 1.0 - tShifted) * 2.0;
        const shiftedDist  = Math.min(shiftedEdgeS, shiftedEdgeT);
        let pf: number;
        if (dve_isGooey) {
          // High adhesion (mud, clay, moss): smoothstep full mound — no squared taper
          pf = shiftedDist * shiftedDist * (3.0 - 2.0 * shiftedDist);
        } else if (phNorm < 0.36) {
          // Acid material (pH < 5): sharp asymmetric power-curve ridge
          pf = Math.pow(Math.max(0.0, shiftedDist), dve_phSharpness);
        } else {
          // Default: smooth sin pillow (shifted)
          pf = Math.sin(shiftedDist * Math.PI * 0.5);
        }
        pillowSq = pf * pf;
      }

        // Per-vertex noise modulation for organic irregularity.
        // Boundary vertices use weathering=0 so noiseMod is purely world-position
        // based — both blocks sharing the edge will compute the same value.
        const noiseWeathering = (isOnEdge || isCorner) ? 0 : weathering;
        const noiseVal = erosionFBM(worldX * 2.3, worldY * 2.3, worldZ * 2.3, noiseWeathering);
        // noiseVal is in [0.7, 1.3]; remap to [0.5, 1.5] for more variation
        const noiseMod = (noiseVal - 0.7) / 0.6 * 1.0 + 0.5;

        const displacement = activePull * pillowSq * noiseMod * displaceFactor;

        // pullDir was already computed above (face normal, negative bisector, etc.)
        _pullVector.x = pullDirX * displacement;
        _pullVector.y = pullDirY * displacement;
        _pullVector.z = pullDirZ * displacement;

        // Gravity bias for adhesive materials — visible droop
        if (pullConfig.adhesion > 0.2) {
          _pullVector.y -= (pullConfig.adhesion - 0.2) * GRAVITY_BIAS * displacement;
        }

        // Anisotropic grain — mild modulation only (max 15% reduction)
        const pvLen = Math.sqrt(
          _pullVector.x * _pullVector.x +
            _pullVector.y * _pullVector.y +
            _pullVector.z * _pullVector.z
        );
        if (pvLen > 0.0001) {
          const pvNormX = _pullVector.x / pvLen;
          const pvNormY = _pullVector.y / pvLen;
          const pvNormZ = _pullVector.z / pvLen;
          const dot = Math.abs(
            pvNormX * grainDir[0] +
              pvNormY * grainDir[1] +
              pvNormZ * grainDir[2]
          );
          const grainFactor = dot * 0.15 + 0.85; // [0.85, 1.0] — minimal reduction
          _pullVector.x *= grainFactor;
          _pullVector.y *= grainFactor;
          _pullVector.z *= grainFactor;
        }

        _pos[0] += _pullVector.x;
        _pos[1] += _pullVector.y;
        _pos[2] += _pullVector.z;

        subPullStrength[idx] = Math.min(
          Math.sqrt(
            _pullVector.x * _pullVector.x +
              _pullVector.y * _pullVector.y +
              _pullVector.z * _pullVector.z
          ) / MAX_PULL,
          1.0
        );
      } else {
        subPullStrength[idx] = 0;
      }

      subPositions[idx] = [_pos[0], _pos[1], _pos[2]];
    }
  }

  // ------------------------------------------------------------------
  //  Vertex-averaged smooth normals
  //  Compute one face normal per sub-quad, then average at shared vertices.
  // ------------------------------------------------------------------
  const quadNormals: Vec3Array[] = new Array(N * N);
  const subNormals: Vec3Array[] = new Array(gridSize * gridSize);

  // Step 1: face normal per sub-quad (left-handed cross, same winding as Quad)
  for (let qj = 0; qj < N; qj++) {
    for (let qi = 0; qi < N; qi++) {
      const trI = (qj + 1) * gridSize + (qi + 1);
      const tlI = (qj + 1) * gridSize + qi;
      const blI = qj * gridSize + qi;

      const tr = subPositions[trI];
      const tl = subPositions[tlI];
      const bl = subPositions[blI];

      // vectorA = tl - tr, vectorB = bl - tr
      const ax = tl[0] - tr[0], ay = tl[1] - tr[1], az = tl[2] - tr[2];
      const bx = bl[0] - tr[0], by = bl[1] - tr[1], bz = bl[2] - tr[2];

      // cross(a, b) negated for left-handed
      let nx = -(ay * bz - az * by);
      let ny = -(az * bx - ax * bz);
      let nz = -(ax * by - ay * bx);

      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      quadNormals[qj * N + qi] = [nx / len, ny / len, nz / len];
    }
  }

  // Step 2: average normals at each grid vertex from its adjacent sub-quads
  for (let vj = 0; vj < gridSize; vj++) {
    for (let vi = 0; vi < gridSize; vi++) {
      let sx = 0, sy = 0, sz = 0;

      // Vertex (vi,vj) is shared by up to 4 quads:
      // BottomLeft of quad (vi, vj)
      if (vi < N && vj < N) { const n = quadNormals[vj * N + vi]; sx += n[0]; sy += n[1]; sz += n[2]; }
      // BottomRight of quad (vi-1, vj)
      if (vi > 0 && vj < N) { const n = quadNormals[vj * N + (vi - 1)]; sx += n[0]; sy += n[1]; sz += n[2]; }
      // TopLeft of quad (vi, vj-1)
      if (vi < N && vj > 0) { const n = quadNormals[(vj - 1) * N + vi]; sx += n[0]; sy += n[1]; sz += n[2]; }
      // TopRight of quad (vi-1, vj-1)
      if (vi > 0 && vj > 0) { const n = quadNormals[(vj - 1) * N + (vi - 1)]; sx += n[0]; sy += n[1]; sz += n[2]; }

      const len = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
      subNormals[vj * gridSize + vi] = [sx / len, sy / len, sz / len];
    }
  }

  // Step 3 (R10): Cross-boundary normal smoothing.
  // For each edge sub-vertex, blend its averaged normal 50/50 with the cardinal
  // normal of the adjacent face when that direction borders a SOLID voxel neighbour
  // (not exposed to air). This gives C0-continuous normals across voxel face boundaries
  // and eliminates the "quilted pillow" seam without extra vertex attributes.
  for (let vj = 0; vj < gridSize; vj++) {
    for (let vi = 0; vi < gridSize; vi++) {
      const onHEdge = vi === 0 || vi === N;
      const onVEdge = vj === 0 || vj === N;
      if (!onHEdge && !onVEdge) continue; // interior vertex — already smooth within face
      const adjTable = edgeAdjacency[face];
      const isCorner  = onHEdge && onVEdge;
      if (isCorner) {
        const jAdj = vj === N ? adjTable[0] : adjTable[2];
        const iAdj = vi === N ? adjTable[1] : adjTable[3];
        // Smooth only when BOTH adjacent directions border solid voxels
        if (exposedFaces[jAdj] || exposedFaces[iAdj]) continue;
        const cur = subNormals[vj * gridSize + vi];
        // Blend toward faceNormal (not adj face normals).
        // Both blocks sharing this corner compute the same blend target (faceNormal) →
        // corner normals converge to the same value from all sides. No shading seam. ✓
        let bx = cur[0] + faceNormal[0] * 2;
        let by = cur[1] + faceNormal[1] * 2;
        let bz = cur[2] + faceNormal[2] * 2;
        const bLen = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
        subNormals[vj * gridSize + vi] = [bx / bLen, by / bLen, bz / bLen];
      } else {
        // Pure edge vertex (exactly one edge direction applies)
        let adjFace: VoxelFaces;
        if      (vj === N) adjFace = adjTable[0];
        else if (vi === N) adjFace = adjTable[1];
        else if (vj === 0) adjFace = adjTable[2];
        else               adjFace = adjTable[3]; // vi === 0
        if (exposedFaces[adjFace]) continue; // air-exposed edge — keep depression, no smooth
        const cur  = subNormals[vj * gridSize + vi];
        // Blend toward faceNormal (same blend target from both sides of the block boundary).
        // Block A (right edge): normalize(localN_A + faceNormal) ≈ faceNormal
        // Block B (left edge):  normalize(localN_B + faceNormal) ≈ faceNormal
        // → both converge to the same normal → no shading crease. ✓
        let bx = cur[0] + faceNormal[0] * 2;
        let by = cur[1] + faceNormal[1] * 2;
        let bz = cur[2] + faceNormal[2] * 2;
        const bLen = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
        subNormals[vj * gridSize + vi] = [bx / bLen, by / bLen, bz / bLen];
      }
    }
  }

  // ------------------------------------------------------------------
  //  Generate N × N sub-quads
  // ------------------------------------------------------------------
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      //  topLeft -- topRight           (j+1)
      //  |             |
      //  botLeft - botRight            (j)
      //  (i)          (i+1)

      const blIdx = j * gridSize + i;
      const brIdx = j * gridSize + (i + 1);
      const tlIdx = (j + 1) * gridSize + i;
      const trIdx = (j + 1) * gridSize + (i + 1);

      // Create sub-quad in the engine's winding order:
      // [TopRight=0, TopLeft=1, BottomLeft=2, BottomRight=3]
      const subQuad = Quad.Create(
        [
          subPositions[trIdx], // TopRight
          subPositions[tlIdx], // TopLeft
          subPositions[blIdx], // BottomLeft
          subPositions[brIdx], // BottomRight
        ],
        [subUVs[trIdx], subUVs[tlIdx], subUVs[blIdx], subUVs[brIdx]]
      );

      // Override normals with vertex-averaged smooth normals
      subQuad.normals.set(
        Vector3Like.FromArray(subNormals[trIdx]),
        Vector3Like.FromArray(subNormals[tlIdx]),
        Vector3Like.FromArray(subNormals[blIdx]),
        Vector3Like.FromArray(subNormals[brIdx])
      );

      // Apply the texture
      GetTexture(builder, texture, face, subQuad);

      // Record vertex count before writing
      const baseVertex = builder.mesh.vertexCount;

      // Write sub-quad to mesh buffer
      addVoxelQuad(builder, subQuad);

      // Patch padding slots for the 4 vertices just written
      const vertIndices = [trIdx, tlIdx, blIdx, brIdx];

      for (let v = 0; v < 4; v++) {
        builder.mesh.buffer.setIndex(baseVertex + v);
        const arr = builder.mesh.buffer.currentArray;
        const floatBase = builder.mesh.buffer.curentIndex * STRIDE;

        arr[floatBase + 3] = subDissolutionProximity[vertIndices[v]];
        arr[floatBase + 7] = subPullStrength[vertIndices[v]];
        arr[floatBase + 11] = subdivLevelNorm;
        arr[floatBase + 17] = Math.min(pullConfig.adhesion, 1.0);
        arr[floatBase + 26] = subVertAO[vertIndices[v]]; // R06: vertex-baked AO
        arr[floatBase + 27] = phNorm;
      }

      builder.updateBounds(subQuad.bounds);
    }
  }
}

// ------------------------------------------------------------------
//  Public API: should this face be subdivided?
// ------------------------------------------------------------------

/**
 * Check if a voxel string ID is an organic material that qualifies for subdivision.
 */
export function isSubdivisionCandidate(stringId: string): boolean {
  return organicTokens.has(stringId) ||
    [...organicTokens].some((token) => stringId.includes(token));
}

/**
 * Get physics pull configuration for a voxel.
 */
export function getPullConfig(voxelId: number, stringId: string): PullConfig {
  const tags = VoxelTagsRegister.VoxelTags[voxelId];
  if (!tags) {
    return {
      adhesion: 0,
      porosity: 0,
      shearStrength: 100,
      friction: 0.5,
      ph: 7,
      isWood: false,
      isSedimentaryRock: false,
    };
  }
  return {
    adhesion: (tags[VoxelTagIds.adhesion] as number) ?? 0,
    porosity: (tags[VoxelTagIds.porosity] as number) ?? 0,
    shearStrength: (tags[VoxelTagIds.shearStrength] as number) ?? 100,
    friction: (tags[VoxelTagIds.friction] as number) ?? 0.5,
    ph: (tags[VoxelTagIds.ph] as number) ?? 7,
    isWood: woodTokens.has(stringId) ||
      [...woodTokens].some((token) => stringId.includes(token)),
    isSedimentaryRock: sedimentaryRockTokens.has(stringId) ||
      [...sedimentaryRockTokens].some((token) => stringId.includes(token)),
  };
}

/**
 * Determine the subdivision level for a given edgeBoundary value.
 * Since every rendered organic face is exposed to air, we always
 * subdivide at least 3×3. Corners/edges with more air neighbors get 4×4.
 * Highly isolated blocks (≥4 air faces, edgeBoundary > 0.8) get 5×5.
 */
export function getSubdivisionLevel(edgeBoundary: number): number {
  if (edgeBoundary > 0.8) return 5;  // 5×5: highly isolated blocks (≥4 air faces)
  if (edgeBoundary > 0.45) return 4; // 4×4: corner/edge voxels with multiple air faces
  return 3; // 3×3: standard exposed face (4 interior + 8 edge-mid vertices)
}

/**
 * Per-direction exposure: returns boolean[6] indicating which cardinal
 * neighbours are air or a different material. The rendered face itself
 * is always marked exposed (index === face).
 */
export function computeExposedFaces(builder: VoxelModelBuilder, face: VoxelFaces): boolean[] {
  const pos = builder.position;
  const space = builder.space;
  const nVoxel = builder.nVoxel;
  const currentId = builder.voxel.getVoxelId();

  const exposed: boolean[] = [false, false, false, false, false, false];
  exposed[face] = true; // the rendered face is always exposed

  for (let i = 0; i < 6; i++) {
    if (i === face) continue;
    const [dx, dy, dz] = cardinalOffsets[i];
    const hashed = space.getHash(nVoxel, pos.x + dx, pos.y + dy, pos.z + dz);
    if (space.foundHash[hashed] < 2 || space.trueVoxelCache[hashed] !== currentId) {
      exposed[i] = true;
    }
  }

  return exposed;
}

/**
 * Compute face-aware edge boundary.
 * The face being rendered is KNOWN to be exposed (face culling ensures this).
 * We count how many OTHER cardinal neighbors are also air/different material.
 * A face that is the only exposed side → edgeBoundary ~0.35 (still gets 2×2).
 * A corner voxel with 3+ air faces → edgeBoundary ~0.6+ (gets 3×3).
 *
 * @param builder - VoxelModelBuilder context
 * @param face    - The face being rendered (known to be exposed)
 */
export function computeEdgeBoundary(builder: VoxelModelBuilder, face: VoxelFaces): number {
  const pos = builder.position;
  const space = builder.space;
  const nVoxel = builder.nVoxel;
  const currentId = builder.voxel.getVoxelId();

  // Count how many of the OTHER 5 cardinal neighbors are different (air/other material)
  let airCount = 0;
  for (let i = 0; i < 6; i++) {
    // Skip the face direction itself — we know it's exposed
    if (i === face) continue;

    const [dx, dy, dz] = cardinalOffsets[i];
    const hashed = space.getHash(nVoxel, pos.x + dx, pos.y + dy, pos.z + dz);
    if (space.foundHash[hashed] < 2 || space.trueVoxelCache[hashed] !== currentId) {
      airCount++;
    }
  }

  // Base exposure from the rendered face itself (1/6 ≈ 0.167)
  // Plus contribution from other exposed faces
  // Formula: (1 + airCount) / 6
  // 0 other air faces → 1/6 = 0.167  (but we always subdivide 2×2 now)
  // 1 other air face  → 2/6 = 0.333
  // 2 other air faces → 3/6 = 0.5   (corner → 3×3)
  // 3+ other air faces → 4/6+ = 0.667+ (very exposed → 3×3)
  return (1 + airCount) / 6;
}
