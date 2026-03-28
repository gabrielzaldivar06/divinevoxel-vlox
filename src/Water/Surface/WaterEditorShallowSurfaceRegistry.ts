type EditorShallowSurfaceRecord = {
  x: number;
  y: number;
  z: number;
  radius: number;
  strength: number;
  bornAt: number;
  lingerDuration: number;
  connectedAt: number;
};

export type ActiveEditorShallowSurfaceRecord = EditorShallowSurfaceRecord & {
  age: number;
  normalizedAge: number;
  connected: boolean;
  handoff: number;
  remaining: number;
};

const MAX_EDITOR_SHALLOW_SURFACE_RECORDS = 128;
const HANDOFF_DURATION = 1.1;
const records: EditorShallowSurfaceRecord[] = [];

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
    if (record.connectedAt > 0) {
      if (now - record.connectedAt > HANDOFF_DURATION) {
        records.splice(i, 1);
      }
      continue;
    }
    if (now - record.bornAt > record.lingerDuration) {
      records.splice(i, 1);
    }
  }
}

function getRecordEnvelope(record: EditorShallowSurfaceRecord, now: number) {
  if (record.connectedAt > 0) {
    const handoffAge = Math.max(0, now - record.connectedAt);
    return 1 - smoothstep(0, HANDOFF_DURATION, handoffAge);
  }

  const age = Math.max(0, now - record.bornAt);
  const lateFade = smoothstep(record.lingerDuration * 0.72, record.lingerDuration, age);
  return 1 - lateFade;
}

export function registerEditorShallowSurface(
  x: number,
  y: number,
  z: number,
  radius = 1,
  strength = 1,
  lingerDuration = 9,
) {
  const now = nowSeconds();
  pruneExpired(now);

  const nextRadius = Math.max(1.1, radius);
  const nextStrength = clamp01(strength);
  const mergeDistance = nextRadius + 1.5;
  for (const record of records) {
    const dx = record.x - x;
    const dz = record.z - z;
    if (Math.hypot(dx, dz) > mergeDistance) continue;
    record.x = (record.x + x) * 0.5;
    record.y = Math.max(record.y, y);
    record.z = (record.z + z) * 0.5;
    record.radius = Math.max(record.radius, nextRadius);
    record.strength = Math.max(record.strength, nextStrength);
    record.bornAt = now;
    record.lingerDuration = Math.max(record.lingerDuration, lingerDuration);
    record.connectedAt = 0;
    return;
  }

  records.push({
    x,
    y,
    z,
    radius: nextRadius,
    strength: nextStrength,
    bornAt: now,
    lingerDuration: Math.max(1.5, lingerDuration),
    connectedAt: 0,
  });

  if (records.length > MAX_EDITOR_SHALLOW_SURFACE_RECORDS) {
    records.splice(0, records.length - MAX_EDITOR_SHALLOW_SURFACE_RECORDS);
  }
}

export function eraseEditorShallowSurfaceNear(
  x: number,
  z: number,
  radius = 1.5,
) {
  const now = nowSeconds();
  pruneExpired(now);
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    const dx = record.x - x;
    const dz = record.z - z;
    const distance = Math.hypot(dx, dz);
    if (distance <= radius + record.radius) {
      records.splice(i, 1);
    }
  }
}

export function sampleEditorShallowSurfaceInfluence(x: number, z: number) {
  const now = nowSeconds();
  pruneExpired(now);
  let influence = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    const envelope = getRecordEnvelope(record, now);
    if (envelope <= 0) continue;
    const dx = x - record.x;
    const dz = z - record.z;
    const distance = Math.hypot(dx, dz);
    const horizontalFalloff = 1 - smoothstep(0, record.radius + 1.85, distance);
    if (horizontalFalloff <= 0) continue;
    influence = Math.max(influence, horizontalFalloff * envelope * record.strength);
  }
  return clamp01(influence);
}

export function getActiveEditorShallowSurfaceRecords() {
  const now = nowSeconds();
  pruneExpired(now);
  const active: ActiveEditorShallowSurfaceRecord[] = [];
  for (const record of records) {
    const age = Math.max(0, now - record.bornAt);
    const normalizedAge = clamp01(age / Math.max(0.0001, record.lingerDuration));
    const connected = record.connectedAt > 0;
    const handoff = connected ? clamp01((now - record.connectedAt) / HANDOFF_DURATION) : 0;
    const remaining = getRecordEnvelope(record, now);
    if (remaining <= 0) continue;
    active.push({
      ...record,
      age,
      normalizedAge,
      connected,
      handoff,
      remaining,
    });
  }
  return active;
}

function sampleLargeBodyFieldAt(
  field: Float32Array,
  size: number,
  localX: number,
  localZ: number,
  boundsX: number,
  boundsZ: number,
) {
  if (!field.length || size <= 0) return 0;
  const fx = clamp01((localX + 0.5) / Math.max(boundsX, 1)) * (size - 1);
  const fz = clamp01((localZ + 0.5) / Math.max(boundsZ, 1)) * (size - 1);
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const x1 = Math.min(size - 1, x0 + 1);
  const z1 = Math.min(size - 1, z0 + 1);
  const tx = fx - x0;
  const tz = fz - z0;
  const v00 = field[x0 * size + z0] ?? 0;
  const v10 = field[x1 * size + z0] ?? 0;
  const v01 = field[x0 * size + z1] ?? 0;
  const v11 = field[x1 * size + z1] ?? 0;
  const north = v00 + (v10 - v00) * tx;
  const south = v01 + (v11 - v01) * tx;
  return north + (south - north) * tz;
}

export function markEditorShallowSurfaceConnectedByLargeBody(
  originX: number,
  originZ: number,
  boundsX: number,
  boundsZ: number,
  largeBodyField: Float32Array,
  largeBodyFieldSize: number,
) {
  const now = nowSeconds();
  pruneExpired(now);
  for (const record of records) {
    if (record.connectedAt > 0) continue;
    if (now - record.bornAt < 0.35) continue;
    const localX = record.x - originX;
    const localZ = record.z - originZ;
    if (localX < -2 || localX > boundsX + 1 || localZ < -2 || localZ > boundsZ + 1) {
      continue;
    }
    const largeBodySignal = sampleLargeBodyFieldAt(
      largeBodyField,
      largeBodyFieldSize,
      localX,
      localZ,
      boundsX,
      boundsZ,
    );
    if (largeBodySignal >= 0.42) {
      record.connectedAt = now;
    }
  }
}

export function clearEditorShallowSurfaceRegistry() {
  records.length = 0;
}
