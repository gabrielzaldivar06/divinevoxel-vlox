import { Quad } from "../../../../../Geometry/Primitives/Quad";
import { VoxelModelBuilder } from "../../../VoxelModelBuilder";
import { VoxelFaces } from "../../../../../../Math";
interface PullConfig {
    adhesion: number;
    porosity: number;
    shearStrength: number;
    friction: number;
    ph: number;
    isWood: boolean;
    isSedimentaryRock: boolean;
}
/**
 * Replaces a single quad with a subdivided grid (2×2 or 3×3)
 * with vertex pulling applied to interior sub-vertices.
 *
 * @param builder      - VoxelModelBuilder context
 * @param quad         - Original quad (4 corner positions + normals + UVs)
 * @param face         - Which face of the voxel (Up, North, etc.)
 * @param subdivLevel  - 2 for 2×2, 3 for 3×3
 * @param texture      - Texture arg for GetTexture
 * @param pullConfig   - Physics properties of this voxel
 * @param exposedFaces - Per-direction boolean: true = air/different material neighbour
 */
export declare function buildSubdividedFace(builder: VoxelModelBuilder, quad: Quad, face: VoxelFaces, subdivLevel: number, texture: any, pullConfig: PullConfig, exposedFaces: boolean[]): void;
/**
 * Check if a voxel string ID is an organic material that qualifies for subdivision.
 */
export declare function isSubdivisionCandidate(stringId: string): boolean;
/**
 * Get physics pull configuration for a voxel.
 */
export declare function getPullConfig(voxelId: number, stringId: string): PullConfig;
/**
 * Determine the subdivision level for a given edgeBoundary value.
 * Since every rendered organic face is exposed to air, we always
 * subdivide at least 3×3. Corners/edges with more air neighbors get 4×4.
 * Highly isolated blocks (≥4 air faces, edgeBoundary > 0.8) get 5×5.
 */
export declare function getSubdivisionLevel(edgeBoundary: number): number;
/**
 * Per-direction exposure: returns boolean[6] indicating which cardinal
 * neighbours are air or a different material. The rendered face itself
 * is always marked exposed (index === face).
 */
export declare function computeExposedFaces(builder: VoxelModelBuilder, face: VoxelFaces): boolean[];
/**
 * Compute face-aware edge boundary.
 * The face being rendered is KNOWN to be exposed (face culling ensures this).
 * We count how many OTHER cardinal neighbors are also air/different material.
 * A face that is the only exposed side → edgeBoundary ~0.35 (still gets 2×2).
 * A corner voxel with 3+ air faces → edgeBoundary ~0.6+ (gets 3×3).
 *
 * @param builder - VoxelModelBuilder context
 * @param face    - The face being rendered (known to be exposed)
 */
export declare function computeEdgeBoundary(builder: VoxelModelBuilder, face: VoxelFaces): number;
export {};
