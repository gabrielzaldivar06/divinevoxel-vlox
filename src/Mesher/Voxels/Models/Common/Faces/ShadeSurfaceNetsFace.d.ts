import { Vec3Array } from "@amodx/math";
import { VoxelModelBuilder } from "../../VoxelModelBuilder";
import { VoxelFaces } from "../../../../../Math";
/**
 * Compute AO and lighting for a Surface Nets quad.
 *
 * Unlike ShadeRulledFace which uses pre-built LUTs for axis-aligned faces,
 * this function works with arbitrary normals by sampling the hemisphere
 * around each vertex's face normal direction.
 *
 * For each of the 4 vertices:
 *  - Light: sample the light cache at the face-direction neighbor and
 *    up to 3 gradient neighbors, take maximum per channel.
 *  - AO: count how many solid neighbors lie in the hemisphere of the quad normal.
 *    Cap at 3 to match the axis-aligned AO system.
 *
 * @param builder  The model builder with position/cache/nVoxel set up
 * @param closestFace  The dominant axis-aligned face for this quad
 * @param positions  The 4 vertex positions (local to section)
 */
export declare function ShadeSurfaceNetsFace(builder: VoxelModelBuilder, closestFace: VoxelFaces, positions: [Vec3Array, Vec3Array, Vec3Array, Vec3Array]): void;
