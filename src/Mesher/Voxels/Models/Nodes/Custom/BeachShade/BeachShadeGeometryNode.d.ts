import type { BeachShadeVoxelModelArgs } from "../../../../../../Voxels/Models/Defaults/Examples";
import { GeoemtryNode } from "../../GeometryNode";
import { CompiledCustomGeometryNode } from "../../Types/GeometryNode.types";
export declare class BeachShadeGeometryNode extends GeoemtryNode<CompiledCustomGeometryNode, BeachShadeVoxelModelArgs> {
    init(): void;
    private resetFaceData;
    private addQuad;
    private addTriangle;
    add(args: BeachShadeVoxelModelArgs): boolean;
}
