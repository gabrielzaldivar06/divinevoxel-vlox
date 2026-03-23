import { DimensionSegment } from "../Dimensions/DimensionSegment";
import { BrushTool } from "../../Tools/Brush/Brush";
import { TaskTool } from "../../Tools/Tasks/TasksTool";
import { WorldSimulationTools } from "../Internal/WorldSimulationTools";
import { LocationData } from "../../Math";
import { VoxelBehaviorsRegister } from "../Voxels/Behaviors";
import { VoxelTagsRegister } from "../../Voxels/Data/VoxelTagsRegister";
import { VoxelLUT } from "../../Voxels/Data/VoxelLUT";
import { IVoxelTemplate } from "../../Templates/VoxelTemplates.types";
import { VoxelUpdateData } from "../../Tasks/Tasks.types";
import { VoxelPath } from "../../Templates/Path/VoxelPath";
import { PaintVoxel } from "../../Tasks/Paint/Paint/PaintVoxel";
import PaintVoxelTemplate from "../../Tasks/Paint/Paint/PaintVoxelTemplate";
import PaintVoxelPath from "../../Tasks/Paint/Paint/PaintVoxelPath";
import { EraseVoxel } from "../../Tasks/Paint/Erase/EraseVoxel";
import EraseVoxelTemplate from "../../Tasks/Paint/Erase/EraseVoxelTemplate";
import EraseVoxelPath from "../../Tasks/Paint/Erase/EraseVoxelPath";
import { IVoxelSelection } from "../../Templates/Selection/VoxelSelection";
import EraseVoxelSelection from "../../Tasks/Paint/Erase/EraseVoxelSelection";
import { canUpdate } from "../../Tasks/Paint/Common";

function getBehaviorForVoxelId(voxelId: number) {
  const tags = VoxelTagsRegister.VoxelTags[voxelId];
  return VoxelBehaviorsRegister.get(
    tags?.["dve_simulation_behavior"] || "default"
  );
}

function forEachVoxelPathPosition(
  voxelPath: VoxelPath,
  updateData: VoxelUpdateData,
  visitor: (x: number, y: number, z: number) => void
) {
  const visited = new Set<string>();

  for (let i = 0; i < voxelPath.segments.length; i++) {
    const { start, end } = voxelPath.segments[i];
    const [sx, sy, sz] = start;
    const [ex, ey, ez] = end;

    const dx = ex - sx;
    const dy = ey - sy;
    const dz = ez - sz;
    const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));

    if (steps === 0) {
      if (!canUpdate(sx, sy, sz, updateData)) continue;
      const key = `${sx}:${sy}:${sz}`;
      if (visited.has(key)) continue;
      visited.add(key);
      visitor(sx, sy, sz);
      continue;
    }

    const stepX = dx / steps;
    const stepY = dy / steps;
    const stepZ = dz / steps;

    let x = sx;
    let y = sy;
    let z = sz;

    for (let step = 0; step <= steps; step++) {
      const vx = Math.floor(x);
      const vy = Math.floor(y);
      const vz = Math.floor(z);
      x += stepX;
      y += stepY;
      z += stepZ;
      if (!canUpdate(vx, vy, vz, updateData)) continue;
      const key = `${vx}:${vy}:${vz}`;
      if (visited.has(key)) continue;
      visited.add(key);
      visitor(vx, vy, vz);
    }
  }
}

export class SimulationBrush extends BrushTool {
  private taskTool: TaskTool;

  _location: LocationData = [0, 0, 0, 0];
  _mapLocation() {
    this._location[0] = this._dimension.id;
    this._location[1] = this.x;
    this._location[2] = this.y;
    this._location[3] = this.z;
  }
  constructor(public _dimension: DimensionSegment) {
    super();
    this.taskTool = WorldSimulationTools.taskTool;
  }

  paint(updateData: VoxelUpdateData = {}) {
    this._mapLocation();
    const x = this.x;
    const y = this.y;
    const z = this.z;
    const tags =
      VoxelTagsRegister.VoxelTags[
        VoxelLUT.voxelIds.getNumberId(this.data.id)
      ];

    const behavior = VoxelBehaviorsRegister.get(
      tags?.["dve_simulation_behavior"] || "default"
    );
    PaintVoxel(this._location, this.getRaw(), updateData);
    behavior.onPaint(this._dimension.simulation, x, y, z);
    return this;
  }

  async paintAsync(updateData: VoxelUpdateData = {}) {
    this._mapLocation();
    const x = this.x;
    const y = this.y;
    const z = this.z;
    const tags =
      VoxelTagsRegister.VoxelTags[
        VoxelLUT.voxelIds.getNumberId(this.data.id)
      ];

    const behavior = VoxelBehaviorsRegister.get(
      tags?.["dve_simulation_behavior"] || "default"
    );

    await this.taskTool.voxel.paint.runAsync([
      this._location,
      this.getRaw(),
      updateData,
    ]);
    behavior.onPaint(this._dimension.simulation, x, y, z);
  }

  paintTemplate(
    voxelTemplate: IVoxelTemplate,
    updateData: VoxelUpdateData = {}
  ) {
    PaintVoxelTemplate(
      this.dimension,
      [this.x, this.y, this.z],
      voxelTemplate.toJSON(),
      updateData
    );

    const { x: ox, y: oy, z: oz } = this;
    const { x: sx, y: sy, z: sz } = voxelTemplate.bounds.size;

    for (let x = 0; x < sx; x++) {
      for (let y = 0; y < sy; y++) {
        for (let z = 0; z < sz; z++) {
          const tx = ox + x;
          const ty = oy + y;
          const tz = oz + z;
          const voxel = this.dataCursor.getVoxel(tx, ty, tz);
          if (voxelTemplate.isAir(voxelTemplate.getIndex(x, y, z))) continue;
          if (!voxel) continue;
          const behavior = getBehaviorForVoxelId(voxel.getVoxelId());

          behavior.onPaint(this._dimension.simulation, tx, ty, tz);
        }
      }
    }
    return this;
  }

  async paintTemplateAsync(
    voxelTemplate: IVoxelTemplate,
    updateData: VoxelUpdateData = {}
  ) {
    await this.taskTool.voxel.paintTemplate.runAsync([
      this.dimension,
      [this.x, this.y, this.z],
      voxelTemplate.toJSON(),
      updateData,
    ]);
    const { x: ox, y: oy, z: oz } = this;
    const { x: sx, y: sy, z: sz } = voxelTemplate.bounds.size;

    for (let x = 0; x < sx; x++) {
      for (let y = 0; y < sy; y++) {
        for (let z = 0; z < sz; z++) {
          const tx = ox + x;
          const ty = oy + y;
          const tz = oz + z;
          const voxel = this.dataCursor.getVoxel(tx, ty, tz);
          if (voxelTemplate.isAir(voxelTemplate.getIndex(x, y, z))) continue;
          if (!voxel) continue;
          const behavior = getBehaviorForVoxelId(voxel.getVoxelId());

          behavior.onPaint(this._dimension.simulation, tx, ty, tz);
        }
      }
    }
    return this;
  }

  paintPath(voxelPath: VoxelPath, updateData: VoxelUpdateData = {}) {
    PaintVoxelPath(
      this.dimension,
      [this.x, this.y, this.z],
      voxelPath.toJSON(),
      updateData
    );

    forEachVoxelPathPosition(voxelPath, updateData, (tx, ty, tz) => {
      const voxel = this.dataCursor.getVoxel(tx, ty, tz);
      if (!voxel || voxel.isAir()) return;
      const behavior = getBehaviorForVoxelId(voxel.getVoxelId());
      behavior.onPaint(this._dimension.simulation, tx, ty, tz);
    });

    return this;
  }

  async paintPathAsync(voxelPath: VoxelPath, updateData: VoxelUpdateData = {}) {
    await this.taskTool.voxel.paintPath.runAsync([
      this.dimension,
      [this.x, this.y, this.z],
      voxelPath.toJSON(),
      updateData,
    ]);

    forEachVoxelPathPosition(voxelPath, updateData, (tx, ty, tz) => {
      const voxel = this.dataCursor.getVoxel(tx, ty, tz);
      if (!voxel || voxel.isAir()) return;
      const behavior = getBehaviorForVoxelId(voxel.getVoxelId());
      behavior.onPaint(this._dimension.simulation, tx, ty, tz);
    });

    return this;
  }

  erase(updateData: VoxelUpdateData = {}) {
    this._mapLocation();
    const x = this.x;
    const y = this.y;
    const z = this.z;
    const voxel = this._dimension.simulation.getVoxelForUpdate(x, y, z);
    if (!voxel || voxel.isAir()) {
      EraseVoxel(this._location, updateData);
      return this;
    }
    const behavior = getBehaviorForVoxelId(voxel.getVoxelId());
    EraseVoxel(this._location, updateData);
    behavior.onErase(this._dimension.simulation, x, y, z);
    return this;
  }

  async eraseAsync(updateData: VoxelUpdateData = {}) {
    this._mapLocation();
    const x = this.x;
    const y = this.y;
    const z = this.z;
    const voxel = this._dimension.simulation.getVoxelForUpdate(x, y, z);
    if (!voxel || voxel.isAir()) {
      await this.taskTool.voxel.erase.runAsync([this._location, updateData]);
      return;
    }
    const behavior = getBehaviorForVoxelId(voxel.getVoxelId());
    await this.taskTool.voxel.erase.runAsync([this._location, updateData]);
    behavior.onErase(this._dimension.simulation, x, y, z);
  }
  eraseTemplate(
    voxelTemplate: IVoxelTemplate,
    updateData: VoxelUpdateData = {}
  ) {
    const { x: ox, y: oy, z: oz } = this;
    const { x: sx, y: sy, z: sz } = voxelTemplate.bounds.size;

    for (let x = 0; x < sx; x++) {
      for (let y = 0; y < sy; y++) {
        for (let z = 0; z < sz; z++) {
          const tx = ox + x;
          const ty = oy + y;
          const tz = oz + z;
          if (voxelTemplate.isAir(voxelTemplate.getIndex(x, y, z))) continue;
          const voxel = this.dataCursor.getVoxel(tx, ty, tz);
          if (!voxel || voxel.isAir()) continue;
          const behavior = getBehaviorForVoxelId(voxel.getVoxelId());

          behavior.onErase(this._dimension.simulation, tx, ty, tz);
        }
      }
    }

    EraseVoxelTemplate(
      this.dimension,
      [this.x, this.y, this.z],
      voxelTemplate.toJSON(),
      updateData
    );

    return this;
  }

  async eraseTemplateAsync(
    voxelTemplate: IVoxelTemplate,
    updateData: VoxelUpdateData = {}
  ) {
    const { x: ox, y: oy, z: oz } = this;
    const { x: sx, y: sy, z: sz } = voxelTemplate.bounds.size;
    for (let x = 0; x < sx; x++) {
      for (let y = 0; y < sy; y++) {
        for (let z = 0; z < sz; z++) {
          const tx = ox + x;
          const ty = oy + y;
          const tz = oz + z;
          if (voxelTemplate.isAir(voxelTemplate.getIndex(x, y, z))) continue;
          const voxel = this.dataCursor.getVoxel(tx, ty, tz);
          if (!voxel || voxel.isAir()) continue;
          const behavior = getBehaviorForVoxelId(voxel.getVoxelId());

          behavior.onErase(this._dimension.simulation, tx, ty, tz);
        }
      }
    }
    await this.taskTool.voxel.eraseTemplate.runAsync([
      this.dimension,
      [this.x, this.y, this.z],
      voxelTemplate.toJSON(),
      updateData,
    ]);

    return this;
  }

  eraseSelection(selection: IVoxelSelection, updateData: VoxelUpdateData = {}) {
    const { x: ox, y: oy, z: oz } = this;
    const { x: sx, y: sy, z: sz } = selection.bounds.size;

    for (let x = 0; x < sx; x++) {
      for (let y = 0; y < sy; y++) {
        for (let z = 0; z < sz; z++) {
          const tx = ox + x;
          const ty = oy + y;
          const tz = oz + z;
          if (!selection.isSelected(tx, ty, tz)) continue;
          const voxel = this.dataCursor.getVoxel(tx, ty, tz);
          if (!voxel || voxel.isAir()) continue;
          const behavior = getBehaviorForVoxelId(voxel.getVoxelId());

          behavior.onErase(this._dimension.simulation, tx, ty, tz);
        }
      }
    }

    EraseVoxelSelection(
      this.dimension,
      [this.x, this.y, this.z],
      selection.toJSON(),
      updateData
    );

    return this;
  }

  async eraseSelectionAsync(
    selection: IVoxelSelection,
    updateData: VoxelUpdateData = {}
  ) {
    const { x: ox, y: oy, z: oz } = this;
    const { x: sx, y: sy, z: sz } = selection.bounds.size;
    for (let x = 0; x < sx; x++) {
      for (let y = 0; y < sy; y++) {
        for (let z = 0; z < sz; z++) {
          const tx = ox + x;
          const ty = oy + y;
          const tz = oz + z;
          if (!selection.isSelected(tx, ty, tz)) continue;
          const voxel = this.dataCursor.getVoxel(tx, ty, tz);
          if (!voxel || voxel.isAir()) continue;
          const behavior = getBehaviorForVoxelId(voxel.getVoxelId());

          behavior.onErase(this._dimension.simulation, tx, ty, tz);
        }
      }
    }
    await this.taskTool.voxel.eraseSelection.runAsync([
      this.dimension,
      [this.x, this.y, this.z],
      selection.toJSON(),
      updateData,
    ]);

    return this;
  }

  erasePath(voxelPath: VoxelPath, updateData: VoxelUpdateData = {}) {
    forEachVoxelPathPosition(voxelPath, updateData, (tx, ty, tz) => {
      const voxel = this.dataCursor.getVoxel(tx, ty, tz);
      if (!voxel || voxel.isAir()) return;
      const behavior = getBehaviorForVoxelId(voxel.getVoxelId());
      behavior.onErase(this._dimension.simulation, tx, ty, tz);
    });

    EraseVoxelPath(
      this.dimension,
      [this.x, this.y, this.z],
      voxelPath.toJSON(),
      updateData
    );

    return this;
  }

  async erasePathAsync(voxelPath: VoxelPath, updateData: VoxelUpdateData = {}) {
    forEachVoxelPathPosition(voxelPath, updateData, (tx, ty, tz) => {
      const voxel = this.dataCursor.getVoxel(tx, ty, tz);
      if (!voxel || voxel.isAir()) return;
      const behavior = getBehaviorForVoxelId(voxel.getVoxelId());
      behavior.onErase(this._dimension.simulation, tx, ty, tz);
    });

    await this.taskTool.voxel.erasePath.runAsync([
      this.dimension,
      [this.x, this.y, this.z],
      voxelPath.toJSON(),
      updateData,
    ]);

    return this;
  }
}
