import type {
  ContinuousWaterColumn,
  ContinuousWaterSection,
} from "../Continuous/ContinuousWaterTypes.js";
import {
  WaterBoundaryFluxBuffer,
  type WaterBoundaryDirection,
  type WaterBoundaryFluxEntry,
  getOppositeBoundaryDirection,
} from "./WaterBoundaryFluxBuffer.js";

export interface WaterGhostColumn {
  active: boolean;
  bedY: number;
  surfaceY: number;
  depth: number;
  ownership: "none" | "continuous";
  velocityX: number;
  velocityZ: number;
  pressure: number;
  bodyId: number;
}

export interface WaterGhostColumnSet {
  north: WaterGhostColumn[];
  south: WaterGhostColumn[];
  east: WaterGhostColumn[];
  west: WaterGhostColumn[];
}

export interface WaterBoundaryFluxSnapshot {
  north: WaterBoundaryFluxEntry[];
  south: WaterBoundaryFluxEntry[];
  east: WaterBoundaryFluxEntry[];
  west: WaterBoundaryFluxEntry[];
}

interface WaterChunkRuntimeEntry {
  key: string;
  originX: number;
  originZ: number;
  sizeX: number;
  sizeZ: number;
  ghostColumns: WaterGhostColumnSet;
  inboundFlux: WaterBoundaryFluxBuffer;
  outboundFlux: WaterBoundaryFluxBuffer;
  deferredOutboundFlux: WaterBoundaryFluxBuffer;
  lastBoundarySyncTick: number;
  isRetired: boolean;
}

function sectionKey(originX: number, originZ: number) {
  return `${originX}_${originZ}`;
}

function createGhostColumn(): WaterGhostColumn {
  return {
    active: false,
    bedY: 0,
    surfaceY: 0,
    depth: 0,
    ownership: "none",
    velocityX: 0,
    velocityZ: 0,
    pressure: 0,
    bodyId: 0,
  };
}

function createGhostColumns(size: number) {
  return Array.from({ length: size }, () => createGhostColumn());
}

function createGhostColumnSet(sizeX: number, sizeZ: number): WaterGhostColumnSet {
  return {
    north: createGhostColumns(sizeX),
    south: createGhostColumns(sizeX),
    east: createGhostColumns(sizeZ),
    west: createGhostColumns(sizeZ),
  };
}

function resetGhostColumn(target: WaterGhostColumn) {
  target.active = false;
  target.bedY = 0;
  target.surfaceY = 0;
  target.depth = 0;
  target.ownership = "none";
  target.velocityX = 0;
  target.velocityZ = 0;
  target.pressure = 0;
  target.bodyId = 0;
}

function clearGhostColumnSet(target: WaterGhostColumnSet) {
  for (const column of target.north) resetGhostColumn(column);
  for (const column of target.south) resetGhostColumn(column);
  for (const column of target.east) resetGhostColumn(column);
  for (const column of target.west) resetGhostColumn(column);
}

function copyGhostColumn(target: WaterGhostColumn, source: ContinuousWaterColumn | null) {
  if (!source || !source.active) {
    resetGhostColumn(target);
    return;
  }

  target.active = true;
  target.bedY = source.bedY;
  target.surfaceY = source.surfaceY;
  target.depth = source.depth;
  target.ownership = "continuous";
  target.velocityX = source.velocityX;
  target.velocityZ = source.velocityZ;
  target.pressure = source.pressure;
  target.bodyId = source.bodyId;
}

function getBoundaryColumn(
  section: ContinuousWaterSection,
  direction: WaterBoundaryDirection,
  index: number,
): ContinuousWaterColumn | null {
  if (direction === "north" || direction === "south") {
    if (index < 0 || index >= section.sizeX) return null;
    const z = direction === "north" ? 0 : section.sizeZ - 1;
    return section.columns[z * section.sizeX + index] ?? null;
  }

  if (index < 0 || index >= section.sizeZ) return null;
  const x = direction === "west" ? 0 : section.sizeX - 1;
  return section.columns[index * section.sizeX + x] ?? null;
}

function getNeighborOrigin(
  originX: number,
  originZ: number,
  sizeX: number,
  sizeZ: number,
  direction: WaterBoundaryDirection,
) {
  switch (direction) {
    case "north":
      return { originX, originZ: originZ - sizeZ };
    case "south":
      return { originX, originZ: originZ + sizeZ };
    case "east":
      return { originX: originX + sizeX, originZ };
    case "west":
      return { originX: originX - sizeX, originZ };
  }
}

function getBoundaryLength(sizeX: number, sizeZ: number, direction: WaterBoundaryDirection) {
  return direction === "north" || direction === "south" ? sizeX : sizeZ;
}

export class WaterChunkRegistry {
  private readonly entries = new Map<string, WaterChunkRuntimeEntry>();

  private hasFlux(buffer: WaterBoundaryFluxBuffer) {
    const directions: WaterBoundaryDirection[] = ["north", "south", "east", "west"];
    for (const direction of directions) {
      for (const flux of buffer.entries(direction)) {
        if (flux.mass > 0) {
          return true;
        }
      }
    }
    return false;
  }

  private measureFlux(buffer: WaterBoundaryFluxBuffer) {
    let total = 0;
    const directions: WaterBoundaryDirection[] = ["north", "south", "east", "west"];
    for (const direction of directions) {
      for (const flux of buffer.entries(direction)) {
        if (flux.mass <= 0) continue;
        total += flux.mass;
      }
    }
    return total;
  }

  clear() {
    this.entries.clear();
  }

  removeSection(originX: number, originZ: number) {
    this.entries.delete(sectionKey(originX, originZ));
  }

  retireSection(originX: number, originZ: number) {
    const entry = this.entries.get(sectionKey(originX, originZ));
    if (!entry) return;
    entry.isRetired = true;
    entry.outboundFlux.clear();
    clearGhostColumnSet(entry.ghostColumns);
  }

  private getOrCreateEntry(
    originX: number,
    originZ: number,
    sizeX: number,
    sizeZ: number,
  ): WaterChunkRuntimeEntry {
    const key = sectionKey(originX, originZ);
    const existing = this.entries.get(key);
    if (existing && existing.sizeX === sizeX && existing.sizeZ === sizeZ) {
      return existing;
    }

    const boundarySize = Math.max(sizeX, sizeZ);
    const next: WaterChunkRuntimeEntry = {
      key,
      originX,
      originZ,
      sizeX,
      sizeZ,
      ghostColumns: createGhostColumnSet(sizeX, sizeZ),
      inboundFlux: new WaterBoundaryFluxBuffer(boundarySize),
      outboundFlux: new WaterBoundaryFluxBuffer(boundarySize),
      deferredOutboundFlux: new WaterBoundaryFluxBuffer(boundarySize),
      lastBoundarySyncTick: 0,
      isRetired: false,
    };
    this.entries.set(key, next);
    return next;
  }

  beginTick(sections: ReadonlyMap<string, ContinuousWaterSection>, tick: number) {
    for (const section of sections.values()) {
      const entry = this.getOrCreateEntry(
        section.originX,
        section.originZ,
        section.sizeX,
        section.sizeZ,
      );
      entry.isRetired = false;
      entry.outboundFlux.clear();
      entry.lastBoundarySyncTick = tick;

      const directions: WaterBoundaryDirection[] = ["north", "south", "east", "west"];
      for (const direction of directions) {
        const neighborOrigin = getNeighborOrigin(
          section.originX,
          section.originZ,
          section.sizeX,
          section.sizeZ,
          direction,
        );
        const neighbor = sections.get(sectionKey(neighborOrigin.originX, neighborOrigin.originZ));
        const boundaryLength = getBoundaryLength(section.sizeX, section.sizeZ, direction);

        for (let i = 0; i < boundaryLength; i++) {
          const ghost = entry.ghostColumns[direction][i];
          if (!neighbor) {
            resetGhostColumn(ghost);
            continue;
          }
          copyGhostColumn(ghost, getBoundaryColumn(neighbor, getOppositeBoundaryDirection(direction), i));
        }
      }
    }
  }

  getGhostColumns(originX: number, originZ: number): WaterGhostColumnSet | null {
    return this.entries.get(sectionKey(originX, originZ))?.ghostColumns ?? null;
  }

  consumeInboundFlux(originX: number, originZ: number): WaterBoundaryFluxSnapshot | null {
    const entry = this.entries.get(sectionKey(originX, originZ));
    if (!entry) return null;
    return entry.inboundFlux.cloneAndClear();
  }

  hasPendingBoundaryState(originX: number, originZ: number) {
    const entry = this.entries.get(sectionKey(originX, originZ));
    if (!entry) return false;
    return this.hasFlux(entry.inboundFlux) || this.hasFlux(entry.deferredOutboundFlux);
  }

  measureBufferedMass() {
    let total = 0;
    for (const entry of this.entries.values()) {
      total += this.measureFlux(entry.inboundFlux);
      total += this.measureFlux(entry.outboundFlux);
      total += this.measureFlux(entry.deferredOutboundFlux);
    }
    return total;
  }

  recordOutboundFlux(
    originX: number,
    originZ: number,
    direction: WaterBoundaryDirection,
    index: number,
    mass: number,
    velocityX: number,
    velocityZ: number,
    tick: number,
  ) {
    const entry = this.entries.get(sectionKey(originX, originZ));
    if (!entry) return;
    entry.outboundFlux.accumulate(direction, index, mass, velocityX, velocityZ, tick);
  }

  finalizeTick() {
    const directions: WaterBoundaryDirection[] = ["north", "south", "east", "west"];
    for (const entry of this.entries.values()) {
      for (const direction of directions) {
        const neighborOrigin = getNeighborOrigin(
          entry.originX,
          entry.originZ,
          entry.sizeX,
          entry.sizeZ,
          direction,
        );
        const neighbor = this.entries.get(sectionKey(neighborOrigin.originX, neighborOrigin.originZ));
        const targetDirection = getOppositeBoundaryDirection(direction);

        if (!neighbor) {
          const boundary = entry.outboundFlux.entries(direction);
          for (let i = 0; i < boundary.length; i++) {
            const flux = boundary[i];
            if (flux.mass <= 0) continue;
            entry.deferredOutboundFlux.accumulate(
              direction,
              i,
              flux.mass,
              flux.velocityX,
              flux.velocityZ,
              flux.tick,
              flux.bedY,
            );
          }
          entry.outboundFlux.clearDirection(direction);
          continue;
        }

        const deferred = entry.deferredOutboundFlux.entries(direction);
        for (let i = 0; i < deferred.length; i++) {
          const flux = deferred[i];
          if (flux.mass <= 0) continue;
          const deliveryTick = neighbor.lastBoundarySyncTick || flux.tick;
          neighbor.inboundFlux.accumulate(
            targetDirection,
            i,
            flux.mass,
            flux.velocityX,
            flux.velocityZ,
            deliveryTick,
            flux.bedY,
          );
        }
        entry.deferredOutboundFlux.clearDirection(direction);

        const boundary = entry.outboundFlux.entries(direction);
        for (let i = 0; i < boundary.length; i++) {
          const flux = boundary[i];
          if (flux.mass <= 0) continue;
          const deliveryTick = neighbor.lastBoundarySyncTick || flux.tick;
          neighbor.inboundFlux.accumulate(
            targetDirection,
            i,
            flux.mass,
            flux.velocityX,
            flux.velocityZ,
            deliveryTick,
            flux.bedY,
          );
        }
        entry.outboundFlux.clearDirection(direction);
      }
    }

    for (const [key, entry] of this.entries) {
      if (!entry.isRetired) continue;
      if (this.hasFlux(entry.inboundFlux)) continue;
      if (this.hasFlux(entry.deferredOutboundFlux)) continue;
      this.entries.delete(key);
    }
  }
}