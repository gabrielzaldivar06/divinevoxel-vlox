import {
  VoxelSubstanceTagIdds as VoxelSubstanceTagIds,
  VoxelSubstanceTags,
  VoxelTagIds,
  VoxelTags,
} from "./VoxelTag.types";

export class VoxelTagsRegister {
  static IncludedVoxelTags: string[] = [
    VoxelTagIds.substance,
    VoxelTagIds.renderedMaterial,
    VoxelTagIds.voxelMaterial,
    VoxelTagIds.hardness,
    VoxelTagIds.colliderID,
    VoxelTagIds.checkCollisions,
    VoxelTagIds.isLightSource,
    VoxelTagIds.lightValue,
    VoxelTagIds.noAO,
    VoxelTagIds.isTransparent,
    VoxelTagIds.canHaveSecondary,
    VoxelTagIds.isPowerSource,
    VoxelTagIds.canBePowered,
    VoxelTagIds.canCarryPower,
    VoxelTagIds.canHoldPower,
    VoxelTagIds.powerValue,
    VoxelTagIds.fullBlock,
    VoxelTagIds.simulationBehavior,
    VoxelTagIds.ph,
    VoxelTagIds.friction,
    VoxelTagIds.adhesion,
    VoxelTagIds.porosity,
    VoxelTagIds.shearStrength,
    VoxelTagIds.albedoValue,
    VoxelTagIds.isRadiationSource,
    VoxelTagIds.radiationValue,
  ];
  static IncludedSubstnacesTags: string[] = [
    VoxelSubstanceTagIds.parent,
    VoxelSubstanceTagIds.isSolid,
    VoxelSubstanceTagIds.isTransparent,
    VoxelSubstanceTagIds.isLiquid,
    VoxelSubstanceTagIds.flowRate,
    VoxelSubstanceTagIds.isWindAffected,
  ];
  static VoxelTagDefaults: Record<string, any> = {
    [VoxelTagIds.renderedMaterial]: "dve_solid",
    [VoxelTagIds.substance]: "dve_solid",
    [VoxelTagIds.colliderID]: "dve_cube",
    [VoxelTagIds.simulationBehavior]: "dve_default",
    [VoxelTagIds.ph]: 7,
    [VoxelTagIds.friction]: 0.5,
    [VoxelTagIds.adhesion]: 0,
    [VoxelTagIds.porosity]: 0,
    [VoxelTagIds.shearStrength]: 100,
    [VoxelTagIds.albedoValue]: 0.3,
    [VoxelTagIds.isRadiationSource]: false,
    [VoxelTagIds.radiationValue]: 0,
  };
  static VoxelTags: VoxelTags[] = [];
  /** Pre-computed set of numeric voxel IDs that are radiation sources. */
  static RadiationSourceIds: Set<number> = new Set();

  static SubstanceTagDefaults: Record<string, any> = {};
  static SubstanceTags: VoxelSubstanceTags[] = [];
}
