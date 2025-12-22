import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

// --- Theme Colors ---
const COLORS = {
    background: 0xf8f9fa,
    // ... (rest of COLORS object is unchanged)
    gridMajor: 0x94a3b8,
    gridMinor: 0xcbd5e1,
    text: '#64748b',
    axisX: 0xef4444,
    axisY: 0x22c55e,
    feed: 0x383838,
    rapid: 0xffa500,
    machineBox: 0xffd949,
    statsBox: 0x94a3b8,
    statsText: '#ffffff',
    statsBg: '#383838',
    tool: 0xffd949,
    toolShadow: 0xd7b232
};

export class GCodeViewer {
    constructor(containerId, loadingOverlayId) {
        this.container = document.getElementById(containerId);
        this.loadingOverlay = document.getElementById(loadingOverlayId);

        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;

        // Unit State
        this.nativeUnits = 'mm';
        this.displayUnits = 'mm';

        // Groups
        this.gcodeGroup = new THREE.Group();
        this.gridGroup = new THREE.Group();
        this.machineGroup = new THREE.Group();
        this.wcsGroup = new THREE.Group();
        this.labelsGroup = new THREE.Group();
        this.statsGroup = new THREE.Group();
        this.toolGroup = new THREE.Group();

        // Defaults
        this.gridBounds = { xmin: -100, ymin: -100, xmax: 100, ymax: 100, zmin: 0 };
        this.machineLimits = { x: 200, y: 200, z: 100 };
        this.wco = { x: 0, y: 0, z: 0 };

        // Tweening State
        this.targetToolPos = new THREE.Vector3(0, 0, 0);
        this.currentToolPos = new THREE.Vector3(0, 0, 0);

        // --- NEW: Spindle Animation State ---
        this.spindleSpeed = 0; // Current RPM from controller
        this.clock = new THREE.Clock(); // For frame-rate independent animation

        this.init();
    }

    init() {
        // ... (init method is unchanged)
        if (!this.container) return;
        const w = this.container.clientWidth;
        const h = this.container.clientHeight || 400;

        // Scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(COLORS.background);

        // --- GRAPHICS UPGRADE: Lighting ---
        const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
        hemiLight.position.set(0, 0, 200);
        this.scene.add(hemiLight);

        const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
        dirLight.position.set(50, 100, 150);
        dirLight.castShadow = true;

        dirLight.shadow.mapSize.width = 2048;
        dirLight.shadow.mapSize.height = 2048;
        dirLight.shadow.camera.near = 0.5;
        dirLight.shadow.camera.far = 5000;
        const d = 1000;
        dirLight.shadow.camera.left = -d;
        dirLight.shadow.camera.right = d;
        dirLight.shadow.camera.top = d;
        dirLight.shadow.camera.bottom = -d;
        dirLight.shadow.bias = -0.0001;

        this.scene.add(dirLight);

        // --- GRAPHICS UPGRADE: Renderer ---
        this.renderer = new THREE.WebGLRenderer({
            antialias: true,
            alpha: true,
            powerPreference: "high-performance"
        });
        this.renderer.setSize(w, h);
        this.renderer.setPixelRatio(window.devicePixelRatio);

        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.0;

        this.container.appendChild(this.renderer.domElement);

        // Camera (Z-Up)
        this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 10000);
        this.camera.up.set(0, 0, 1);
        this.camera.position.set(0, -200, 200);

        // Controls
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;

        // Add Groups
        this.scene.add(this.gridGroup);
        this.scene.add(this.labelsGroup);
        this.scene.add(this.gcodeGroup);
        this.scene.add(this.statsGroup);
        this.scene.add(this.machineGroup);
        this.scene.add(this.wcsGroup);
        this.scene.add(this.toolGroup);

        // Initial Renders
        this.renderCoolGrid();
        this.renderWCSOrigin();
        this.renderMachineBox();
        this.renderTool();

        this.animate();
    }

    setUnits(units) {
        // ... (setUnits method is unchanged)
        if (this.displayUnits === units) return;
        this.displayUnits = units;
        this.renderCoolGrid();
        const box = new THREE.Box3().setFromObject(this.gcodeGroup);
        if(!box.isEmpty()) this.renderJobStats(box);
        window.dispatchEvent(new CustomEvent('viewer-units-changed', { detail: { units: this.displayUnits } }));
    }

    // --- UPDATED: animate() method ---
    animate() {
        requestAnimationFrame(() => this.animate());
        const delta = this.clock.getDelta(); // Get time since last frame in seconds

        // Smoothly interpolate tool position
        this.currentToolPos.lerp(this.targetToolPos, 0.1);
        this.toolGroup.position.copy(this.currentToolPos);

        // --- Spindle Rotation Logic (Corrected and Stabilized) ---
        const elapsedTime = this.clock.getElapsedTime(); // Time in seconds
        console.log(this.spindleSpeed);

        if (this.spindleSpeed > 0) {
             // 1. Convert Revolutions Per Minute (RPM) to Radians Per Second
             // (RPM / 60) gives revolutions per second.
             // (RPS * 2 * PI) gives radians per second.
             // Simplified: RPM * (PI / 30)
             const radiansPerSecond = this.spindleSpeed * (Math.PI / 30);

             // 2. Calculate the TARGET rotation based on the total elapsed time.
             // This is an absolute calculation, not incremental, which prevents error accumulation.
             const targetRotationZ = elapsedTime * radiansPerSecond;

             // 3. Set the tool group's rotation directly to this calculated value.
             this.toolGroup.rotation.z = -targetRotationZ;
        }
         // --- NEW: If speed is zero, we don't do anything, so the rotation stops and holds its last position ---
        // Update controls and render the scene
        if (this.controls) this.controls.update();
        if (this.renderer && this.scene && this.camera) {
            this.renderer.render(this.scene, this.camera);
        }
    }

    // --- NEW: Method to update spindle speed from external source ---
    setSpindleSpeed(rpm) {
        this.spindleSpeed = rpm || 0;
    }

    resize() {
        // ... (resize method is unchanged)
        if (!this.container || this.container.clientWidth === 0) return;
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
    }

    // ... (The rest of the file is unchanged)
    // --- Text Helpers ---
    createTextSprite(text) {
        const resMult = 4;
        const fontsize = 24 * resMult;
        const border = 10 * resMult;
        const canvas = document.createElement('canvas');
        const width = (text.length * (fontsize * 0.6)) + (border * 2);
        const height = fontsize + (border * 2);
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = COLORS.text;
        ctx.font = `bold ${fontsize}px "JetBrains Mono", monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, width/2, height/2);
        const tex = new THREE.CanvasTexture(canvas);
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
        const sprite = new THREE.Sprite(mat);
        const scale = 0.25 / resMult;
        sprite.scale.set(width * scale, height * scale, 1);
        return sprite;
    }

    createTextPlane(text) {
        const fontsize = 60;
        const border = 10;
        const textWidthEstimate = text.length * (fontsize * 0.6) + (border * 4);
        const canvasWidth = Math.max(textWidthEstimate, 64);
        const canvasHeight = fontsize + (border * 2);
        const canvas = document.createElement('canvas');
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = COLORS.statsBg;
        ctx.roundRect(0, 0, canvasWidth, canvasHeight, 16);
        ctx.fill();
        ctx.fillStyle = COLORS.statsText;
        ctx.font = `bold ${fontsize}px "JetBrains Mono", monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, canvasWidth / 2, canvasHeight / 2);
        const tex = new THREE.CanvasTexture(canvas);
        tex.minFilter = THREE.LinearFilter;
        tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        const material = new THREE.MeshBasicMaterial({
            map: tex, transparent: true, opacity: 1, side: THREE.DoubleSide, depthWrite: false
        });
        const scaleFactor = 0.15;
        const geometry = new THREE.PlaneGeometry(canvasWidth * scaleFactor, canvasHeight * scaleFactor);
        return new THREE.Mesh(geometry, material);
    }

    renderCoolGrid() {
        this.gridGroup.clear();
        this.labelsGroup.clear();
        const { xmin, xmax, ymin, ymax, zmin } = this.gridBounds;
        let floorZ = (zmin !== undefined) ? Math.min(0, zmin) : 0;
        floorZ -= 1.0;
        const shadowPlaneGeo = new THREE.PlaneGeometry(Math.max(2000, (xmax-xmin)*2), Math.max(2000, (ymax-ymin)*2));
        const shadowPlaneMat = new THREE.ShadowMaterial({ opacity: 0.1, color: 0x000000 });
        const shadowPlane = new THREE.Mesh(shadowPlaneGeo, shadowPlaneMat);
        shadowPlane.receiveShadow = true;
        shadowPlane.position.z = floorZ;
        shadowPlane.position.x = (xmin + xmax) / 2;
        shadowPlane.position.y = (ymin + ymax) / 2;
        this.gridGroup.add(shadowPlane);
        const isDisplayInch = this.displayUnits === 'inch';
        const isNativeInch = this.nativeUnits === 'inch';
        let scaleFactor = 1.0;
        if (isNativeInch && !isDisplayInch) scaleFactor = 1 / 25.4;
        else if (!isNativeInch && isDisplayInch) scaleFactor = 25.4;
        const widthDisplay = (xmax - xmin) / scaleFactor;
        const heightDisplay = (ymax - ymin) / scaleFactor;
        const maxDimDisplay = Math.max(widthDisplay, heightDisplay);
        let rawStep = maxDimDisplay / 10;
        const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
        const normalized = rawStep / magnitude;
        let cleanStepDisplay;
        if (normalized < 2) cleanStepDisplay = 1 * magnitude;
        else if (normalized < 5) cleanStepDisplay = 2 * magnitude;
        else cleanStepDisplay = 5 * magnitude;
        const minStep = isDisplayInch ? 1.0 : 10.0;
        if (cleanStepDisplay < minStep) cleanStepDisplay = minStep;
        const majorScene = cleanStepDisplay * scaleFactor;
        const stepScene = majorScene / 5;
        const epsilon = 0.0001;
        const isMajor = (valScene) => {
            const valDisplay = valScene / scaleFactor;
            const rem = Math.abs(valDisplay / cleanStepDisplay);
            const distToInt = Math.abs(rem - Math.round(rem));
            return distToInt < epsilon;
        };
        const vertices = [];
        const colors = [];
        const cMajor = new THREE.Color(COLORS.gridMajor);
        const cMinor = new THREE.Color(COLORS.gridMinor);
        const xStart = Math.floor(xmin / majorScene) * majorScene;
        const xEnd = Math.ceil(xmax / majorScene) * majorScene;
        const yStart = Math.floor(ymin / majorScene) * majorScene;
        const yEnd = Math.ceil(ymax / majorScene) * majorScene;
        for (let x = xStart; x <= xEnd + epsilon; x += stepScene) {
             vertices.push(x, yStart, 0, x, yEnd, 0);
             if (isMajor(x)) {
                 colors.push(cMajor.r, cMajor.g, cMajor.b, cMajor.r, cMajor.g, cMajor.b);
                 const valDisplay = x / scaleFactor;
                 const labelText = parseFloat(valDisplay.toPrecision(10)).toString();
                 const s = this.createTextSprite(labelText);
                 const yOffset = isDisplayInch ? (0.5 * scaleFactor) : (10 * scaleFactor);
                 s.position.set(x, yStart - yOffset, 0);
                 this.labelsGroup.add(s);
             } else {
                 colors.push(cMinor.r, cMinor.g, cMinor.b, cMinor.r, cMinor.g, cMinor.b);
             }
        }
        for (let y = yStart; y <= yEnd + epsilon; y += stepScene) {
             vertices.push(xStart, y, 0, xEnd, y, 0);
             if (isMajor(y)) {
                 colors.push(cMajor.r, cMajor.g, cMajor.b, cMajor.r, cMajor.g, cMajor.b);
                 const valDisplay = y / scaleFactor;
                 const labelText = parseFloat(valDisplay.toPrecision(10)).toString();
                 const s = this.createTextSprite(labelText);
                 const xOffset = isDisplayInch ? (0.8 * scaleFactor) : (15 * scaleFactor);
                 s.position.set(xStart - xOffset, y, 0);
                 this.labelsGroup.add(s);
             } else {
                 colors.push(cMinor.r, cMinor.g, cMinor.b, cMinor.r, cMinor.g, cMinor.b);
             }
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent:true, opacity:0.5 });
        this.gridGroup.add(new THREE.LineSegments(geometry, material));
        if (xStart <= 0 && xEnd >= 0) {
            const yAxisGeo = new THREE.BufferGeometry().setFromPoints([ new THREE.Vector3(0, yStart, 0.05), new THREE.Vector3(0, yEnd, 0.05) ]);
            this.gridGroup.add(new THREE.LineSegments(yAxisGeo, new THREE.LineBasicMaterial({ color: COLORS.axisY, linewidth: 2 })));
        }
        if (yStart <= 0 && yEnd >= 0) {
             const xAxisGeo = new THREE.BufferGeometry().setFromPoints([ new THREE.Vector3(xStart, 0, 0.05), new THREE.Vector3(xEnd, 0, 0.05) ]);
            this.gridGroup.add(new THREE.LineSegments(xAxisGeo, new THREE.LineBasicMaterial({ color: COLORS.axisX, linewidth: 2 })));
        }
    }

    setMachineLimits(x, y, z) {
        if (x && y && z) {
            this.machineLimits = { x, y, z };
            this.renderMachineBox();
        }
    }

    updateWCS(wcoArray) {
        if (!wcoArray || wcoArray.length < 3) return;
        const newWco = { x: wcoArray[0], y: wcoArray[1], z: wcoArray[2] };
        if (Math.abs(newWco.x - this.wco.x) > 0.01 ||
            Math.abs(newWco.y - this.wco.y) > 0.01 ||
            Math.abs(newWco.z - this.wco.z) > 0.01) {
            this.wco = newWco;
            this.renderMachineBox();
        }
    }

    renderWCSOrigin() {
        this.wcsGroup.clear();
        this.wcsGroup.add(new THREE.AxesHelper(20));
    }

    renderMachineBox() {
        this.machineGroup.clear();
        const mzX = this.wco.x; const mzY = this.wco.y; const mzZ = this.wco.z;
        const { x, y, z } = this.machineLimits;
        const vertices = [];
        const xMin = -x; const xMax = 0;
        const yMin = -y; const yMax = 0;
        const zMin = -z; const zMax = 0;
        const addLine = (a, b) => vertices.push(...a, ...b);
        const p = [
            [xMin, yMin, zMin], [xMax, yMin, zMin], [xMax, yMax, zMin], [xMin, yMax, zMin],
            [xMin, yMin, zMax], [xMax, yMin, zMax], [xMax, yMax, zMax], [xMin, yMax, zMax]
        ];
        addLine(p[0], p[1]); addLine(p[1], p[2]); addLine(p[2], p[3]); addLine(p[3], p[0]);
        addLine(p[4], p[5]); addLine(p[5], p[6]); addLine(p[6], p[7]); addLine(p[7], p[4]);
        addLine(p[0], p[4]); addLine(p[1], p[5]); addLine(p[2], p[6]); addLine(p[3], p[7]);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        const dashedMat = new THREE.LineDashedMaterial({ color: COLORS.machineBox, dashSize: 5, gapSize: 3, opacity: 0.9, transparent: true, depthWrite: false });
        const lines = new THREE.LineSegments(geometry, dashedMat);
        lines.computeLineDistances();
        this.machineGroup.position.set(mzX, mzY, mzZ);
        this.machineGroup.add(lines);
        const homeSphere = new THREE.Mesh(new THREE.SphereGeometry(2, 16, 16), new THREE.MeshBasicMaterial({ color: COLORS.machineBox, transparent: true, opacity: 0.8 }));
        this.machineGroup.add(homeSphere);
    }

    renderTool() {
        this.toolGroup.clear();
        const transparency = 0.9;
        const endmillMat = new THREE.MeshNormalMaterial({
            transparent: true,
            opacity: transparency,
            side: THREE.DoubleSide
        });
        const colletNutMat = new THREE.MeshStandardMaterial({
            color: 0x000000,
            roughness: 0.4,
            metalness: 0.6,
            transparent: true,
            opacity: transparency,
        });
        const colletShaftMat = new THREE.MeshStandardMaterial({
            color: 0xbdc3c7,
            roughness: 0.4,
            metalness: 0.6,
            transparent: true,
            opacity: transparency,
        });
        const loader = new STLLoader();
        loader.load('./endmill.stl', (geometry) => {
            const mesh = new THREE.Mesh(geometry, endmillMat);
            mesh.castShadow = true;
            this.toolGroup.add(mesh);
        }, undefined, (error) => console.warn('Could not load endmill.stl', error));
        loader.load('./collet-nut.stl', (geometry) => {
            const mesh = new THREE.Mesh(geometry, colletNutMat);
            mesh.castShadow = true;
            mesh.position.z = 30;
            this.toolGroup.add(mesh);
        }, undefined, (error) => console.warn('Could not load collet-nut.stl', error));
        loader.load('./collet-shaft.stl', (geometry) => {
            const mesh = new THREE.Mesh(geometry, colletShaftMat);
            mesh.castShadow = true;
            mesh.position.z = 30;
            this.toolGroup.add(mesh);
        }, undefined, (error) => console.warn('Could not load collet-shaft.stl', error));
        this.updateToolPosition(this.currentToolPos.x, this.currentToolPos.y, this.currentToolPos.z);
    }

    updateToolPosition(x, y, z) {
        if(x !== undefined && y !== undefined && z !== undefined) {
            this.targetToolPos.set(x, y, z);
        }
    }

    processGCodeString(gcode) {
        if (this.loadingOverlay) this.loadingOverlay.classList.remove('hidden');
        this.sendToWorker(gcode);
    }

    loadLocalFile(file) {
        if (!file) return;
        if (this.loadingOverlay) this.loadingOverlay.classList.remove('hidden');
        const reader = new FileReader();
        reader.onload = (evt) => { this.sendToWorker(evt.target.result); };
        reader.readAsText(file);
    }

    sendToWorker(data) {
        const worker = new Worker('gcview.worker.js', { type: 'module' });
        worker.onmessage = (msg) => {
            const payload = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
            if (payload.linePoints) {
                this.nativeUnits = payload.inch ? 'inch' : 'mm';
                this.renderLines(payload.linePoints);
                this.renderCoolGrid();
                if (this.loadingOverlay) this.loadingOverlay.classList.add('hidden');
                worker.terminate();
            }
        };
        worker.postMessage({ data: data });
    }

    renderLines(points) {
        this.gcodeGroup.clear();
        const rapidGeo = [];
        const feedGeo = [];
        for (let i = 1; i < points.length; i++) {
            const p1 = points[i - 1];
            const p2 = points[i];
            if (p2.g === 0) {
                rapidGeo.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
            } else {
                feedGeo.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
            }
        }
        if (feedGeo.length) {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(feedGeo, 3));
            this.gcodeGroup.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: COLORS.feed, linewidth: 2 })));
        }
        if (rapidGeo.length) {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(rapidGeo, 3));
            this.gcodeGroup.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: COLORS.rapid, linewidth: 1, transparent: true, opacity: 0.5 })));
        }
        const box = new THREE.Box3().setFromObject(this.gcodeGroup);
        if (!box.isEmpty()) {
            this.gridBounds = {
                xmin: box.min.x - 20, ymin: box.min.y - 20,
                xmax: box.max.x + 20, ymax: box.max.y + 20,
                zmin: box.min.z
            };
            this.renderCoolGrid();
            this.renderJobStats(box);
            this.resetCamera();
        }
    }

    renderJobStats(box) {
        this.statsGroup.clear();
        if(box.isEmpty()) return;
        const size = new THREE.Vector3();
        box.getSize(size);
        const center = new THREE.Vector3();
        box.getCenter(center);
        const boxGeo = new THREE.BoxGeometry(size.x, size.y, size.z);
        const edges = new THREE.EdgesGeometry(boxGeo);
        const line = new THREE.LineSegments(edges, new THREE.LineDashedMaterial({ color: COLORS.statsBox, dashSize: 3, gapSize: 2, opacity: 0.7, transparent: true }));
        line.computeLineDistances();
        line.position.copy(center);
        this.statsGroup.add(line);
        const margin = 5;
        const isDisplayInch = this.displayUnits === 'inch';
        const isNativeInch = this.nativeUnits === 'inch';
        let unitsPerDisplayUnit = 1;
        if (!isNativeInch && isDisplayInch) unitsPerDisplayUnit = 25.4;
        else if (isNativeInch && !isDisplayInch) unitsPerDisplayUnit = 1 / 25.4;
        const dimX = size.x / unitsPerDisplayUnit;
        const dimY = size.y / unitsPerDisplayUnit;
        const dimZ = size.z / unitsPerDisplayUnit;
        const unitLabel = isDisplayInch ? 'in' : 'mm';
        const xMesh = this.createTextPlane(`X: ${dimX.toFixed(2)}${unitLabel}`);
        xMesh.position.set(center.x, box.min.y - margin, box.min.z);
        this.statsGroup.add(xMesh);
        const yMesh = this.createTextPlane(`Y: ${dimY.toFixed(2)}${unitLabel}`);
        yMesh.position.set(box.min.x - margin, center.y, box.min.z);
        yMesh.rotation.z = Math.PI / 2;
        this.statsGroup.add(yMesh);
        const zMesh = this.createTextPlane(`Z: ${dimZ.toFixed(2)}${unitLabel}`);
        zMesh.position.set(box.min.x, box.max.y + margin, center.z);
        zMesh.rotation.x = Math.PI / 2;
        this.statsGroup.add(zMesh);
    }

    resetCamera() {
        const box = new THREE.Box3().setFromObject(this.gcodeGroup);
        if (box.isEmpty()) {
            this.camera.position.set(0, -200, 200);
            this.controls.target.set(0, 0, 0);
        } else {
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y);
            this.controls.target.copy(center);
            this.camera.position.set(center.x, center.y - maxDim * 1.5, center.z + maxDim);
        }
        this.controls.update();
    }

    setCameraView(view) {
        const box = new THREE.Box3().setFromObject(this.gcodeGroup);
        let center = new THREE.Vector3(0,0,0);
        let dist = 200;
        if (!box.isEmpty()) {
            center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z || 1);
            dist = maxDim * 2;
        }
        this.controls.target.copy(center);
        switch (view) {
            case 'Top':
                this.camera.position.set(center.x, center.y, center.z + dist);
                this.camera.up.set(0, 1, 0);
                break;
            case 'Front':
                this.camera.position.set(center.x, center.y - dist, center.z);
                this.camera.up.set(0, 0, 1);
                break;
            case 'Left':
                this.camera.position.set(center.x - dist, center.y, center.z);
                this.camera.up.set(0, 0, 1);
                break;
            case 'Iso':
                this.camera.position.set(center.x + dist, center.y - dist, center.z + dist);
                this.camera.up.set(0, 0, 1);
                break;
        }
        this.controls.update();
    }

    toggleCamera() {
        const currentPos = this.camera.position.clone();
        const currentTarget = this.controls.target.clone();
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        if (this.camera instanceof THREE.PerspectiveCamera) {
            const aspect = w / h;
            const frustumSize = currentPos.distanceTo(currentTarget);
            this.camera = new THREE.OrthographicCamera(frustumSize * aspect / -2, frustumSize * aspect / 2, frustumSize / 2, frustumSize / -2, 0.1, 10000);
            this.camera.up.set(0,0,1);
            this.camera.position.copy(currentPos);
            this.camera.zoom = 1;
            this.controls.object = this.camera;
            this.controls.target.copy(currentTarget);
            return 'Ortho';
        } else {
            this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 10000);
            this.camera.up.set(0,0,1);
            this.camera.position.copy(currentPos);
            this.controls.object = this.camera;
            this.controls.target.copy(currentTarget);
            return 'Persp';
        }
    }
}
