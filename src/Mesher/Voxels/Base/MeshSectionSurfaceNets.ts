import { LocationData } from "../../../Math";
import type { SetSectionMeshTask } from "../../Types/Mesher.types";
import { WorldSpaces } from "../../../World/WorldSpaces.js";
import { VoxelGeometryBuilderCacheSpace } from "../Models/VoxelGeometryBuilderCacheSpace.js";
import { SectionCursor } from "../../../World/Cursor/SectionCursor.js";
import { VoxelModelBuilder } from "../Models/VoxelModelBuilder.js";
import { VoxelMeshBVHBuilder } from "../Geometry/VoxelMeshBVHBuilder";
import { Vec3Array, Vector3Like } from "@amodx/math";
import { RenderedMaterials } from "../Models/RenderedMaterials";
import { CompactVoxelSectionMesh } from "./CompactVoxelSectionMesh";
import { DataCursorInterface } from "../../../Voxels/Cursor/DataCursor.interface";
import { VoxelLUT } from "../../../Voxels/Data/VoxelLUT";
import { GeometryLUT } from "../../../Voxels/Data/GeometryLUT";
import { Quad } from "../../Geometry/Primitives/Quad";
import { addVoxelQuad } from "../Geometry/VoxelGeometryBuilder";
import { EngineSettings } from "../../../Settings/EngineSettings";
import { VoxelFaces } from "../../../Math";
import { closestVoxelFace } from "../../../Math/UtilFunctions";
import { ShadeSurfaceNetsFace } from "../Models/Common/Faces/ShadeSurfaceNetsFace";
import { GetTexture } from "../Models/Common/GetTexture";
import { QuadVoxelGometryInputs } from "../Models/Nodes/Types/QuadVoxelGometryNodeTypes";
import { BaseVoxelGeometryTextureProcedureData } from "../Models/Procedures/TextureProcedure";

let space: VoxelGeometryBuilderCacheSpace;
const bvhTool = new VoxelMeshBVHBuilder();

const ArgIndexes = QuadVoxelGometryInputs.ArgIndexes;

function getIsoThreshold(): number {
  return EngineSettings.settings.terrain.surfaceNetsIsoLevel / 15;
}

// 8 corners of a 2x2x2 cube, starting from (0,0,0)
const CORNER_OFFSETS: [number, number, number][] = [
  [0, 0, 0], // 0
  [1, 0, 0], // 1
  [0, 1, 0], // 2
  [1, 1, 0], // 3
  [0, 0, 1], // 4
  [1, 0, 1], // 5
  [0, 1, 1], // 6
  [1, 1, 1], // 7
];

// Each of the 12 edges of the cube, defined as pairs of corner indices.
// Grouped by axis: edges 0-3 along X, 4-7 along Y, 8-11 along Z.
const EDGE_TABLE: [number, number][] = [
  [0, 1], [2, 3], [4, 5], [6, 7], // X-axis
  [0, 2], [1, 3], [4, 6], [5, 7], // Y-axis
  [0, 4], [1, 5], [2, 6], [3, 7], // Z-axis
];

// For each of the 3 axes, the 4 cells that share that axis-aligned edge.
const AXIS_QUADS: [number, number, number][][] = [
  // axis 0 = X: cells sharing edge at (x, y, z) along X
  [[0, 0, 0], [0, -1, 0], [0, -1, -1], [0, 0, -1]],
  // axis 1 = Y: cells sharing edge at (x, y, z) along Y
  [[0, 0, 0], [-1, 0, 0], [-1, 0, -1], [0, 0, -1]],
  // axis 2 = Z: cells sharing edge at (x, y, z) along Z
  [[0, 0, 0], [-1, 0, 0], [-1, -1, 0], [0, -1, 0]],
];

const AXIS_TO_FACE_POS: VoxelFaces[] = [
  VoxelFaces.East, VoxelFaces.Up, VoxelFaces.North,
];
const AXIS_TO_FACE_NEG: VoxelFaces[] = [
  VoxelFaces.West, VoxelFaces.Down, VoxelFaces.South,
];

const padding = Vector3Like.Create(5, 5, 5);
const emitQuad = Quad.Create();

// Reusable quad corner positions (Fix: avoid 4 array allocations per quad)
const _qPos: [Vec3Array, Vec3Array, Vec3Array, Vec3Array] = [
  [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0],
];

// --- Module-level reusable buffers (Fix #1: no per-call GC pressure) ---
let _densityGrid: Float32Array | null = null;
let _vertX: Float32Array | null = null;
let _vertY: Float32Array | null = null;
let _vertZ: Float32Array | null = null;
let _vertMat: Int16Array | null = null;
let _vertExists: Uint8Array | null = null;
let _lastDensitySize = 0;
let _lastVertSize = 0;

// Reusable array for corner densities (Fix #1: avoid per-cell allocation)
const _cornerDensities = new Float64Array(8);

function ensureBuffers(densitySize: number, vertSize: number) {
  if (densitySize > _lastDensitySize) {
    _densityGrid = new Float32Array(densitySize);
    _lastDensitySize = densitySize;
  }
  if (vertSize > _lastVertSize) {
    _vertX = new Float32Array(vertSize);
    _vertY = new Float32Array(vertSize);
    _vertZ = new Float32Array(vertSize);
    _vertMat = new Int16Array(vertSize);
    _vertExists = new Uint8Array(vertSize);
    _lastVertSize = vertSize;
  }
}

// Module-level index functions (Fix #2: no closure re-creation)
// Density grid: points from -1 to gridN → (gridN+2) per axis, stored at offset +1
// Cell vertex grid: cells from -1 to gridN-1 → (gridN+1) per axis, stored at offset +1
let _dpX = 0, _dpZ = 0; // density point strides
let _cvX = 0, _cvZ = 0; // cell vertex strides

function densityPointIndex(lx: number, ly: number, lz: number): number {
  return (ly + 1) * _dpX * _dpZ + (lx + 1) * _dpZ + (lz + 1);
}

function cellVertIndex(lx: number, ly: number, lz: number): number {
  return (ly + 1) * _cvX * _cvZ + (lx + 1) * _cvZ + (lz + 1);
}

/**
 * Look up the density at a world position via the cache space.
 * Returns 0.0 for air, level/15 for solid (default 1.0 if level==0 on solid).
 */
function getDensity(
  nVoxel: DataCursorInterface,
  x: number,
  y: number,
  z: number,
): number {
  const hashed = space.getHash(nVoxel, x, y, z);
  if (space.foundHash[hashed] < 2) return 0;
  return space.levelCache[hashed] / 15;
}

/**
 * Get the material index for a solid voxel at the given world position.
 */
function getMaterialIndex(
  nVoxel: DataCursorInterface,
  x: number,
  y: number,
  z: number,
): number {
  const hashed = space.getHash(nVoxel, x, y, z);
  if (space.foundHash[hashed] < 2) return -1;
  return VoxelLUT.materialMap[space.trueVoxelCache[hashed]];
}

/**
 * Resolve the texture index for a solid voxel via its geometry model.
 * Finds the compiled geometry node whose closestFace matches the given face,
 * then calls GetTexture with that node's texture arg.
 */
function resolveTexture(
  builder: VoxelModelBuilder,
  nVoxel: DataCursorInterface,
  solidX: number,
  solidY: number,
  solidZ: number,
  closestFace: VoxelFaces,
  quad: Quad,
): void {
  const trySetTexture = (textureArg: unknown) => {
    if (typeof textureArg === "number") {
      builder.vars.textureIndex = textureArg;
      return true;
    }

    if (!textureArg || typeof textureArg !== "object") {
      return false;
    }

    const procedureData = textureArg as BaseVoxelGeometryTextureProcedureData;
    if (typeof procedureData.type === "string") {
      GetTexture(builder, procedureData, closestFace, quad);
      return true;
    }

    if (typeof procedureData.texture === "number") {
      builder.vars.textureIndex = procedureData.texture;
      return true;
    }

    return false;
  };

  const hashed = space.getHash(nVoxel, solidX, solidY, solidZ);
  const trueVoxelId = space.trueVoxelCache[hashed];
  const voxelId = space.voxelCache[hashed];
  const relVoxelId = space.reltionalVoxelCache[hashed];
  if (!voxelId) {
    builder.vars.textureIndex = 0;
    return;
  }

  const tryGeometrySet = (
    geometryPaletteId: number,
    geometryInputPaletteId: number,
  ) => {
    const compiledNodes = GeometryLUT.compiledGeometry[geometryPaletteId];
    const nodeInputs = GeometryLUT.geometryInputs[geometryInputPaletteId];
    if (!compiledNodes || !nodeInputs) return false;

    for (let nodeIndex = 0; nodeIndex < compiledNodes.length; nodeIndex++) {
      const node = compiledNodes[nodeIndex];
      if (node.type !== "quad") continue;
      const args = nodeInputs[nodeIndex];
      if (!args) continue;
      if (
        node.closestFace === closestFace &&
        trySetTexture(args[ArgIndexes.Texture])
      ) {
        return true;
      }
    }

    for (let nodeIndex = 0; nodeIndex < compiledNodes.length; nodeIndex++) {
      const node = compiledNodes[nodeIndex];
      if (node.type !== "quad") continue;
      const args = nodeInputs[nodeIndex];
      if (!args) continue;
      if (trySetTexture(args[ArgIndexes.Texture])) {
        return true;
      }
    }

    return false;
  };

  const geometryStateIndex = VoxelLUT.getGeometryIndex(voxelId, relVoxelId);
  const geometryPaletteIds = GeometryLUT.geometryIndex[geometryStateIndex];
  const inputStateIndex = VoxelLUT.getGeometryInputIndex(voxelId, relVoxelId);
  const geometryInputPaletteIds = GeometryLUT.geometryInputsIndex[inputStateIndex];

  if (geometryPaletteIds && geometryInputPaletteIds) {
    for (
      let geometrySlot = 0;
      geometrySlot < geometryPaletteIds.length;
      geometrySlot++
    ) {
      if (
        tryGeometrySet(
          geometryPaletteIds[geometrySlot],
          geometryInputPaletteIds[geometrySlot],
        )
      ) {
        return;
      }
    }
  }

  const conditionalNodes = VoxelLUT.getConditionalGeometryNodes(
    VoxelLUT.modelsIndex[trueVoxelId],
  );
  if (conditionalNodes) {
    const modelState = VoxelLUT.voxelIdToState[voxelId];
    const relationalState = space.reltionalStateCache[hashed];

    for (let i = 0; i < conditionalNodes.length; i++) {
      const [geometryPaletteId, requiredModelState, requiredRelationalState] =
        conditionalNodes[i];
      if (
        requiredModelState !== modelState ||
        !requiredRelationalState[relationalState]
      ) {
        continue;
      }

      const conditionalInputStateIndex = VoxelLUT.getConditionalGeometryInputIndex(
        geometryPaletteId,
        voxelId,
        relVoxelId,
      );
      const conditionalGeometryPaletteIds =
        GeometryLUT.geometryIndex[geometryPaletteId];
      const conditionalGeometryInputPaletteIds =
        GeometryLUT.geometryInputsIndex[conditionalInputStateIndex];

      if (
        !conditionalGeometryPaletteIds ||
        !conditionalGeometryInputPaletteIds
      ) {
        continue;
      }

      for (
        let geometrySlot = 0;
        geometrySlot < conditionalGeometryPaletteIds.length;
        geometrySlot++
      ) {
        if (
          tryGeometrySet(
            conditionalGeometryPaletteIds[geometrySlot],
            conditionalGeometryInputPaletteIds[geometrySlot],
          )
        ) {
          return;
        }
      }
    }
  }

  builder.vars.textureIndex = 0;
}

export function MeshSectionSurfaceNets(
  worldCursor: DataCursorInterface,
  sectionCursor: SectionCursor,
  location: LocationData,
  transfers: any[] = [],
): SetSectionMeshTask | null {
  if (!space) {
    space = new VoxelGeometryBuilderCacheSpace({
      x: WorldSpaces.section.bounds.x + padding.x,
      y: WorldSpaces.section.bounds.y + padding.y,
      z: WorldSpaces.section.bounds.z + padding.z,
    });
  }

  const { x: cx, y: cy, z: cz } = sectionCursor._sectionPosition;
  const section = sectionCursor._section!;

  let [minY, maxY] = section.getMinMax();
  if (minY === Infinity && maxY === -Infinity) {
    section.setInProgress(false);
    return null;
  }

  space.start(
    cx - (padding.x - 1),
    cy - (padding.y - 1),
    cz - (padding.z - 1),
  );

  bvhTool.reset();
  const effects = {};
  for (let i = 0; i < RenderedMaterials.meshers.length; i++) {
    const mesher = RenderedMaterials.meshers[i];
    mesher.space = space;
    mesher.bvhTool = bvhTool;
    mesher.effects = effects;
  }

  const isoThreshold = getIsoThreshold();

  const gridX = WorldSpaces.section.bounds.x;
  const gridY = WorldSpaces.section.bounds.y;
  const gridZ = WorldSpaces.section.bounds.z;

  // Padded dimensions (Fix #4+#8: extend 1 cell into negative padding to
  // avoid discarding border quads whose AXIS_QUADS offsets reach cell -1).
  //
  // Density grid points: from -1 to gridN → (gridN + 2) per axis
  // Cell vertices:       from -1 to gridN-1 → (gridN + 1) per axis
  _dpX = gridX + 2;
  _dpZ = gridZ + 2;
  _cvX = gridX + 1;
  _cvZ = gridZ + 1;

  const densitySize = (gridX + 2) * (gridY + 2) * (gridZ + 2);
  const vertSize = (gridX + 1) * (gridY + 1) * (gridZ + 1);

  ensureBuffers(densitySize, vertSize);

  // Reset only the used portion of each buffer
  _densityGrid!.fill(0, 0, densitySize);
  _vertExists!.fill(0, 0, vertSize);
  _vertMat!.fill(-1, 0, vertSize);

  // --- Phase 0: Pre-compute density grid (Fix #3: no redundant getDensity) ---
  // Grid points span lx ∈ [-1, gridX], ly ∈ [-1, gridY], lz ∈ [-1, gridZ].
  for (let ly = -1; ly <= gridY; ly++) {
    for (let lx = -1; lx <= gridX; lx++) {
      for (let lz = -1; lz <= gridZ; lz++) {
        _densityGrid![densityPointIndex(lx, ly, lz)] = getDensity(
          worldCursor,
          cx + lx,
          cy + ly,
          cz + lz,
        );
      }
    }
  }

  // --- Phase 1: Compute surface vertices for each cell ---
  // Cells span lx ∈ [-1, gridX-1] (padded grid, Fix #4+#8).
  // Each cell queries 2×2×2 corners from the density grid.
  for (let ly = -1; ly < gridY; ly++) {
    for (let lx = -1; lx < gridX; lx++) {
      for (let lz = -1; lz < gridZ; lz++) {
        // Read 8 corner densities from the pre-computed grid
        for (let c = 0; c < 8; c++) {
          _cornerDensities[c] = _densityGrid![
            densityPointIndex(
              lx + CORNER_OFFSETS[c][0],
              ly + CORNER_OFFSETS[c][1],
              lz + CORNER_OFFSETS[c][2],
            )
          ];
        }

        // Corner mask: bit set if density >= threshold
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          if (_cornerDensities[c] >= isoThreshold) mask |= 1 << c;
        }

        // Skip uniform cells (entirely inside or entirely outside)
        if (mask === 0 || mask === 0xff) continue;

        // Average edge-crossing positions to find the surface vertex
        let sx = 0,
          sy = 0,
          sz = 0;
        let edgeCount = 0;

        for (let e = 0; e < 12; e++) {
          const [a, b] = EDGE_TABLE[e];
          const da = _cornerDensities[a];
          const db = _cornerDensities[b];
          if ((da >= isoThreshold) === (db >= isoThreshold)) continue;

          const t = (isoThreshold - da) / (db - da);
          const ca = CORNER_OFFSETS[a];
          const cb = CORNER_OFFSETS[b];
          sx += ca[0] + t * (cb[0] - ca[0]);
          sy += ca[1] + t * (cb[1] - ca[1]);
          sz += ca[2] + t * (cb[2] - ca[2]);
          edgeCount++;
        }

        if (edgeCount === 0) continue;

        const wx = cx + lx;
        const wy = cy + ly;
        const wz = cz + lz;

        const idx = cellVertIndex(lx, ly, lz);
        _vertX![idx] = wx + sx / edgeCount;
        _vertY![idx] = wy + sy / edgeCount;
        _vertZ![idx] = wz + sz / edgeCount;
        _vertExists![idx] = 1;

        // Material: pick from the densest solid corner
        let bestMat = -1;
        let bestDensity = 0;
        for (let c = 0; c < 8; c++) {
          if (_cornerDensities[c] > bestDensity) {
            bestDensity = _cornerDensities[c];
            const mat = getMaterialIndex(
              worldCursor,
              wx + CORNER_OFFSETS[c][0],
              wy + CORNER_OFFSETS[c][1],
              wz + CORNER_OFFSETS[c][2],
            );
            if (mat >= 0) bestMat = mat;
          }
        }
        _vertMat![idx] = bestMat;
      }
    }
  }

  // --- Phase 2: Emit quads at sign-change edges ---
  // For each cell in the section [0, gridN), check +X/+Y/+Z edges.
  // AXIS_QUADS offsets go to -1, which is now within the padded grid (Fix #4+#8).
  for (let ly = 0; ly < gridY; ly++) {
    for (let lx = 0; lx < gridX; lx++) {
      for (let lz = 0; lz < gridZ; lz++) {
        const d0 = _densityGrid![densityPointIndex(lx, ly, lz)];

        for (let axis = 0; axis < 3; axis++) {
          // Density at the +axis neighbor point
          const d1 = _densityGrid![
            densityPointIndex(
              lx + (axis === 0 ? 1 : 0),
              ly + (axis === 1 ? 1 : 0),
              lz + (axis === 2 ? 1 : 0),
            )
          ];

          const inside0 = d0 >= isoThreshold;
          const inside1 = d1 >= isoThreshold;
          if (inside0 === inside1) continue;

          // Gather the 4 cell vertices sharing this edge
          const quadCells = AXIS_QUADS[axis];
          let allExist = true;

          for (let q = 0; q < 4; q++) {
            const qi = cellVertIndex(
              lx + quadCells[q][0],
              ly + quadCells[q][1],
              lz + quadCells[q][2],
            );
            if (!_vertExists![qi]) {
              allExist = false;
              break;
            }
          }

          if (!allExist) continue;

          const wx = cx + lx;
          const wy = cy + ly;
          const wz = cz + lz;

          // Determine material from the solid side
          const solidX = inside0 ? wx : wx + (axis === 0 ? 1 : 0);
          const solidY = inside0 ? wy : wy + (axis === 1 ? 1 : 0);
          const solidZ = inside0 ? wz : wz + (axis === 2 ? 1 : 0);

          const matIndex = getMaterialIndex(worldCursor, solidX, solidY, solidZ);
          if (matIndex < 0) continue;

          const builder = RenderedMaterials.meshers[matIndex];
          if (!builder) continue;

          // Build quad positions (local to section origin)
          for (let q = 0; q < 4; q++) {
            const qi = cellVertIndex(
              lx + quadCells[q][0],
              ly + quadCells[q][1],
              lz + quadCells[q][2],
            );
            _qPos[q][0] = _vertX![qi] - cx;
            _qPos[q][1] = _vertY![qi] - cy;
            _qPos[q][2] = _vertZ![qi] - cz;
          }
          const positions = _qPos;

          // Flip winding when solid is on the +axis side
          if (!inside0) {
            const t0 = positions[1][0], t1 = positions[1][1], t2 = positions[1][2];
            positions[1][0] = positions[3][0]; positions[1][1] = positions[3][1]; positions[1][2] = positions[3][2];
            positions[3][0] = t0; positions[3][1] = t1; positions[3][2] = t2;
          }

          emitQuad.setPositions(positions);
          emitQuad.setUVs(Quad.FullUVs as any);
          emitQuad.doubleSided = false;

          const dominantFace = closestVoxelFace(emitQuad.normals.vertices[0]);

          builder.origin.x = 0;
          builder.origin.y = 0;
          builder.origin.z = 0;
          builder.position.x = wx;
          builder.position.y = wy;
          builder.position.z = wz;
          builder.nVoxel = worldCursor;

          const solidVoxel = worldCursor.getVoxel(solidX, solidY, solidZ);
          if (!solidVoxel) continue;
          builder.voxel = solidVoxel;

          // Reset light/AO before shading so each quad starts clean
          builder.vars.light.setAll(0);
          builder.vars.ao.setAll(0);

          // Shade the face (AO + lighting)
          ShadeSurfaceNetsFace(builder, dominantFace, positions);

          // Resolve texture from the voxel's geometry model (Fix #6)
          resolveTexture(
            builder,
            worldCursor,
            solidX,
            solidY,
            solidZ,
            dominantFace,
            emitQuad,
          );

          builder.startConstruction();
          addVoxelQuad(builder, emitQuad);
          builder.updateBounds(emitQuad.bounds);
          builder.endConstruction();
        }
      }
    }
  }

  // Phase 3: Collect and compact results
  const meshed: VoxelModelBuilder[] = [];
  for (let i = 0; i < RenderedMaterials.meshers.length; i++) {
    const mesher = RenderedMaterials.meshers[i];
    if (!mesher.mesh.vertexCount) {
      mesher.clear();
      mesher.bvhTool = null;
      continue;
    }
    const { min, max } = mesher.bvhTool!.getMeshBounds();
    mesher.mesh.minBounds.x = min[0];
    mesher.mesh.minBounds.y = min[1];
    mesher.mesh.minBounds.z = min[2];
    mesher.mesh.maxBounds.x = max[0];
    mesher.mesh.maxBounds.y = max[1];
    mesher.mesh.maxBounds.z = max[2];
    meshed.push(mesher);
  }

  const compactMesh = CompactVoxelSectionMesh(location, meshed, transfers);

  for (let i = 0; i < meshed.length; i++) {
    meshed[i].clear();
    meshed[i].bvhTool = null;
  }

  section.setInProgress(false);
  return compactMesh;
}
