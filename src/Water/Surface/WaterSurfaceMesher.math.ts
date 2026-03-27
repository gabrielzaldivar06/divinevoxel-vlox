import { WaterColumnSample, WaterSectionGrid } from "../Types/WaterTypes";
import {
  WATER_CREST_AMPLITUDE,
  WATER_CREST_FINE_AMPLITUDE,
  WATER_SURFACE_NOISE_AMPLITUDE,
  WaterPoint,
} from "./WaterSurfaceMesher.types";

export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

export function bilerp(v00: number, v10: number, v01: number, v11: number, tx: number, tz: number) {
  return lerp(lerp(v00, v10, tx), lerp(v01, v11, tx), tz);
}

export function waterHashCell(
  cx: number,
  cz: number,
  fx: number,
  fz: number,
): number {
  let s = (Math.imul(cx, 0x9e3779b9) ^ Math.imul(cz, 0x6c62272e)) >>> 0;
  s = (Math.imul(s ^ (s >>> 16), 0x45d9f3b)) >>> 0;
  const bias = (s / 0x100000000) * 6.2831853;
  const h = Math.sin(fx * 127.1 + fz * 311.7 + bias) * 43758.5453123;
  return h - Math.floor(h);
}

export function waterHash(x: number, z: number): number {
  const cx = Math.floor(x);
  const cz = Math.floor(z);
  return waterHashCell(cx, cz, x - cx, z - cz);
}

export function getSubdivisionJitter(
  worldX: number,
  worldZ: number,
  jitterScale: number,
): [number, number, number] {
  const cx = Math.floor(worldX);
  const cz = Math.floor(worldZ);
  const fx = worldX - cx;
  const fz = worldZ - cz;
  const hx = waterHashCell(cx, cz, fx * 7.31, fz * 13.17);
  const hz = waterHashCell(cx, cz, fx * 11.03, fz * 5.79);
  const hy = waterHashCell(cx, cz, fx * 3.47, fz * 9.61);
  return [
    (hx - 0.5) * jitterScale,
    (hy - 0.5) * jitterScale * 0.25,
    (hz - 0.5) * jitterScale,
  ];
}

export function encodeWaterClassValue(waterClass: WaterColumnSample["waterClass"]) {
  if (waterClass === "river") return 0;
  if (waterClass === "sea") return 1;
  return 0.5;
}

export function packWaterClassAndTurbidity(classValue: number, turbidity: number) {
  const classCenter = classValue < 0.25 ? 0.16 : classValue > 0.75 ? 0.84 : 0.5;
  return clamp01(classCenter - 0.09 + clamp01(turbidity) * 0.18);
}

export function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

export function smoothstep(edge0: number, edge1: number, x: number) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number) {
  const t2 = t * t;
  const t3 = t2 * t;
  const value = 0.5 * (
    2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
  const minValue = Math.min(p1, p2);
  const maxValue = Math.max(p1, p2);
  return Math.max(minValue, Math.min(maxValue, value));
}

export function sampleSeamCurvePoint(
  prev: WaterPoint,
  start: WaterPoint,
  end: WaterPoint,
  next: WaterPoint,
  t: number,
): WaterPoint {
  return [
    catmullRom(prev[0], start[0], end[0], next[0], t),
    catmullRom(prev[1], start[1], end[1], next[1], t),
    catmullRom(prev[2], start[2], end[2], next[2], t),
  ];
}

export function sampleSeamCurveValue(
  prev: number,
  start: number,
  end: number,
  next: number,
  t: number,
) {
  return catmullRom(prev, start, end, next, t);
}

export function getStableHeightNoise(
  grid: WaterSectionGrid,
  localX: number,
  localZ: number,
) {
  const worldX = grid.originX + localX;
  const worldZ = grid.originZ + localZ;
  const phase = Math.sin(worldX * 127.1 + worldZ * 311.7) * 43758.5453123;
  return (phase - Math.floor(phase) - 0.5) * WATER_SURFACE_NOISE_AMPLITUDE;
}

export function hash2D(x: number, z: number) {
  const n = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return n - Math.floor(n);
}

export function getDeterministicSurfaceScalar(worldX: number, worldZ: number, seed: number) {
  return hash2D(worldX * (0.73 + seed * 0.11), worldZ * (1.17 + seed * 0.07));
}

export function getNonGridSurfaceNoise(worldX: number, worldZ: number) {
  const large = getDeterministicSurfaceScalar(worldX * 0.19, worldZ * 0.23, 1);
  const medium = getDeterministicSurfaceScalar(worldX * 0.47, worldZ * 0.41, 2);
  const fine = getDeterministicSurfaceScalar(worldX * 0.91, worldZ * 0.88, 3);
  return (large - 0.5) * 0.06 + (medium - 0.5) * 0.03 + (fine - 0.5) * 0.01;
}

export function computeWaterCrestStrength(
  fillFactor: number,
  shoreDistance: number,
  openEdgeFactor: number,
  slope: number,
  flowStrength: number,
  interactionInfluence: number,
) {
  const shoreFactor = 1 - clamp01(shoreDistance / 8);
  return clamp01(
    fillFactor * 0.18 +
      shoreFactor * 0.34 +
      openEdgeFactor * 0.22 +
      slope * 0.3 +
      flowStrength * 0.26 +
      interactionInfluence * 0.4,
  );
}

export function computeWaterCrestOffset(
  worldX: number,
  worldZ: number,
  crestStrength: number,
) {
  if (crestStrength <= 0.0001) return 0;
  const baseNoise = getNonGridSurfaceNoise(worldX, worldZ);
  const fineNoise = getDeterministicSurfaceScalar(worldX * 1.37, worldZ * 1.19, 7) - 0.5;
  return baseNoise * WATER_CREST_AMPLITUDE * crestStrength + fineNoise * WATER_CREST_FINE_AMPLITUDE * crestStrength;
}
