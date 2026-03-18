export declare class ProtoVertexBuffer {
    vertexFloatSize: number;
    sectorVertexSize: number;
    _buffers: Float32Array[];
    sectorSize: number;
    constructor(vertexFloatSize: number, sectorVertexSize: number, startingSectorSize?: number);
    currentArray: Float32Array;
    curentIndex: number;
    _index: number;
    setIndex(index: number): void;
}
export declare class ProtoIndiceBuffer {
    sectorSize: number;
    _buffers: Uint32Array[];
    constructor(sectorSize: number, startingSectorSize?: number);
    currentArray: Uint32Array;
    curentIndex: number;
    _index: number;
    setIndex(index: number): this;
}
