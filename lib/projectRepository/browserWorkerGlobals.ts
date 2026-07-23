import { Buffer } from "buffer";

// LightningFS 4.6.2 loads isomorphic-textencoder's browser shim, which checks
// `global` but not WorkerGlobalScope's `self`. Expose the standard worker global
// before LightningFS is evaluated; native TextEncoder/TextDecoder remain intact.
Reflect.set(globalThis, "global", globalThis);

// isomorphic-git 1.38.7's ESM build expects the Node-compatible Buffer global.
Reflect.set(globalThis, "Buffer", Buffer);
