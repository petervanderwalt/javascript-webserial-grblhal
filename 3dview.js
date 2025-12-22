import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// --- Theme Colors ---
const COLORS = {
    background: 0xf8f9fa,

    // Grid (Darker Slate for better visibility on light bg)
    gridMajor: 0x94a3b8,  // Slate 400
    gridMinor: 0xcbd5e1,  // Slate 300

    text: '#64748b',      // Slate 500

    axisX: 0xef4444,
    axisY: 0x22c55e,

    feed: 0x383838,
    rapid: 0xffa500,
    machineBox: 0xffd949,

    // Stats
    statsBox: 0x94a3b8,
    statsText: '#ffffff',
    statsBg: '#383838',

    // Tool
    tool: 0xffd949, // Solar Yellow
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
        this.nativeUnits = 'mm';   // Units of the loaded G-code (Scene coordinates)
        this.displayUnits = 'mm';  // Units user wants to see (Grid/Labels)

        // Groups
        this.gcodeGroup = new THREE.Group();
        this.gridGroup = new THREE.Group();
        this.machineGroup = new THREE.Group();
        this.wcsGroup = new THREE.Group();
        this.labelsGroup = new THREE.Group();
        this.statsGroup = new THREE.Group();
        this.toolGroup = new THREE.Group();

        // Defaults
        this.gridBounds = { xmin: -100, ymin: -100, xmax: 100, ymax: 100 };
        this.machineLimits = { x: 200, y: 200, z: 100 };
        this.wco = { x: 0, y: 0, z: 0 };

        // Tweening State
        this.targetToolPos = new THREE.Vector3(0, 0, 0);
        this.currentToolPos = new THREE.Vector3(0, 0, 0);

        this.init();
    }

    init() {
        if (!this.container) return;
        const w = this.container.clientWidth;
        const h = this.container.clientHeight || 400;

        // Scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(COLORS.background);

        // Lighting
        this.scene.add(new THREE.AmbientLight(0xffffff, 0.7));
        const light = new THREE.DirectionalLight(0xffffff, 0.8);
        light.position.set(50, 50, 100);
        this.scene.add(light);

        // Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(w, h);
        this.renderer.setPixelRatio(window.devicePixelRatio);
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

    // Public method to switch display units (called from UI)
    setUnits(units) {
        if (this.displayUnits === units) return;
        this.displayUnits = units;

        this.renderCoolGrid();

        // Update stats if job is loaded
        const box = new THREE.Box3().setFromObject(this.gcodeGroup);
        if(!box.isEmpty()) this.renderJobStats(box);

        // Notify main app to update UI checkboxes (syncs if set via code/load)
        window.dispatchEvent(new CustomEvent('viewer-units-changed', { detail: { units: this.displayUnits } }));
    }

    animate() {
        requestAnimationFrame(() => this.animate());
        this.currentToolPos.lerp(this.targetToolPos, 0.1);
        this.toolGroup.position.copy(this.currentToolPos);
        if (this.controls) this.controls.update();
        if (this.renderer && this.scene && this.camera) {
            this.renderer.render(this.scene, this.camera);
        }
    }

    resize() {
        if (!this.container || this.container.clientWidth === 0) return;
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
    }

    // --- Text Helpers ---

    createTextSprite(text) {
        const fontsize = 18;
        const canvas = document.createElement('canvas');
        // Add extra padding to prevent clipping
        const width = (text.length * (fontsize * 0.6)) + 40;
        const height = fontsize + 20;

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

        const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
        const sprite = new THREE.Sprite(mat);
        // Scale down sprite in 3D space
        const scale = 0.25;
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
        tex.anisotropy = 16;

        const material = new THREE.MeshBasicMaterial({
            map: tex, transparent: true, opacity: 1, side: THREE.DoubleSide, depthWrite: false
        });

        const scaleFactor = 0.15;
        const geometry = new THREE.PlaneGeometry(canvasWidth * scaleFactor, canvasHeight * scaleFactor);
        return new THREE.Mesh(geometry, material);
    }

    // --- Grid Logic (Scaled) ---

    renderCoolGrid() {
        this.gridGroup.clear();
        this.labelsGroup.clear();

        const { xmin, xmax, ymin, ymax } = this.gridBounds;

        const isDisplayInch = this.displayUnits === 'inch';
        const isNativeInch = this.nativeUnits === 'inch';

        // 1. Calculate Conversion Factor (Scene Units per Display Unit)
        // If Native is MM, 1 Inch Display = 25.4 Scene Units
        // If Native is Inch, 1 MM Display = 1/25.4 Scene Units
        let unitsPerDisplayUnit = 1;
        if (!isNativeInch && isDisplayInch) {
            unitsPerDisplayUnit = 25.4; // Displaying Inch grid on MM geometry
        } else if (isNativeInch && !isDisplayInch) {
            unitsPerDisplayUnit = 1 / 25.4; // Displaying MM grid on Inch geometry
        }

        // 2. Define Grid Density (In Display Units)
        const stepDisplay = isDisplayInch ? 0.25 : 10;
        const majorDisplay = isDisplayInch ? 1.0 : 50;

        // 3. Convert to Scene Coordinate Deltas
        const stepScene = stepDisplay * unitsPerDisplayUnit;
        const majorScene = majorDisplay * unitsPerDisplayUnit;

        const epsilon = 0.0001;

        // Helper to check for major lines using Scene Coords
        const isMajor = (val) => {
            // Normalize value relative to major interval to avoid floating point modulo issues near zero
            const rem = Math.abs(val / majorScene);
            const distToInt = Math.abs(rem - Math.round(rem));
            return distToInt < epsilon;
        };

        const vertices = [];
        const colors = [];
        const cMajor = new THREE.Color(COLORS.gridMajor);
        const cMinor = new THREE.Color(COLORS.gridMinor);

        // Align start to the grid
        const xStart = Math.floor(xmin / stepScene) * stepScene;
        const xEnd = Math.ceil(xmax / stepScene) * stepScene;
        const yStart = Math.floor(ymin / stepScene) * stepScene;
        const yEnd = Math.ceil(ymax / stepScene) * stepScene;

        // Draw Vertical Lines (X moving)
        for (let x = xStart; x <= xEnd + epsilon; x += stepScene) {
             vertices.push(x, ymin, 0, x, ymax, 0);
             const major = isMajor(x);
             const c = major ? cMajor : cMinor;
             colors.push(c.r, c.g, c.b, c.r, c.g, c.b);

             if (major) {
                 // Label Value: Convert Scene Coord back to Display Unit
                 const val = x / unitsPerDisplayUnit;
                 // Fix rounding errors (e.g. 0.99999 -> 1)
                 const labelVal = Math.round(val * 1000) / 1000;
                 const labelText = isDisplayInch ? labelVal.toFixed(0) : labelVal.toString();

                 const s = this.createTextSprite(labelText);
                 // Label offset in Scene Units
                 const yOffset = isDisplayInch ? (0.5 * unitsPerDisplayUnit) : (8 * unitsPerDisplayUnit);

                 // Cap offset to reasonable visual limits so labels don't fly away in zoomed mm views
                 const visualOffset = Math.min(yOffset, (ymax - ymin) * 0.1);

                 s.position.set(x, ymin - (isDisplayInch && !isNativeInch ? 15 : 8), 0); // Fixed offset for consistency
                 this.labelsGroup.add(s);
             }
        }

        // Draw Horizontal Lines (Y moving)
        for (let y = yStart; y <= yEnd + epsilon; y += stepScene) {
             vertices.push(xmin, y, 0, xmax, y, 0);
             const major = isMajor(y);
             const c = major ? cMajor : cMinor;
             colors.push(c.r, c.g, c.b, c.r, c.g, c.b);

             if (major) {
                 const val = y / unitsPerDisplayUnit;
                 const labelVal = Math.round(val * 1000) / 1000;
                 const labelText = isDisplayInch ? labelVal.toFixed(0) : labelVal.toString();

                 const s = this.createTextSprite(labelText);
                 s.position.set(xmin - (isDisplayInch && !isNativeInch ? 15 : 10), y, 0);
                 this.labelsGroup.add(s);
             }
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

        const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent:true, opacity:0.4 });
        this.gridGroup.add(new THREE.LineSegments(geometry, material));

        // Draw Axes (X/Y)
        if (xStart <= 0 && xEnd >= 0) {
            const yAxisGeo = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(0, ymin, 0.05), new THREE.Vector3(0, ymax, 0.05)
            ]);
            this.gridGroup.add(new THREE.LineSegments(yAxisGeo, new THREE.LineBasicMaterial({ color: COLORS.axisY, linewidth: 2 })));
        }

        if (yStart <= 0 && yEnd >= 0) {
             const xAxisGeo = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(xmin, 0, 0.05), new THREE.Vector3(xmax, 0, 0.05)
            ]);
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
        const coneHeight = 15;
        const coneRadius = 5;
        const coneGeo = new THREE.ConeGeometry(coneRadius, coneHeight, 32);
        const coneMat = new THREE.MeshStandardMaterial({
            color: COLORS.tool,
            roughness: 0.4,
            metalness: 0.6
        });
        const cone = new THREE.Mesh(coneGeo, coneMat);
        cone.geometry.rotateX(-Math.PI / 2);
        cone.geometry.translate(0, 0, coneHeight / 2);
        this.toolGroup.add(cone);
        this.updateToolPosition(0,0,0);
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
                // Determine Native Units from File
                if (payload.inch) {
                    this.nativeUnits = 'inch';
                    // NOTE: We do NOT auto-switch display units here.
                } else {
                    this.nativeUnits = 'mm';
                    // NOTE: We do NOT auto-switch display units here.
                }

                this.renderLines(payload.linePoints);

                // Force grid update to respect current display units but with new native scaling
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
                xmax: box.max.x + 20, ymax: box.max.y + 20
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

        // 1. Dashed Box
        const boxGeo = new THREE.BoxGeometry(size.x, size.y, size.z);
        const edges = new THREE.EdgesGeometry(boxGeo);
        const line = new THREE.LineSegments(edges, new THREE.LineDashedMaterial({ color: COLORS.statsBox, dashSize: 3, gapSize: 2, opacity: 0.7, transparent: true }));
        line.computeLineDistances();
        line.position.copy(center);
        this.statsGroup.add(line);

        const margin = 5;

        // Convert Dimensions for Display
        const isDisplayInch = this.displayUnits === 'inch';
        const isNativeInch = this.nativeUnits === 'inch';
        let unitsPerDisplayUnit = 1;
        if (!isNativeInch && isDisplayInch) unitsPerDisplayUnit = 25.4;
        else if (isNativeInch && !isDisplayInch) unitsPerDisplayUnit = 1 / 25.4;

        const dimX = size.x / unitsPerDisplayUnit;
        const dimY = size.y / unitsPerDisplayUnit;
        const dimZ = size.z / unitsPerDisplayUnit;
        const unitLabel = isDisplayInch ? 'in' : 'mm';

        // 2. X Dimension
        const xMesh = this.createTextPlane(`X: ${dimX.toFixed(2)}${unitLabel}`);
        xMesh.position.set(center.x, box.min.y - margin, box.min.z);
        this.statsGroup.add(xMesh);

        // 3. Y Dimension
        const yMesh = this.createTextPlane(`Y: ${dimY.toFixed(2)}${unitLabel}`);
        yMesh.position.set(box.min.x - margin, center.y, box.min.z);
        yMesh.rotation.z = Math.PI / 2;
        this.statsGroup.add(yMesh);

        // 4. Z Dimension
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
