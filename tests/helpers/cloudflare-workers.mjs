// Shared bindings object. Tests assign env.DB before importing server modules,
// mirroring how the Workers runtime injects the D1 binding.
export const env = {};

export function waitUntil() {}

export function passThroughOnException() {}
