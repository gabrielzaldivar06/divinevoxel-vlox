import { VoxelSubstanceTags, VoxelTags } from "./VoxelTag.types";
export declare class VoxelTagsRegister {
    static IncludedVoxelTags: string[];
    static IncludedSubstnacesTags: string[];
    static VoxelTagDefaults: Record<string, any>;
    static VoxelTags: VoxelTags[];
    /** Pre-computed set of numeric voxel IDs that are radiation sources. */
    static RadiationSourceIds: Set<number>;
    static SubstanceTagDefaults: Record<string, any>;
    static SubstanceTags: VoxelSubstanceTags[];
}
