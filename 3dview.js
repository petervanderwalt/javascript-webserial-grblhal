
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// --- Theme Colors for the 3D Viewer ---
const COLORS = {
    background: 0xF8F9FA, // Light Gray-Blue BG
    grid: 0x555555,       // Slate grid
    axisX: 0xEF4444,      // Red
    axisY: 0x22C55E,      // Green
    feed: 0x6A6B6A,       // Medium Graphite
    rapid: 0xFFD949,      // Solar Yellow
    machineBox: 0xAAAAAA  // Ghost Gray for machine limits
};

export class GCodeViewer {
    constructor(containerId, loadingOverlayId) {
        this.container = document.getElementById(containerId);
        this.loadingOverlay = document.getElementById(loadingOverlayId);

        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;

        // Groups
        this.gcodeGroup = new THREE.Group(); // The G-Code path
        this.gridGroup = new THREE.Group();  // The floor grid
        this.machineGroup = new THREE.Group(); // The Machine Limits box
        this.wcsGroup = new THREE.Group();   // The WCS Origin marker

        this.gridBounds = { xmin: -100, ymin: -100, xmax: 100, ymax: 100 };
        this.machineLimits = { x: 200, y: 200, z: 100 }; // Defaults until fetched
        this.wco = { x: 0, y: 0, z: 0 }; // Work Coordinate Offset

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
        this.scene.add(new THREE.AmbientLight(0xCCCCCC));
        const light = new THREE.DirectionalLight(0xFFFFFF, 1.5);
        light.position.set(100, 100, 200);
        this.scene.add(light);

        // Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(w, h);
        this.container.appendChild(this.renderer.domElement);

        // Camera
        this.camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 10000);
        this.camera.up.set(0, 0, 1); // Z-up
        this.camera.position.set(0, -200, 200);

        // Controls
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.1;

        // Add Groups to Scene
        this.scene.add(this.gridGroup);
        this.scene.add(this.gcodeGroup);
        this.scene.add(this.machineGroup);
        this.scene.add(this.wcsGroup);

        // Initial Renders
        this.renderStaticGrid();
        this.renderWCSOrigin();

        // Render Machine Box (Default)
        this.renderMachineBox();

        this.animate();
    }

    animate() {
        requestAnimationFrame(() => this.animate());
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

        if (this.camera.isOrthographicCamera) {
            const s = 200;
            this.camera.left = -s * (w / h);
            this.camera.right = s * (w / h);
            this.camera.top = s;
            this.camera.bottom = -s;
        }

        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
    }

    // --- Machine Limits & WCS Logic ---

    /**
     * Update the Machine Limits (from Grbl Settings $130, $131, $132)
     */
    setMachineLimits(x, y, z) {
        if (x && y && z) {
            this.machineLimits = { x, y, z };
            this.renderMachineBox();
        }
    }

    /**
     * Update the Work Coordinate Offset (from DRO Status)
     * array: [x, y, z]
     */
    updateWCS(wcoArray) {
        if (!wcoArray || wcoArray.length < 3) return;

        // Only re-render if changed significantly to save performance
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
        // Standard RGB Axis Helper at (0,0,0) - This is WORK ZERO
        // X = Red, Y = Green, Z = Blue
        const axesHelper = new THREE.AxesHelper(20);
        this.wcsGroup.add(axesHelper);
    }

    renderMachineBox() {
        this.machineGroup.clear();

        // Machine Zero in Work Coordinates is located at WCO.
        // The Machine Group is moved to this WCO location.
        const mzX = this.wco.x;
        const mzY = this.wco.y;
        const mzZ = this.wco.z;

        const limitX = this.machineLimits.x;
        const limitY = this.machineLimits.y;
        const limitZ = this.machineLimits.z;

        // Grbl machines are usually Negative Space.
        // 0,0,0 is Home (Top Right Back).
        // Max travel is -X, -Y, -Z from there.
        // We draw the box from Machine Zero to (Machine Zero - Travel).

        const vertices = [];

        // Corners relative to Machine Zero (assuming negative space convention)
        const xMin = -limitX; const xMax = 0;
        const yMin = -limitY; const yMax = 0;
        const zMin = -limitZ; const zMax = 0;

        // Create box points
        const p1 = [xMin, yMin, zMin];
        const p2 = [xMax, yMin, zMin];
        const p3 = [xMax, yMax, zMin];
        const p4 = [xMin, yMax, zMin];
        const p5 = [xMin, yMin, zMax];
        const p6 = [xMax, yMin, zMax];
        const p7 = [xMax, yMax, zMax];
        const p8 = [xMin, yMax, zMax];

        // Helper to push line segments
        const addLine = (a, b) => vertices.push(...a, ...b);

        // Bottom Rect
        addLine(p1, p2); addLine(p2, p3); addLine(p3, p4); addLine(p4, p1);
        // Top Rect
        addLine(p5, p6); addLine(p6, p7); addLine(p7, p8); addLine(p8, p5);
        // Verticals
        addLine(p1, p5); addLine(p2, p6); addLine(p3, p7); addLine(p4, p8);

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));

        // Use LineDashedMaterial for the ghosting effect
        const dashedMat = new THREE.LineDashedMaterial({
            color: COLORS.machineBox,
            dashSize: 10,
            gapSize: 5,
            opacity: 0.5,
            transparent: true,
            depthWrite: false // Allow seeing through
        });

        const lines = new THREE.LineSegments(geometry, dashedMat);
        lines.computeLineDistances(); // Required for dashed material to render correctly

        // Position the entire Machine Group at the Machine Zero location
        this.machineGroup.position.set(mzX, mzY, mzZ);
        this.machineGroup.add(lines);

        // Add a "Machine Origin" Sphere indicator
        const homeSphere = new THREE.Mesh(
            new THREE.SphereGeometry(1.5, 8, 8),
            new THREE.MeshBasicMaterial({ color: 0x888888, transparent: true, opacity: 0.5 })
        );
        this.machineGroup.add(homeSphere);
    }

    // --- Standard Grid ---

    renderStaticGrid() {
        this.gridGroup.clear();
        const { xmin, ymin, xmax, ymax } = this.gridBounds;
        const step = 10;

        const gridPoints = [];
        const gridColors = [];
        const axisPoints = [];
        const axisColors = [];

        const c_main = new THREE.Color(COLORS.grid);
        const c_axisX = new THREE.Color(COLORS.axisX);
        const c_axisY = new THREE.Color(COLORS.axisY);

        const addLine = (x1, y1, x2, y2, c, isAxis) => {
            if (isAxis) {
                axisPoints.push(x1, y1, 0, x2, y2, 0);
                axisColors.push(c.r, c.g, c.b, c.r, c.g, c.b);
            } else {
                gridPoints.push(x1, y1, 0, x2, y2, 0);
                gridColors.push(c.r, c.g, c.b, c.r, c.g, c.b);
            }
        };

        for (let x = Math.floor(xmin / step) * step; x <= Math.ceil(xmax / step) * step; x += step) {
            addLine(x, ymin, x, ymax, x === 0 ? c_axisY : c_main, x === 0);
        }
        for (let y = Math.floor(ymin / step) * step; y <= Math.ceil(ymax / step) * step; y += step) {
            addLine(xmin, y, xmax, y, y === 0 ? c_axisX : c_main, y === 0);
        }

        const gridGeo = new THREE.BufferGeometry();
        gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gridPoints, 3));
        gridGeo.setAttribute('color', new THREE.Float32BufferAttribute(gridColors, 3));
        const gridMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.25 });
        this.gridGroup.add(new THREE.LineSegments(gridGeo, gridMat));

        const axisGeo = new THREE.BufferGeometry();
        axisGeo.setAttribute('position', new THREE.Float32BufferAttribute(axisPoints, 3));
        axisGeo.setAttribute('color', new THREE.Float32BufferAttribute(axisColors, 3));
        const axisMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: false, opacity: 1.0, linewidth: 2 });
        this.gridGroup.add(new THREE.LineSegments(axisGeo, axisMat));
    }

    // --- Interaction ---

    toggleCamera() {
        if (!this.container) return;
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        const aspect = w / h;
        const s = 200;

        if (this.camera.isPerspectiveCamera) {
            this.camera = new THREE.OrthographicCamera(-s * aspect, s * aspect, s, -s, 0.1, 10000);
            this.camera.up.set(0, 0, 1);
        } else {
            this.camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 10000);
            this.camera.up.set(0, 0, 1);
        }

        this.camera.position.set(0, -150, 150);
        this.controls.object = this.camera;
        this.controls.update();

        return this.camera.isPerspectiveCamera ? 'Persp' : 'Ortho';
    }

    resetCamera() {
        const box = new THREE.Box3().setFromObject(this.gcodeGroup);
        if (box.isEmpty()) {
            this.camera.position.set(0, -150, 150);
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

    // --- Parsing & Loading ---

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
                this.renderLines(payload.linePoints);
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
            this.gcodeGroup.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: COLORS.rapid, linewidth: 1 })));
        }

        const box = new THREE.Box3().setFromObject(this.gcodeGroup);
        if (!box.isEmpty()) {
            this.gridBounds = {
                xmin: box.min.x - 20, ymin: box.min.y - 20,
                xmax: box.max.x + 20, ymax: box.max.y + 20
            };
            this.renderStaticGrid();
            this.resetCamera();
        }
    }
}
