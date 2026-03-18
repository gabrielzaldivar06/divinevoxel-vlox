import { Vec2Array, Vector3Like } from "@amodx/math";
export interface MesherSettingsData {
}
export declare class MesherSettingsData {
    /**Tell the mesher to shade voxel faces with sun light data. Disable if you are using a custom renderering pipeline. */
    doSunLight: boolean;
    /**Tell the mesher to use the built in AO system. Disable if you are using a custom renderering pipeline. */
    doAO: boolean;
    doColors: boolean;
}
export interface RenderSettingsData {
}
export declare class RenderSettingsData {
    /**Set the mode to change how mesh data is generated based on the underlying rendering API. */
    mode: "webgl" | "webgpu";
    /**Renderer will not dispose of buffers to keep them renderering. */
    cpuBound: boolean;
    bufferMode: "single" | "multi";
    textureSize: Vec2Array;
    sharpTextureSampling: boolean;
}
export interface UpdatingSettings {
}
export declare class UpdatingSettings {
    /**Sector sections are marked as dirty so they can be processed later. */
    dirtyMechanism: boolean;
    /**Updated sector sections are auto rebuilt */
    autoRebuild: boolean;
}
export interface WorldSettings {
}
export declare class WorldSettings {
    min: Vector3Like;
    max: Vector3Like;
    sectorPower2Size: Vector3Like;
    sectionPower2Size: Vector3Like;
}
export interface PropagationSettings {
}
export declare class PropagationSettings {
    rgbLightEnabled: boolean;
    sunLightEnabled: boolean;
    flowEnabled: boolean;
    powerEnabled: boolean;
}
export interface MemoryAndCPUSettings {
}
export declare class MemoryAndCPUSettings {
    useSharedMemory: boolean;
}
export interface TerrainSettingsData {
}
export declare class TerrainSettingsData {
    visualV2: boolean;
    macroVariation: boolean;
    materialTriplanar: boolean;
    materialWetness: boolean;
    surfaceMetadata: boolean;
    surfaceHeightGradient: boolean;
    surfaceOverlays: boolean;
    transitionMeshes: boolean;
    transitionMeshMinDistance: number;
    transitionMeshMaxDistance: number;
    viewConeCulling: boolean;
    viewConeThreshold: number;
    horizonCulling: boolean;
    horizonExtraHeight: number;
    nearCameraHighDetail: boolean;
    microVariation: boolean;
    benchmarkPreset: "off" | "baseline" | "material-preview" | "material-import" | "optimum-inspired" | "universalis-inspired" | "phase-3-preview" | "pbr-premium" | "pbr-premium-v2" | "pbr-surface-lod" | "phase-4-geometry" | "definitivo";
    benchmarkLabel: string;
    defaultTextureUpscale: number;
    defaultSharpTextureSampling: boolean;
    defaultCameraFov: number;
    dissolution: boolean;
    dissolutionIntensity: number;
    dissolutionSplats: boolean;
    dissolutionTemporal: boolean;
    surfaceNets: boolean;
    surfaceNetsIsoLevel: number;
    atmosphericSplats: boolean;
    lodMorph: boolean;
    /**
     * Maximum number of active scene meshes (draw-call budget).
     * Each active mesh = 1 draw call per render pass.
     * Budget prevents mesh-count regression from new features.
     * Default 800 covers ~50 sections × 16 materials with headroom.
     */
    maxSceneMeshes: number;
}
export declare class EngineSettingsData {
    memoryAndCPU: MemoryAndCPUSettings;
    mesher: MesherSettingsData;
    rendererSettings: RenderSettingsData;
    terrain: TerrainSettingsData;
    updating: UpdatingSettings;
    world: WorldSettings;
    propagation: PropagationSettings;
}
