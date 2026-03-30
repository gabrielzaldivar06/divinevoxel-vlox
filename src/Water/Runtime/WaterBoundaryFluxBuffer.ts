export type WaterBoundaryDirection = "north" | "south" | "east" | "west";

export interface WaterBoundaryFluxEntry {
  mass: number;
  velocityX: number;
  velocityZ: number;
  tick: number;
  bedY: number;
}

function createFluxEntry(): WaterBoundaryFluxEntry {
  return {
    mass: 0,
    velocityX: 0,
    velocityZ: 0,
    tick: 0,
    bedY: Number.NaN,
  };
}

function copyFluxEntry(entry: WaterBoundaryFluxEntry): WaterBoundaryFluxEntry {
  return {
    mass: entry.mass,
    velocityX: entry.velocityX,
    velocityZ: entry.velocityZ,
    tick: entry.tick,
    bedY: entry.bedY,
  };
}

function resetFluxEntry(entry: WaterBoundaryFluxEntry) {
  entry.mass = 0;
  entry.velocityX = 0;
  entry.velocityZ = 0;
  entry.tick = 0;
  entry.bedY = Number.NaN;
}

function createFluxArray(size: number) {
  return Array.from({ length: size }, () => createFluxEntry());
}

export function getOppositeBoundaryDirection(
  direction: WaterBoundaryDirection,
): WaterBoundaryDirection {
  switch (direction) {
    case "north":
      return "south";
    case "south":
      return "north";
    case "east":
      return "west";
    case "west":
      return "east";
  }
}

export class WaterBoundaryFluxBuffer {
  readonly north: WaterBoundaryFluxEntry[];
  readonly south: WaterBoundaryFluxEntry[];
  readonly east: WaterBoundaryFluxEntry[];
  readonly west: WaterBoundaryFluxEntry[];

  constructor(readonly size: number) {
    this.north = createFluxArray(size);
    this.south = createFluxArray(size);
    this.east = createFluxArray(size);
    this.west = createFluxArray(size);
  }

  private getBuffer(direction: WaterBoundaryDirection) {
    switch (direction) {
      case "north":
        return this.north;
      case "south":
        return this.south;
      case "east":
        return this.east;
      case "west":
        return this.west;
    }
  }

  clear() {
    for (const entry of this.north) resetFluxEntry(entry);
    for (const entry of this.south) resetFluxEntry(entry);
    for (const entry of this.east) resetFluxEntry(entry);
    for (const entry of this.west) resetFluxEntry(entry);
  }

  entries(direction: WaterBoundaryDirection) {
    return this.getBuffer(direction);
  }

  clearDirection(direction: WaterBoundaryDirection) {
    for (const entry of this.getBuffer(direction)) {
      resetFluxEntry(entry);
    }
  }

  accumulate(
    direction: WaterBoundaryDirection,
    index: number,
    mass: number,
    velocityX: number,
    velocityZ: number,
    tick: number,
    bedY?: number,
  ) {
    if (index < 0 || index >= this.size || mass <= 0) return;

    const entry = this.getBuffer(direction)[index];
    const nextMass = entry.mass + mass;
    if (nextMass <= 0) return;

    if (entry.mass === 0) {
      entry.velocityX = velocityX;
      entry.velocityZ = velocityZ;
    } else {
      entry.velocityX = (entry.velocityX * entry.mass + velocityX * mass) / nextMass;
      entry.velocityZ = (entry.velocityZ * entry.mass + velocityZ * mass) / nextMass;
    }
    const resolvedBedY = typeof bedY === "number" && Number.isFinite(bedY) ? bedY : undefined;
    if (resolvedBedY !== undefined) {
      if (!Number.isFinite(entry.bedY) || entry.mass === 0) {
        entry.bedY = resolvedBedY;
      } else {
        entry.bedY = (entry.bedY * entry.mass + resolvedBedY * mass) / nextMass;
      }
    }
    entry.mass = nextMass;
    entry.tick = tick;
  }

  cloneAndClear() {
    const snapshot = {
      north: this.north.map(copyFluxEntry),
      south: this.south.map(copyFluxEntry),
      east: this.east.map(copyFluxEntry),
      west: this.west.map(copyFluxEntry),
    };
    this.clear();
    return snapshot;
  }
}