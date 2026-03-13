import type { SetSectionMeshTask } from "../Mesher/Types/Mesher.types";
import { MeshRegister } from "./MeshRegister.js";
import { LocationData } from "../Math/index.js";
import { DVESectionMeshes } from "./Classes/DVESectionMeshes";
import { CompactedSectionVoxelMesh } from "../Mesher/Voxels/Geometry/CompactedSectionVoxelMesh";
import { CompactedMeshData } from "../Mesher/Voxels/Geometry/CompactedSectionVoxelMesh";
import { SectorMesh } from "./Classes/SectorMesh";
import { SectionMesh } from "./Classes/SectionMesh";
const added = new Set<string>();
const compacted = new CompactedSectionVoxelMesh();
const location: LocationData = [0, 0, 0, 0];

export type SectionMeshCallback = (
  sectorKey: string,
  meshes: { materialId: string; vertices: Float32Array; sectionOrigin: [number, number, number] }[]
) => void;

export type SectorRemovedCallback = (sectorKey: string) => void;

export type VoxelErasedCallback = (
  dimensionId: number,
  x: number,
  y: number,
  z: number,
  voxelId: number
) => void;

export class MeshManager {
  static _sectorPool: SectorMesh[] = [];
  static _sectionPool: SectionMesh[] = [];
  static sectorMeshes: DVESectionMeshes;
  static runningUpdate = false;

  static onSectionUpdated: SectionMeshCallback | null = null;
  static onSectorRemoved: SectorRemovedCallback | null = null;
  static onVoxelErased: VoxelErasedCallback | null = null;

  static updateSection(data: SetSectionMeshTask) {
    compacted.setData(data);

    compacted.getLocation(location);

    let sector = MeshRegister.sectors.getAt(location);
    if (!sector) {
      sector = MeshRegister.sectors.addAt(location);
    }
    let section = sector.getSection(location[1], location[2], location[3]);
    if (!section) {
      section = sector.addSection(location[1], location[2], location[3]);
    }
    /* 
    added.clear();
    for (const [id, points] of effects) {
      added.add(id);
      if (!section.effects.has(id)) {
        const EffectClass = VoxelEffectRegister.get(id);
        const newEffect = new EffectClass(section);
        newEffect.init();
        newEffect.setPoints(points);
        section.effects.set(id, newEffect);
      } else {
        const effect = section.effects.get(id)!;
        effect.setPoints(points);
      }
    }
    for (const [key, effect] of section.effects) {
      if (!added.has(key)) {
        effect.dispose();
        section.effects.delete(key);
      }
    }

 */
    this.sectorMeshes.updateVertexData(section, compacted);

    // Fire splat callback with mesh data
    if (this.onSectionUpdated) {
      const sectorKey = `${location[0]}_${location[1]}_${location[2]}_${location[3]}`;
      const totalMeshes = compacted.getTotalMeshes();
      const meshes: { materialId: string; vertices: Float32Array; sectionOrigin: [number, number, number] }[] = [];
      const cbMeshData = new CompactedMeshData();
      for (let i = 0; i < totalMeshes; i++) {
        compacted.getMeshData(i, cbMeshData);
        meshes.push({
          materialId: cbMeshData.materialId,
          vertices: cbMeshData.verticies,
          sectionOrigin: [location[1], location[2], location[3]],
        });
      }
      this.onSectionUpdated(sectorKey, meshes);
    }
  }
  static removeSector(dimensionId: number, x: number, y: number, z: number) {
    const sectorKey = `${dimensionId}_${x}_${y}_${z}`;
    const sector = MeshRegister.sectors.remove(dimensionId, x, y, z);
    if (!sector) return false;
    sector.dipose();
    if (this.onSectorRemoved) {
      this.onSectorRemoved(sectorKey);
    }
  }
  static removeSectorAt(data: LocationData) {
    return this.removeSector(...data);
  }
}
