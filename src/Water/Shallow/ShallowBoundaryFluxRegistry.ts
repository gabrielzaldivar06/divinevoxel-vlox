import type {
  ShallowColumnState,
  ShallowWaterSectionGrid,
} from "./ShallowWaterTypes";
import {
  WaterBoundaryFluxBuffer,
  type WaterBoundaryDirection,
  type WaterBoundaryFluxEntry,
  getOppositeBoundaryDirection,
} from "../Runtime/WaterBoundaryFluxBuffer.js";

export interface ShallowGhostColumn {
  active: boolean;
  bedY: number;
  surfaceY: number;
  thickness: number;
  spreadVX: number;
  spreadVZ: number;
}

export interface ShallowGhostColumnSet {
  north: ShallowGhostColumn[];
  south: ShallowGhostColumn[];
  east: ShallowGhostColumn[];
  west: ShallowGhostColumn[];
}

export interface ShallowBoundaryFluxSnapshot {
  north: WaterBoundaryFluxEntry[];
  south: WaterBoundaryFluxEntry[];
  east: WaterBoundaryFluxEntry[];
  west: WaterBoundaryFluxEntry[];
}

interface PendingShallowSectionBootstrap {
  key: string;
  originX: number;
  originZ: number;
  bedYHint: number;
  sizeX: number;
  sizeZ: number;
}

interface ShallowBoundaryRuntimeEntry {
  key: string;
  originX: number;
  originZ: number;
  sizeX: number;
  sizeZ: number;
  ghostColumns: ShallowGhostColumnSet;
  inboundFlux: WaterBoundaryFluxBuffer;
  outboundFlux: WaterBoundaryFluxBuffer;
  deferredOutboundFlux: WaterBoundaryFluxBuffer;
  lastBoundarySyncTick: number;
  isRetired: boolean;
}

function sectionKey(originX: number, originZ: number) {
  return `${originX}_${originZ}`;
}

function createGhostColumn(): ShallowGhostColumn {
  return {
    active: false,
    bedY: 0,
    surfaceY: 0,
    thickness: 0,
    spreadVX: 0,
    spreadVZ: 0,
  };
}

function createGhostColumns(size: number) {
  return Array.from({ length: size }, () => createGhostColumn());
}

function createGhostColumnSet(sizeX: number, sizeZ: number): ShallowGhostColumnSet {
  return {
    north: createGhostColumns(sizeX),
    south: createGhostColumns(sizeX),
    east: createGhostColumns(sizeZ),
    west: createGhostColumns(sizeZ),
  };
}

function resetGhostColumn(target: ShallowGhostColumn) {
  target.active = false;
  target.bedY = 0;
  target.surfaceY = 0;
  target.thickness = 0;
  target.spreadVX = 0;
  target.spreadVZ = 0;
}

function clearGhostColumnSet(target: ShallowGhostColumnSet) {
  for (const column of target.north) resetGhostColumn(column);
  for (const column of target.south) resetGhostColumn(column);
  for (const column of target.east) resetGhostColumn(column);
  for (const column of target.west) resetGhostColumn(column);
}

function copyGhostColumn(target: ShallowGhostColumn, source: ShallowColumnState | null) {
  if (!source) {
    resetGhostColumn(target);
    return;
  }

  target.active = source.active;
  target.bedY = source.bedY;
  target.surfaceY = source.active ? source.surfaceY : source.bedY;
  target.thickness = source.active ? source.thickness : 0;
  target.spreadVX = source.spreadVX;
  target.spreadVZ = source.spreadVZ;
}

function getBoundaryColumn(
  section: ShallowWaterSectionGrid,
  direction: WaterBoundaryDirection,
  index: number,
): ShallowColumnState | null {
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

function hasFlux(buffer: WaterBoundaryFluxBuffer) {
  const directions: WaterBoundaryDirection[] = ["north", "south", "east", "west"];
  for (const direction of directions) {
    for (const entry of buffer.entries(direction)) {
      if (entry.mass > 0) return true;
    }
  }
  return false;
}

function measureFlux(buffer: WaterBoundaryFluxBuffer) {
  let total = 0;
  const directions: WaterBoundaryDirection[] = ["north", "south", "east", "west"];
  for (const direction of directions) {
    for (const entry of buffer.entries(direction)) {
      if (entry.mass <= 0) continue;
      total += entry.mass;
    }
  }
  return total;
}

export class ShallowBoundaryFluxRegistry {
  private readonly entries = new Map<string, ShallowBoundaryRuntimeEntry>();
  private readonly pendingSectionBootstraps = new Map<string, PendingShallowSectionBootstrap>();

  clear() {
    this.entries.clear();
    this.pendingSectionBootstraps.clear();
  }

  removeSection(originX: number, originZ: number) {
    const key = sectionKey(originX, originZ);
    this.entries.delete(key);
    this.pendingSectionBootstraps.delete(key);
  }

  retireSection(originX: number, originZ: number) {
    const key = sectionKey(originX, originZ);
    const entry = this.entries.get(key);
    if (entry) {
      entry.isRetired = true;
      entry.outboundFlux.clear();
      clearGhostColumnSet(entry.ghostColumns);
    }
    this.pendingSectionBootstraps.delete(key);
  }

  private getOrCreateEntry(
    originX: number,
    originZ: number,
    sizeX: number,
    sizeZ: number,
  ): ShallowBoundaryRuntimeEntry {
    const key = sectionKey(originX, originZ);
    const existing = this.entries.get(key);
    if (existing && existing.sizeX === sizeX && existing.sizeZ === sizeZ) {
      return existing;
    }

    const boundarySize = Math.max(sizeX, sizeZ);
    const next: ShallowBoundaryRuntimeEntry = {
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

  beginTick(sections: ReadonlyMap<string, ShallowWaterSectionGrid>, tick: number) {
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

  getGhostColumns(originX: number, originZ: number): ShallowGhostColumnSet | null {
    return this.entries.get(sectionKey(originX, originZ))?.ghostColumns ?? null;
  }

  consumeInboundFlux(originX: number, originZ: number): ShallowBoundaryFluxSnapshot | null {
    const entry = this.entries.get(sectionKey(originX, originZ));
    if (!entry) return null;
    return entry.inboundFlux.cloneAndClear();
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
    bedY?: number,
  ) {
    const entry = this.entries.get(sectionKey(originX, originZ));
    if (!entry) return;
    entry.outboundFlux.accumulate(direction, index, mass, velocityX, velocityZ, tick, bedY);
  }

  queueReceiverSection(
    originX: number,
    originZ: number,
    bedYHint: number,
    sizeX: number,
    sizeZ: number,
  ) {
    const key = sectionKey(originX, originZ);
    const existing = this.pendingSectionBootstraps.get(key);
    if (existing) {
      if (Number.isFinite(bedYHint)) {
        existing.bedYHint =
          !Number.isFinite(existing.bedYHint)
            ? bedYHint
            : Math.min(existing.bedYHint, bedYHint);
      }
      return;
    }

    this.pendingSectionBootstraps.set(key, {
      key,
      originX,
      originZ,
      bedYHint,
      sizeX,
      sizeZ,
    });
  }

  materializePendingSections(
    createSection: (originX: number, originZ: number, bedYHint: number) => void,
  ) {
    for (const pending of this.pendingSectionBootstraps.values()) {
      createSection(pending.originX, pending.originZ, pending.bedYHint);
      this.getOrCreateEntry(pending.originX, pending.originZ, pending.sizeX, pending.sizeZ);
    }
    this.pendingSectionBootstraps.clear();
  }

  hasPendingTransfers(originX: number, originZ: number) {
    const key = sectionKey(originX, originZ);
    if (this.pendingSectionBootstraps.has(key)) return true;
    const entry = this.entries.get(key);
    if (!entry) return false;
    return (
      hasFlux(entry.inboundFlux) ||
      hasFlux(entry.outboundFlux) ||
      hasFlux(entry.deferredOutboundFlux)
    );
  }

  measureBufferedMass() {
    let total = 0;
    for (const entry of this.entries.values()) {
      total += measureFlux(entry.inboundFlux);
      total += measureFlux(entry.outboundFlux);
      total += measureFlux(entry.deferredOutboundFlux);
    }
    return total;
  }

  finalizeTick(currentTick?: number) {
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
          const deliveryTick = neighbor.lastBoundarySyncTick || currentTick || flux.tick;
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
          const deliveryTick = neighbor.lastBoundarySyncTick || currentTick || flux.tick;
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
      if (hasFlux(entry.inboundFlux)) continue;
      if (hasFlux(entry.deferredOutboundFlux)) continue;
      this.entries.delete(key);
    }
  }
}