import { Vector3Like, Vector2Like, Vector4Like } from "@amodx/math";
import { VoxelShaderData } from "./VoxelShaderData";
import { VoxelModelBuilder } from "../Models/VoxelModelBuilder";

import { Quad } from "../../Geometry/Primitives/Quad";
import { QuadVerticies } from "../../Geometry/Geometry.types";
import { VoxelMeshVertexConstants } from "./VoxelMeshVertexStructCursor";
import { Triangle } from "../../Geometry/Primitives";
import { DataCursorInterface } from "../../../Voxels/Cursor/DataCursor.interface";

const vector1ShaderData = Vector4Like.Create();
const vector2ShaderData = Vector4Like.Create();
const vector3ShaderData = Vector4Like.Create();
const vector4ShaderData = Vector4Like.Create();
const vector1Metadata = Vector4Like.Create();
const vector2Metadata = Vector4Like.Create();
const vector3Metadata = Vector4Like.Create();
const vector4Metadata = Vector4Like.Create();
const worldContextCache = { x: 0, y: 0, z: 0 };
const geometrySampleCache = { x: 0, y: 0, z: 0, height: 0 };

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function roundToVoxel(value: number) {
  return Math.floor(value + 0.5);
}

function getSamplingAnchor(
  builder: VoxelModelBuilder,
  averageSurfaceHeight: number,
) {
  if (builder.useSurfaceSamplePosition) {
    geometrySampleCache.x = roundToVoxel(builder.surfaceSamplePosition.x);
    geometrySampleCache.y = roundToVoxel(builder.surfaceSamplePosition.y);
    geometrySampleCache.z = roundToVoxel(builder.surfaceSamplePosition.z);
    geometrySampleCache.height = builder.surfaceSampleHeight;
    return geometrySampleCache;
  }

  geometrySampleCache.x = roundToVoxel(builder.position.x);
  geometrySampleCache.y = roundToVoxel(builder.position.y);
  geometrySampleCache.z = roundToVoxel(builder.position.z);
  geometrySampleCache.height = averageSurfaceHeight;
  return geometrySampleCache;
}

function computeShelter(
  nVoxel: DataCursorInterface,
  x: number,
  y: number,
  z: number
): number {
  let solidCount = 0;
  for (let dy = 1; dy <= 3; dy++) {
    const cursor = nVoxel.getVoxel(x, y + dy, z);
    if (cursor && cursor.isRenderable() && cursor.isOpaque()) solidCount++;
  }
  return solidCount / 3;
}

function computeHydrologySignal(
  builder: VoxelModelBuilder,
  x: number,
  y: number,
  z: number,
  shelter: number,
) {
  let directContact = 0;
  let retainedMoisture = 0;

  for (let dy = -1; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const neighbor = builder.nVoxel.getVoxel(x + dx, y + dy, z + dz);
        if (!neighbor || !neighbor.substanceTags["dve_is_liquid"]) continue;

        const horizontalDistance = Math.hypot(dx, dz);
        const distance = horizontalDistance + Math.abs(dy) * 0.8;
        const proximity = clamp01(1 - distance / 3.25);
        if (proximity <= 0) continue;

        const verticalBias = dy < 0 ? 0.78 : dy === 0 ? 1 : 0.62;
        directContact = Math.max(directContact, proximity * verticalBias);
        retainedMoisture += proximity * (0.05 + verticalBias * 0.08);
      }
    }
  }

  return clamp01(directContact * 0.74 + clamp01(retainedMoisture) * (0.22 + shelter * 0.18));
}

const cardinalOffsets: [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

function computeWorldContext(
  builder: VoxelModelBuilder,
  x: number,
  y: number,
  z: number,
  shelter: number,
): typeof worldContextCache {
  let opaqueCount = 0;
  let maxSun = 0;
  for (let i = 0; i < 6; i++) {
    const [dx, dy, dz] = cardinalOffsets[i];
    const neighbor = builder.nVoxel.getVoxel(x + dx, y + dy, z + dz);
    if (neighbor) {
      if (neighbor.isRenderable() && neighbor.isOpaque()) {
        opaqueCount++;
      } else {
        const light = neighbor.getLight();
        if (light >= 0) {
          const sun = light & 0xf;
          if (sun > maxSun) maxSun = sun;
        }
      }
    }
  }
  worldContextCache.x = maxSun / 15;
  worldContextCache.y = opaqueCount / 6;
  worldContextCache.z = computeHydrologySignal(builder, x, y, z, shelter);
  return worldContextCache;
}

function createSurfaceMetadata(
  normal: Vector3Like,
  aoValue: number,
  positionY: number,
  shelter: number,
  target: Vector4Like,
  avgNY: number = normal.y
) {
  const topExposure = clamp01(avgNY);
  const slope = clamp01(1 - Math.abs(avgNY));
  const rawCavity = clamp01(aoValue / 3);
  const cavity = clamp01(rawCavity * 0.7 + shelter * 0.3);
  const heightNorm = clamp01((positionY - 16) / 112);
  target.x = topExposure;
  target.y = slope;
  target.z = cavity;
  target.w = heightNorm;
  return target;
}

export function addVoxelTriangle(builder: VoxelModelBuilder, tri: Triangle) {
  if (!builder.mesh) return;

  const origin = builder.origin;
  const worldLight = builder.vars.light;
  const worldAO = builder.vars.ao;
  const animData = builder.vars.animation;
  const texture = builder.vars.textureIndex;
  const overlayTextures = builder.vars.overlayTextures;
  const topRightPos = tri.positions.vertices[0];
  const topLeftPos = tri.positions.vertices[1];
  const bottomLeftPos = tri.positions.vertices[2];

  const topRightNor = tri.normals.vertices[0];
  const topLeftNor = tri.normals.vertices[1];
  const bottomLeftNor = tri.normals.vertices[2];
  const averageWorldY =
    (topRightPos.y + topLeftPos.y + bottomLeftPos.y) / 3 + origin.y;
  const sample = getSamplingAnchor(builder, averageWorldY);
  const posY = sample.height;
  const shelter = computeShelter(builder.nVoxel, sample.x, sample.y, sample.z);
  const wctx = computeWorldContext(builder, sample.x, sample.y, sample.z, shelter);

  const topRightVoxelData = VoxelShaderData.create(
    worldLight.vertices[QuadVerticies.TopRight],
    worldLight.vertices[QuadVerticies.TopLeft],
    worldLight.vertices[QuadVerticies.BottomLeft],
    worldLight.vertices[QuadVerticies.BottomRight],
    worldAO.vertices[QuadVerticies.TopRight],
    worldAO.vertices[QuadVerticies.TopLeft],
    worldAO.vertices[QuadVerticies.BottomLeft],
    worldAO.vertices[QuadVerticies.BottomRight],
    animData.vertices[QuadVerticies.TopRight],
    QuadVerticies.TopRight,
    vector1ShaderData
  );
  const _triAvgNY = (topRightNor.y + topLeftNor.y + bottomLeftNor.y) / 3;
  const _triAvgAO =
    (worldAO.vertices[QuadVerticies.TopRight] +
      worldAO.vertices[QuadVerticies.TopLeft] +
      worldAO.vertices[QuadVerticies.BottomLeft]) /
    3;
  const topRightMetadata = createSurfaceMetadata(
    topRightNor,
    _triAvgAO,
    posY,
    shelter,
    vector1Metadata,
    _triAvgNY
  );
  const topLeftVoxelData = VoxelShaderData.create(
    worldLight.vertices[QuadVerticies.TopRight],
    worldLight.vertices[QuadVerticies.TopLeft],
    worldLight.vertices[QuadVerticies.BottomLeft],
    worldLight.vertices[QuadVerticies.BottomRight],
    worldAO.vertices[QuadVerticies.TopRight],
    worldAO.vertices[QuadVerticies.TopLeft],
    worldAO.vertices[QuadVerticies.BottomLeft],
    worldAO.vertices[QuadVerticies.BottomRight],
    animData.vertices[QuadVerticies.TopLeft],
    QuadVerticies.TopLeft,
    vector2ShaderData
  );
  const topLeftMetadata = createSurfaceMetadata(
    topLeftNor,
    _triAvgAO,
    posY,
    shelter,
    vector2Metadata,
    _triAvgNY
  );
  const bottomLeftVoxelData = VoxelShaderData.create(
    worldLight.vertices[QuadVerticies.TopRight],
    worldLight.vertices[QuadVerticies.TopLeft],
    worldLight.vertices[QuadVerticies.BottomLeft],
    worldLight.vertices[QuadVerticies.BottomRight],
    worldAO.vertices[QuadVerticies.TopRight],
    worldAO.vertices[QuadVerticies.TopLeft],
    worldAO.vertices[QuadVerticies.BottomLeft],
    worldAO.vertices[QuadVerticies.BottomRight],
    animData.vertices[QuadVerticies.BottomLeft],
    QuadVerticies.BottomLeft,
    vector3ShaderData
  );
  const bottomLeftMetadata = createSurfaceMetadata(
    bottomLeftNor,
    _triAvgAO,
    posY,
    shelter,
    vector3Metadata,
    _triAvgNY
  );

  const indices = builder.mesh!.indices;
  let indIndex = builder.mesh.indicieCount;
  let sides = tri.doubleSided ? 2 : 1;

  const baseIndex = builder.mesh.vertexCount;

  while (sides--) {
    const baseIndex = builder.mesh.vertexCount;
    builder.mesh.buffer.setIndex(baseIndex);
    addVertex(
      builder.mesh.buffer.curentIndex,
      builder.mesh.buffer.currentArray,
      origin,
      topRightPos,
      topRightNor,
      tri.uvs.vertices[QuadVerticies.TopRight],
      topRightVoxelData,
      topRightMetadata,
      wctx,
      texture,
      overlayTextures
    );

    builder.mesh.buffer.setIndex(baseIndex + 1);
    addVertex(
      builder.mesh.buffer.curentIndex,
      builder.mesh.buffer.currentArray,
      origin,
      topLeftPos,
      topLeftNor,
      tri.uvs.vertices[QuadVerticies.TopLeft],
      topLeftVoxelData,
      topLeftMetadata,
      wctx,
      texture,
      overlayTextures
    );
    builder.mesh.buffer.setIndex(baseIndex + 2);
    addVertex(
      builder.mesh.buffer.curentIndex,
      builder.mesh.buffer.currentArray,
      origin,
      bottomLeftPos,
      bottomLeftNor,
      tri.uvs.vertices[QuadVerticies.BottomLeft],
      bottomLeftVoxelData,
      bottomLeftMetadata,
      wctx,
      texture,
      overlayTextures
    );

    builder.mesh.addVerticies(3, 3);
  }
  if (!tri.doubleSided) {
    let index = baseIndex;
    indices.setIndex(indIndex).currentArray[indices.curentIndex] = index;
    indices.setIndex(indIndex + 1).currentArray[indices.curentIndex] =
      index + 1;
    indices.setIndex(indIndex + 2).currentArray[indices.curentIndex] =
      index + 2;
  } else {
    let index = baseIndex;
    indices.setIndex(indIndex).currentArray[indices.curentIndex] = index;
    indices.setIndex(indIndex + 1).currentArray[indices.curentIndex] =
      index + 1;
    indices.setIndex(indIndex + 2).currentArray[indices.curentIndex] =
      index + 2;
    index += 3;
    indIndex += 3;
    indices.setIndex(indIndex).currentArray[indices.curentIndex] = index + 3;
    indices.setIndex(indIndex + 1).currentArray[indices.curentIndex] =
      index + 2;
    indices.setIndex(indIndex + 2).currentArray[indices.curentIndex] =
      index + 1;
  }

  builder.vars.reset();
}

export function addVoxelQuad(
  builder: VoxelModelBuilder,
  quad: Quad,
  targetBuilder: VoxelModelBuilder = builder
) {
  if (!targetBuilder.mesh) return;

  const origin = builder.origin;
  const worldLight = builder.vars.light;
  const worldAO = builder.vars.ao;
  const animData = builder.vars.animation;
  const texture = builder.vars.textureIndex;
  const overlayTextures = builder.vars.overlayTextures;
  const topRightPos = quad.positions.vertices[0];
  const topLeftPos = quad.positions.vertices[1];
  const bottomLeftPos = quad.positions.vertices[2];
  const bottomRightPos = quad.positions.vertices[3];
  const topRightNor = quad.normals.vertices[0];
  const topLeftNor = quad.normals.vertices[1];
  const bottomLeftNor = quad.normals.vertices[2];
  const bottomRightNor = quad.normals.vertices[3];
  const averageWorldY =
    (topRightPos.y + topLeftPos.y + bottomLeftPos.y + bottomRightPos.y) / 4 +
    origin.y;
  const sample = getSamplingAnchor(builder, averageWorldY);
  const posY = sample.height;
  const shelter = computeShelter(builder.nVoxel, sample.x, sample.y, sample.z);
  const wctx = computeWorldContext(builder, sample.x, sample.y, sample.z, shelter);
  const topRightVoxelData = VoxelShaderData.create(
    worldLight.vertices[QuadVerticies.TopRight],
    worldLight.vertices[QuadVerticies.TopLeft],
    worldLight.vertices[QuadVerticies.BottomLeft],
    worldLight.vertices[QuadVerticies.BottomRight],
    worldAO.vertices[QuadVerticies.TopRight],
    worldAO.vertices[QuadVerticies.TopLeft],
    worldAO.vertices[QuadVerticies.BottomLeft],
    worldAO.vertices[QuadVerticies.BottomRight],
    animData.vertices[QuadVerticies.TopRight],
    QuadVerticies.TopRight,
    vector1ShaderData
  );
  const topLeftVoxelData = VoxelShaderData.create(
    worldLight.vertices[QuadVerticies.TopRight],
    worldLight.vertices[QuadVerticies.TopLeft],
    worldLight.vertices[QuadVerticies.BottomLeft],
    worldLight.vertices[QuadVerticies.BottomRight],
    worldAO.vertices[QuadVerticies.TopRight],
    worldAO.vertices[QuadVerticies.TopLeft],
    worldAO.vertices[QuadVerticies.BottomLeft],
    worldAO.vertices[QuadVerticies.BottomRight],
    animData.vertices[QuadVerticies.TopLeft],
    QuadVerticies.TopLeft,
    vector2ShaderData
  );
  const bottomLeftVoxelData = VoxelShaderData.create(
    worldLight.vertices[QuadVerticies.TopRight],
    worldLight.vertices[QuadVerticies.TopLeft],
    worldLight.vertices[QuadVerticies.BottomLeft],
    worldLight.vertices[QuadVerticies.BottomRight],
    worldAO.vertices[QuadVerticies.TopRight],
    worldAO.vertices[QuadVerticies.TopLeft],
    worldAO.vertices[QuadVerticies.BottomLeft],
    worldAO.vertices[QuadVerticies.BottomRight],
    animData.vertices[QuadVerticies.BottomLeft],
    QuadVerticies.BottomLeft,
    vector3ShaderData
  );
  const bottomRightVoxelData = VoxelShaderData.create(
    worldLight.vertices[QuadVerticies.TopRight],
    worldLight.vertices[QuadVerticies.TopLeft],
    worldLight.vertices[QuadVerticies.BottomLeft],
    worldLight.vertices[QuadVerticies.BottomRight],
    worldAO.vertices[QuadVerticies.TopRight],
    worldAO.vertices[QuadVerticies.TopLeft],
    worldAO.vertices[QuadVerticies.BottomLeft],
    worldAO.vertices[QuadVerticies.BottomRight],
    animData.vertices[QuadVerticies.BottomRight],
    QuadVerticies.BottomRight,
    vector4ShaderData
  );
  // Use quad-average AO and quad-average normal.y for all 4 metadata vertices
  // so that dveMetadata.x (topExposure), .y (slope), and .z (cavity) are
  // uniform across the quad and do not produce a diagonal interpolation seam.
  const _avgQuadAO =
    (worldAO.vertices[QuadVerticies.TopRight] +
      worldAO.vertices[QuadVerticies.TopLeft] +
      worldAO.vertices[QuadVerticies.BottomLeft] +
      worldAO.vertices[QuadVerticies.BottomRight]) /
    4;
  const _avgNY =
    (topRightNor.y + topLeftNor.y + bottomLeftNor.y + bottomRightNor.y) / 4;
  const topRightMetadata = createSurfaceMetadata(
    topRightNor,
    _avgQuadAO,
    posY,
    shelter,
    vector1Metadata,
    _avgNY
  );
  const topLeftMetadata = createSurfaceMetadata(
    topLeftNor,
    _avgQuadAO,
    posY,
    shelter,
    vector2Metadata,
    _avgNY
  );
  const bottomLeftMetadata = createSurfaceMetadata(
    bottomLeftNor,
    _avgQuadAO,
    posY,
    shelter,
    vector3Metadata,
    _avgNY
  );
  const bottomRightMetadata = createSurfaceMetadata(
    bottomRightNor,
    _avgQuadAO,
    posY,
    shelter,
    vector4Metadata,
    _avgNY
  );
  const indices = targetBuilder.mesh!.indices;
  let indIndex = targetBuilder.mesh.indicieCount;

  const baseIndex = targetBuilder.mesh.vertexCount;
  targetBuilder.mesh.buffer.setIndex(baseIndex);
  addVertex(
    targetBuilder.mesh.buffer.curentIndex,
    targetBuilder.mesh.buffer.currentArray,
    origin,
    topRightPos,
    topRightNor,
    quad.uvs.vertices[QuadVerticies.TopRight],
    topRightVoxelData,
    topRightMetadata,
    wctx,
    texture,
    overlayTextures
  );

  targetBuilder.mesh.buffer.setIndex(baseIndex + 1);
  addVertex(
    targetBuilder.mesh.buffer.curentIndex,
    targetBuilder.mesh.buffer.currentArray,
    origin,
    topLeftPos,
    topLeftNor,
    quad.uvs.vertices[QuadVerticies.TopLeft],
    topLeftVoxelData,
    topLeftMetadata,
    wctx,
    texture,
    overlayTextures
  );
  targetBuilder.mesh.buffer.setIndex(baseIndex + 2);
  addVertex(
    targetBuilder.mesh.buffer.curentIndex,
    targetBuilder.mesh.buffer.currentArray,
    origin,
    bottomLeftPos,
    bottomLeftNor,
    quad.uvs.vertices[QuadVerticies.BottomLeft],
    bottomLeftVoxelData,
    bottomLeftMetadata,
    wctx,
    texture,
    overlayTextures
  );
  targetBuilder.mesh.buffer.setIndex(baseIndex + 3);
  addVertex(
    targetBuilder.mesh.buffer.curentIndex,
    targetBuilder.mesh.buffer.currentArray,
    origin,
    bottomRightPos,
    bottomRightNor,
    quad.uvs.vertices[QuadVerticies.BottomRight],
    bottomRightVoxelData,
    bottomRightMetadata,
    wctx,
    texture,
    overlayTextures
  );

  indIndex = targetBuilder.mesh.indicieCount;

  // Voxel Flip Rule: choose the quad diagonal that minimises the AO/light
  // gradient discontinuity.  Each diagonal is the shared edge of its two
  // triangles; placing it where the brightness difference is smallest hides
  // the interpolation seam that would otherwise appear as a visible band.
  //
  // Primary diagonal:  V0(TopRight) — V2(BottomLeft)   → triangles [0,1,2] [2,3,0]
  // Alternate diagonal: V1(TopLeft) — V3(BottomRight)  → triangles [0,1,3] [1,2,3]
  //
  // We score each vertex as (ao * 4096 + light) so AO differences dominate
  // while light breaks ties.  If the alternate pair sum > primary pair sum,
  // flipping the diagonal places the "warmer" edge as the shared seam, which
  // matches the gradient direction and makes the seam invisible.
  const _aoTR = worldAO.vertices[QuadVerticies.TopRight];
  const _aoTL = worldAO.vertices[QuadVerticies.TopLeft];
  const _aoBL = worldAO.vertices[QuadVerticies.BottomLeft];
  const _aoBR = worldAO.vertices[QuadVerticies.BottomRight];
  const _lTR  = worldLight.vertices[QuadVerticies.TopRight];
  const _lTL  = worldLight.vertices[QuadVerticies.TopLeft];
  const _lBL  = worldLight.vertices[QuadVerticies.BottomLeft];
  const _lBR  = worldLight.vertices[QuadVerticies.BottomRight];
  const _bTR  = _aoTR * 4096 + _lTR;
  const _bTL  = _aoTL * 4096 + _lTL;
  const _bBL  = _aoBL * 4096 + _lBL;
  const _bBR  = _aoBR * 4096 + _lBR;
  // flip = true → use alternate diagonal (V1-V3)
  const _flipDiag = (_bTL + _bBR) > (_bTR + _bBL);

  if (!quad.doubleSided) {
    const index = baseIndex;
    if (!_flipDiag) {
      // Primary: [0,1,2], [2,3,0]
      indices.setIndex(indIndex    ).currentArray[indices.curentIndex] = index;
      indices.setIndex(indIndex + 1).currentArray[indices.curentIndex] = index + 1;
      indices.setIndex(indIndex + 2).currentArray[indices.curentIndex] = index + 2;
      indices.setIndex(indIndex + 3).currentArray[indices.curentIndex] = index + 2;
      indices.setIndex(indIndex + 4).currentArray[indices.curentIndex] = index + 3;
      indices.setIndex(indIndex + 5).currentArray[indices.curentIndex] = index;
    } else {
      // Alternate: [0,1,3], [1,2,3]
      indices.setIndex(indIndex    ).currentArray[indices.curentIndex] = index;
      indices.setIndex(indIndex + 1).currentArray[indices.curentIndex] = index + 1;
      indices.setIndex(indIndex + 2).currentArray[indices.curentIndex] = index + 3;
      indices.setIndex(indIndex + 3).currentArray[indices.curentIndex] = index + 1;
      indices.setIndex(indIndex + 4).currentArray[indices.curentIndex] = index + 2;
      indices.setIndex(indIndex + 5).currentArray[indices.curentIndex] = index + 3;
    }
    targetBuilder.mesh.addVerticies(4, 6);
  } else {
    const index = baseIndex;
    if (!_flipDiag) {
      // Primary front: [0,1,2], [2,3,0]
      indices.setIndex(indIndex    ).currentArray[indices.curentIndex] = index;
      indices.setIndex(indIndex + 1).currentArray[indices.curentIndex] = index + 1;
      indices.setIndex(indIndex + 2).currentArray[indices.curentIndex] = index + 2;
      indices.setIndex(indIndex + 3).currentArray[indices.curentIndex] = index + 2;
      indices.setIndex(indIndex + 4).currentArray[indices.curentIndex] = index + 3;
      indices.setIndex(indIndex + 5).currentArray[indices.curentIndex] = index;
      indIndex += 6;
      // Primary back (reversed winding): [0,3,2], [2,1,0]
      indices.setIndex(indIndex    ).currentArray[indices.curentIndex] = index;
      indices.setIndex(indIndex + 1).currentArray[indices.curentIndex] = index + 3;
      indices.setIndex(indIndex + 2).currentArray[indices.curentIndex] = index + 2;
      indices.setIndex(indIndex + 3).currentArray[indices.curentIndex] = index + 2;
      indices.setIndex(indIndex + 4).currentArray[indices.curentIndex] = index + 1;
      indices.setIndex(indIndex + 5).currentArray[indices.curentIndex] = index;
    } else {
      // Alternate front: [0,1,3], [1,2,3]
      indices.setIndex(indIndex    ).currentArray[indices.curentIndex] = index;
      indices.setIndex(indIndex + 1).currentArray[indices.curentIndex] = index + 1;
      indices.setIndex(indIndex + 2).currentArray[indices.curentIndex] = index + 3;
      indices.setIndex(indIndex + 3).currentArray[indices.curentIndex] = index + 1;
      indices.setIndex(indIndex + 4).currentArray[indices.curentIndex] = index + 2;
      indices.setIndex(indIndex + 5).currentArray[indices.curentIndex] = index + 3;
      indIndex += 6;
      // Alternate back (reversed winding): [0,3,1], [1,3,2]
      indices.setIndex(indIndex    ).currentArray[indices.curentIndex] = index;
      indices.setIndex(indIndex + 1).currentArray[indices.curentIndex] = index + 3;
      indices.setIndex(indIndex + 2).currentArray[indices.curentIndex] = index + 1;
      indices.setIndex(indIndex + 3).currentArray[indices.curentIndex] = index + 1;
      indices.setIndex(indIndex + 4).currentArray[indices.curentIndex] = index + 3;
      indices.setIndex(indIndex + 5).currentArray[indices.curentIndex] = index + 2;
    }
    targetBuilder.mesh.addVerticies(4, 12);
  }

  builder.vars.reset();
}

function addVertex(
  index: number,
  array: Float32Array,
  origin: Vector3Like,
  position: Vector3Like,
  normal: Vector3Like,
  uvs: Vector2Like,
  voxelData: Vector4Like,
  metadata: Vector4Like,
  worldContext: typeof worldContextCache,
  texture: number,
  overlayTextures: Vector4Like
) {
  index *= VoxelMeshVertexConstants.VertexFloatSize;
  array[VoxelMeshVertexConstants.PositionOffset + index] =
    position.x + origin.x;
  array[VoxelMeshVertexConstants.PositionOffset + index + 1] =
    position.y + origin.y;
  array[VoxelMeshVertexConstants.PositionOffset + index + 2] =
    position.z + origin.z;
  // Dissolution padding slots — must be 0 so the dissolution discard guard
  // (vDissolutionProximity > 0.01) never fires for non-organic regular quads.
  // SubdivisionBuilder overwrites these with real values for organic vertices.
  array[index + 3] = 0.0;  // dissolutionProximity
  array[index + 7] = 0.0;  // pullStrength
  array[index + 11] = 0.0; // subdivLevel
  array[index + 17] = 0.0; // pullDirectionBias

  array[VoxelMeshVertexConstants.UVOffset + index] = uvs.x;
  array[VoxelMeshVertexConstants.UVOffset + index + 1] = uvs.y;

  array[VoxelMeshVertexConstants.NormalOffset + index] = normal.x;
  array[VoxelMeshVertexConstants.NormalOffset + index + 1] = normal.y;
  array[VoxelMeshVertexConstants.NormalOffset + index + 2] = normal.z;

  array[VoxelMeshVertexConstants.TextureIndexOffset + index] =
    VoxelShaderData.createTextureIndex(texture, overlayTextures.x);
  array[VoxelMeshVertexConstants.TextureIndexOffset + index + 1] =
    VoxelShaderData.createTextureIndex(overlayTextures.y, overlayTextures.z);
  array[VoxelMeshVertexConstants.TextureIndexOffset + index + 2] =
    VoxelShaderData.createTextureIndex(overlayTextures.w, 0);

  array[VoxelMeshVertexConstants.ColorOffset + index] = worldContext.x;
  array[VoxelMeshVertexConstants.ColorOffset + index + 1] = worldContext.y;
  array[VoxelMeshVertexConstants.ColorOffset + index + 2] = worldContext.z;

  array[VoxelMeshVertexConstants.VoxelDataOFfset + index] = voxelData.x;
  array[VoxelMeshVertexConstants.VoxelDataOFfset + index + 1] = voxelData.y;
  array[VoxelMeshVertexConstants.VoxelDataOFfset + index + 2] = voxelData.z;
  array[VoxelMeshVertexConstants.VoxelDataOFfset + index + 3] = voxelData.w;

  array[VoxelMeshVertexConstants.MetadataOffset + index] = metadata.x;
  array[VoxelMeshVertexConstants.MetadataOffset + index + 1] = metadata.y;
  array[VoxelMeshVertexConstants.MetadataOffset + index + 2] = metadata.z;
  array[VoxelMeshVertexConstants.MetadataOffset + index + 3] = metadata.w;
  // subdivAO neutral sentinel: 0.5 maps smoothstep(0.1,0.9,0.5)→0.5 → dveMicroAO=1.0
  // (unchanged from pre-dissolution default). Subdivision quads override this in SubdivisionBuilder.
  array[index + 26] = 0.5;
}
