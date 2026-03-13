import { Vec3Array, Vec4Array } from "@amodx/math";
import { VoxelFaces } from "../../../../../Math";
import { EngineSettings } from "../../../../../Settings/EngineSettings";
import { Quad } from "../../../../Geometry/Primitives/Quad";
import { addVoxelQuad } from "../../../Geometry/VoxelGeometryBuilder";
import { GeoemtryNode } from "../GeometryNode";
import {
  CompiledQuadVoxelGeometryNode,
  QuadVoxelGometryArgs,
  QuadVoxelGometryInputs,
} from "../Types/QuadVoxelGometryNodeTypes";
import { GetTexture } from "../../Common/GetTexture";
import { CullRulledFace } from "../../Common/Faces/CullRulledFace";
import { ShadeRulledFace } from "../../Common/Faces/ShadeRulledFace";
import { ShadeRulelessFace } from "../../Common/Faces/ShadeRulelessFace";
import { VoxelLUT } from "../../../../../Voxels/Data/VoxelLUT";
import {
  buildSubdividedFace,
  isSubdivisionCandidate,
  computeExposedFaces,
  getSubdivisionLevel,
  getPullConfig,
} from "../Custom/Subdivision/SubdivisionBuilder";

const ArgIndexes = QuadVoxelGometryInputs.ArgIndexes;

const transitionFaces = [
  {
    face: VoxelFaces.North,
    direction: "north" as const,
    offset: [0, 0, 1] as Vec3Array,
    edge: [0, 1] as const,
    diagonalOffsets: [[1, 0, 1], [-1, 0, 1]] as Vec3Array[],
  },
  {
    face: VoxelFaces.South,
    direction: "south" as const,
    offset: [0, 0, -1] as Vec3Array,
    edge: [3, 2] as const,
    diagonalOffsets: [[1, 0, -1], [-1, 0, -1]] as Vec3Array[],
  },
  {
    face: VoxelFaces.East,
    direction: "east" as const,
    offset: [1, 0, 0] as Vec3Array,
    edge: [0, 3] as const,
    diagonalOffsets: [[1, 0, 1], [1, 0, -1]] as Vec3Array[],
  },
  {
    face: VoxelFaces.West,
    direction: "west" as const,
    offset: [-1, 0, 0] as Vec3Array,
    edge: [1, 2] as const,
    diagonalOffsets: [[-1, 0, 1], [-1, 0, -1]] as Vec3Array[],
  },
];

const transitionCorners = [
  {
    diagonalOffset: [1, 0, 1] as Vec3Array,
    faceA: VoxelFaces.North,
    faceB: VoxelFaces.East,
    neighbors: [1, 3] as const,
    vertex: 0 as const,
  },
  {
    diagonalOffset: [-1, 0, 1] as Vec3Array,
    faceA: VoxelFaces.North,
    faceB: VoxelFaces.West,
    neighbors: [0, 2] as const,
    vertex: 1 as const,
  },
  {
    diagonalOffset: [-1, 0, -1] as Vec3Array,
    faceA: VoxelFaces.South,
    faceB: VoxelFaces.West,
    neighbors: [3, 1] as const,
    vertex: 2 as const,
  },
  {
    diagonalOffset: [1, 0, -1] as Vec3Array,
    faceA: VoxelFaces.South,
    faceB: VoxelFaces.East,
    neighbors: [2, 0] as const,
    vertex: 3 as const,
  },
];

const organicTransitionTokens = [
  "grass",
  "dirt",
  "soil",
  "sand",
  "mud",
  "clay",
  "rock",
  "stone",
  "gravel",
  "moss",
  "earth",
];

function copyPoint(point: Vec3Array): Vec3Array {
  return [point[0], point[1], point[2]];
}

function lerpPoint(a: Vec3Array, b: Vec3Array, alpha: number): Vec3Array {
  return [
    a[0] + (b[0] - a[0]) * alpha,
    a[1] + (b[1] - a[1]) * alpha,
    a[2] + (b[2] - a[2]) * alpha,
  ];
}

function getQuadCenter(points: [Vec3Array, Vec3Array, Vec3Array, Vec3Array]) {
  return [
    (points[0][0] + points[1][0] + points[2][0] + points[3][0]) / 4,
    (points[0][1] + points[1][1] + points[2][1] + points[3][1]) / 4,
    (points[0][2] + points[1][2] + points[2][2] + points[3][2]) / 4,
  ] as Vec3Array;
}

function createInsetTopPoints(
  points: [Vec3Array, Vec3Array, Vec3Array, Vec3Array],
  inset: number,
  height: number
) {
  const center = getQuadCenter(points);
  return points.map((point) => {
    const nextPoint = copyPoint(point);
    nextPoint[0] += (center[0] - nextPoint[0]) * inset;
    nextPoint[2] += (center[2] - nextPoint[2]) * inset;
    nextPoint[1] += height;
    return nextPoint;
  }) as [Vec3Array, Vec3Array, Vec3Array, Vec3Array];
}

function createInsetPoints(
  points: [Vec3Array, Vec3Array, Vec3Array, Vec3Array],
  inset: number,
  height: number
) {
  return createInsetTopPoints(points, inset, height);
}

function isOrganicTransitionCandidate(stringId: string) {
  return organicTransitionTokens.some((token) => stringId.includes(token));
}

function isOpenTransitionNeighbor(foundHash: number) {
  return foundHash < 2;
}

function isRenderableTransitionNeighbor(foundHash: number) {
  return foundHash >= 2;
}

function getNeighborHash(
  space: QuadVoxelGometryNode["builder"]["space"],
  nVoxel: QuadVoxelGometryNode["builder"]["nVoxel"],
  position: QuadVoxelGometryNode["builder"]["position"],
  offset: Vec3Array,
) {
  return space.getHash(
    nVoxel,
    position.x + offset[0],
    position.y + offset[1],
    position.z + offset[2],
  );
}

function getNeighborStringId(
  space: QuadVoxelGometryNode["builder"]["space"],
  hashed: number,
) {
  const trueVoxelId = space.trueVoxelCache[hashed];
  if (!trueVoxelId) return "dve_air";
  return VoxelLUT.voxelIds.getStringId(trueVoxelId);
}

function isCompatibleTransitionNeighbor(
  space: QuadVoxelGometryNode["builder"]["space"],
  hashed: number,
  currentStringId: string,
) {
  const neighborStringId = getNeighborStringId(space, hashed);
  return (
    isOrganicTransitionCandidate(neighborStringId) &&
    neighborStringId === currentStringId
  );
}

export class QuadVoxelGometryNode extends GeoemtryNode<
  CompiledQuadVoxelGeometryNode,
  QuadVoxelGometryArgs
> {
  quad: Quad;
  vertexWeights: [Vec4Array, Vec4Array, Vec4Array, Vec4Array];
  closestFace: VoxelFaces;

  trueFaceIndex?: number;

  init() {
    this.quad = Quad.Create(this.data.positions);
    this.vertexWeights = this.data.weights;
    this.closestFace = this.data.closestFace;
    if (this.data.trueFaceIndex !== undefined)
      this.trueFaceIndex = this.data.trueFaceIndex;
  }

  private shadeFace(face: VoxelFaces) {
    const builder = this.builder;
    builder.calculateFaceData(face);
    this.trueFaceIndex !== undefined && face === this.closestFace
      ? ShadeRulledFace(
          builder,
          this.trueFaceIndex,
          builder.lightData[face],
          this.vertexWeights,
          4,
        )
      : ShadeRulelessFace(
          builder,
          builder.lightData[face],
          this.vertexWeights,
          4,
        );
  }

  private addTransitionQuad(
    quad: Quad,
    face: VoxelFaces,
    texture: QuadVoxelGometryArgs[typeof ArgIndexes.Texture],
    useFullUvs = false,
    doubleSided = false,
  ) {
    const builder = this.builder;
    const targetBuilder = builder.transitionBuilder || builder;
    quad.doubleSided = doubleSided;
    this.shadeFace(face);
    if (useFullUvs) {
      quad.setUVs(Quad.FullUVs as any);
    }
    GetTexture(builder, texture, face, quad);
    addVoxelQuad(builder, quad, targetBuilder);
    targetBuilder.updateBounds(quad.bounds);
  }

  private addConvexCorner(
    corner: (typeof transitionCorners)[number],
    points: [Vec3Array, Vec3Array, Vec3Array, Vec3Array],
    topInsetPoints: [Vec3Array, Vec3Array, Vec3Array, Vec3Array],
    texture: QuadVoxelGometryArgs[typeof ArgIndexes.Texture],
  ) {
    const outerCorner = points[corner.vertex];
    const topInnerCorner = topInsetPoints[corner.vertex];
    const outerA = lerpPoint(outerCorner, points[corner.neighbors[0]], 0.55);
    const outerB = lerpPoint(outerCorner, points[corner.neighbors[1]], 0.55);
    const topInnerA = lerpPoint(
      topInnerCorner,
      topInsetPoints[corner.neighbors[0]],
      0.55,
    );
    const topInnerB = lerpPoint(
      topInnerCorner,
      topInsetPoints[corner.neighbors[1]],
      0.55,
    );
    const quad = Quad.Create(
      Quad.OrderQuadVertices(
        [outerA, outerB, topInnerB, topInnerA],
        "up",
      ),
      Quad.FullUVs as any,
    );

    this.addTransitionQuad(quad, VoxelFaces.Up, texture, true, false);
  }

  private addConcaveCorner(
    corner: (typeof transitionCorners)[number],
    topInsetPoints: [Vec3Array, Vec3Array, Vec3Array, Vec3Array],
    capHeight: number,
    texture: QuadVoxelGometryArgs[typeof ArgIndexes.Texture],
  ) {
    const innerCorner = topInsetPoints[corner.vertex];
    const rimA = lerpPoint(innerCorner, topInsetPoints[corner.neighbors[0]], 0.55);
    const rimB = lerpPoint(innerCorner, topInsetPoints[corner.neighbors[1]], 0.55);
    const pocket = getQuadCenter([
      innerCorner,
      rimA,
      rimB,
      lerpPoint(rimA, rimB, 0.5),
    ]);
    pocket[1] -= Math.max(0.1, capHeight * 0.88);
    const quad = Quad.Create(
      Quad.OrderQuadVertices([rimA, innerCorner, rimB, pocket], "up"),
      Quad.FullUVs as any,
    );

    this.addTransitionQuad(quad, VoxelFaces.Up, texture, true, false);
  }

  private addOrganicTransitions(args: QuadVoxelGometryArgs) {
    const terrainSettings = EngineSettings.settings.terrain;
    if (!terrainSettings.transitionMeshes) return;
    if (this.closestFace !== VoxelFaces.Up) return;

    const stringId = this.builder.voxel.getStringId();
    if (!isOrganicTransitionCandidate(stringId)) return;

    const points = this.quad.positions.toVec3Array();
    const position = this.builder.position;
    const space = this.builder.space;
    const nVoxel = this.builder.nVoxel;

    const exposedFaces = transitionFaces.filter(({ offset }) => {
      const hashed = getNeighborHash(space, nVoxel, position, offset);
      return isOpenTransitionNeighbor(space.foundHash[hashed]);
    });

    if (!exposedFaces.length) return;

    const exposedFaceSet = new Set(exposedFaces.map((face) => face.face));

    const capHeight = terrainSettings.nearCameraHighDetail
      ? 0.11
      : exposedFaces.length > 1
        ? 0.1
        : 0.08;
    const capInset = terrainSettings.nearCameraHighDetail ? 0.38 : 0.32;
    const topInsetPoints = createInsetPoints(points, capInset, capHeight);
    const capQuad = Quad.Create(
      Quad.OrderQuadVertices(topInsetPoints, "up"),
      this.quad.uvs.toVec2Array(),
    );
    this.addTransitionQuad(
      capQuad,
      VoxelFaces.Up,
      args[ArgIndexes.Texture],
      false,
      false,
    );

    for (const transitionFace of exposedFaces) {
      const blockedDiagonals = transitionFace.diagonalOffsets.reduce(
        (total, diagonalOffset) => {
          const hashed = getNeighborHash(space, nVoxel, position, diagonalOffset);
          const found = space.foundHash[hashed];
          if (!isRenderableTransitionNeighbor(found)) {
            return total;
          }
          return isCompatibleTransitionNeighbor(space, hashed, stringId)
            ? total
            : total + 1;
        },
        0,
      );
      if (blockedDiagonals >= transitionFace.diagonalOffsets.length) {
        continue;
      }

      const outerA = copyPoint(points[transitionFace.edge[0]]);
      const outerB = copyPoint(points[transitionFace.edge[1]]);
      const topA = copyPoint(topInsetPoints[transitionFace.edge[0]]);
      const topB = copyPoint(topInsetPoints[transitionFace.edge[1]]);
      const shoulderQuad = Quad.Create(
        Quad.OrderQuadVertices(
          [outerA, outerB, topB, topA],
          transitionFace.direction,
        ),
        Quad.FullUVs as any,
      );
      this.addTransitionQuad(
        shoulderQuad,
        transitionFace.face,
        args[ArgIndexes.Texture],
        true,
        false,
      );
    }

    for (const corner of transitionCorners) {
      if (!exposedFaceSet.has(corner.faceA) || !exposedFaceSet.has(corner.faceB)) {
        continue;
      }

      const hashed = getNeighborHash(space, nVoxel, position, corner.diagonalOffset);
      const diagonalFound = space.foundHash[hashed];
      const diagonalExposed = isOpenTransitionNeighbor(diagonalFound);

      if (
        isRenderableTransitionNeighbor(diagonalFound) &&
        !isCompatibleTransitionNeighbor(space, hashed, stringId)
      ) {
        continue;
      }

      if (diagonalFound === 3) {
        continue;
      }

      diagonalExposed
        ? this.addConvexCorner(
            corner,
            points,
            topInsetPoints,
            args[ArgIndexes.Texture],
          )
        : this.addConcaveCorner(
            corner,
            topInsetPoints,
            capHeight,
            args[ArgIndexes.Texture],
          );
    }
  }

  add(args: QuadVoxelGometryArgs) {
    if (!args[ArgIndexes.Enabled]) return false;

    const builder = this.builder;

    if (
      this.trueFaceIndex !== undefined &&
      !CullRulledFace(builder, this.trueFaceIndex)
    )
      return false;

    this.shadeFace(this.closestFace);
    const quad = this.quad;

    quad.doubleSided = args[ArgIndexes.DoubleSided];
    const uvs = args[ArgIndexes.UVs];
    //1
    quad.uvs.vertices[0].x = uvs[0][0];
    quad.uvs.vertices[0].y = uvs[0][1];
    //2
    quad.uvs.vertices[1].x = uvs[1][0];
    quad.uvs.vertices[1].y = uvs[1][1];
    //3
    quad.uvs.vertices[2].x = uvs[2][0];
    quad.uvs.vertices[2].y = uvs[2][1];
    //4
    quad.uvs.vertices[3].x = uvs[3][0];
    quad.uvs.vertices[3].y = uvs[3][1];

    GetTexture(builder, args[ArgIndexes.Texture], this.closestFace, quad);

    // Dissolution subdivision: replace single quad with subdivided grid + vertex pulling
    if (EngineSettings.settings.terrain.dissolution) {
      const stringId = builder.voxel.getStringId();
      if (isSubdivisionCandidate(stringId)) {
        const exposedFaces = computeExposedFaces(builder, this.closestFace);
        let airCount = 0;
        for (let ef = 0; ef < 6; ef++) if (exposedFaces[ef]) airCount++;
        const edgeBoundary = airCount / 6;
        const subdivLevel = getSubdivisionLevel(edgeBoundary);
        const voxelId = builder.voxel.getVoxelId();
        const pullConfig = getPullConfig(voxelId, stringId);
        buildSubdividedFace(
          builder,
          quad,
          this.closestFace,
          subdivLevel,
          args[ArgIndexes.Texture],
          pullConfig,
          exposedFaces,
        );
        builder.vars.light.setAll(0);
        builder.vars.ao.setAll(0);
        this.addOrganicTransitions(args);
        return true;
      }
    }

    addVoxelQuad(builder, quad);

    builder.updateBounds(quad.bounds);
    builder.vars.light.setAll(0);
    builder.vars.ao.setAll(0);

    this.addOrganicTransitions(args);

    return true;
  }
}
