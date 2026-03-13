import { VoxelModelBuilder } from "../Models/VoxelModelBuilder";
import { VoxelLUT } from "../../../Voxels/Data/VoxelLUT";
import { GeometryLUT } from "../../../Voxels/Data/GeometryLUT";
import { VoxelGeometryConstructorRegister } from "../Models/VoxelGeometryConstructorRegister";

  export function BuildVoxel(builder: VoxelModelBuilder): boolean {
    let added = false;
    // DEBUG: track BuildVoxel calls
    if (!(globalThis as any).__DVE_BUILD_STATS__) {
      (globalThis as any).__DVE_BUILD_STATS__ = {
        calls: 0,
        geoFound: 0,
        nodeTypes: [] as string[],
        addCalled: 0,
        addReturned: 0,
      };
    }
    const _bs = (globalThis as any).__DVE_BUILD_STATS__;
    _bs.calls++;
    const hashed = builder.space.getHash(
      builder.nVoxel,
      builder.position.x,
      builder.position.y,
      builder.position.z
    );

    const trueVoxelId = builder.voxel.getVoxelId();
    const voxelId = builder.space!.voxelCache[hashed];
    const reltionalVoxelId = builder.space!.reltionalVoxelCache[hashed];

    const geomtriesIndex = VoxelLUT.getGeometryIndex(voxelId, reltionalVoxelId);
    const geomtries = GeometryLUT.geometryIndex[geomtriesIndex];

    const inputsIndex = VoxelLUT.getGeometryInputIndex(
      voxelId,
      reltionalVoxelId
    );
    const inputs = GeometryLUT.geometryInputsIndex[inputsIndex];

    const geometriesLength = geomtries.length;

    for (let i = 0; i < geometriesLength; i++) {
      const nodeId = geomtries[i];
      const inputsIndex = inputs[i];
      const geoInputs = GeometryLUT.geometryInputs[inputsIndex];
      const geometry = VoxelGeometryConstructorRegister.geometry[nodeId];
      _bs.geoFound++;
      const nodesLength = geometry.nodes.length;
      for (let k = 0; k < nodesLength; k++) {
        const geo = geometry.nodes[k];
        if (_bs.nodeTypes.length < 30 && !_bs.nodeTypes.includes(geo.constructor.name)) {
          _bs.nodeTypes.push(geo.constructor.name);
        }
        geo.builder = builder;
        _bs.addCalled++;
        const addedGeo = geo.add(geoInputs[k]);
        if (addedGeo) { added = true; _bs.addReturned++; }
      }
    }

    const conditioanlNodes = VoxelLUT.getConditionalGeometryNodes(VoxelLUT.modelsIndex[trueVoxelId]);
    if (conditioanlNodes) {
      const modelState = VoxelLUT.voxelIdToState[voxelId];
      const reltionalState = builder.space!.reltionalStateCache[hashed];
      const nodesLength = conditioanlNodes.length;

      for (let i = 0; i < nodesLength; i++) {
        const [geoId, requiredModelState, requiredModelReltionalState] =
          conditioanlNodes[i];
        if (
          requiredModelState !== modelState ||
          !requiredModelReltionalState[reltionalState]
        )
          continue;

        const geomtries = GeometryLUT.geometryIndex[geoId];
        const inputsIndex = VoxelLUT.getConditionalGeometryInputIndex(
          geoId,
          voxelId,
          reltionalVoxelId
        );

        const inputs = GeometryLUT.geometryInputsIndex[inputsIndex];

        const geometriesLength = geomtries.length;

        for (let i = 0; i < geometriesLength; i++) {
          const nodeId = geomtries[i];
          const inputsIndex = inputs[i];
          const geoInputs = GeometryLUT.geometryInputs[inputsIndex];
          const geometry = VoxelGeometryConstructorRegister.geometry[nodeId];
          const nodesLength = geometry.nodes.length;
          for (let k = 0; k < nodesLength; k++) {
            const geo = geometry.nodes[k];
            geo.builder = builder;
            const addedGeo = geo.add(geoInputs[k]);
            if (addedGeo) added = true;
          }
        }
      }
    }

    /*     this.effects.addEffects(
      builder.voxel.getState(),
      builder.origin,
      builder.effects
    ); */

    builder.clearCalculatedData();

    return added;
  }
