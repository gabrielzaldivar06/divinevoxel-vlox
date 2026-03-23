import { Flat3DIndex, Vector3Like } from "@amodx/math";
import { LocationData } from "../../Math";
import { WorldSpaces } from "../WorldSpaces";
import { Section } from "../Section/Section";
import { WorldRegister } from "../WorldRegister";

export interface SectionSnapShotTransferData {
  location: LocationData;
  sections: Uint8Array[];
  used: boolean[];
}

export class SectionSnapShot {
  sections: Uint8Array[] = [];
  location: LocationData = [0, 0, 0, 0];
  private _buffers: ArrayBuffer[] = [];
  private _used: boolean[] = [];

  private _sectionSizeX = 0;
  private _sectionSizeY = 0;
  private _sectionSizeZ = 0;

  constructor() {
    const totalSections = 27;
    for (let i = 0; i < totalSections; i++) {
      const buffer = new ArrayBuffer(Section.GetBufferSize());
      this.sections.push(new Uint8Array(buffer));
      this._buffers.push(buffer);
      this._used[i] = false;
    }
    this._updateSizes();
  }

  private _updateSizes() {
    this._sectionSizeX = WorldSpaces.section.bounds.x;
    this._sectionSizeY = WorldSpaces.section.bounds.y;
    this._sectionSizeZ = WorldSpaces.section.bounds.z;
  }

  reset() {
    const totalSections = 27;
    this.sections.length = 0;
    this._buffers.length = 0;
    this._used.length = 0;
    for (let i = 0; i < totalSections; i++) {
      const buffer = new ArrayBuffer(Section.GetBufferSize());
      this.sections.push(new Uint8Array(buffer));
      this._buffers.push(buffer);
      this._used[i] = false;
    }
    this._isTransfered = false;
    this._updateSizes();
  }

  setLocation(dimension: number, x: number, y: number, z: number) {
    this.location[0] = dimension;
    this.location[1] = x;
    this.location[2] = y;
    this.location[3] = z;
  }

  storeSnapShot() {
    // Guard: reallocate any section buffer whose size doesn't match the current
    // WorldSpaces configuration. This handles two failure modes:
    //   1. Snapshot was constructed/cached before WorldSpaces was fully configured
    //      (buffer too small → set() throws RangeError).
    //   2. Buffer was neutered after an ArrayBuffer transfer and was never properly
    //      restored (byteLength === 0 → set() throws TypeError).
    const expectedSize = Section.GetBufferSize();
    for (let i = 0; i < this.sections.length; i++) {
      if (this.sections[i].byteLength !== expectedSize) {
        const buf = new ArrayBuffer(expectedSize);
        this._buffers[i] = buf;
        this.sections[i] = new Uint8Array(buf);
      }
    }
    this._updateSizes();

    const sizeX = this._sectionSizeX;
    const sizeY = this._sectionSizeY;
    const sizeZ = this._sectionSizeZ;
    const dim = this.location[0];
    const ox = this.location[1];
    const oy = this.location[2];
    const oz = this.location[3];
    const sections = this.sections;
    const used = this._used;
    const world = WorldSpaces.world;
    const sectorReg = WorldRegister.sectors;

    let index = 0;
    for (let z = 0; z < 3; z++) {
      const wz = oz + (z - 1) * sizeZ;
      for (let y = 0; y < 3; y++) {
        const wy = oy + (y - 1) * sizeY;
        for (let x = 0; x < 3; x++) {
          const wx = ox + (x - 1) * sizeX;
          const i = index++;
          const snapShotSection = sections[i];
          const beenUsed = used[i];

          if (!world.inBounds(wx, wy, wz)) {
            if (beenUsed) snapShotSection.fill(0);
            used[i] = false;
            continue;
          }

          const sector = sectorReg.get(dim, wx, wy, wz);
          if (!sector) {
            if (beenUsed) snapShotSection.fill(0);
            used[i] = false;
            continue;
          }

          used[i] = true;
          const sectionView = sector.getSection(wx, wy, wz).view;
          // Guard: source sector buffer may be detached when using non-shared
          // memory (ArrayBuffer gets neutered after worker transfer).
          if (sectionView.buffer.byteLength === 0) {
            snapShotSection.fill(0);
            used[i] = false;
            continue;
          }
          snapShotSection.set(sectionView);
        }
      }
    }
  }

  private _isTransfered = false;

  isTransfered() {
    return this._isTransfered;
  }

  transfer(): [SectionSnapShotTransferData, ArrayBuffer[]] {
    this._isTransfered = true;
    return [
      {
        location: this.location,
        sections: this.sections,
        used: this._used,
      },
      this._buffers,
    ];
  }

  restore(data: SectionSnapShotTransferData) {
    this.sections = data.sections;
    this.location = data.location;
    this._used = data.used;
    this._isTransfered = false;
    for (let i = 0; i < this.sections.length; i++) {
      this._buffers[i] = this.sections[i].buffer as ArrayBuffer;
    }
  }
}
