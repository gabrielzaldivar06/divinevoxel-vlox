const transitionMaterialSuffix = "__transition";

export function getTransitionMaterialId(materialId: string) {
  return `${materialId}${transitionMaterialSuffix}`;
}

export function isTransitionMaterialId(materialId: string) {
  return materialId.endsWith(transitionMaterialSuffix);
}

export function getBaseMaterialId(materialId: string) {
  return isTransitionMaterialId(materialId)
    ? materialId.slice(0, -transitionMaterialSuffix.length)
    : materialId;
}