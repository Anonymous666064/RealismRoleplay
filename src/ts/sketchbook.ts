import '../css/main.css';
import * as THREE from 'three';
import * as CANNON from 'cannon';

(window as any).THREE = THREE;
(window as any).CANNON = CANNON;

// Realism fix: three.js r113's InterleavedBufferAttribute has no .clone() method.
// The male.glb / female.glb / female-athlete.glb models use interleaved buffers
// (byteStride=52), so BufferGeometry.clone() crashes with "o.clone is not a function"
// when the NPC system clones each mesh's geometry. This polyfill runs in the main
// entry point (before any other module) so it's always available.
if ((THREE as any).InterleavedBufferAttribute && !(THREE as any).InterleavedBufferAttribute.prototype.clone)
{
        (THREE as any).InterleavedBufferAttribute.prototype.clone = function()
        {
                return new (THREE as any).InterleavedBufferAttribute(this.data, this.itemSize, this.offset, this.normalized);
        };
}

export { World } from './world/World';