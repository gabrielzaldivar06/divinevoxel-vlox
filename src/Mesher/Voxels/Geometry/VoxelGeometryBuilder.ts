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

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
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
  z: number
): typeof worldContextCache {
  let opaqueCount = 0;
  let sameIdCount = 0;
  let maxSun = 0;
  const currentId = builder.voxel.getVoxelId();
  for (let i = 0; i < 6; i++) {
    const [dx, dy, dz] = cardinalOffsets[i];
    const neighbor = builder.nVoxel.getVoxel(x + dx, y + dy, z + dz);
    if (neighbor) {
      if (neighbor.isRenderable() && neighbor.isOpaque()) {
        opaqueCount++;
        if (neighbor.getVoxelId() === currentId) sameIdCount++;
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
  worldContextCache.z = 1 - sameIdCount / 6;
  return worldContextCache;
}

function createSurfaceMetadata(
  normal: Vector3Like,
  aoValue: number,
  positionY: number,
  shelter: number,
  target: Vector4Like
) {
  const topExposure = clamp01(normal.y);
  const slope = clamp01(1 - Math.abs(normal.y));
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
  const posY = builder.position.y;
  const shelter = computeShelter(builder.nVoxel, builder.position.x, builder.position.y, builder.position.z);
  const wctx = computeWorldContext(builder, builder.position.x, builder.position.y, builder.position.z);
  const topRightPos = tri.positions.vertices[0];
  const topLeftPos = tri.positions.vertices[1];
  const bottomLeftPos = tri.positions.vertices[2];

  const topRightNor = tri.normals.vertices[0];
  const topLeftNor = tri.normals.vertices[1];
  const bottomLeftNor = tri.normals.vertices[2];

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
  const topRightMetadata = createSurfaceMetadata(
    topRightNor,
    worldAO.vertices[QuadVerticies.TopRight],
    posY,
    shelter,
    vector1Metadata
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
    worldAO.vertices[QuadVerticies.TopLeft],
    posY,
    shelter,
    vector2Metadata
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
    worldAO.vertices[QuadVerticies.BottomLeft],
    posY,
    shelter,
    vector3Metadata
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
  const posY = builder.position.y;
  const shelter = computeShelter(builder.nVoxel, builder.position.x, builder.position.y, builder.position.z);
  const wctx = computeWorldContext(builder, builder.position.x, builder.position.y, builder.position.z);
  const topRightPos = quad.positions.vertices[0];
  const topLeftPos = quad.positions.vertices[1];
  const bottomLeftPos = quad.positions.vertices[2];
  const bottomRightPos = quad.positions.vertices[3];
  const topRightNor = quad.normals.vertices[0];
  const topLeftNor = quad.normals.vertices[1];
  const bottomLeftNor = quad.normals.vertices[2];
  const bottomRightNor = quad.normals.vertices[3];
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
  const topRightMetadata = createSurfaceMetadata(
    topRightNor,
    worldAO.vertices[QuadVerticies.TopRight],
    posY,
    shelter,
    vector1Metadata
  );
  const topLeftMetadata = createSurfaceMetadata(
    topLeftNor,
    worldAO.vertices[QuadVerticies.TopLeft],
    posY,
    shelter,
    vector2Metadata
  );
  const bottomLeftMetadata = createSurfaceMetadata(
    bottomLeftNor,
    worldAO.vertices[QuadVerticies.BottomLeft],
    posY,
    shelter,
    vector3Metadata
  );
  const bottomRightMetadata = createSurfaceMetadata(
    bottomRightNor,
    worldAO.vertices[QuadVerticies.BottomRight],
    posY,
    shelter,
    vector4Metadata
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

  if (!quad.doubleSided) {
    let index = baseIndex;
    indices.setIndex(indIndex).currentArray[indices.curentIndex] = index;
    indices.setIndex(indIndex + 1).currentArray[indices.curentIndex] =
      index + 1;
    indices.setIndex(indIndex + 2).currentArray[indices.curentIndex] =
      index + 2;
    indices.setIndex(indIndex + 3).currentArray[indices.curentIndex] =
      index + 2;
    indices.setIndex(indIndex + 4).currentArray[indices.curentIndex] =
      index + 3;
    indices.setIndex(indIndex + 5).currentArray[indices.curentIndex] = index;
    targetBuilder.mesh.addVerticies(4, 6);
  } else {
    let index = baseIndex;
    indices.setIndex(indIndex).currentArray[indices.curentIndex] = index;
    indices.setIndex(indIndex + 1).currentArray[indices.curentIndex] =
      index + 1;
    indices.setIndex(indIndex + 2).currentArray[indices.curentIndex] =
      index + 2;
    indices.setIndex(indIndex + 3).currentArray[indices.curentIndex] =
      index + 2;
    indices.setIndex(indIndex + 4).currentArray[indices.curentIndex] =
      index + 3;
    indices.setIndex(indIndex + 5).currentArray[indices.curentIndex] = index;
    indIndex += 6;
    indices.setIndex(indIndex).currentArray[indices.curentIndex] = index;
    indices.setIndex(indIndex + 1).currentArray[indices.curentIndex] =
      index + 3;
    indices.setIndex(indIndex + 2).currentArray[indices.curentIndex] =
      index + 2;
    indices.setIndex(indIndex + 3).currentArray[indices.curentIndex] =
      index + 2;
    indices.setIndex(indIndex + 4).currentArray[indices.curentIndex] =
      index + 1;
    indices.setIndex(indIndex + 5).currentArray[indices.curentIndex] = index;
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
}
