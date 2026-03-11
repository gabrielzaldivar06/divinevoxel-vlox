import { RenderedMaterials } from "./Voxels/Models/RenderedMaterials";
import { VoxelGeometryConstructorRegister } from "./Voxels/Models/VoxelGeometryConstructorRegister.js";
import { BeachShadeGeometryNode } from "./Voxels/Models/Nodes/Custom/BeachShade/BeachShadeGeometryNode.js";
import { LiquidGeometryNode } from "./Voxels/Models/Nodes/Custom/Liquid/LiquidGeometryNode.js";

export default function () {
  RenderedMaterials.init();

  VoxelGeometryConstructorRegister.registerCustomNode(
    "liquid",
    LiquidGeometryNode
  );
  VoxelGeometryConstructorRegister.registerCustomNode(
    "beach_shade",
    BeachShadeGeometryNode
  );

  VoxelGeometryConstructorRegister.init();
}
