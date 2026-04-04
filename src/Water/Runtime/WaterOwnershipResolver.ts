import type { ContinuousWaterSection } from "../Continuous/ContinuousWaterTypes.js";
import type { ShallowWaterSectionGrid } from "../Shallow/ShallowWaterTypes.js";
import type { RuntimeWaterOwnershipDomain } from "../Contracts/WaterSemanticContract.js";

export interface WaterOwnershipResolutionSummary {
  shallowOwned: number;
  continuousOwned: number;
  contested: number;
  preview: WaterOwnershipPreview;
}

export interface WaterOwnershipColumnDecision {
  domain: RuntimeWaterOwnershipDomain;
  confidence: number;
  contested: boolean;
}

export interface WaterOwnershipPreview {
  tick: number;
  sectionSizes: Map<string, { sizeX: number; sizeZ: number }>;
  domains: Map<string, Uint8Array>;
  confidence: Map<string, Float32Array>;
}

const OWNERSHIP_NONE = 0;
const OWNERSHIP_SHALLOW = 1;
const OWNERSHIP_CONTINUOUS = 2;

function getColumnIndex(sizeX: number, x: number, z: number) {
  return z * sizeX + x;
}

function sectionKey(originX: number, originZ: number) {
  return `${originX}_${originZ}`;
}

function encodeOwnershipDomain(domain: RuntimeWaterOwnershipDomain) {
  switch (domain) {
    case "shallow":
      return OWNERSHIP_SHALLOW;
    case "continuous":
      return OWNERSHIP_CONTINUOUS;
    default:
      return OWNERSHIP_NONE;
  }
}

function decodeOwnershipDomain(code: number): RuntimeWaterOwnershipDomain {
  switch (code) {
    case OWNERSHIP_SHALLOW:
      return "shallow";
    case OWNERSHIP_CONTINUOUS:
      return "continuous";
    default:
      return "none";
  }
}

function normalizeRuntimeOwnershipDomain(
  domain: ContinuousWaterSection["columns"][number]["ownershipDomain"] | ShallowWaterSectionGrid["columns"][number]["ownershipDomain"] | undefined,
): RuntimeWaterOwnershipDomain {
  return domain === "shallow" || domain === "continuous" ? domain : "none";
}

export function getOwnershipPreviewDomain(
  preview: WaterOwnershipPreview | null | undefined,
  originX: number,
  originZ: number,
  x: number,
  z: number,
  sizeX: number,
): RuntimeWaterOwnershipDomain {
  if (!preview) return "none";

  const key = sectionKey(originX, originZ);
  const domains = preview.domains.get(key);
  if (!domains) return "none";

  const index = getColumnIndex(sizeX, x, z);
  return decodeOwnershipDomain(domains[index] ?? OWNERSHIP_NONE);
}

export function shouldSimulateShallowColumn(
  preview: WaterOwnershipPreview | null | undefined,
  originX: number,
  originZ: number,
  x: number,
  z: number,
  sizeX: number,
) {
  if (!preview) return true;
  return getOwnershipPreviewDomain(preview, originX, originZ, x, z, sizeX) === "shallow";
}

export function shouldSimulateContinuousColumn(
  preview: WaterOwnershipPreview | null | undefined,
  originX: number,
  originZ: number,
  x: number,
  z: number,
  sizeX: number,
) {
  if (!preview) return true;
  return getOwnershipPreviewDomain(preview, originX, originZ, x, z, sizeX) === "continuous";
}

export class WaterOwnershipResolver {
  constructor(
    readonly promoteDepth = 0.5,
    readonly demoteDepth = 0.18,
    readonly minTicksInDomain = 3,
  ) {}

  private getContinuousColumnAt(
    continuousSections: ReadonlyMap<string, ContinuousWaterSection>,
    worldX: number,
    worldZ: number,
  ) {
    const sectionSize = 16;
    const originX = Math.floor(worldX / sectionSize) * sectionSize;
    const originZ = Math.floor(worldZ / sectionSize) * sectionSize;
    const section = continuousSections.get(sectionKey(originX, originZ));
    if (!section) return undefined;
    const localX = ((worldX % section.sizeX) + section.sizeX) % section.sizeX;
    const localZ = ((worldZ % section.sizeZ) + section.sizeZ) % section.sizeZ;
    return section.columns[getColumnIndex(section.sizeX, localX, localZ)];
  }

  private hasAdjacentContinuousSupport(
    continuousSections: ReadonlyMap<string, ContinuousWaterSection>,
    originX: number,
    originZ: number,
    x: number,
    z: number,
  ) {
    const worldX = originX + x;
    const worldZ = originZ + z;
    for (const [dx, dz] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ] as const) {
      const column = this.getContinuousColumnAt(
        continuousSections,
        worldX + dx,
        worldZ + dz,
      );
      if (!column?.active || column.depth <= 0.0001) continue;
      if (column.ownershipDomain !== "continuous") continue;
      return true;
    }
    return false;
  }

  private getPreviousResolvedState(
    shallow: ShallowWaterSectionGrid["columns"][number] | undefined,
    continuous: ContinuousWaterSection["columns"][number] | undefined,
  ) {
    const shallowTicks = shallow?.ownershipTicks ?? 0;
    const continuousTicks = continuous?.ownershipTicks ?? 0;

    if (continuousTicks > shallowTicks) {
      return {
        domain: normalizeRuntimeOwnershipDomain(continuous?.ownershipDomain),
        confidence: continuous?.ownershipConfidence ?? 0,
        ticks: continuousTicks,
      };
    }

    return {
      domain: normalizeRuntimeOwnershipDomain(
        shallow?.ownershipDomain ?? continuous?.ownershipDomain,
      ),
      confidence: shallow?.ownershipConfidence ?? continuous?.ownershipConfidence ?? 0,
      ticks: Math.max(shallowTicks, continuousTicks),
    };
  }

  private canKeepPreviousDomain(
    domain: RuntimeWaterOwnershipDomain,
    shallow: ShallowWaterSectionGrid["columns"][number] | undefined,
    continuous: ContinuousWaterSection["columns"][number] | undefined,
  ) {
    if (domain === "shallow") {
      const forcedContinuousTransfer =
        !!shallow?.active &&
        shallow.ownershipConfidence >= 0.6 &&
        shallow.handoffPending &&
        (shallow.pendingOwnershipDomain ?? shallow.ownershipDomain) === "continuous" &&
        !!continuous?.active &&
        continuous.depth > 0.0001;
      if (forcedContinuousTransfer) {
        return false;
      }
      return !!shallow?.active && shallow.thickness > 0.0001;
    }
    if (domain === "continuous") {
      return !!continuous?.active && continuous.depth > 0.0001;
    }
    return true;
  }

  private getOwnershipStabilityScale(ticks: number) {
    if (this.minTicksInDomain <= 1) return 1;
    return Math.max(0.45, Math.min(1, ticks / this.minTicksInDomain));
  }

  private getAdaptiveMinTicksForTransition(
    previousDomain: RuntimeWaterOwnershipDomain,
    rawDomain: RuntimeWaterOwnershipDomain,
    rawConfidence: number,
    shallow: ShallowWaterSectionGrid["columns"][number] | undefined,
    continuous: ContinuousWaterSection["columns"][number] | undefined,
  ) {
    if (
      this.minTicksInDomain <= 2 ||
      previousDomain === "none" ||
      rawDomain === "none" ||
      previousDomain === rawDomain
    ) {
      return this.minTicksInDomain;
    }

    const rapidContinuousPromotion =
      rawDomain === "continuous" &&
      (
        (!!shallow?.active && shallow.thickness >= this.promoteDepth * 1.15) ||
        (!!continuous?.active &&
          continuous.authority !== "bootstrap" &&
          continuous.depth >= this.promoteDepth * 1.05) ||
        rawConfidence >= 0.9
      );

    const rapidShallowDemotion =
      rawDomain === "shallow" &&
      (
        (!!continuous?.active && continuous.depth <= this.demoteDepth * 0.6) ||
        ((shallow?.thickness ?? 0) >= this.demoteDepth * 0.7 && rawConfidence >= 0.82) ||
        rawConfidence >= 0.9
      );

    if (rapidContinuousPromotion || rapidShallowDemotion) {
      return Math.max(2, this.minTicksInDomain - 1);
    }

    return this.minTicksInDomain;
  }

  private resolveColumnDecision(
    shallow: ShallowWaterSectionGrid["columns"][number] | undefined,
    continuous: ContinuousWaterSection["columns"][number] | undefined,
  ): WaterOwnershipColumnDecision {
    const shallowActive = !!shallow?.active && shallow.thickness > 0.0001;
    const continuousActive = !!continuous?.active && continuous.depth > 0.0001;
    const shallowGraceTicks = shallowActive ? shallow?.handoffGraceTicks ?? 0 : 0;
    const continuousGraceTicks = continuousActive ? continuous?.handoffGraceTicks ?? 0 : 0;

    if (!shallowActive && !continuousActive) {
      return {
        domain: "none",
        confidence: 1,
        contested: false,
      };
    }

    if (shallowGraceTicks > 0 || continuousGraceTicks > 0) {
      if (continuousGraceTicks > shallowGraceTicks) {
        return {
          domain: "continuous",
          confidence: 1,
          contested: shallowActive,
        };
      }
      if (shallowGraceTicks > continuousGraceTicks) {
        return {
          domain: "shallow",
          confidence: 1,
          contested: continuousActive,
        };
      }
      if (continuousActive && continuous?.authority !== "bootstrap") {
        return {
          domain: "continuous",
          confidence: 1,
          contested: shallowActive,
        };
      }
      if (shallowActive) {
        return {
          domain: "shallow",
          confidence: 1,
          contested: continuousActive,
        };
      }
    }

    if (continuousActive && continuous?.ownershipLocked) {
      return {
        domain: "continuous",
        confidence: 1,
        contested: shallowActive,
      };
    }

    if (
      shallowActive &&
      continuousActive &&
      shallow!.handoffPending &&
      (shallow!.pendingOwnershipDomain ?? shallow!.ownershipDomain) === "continuous" &&
      continuous!.authority !== "bootstrap"
    ) {
      return {
        domain: "continuous",
        confidence: 0.98,
        contested: false,
      };
    }

    if (shallowActive && !continuousActive) {
        const promoteToContinuous =
          shallow!.handoffPending &&
          shallow!.thickness >= this.promoteDepth;
      return {
        domain: promoteToContinuous ? "continuous" : "shallow",
        confidence: promoteToContinuous ? 0.9 : Math.min(1, 0.6 + shallow!.thickness),
        contested: false,
      };
    }

    if (continuousActive && !shallowActive) {
      const demoteToShallow = continuous!.depth <= this.demoteDepth;
      return {
        domain: demoteToShallow ? "shallow" : "continuous",
        confidence: demoteToShallow ? 0.8 : Math.min(1, 0.6 + continuous!.depth),
        contested: false,
      };
    }

    if (continuous!.authority !== "bootstrap" && continuous!.depth >= this.promoteDepth) {
      return {
        domain: "continuous",
        confidence: 0.95,
        contested: true,
      };
    }

    if (continuous!.depth <= this.demoteDepth && shallow!.thickness > 0.0001) {
      return {
        domain: "shallow",
        confidence: 0.85,
        contested: true,
      };
    }

    const shallowScore =
      shallow!.thickness / Math.max(this.demoteDepth, 0.0001) +
      (shallow!.authority === "player" || shallow!.authority === "editor" ? 0.1 : 0);
    const continuousScore =
      continuous!.depth / Math.max(this.promoteDepth, 0.0001) +
      (continuous!.authority !== "bootstrap" ? 0.15 : 0) +
      (continuous!.ownershipLocked ? 0.5 : 0);
    const totalScore = shallowScore + continuousScore;
    const domain = continuousScore >= shallowScore ? "continuous" : "shallow";
    const confidence =
      totalScore > 0
        ? Math.min(1, 0.5 + Math.abs(continuousScore - shallowScore) / totalScore)
        : 1;

    return {
      domain,
      confidence,
      contested: true,
    };
  }

  previewAll(
    shallowSections: ReadonlyMap<string, ShallowWaterSectionGrid>,
    continuousSections: ReadonlyMap<string, ContinuousWaterSection>,
    tick: number,
  ): WaterOwnershipResolutionSummary {
    const preview: WaterOwnershipPreview = {
      tick,
      sectionSizes: new Map(),
      domains: new Map(),
      confidence: new Map(),
    };
    const summary: WaterOwnershipResolutionSummary = {
      shallowOwned: 0,
      continuousOwned: 0,
      contested: 0,
      preview,
    };

    const keys = new Set<string>([...shallowSections.keys(), ...continuousSections.keys()]);

    for (const key of keys) {
      const shallowSection = shallowSections.get(key);
      const continuousSection = continuousSections.get(key);
      const sizeX = shallowSection?.sizeX ?? continuousSection?.sizeX ?? 0;
      const sizeZ = shallowSection?.sizeZ ?? continuousSection?.sizeZ ?? 0;
      if (sizeX <= 0 || sizeZ <= 0) continue;

      const domains = new Uint8Array(sizeX * sizeZ);
      const confidence = new Float32Array(sizeX * sizeZ);
      preview.sectionSizes.set(key, { sizeX, sizeZ });

      for (let z = 0; z < sizeZ; z++) {
        for (let x = 0; x < sizeX; x++) {
          const index = getColumnIndex(sizeX, x, z);
          const decision = this.resolveColumnDecision(
            shallowSection?.columns[index],
            continuousSection?.columns[index],
          );

          domains[index] = encodeOwnershipDomain(decision.domain);
          confidence[index] = decision.confidence;

          if (decision.contested) {
            summary.contested += 1;
          }
          if (decision.domain === "continuous") {
            summary.continuousOwned += 1;
          } else if (decision.domain === "shallow") {
            summary.shallowOwned += 1;
          }
        }
      }

      preview.domains.set(key, domains);
      preview.confidence.set(key, confidence);
    }

    return summary;
  }

  resolveAll(
    shallowSections: ReadonlyMap<string, ShallowWaterSectionGrid>,
    continuousSections: ReadonlyMap<string, ContinuousWaterSection>,
    tick: number,
    previewSummary = this.previewAll(shallowSections, continuousSections, tick),
  ): WaterOwnershipResolutionSummary {
    const preview: WaterOwnershipPreview = {
      tick,
      sectionSizes: new Map(previewSummary.preview.sectionSizes),
      domains: new Map(),
      confidence: new Map(),
    };
    const summary: WaterOwnershipResolutionSummary = {
      shallowOwned: 0,
      continuousOwned: 0,
      contested: 0,
      preview,
    };

    for (const [key, size] of previewSummary.preview.sectionSizes) {
      const rawDomains = previewSummary.preview.domains.get(key);
      const rawConfidence = previewSummary.preview.confidence.get(key);
      if (!rawDomains || !rawConfidence) continue;

      const shallowSection = shallowSections.get(key);
      const continuousSection = continuousSections.get(key);
      const resolvedDomains = new Uint8Array(rawDomains.length);
      const resolvedConfidenceGrid = new Float32Array(rawConfidence.length);

      for (let z = 0; z < size.sizeZ; z++) {
        for (let x = 0; x < size.sizeX; x++) {
          const index = getColumnIndex(size.sizeX, x, z);
          const shallow = shallowSection?.columns[index];
          const continuous = continuousSection?.columns[index];
          const previous = this.getPreviousResolvedState(shallow, continuous);
          const rawDomain = decodeOwnershipDomain(rawDomains[index] ?? OWNERSHIP_NONE);
          let resolvedDomain = rawDomain;
          let resolvedConfidenceValue = rawConfidence[index] ?? 0;
          const minTicksForTransition = this.getAdaptiveMinTicksForTransition(
            previous.domain,
            rawDomain,
            resolvedConfidenceValue,
            shallow,
            continuous,
          );

          if (
            previous.domain !== "none" &&
            rawDomain !== previous.domain &&
            rawDomain !== "none" &&
            previous.ticks < minTicksForTransition &&
            this.canKeepPreviousDomain(previous.domain, shallow, continuous)
          ) {
            resolvedDomain = previous.domain;
            resolvedConfidenceValue = Math.min(
              resolvedConfidenceValue,
              Math.max(0.5, previous.confidence),
            );
          }

          const nextOwnershipTicks =
            resolvedDomain === "none"
              ? 0
              : previous.domain === resolvedDomain
                ? previous.ticks + 1
                : 1;

          if (resolvedDomain !== "none") {
            resolvedConfidenceValue *= this.getOwnershipStabilityScale(nextOwnershipTicks);
            if (previous.domain !== "none" && resolvedDomain !== previous.domain) {
              resolvedConfidenceValue = Math.min(resolvedConfidenceValue, 0.55);
            }
          }

          resolvedDomains[index] = encodeOwnershipDomain(resolvedDomain);
          resolvedConfidenceGrid[index] = resolvedConfidenceValue;

          if ((shallow?.active && shallow.thickness > 0.0001) && (continuous?.active && continuous.depth > 0.0001)) {
            summary.contested += 1;
          }
          if (resolvedDomain === "continuous") {
            summary.continuousOwned += 1;
          } else if (resolvedDomain === "shallow") {
            summary.shallowOwned += 1;
          }
        }
      }

      preview.domains.set(key, resolvedDomains);
      preview.confidence.set(key, resolvedConfidenceGrid);
    }

    for (const section of continuousSections.values()) {
      const key = sectionKey(section.originX, section.originZ);
      const domains = preview.domains.get(key);
      const confidence = preview.confidence.get(key);

      for (let z = 0; z < section.sizeZ; z++) {
        for (let x = 0; x < section.sizeX; x++) {
          const index = getColumnIndex(section.sizeX, x, z);
          const column = section.columns[index];
          const domain = decodeOwnershipDomain(domains?.[index] ?? OWNERSHIP_NONE);
          column.pendingOwnershipDomain = domain;
          column.ownershipConfidence = confidence?.[index] ?? 0;
          column.handoffPending =
            column.active && !column.ownershipLocked && column.ownershipConfidence >= 0.6 && domain === "shallow";
          column.lastResolvedTick = tick;
        }
      }
    }

    for (const section of shallowSections.values()) {
      const key = sectionKey(section.originX, section.originZ);
      const domains = preview.domains.get(key);
      const confidence = preview.confidence.get(key);

      for (let z = 0; z < section.sizeZ; z++) {
        for (let x = 0; x < section.sizeX; x++) {
          const index = getColumnIndex(section.sizeX, x, z);
          const column = section.columns[index];
          const domain = decodeOwnershipDomain(domains?.[index] ?? OWNERSHIP_NONE);
          const coastalContinuousClaim =
            column.active &&
            column.thickness > 0.0001 &&
            domain !== "continuous" &&
            this.hasAdjacentContinuousSupport(
              continuousSections,
              section.originX,
              section.originZ,
              x,
              z,
            );
          const pendingDomain = coastalContinuousClaim ? "continuous" : domain;
          column.pendingOwnershipDomain = pendingDomain;
          column.ownershipConfidence = confidence?.[index] ?? 0;
          column.handoffPending =
            column.active && column.ownershipConfidence >= 0.6 && pendingDomain === "continuous";
          column.lastResolvedTick = tick;
        }
      }
    }

    return summary;
  }

  finalizeAll(
    shallowSections: ReadonlyMap<string, ShallowWaterSectionGrid>,
    continuousSections: ReadonlyMap<string, ContinuousWaterSection>,
  ) {
    for (const section of continuousSections.values()) {
      for (const column of section.columns) {
        const domain = column.pendingOwnershipDomain;
        if (!domain) continue;
        const previousDomain = column.ownershipDomain;
        column.ownershipDomain = domain;
        column.ownershipTicks =
          domain === "none" ? 0 : previousDomain === domain ? column.ownershipTicks + 1 : 1;
        column.pendingOwnershipDomain = undefined;
      }
    }

    for (const section of shallowSections.values()) {
      for (const column of section.columns) {
        const domain = column.pendingOwnershipDomain;
        if (!domain) continue;
        const previousDomain = column.ownershipDomain;
        column.ownershipDomain = domain;
        column.ownershipTicks =
          domain === "none" ? 0 : previousDomain === domain ? column.ownershipTicks + 1 : 1;
        column.pendingOwnershipDomain = undefined;
      }
    }
  }
}
