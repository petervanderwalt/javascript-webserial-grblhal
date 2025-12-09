

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// --- Theme Colors for the 3D Viewer ---
const COLORS = {
    background: 0xF1F5F9, // Light Gray-Blue BG (neutral, good)
    grid: 0x555555,       // Slate grid (still good)

    axisX: 0xEF4444,      // Red (keep standard)
    axisY: 0x22C55E,      // Green (keep standard)

    feed: 0x6A6B6A,       // Medium Graphite
    rapid: 0xFFD949       // Solar Yellow
};


export class GCodeViewer {
    constructor(containerId, loadingOverlayId) {
        this.container = document.getElementById(containerId);
        this.loadingOverlay = document.getElementById(loadingOverlayId);

        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;

        this.gcodeGroup = new THREE.Group();
        this.gridGroup = new THREE.Group();

        this.gridBounds = { xmin: -100, ymin: -100, xmax: 100, ymax: 100 };

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

        // Groups
        this.scene.add(this.gridGroup);
        this.scene.add(this.gcodeGroup);

        this.renderStaticGrid();
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
            const s = 200; // View size
            this.camera.left = -s * (w / h);
            this.camera.right = s * (w / h);
            this.camera.top = s;
            this.camera.bottom = -s;
        }

        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
    }

    renderStaticGrid() {
        this.gridGroup.clear();
        const { xmin, ymin, xmax, ymax } = this.gridBounds;
        const step = 10;

        // Separate arrays for the faint grid and the strong axes
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

        // Vertical lines
        for (let x = Math.floor(xmin / step) * step; x <= Math.ceil(xmax / step) * step; x += step) {
            addLine(x, ymin, x, ymax, x === 0 ? c_axisY : c_main, x === 0);
        }

        // Horizontal lines
        for (let y = Math.floor(ymin / step) * step; y <= Math.ceil(ymax / step) * step; y += step) {
            addLine(xmin, y, xmax, y, y === 0 ? c_axisX : c_main, y === 0);
        }

        // 1. Render Faint Grid
        const gridGeo = new THREE.BufferGeometry();
        gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gridPoints, 3));
        gridGeo.setAttribute('color', new THREE.Float32BufferAttribute(gridColors, 3));

        const gridMat = new THREE.LineBasicMaterial({
            vertexColors: true,
            transparent: true,
            opacity: 0.25
        });
        this.gridGroup.add(new THREE.LineSegments(gridGeo, gridMat));

        // 2. Render Opaque Axes
        const axisGeo = new THREE.BufferGeometry();
        axisGeo.setAttribute('position', new THREE.Float32BufferAttribute(axisPoints, 3));
        axisGeo.setAttribute('color', new THREE.Float32BufferAttribute(axisColors, 3));

        const axisMat = new THREE.LineBasicMaterial({
            vertexColors: true,
            transparent: false,
            opacity: 1.0,
            linewidth: 2
        });
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
        reader.onload = (evt) => {
            this.sendToWorker(evt.target.result);
        };
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
                xmin: box.min.x - 20,
                ymin: box.min.y - 20,
                xmax: box.max.x + 20,
                ymax: box.max.y + 20
            };
            this.renderStaticGrid();
            this.resetCamera();
        }
    }
}
