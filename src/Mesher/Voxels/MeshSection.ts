import { LocationData } from "../../Math";
import type { SetSectionMeshTask } from "../Types/Mesher.types";
//tools
import { WorldCursor } from "../../World/Cursor/WorldCursor.js";
import { SectionCursor } from "../../World/Cursor/SectionCursor.js";
import { WorldRegister } from "../../World/WorldRegister.js";
import { MeshSectionBase } from "./Base/MeshSectionBase";
import { MeshSectionSurfaceNets } from "./Base/MeshSectionSurfaceNets";
import { EngineSettings } from "../../Settings/EngineSettings";
import { DataCursorInterface } from "../../Voxels/Cursor/DataCursor.interface";

const sectionCursor = new SectionCursor();
const worldCursor = new WorldCursor();

export function MeshSectionWithCursors(
  worldCursor: DataCursorInterface,
  sectionCursor: SectionCursor,
  location: LocationData,
  transfers: any[] = []
): SetSectionMeshTask | null {
  const useSurfaceNets = !!EngineSettings.settings.terrain.surfaceNets;
  if (useSurfaceNets) {
    return MeshSectionSurfaceNets(worldCursor, sectionCursor, location, transfers);
  }

  return MeshSectionBase(worldCursor, sectionCursor, location, transfers);
}

export function MeshSection(
  location: LocationData,
  transfers: any[] = []
): SetSectionMeshTask | null {
  const sector = WorldRegister.sectors.getAt(location);
  if (!sector) return null;
  worldCursor.setFocalPoint(...location);
  sectionCursor.loadSection(...location);

  return MeshSectionWithCursors(worldCursor, sectionCursor, location, transfers);
}
