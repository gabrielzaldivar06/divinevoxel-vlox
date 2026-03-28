type WaterBirthRecord = {
  x: number;
  y: number;
  z: number;
  radius: number;
  strength: number;
  bornAt: number;
  settleDuration: number;
};

const MAX_WATER_BIRTH_RECORDS = 96;
const records: WaterBirthRecord[] = [];
let latestBirthAt = 0;

export type ActiveWaterBirthRecord = WaterBirthRecord & {
  age: number;
  normalizedAge: number;
  remaining: number;
};

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = clamp01((x - edge0) / Math.max(0.0001, edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function nowSeconds() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now() * 0.001;
  }
  return Date.now() * 0.001;
}

function pruneExpired(now = nowSeconds()) {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (now - record.bornAt > record.settleDuration + 0.25) {
      records.splice(i, 1);
    }
  }
}

export function registerWaterSurfaceBirth(
  x: number,
  y: number,
  z: number,
  radius = 1,
  strength = 1,
  settleDuration = 1.4,
) {
  const now = nowSeconds();
  latestBirthAt = now;
  pruneExpired(now);
  records.push({
    x,
    y,
    z,
    radius: Math.max(0.75, radius),
    strength: clamp01(strength),
    bornAt: now,
    settleDuration: Math.max(0.2, settleDuration),
  });
  if (records.length > MAX_WATER_BIRTH_RECORDS) {
    records.splice(0, records.length - MAX_WATER_BIRTH_RECORDS);
  }
}

export function getLatestWaterSurfaceBirthAgeSeconds() {
  if (latestBirthAt <= 0) return null;
  return Math.max(0, nowSeconds() - latestBirthAt);
}

export function sampleWaterSurfaceBirthInfluence(
  x: number,
  y: number,
  z: number,
) {
  const now = nowSeconds();
  pruneExpired(now);
  let influence = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    const age = now - record.bornAt;
    if (age < 0 || age > record.settleDuration + 0.25) continue;

    const dx = x - record.x;
    const dz = z - record.z;
    const dy = y - record.y;
    const horizontalDistance = Math.sqrt(dx * dx + dz * dz);
    const horizontalFalloff = 1 - smoothstep(0, record.radius + 2.6, horizontalDistance);
    if (horizontalFalloff <= 0) continue;

    const verticalFalloff = 1 - smoothstep(0.2, 3.4, Math.abs(dy));
    if (verticalFalloff <= 0) continue;

    const normalizedAge = clamp01(age / record.settleDuration);
    const birthPulse = 1 - smoothstep(0, 0.18, normalizedAge);
    const settlingTail = 1 - smoothstep(0.18, 1, normalizedAge);
    const ageEnvelope = Math.max(birthPulse * 0.82 + settlingTail * 0.96, 0);
    influence = Math.max(
      influence,
      horizontalFalloff * verticalFalloff * ageEnvelope * record.strength,
    );
  }
  return clamp01(influence);
}

export function sampleWaterSurfaceBirthPlanarInfluence(
  x: number,
  z: number,
) {
  const now = nowSeconds();
  pruneExpired(now);
  let influence = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    const age = now - record.bornAt;
    if (age < 0 || age > record.settleDuration + 0.25) continue;

    const dx = x - record.x;
    const dz = z - record.z;
    const horizontalDistance = Math.sqrt(dx * dx + dz * dz);
    const horizontalFalloff = 1 - smoothstep(0, record.radius + 3.2, horizontalDistance);
    if (horizontalFalloff <= 0) continue;

    const normalizedAge = clamp01(age / record.settleDuration);
    const ageEnvelope = 1 - smoothstep(0.08, 1, normalizedAge);
    influence = Math.max(
      influence,
      horizontalFalloff * ageEnvelope * record.strength,
    );
  }
  return clamp01(influence);
}

export function isWaterSurfaceBirthMaskActive(
  x: number,
  z: number,
  threshold = 0.01,
) {
  return sampleWaterSurfaceBirthPlanarInfluence(x, z) > threshold;
}

export function clearWaterSurfaceBirthRegistry() {
  records.length = 0;
}

export function getActiveWaterSurfaceBirthRecords() {
  const now = nowSeconds();
  pruneExpired(now);
  const active: ActiveWaterBirthRecord[] = [];
  for (const record of records) {
    const age = Math.max(0, now - record.bornAt);
    const normalizedAge = clamp01(age / record.settleDuration);
    const remaining = clamp01(1 - normalizedAge);
    if (remaining <= 0) continue;
    active.push({
      ...record,
      age,
      normalizedAge,
      remaining,
    });
  }
  return active;
}
