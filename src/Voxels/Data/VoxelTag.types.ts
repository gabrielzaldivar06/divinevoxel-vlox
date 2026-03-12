export enum VoxelTagIds {
  substance = "dve_substance",
  renderedMaterial = "dve_rendered_material",
  voxelMaterial = "dve_voxel_material",
  hardness = "dve_hardness",
  modelId = "dve_model_id",
  colliderID = "dve_collider_id",
  checkCollisions = "dve_check_collisions",
  isLightSource = "dve_is_light_source",
  lightValue = "dve_light_value",
  noAO = "dve_no_ao",
  isTransparent = "dve_is_transparent",
  canHaveSecondary = "dve_can_have_secondary",
  canBePowered = "dve_can_be_powered",
  canCarryPower = "dve_can_carry_power",
  canHoldPower = "dve_can_hold_power",
  isPowerSource = "dve_is_power_source",
  powerValue = "dve_power_value",
  fullBlock = "dve_full_block",
  simulationBehavior = "dve_simulation_behavior",
  ph = "dve_ph",
  friction = "dve_friction",
  adhesion = "dve_adhesion",
  porosity = "dve_porosity",
  shearStrength = "dve_shear_strength",
  albedoValue = "dve_albedo_value",
  isRadiationSource = "dve_is_radiation_source",
  radiationValue = "dve_radiation_value",
}

export interface VoxelTags {
  [VoxelTagIds.simulationBehavior]: string;
  [VoxelTagIds.fullBlock]: boolean;
  /** The material used to render the voxel. Used by the engine to assign meshes to the proper material. */
  [VoxelTagIds.renderedMaterial]: string;

  /** A description of the material used for the voxel. Not used by the engine directly. */
  [VoxelTagIds.voxelMaterial]: string;

  /** Specifies the substance of the voxel.
   * The voxel will inherit properties from the substance and change how it acts in the world.
   * Properties include being solid or liquid.
   * */
  [VoxelTagIds.substance]: string;

  /** Indicates whether the voxel is a light source. */
  [VoxelTagIds.isLightSource]: boolean;

  /** Indicates if the voxel lets light through */
  [VoxelTagIds.isTransparent]: boolean;

  /** Disables ambient occlusion for this voxel if set to true. */
  [VoxelTagIds.noAO]: boolean;

  /** Defines the light value emitted by the voxel (r, g, z). */
  [VoxelTagIds.lightValue]: [r: number, g: number, z: number] | number;

  [VoxelTagIds.modelId]: string;
  /** The collider ID for the voxel, used for collision detection. */
  [VoxelTagIds.colliderID]: string;

  /** Specifies if the voxel participates in collision checks. */
  [VoxelTagIds.checkCollisions]: boolean;

  /** Indicates if the voxel can have a secondary voxel. */
  [VoxelTagIds.canHaveSecondary]: boolean;

  /** The hardness level of the voxel, affecting how it is broken or interacted with. */
  [VoxelTagIds.hardness]: number;

  /** Whether or not the voxel can be powered */
  [VoxelTagIds.canBePowered]: boolean;

  /** Whether or not the voxel can carry power */
  [VoxelTagIds.canCarryPower]: boolean;

  /** Whether or not the voxel can hold power. */
  [VoxelTagIds.canHoldPower]: boolean;

  /** Whether or not the voxel is a power source*/
  [VoxelTagIds.isPowerSource]: boolean;

  /** If the voxel is a power source this is its value */
  [VoxelTagIds.powerValue]: number;

  /** pH value of the voxel material (0-14). Affects biological membrane integrity. */
  [VoxelTagIds.ph]: number;

  /** Friction coefficient of the voxel surface. Affects movement energy cost. */
  [VoxelTagIds.friction]: number;

  /** Adhesion coefficient. How much the surface "grabs" entities (e.g. mud viscosity). */
  [VoxelTagIds.adhesion]: number;

  /** Porosity of the material (0-1). Affects gas diffusion through the voxel. */
  [VoxelTagIds.porosity]: number;

  /** Shear strength. Load limit before structural collapse. */
  [VoxelTagIds.shearStrength]: number;

  /** Albedo value (0-1). How much light the surface reflects. */
  [VoxelTagIds.albedoValue]: number;

  /** Whether this voxel emits radiation. */
  [VoxelTagIds.isRadiationSource]: boolean;

  /** Radiation intensity emitted by this voxel (0-15). */
  [VoxelTagIds.radiationValue]: number;
}

export enum VoxelSubstanceTagIdds {
  parent = "dve_parent_substance",
  isSolid = "dve_is_solid",
  isTransparent = "dve_is_transparent",
  isLiquid = "dve_is_liquid",
  flowRate = "dve_flow_rate",
  isWindAffected = "dve_is_wind_affected",
}
export interface VoxelSubstanceTags {
  [VoxelSubstanceTagIdds.parent]: string;
  [VoxelSubstanceTagIdds.isTransparent]: boolean;
  [VoxelSubstanceTagIdds.isSolid]: boolean;
  [VoxelSubstanceTagIdds.isLiquid]: boolean;
  [VoxelSubstanceTagIdds.flowRate]: number;
  [VoxelSubstanceTagIdds.isWindAffected]: boolean;
}
