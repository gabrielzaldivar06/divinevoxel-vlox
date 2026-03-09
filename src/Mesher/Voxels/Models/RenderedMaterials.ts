import { VoxelLUT } from "../../../Voxels/Data/VoxelLUT";
import { VoxelModelBuilder } from "./VoxelModelBuilder";
import { getTransitionMaterialId } from "./TransitionMaterialIds";

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

function isOrganicTransitionCandidate(materialId: string) {
  return organicTransitionTokens.some((token) => materialId.includes(token));
}

export class RenderedMaterials {
  static meshersMap = new Map<string, VoxelModelBuilder>();
  static meshers: VoxelModelBuilder[] = [];

  static init() {
    const materials = [...VoxelLUT.material._palette];
    for (const mat of materials) {
      const index = VoxelLUT.material.getNumberId(mat);
      const baseTool = new VoxelModelBuilder(mat, index, mat, false);
      this.meshersMap.set(mat, baseTool);
      this.meshers[index] = baseTool;

      if (!isOrganicTransitionCandidate(mat)) {
        continue;
      }

      const transitionMaterialId = getTransitionMaterialId(mat);
      const transitionIndex = VoxelLUT.material.isRegistered(transitionMaterialId)
        ? VoxelLUT.material.getNumberId(transitionMaterialId)
        : VoxelLUT.material.register(transitionMaterialId);
      const transitionTool = new VoxelModelBuilder(
        transitionMaterialId,
        transitionIndex,
        mat,
        true
      );

      baseTool.transitionBuilder = transitionTool;
      this.meshersMap.set(transitionMaterialId, transitionTool);
      this.meshers[transitionIndex] = transitionTool;
    }
  }
}
