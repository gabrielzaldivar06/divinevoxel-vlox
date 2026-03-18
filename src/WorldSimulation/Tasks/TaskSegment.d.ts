import { LocationData } from "../../Math";
import { DimensionSegment } from "../Dimensions/DimensionSegment";
export declare class TaskSegment {
    dimension: DimensionSegment;
    generationTask: boolean;
    log: boolean;
    _hash: Set<unknown>;
    nodes: LocationData[];
    waitingFor: number;
    _taskCount: number;
    _task: Map<number, LocationData>;
    constructor(dimension: DimensionSegment, generationTask: boolean, log?: boolean);
    clearAll(): void;
    _getLocationData(dimension: number, x: number, y: number, z: number): LocationData;
    completeTask(id: number): boolean;
    addTask(x: number, y: number, z: number): number;
    has(x: number, y: number, z: number): boolean;
    add(x: number, y: number, z: number): false | undefined;
    sort(x: number, y: number, z: number): LocationData[];
    run(): Generator<LocationData>;
}
