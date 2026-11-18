import * as THREE from 'three';
import { CIGARETTE } from './cigarette.js';

const ASH_LENGTH = 0.9;
const SPARK_COUNT = 96;
const BURN_SECONDS = 180;

function ashNoise(x, y, z) {
  return Math.sin(x * 2.7 + Math.sin(y * 3.1 + z))
    * Math.sin(y * 2.3 + Math.sin(z * 2.9 + x));
}

function buildAshGeometry() {
  const positions = [], colors = [], uvs = [], indices = [];
  const segments = 48;
  function ring(x, radius, end = false) {
    const first = positions.length / 3;
    for (let j = 0; j <= segments; j++) {
      const angle = (j % segments) / segments * Math.PI * 2;
      const y = Math.cos(angle), z = Math.sin(angle);
      const grain = ashNoise(y * 4, x * 12, z * 4);
      const layers = Math.sin(x * 90 + ashNoise(y * 2, x * 3, z * 2) * 1.2);
      const r = radius * (1 + grain * 0.05 - Math.max(0, layers) ** 6 * 0.045);
      const edge = end ? ashNoise(y * 3, 2, z * 3) * 0.012 * radius / CIGARETTE.radius : 0;
      positions.push(x + edge, y * r, z * r);
      const shade = 0.78 + grain * 0.12 - Math.max(0, layers) ** 8 * 0.2;
      colors.push(shade * 1.02, shade, shade * 0.97);
      uvs.push(j / segments, x + 0.5);
    }
    return first;
  }
  function connect(a, b) {
    for (let j = 0; j < segments; j++) {
      indices.push(a + j, a + j + 1, b + j, a + j + 1, b + j + 1, b + j);
    }
  }
  // Layered shell and recessed broken ends, not a flat circular cap.
  let previous = ring(-0.43, 0.045);
  for (let i = 0; i <= 32; i++) {
    const current = ring(-0.5 + i / 32, CIGARETTE.radius, i === 0 || i === 32);
    connect(previous, current);
    previous = current;
  }
  for (const [x, radius] of [[0.47, 0.31], [0.39, 0.19], [0.34, 0.045]]) {
    const current = ring(x, radius, true);
    connect(previous, current);
    previous = current;
  }
  // Close the tiny central cavities with triangle fans.
  for (const [start, x, reverse] of [[0, -0.43, true], [previous, 0.34, false]]) {
    const center = positions.length / 3;
    positions.push(x, 0, 0);
    colors.push(0.22, 0.21, 0.2);
    uvs.push(0.5, 0.5);
    for (let j = 0; j < segments; j++) {
      if (reverse) indices.push(center, start + j + 1, start + j);
      else indices.push(center, start + j, start + j + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

function floorSupport(mesh, geometry = mesh.geometry) {
  mesh.updateMatrix();
  const m = mesh.matrix.elements;
  const vertices = geometry.attributes.position;
  let lowest = Infinity;
  for (let i = 0; i < vertices.count; i++) {
    lowest = Math.min(lowest, m[1] * vertices.getX(i) + m[5] * vertices.getY(i) + m[9] * vertices.getZ(i));
  }
  return -lowest;
}

export class BurnSystem {
  constructor(scene, cigarette, floorHeight = -1.4) {
    if (!Number.isFinite(floorHeight)) throw new TypeError('floorHeight must be finite');
    this.cigarette = cigarette;
    this.floorHeight = floorHeight;
    this.progress = 0;
    this.speed = 1;
    this.heat = 1;
    this.randomState = 0xb17e;
    this.sparkBudget = 0;
    this.sparkIndex = 0;
    this.ashIndex = 0;
    this.rotation = new THREE.Quaternion();
    this.worldScale = new THREE.Vector3();
    this.worldPosition = new THREE.Vector3();
    this.worldVelocity = new THREE.Vector3();

    this.ashGeometry = buildAshGeometry();
    // The edge fluctuation is limited by axial ring spacing, avoiding folded faces.
    this.ashGeometry.computeBoundingSphere();
    const width = 128, height = 256;
    const texels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const angle = x / width * Math.PI * 2;
        const u = Math.cos(angle), v = Math.sin(angle);
        const cluster = ashNoise(u * 8, y * 0.12, v * 8);
        const seam = Math.sin(y * 0.54 + ashNoise(u * 3, y * 0.016, v * 3) * 2);
        const pore = cluster < -0.55;
        const shade = pore ? 105 : 226 + cluster * 25 - Math.max(0, seam) ** 12 * 40;
        texels.set([shade, shade, shade * 0.97, 255], (y * width + x) * 4);
      }
    }
    this.ashTexture = new THREE.DataTexture(texels, width, height);
    this.ashTexture.colorSpace = THREE.SRGBColorSpace;
    this.ashTexture.wrapS = this.ashTexture.wrapT = THREE.RepeatWrapping;
    this.ashTexture.magFilter = THREE.LinearFilter;
    this.ashTexture.minFilter = THREE.LinearMipmapLinearFilter;
    this.ashTexture.generateMipmaps = true;
    this.ashTexture.needsUpdate = true;
    this.ashMaterial = new THREE.MeshStandardMaterial({
      roughness: 1, vertexColors: true, map: this.ashTexture, bumpMap: this.ashTexture, bumpScale: 0.012
    });
    this.ash = new THREE.Mesh(this.ashGeometry, this.ashMaterial);
    this.ash.name = 'AttachedAsh';
    this.ash.castShadow = true;
    cigarette.add(this.ash);
    // ponytail: one floor and pooled visual fracture, not rigid-body contact between fragments.
    this.fragments = Array.from({ length: 8 }, () => {
      const mesh = new THREE.Mesh(this.ashGeometry, this.ashMaterial);
      mesh.name = 'FallingAsh';
      mesh.visible = false;
      mesh.castShadow = mesh.receiveShadow = true;
      scene.add(mesh);
      return { mesh, velocity: new THREE.Vector3(), spin: new THREE.Vector3(), settled: false, impacted: false };
    });
    this.chipGeometry = new THREE.IcosahedronGeometry(1, 1);
    const vertices = this.chipGeometry.attributes.position;
    for (let i = 0; i < vertices.count; i++) {
      const x = vertices.getX(i), y = vertices.getY(i), z = vertices.getZ(i);
      const radius = 0.85 + ashNoise(x * 3, y * 3, z * 3) * 0.15;
      vertices.setXYZ(i, x * radius, y * radius, z * radius);
    }
    this.chipGeometry.computeVertexNormals();
    this.chipGeometry.computeBoundingBox();
    this.chipMaterial = new THREE.MeshStandardMaterial({
      color: 0xbfbcb4, roughness: 1, map: this.ashTexture
    });
    this.chipMesh = new THREE.InstancedMesh(this.chipGeometry, this.chipMaterial, 160);
    this.chipMesh.name = 'AshChips';
    this.chipMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.chipMesh.castShadow = this.chipMesh.receiveShadow = true;
    this.chipMesh.frustumCulled = false;
    scene.add(this.chipMesh);
    this.chips = Array.from({ length: 160 }, () => ({
      position: new THREE.Vector3(), velocity: new THREE.Vector3(),
      scale: new THREE.Vector3(), rotation: new THREE.Euler(), spin: new THREE.Vector3(),
      active: false, settled: false, bounces: 0
    }));
    this.chipTransform = new THREE.Object3D();
    this.chipIndex = 0;
    this.impactCount = 0;

    this.positions = new Float32Array(SPARK_COUNT * 3);
    this.velocities = new Float32Array(SPARK_COUNT * 3);
    this.ages = new Float32Array(SPARK_COUNT);
    this.lifetimes = new Float32Array(SPARK_COUNT);
    this.sizes = new Float32Array(SPARK_COUNT);
    this.phases = new Float32Array(SPARK_COUNT).fill(1);
    this.sparkGeometry = new THREE.BufferGeometry();
    for (const [name, array, size] of [
      ['position', this.positions, 3], ['sparkSize', this.sizes, 1], ['phase', this.phases, 1]
    ]) {
      this.sparkGeometry.setAttribute(name, new THREE.BufferAttribute(array, size).setUsage(THREE.DynamicDrawUsage));
    }
    this.sparkMaterial = new THREE.ShaderMaterial({
      uniforms: { viewportHeight: { value: 1 } },
      vertexShader: `
        uniform float viewportHeight;
        attribute float sparkSize;
        attribute float phase;
        varying float age;
        void main() {
          vec4 view = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * view;
          gl_PointSize = max(1.0, sparkSize * viewportHeight * projectionMatrix[1][1] / (2.0 * max(0.01, -view.z)));
          age = phase;
        }
      `,
      fragmentShader: `
        varying float age;
        void main() {
          if (age >= 1.0) discard;
          vec2 uv = gl_PointCoord - 0.5;
          float r = dot(uv, uv);
          float alpha = (exp(-r * 40.0) + 0.12 * exp(-r * 12.0)) * pow(1.0 - age, 1.2);
          if (alpha < 0.003) discard;
          vec3 color = mix(vec3(1.0, 0.035, 0.002), vec3(1.0, 0.65, 0.18), pow(1.0 - age, 2.0));
          gl_FragColor = vec4(color, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.sparks = new THREE.Points(this.sparkGeometry, this.sparkMaterial);
    this.sparks.name = 'BurnSparks';
    this.sparks.frustumCulled = false;
    const viewport = new THREE.Vector2();
    this.sparks.onBeforeRender = renderer => {
      this.sparkMaterial.uniforms.viewportHeight.value = renderer.getDrawingBufferSize(viewport).y;
    };
    scene.add(this.sparks);
    this.setProgress(0);
  }

  random() {
    this.randomState = (Math.imul(this.randomState, 1664525) + 1013904223) >>> 0;
    return this.randomState / 4294967296;
  }

  setSpeed(value) {
    if (Number.isFinite(value)) this.speed = THREE.MathUtils.clamp(value, 0, 20);
  }

  setProgress(value) {
    if (!Number.isFinite(value)) return;
    this.progress = THREE.MathUtils.clamp(value, 0, 1);
    this.heat = this.progress < 1 ? 1 : 0;
    this.sparkBudget = this.sparkIndex = this.ashIndex = this.chipIndex = this.impactCount = 0;
    this.randomState = 0xb17e;
    this.lifetimes.fill(0);
    this.phases.fill(1);
    this.sizes.fill(0);
    for (const fragment of this.fragments) fragment.mesh.visible = false;
    for (const chip of this.chips) chip.active = false;
    this.updateChips(0);
    const burned = this.progress * (CIGARETTE.rodEnd - 0.5);
    this.shedLength = this.progress < 1 ? Math.floor(burned / ASH_LENGTH) * ASH_LENGTH : burned;
    this.syncModel();
    this.cigarette.setBurnHeat(this.heat);
    this.cigarette.update(0);
    this.markSparksDirty();
  }

  syncModel() {
    this.cigarette.setBurnProgress(this.progress);
    // The outer holder owns drag/sway; keep the filter fixed while the local ember stays at zero.
    this.cigarette.position.x = -this.cigarette.userData.burnedLength;
    this.attachedLength = Math.max(0, this.cigarette.userData.burnedLength - this.shedLength);
    this.ash.visible = this.attachedLength > 0.015;
    this.ash.scale.x = Math.max(0.001, this.attachedLength);
    this.ash.position.x = this.attachedLength / 2 + 0.015;
    this.cigarette.updateWorldMatrix(true, false);
  }

  spawnSpark() {
    const i = this.sparkIndex++ % SPARK_COUNT;
    const offset = i * 3;
    const angle = this.random() * Math.PI * 2;
    const position = this.worldPosition;
    position.set(0.02, Math.cos(angle) * CIGARETTE.radius, Math.sin(angle) * CIGARETTE.radius);
    position.applyMatrix4(this.cigarette.matrixWorld).toArray(this.positions, offset);
    this.cigarette.getWorldQuaternion(this.rotation);
    const velocity = this.worldVelocity;
    velocity.set(this.random() * 0.6, Math.cos(angle) * 0.6, Math.sin(angle) * 0.6);
    velocity.applyQuaternion(this.rotation);
    velocity.y += 0.3 + this.random() * 0.6;
    velocity.toArray(this.velocities, offset);
    this.ages[i] = 0;
    this.lifetimes[i] = 0.5 + this.random();
    this.sizes[i] = 0.08 + this.random() * 0.08;
    this.phases[i] = 0;
  }

  dropAsh() {
    this.syncModel();
    if (this.attachedLength <= 0.015) return false;
    const fragment = this.fragments[this.ashIndex++ % this.fragments.length];
    this.ash.updateWorldMatrix(true, false);
    this.ash.matrixWorld.decompose(fragment.mesh.position, fragment.mesh.quaternion, fragment.mesh.scale);
    fragment.mesh.visible = true;
    fragment.velocity.set((this.random() - 0.5) * 0.12, -0.08, (this.random() - 0.5) * 0.12);
    fragment.spin.set(this.random() - 0.5, this.random() - 0.5, this.random() - 0.5).multiplyScalar(1.2);
    fragment.settled = fragment.impacted = false;
    for (let i = 0; i < 3; i++) this.spawnSpark();
    this.shedLength += this.attachedLength;
    this.attachedLength = 0;
    this.ash.visible = false;
    return true;
  }

  breakAsh(fragment) {
    const impact = Math.abs(fragment.velocity.y);
    const count = Math.min(26, 10 + Math.floor(impact * 2));
    fragment.mesh.updateMatrixWorld(true);
    this.impactCount++;
    fragment.impacted = true;
    fragment.mesh.visible = false;
    for (let i = 0; i < count; i++) {
      const chip = this.chips[this.chipIndex++ % this.chips.length];
      const angle = this.random() * Math.PI * 2;
      const radius = Math.sqrt(this.random()) * CIGARETTE.radius * 0.85;
      chip.position.set((this.random() - 0.5) * 0.9, Math.cos(angle) * radius, Math.sin(angle) * radius);
      chip.position.applyMatrix4(fragment.mesh.matrixWorld);
      const size = i < 3 ? 0.13 + this.random() * 0.08 : 0.025 + this.random() * 0.075;
      chip.scale.set(size * (0.8 + this.random()), size * (0.25 + this.random() * 0.2), size);
      chip.rotation.set(this.random() * Math.PI, this.random() * Math.PI, this.random() * Math.PI);
      const spread = Math.min(1.6, impact * 0.25) * (0.35 + this.random() * 0.65);
      chip.velocity.set(Math.cos(angle) * spread + fragment.velocity.x * 0.2,
        0.15 + this.random() * Math.min(0.8, impact * 0.18),
        Math.sin(angle) * spread + fragment.velocity.z * 0.2);
      chip.spin.set(this.random() - 0.5, this.random() - 0.5, this.random() - 0.5).multiplyScalar(7);
      chip.active = true;
      chip.settled = false;
      chip.bounces = 0;
      this.chipTransform.position.copy(chip.position);
      this.chipTransform.scale.copy(chip.scale);
      this.chipTransform.rotation.copy(chip.rotation);
      chip.position.y = Math.max(chip.position.y, this.floorHeight + floorSupport(this.chipTransform, this.chipGeometry));
    }
  }

  updateChips(dt) {
    let dirty = dt === 0;
    for (let i = 0; i < this.chips.length; i++) {
      const chip = this.chips[i];
      if (chip.active && chip.settled && dt > 0) continue;
      const mesh = this.chipTransform;
      mesh.position.copy(chip.position);
      mesh.rotation.copy(chip.rotation);
      mesh.scale.copy(chip.scale);
      if (!chip.active) {
        if (dt > 0) continue;
        mesh.scale.setScalar(0);
      } else if (dt > 0) {
        chip.velocity.y -= 4 * dt;
        chip.position.addScaledVector(chip.velocity, dt);
        chip.rotation.x += chip.spin.x * dt;
        chip.rotation.y += chip.spin.y * dt;
        chip.rotation.z += chip.spin.z * dt;
        mesh.rotation.copy(chip.rotation);
        const support = floorSupport(mesh, this.chipGeometry);
        if (chip.position.y <= this.floorHeight + support) {
          chip.position.y = this.floorHeight + support;
          if (chip.bounces++ > 0 || Math.abs(chip.velocity.y) < 0.35) {
            chip.settled = true;
            chip.rotation.x = chip.rotation.z = 0;
            mesh.rotation.copy(chip.rotation);
            chip.position.y = this.floorHeight + floorSupport(mesh, this.chipGeometry);
          } else {
            chip.velocity.y = Math.abs(chip.velocity.y) * 0.18;
            chip.velocity.x *= 0.55;
            chip.velocity.z *= 0.55;
            // Brittle flakes land on their broad face rather than balancing on an edge.
            chip.rotation.x = chip.rotation.z = 0;
            chip.spin.set(0, chip.spin.y * 0.2, 0);
          }
        }
        mesh.position.copy(chip.position);
      }
      mesh.updateMatrix();
      this.chipMesh.setMatrixAt(i, mesh.matrix);
      dirty = true;
    }
    if (dirty) this.chipMesh.instanceMatrix.needsUpdate = true;
  }

  update(deltaTime) {
    if (!Number.isFinite(deltaTime) || deltaTime <= 0) return;
    const dt = Math.min(deltaTime, 0.1);
    if (this.progress < 1) {
      this.progress = Math.min(1, this.progress + dt * this.speed / BURN_SECONDS);
    } else {
      this.heat = Math.max(0, this.heat - dt * 1.5);
    }
    this.syncModel();
    if (this.attachedLength >= ASH_LENGTH || (this.progress === 1 && this.attachedLength > 0)) this.dropAsh();
    this.cigarette.setBurnHeat(this.heat);
    this.sparkBudget += dt * 3 * this.heat;
    while (this.sparkBudget >= 1) {
      this.spawnSpark();
      this.sparkBudget--;
    }
    for (const fragment of this.fragments) {
      if (!fragment.mesh.visible || fragment.settled) continue;
      fragment.velocity.y -= 4 * dt;
      fragment.mesh.position.addScaledVector(fragment.velocity, dt);
      fragment.mesh.rotateX(fragment.spin.x * dt);
      fragment.mesh.rotateY(fragment.spin.y * dt);
      fragment.mesh.rotateZ(fragment.spin.z * dt);
      const support = floorSupport(fragment.mesh);
      if (fragment.mesh.position.y <= this.floorHeight + support) {
        fragment.mesh.position.y = this.floorHeight + support;
        this.breakAsh(fragment);
      }
    }
    this.updateChips(dt);
    for (let i = 0; i < SPARK_COUNT; i++) {
      if (this.lifetimes[i] === 0) continue;
      this.ages[i] += dt;
      this.phases[i] = Math.min(1, this.ages[i] / this.lifetimes[i]);
      if (this.phases[i] >= 1) {
        this.lifetimes[i] = this.sizes[i] = 0;
        continue;
      }
      const offset = i * 3;
      this.velocities[offset + 1] -= 4 * dt;
      for (let axis = 0; axis < 3; axis++) this.positions[offset + axis] += this.velocities[offset + axis] * dt;
      if (this.positions[offset + 1] < this.floorHeight + 0.02) {
        this.positions[offset + 1] = this.floorHeight + 0.02;
        this.velocities[offset + 1] = Math.abs(this.velocities[offset + 1]) * 0.15;
        this.ages[i] = Math.max(this.ages[i], this.lifetimes[i] * 0.8);
      }
    }
    this.markSparksDirty();
  }

  markSparksDirty() {
    for (const attribute of Object.values(this.sparkGeometry.attributes)) attribute.needsUpdate = true;
  }

  dispose() {
    this.ash.removeFromParent();
    for (const fragment of this.fragments) fragment.mesh.removeFromParent();
    this.sparks.removeFromParent();
    this.chipMesh.removeFromParent();
    this.chipMesh.dispose();
    this.chipGeometry.dispose();
    this.chipMaterial.dispose();
    this.ashGeometry.dispose();
    this.ashMaterial.dispose();
    this.ashTexture.dispose();
    this.sparkGeometry.dispose();
    this.sparkMaterial.dispose();
  }
}
