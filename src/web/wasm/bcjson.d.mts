export function stringifyLossless(value: unknown): string;
export function parseLossless(text: string): unknown;
export function littleEndianFloat64Bytes(values: Float64Array): Uint8Array;
export function float64FromLittleEndianBytes(bytes: Uint8Array): Float64Array;
