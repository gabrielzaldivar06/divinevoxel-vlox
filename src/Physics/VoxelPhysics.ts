import { WorldSpaces } from "../World/WorldSpaces";

/**
 * Data-driven physics utilities for voxel world simulation.
 * Provides derived physical quantities computed from world position and voxel properties.
 */
export class VoxelPhysics {
  /** Base atmospheric pressure at sea level (Y=0) in arbitrary units. */
  static basePressure = 101.325;
  /** Fluid density constant for hydrostatic pressure calculation. */
  static fluidDensity = 1.0;
  /** Gravitational acceleration constant. */
  static gravity = 9.81;

  /**
   * Compute atmospheric/hydrostatic pressure at a given Y coordinate.
   * P = basePressure + density * g * (maxY - y)
   * Higher Y = lower pressure (altitude). Lower Y = higher pressure (depth).
   */
  static getPressure(y: number): number {
    const maxY = WorldSpaces.world.bounds.MaxY;
    return (
      VoxelPhysics.basePressure +
      VoxelPhysics.fluidDensity * VoxelPhysics.gravity * (maxY - y)
    );
  }

  /**
   * Get normalized pressure (0-1) where 0 = top of world, 1 = bottom.
   */
  static getNormalizedPressure(y: number): number {
    const maxY = WorldSpaces.world.bounds.MaxY;
    return Math.max(0, Math.min(1, (maxY - y) / maxY));
  }

  /**
   * Get normalized altitude (0-1) where 0 = bottom, 1 = top.
   * Inverse of normalized pressure.
   */
  static getNormalizedAltitude(y: number): number {
    const maxY = WorldSpaces.world.bounds.MaxY;
    return Math.max(0, Math.min(1, y / maxY));
  }
}
