import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { ViewCube } from './viewcube.js';

// --- Theme Colors ---
const COLORS = {
    gridMajor: 0x94a3b8,
    gridMinor: 0xcbd5e1,
    text: '#64748b',
    axisX: 0xef4444,
    axisY: 0x22c55e,
    feed: 0x383838,
    rapid: 0xffa500,
    machineBox: 0x555555, // Dark Grey
    statsBox: 0x94a3b8,
    statsText: '#ffffff',
    statsBg: '#383838',
    tool: 0xffd949
};

export class GCodeViewer {
    constructor(containerId, loadingOverlayId, store) { // Added store
        this.container = document.getElementById(containerId);
        this.loadingOverlay = document.getElementById(loadingOverlayId);
        this.store = store; // Save store reference

        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;

        // Unit State
        this.nativeUnits = 'mm';
        this.displayUnits = 'mm';

        // Grid State - Load from Store
        this.gridMode = this.store ? (this.store.get('viewer.gridMode') || 'job') : 'job';

        // Groups
        // Root groups attached to Scene
        this.machineGroup = new THREE.Group(); // Fixed at World (0,0,0) = Machine Home
        this.workOffsetsGroup = new THREE.Group(); // Moves based on WCO

        // Child groups attached to workOffsetsGroup
        this.gcodeGroup = new THREE.Group();
        this.gridGroup = new THREE.Group();
        this.wcsGroup = new THREE.Group();
        this.labelsGroup = new THREE.Group();
        this.statsGroup = new THREE.Group();
        this.toolGroup = new THREE.Group();

        // Defaults
        this.gridBounds = null; // Force calculation on first render
        this.machineLimits = { x: 200, y: 200, z: 100 };
        this.wco = { x: 0, y: 0, z: 0 };

        // Tweening State
        this.targetToolPos = new THREE.Vector3(0, 0, 0);
        this.currentToolPos = new THREE.Vector3(0, 0, 0);

        // Spindle Animation State
        this.spindleSpeed = 0;
        this.clock = new THREE.Clock();

        this.init();
    }

    init() {
        if (!this.container) return;
        const w = this.container.clientWidth;
        const h = this.container.clientHeight || 400;

        // Scene
        this.scene = new THREE.Scene();

        // Lighting
        const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
        hemiLight.position.set(0, 0, 200);
        this.scene.add(hemiLight);

        const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
        dirLight.position.set(50, 100, 150);
        this.scene.add(dirLight);

        // Renderer
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

        // ViewCube
        this.viewCube = new ViewCube(this.camera, this.controls, this.container);

        // Scene Hierarchy Construction
        // 1. Machine Group (Static)
        this.scene.add(this.machineGroup);

        // 2. Work Offsets Group (Dynamic Position)
        this.scene.add(this.workOffsetsGroup);

        // 3. Children of Work Offsets
        this.workOffsetsGroup.add(this.gridGroup);
        this.workOffsetsGroup.add(this.labelsGroup);
        this.workOffsetsGroup.add(this.gcodeGroup);
        this.workOffsetsGroup.add(this.statsGroup);
        this.workOffsetsGroup.add(this.wcsGroup);
        this.workOffsetsGroup.add(this.toolGroup);

        // Initial Renders
        this.renderCoolGrid();
        this.renderWCSOrigin();
        this.renderMachineBox();
        this.renderTool();

        this.animate();
    }

    setUnits(units) {
        if (this.displayUnits === units) return;
        this.displayUnits = units;
        this.renderCoolGrid();
        // Use Local Box for stats to ensure they align with the gcode inside the group
        const box = this.getLocalGCodeBox();
        if (!box.isEmpty()) this.renderJobStats(box);
        window.dispatchEvent(new CustomEvent('viewer-units-changed', { detail: { units: this.displayUnits } }));
    }

    animate() {
        requestAnimationFrame(() => this.animate());
        const delta = this.clock.getDelta();

        // Tool position is in WPos (local to workOffsetsGroup)
        this.currentToolPos.lerp(this.targetToolPos, 0.1);
        this.toolGroup.position.copy(this.currentToolPos);

        const elapsedTime = this.clock.getElapsedTime();

        if (this.spindleSpeed > 0) {
            const radiansPerSecond = this.spindleSpeed * (Math.PI / 30);
            const targetRotationZ = elapsedTime * radiansPerSecond;
            this.toolGroup.rotation.z = -targetRotationZ;
        }

        if (this.controls) this.controls.update();
        if (this.renderer && this.scene && this.camera) {
            this.renderer.render(this.scene, this.camera);
        }
    }

    setSpindleSpeed(rpm) {
        this.spindleSpeed = rpm || 0;
    }

    resize() {
        if (!this.container || this.container.clientWidth === 0) return;
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
    }

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
        ctx.fillText(text, width / 2, height / 2);
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
            map: tex,
            transparent: true,
            opacity: 1,
            side: THREE.DoubleSide,
            depthWrite: false,
            depthTest: false
        });
        const scaleFactor = 0.15;
        const geometry = new THREE.PlaneGeometry(canvasWidth * scaleFactor, canvasHeight * scaleFactor);
        return new THREE.Mesh(geometry, material);
    }

    // New Helper to get box in Local Space (relative to workOffsetsGroup)
    getLocalGCodeBox() {
        const box = new THREE.Box3();
        this.gcodeGroup.children.forEach(child => {
            if (child.geometry) {
                if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
                box.union(child.geometry.boundingBox);
            }
        });
        return box;
    }

    updateGridBounds(forceJobBox = null) {
        if (this.gridMode === 'machine' && this.machineLimits) {
            // Machine Limits are in Machine Coordinates (MPos) relative to Home (0,0,0)
            // But the Grid is drawn inside workOffsetsGroup, which is shifted by WCO.

            const mx = this.machineLimits.x;
            const my = this.machineLimits.y;
            const ox = -this.wco.x; // Origin X (Machine Home in Local space)
            const oy = -this.wco.y; // Origin Y (Machine Home in Local space)

            this.gridBounds = {
                xmin: ox - mx, // Left/South edge
                ymin: oy - my, // Bottom/South edge
                xmax: ox,      // Right/North edge (Home)
                ymax: oy,      // Top/North edge (Home)
                zmin: 0
            };
        } else {
            // Job Mode
            let box = forceJobBox;
            if (!box) {
                // Use Local Box for Grid Job Mode (Grid is inside WorkGroup)
                box = this.getLocalGCodeBox();
            }

            if (!box.isEmpty()) {
                this.gridBounds = {
                    xmin: box.min.x - 20,
                    ymin: box.min.y - 20,
                    xmax: box.max.x + 20,
                    ymax: box.max.y + 20,
                    zmin: box.min.z
                };
            } else {
                this.gridBounds = { xmin: -100, ymin: -100, xmax: 100, ymax: 100, zmin: 0 };
            }
        }
    }

    toggleGridMode() {
        this.gridMode = (this.gridMode === 'job') ? 'machine' : 'job';
        if (this.store) this.store.set('viewer.gridMode', this.gridMode); // Save to Store
        this.updateGridBounds();
        this.renderCoolGrid();
        return this.gridMode === 'machine' ? 'Grid: Machine' : 'Grid: Job';
    }

    renderCoolGrid() {
        this.gridGroup.clear();
        this.labelsGroup.clear();

        if (!this.gridBounds) this.updateGridBounds();

        const { xmin, xmax, ymin, ymax, zmin } = this.gridBounds;

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
            if (x < xmin - epsilon || x > xmax + epsilon) continue;
            vertices.push(x, ymin, 0, x, ymax, 0);

            if (isMajor(x)) {
                colors.push(cMajor.r, cMajor.g, cMajor.b, cMajor.r, cMajor.g, cMajor.b);
                const valDisplay = x / scaleFactor;
                const labelText = parseFloat(valDisplay.toPrecision(10)).toString();
                const s = this.createTextSprite(labelText);
                const yOffset = isDisplayInch ? (0.5 * scaleFactor) : (10 * scaleFactor);
                s.position.set(x, ymin - yOffset, 0);
                this.labelsGroup.add(s);
            } else {
                colors.push(cMinor.r, cMinor.g, cMinor.b, cMinor.r, cMinor.g, cMinor.b);
            }
        }

        for (let y = yStart; y <= yEnd + epsilon; y += stepScene) {
            if (y < ymin - epsilon || y > ymax + epsilon) continue;
            vertices.push(xmin, y, 0, xmax, y, 0);

            if (isMajor(y)) {
                colors.push(cMajor.r, cMajor.g, cMajor.b, cMajor.r, cMajor.g, cMajor.b);
                const valDisplay = y / scaleFactor;
                const labelText = parseFloat(valDisplay.toPrecision(10)).toString();
                const s = this.createTextSprite(labelText);
                const xOffset = isDisplayInch ? (0.8 * scaleFactor) : (15 * scaleFactor);
                s.position.set(xmin - xOffset, y, 0);
                this.labelsGroup.add(s);
            } else {
                colors.push(cMinor.r, cMinor.g, cMinor.b, cMinor.r, cMinor.g, cMinor.b);
            }
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5 });
        this.gridGroup.add(new THREE.LineSegments(geometry, material));

        if (xStart <= 0 && xEnd >= 0) {
            if (0 >= xmin && 0 <= xmax) {
                const yAxisGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, ymin, 0.05), new THREE.Vector3(0, ymax, 0.05)]);
                this.gridGroup.add(new THREE.LineSegments(yAxisGeo, new THREE.LineBasicMaterial({ color: COLORS.axisY, linewidth: 2 })));
            }
        }
        if (yStart <= 0 && yEnd >= 0) {
            if (0 >= ymin && 0 <= ymax) {
                const xAxisGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(xmin, 0, 0.05), new THREE.Vector3(xmax, 0, 0.05)]);
                this.gridGroup.add(new THREE.LineSegments(xAxisGeo, new THREE.LineBasicMaterial({ color: COLORS.axisX, linewidth: 2 })));
            }
        }
    }

    setMachineLimits(x, y, z) {
        if (x && y && z) {
            this.machineLimits = { x, y, z };
            this.renderMachineBox();
            if (this.gridMode === 'machine') {
                this.updateGridBounds();
                this.renderCoolGrid();
            }
        }
    }

    updateWCS(wcoArray) {
        if (!wcoArray || wcoArray.length < 3) return;
        const newWco = { x: wcoArray[0], y: wcoArray[1], z: wcoArray[2] };

        // Check delta
        if (Math.abs(newWco.x - this.wco.x) > 0.01 ||
            Math.abs(newWco.y - this.wco.y) > 0.01 ||
            Math.abs(newWco.z - this.wco.z) > 0.01) {

            // Calculate shift vector
            const diffX = newWco.x - this.wco.x;
            const diffY = newWco.y - this.wco.y;
            const diffZ = newWco.z - this.wco.z;

            this.wco = newWco;

            // Move the Work Group to the new WCO world position
            this.workOffsetsGroup.position.set(this.wco.x, this.wco.y, this.wco.z);

            // Compensate the tool position so it stays static in World Space
            // NewLocalPos = OldLocalPos - ShiftVector
            // This prevents the visual "jump" while the new coordinate logic syncs
            this.currentToolPos.x -= diffX;
            this.currentToolPos.y -= diffY;
            this.currentToolPos.z -= diffZ;

            // If in machine grid mode, limits relative to WCS change, so redraw grid
            if (this.gridMode === 'machine') {
                this.updateGridBounds();
                this.renderCoolGrid();
            }
        }
    }

    renderWCSOrigin() {
        this.wcsGroup.clear();
        this.wcsGroup.add(new THREE.AxesHelper(20));
    }

    renderMachineBox() {
        this.machineGroup.clear();

        // Machine Box is now static at World (0,0,0) -> Machine Home
        const { x, y, z } = this.machineLimits;

        // Standard CNC: Home is (0,0,0). Travel is negative.
        // x,y,z passed here are magnitudes (e.g. 300, 300, 80).
        const xMin = -x; const xMax = 0;
        const yMin = -y; const yMax = 0;
        const zMin = -z; const zMax = 0;

        const vertices = [];
        const addLine = (a, b) => vertices.push(...a, ...b);
        const p = [
            [xMin, yMin, zMin], [xMax, yMin, zMin], [xMax, yMax, zMin], [xMin, yMax, zMin],
            [xMin, yMin, zMax], [xMax, yMin, zMax], [xMax, yMax, zMax], [xMin, yMax, zMax]
        ];

        // Top and Bottom Loops
        addLine(p[0], p[1]); addLine(p[1], p[2]); addLine(p[2], p[3]); addLine(p[3], p[0]);
        addLine(p[4], p[5]); addLine(p[5], p[6]); addLine(p[6], p[7]); addLine(p[7], p[4]);
        // Pillars
        addLine(p[0], p[4]); addLine(p[1], p[5]); addLine(p[2], p[6]); addLine(p[3], p[7]);

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        const dashedMat = new THREE.LineDashedMaterial({
            color: COLORS.machineBox,
            dashSize: 10,
            gapSize: 5,
            opacity: 0.8,
            transparent: true,
            depthWrite: false
        });
        const lines = new THREE.LineSegments(geometry, dashedMat);
        lines.computeLineDistances();

        this.machineGroup.add(lines);

        // Machine Home Sphere (Fixed at World 0,0,0)
        const homeSphere = new THREE.Mesh(new THREE.SphereGeometry(3, 16, 16), new THREE.MeshBasicMaterial({ color: COLORS.machineBox, transparent: true, opacity: 0.8 }));
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
            this.toolGroup.add(mesh);
        }, undefined, (error) => console.warn('Could not load endmill.stl', error));
        loader.load('./collet-nut.stl', (geometry) => {
            const mesh = new THREE.Mesh(geometry, colletNutMat);
            mesh.position.z = 30;
            this.toolGroup.add(mesh);
        }, undefined, (error) => console.warn('Could not load collet-nut.stl', error));
        loader.load('./collet-shaft.stl', (geometry) => {
            const mesh = new THREE.Mesh(geometry, colletShaftMat);
            mesh.position.z = 30;
            this.toolGroup.add(mesh);
        }, undefined, (error) => console.warn('Could not load collet-shaft.stl', error));
        this.updateToolPosition(this.currentToolPos.x, this.currentToolPos.y, this.currentToolPos.z);
    }

    updateToolPosition(x, y, z) {
        if (x !== undefined && y !== undefined && z !== undefined) {
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
            this.gcodeGroup.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
                color: COLORS.feed,
                linewidth: 2,
                depthTest: false
            })));
        }
        if (rapidGeo.length) {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(rapidGeo, 3));
            this.gcodeGroup.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
                color: COLORS.rapid,
                linewidth: 1,
                transparent: true,
                opacity: 0.5,
                depthTest: false
            })));
        }

        // Use Local Box for Grid and Stats
        const box = this.getLocalGCodeBox();
        if (!box.isEmpty()) {
            this.updateGridBounds(box);
            this.renderCoolGrid();
            this.renderJobStats(box);
            this.resetCamera();
        }
    }

    renderJobStats(box) {
        this.statsGroup.clear();
        if (box.isEmpty()) return;
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
        // 1. Try GCode Box (Job Focus) - using WORLD coordinates for Camera
        const box = new THREE.Box3().setFromObject(this.gcodeGroup);

        if (!box.isEmpty()) {
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y);
            this.controls.target.copy(center);
            this.camera.position.set(center.x, center.y - maxDim * 1.5, center.z + maxDim);
            this.controls.update();
        } else {
            // 2. Try Machine Limits (Machine Focus)
            const machineBox = new THREE.Box3().setFromObject(this.machineGroup);

            if (!machineBox.isEmpty()) {
                const center = machineBox.getCenter(new THREE.Vector3());
                const size = machineBox.getSize(new THREE.Vector3());
                const maxDim = Math.max(size.x, size.y, size.z || 100);

                this.controls.target.copy(center);
                // Position camera to see the full machine bed
                this.camera.position.set(center.x, center.y - maxDim * 1.5, center.z + maxDim);
                this.controls.update();
            } else {
                // 3. Fallback (Default)
                this.camera.position.set(0, -200, 200);
                this.controls.target.set(0, 0, 0);
                this.controls.update();
            }
        }
    }

    setCameraView(view) {
        const box = new THREE.Box3().setFromObject(this.gcodeGroup);
        let center = new THREE.Vector3(0, 0, 0);
        let dist = 200;
        if (!box.isEmpty()) {
            center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z || 1);
            dist = maxDim * 2;
        }

        // Use Work Zero (workOffsetsGroup position) if no gcode
        if (box.isEmpty() && this.workOffsetsGroup) {
            center.copy(this.workOffsetsGroup.position);
        }

        this.controls.target.copy(center);

        // Calculate target position and up vector
        let targetPosition = new THREE.Vector3();
        let targetUp = new THREE.Vector3();

        switch (view) {
            case 'Top':
                targetPosition.set(center.x, center.y, center.z + dist);
                targetUp.set(0, 1, 0);
                break;
            case 'Front':
                targetPosition.set(center.x, center.y - dist, center.z);
                targetUp.set(0, 0, 1);
                break;
            case 'Left':
                targetPosition.set(center.x - dist, center.y, center.z);
                targetUp.set(0, 0, 1);
                break;
            case 'Iso':
                targetPosition.set(center.x + dist, center.y - dist, center.z + dist);
                targetUp.set(0, 0, 1);
                break;
        }

        // Animate camera to target position
        this.animateCamera(targetPosition, targetUp);
    }

    animateCamera(targetPosition, targetUp) {
        const startPosition = this.camera.position.clone();
        const startUp = this.camera.up.clone();
        const duration = 600; // milliseconds
        const startTime = Date.now();

        const animate = () => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);

            // Easing function (easeInOutCubic)
            const eased = progress < 0.5
                ? 4 * progress * progress * progress
                : 1 - Math.pow(-2 * progress + 2, 3) / 2;

            // Interpolate position
            this.camera.position.lerpVectors(startPosition, targetPosition, eased);

            // Interpolate up vector
            this.camera.up.lerpVectors(startUp, targetUp, eased);

            this.controls.update();

            if (progress < 1) {
                requestAnimationFrame(animate);
            }
        };

        animate();
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
            this.camera.up.set(0, 0, 1);
            this.camera.position.copy(currentPos);
            this.camera.zoom = 1;
            this.controls.object = this.camera;
            this.controls.target.copy(currentTarget);

            // Update viewcube with new camera reference
            if (this.viewCube) {
                this.viewCube.updateCamera(this.camera, this.controls);
            }

            return 'Orthographic';
        } else {
            this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 10000);
            this.camera.up.set(0, 0, 1);
            this.camera.position.copy(currentPos);
            this.controls.object = this.camera;
            this.controls.target.copy(currentTarget);

            // Update viewcube with new camera reference
            if (this.viewCube) {
                this.viewCube.updateCamera(this.camera, this.controls);
            }

            return 'Perspective';
        }
    }
}
