import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ViewCube } from './viewcube.js';
import { buildToolGroup, DEFAULT_PARAMS } from './endmill-generator.js';

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

const LASER_CONFIG = {
    color: 0x0030cc, // 445nm blue diode laser — deeper to avoid additive washout
    beamLength: 20,
    beamRadius: 0.2,
    glowColor: 'rgba(0, 48, 204, 1)'
};

class ParticleSystem {
    constructor(scene) {
        this.scene = scene;
        this.particles = [];
        this.chipColors = this._loadChipColors();
    }

    _loadChipColors() {
        const s = getComputedStyle(document.body);
        return [
            s.getPropertyValue('--oz-primary').trim() || '#FF6600',
            s.getPropertyValue('--oz-primary-light').trim() || '#FF8533',
            s.getPropertyValue('--oz-primary-dark').trim() || '#D55700',
            s.getPropertyValue('--oz-grey-dark').trim() || '#2F373C',
            s.getPropertyValue('--oz-grey-mid').trim() || '#6B7280',
        ];
    }

    emit(pos, count, type) {
        for (let i = 0; i < count; i++) {
            if (type === 'chip') this.createChip(pos);
            else if (type === 'vapor') this.createVapor(pos);
        }
    }

    createChip(pos) {
        const hex = this.chipColors[Math.floor(Math.random() * this.chipColors.length)];
        const mat = new THREE.SpriteMaterial({ color: new THREE.Color(hex) });
        const sprite = new THREE.Sprite(mat);
        sprite.position.copy(pos);
        sprite.scale.set(1.5, 1.5, 1.5);

        const velocity = new THREE.Vector3(
            (Math.random() - 0.5) * 50,
            (Math.random() - 0.5) * 50,
            (Math.random()) * 50 // Upwards mostly
        );

        this.scene.add(sprite);
        this.particles.push({ mesh: sprite, velocity: velocity, life: 1.0, type: 'chip' });
    }

    createVapor(pos) {
        const mat = new THREE.SpriteMaterial({
            color: 0x0030cc,
            transparent: true,
            opacity: 0.6,
            blending: THREE.AdditiveBlending
        });
        const sprite = new THREE.Sprite(mat);
        sprite.position.copy(pos);
        sprite.position.x += (Math.random() - 0.5) * 2;
        sprite.position.y += (Math.random() - 0.5) * 2;

        sprite.scale.set(2, 2, 1);

        const velocity = new THREE.Vector3(
            (Math.random() - 0.5) * 10,
            (Math.random() - 0.5) * 10,
            (Math.random()) * 20 + 10 // Upwards
        );

        this.scene.add(sprite);
        this.particles.push({ mesh: sprite, velocity: velocity, life: 0.8, type: 'vapor' });
    }

    update(delta) {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.life -= delta;

            p.mesh.position.addScaledVector(p.velocity, delta);

            if (p.type === 'chip') {
                p.velocity.z -= 9.8 * 10 * delta; // Gravity
                p.mesh.rotation.z += 5 * delta; // Spin
            } else if (p.type === 'vapor') {
                p.mesh.scale.multiplyScalar(1.0 + delta); // Expand
                p.mesh.material.opacity = p.life; // Fade
            }

            if (p.life <= 0 || p.mesh.position.z < -100) {
                this.scene.remove(p.mesh);
                if (p.mesh.material) p.mesh.material.dispose();
                this.particles.splice(i, 1);
            }
        }
    }
}

export class GCodeViewer {
    constructor(containerId, store) {
        this.container = document.getElementById(containerId);
        this.store = store; // Save store reference

        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;

        // Unit State
        this.nativeUnits = 'mm';
        this.displayUnits = 'mm';

        // Grid State - Load from Store
        this.gridMode = this.store ? (this.store.get('viewer.gridMode') || 'machine') : 'machine';

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
        this.isPositiveSpace = false; // Based on build info [OPT:Z]
        this.homingDirMask = 0;      // Based on $23 setting
        this.wco = { x: 0, y: 0, z: 0 };

        // Tweening State
        this.targetToolPos = new THREE.Vector3(0, 0, 0);
        this.currentToolPos = new THREE.Vector3(0, 0, 0);
        this.lastToolPos = new THREE.Vector3(0, 0, 0); // Track previous pos for movement detection

        // Progress Tracking
        this.lineMap = []; // lineNum -> { start, count }
        this.lastRenderedLine = 0;
        this.feedMesh = null;
        this.particleSystem = null; // Instantiated in init()

        this.currentGCode = '';

        // Endmill parameters (persisted via store)
        this.endmillParams = { ...DEFAULT_PARAMS };
        if (this.store) {
            const saved = this.store.get('viewer.endmillParams');
            if (saved) this.endmillParams = { ...DEFAULT_PARAMS, ...saved };
        }

        // Spindle Animation State
        this.spindleSpeed = 0;
        this.laserPower = 0; // 0-1 range
        this.isLaserMode = false;
        this.isLaserMode = false;
        this.cameraMode = 'orbit'; // 'orbit' | 'spindle'
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
            alpha: false,
            powerPreference: "high-performance"
        });
        this.renderer.setSize(w, h);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setClearColor(0xffffff, 1);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.25;

        this.container.appendChild(this.renderer.domElement);

        this._createEnvironment();

        // Camera (Z-Up)
        this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 10000);
        this.camera.up.set(0, 0, 1);
        this.camera.position.set(0, -200, 200);

        // Controls
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = false;

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

        // Instantiate Particle System attached to workOffsetsGroup so it uses local Work coordinates
        this.particleSystem = new ParticleSystem(this.workOffsetsGroup);

        // Context Menu Event
        this.renderer.domElement.addEventListener('contextmenu', (e) => this.onContextMenu(e));

        // Start animation loop (viewer tab is default visible)
        this._active = true;
        requestAnimationFrame(() => this.animate());
    }

    startAnim() {
        if (this._active) return;
        this._active = true;
        requestAnimationFrame(() => this.animate());
    }

    stopAnim() {
        this._active = false;
    }

    _createEnvironment() {
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 512;
        const ctx = canvas.getContext('2d');
        const grad = ctx.createLinearGradient(0, 0, 0, 512);
        grad.addColorStop(0, '#c8d8e8');
        grad.addColorStop(0.45, '#8898a8');
        grad.addColorStop(0.55, '#586878');
        grad.addColorStop(1, '#384858');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 512, 512);

        const envTexture = new THREE.CanvasTexture(canvas);
        envTexture.mapping = THREE.EquirectangularReflectionMapping;
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        const envMap = pmrem.fromEquirectangular(envTexture).texture;
        pmrem.dispose();
        this.scene.environment = envMap;
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
        if (!this._active) return;
        requestAnimationFrame(() => this.animate());
        const delta = this.clock.getDelta();

        // Tool position is in WPos (local to workOffsetsGroup)
        this.currentToolPos.lerp(this.targetToolPos, 0.1);
        this.toolGroup.position.copy(this.currentToolPos);

        const elapsedTime = this.clock.getElapsedTime();

        if (this.spindleSpeed > 0 && !this.isLaserMode) {
            const radiansPerSecond = this.spindleSpeed * (Math.PI / 30);
            const targetRotationZ = elapsedTime * radiansPerSecond;
            this.toolGroup.rotation.z = -targetRotationZ;
        }

        if (this.isLaserMode) {
            this.updateLaserVisuals();
        }

        if (this.controls) this.controls.update();
        if (this.particleSystem) this.particleSystem.update(delta);

        // Emit particles if moving and spindle on
        const dist = this.currentToolPos.distanceTo(this.lastToolPos);
        if (dist > 0.01 && this.spindleSpeed > 0) {
            // Determine type: 'chip' or 'vapor'
            const type = this.isLaserMode ? 'vapor' : 'chip';
            // Emit count proportional to distance/speed
            const count = Math.min(Math.floor(dist * 5), 10);
            this.particleSystem.emit(this.currentToolPos, count, type);
        }
        this.lastToolPos.copy(this.currentToolPos);
        // --- Camera: Spindle View ---
        if (this.cameraMode === 'spindle') {
            // Keep the camera looking at the spindle position
            // User can still orbit/zoom freely — only the target follows the tool
            const worldToolPos = new THREE.Vector3();
            this.toolGroup.getWorldPosition(worldToolPos);
            this.controls.target.copy(worldToolPos);
        }

        if (this.renderer && this.scene && this.camera) {
            this.renderer.render(this.scene, this.camera);
        }
    }

    setSpindleSpeed(rpm) {
        this.spindleSpeed = rpm || 0;
        // Map RPM to Laser Power (0-1000 usually) -> 0-1
        // Assuming $30=1000 max spindle speed for laser
        this.laserPower = Math.min(Math.max(this.spindleSpeed / 1000, 0), 1);
    }

    setLaserMode(enabled) {
        if (this.isLaserMode === enabled) return;
        this.isLaserMode = enabled;
        this.renderTool(); // Re-render tool (Endmill vs Laser)
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
        ctx.font = `bold ${fontsize}px "Nunito", sans-serif`;
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
        ctx.font = `bold ${fontsize}px "Nunito", sans-serif`;
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
            const ox = -this.wco.x; // Machine Origin (Home) in Local Space
            const oy = -this.wco.y; // Machine Origin (Home) in Local Space

            let xMin, xMax, yMin, yMax;

            if (this.isPositiveSpace) {
                // X Axis
                if (this.homingDirMask & 1) { xMin = 0; xMax = mx; } // Home to Min
                else { xMin = -mx; xMax = 0; }                      // Home to Max

                // Y Axis
                if (this.homingDirMask & 2) { yMin = 0; yMax = my; } // Home to Min
                else { yMin = -my; yMax = 0; }                      // Home to Max
            } else {
                // Standard CNC: Home at Max, Travel Negative
                xMin = -mx; xMax = 0;
                yMin = -my; yMax = 0;
            }

            this.gridBounds = {
                xmin: ox + xMin,
                ymin: oy + yMin,
                xmax: ox + xMax,
                ymax: oy + yMax,
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
        
        // Auto reset camera to see the new grid
        if (typeof this.resetCamera === 'function') this.resetCamera();
        
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
            this._updateFeedEnvelopeColors();
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
            this._updateFeedEnvelopeColors();
        }
    }

    renderWCSOrigin() {
        this.wcsGroup.clear();
        this.wcsGroup.add(new THREE.AxesHelper(20));
    }

    _getEnvelopeBounds() {
        const { x, y, z } = this.machineLimits || { x: 0, y: 0, z: 0 };
        let xMin, xMax, yMin, yMax, zMin, zMax;
        if (this.isPositiveSpace) {
            if (this.homingDirMask & 1) { xMin = 0; xMax = x; } else { xMin = -x; xMax = 0; }
            if (this.homingDirMask & 2) { yMin = 0; yMax = y; } else { yMin = -y; yMax = 0; }
            if (this.homingDirMask & 4) { zMin = 0; zMax = z; } else { zMin = -z; zMax = 0; }
        } else {
            xMin = -x; xMax = 0; yMin = -y; yMax = 0; zMin = -z; zMax = 0;
        }
        return { xMin, xMax, yMin, yMax, zMin, zMax };
    }

    _updateFeedEnvelopeColors() {
        if (!this.feedMesh) return;
        const posAttr = this.feedMesh.geometry.attributes.position;
        const colAttr = this.feedMesh.geometry.attributes.color;
        if (!posAttr || !colAttr || !this.feedColorsCache) return;

        const pos = posAttr.array;
        const colors = colAttr.array;
        const cache = this.feedColorsCache;
        const env = this._getEnvelopeBounds();
        const wco = this.wco || { x: 0, y: 0, z: 0 };

        const outsideColor = new THREE.Color(0xdc2626);

        for (let i = 0; i < pos.length; i += 3) {
            const mx = pos[i] + wco.x;
            const my = pos[i + 1] + wco.y;
            const mz = pos[i + 2] + wco.z;
            const inside = mx >= env.xMin && mx <= env.xMax &&
                           my >= env.yMin && my <= env.yMax &&
                           mz >= env.zMin && mz <= env.zMax;
            if (!inside) {
                colors[i] = outsideColor.r;
                colors[i + 1] = outsideColor.g;
                colors[i + 2] = outsideColor.b;
            } else {
                colors[i] = cache[i];
                colors[i + 1] = cache[i + 1];
                colors[i + 2] = cache[i + 2];
            }
        }
        colAttr.needsUpdate = true;
    }

    renderMachineBox() {
        this.machineGroup.clear();

        const { x, y, z } = this.machineLimits;

        // Origin after homing logic ($23 and Z option):
        // isPositiveSpace (Z option): Set origin (0,0,0) at home position.
        // Homing Dir ($23 bit): 0 = Home to MAX (travel is negative), 1 = Home to MIN (travel is positive).

        let xMin, xMax, yMin, yMax, zMin, zMax;

        if (this.isPositiveSpace) {
            if (this.homingDirMask & 1) { xMin = 0; xMax = x; } else { xMin = -x; xMax = 0; }
            if (this.homingDirMask & 2) { yMin = 0; yMax = y; } else { yMin = -y; yMax = 0; }
            if (this.homingDirMask & 4) { zMin = 0; zMax = z; } else { zMin = -z; zMax = 0; }
        } else {
            xMin = -x; xMax = 0; yMin = -y; yMax = 0; zMin = -z; zMax = 0;
        }

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
        // Dispose old tool geometry/materials
        if (this._endmillGeneratedGroup) {
            this._endmillGeneratedGroup.traverse(child => {
                if (child.isMesh) {
                    if (child.geometry) child.geometry.dispose();
                    if (child.material) {
                        if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
                        else child.material.dispose();
                    }
                }
            });
            this._endmillGeneratedGroup = null;
        }
        this.toolGroup.clear();

        if (this.isLaserMode) {
            this.renderLaserModule();
        } else {
            this.renderEndmill();
        }

        this.updateToolPosition(this.currentToolPos.x, this.currentToolPos.y, this.currentToolPos.z);
    }

    renderLaserModule() {
        // 1. Laser Body (Simple Box/Cylinder representation)
        // Offset body UP so the gap below is for the beam
        // e.g. Body starts at Z = LASER_CONFIG.beamLength
        const bodyHeight = 30;
        const bodyGeo = new THREE.CylinderGeometry(10, 10, bodyHeight, 16);
        const bodyMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.5, metalness: 0.5 });

        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.rotation.x = Math.PI / 2; // Cylinder is Y-up by default, rotate to Z-up

        // Position: 
        // Tip of beam is at Z=0 relative to tool group.
        // Beam length is LASER_CONFIG.beamLength (e.g. 20).
        // So Body bottom should be at Z=20.
        // Body center is at Z = 20 + (30/2) = 35.
        body.position.z = LASER_CONFIG.beamLength + (bodyHeight / 2);

        this.toolGroup.add(body);

        // 2. Laser Beam
        // Cylinder is centered at local origin. 
        // We want it to span from Z=0 to Z=20.
        // Center at Z=10.
        const beamGeo = new THREE.CylinderGeometry(LASER_CONFIG.beamRadius, LASER_CONFIG.beamRadius, LASER_CONFIG.beamLength, 8);
        const beamMat = new THREE.MeshBasicMaterial({
            color: LASER_CONFIG.color,
            transparent: true,
            opacity: 0.5,
            depthWrite: false
        });
        this.laserBeam = new THREE.Mesh(beamGeo, beamMat);
        this.laserBeam.rotation.x = Math.PI / 2;
        this.laserBeam.position.z = LASER_CONFIG.beamLength / 2;
        this.toolGroup.add(this.laserBeam);

        // 2b. Idle beam — dim, non-glowing line visible when laser is off
        const idleMat = new THREE.MeshBasicMaterial({
            color: LASER_CONFIG.color,
            transparent: true,
            opacity: 0.3,
            depthWrite: false
        });
        this.laserBeamIdle = new THREE.Mesh(beamGeo.clone(), idleMat);
        this.laserBeamIdle.rotation.x = Math.PI / 2;
        this.laserBeamIdle.position.z = LASER_CONFIG.beamLength / 2;
        this.toolGroup.add(this.laserBeamIdle);

        // 3. Laser Glow Sprite
        // At the tip (Z=0)
        const glowTexture = this.createGlowTexture();
        const glowMat = new THREE.SpriteMaterial({
            map: glowTexture,
            color: 0xffffff,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });
        this.laserGlow = new THREE.Sprite(glowMat);
        this.laserGlow.scale.set(10, 10, 1);
        this.laserGlow.position.set(0, 0, 0.1); // Just above Z=0
        this.toolGroup.add(this.laserGlow);
    }

    createGlowTexture() {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
        gradient.addColorStop(0, 'rgba(0, 20, 140, 1)');
        gradient.addColorStop(0.2, 'rgba(0, 40, 200, 0.8)');
        gradient.addColorStop(0.5, 'rgba(0, 80, 255, 0.35)');
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 64, 64);
        return new THREE.CanvasTexture(canvas);
    }

    updateLaserVisuals() {
        if (!this.laserBeam || !this.laserGlow || !this.laserBeamIdle) return;

        // Pulse effect or power-based scaling
        // Min opacity when on: 0.3, Max: 0.9
        const power = Math.max(this.laserPower, 0.05);
        // Actually, if spindle is 0, power is 0. 

        if (this.spindleSpeed <= 0) {
            this.laserBeam.visible = false;
            this.laserGlow.visible = false;
            this.laserBeamIdle.visible = true;
            return;
        } else {
            this.laserBeam.visible = true;
            this.laserGlow.visible = true;
            this.laserBeamIdle.visible = false;
        }

        const flicker = 0.95 + Math.random() * 0.1;

        this.laserBeam.material.opacity = (0.15 + (power * 0.3)) * flicker;
        this.laserGlow.material.opacity = (0.15 + (power * 0.35)) * flicker;

        const scale = (4 + (power * 6)) * flicker;
        this.laserGlow.scale.set(scale, scale, 1);
    }

    renderEndmill() {
        const toolGroup = buildToolGroup(this.endmillParams);
        this.toolGroup.add(toolGroup);
        this._endmillGeneratedGroup = toolGroup;
    }

    updateEndmillParams(params) {
        this.endmillParams = { ...this.endmillParams, ...params };
        if (this.store) {
            this.store.set('viewer.endmillParams', this.endmillParams);
        }
        if (!this.isLaserMode) {
            this.renderTool();
        }
    }

    getEndmillParams() {
        return { ...this.endmillParams };
    }

    updateToolPosition(x, y, z) {
        if (x !== undefined && y !== undefined && z !== undefined) {
            this.targetToolPos.set(x, y, z);
        }
    }

    processGCodeString(gcode, successMessage = 'G-code parsed') {
        this.sendToWorker(gcode, successMessage);
    }

    loadLocalFile(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (evt) => { this.sendToWorker(evt.target.result, `${file.name} parsed`); };
        reader.readAsText(file);
    }

    sendToWorker(data, successMessage = 'G-code parsed') {
        this.currentGCode = data; // Store for tool parsing
        const worker = new Worker('gcview.worker.js', { type: 'module' });
        worker.onmessage = (msg) => {
            const payload = msg.data;
            if (payload.progress !== undefined) return;
            if (payload.feedGeo || payload.rapidGeo) {
                this.nativeUnits = payload.inch ? 'inch' : 'mm';
                this.renderLines(payload);
                this.renderCoolGrid();
                worker.terminate();
                if (successMessage && window.showToast) {
                    window.showToast(successMessage, 'file-text', 'success');
                }

                // Dispatch stats event for UI panels to consume
                window.dispatchEvent(new CustomEvent('gcode-stats', {
                    detail: {
                        totalDist: payload.totalDist || 0,
                        totalTime: payload.totalTime || 0,
                        segmentLengthStats: payload.segmentLengthStats || [],
                        inch: payload.inch || false
                    }
                }));
            }
        };
        worker.postMessage({ data: data });
    }

    renderLines(payload) {
        this.gcodeGroup.clear();
        this.lineMap = payload.lineMap || [];
        this.lastRenderedLine = 0;
        this.feedMesh = null;

        const feedGeo = payload.feedGeo;
        const rapidGeo = payload.rapidGeo;

        if (feedGeo && feedGeo.length > 0) {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(feedGeo, 3));

            // Generate initial colors on GPU-side (BufferAttribute)
            const colorBuffer = new Float32Array(feedGeo.length);
            
            // Extract colors from computed CSS styles to match the UI theme
            const cssAppPrimary = getComputedStyle(document.body).getPropertyValue('--color-primary').trim() || '#449D9F';
            const cssAppSecondary = getComputedStyle(document.body).getPropertyValue('--color-secondary').trim() || '#FF6600';
            
            const colorG1 = new THREE.Color(cssAppPrimary);
            const colorG23 = new THREE.Color(cssAppSecondary);
            const feedTypes = payload.feedTypes;

            // Faked directional light for line volume
            const lightDir = new THREE.Vector3(1, 1, 1).normalize();
            const D = new THREE.Vector3();
            const crossVec = new THREE.Vector3();

            for (let i = 0; i < colorBuffer.length; i += 6) {
                // Compute direction of this segment
                D.set(
                    feedGeo[i + 3] - feedGeo[i],
                    feedGeo[i + 4] - feedGeo[i + 1],
                    feedGeo[i + 5] - feedGeo[i + 2]
                );
                
                // If zero length, default to 1
                if (D.lengthSq() > 0) D.normalize();
                else D.set(0, 0, 1);

                // Intensity based on cross product (max light when line is perpendicular to light ray)
                crossVec.crossVectors(D, lightDir);
                // Base ambient 0.5 + Diffuse 0.5
                const intensity = 0.5 + 0.5 * crossVec.length();

                for (let v = 0; v < 2; v++) {
                    const idx = i + v * 3;
                    const type = (feedTypes && (idx/3) < feedTypes.length) ? feedTypes[idx / 3] : 1;
                    const c = (type === 2) ? colorG23 : colorG1;
                    
                    colorBuffer[idx] = c.r * intensity;
                    colorBuffer[idx + 1] = c.g * intensity;
                    colorBuffer[idx + 2] = c.b * intensity;
                }
            }
            
            this.feedColorsCache = new Float32Array(colorBuffer);
            geo.setAttribute('color', new THREE.BufferAttribute(colorBuffer, 3));

            const mat = new THREE.LineBasicMaterial({
                vertexColors: true,
                linewidth: 2,
                depthTest: false
            });
            this.feedMesh = new THREE.LineSegments(geo, mat);
            this.gcodeGroup.add(this.feedMesh);
            this._updateFeedEnvelopeColors();
        }

        if (rapidGeo && rapidGeo.length > 0) {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(rapidGeo, 3));
            const cssAppDanger = getComputedStyle(document.body).getPropertyValue('--color-axis-x').trim() || COLORS.rapid;
            this.gcodeGroup.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
                color: new THREE.Color(cssAppDanger),
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



    updateProgress(currentLine) {
        if (!this.feedMesh || !this.lineMap) return;

        const colorAttr = this.feedMesh.geometry.attributes.color;

        // If currentLine reset (e.g. restart), reset all colors
        if (currentLine < this.lastRenderedLine) {
            if (this.feedColorsCache) {
                for (let i = 0; i < colorAttr.count; i++) {
                    const idx = i * 3;
                    colorAttr.setXYZ(i, this.feedColorsCache[idx], this.feedColorsCache[idx+1], this.feedColorsCache[idx+2]);
                }
            }
            colorAttr.updateRange.offset = 0;
            colorAttr.updateRange.count = -1;
            colorAttr.needsUpdate = true;
            this.lastRenderedLine = 0;
        }

        // LineMap is Uint32Array: [start, count, start, count, ...]
        const maxLine = (this.lineMap.length / 2) - 1;
        const targetLine = Math.min(currentLine, maxLine);

        if (targetLine > this.lastRenderedLine) {
            let minStart = Infinity;
            let maxEnd = 0;
            
            for (let l = this.lastRenderedLine + 1; l <= targetLine; l++) {
                const start = this.lineMap[l * 2];
                const count = this.lineMap[l * 2 + 1];
                if (count > 0) {
                    if (start < minStart) minStart = start;
                    if (start + count > maxEnd) maxEnd = start + count;

                    for (let k = 0; k < count; k++) {
                        colorAttr.setXYZ(start + k, 0.2, 0.2, 0.2);
                    }
                }
            }
            if (minStart < Infinity) {
                if (colorAttr.updateRange.count === -1) {
                    colorAttr.updateRange.offset = minStart * 3;
                    colorAttr.updateRange.count = (maxEnd - minStart) * 3;
                } else {
                    const currentOffset = colorAttr.updateRange.offset;
                    const currentEnd = currentOffset + colorAttr.updateRange.count;
                    const newOffset = Math.min(currentOffset, minStart * 3);
                    const newEnd = Math.max(currentEnd, maxEnd * 3);
                    colorAttr.updateRange.offset = newOffset;
                    colorAttr.updateRange.count = newEnd - newOffset;
                }
                colorAttr.needsUpdate = true;
            }
            this.lastRenderedLine = targetLine;
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
        const box = new THREE.Box3().setFromObject(this.gcodeGroup);
        let center = new THREE.Vector3(0, 0, 0);
        let maxDim = 100;
        let isSetup = false;

        if (!box.isEmpty()) {
            center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            maxDim = Math.max(size.x, size.y);
            isSetup = true;
        } else {
            const gridBox = new THREE.Box3().setFromObject(this.gridGroup);
            if (!gridBox.isEmpty() && isFinite(gridBox.min.x)) {
                center = gridBox.getCenter(new THREE.Vector3());
                const size = gridBox.getSize(new THREE.Vector3());
                maxDim = Math.max(size.x, size.y, size.z || 100);
                isSetup = true;
            }
        }

        // Target View: Front-Facing, Tilted back
        const targetPos = new THREE.Vector3(center.x, center.y - maxDim * 1.5, center.z + maxDim);
        this.camera.position.copy(targetPos);
        this.controls.target.copy(center);
        this.controls.update();
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
        } else {
            // Use Grid Box (Grid Focus) if no gcode
            const gridBox = new THREE.Box3().setFromObject(this.gridGroup);
            if (!gridBox.isEmpty() && isFinite(gridBox.min.x)) {
                center = gridBox.getCenter(new THREE.Vector3());
                const size = gridBox.getSize(new THREE.Vector3());
                const maxDim = Math.max(size.x, size.y, size.z || 100);
                dist = maxDim * 2;
            } else if (this.workOffsetsGroup) {
                center.copy(this.workOffsetsGroup.position);
            }
        }

        this.controls.target.copy(center);

        // Calculate target position and up vector
        let targetPosition = new THREE.Vector3();
        let targetUp = new THREE.Vector3();

        this.cameraMode = 'orbit'; // Reset to orbit when manually setting view

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

        // Snap camera to target position without tweening
        this.animateCamera(targetPosition, targetUp);
    }

    animateCamera(targetPosition, targetUp) {
        this.camera.position.copy(targetPosition);
        this.camera.up.copy(targetUp);
        this.controls.update();
    }

    toggleCamera() {
        console.log('[toggleCamera] entered. cameraMode:', this.cameraMode, 'camera type:', this.camera?.constructor?.name);
        this.cameraMode = 'orbit';
        const oldPos = this.camera.position.clone();
        const oldTarget = this.controls.target.clone();
        console.log('[toggleCamera] oldPos:', oldPos.toArray().map(v=>v.toFixed(2)), 'oldTarget:', oldTarget.toArray().map(v=>v.toFixed(2)));
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        if (this.camera instanceof THREE.PerspectiveCamera) {
            console.log('[toggleCamera] switching TO orthographic');
            const box = new THREE.Box3().setFromObject(this.gcodeGroup);
            let maxDim = 100;
            if (!box.isEmpty()) {
                const size = box.getSize(new THREE.Vector3());
                maxDim = Math.max(size.x, size.y);
                console.log('[toggleCamera] gcode box size:', size.toArray().map(v=>v.toFixed(2)), 'maxDim:', maxDim);
            } else {
                console.log('[toggleCamera] gcodeGroup box is EMPTY');
            }
            const aspect = w / h;
            const frustumSize = Math.max(maxDim * 0.6, 100);
            console.log('[toggleCamera] frustumSize:', frustumSize, 'aspect:', aspect);
            this.camera = new THREE.OrthographicCamera(frustumSize * aspect / -2, frustumSize * aspect / 2, frustumSize / 2, frustumSize / -2, 1, 10000);
            this.camera.up.set(0, 0, 1);
            this.camera.position.copy(oldPos);
            this.camera.zoom = 1;
            this.controls.object = this.camera;
            this.controls.target.copy(oldTarget);
        } else {
            console.log('[toggleCamera] switching TO perspective');
            this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 10000);
            this.camera.up.set(0, 0, 1);
            this.camera.position.copy(oldPos);
            this.controls.object = this.camera;
            this.controls.target.copy(oldTarget);
        }
        console.log('[toggleCamera] new camera pos:', this.camera.position.toArray().map(v=>v.toFixed(2)), 'target:', this.controls.target.toArray().map(v=>v.toFixed(2)));
        if (this.viewCube) {
            this.viewCube.updateCamera(this.camera, this.controls);
        }
        console.log('[toggleCamera] scheduling resetCamera in 50ms');
        setTimeout(() => {
            console.log('[toggleCamera] resetCamera firing');
            this.resetCamera();
            console.log('[toggleCamera] after resetCamera pos:', this.camera.position.toArray().map(v=>v.toFixed(2)), 'target:', this.controls.target.toArray().map(v=>v.toFixed(2)));
        }, 50);
        return this.camera instanceof THREE.PerspectiveCamera ? 'Perspective' : 'Orthographic';
    }

    getCameraType() {
        if (this.camera instanceof THREE.PerspectiveCamera) return 'Perspective';
        if (this.camera instanceof THREE.OrthographicCamera) return 'Orthographic';
        return 'Unknown';
    }

    setCameraMode(mode) {
        this.cameraMode = mode;
    }

    onContextMenu(event) {
        event.preventDefault();
        if (!this.isMachineIdle()) return;

        // Only honor clicks inside the machine's valid workspace
        const { x, y } = this.machineLimits;
        let xMin, xMax, yMin, yMax;
        if (this.isPositiveSpace) {
            xMin = (this.homingDirMask & 1) ? 0 : -x; xMax = (this.homingDirMask & 1) ? x : 0;
            yMin = (this.homingDirMask & 2) ? 0 : -y; yMax = (this.homingDirMask & 2) ? y : 0;
        } else {
            xMin = -x; xMax = 0; yMin = -y; yMax = 0;
        }

        const mouse = new THREE.Vector2();
        const rect = this.container.getBoundingClientRect();
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, this.camera);

        const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
        const target = new THREE.Vector3();

        if (raycaster.ray.intersectPlane(plane, target)) {
            // Clamp to workspace bounds
            if (target.x < xMin || target.x > xMax || target.y < yMin || target.y > yMax) return;
            this.showContextMenu(event.clientX, event.clientY, target.x, target.y);
        }
    }

    isMachineIdle() {
        const state = window.droHandler?._lastState || document.getElementById('machine-state')?.textContent || '';
        return state.toLowerCase().split(':')[0] === 'idle';
    }

    showContextMenu(x, y, mX, mY) {
        // Create or reuse DOM element
        let menu = document.getElementById('viewer-context-menu');
        if (!menu) {
            menu = document.createElement('div');
            menu.id = 'viewer-context-menu';
            menu.className = 'fixed bg-white shadow-xl rounded border border-grey-light z-[100] text-sm flex flex-col min-w-[150px] overflow-hidden';
            document.body.appendChild(menu);

            // Close on click elsewhere
            document.addEventListener('click', () => menu.classList.add('hidden'));
        }

        menu.innerHTML = `
            <div class="px-3 py-2 bg-grey-bg border-b border-grey-light font-bold text-xs text-grey uppercase">
                Machine X: ${mX.toFixed(2)} Y: ${mY.toFixed(2)}
            </div>
            <button class="text-left px-4 py-2 hover:bg-primary-light hover:text-primary-dark transition-colors"
                onclick="window.sendCmd('G53 G0 X${mX.toFixed(3)} Y${mY.toFixed(3)}');">
                <i data-lucide="pointer" style="width:14px;height:14px;margin-right:8px"></i> Jog Here (Rapid)
            </button>
            <button class="text-left px-4 py-2 hover:bg-primary-light hover:text-primary-dark transition-colors"
                onclick="window.sendCmd('G53 G1 X${mX.toFixed(3)} Y${mY.toFixed(3)} F1000');">
                <i data-lucide="pointer" style="width:14px;height:14px;margin-right:8px"></i> Jog Here (Feed)
            </button>
            <div class="border-t border-grey-light my-1"></div>
            <button class="text-left px-4 py-2 hover:bg-primary-light hover:text-primary-dark transition-colors"
                onclick="window.setWorkZeroAt(${mX.toFixed(3)}, ${mY.toFixed(3)});">
                <i data-lucide="crosshair" style="width:14px;height:14px;margin-right:8px"></i> Set XY Zero Here
            </button>
        `;
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        if (window.lucide) lucide.createIcons();
        menu.classList.remove('hidden');
    }

    setHomingDirMask(mask) {
        this.homingDirMask = mask;
        this.renderMachineBox();
        this._updateFeedEnvelopeColors();
        this.updateGridBounds();
        this.renderCoolGrid();
    }
}
