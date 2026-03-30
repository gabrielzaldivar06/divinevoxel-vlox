import { WaterColumnSample } from "../Types/WaterTypes";
import { VoxelMeshVertexConstants } from "../../Mesher/Voxels/Geometry/VoxelMeshVertexStructCursor";

export type WaterSurfaceMesherStrategy = "cpu" | "gpu";

export type WaterSurfaceMesherOptions = {
  minSurfaceY?: number;
  maxSurfaceY?: number;
  mesherStrategy?: WaterSurfaceMesherStrategy;
};

export type WaterPatchStitchContext = {
  continuitySignature: number;
  meanSurfaceHeight: number;
  meanThickness: number;
  meanFlow: number;
  meanTurbulence: number;
  shoreInfluence: number;
  dominantWaveDirectionX: number;
  dominantWaveDirectionZ: number;
};

export type WaterSurfaceMesherRegime =
  | "openSurface"
  | "shoreBand"
  | "channelRibbon"
  | "wallContact"
  | "dropEdge";

export type WaterSurfaceColumnSelector = (
  column: WaterColumnSample,
  lx: number,
  lz: number,
) => boolean;

export type WaterVertexContext = {
  fillFactor: number;
  shoreDistance: number;
  openEdgeFactor: number;
  interactionInfluence: number;
  surfaceWarp: number;
  flowX: number;
  flowZ: number;
  flowStrength: number;
  waterClassValue: number;
};

export type WaterPoint = [number, number, number];

export type WaterSurfaceSpline = {
  heights: [
    [number, number, number, number],
    [number, number, number, number],
    [number, number, number, number],
    [number, number, number, number],
  ];
};

export type WaterSurfaceVertexPayload = {
  dropHeight: number;
  foamCrest: number;
  foamEdge: number;
  foamImpact: number;
};

export const VERTEX_SIZE = VoxelMeshVertexConstants.VertexFloatSize;
export const WATER_SEAM_EPSILON = 0.001;
export const SEA_LEVEL_BAND = 2.5;
export const SEA_OPEN_BLEND_START = 6;
export const SEA_OPEN_BLEND_END = 24;
export const RIVER_FLOW_BLEND_START = 0.12;
export const RIVER_FLOW_BLEND_END = 0.52;
export const COASTAL_BLEND_DISTANCE = 6;
export const CLASS_NEIGHBOR_BLEND_RADIUS = 1;
export const WATER_CORNER_SAMPLE_RADIUS = 2;
export const WATER_UNIFORM_SUBDIVISIONS = 2;
export const WATER_CREST_AMPLITUDE = 0.07;
export const WATER_CREST_FINE_AMPLITUDE = 0.025;
export const WATER_SURFACE_NOISE_AMPLITUDE = 0.012;
export const MIN_LAYERED_SEAM_FILL = 0.72;
export const MIN_LAYERED_SEAM_SLOPE = 0.24;
export const MIN_LAYERED_SEAM_DEPTH = 0.4;
export const MAX_LAYERED_SEAM_OPEN_EDGE = 0.34;

export type WaterSurfaceMesherProfile = {
  surfaceDamping: number;
  surfaceWarp: number;
  aperiodicDetailStrength: number;
  flowAnisotropy: number;
  ribbonPinch: number;
  wallLean: number;
  seamSlopeBoost: number;
  seamOpenEdgeScale: number;
};

export type WaterPreparedCellRenderData = {
  column: WaterColumnSample;
  heightNorm: number;
  fillFactor: number;
  shoreDistance: number;
  openEdgeFactor: number;
  flowX: number;
  flowZ: number;
  flowStrength: number;
  waterClassValue: number;
  profile: WaterSurfaceMesherProfile;
  vertexPayload: WaterSurfaceVertexPayload;
  cornerPayloads: [
    WaterSurfaceVertexPayload,
    WaterSurfaceVertexPayload,
    WaterSurfaceVertexPayload,
    WaterSurfaceVertexPayload,
  ];
  vertexContexts: [
    WaterVertexContext,
    WaterVertexContext,
    WaterVertexContext,
    WaterVertexContext,
  ];
  adjustedTop: {
    topNE: WaterPoint;
    topNW: WaterPoint;
    topSW: WaterPoint;
    topSE: WaterPoint;
    stableSurfaceHeight: number;
  };
  surfaceSpline: WaterSurfaceSpline;
  cellSlope: number;
  cellSurfaceWarp: number;
  subdivisions: number;
};
