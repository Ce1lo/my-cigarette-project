import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { DragControls } from 'three/addons/controls/DragControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { GUI } from 'lil-gui';

import { createCigarette, setGlowIntensity } from './cigarette.js';
import { SmokeSystem } from './smoke.js';
import { BurnSystem } from './burn.js';
import { CONFIG } from './config.js';

// KHỞI TẠO SCENE, CAMERA, RENDERER
const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xc9c7bb, 35, 130);

const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
);
function frameCamera() {
    const distance = window.innerWidth <= 600 ? 19 : 12;
    const direction = new THREE.Vector3(0.71, 0.19, 0.68).normalize();
    camera.position.copy(direction.multiplyScalar(distance)).add(controls.target);
}

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
container.appendChild(renderer.domElement);

// ÁNH SÁNG MÔI TRƯỜNG & ORBIT CONTROLS
const ambientLight = new THREE.HemisphereLight(0xbdd7ed, 0x6a5540, 0.9);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xffd5a1, 3.5);
dirLight.position.set(-10, 4, -8);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(1024, 1024);
Object.assign(dirLight.shadow.camera, { left: -12, right: 12, top: 10, bottom: -10, near: 0.5, far: 40 });
dirLight.shadow.camera.updateProjectionMatrix();
dirLight.shadow.bias = -0.0001;
dirLight.shadow.normalBias = 0.01;
scene.add(dirLight);

const sky = new Sky();
sky.scale.setScalar(150);
sky.material.uniforms.turbidity.value = 3;
sky.material.uniforms.rayleigh.value = 2;
sky.material.uniforms.sunPosition.value.copy(dirLight.position).normalize();
scene.add(sky);

const floorHeight = -1.4;
const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(250, 250),
    new THREE.MeshStandardMaterial({ color: 0x635b50, roughness: 0.95 })
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = floorHeight;
floor.receiveShadow = true;
scene.add(floor);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.target.set(-3.5, 0.7, 0);
controls.minDistance = 3;
controls.maxDistance = 30;
controls.maxPolarAngle = Math.PI / 2;
frameCamera();
controls.update();

// Holder chuyển động; gốc local của cigaretteGroup luôn là tâm than hồng.
const holder = new THREE.Group();
const anchor = new THREE.Vector3();
const cigaretteGroup = createCigarette();
holder.add(cigaretteGroup);
scene.add(holder);
cigaretteGroup.traverse(object => {
    if (object.isMesh) object.castShadow = object.receiveShadow = true;
});
setGlowIntensity(cigaretteGroup, CONFIG.glowIntensity);
const burnSystem = new BurnSystem(scene, cigaretteGroup, floorHeight);
const smokeSystem = new SmokeSystem(scene);

// 2. CẤU HÌNH KÉO THẢ CHUỘT (DRAG CONTROLS) CHO ĐIẾU THUỐC
let isDragging = false;

const dragControls = new DragControls([holder], camera, renderer.domElement);
dragControls.transformGroup = true;

dragControls.addEventListener('dragstart', () => {
    isDragging = true;
    params.enableMovement = false;
    controls.enabled = false;
    document.body.style.cursor = 'grabbing';
});

dragControls.addEventListener('drag', () => {
    holder.position.y = THREE.MathUtils.clamp(holder.position.y, floorHeight + 0.65, floorHeight + 10);
    anchor.copy(holder.position);
    params.height = Math.round((anchor.y - floorHeight) * 10) / 10;
});

dragControls.addEventListener('dragend', () => {
    isDragging = false;
    anchor.copy(holder.position);
    controls.enabled = true;
    document.body.style.cursor = 'auto';
});

dragControls.addEventListener('hoveron', () => {
    if (!isDragging) document.body.style.cursor = 'grab';
});
dragControls.addEventListener('hoveroff', () => {
    if (!isDragging) document.body.style.cursor = 'auto';
});

// THIẾT LẬP BẢNG ĐIỀU KHIỂN UI (LIL-GUI)
const gui = new GUI({ title: 'ĐIỀU KHIỂN MÔ PHỎNG' });

const params = {
    glowIntensity: CONFIG.glowIntensity,
    smokeDensity: CONFIG.smokeDensity,
    windStrength: CONFIG.windStrength,
    enableMovement: true,
    burnPercent: 0,
    burnSpeed: 1,
    height: -floorHeight,
    dropAsh: () => burnSystem.dropAsh(),
    frame: () => {
        controls.target.set(anchor.x - 3.5, anchor.y * 0.5 + 0.7, anchor.z);
        frameCamera();
        controls.update();
    },
    paused: false,
    restart: () => {
        seekBurn(0);
        params.burnPercent = 0;
        smokeSystem.reset();
    }
};

function seekBurn(value) {
    const previous = burnSystem.progress;
    burnSystem.setProgress(value / 100);
    cigaretteGroup.getWorldPosition(emitterPos);
    smokeSystem.updateEmitterPosition(emitterPos);
    smokeSystem.setEmissionEnabled(burnSystem.progress < 1);
    if (burnSystem.progress < previous) smokeSystem.reset();
}

const lifecycle = gui.addFolder('Vòng đời · 180 giây ở 1×');
lifecycle.add(params, 'burnPercent', 0, 100, 0.1).name('Đã cháy (%)').decimals(1).listen().onChange(seekBurn);
lifecycle.add(params, 'burnSpeed', 0, 20, 0.25).name('Tốc độ cháy (×)').onChange(value => burnSystem.setSpeed(value));
lifecycle.add(params, 'paused').name('Tạm dừng');
lifecycle.add(params, 'restart').name('Đốt lại');

const falling = gui.addFolder('Thử rơi tàn · đơn vị scene');
falling.add(params, 'height', 0.65, 10, 0.1).name('Độ cao trên sàn').decimals(1).listen().onChange(value => {
    params.enableMovement = false;
    anchor.copy(holder.position);
    anchor.y = floorHeight + value;
    holder.position.copy(anchor);
});
falling.add(params, 'dropAsh').name('Làm rơi tàn');
falling.add(params, 'frame').name('Xem thuốc và sàn');

gui.add(params, 'glowIntensity', 0, 5, 0.1)
   .name('Độ sáng Than')
   .onChange(val => setGlowIntensity(cigaretteGroup, val));

gui.add(params, 'smokeDensity', 0, 2000, 10)
   .name('Mật độ Khói')
   .onChange(val => smokeSystem.setSmokeDensity(val));

gui.add(params, 'windStrength', -3, 3, 0.05)
   .name('Sức gió')
   .onChange(val => smokeSystem.setWindStrength(val));

gui.add(params, 'enableMovement').name('Thuốc đung đưa').listen();

// ANIMATION LOOP
const clock = new THREE.Clock();
const emitterPos = new THREE.Vector3();
let elapsedTime = 0;

function step(deltaTime) {
    elapsedTime += deltaTime;
    if (params.enableMovement && !isDragging) {
        holder.position.set(
            anchor.x + Math.sin(elapsedTime * 0.8) * 0.5,
            Math.max(floorHeight + 0.65, anchor.y + Math.cos(elapsedTime * 0.6) * 0.3),
            anchor.z + Math.sin(elapsedTime * 0.5) * 0.2
        );
    }
    burnSystem.update(deltaTime);
    cigaretteGroup.update(deltaTime);
    params.burnPercent = Math.round(burnSystem.progress * 1000) / 10;
    cigaretteGroup.getWorldPosition(emitterPos);
    smokeSystem.updateEmitterPosition(emitterPos);
    smokeSystem.setEmissionEnabled(burnSystem.progress < 1);
    smokeSystem.update(deltaTime);
}

// Fixed-step drop preview: ?burn=15&speed=0&height=6&drop=1&t=2&moving=0.
const query = new URLSearchParams(location.search);
for (const [key, apply] of [
    ['burn', value => seekBurn(value)],
    ['speed', value => { burnSystem.setSpeed(value); params.burnSpeed = burnSystem.speed; }],
    ['height', value => {
        params.height = THREE.MathUtils.clamp(value, 0.65, 10);
        holder.position.y = anchor.y = floorHeight + params.height;
        params.frame();
    }]
]) {
    if (query.has(key) && Number.isFinite(Number(query.get(key)))) apply(Number(query.get(key)));
}
if (query.get('moving') === '0') params.enableMovement = false;
if (query.get('drop') === '1') burnSystem.dropAsh();
if (query.has('t') && Number.isFinite(Number(query.get('t')))) {
    const frames = Math.round(THREE.MathUtils.clamp(Number(query.get('t')), 0, 30) * 60);
    for (let i = 0; i < frames; i++) step(1 / 60);
    params.paused = true;
}
params.burnPercent = Math.round(burnSystem.progress * 1000) / 10;
gui.controllersRecursive().forEach(controller => controller.updateDisplay());
if (window.matchMedia('(max-width: 600px)').matches) gui.close();
renderer.setAnimationLoop(() => {
    const deltaTime = Math.min(clock.getDelta(), 0.1);
    if (!params.paused) step(deltaTime);
    controls.update();
    renderer.render(scene, camera);
});

export { scene, renderer, camera, controls, holder, cigaretteGroup, burnSystem, smokeSystem, params };

// XỬ LÝ RESIZE CỬA SỔ
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    frameCamera();
    renderer.setSize(window.innerWidth, window.innerHeight);
});