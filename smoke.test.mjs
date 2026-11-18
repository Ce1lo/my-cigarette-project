// Run: node --experimental-vm-modules smoke.test.mjs (requires CDN access).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceTextModule } from 'node:vm';

const modules = new Map();
async function loadModule(url) {
    if (modules.has(url)) return modules.get(url);
    const source = url.startsWith('https:')
        ? await fetch(url).then(response => {
            if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
            return response.text();
        })
        : await readFile(new URL(url), 'utf8');
    const module = new SourceTextModule(source, { identifier: url });
    modules.set(url, module);
    await module.link((specifier, parent) => loadModule(
        specifier === 'three' ? 'https://unpkg.com/three@0.160.0/build/three.module.js'
            : specifier.startsWith('three/addons/')
                ? specifier.replace('three/addons/', 'https://unpkg.com/three@0.160.0/examples/jsm/')
                : new URL(specifier, parent.identifier).href
    ));
    return module;
}

const module = await loadModule(new URL('./smoke.js', import.meta.url).href);
await module.evaluate();
const { SmokeSystem } = module.namespace;
const THREE = modules.get('https://unpkg.com/three@0.160.0/build/three.module.js').namespace;
const scene = new THREE.Scene();
const smoke = new SmokeSystem(scene);
assert.equal(scene.children[0], smoke.points);
assert.deepEqual(smoke.emitterPosition.toArray(), [0, 0, 0]);
assert.equal(smoke.geometry.drawRange.count, 500);
assert.equal(smoke.material.depthWrite, false);
assert.equal(smoke.material.blending, THREE.NormalBlending);
assert.equal(smoke.geometry.attributes.particleSeed.array, smoke.seeds);
assert.ok(smoke.seeds.every(value => value >= 0 && value < 1));
const twin = new SmokeSystem(new THREE.Scene());
assert.deepEqual(smoke.seeds, twin.seeds);
for (let frame = 0; frame < 120; frame++) {
    smoke.update(1 / 60);
    twin.update(1 / 60);
}
assert.deepEqual(smoke.positions, twin.positions);
assert.deepEqual(smoke.velocities, twin.velocities);
assert.equal(smoke.material.uniforms.time.value, smoke.time);
twin.dispose();
const positions = smoke.positions;
const velocities = smoke.velocities;

smoke.setSmokeDensity(1);
smoke.resetParticle(0);
assert.deepEqual(Array.from(positions.slice(0, 3)), [0, 0, 0]);
smoke.update(0.1);
assert.ok(positions[1] > 0);
assert.ok(smoke.sizes[0] > 0.12);
assert.ok(smoke.opacities[0] > 0);
const previousPosition = Array.from(positions.slice(0, 3));
const emitter = new THREE.Vector3(3, 2, -1);
smoke.updateEmitterPosition(emitter);
emitter.set(9, 9, 9);
assert.deepEqual(smoke.emitterPosition.toArray(), [3, 2, -1]);
assert.deepEqual(Array.from(positions.slice(0, 3)), previousPosition);

smoke.ages[0] = smoke.lifetimes[0];
smoke.update(0.01);
assert.deepEqual(Array.from(positions.slice(0, 3)), [3, 2, -1]);
assert.equal(smoke.opacities[0], 0);
positions[1] = 7;
smoke.update(0.01);
assert.deepEqual(Array.from(positions.slice(0, 3)), [3, 2, -1]);
smoke.resetParticle(0, 0.05);
smoke.updateEmitterPosition({ x: -2, y: 4, z: 1 });
smoke.update(0.1);
assert.deepEqual(Array.from(positions.slice(0, 3)), [-2, 4, 1]);

smoke.resetParticle(0);
smoke.ages[0] = smoke.lifetimes[0] * 0.5;
smoke.update(0.01);
const middleOpacity = smoke.opacities[0];
const middleSize = smoke.sizes[0];
smoke.ages[0] = smoke.lifetimes[0] * 0.9;
smoke.update(0.01);
assert.ok(smoke.opacities[0] < middleOpacity);
assert.ok(smoke.sizes[0] > middleSize);
smoke.resetParticle(0);
smoke.setWindStrength(3);
const oldX = positions[0];
for (let i = 0; i < 10; i++) smoke.update(0.1);
assert.ok(positions[0] > oldX);
smoke.setWindStrength(-3);
const windyX = positions[0];
for (let i = 0; i < 10; i++) smoke.update(0.1);
assert.ok(positions[0] < windyX);

for (const invalid of [NaN, Infinity, -Infinity, '10', null]) {
    const time = smoke.time;
    smoke.update(invalid);
    assert.equal(smoke.time, time);
    smoke.setSmokeDensity(invalid);
    assert.equal(smoke.density, 1);
    smoke.setWindStrength(invalid);
    assert.equal(smoke.windStrength, -3);
}
smoke.updateEmitterPosition({ x: NaN, y: 0, z: 0 });
assert.deepEqual(smoke.emitterPosition.toArray(), [-2, 4, 1]);
smoke.setSmokeDensity(-1);
assert.equal(smoke.geometry.drawRange.count, 0);
smoke.setSmokeDensity(1e9);
assert.equal(smoke.geometry.drawRange.count, 2000);
smoke.setWindStrength(1e9);
assert.equal(smoke.windStrength, 3);
for (let i = 0; i < 1200; i++) smoke.update(1 / 60);
assert.equal(smoke.positions, positions);
assert.equal(smoke.velocities, velocities);
assert.ok(positions.every(Number.isFinite));
assert.ok(velocities.every(Number.isFinite));
assert.ok(smoke.opacities.every(value => value >= 0 && value <= 0.09));
smoke.points.onBeforeRender({ getDrawingBufferSize: target => target.set(1600, 1200) });
assert.equal(smoke.material.uniforms.viewportHeight.value, 1200);
let disposed = 0;
smoke.geometry.addEventListener('dispose', () => disposed++);
smoke.material.addEventListener('dispose', () => disposed++);
smoke.dispose();
assert.equal(scene.children.length, 0);
assert.equal(disposed, 2);
const tail = new SmokeSystem(new THREE.Scene());
for (let i = 0; i < 480; i++) tail.update(1 / 60);
assert.ok(tail.opacities.some(value => value > 0));
tail.setEmissionEnabled(false);
for (let i = 0; i < 600; i++) tail.update(1 / 60);
assert.ok(tail.opacities.every(value => value === 0));
tail.setEmissionEnabled(true);
for (let i = 0; i < 120; i++) tail.update(1 / 60);
assert.ok(tail.opacities.some(value => value > 0));
tail.reset();
assert.ok(tail.opacities.every(value => value === 0));
tail.dispose();
console.log('SmokeSystem: all checks passed.');

const burnModule = await loadModule(new URL('./burn.js', import.meta.url).href);
await burnModule.evaluate();
const { BurnSystem } = burnModule.namespace;
const burnScene = new THREE.Scene();
const holder = new THREE.Group();
const cigarette = new THREE.Group();
const paper = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
// Minimal model contract; real canvas textures/model are checked in Edge.
cigarette.setBurnProgress = value => { cigarette.userData.burnedLength = value * 5.2; };
cigarette.setBurnHeat = () => {};
cigarette.update = () => {};
cigarette.add(paper);
holder.add(cigarette);
burnScene.add(holder);
const burn = new BurnSystem(burnScene, cigarette);
const buffers = [burn.positions, burn.velocities, burn.ashGeometry, burn.sparkGeometry];
const ashVertices = burn.ashGeometry.attributes.position;
const ashNormals = burn.ashGeometry.attributes.normal;
assert.ok(ashVertices.array.every(Number.isFinite));
assert.ok(ashNormals.array.every(Number.isFinite));
const edges = new Map();
const vertexKey = i => [ashVertices.getX(i), ashVertices.getY(i), ashVertices.getZ(i)]
    .map(value => Math.round(value * 1e6)).join(',');
const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
let volume = 0;
const ashIndices = burn.ashGeometry.index.array;
for (let i = 0; i < ashIndices.length; i += 3) {
    const ids = Array.from(ashIndices.slice(i, i + 3));
    a.fromBufferAttribute(ashVertices, ids[0]);
    b.fromBufferAttribute(ashVertices, ids[1]);
    c.fromBufferAttribute(ashVertices, ids[2]);
    volume += a.dot(b.clone().cross(c)) / 6;
    assert.ok(b.clone().sub(a).cross(c.clone().sub(a)).lengthSq() > 1e-14);
    for (let j = 0; j < 3; j++) {
        const from = vertexKey(ids[j]), to = vertexKey(ids[(j + 1) % 3]);
        const key = [from, to].sort().join('/');
        const edge = edges.get(key) || { count: 0, winding: 0 };
        edge.count++;
        edge.winding += from < to ? 1 : -1;
        edges.set(key, edge);
    }
}
assert.ok(volume > 0);
assert.ok([...edges.values()].every(edge => edge.count === 2 && edge.winding === 0));
for (const invalid of [NaN, Infinity, '1', null]) {
    burn.setProgress(invalid);
    burn.setSpeed(invalid);
    burn.update(invalid);
}
assert.equal(burn.progress, 0);
assert.equal(burn.speed, 1);
burn.update(0.1);
assert.ok(Math.abs(burn.progress - 0.1 / 180) < 1e-10);
burn.setSpeed(0);
const stopped = burn.progress;
burn.update(0.1);
assert.equal(burn.progress, stopped);
burn.setSpeed(100);
assert.equal(burn.speed, 20);
burn.setProgress(0.17);
holder.position.y = 4;
burn.update(0.1);
assert.equal(burn.fragments.filter(fragment => fragment.mesh.visible).length, 1);
assert.equal(burn.impactCount, 0);
assert.ok(burn.chips.every(chip => !chip.active));
assert.ok(burn.lifetimes.some(value => value > 0));
const fragment = burn.fragments[0];
const fragmentX = fragment.mesh.position.x;
holder.position.x = 10;
burn.update(0.01);
assert.ok(Math.abs(fragment.mesh.position.x - fragmentX) < 0.1);
assert.ok(Math.abs(cigarette.getWorldPosition(new THREE.Vector3()).x - (10 - cigarette.userData.burnedLength)) < 1e-8);
burn.setSpeed(0);
for (let i = 0; i < 240; i++) burn.update(1 / 60);
assert.equal(burn.impactCount, 1);
assert.equal(fragment.impacted, true);
assert.ok(burn.fragments.every(item => !item.mesh.visible));
assert.ok(burn.chips.some(chip => chip.active));
assert.ok(burn.chips.filter(chip => chip.active).every(chip => chip.settled));
assert.ok(burn.chips.filter(chip => chip.active).every(chip => chip.position.y >= burn.floorHeight));
const landedVertices = burn.chipGeometry.attributes.position;
const landedTransform = new THREE.Object3D();
const landedPoint = new THREE.Vector3();
for (const chip of burn.chips.filter(chip => chip.active)) {
    landedTransform.position.copy(chip.position);
    landedTransform.rotation.copy(chip.rotation);
    landedTransform.scale.copy(chip.scale);
    landedTransform.updateMatrix();
    let minimum = Infinity;
    for (let i = 0; i < landedVertices.count; i++) {
        landedPoint.fromBufferAttribute(landedVertices, i).applyMatrix4(landedTransform.matrix);
        minimum = Math.min(minimum, landedPoint.y);
    }
    assert.ok(Math.abs(minimum - burn.floorHeight) < 1e-6);
}
const chipIndex = burn.chipIndex;
for (let i = 0; i < 60; i++) burn.update(1 / 60);
assert.equal(burn.chipIndex, chipIndex);
const highDropCount = burn.chips.filter(chip => chip.active).length;
burn.setProgress(0.15);
holder.position.y = burn.floorHeight + 0.65;
assert.equal(burn.dropAsh(), true);
for (let i = 0; i < 180; i++) burn.update(1 / 60);
assert.ok(burn.chips.filter(chip => chip.active).length < highDropCount);
assert.ok(burn.chipMesh.instanceMatrix.array.every(Number.isFinite));
burn.setProgress(0.15);
assert.equal(burn.dropAsh(), true);
assert.equal(burn.dropAsh(), false);
assert.equal(burn.fragments.filter(item => item.mesh.visible).length, 1);
assert.ok(burn.chips.every(chip => !chip.active));
burn.setProgress(1);
assert.equal(burn.heat, 0);
assert.ok(burn.fragments.every(item => !item.mesh.visible));
burn.setProgress(0);
burn.setSpeed(20);
for (let i = 0; i < 600; i++) burn.update(1 / 60);
assert.equal(burn.progress, 1);
assert.equal(burn.heat, 0);
assert.ok(burn.positions.every(Number.isFinite));
assert.ok(burn.velocities.every(Number.isFinite));
assert.deepEqual([burn.positions, burn.velocities, burn.ashGeometry, burn.sparkGeometry], buffers);
burn.setProgress(-2);
assert.equal(burn.progress, 0);
assert.ok(burn.sizes.every(value => value === 0));
let burnDisposed = 0;
for (const resource of [burn.ashGeometry, burn.ashMaterial, burn.ashTexture,
    burn.chipGeometry, burn.chipMaterial, burn.chipMesh, burn.sparkGeometry, burn.sparkMaterial]) {
    resource.addEventListener('dispose', () => burnDisposed++);
}
burn.dispose();
assert.equal(burnDisposed, 8);
assert.equal(burnScene.children.length, 1);
assert.equal(cigarette.children.length, 1);
paper.geometry.dispose();
paper.material.dispose();
console.log('BurnSystem: all checks passed.');
