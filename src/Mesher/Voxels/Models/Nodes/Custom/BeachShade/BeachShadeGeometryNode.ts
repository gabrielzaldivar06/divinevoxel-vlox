import { Vec3Array, Vec4Array } from "@amodx/math";
import { VoxelFaces } from "../../../../../../Math";
import type { BeachShadeVoxelModelArgs } from "../../../../../../Voxels/Models/Defaults/Examples";
import { GeoemtryNode } from "../../GeometryNode";
import { CompiledCustomGeometryNode } from "../../Types/GeometryNode.types";
import { GetTexture } from "../../../Common/GetTexture";
import { ShadeRulelessFace } from "../../../Common/Faces/ShadeRulelessFace";
import { addVoxelQuad, addVoxelTriangle } from "../../../../Geometry/VoxelGeometryBuilder";
import { Box } from "../../../../../Geometry/Shapes/Box";
import { Quad } from "../../../../../Geometry/Primitives/Quad";
import { Triangle } from "../../../../../Geometry/Primitives/Triangle";

const QUAD_VERTEX_WEIGHTS: Vec4Array[] = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

const TRIANGLE_VERTEX_WEIGHTS: Vec4Array[] = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
];

const FULL_QUAD_UVS: [[number, number], [number, number], [number, number], [number, number]] = [
  [1, 1],
  [0, 1],
  [0, 0],
  [1, 0],
];

const FULL_TRIANGLE_UVS: [[number, number], [number, number], [number, number]] = [
  [0, 0],
  [1, 0],
  [0, 1],
];

const poleBox = Box.Create([
  [0.45, 0, 0.45],
  [0.55, 0.78, 0.55],
]);

const canopyTop = [0.5, 1, 0.5] as [number, number, number];
const canopyRing: [Vec3Array, Vec3Array, Vec3Array, Vec3Array] = [
  [0.12, 0.78, 0.12],
  [0.88, 0.78, 0.12],
  [0.88, 0.78, 0.88],
  [0.12, 0.78, 0.88],
];

export class BeachShadeGeometryNode extends GeoemtryNode<
  CompiledCustomGeometryNode,
  BeachShadeVoxelModelArgs
> {
  init(): void {}

  private resetFaceData() {
    this.builder.vars.light.setAll(0);
    this.builder.vars.ao.setAll(0);
  }

  private addQuad(quad: Quad, face: VoxelFaces, texture: number) {
    const builder = this.builder;
    builder.calculateFaceData(face);
    ShadeRulelessFace(builder, builder.lightData[face], QUAD_VERTEX_WEIGHTS, 4);
    quad.setUVs(FULL_QUAD_UVS);
    GetTexture(builder, texture, face, quad);
    addVoxelQuad(builder, quad);
    builder.updateBounds(quad.bounds);
    this.resetFaceData();
  }

  private addTriangle(triangle: Triangle, face: VoxelFaces, texture: number) {
    const builder = this.builder;
    builder.calculateFaceData(face);
    ShadeRulelessFace(builder, builder.lightData[face], TRIANGLE_VERTEX_WEIGHTS, 3);

    triangle.uvs.vertices[0].x = 0.5;
    triangle.uvs.vertices[0].y = 1;
    triangle.uvs.vertices[1].x = 1;
    triangle.uvs.vertices[1].y = 0;
    triangle.uvs.vertices[2].x = 0;
    triangle.uvs.vertices[2].y = 0;

    GetTexture(builder, texture, face, triangle);
    addVoxelTriangle(builder, triangle);
    builder.updateBounds(triangle.bounds);
    this.resetFaceData();
  }

  add(args: BeachShadeVoxelModelArgs): boolean {
    for (const face of [
      VoxelFaces.Up,
      VoxelFaces.Down,
      VoxelFaces.North,
      VoxelFaces.South,
      VoxelFaces.East,
      VoxelFaces.West,
    ]) {
      this.addQuad(poleBox.quads[face], face, args.poleTexture);
    }

    const canopyTriangles = [
      Triangle.Create([canopyTop, canopyRing[0], canopyRing[1]], FULL_TRIANGLE_UVS, true),
      Triangle.Create([canopyTop, canopyRing[1], canopyRing[2]], FULL_TRIANGLE_UVS, true),
      Triangle.Create([canopyTop, canopyRing[2], canopyRing[3]], FULL_TRIANGLE_UVS, true),
      Triangle.Create([canopyTop, canopyRing[3], canopyRing[0]], FULL_TRIANGLE_UVS, true),
    ];

    for (const triangle of canopyTriangles) {
      this.addTriangle(triangle, VoxelFaces.Up, args.canopyTexture);
    }

    return true;
  }
}