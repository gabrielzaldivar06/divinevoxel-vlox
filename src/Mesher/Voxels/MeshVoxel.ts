import { VoxelGeometryBuilderCacheSpace } from "./Models/VoxelGeometryBuilderCacheSpace.js";
import { TemplateCursor } from "../../Templates/Cursor/TemplateCursor.js";
import { FullVoxelTemplate } from "../../Templates/Full/FullVoxelTemplate.js";
import { CompactTemplateMesh } from "./Base/CompactTemplateMesh.js";
import { RawVoxelData } from "../../Voxels/Types/Voxel.types.js";
import { CompactMeshData } from "../Types/index.js";
import { RenderedMaterials } from "./Models/RenderedMaterials.js";
import { VoxelLUT } from "../../Voxels/Data/VoxelLUT.js";
import { BuildVoxel } from "./Base/BuildVoxel.js";
const template = new FullVoxelTemplate(
  FullVoxelTemplate.CreateNew([3, 3, 3], 0xf)
);
const templateCursor = new TemplateCursor();
templateCursor.setTemplate(template);

const space = new VoxelGeometryBuilderCacheSpace({ x: 3, y: 3, z: 3 });
export function MeshVoxel(
  rawVoxelData: RawVoxelData
): [mesh: CompactMeshData, tranfers: any[]] | false {

  const index = template.getIndex(1, 1, 1);
  template.ids[index] = rawVoxelData[0];
  template.level[index] = rawVoxelData[2];
  template.secondary[index] = rawVoxelData[3];
  const voxel = templateCursor.getVoxel(1, 1, 1)!;
  if (!voxel.isRenderable()) return false;

  const builder =
    RenderedMaterials.meshers[VoxelLUT.materialMap[voxel.getVoxelId()]];
  const transitionBuilder = builder.transitionBuilder;


  builder.space = space;
  builder.bvhTool = null;
  builder.clear();
  transitionBuilder?.clear();
  space.start(0, 0, 0);

  builder.effects = {};
  if (transitionBuilder) {
    transitionBuilder.space = space;
    transitionBuilder.bvhTool = null;
    transitionBuilder.effects = builder.effects;
  }
  builder.origin.x = -0.5;
  builder.origin.y = -0.5;
  builder.origin.z = -0.5;
  builder.position.x = 1;
  builder.position.y = 1;
  builder.position.z = 1;

  builder.voxel = voxel;
  builder.nVoxel = templateCursor;

  if (transitionBuilder) {
    transitionBuilder.origin.x = builder.origin.x;
    transitionBuilder.origin.y = builder.origin.y;
    transitionBuilder.origin.z = builder.origin.z;
    transitionBuilder.position.x = builder.position.x;
    transitionBuilder.position.y = builder.position.y;
    transitionBuilder.position.z = builder.position.z;
    transitionBuilder.voxel = voxel;
    transitionBuilder.nVoxel = templateCursor;
    transitionBuilder.startConstruction();
  }

  builder.startConstruction();
  BuildVoxel(builder);
  builder.endConstruction();
  transitionBuilder?.endConstruction();

  const transfers: any[] = [];
  const compacted = CompactTemplateMesh(
    transitionBuilder ? [builder, transitionBuilder] : [builder],
    transfers
  );
  builder.clear();
  transitionBuilder?.clear();

  return [compacted, transfers];
}
