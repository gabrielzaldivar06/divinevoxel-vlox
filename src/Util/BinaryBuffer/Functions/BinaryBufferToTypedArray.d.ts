import { BinaryBufferData } from "../BinaryBuffer.types";
export default function BinaryBufferToTypedArray(buffer: BinaryBufferData): Uint16Array<ArrayBuffer | SharedArrayBuffer> | Uint8Array<ArrayBuffer | SharedArrayBuffer> | undefined;
