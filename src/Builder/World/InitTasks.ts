import { WorldSimulation } from "../../WorldSimulation";
import { Threads } from "@amodx/threads";
import { LocationData } from "../../Math";
import { PaintVoxelData, RawVoxelData } from "../../Voxels";
import { Vec3Array, Vector3Like } from "@amodx/math";
import { IVoxelTemplateData } from "../../Templates/VoxelTemplates.types";
import { VoxelPathData } from "../../Templates/Path/VoxelPath.types";
import { VoxelTemplateRegister } from "../../Templates/VoxelTemplateRegister";
import { VoxelPath } from "../../Templates/Path/VoxelPath";
import { VoxelUpdateData } from "../../Tasks/Tasks.types";
import PickVoxelWorld from "../../Voxels/Interaction/Functions/PickVoxelWorld";
import { WorldCursor } from "../../World";

import LockSectors from "../../World/Lock/Function/LockSectors";
import UnLockSectors from "../../World/Lock/Function/UnLockSectors";
import { BoundingBox } from "@amodx/math/Geometry/Bounds/BoundingBox";
import { VoxelSurfaceSelection } from "../../Templates/Selection/VoxelSurfaceSelection";
import { VoxelBFSSelection } from "../../Templates/Selection/VoxelBFSSelection";
import CreateFullTemplate from "../../Templates/Full/Functions/CreateFullTemplate";
import { BoundsMinMaxData } from "@amodx/math/Geometry/Bounds/BoundsInterface";
import { FullVoxelTemplateData } from "../../Templates/Full/FullVoxelTemplate.types";
import { IVoxelSelectionData } from "../../Templates/Selection/VoxelSelection";
import { ExtrudeSelection } from "../../Templates/Functions/ExtrudeSelection";
import ReplaceVoxelTemplate from "../../Tasks/Paint/Paint/ReplaceVoxelTemplate";

export function InitTasks() {
  const dimension = WorldSimulation.getDimension(0);
  const brush = dimension.getBrush();
  const cursor = new WorldCursor();

  const surfaceSelection = new VoxelSurfaceSelection();
  const bfsSelection = new VoxelBFSSelection();

  const updateData: VoxelUpdateData = {
    includedAreas: [],
  };
  const buildAreaBounds = new BoundingBox();

  Threads.registerTask<[min: Vector3Like, max: Vector3Like], any>(
    "get-box-area-template",
    async ([min, max]) => {
      const areaBounds = new BoundingBox(min, max);
      await LockSectors(cursor.dimension, areaBounds);
      const archived = CreateFullTemplate(cursor, { min, max });
      await UnLockSectors(cursor.dimension, areaBounds);
      return [archived];
    }
  );

  Threads.registerTask<[min: Vec3Array, max: Vec3Array]>(
    "set-build-area",
    async ([min, max]) => {
      buildAreaBounds.setMinMax(
        Vector3Like.Create(...min),
        Vector3Like.Create(...max)
      );
      updateData.includedAreas = [[min, max]];
    }
  );

  Threads.registerTask<
    [position: Vec3Array, direction: Vec3Array, length: number],
    any
  >("pick-voxel", async ([position, direction, length]) => {
    const pickedVoxel = await PickVoxelWorld(
      cursor,
      position,
      direction,
      length
    );
    //pick voxels error when not using shared memory if the secotrs are check out
    return [pickedVoxel?.toJSON() || null];
  });

  /**
   * Selections
   */
  Threads.registerTask<
    [
      position: Vector3Like,
      normal: Vector3Like,
      extrusion: number,
      maxSize?: number
    ]
  >(
    "get-voxel-surface-selection",
    async ([position, normal, extrusion, maxSize]) => {
      const selBounds = new BoundingBox(
        Vector3Like.Create(position.x, position.y, position.z),
        Vector3Like.Create(position.x, position.y, position.z)
      );
      await LockSectors(cursor.dimension, selBounds);
      surfaceSelection.reConstruct(
        cursor,
        position,
        normal,
        extrusion,
        maxSize
      );
      await UnLockSectors(cursor.dimension, selBounds);
      return [surfaceSelection.toJSON()];
    }
  );

  Threads.registerTask<[data: IVoxelSelectionData<any>, normal: Vector3Like]>(
    "get-extruded-voxel-selection-template",
    async ([selectionData, normal]) => {
      const selection = VoxelTemplateRegister.createSelection(selectionData);
      await LockSectors(cursor.dimension, selection.bounds);
      const fullVoxelTemplate = ExtrudeSelection(cursor, selection, normal);
      await UnLockSectors(cursor.dimension, selection.bounds);

      return [fullVoxelTemplate.toJSON()];
    }
  );

  Threads.registerTask<[position: Vector3Like, maxSize?: number]>(
    "get-voxel-bfs-selection",
    async ([position, maxSize]) => {
      const bfsBounds = new BoundingBox(
        Vector3Like.Create(position.x, position.y, position.z),
        Vector3Like.Create(position.x, position.y, position.z)
      );
      await LockSectors(cursor.dimension, bfsBounds);
      bfsSelection.reConstruct(cursor, position, maxSize);
      await UnLockSectors(cursor.dimension, bfsBounds);
      return [bfsSelection.toJSON()];
    }
  );

  /**
   * Painting
   */
  Threads.registerTask<[LocationData, RawVoxelData]>(
    "paint-voxel",
    async ([location, raw]) => {
      const voxelBounds = new BoundingBox(
        Vector3Like.Create(location[1], location[2], location[3]),
        Vector3Like.Create(location[1], location[2], location[3])
      );
      await LockSectors(location[0], voxelBounds);
      brush.setXYZ(location[1], location[2], location[3]);
      brush.setRaw(raw);
      brush.paint(updateData);
      await UnLockSectors(location[0], voxelBounds);
    }
  );

  Threads.registerTask<LocationData, number>("erase-voxel", async (location) => {
    const voxelBounds = new BoundingBox(
      Vector3Like.Create(location[1], location[2], location[3]),
      Vector3Like.Create(location[1], location[2], location[3])
    );
    await LockSectors(location[0], voxelBounds);
    cursor.setFocalPoint(location[0], location[1], location[2], location[3]);
    const erasedVoxelId = cursor.getVoxel(location[1], location[2], location[3])?.getVoxelId() || 0;
    brush.dimension = location[0];
    brush.setXYZ(location[1], location[2], location[3]);
    brush.erase(updateData);
    await UnLockSectors(location[0], voxelBounds);
    return [erasedVoxelId];
  });

  Threads.registerTask<
    [location: LocationData, BoundsMinMaxData],
    FullVoxelTemplateData
  >("create-voxel-template", async ([location, bounds]) => {
    const boundingBox = new BoundingBox(bounds.min, bounds.max);
    await LockSectors(location[0], boundingBox);
    const template = CreateFullTemplate(cursor, bounds, true);
    await UnLockSectors(location[0], boundingBox);
    return [template];
  });

  Threads.registerTask<[location: LocationData, data: IVoxelTemplateData<any>]>(
    "paint-voxel-template",
    async ([location, data]) => {
      const template = VoxelTemplateRegister.create(data);
      brush.dimension = location[0];
      await LockSectors(location[0], template.bounds);
      brush
        .setXYZ(location[1], location[2], location[3])
        .paintTemplate(template, updateData);
      await UnLockSectors(location[0], template.bounds);
    }
  );

  Threads.registerTask<[location: LocationData, data: IVoxelTemplateData<any>]>(
    "replace-voxel-template",
    async ([location, data]) => {
      const template = VoxelTemplateRegister.create(data);
      brush.dimension = location[0];
      await LockSectors(location[0], template.bounds);
      ReplaceVoxelTemplate(
        location[0],
        [location[1], location[2], location[3]],
        data,
        updateData
      );
      await UnLockSectors(location[0], template.bounds);
    }
  );

  Threads.registerTask<[location: LocationData, data: IVoxelTemplateData<any>]>(
    "erase-voxel-template",
    async ([location, data]) => {
      brush.dimension = location[0];
      const template = VoxelTemplateRegister.create(data);
      await LockSectors(location[0], template.bounds);
      brush
        .setXYZ(location[1], location[2], location[3])
        .eraseTemplate(template, updateData);
      await UnLockSectors(location[0], template.bounds);
    }
  );
  Threads.registerTask<
    [location: LocationData, data: IVoxelSelectionData<any>]
  >("erase-voxel-selection", async ([location, selectionData]) => {
    brush.dimension = location[0];
    const selection = VoxelTemplateRegister.createSelection(selectionData);
    await LockSectors(location[0], selection.bounds);
    brush
      .setXYZ(location[1], location[2], location[3])
      .eraseSelection(selection, updateData);
    await UnLockSectors(location[0], selection.bounds);
  });

  Threads.registerTask<[location: LocationData, data: VoxelPathData]>(
    "paint-voxel-path",
    async ([location, data]) => {
      const pathBounds = new BoundingBox(
        Vector3Like.Create(location[1], location[2], location[3]),
        Vector3Like.Create(location[1], location[2], location[3])
      );
      await LockSectors(location[0], pathBounds);
      brush.dimension = location[0];
      brush
        .setXYZ(location[1], location[2], location[3])
        .paintPath(new VoxelPath(data), updateData);
      await UnLockSectors(location[0], pathBounds);
    }
  );

  Threads.registerTask<[location: LocationData, data: VoxelPathData]>(
    "erase-voxel-path",
    async ([location, data]) => {
      const pathBounds = new BoundingBox(
        Vector3Like.Create(location[1], location[2], location[3]),
        Vector3Like.Create(location[1], location[2], location[3])
      );
      await LockSectors(location[0], pathBounds);
      brush.dimension = location[0];
      brush
        .setXYZ(location[1], location[2], location[3])
        .erasePath(new VoxelPath(data), updateData);
      await UnLockSectors(location[0], pathBounds);
    }
  );
}
