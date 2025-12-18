(function () {
    'use strict';

    // --- MATERIALS ---
    const defaultMaterial = new THREE.LineBasicMaterial({ color: 0x383838 });
    const selectedMaterial = new THREE.LineBasicMaterial({ color: 0xFFD949, linewidth: 2 });

    class Renderer {
        constructor(containerId) {
            this.container = document.getElementById(containerId);
            if (!this.container) {
                throw new Error(`Container with id "${containerId}" not found.`);
            }

            // Publicly expose materials
            this.defaultMaterial = defaultMaterial;
            this.selectedMaterial = selectedMaterial;

            this.scene = null;
            this.camera = null;
            this.renderer = null;
            this.controls = null;
            this.raycaster = null;

            this._init();
        }

        _init() {
            // Scene
            this.scene = new THREE.Scene();
            this.scene.background = new THREE.Color(0xF8F9FA); // Corresponds to grey-background

            // Camera
            this.camera = new THREE.PerspectiveCamera(75, this.container.clientWidth / this.container.clientHeight, 0.1, 10000);
            this.camera.position.set(0, 0, 100);
            this.camera.up.set(0, 1, 0);

            // Renderer
            this.renderer = new THREE.WebGLRenderer({ antialias: true });
            this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
            this.container.appendChild(this.renderer.domElement);

            // Controls
            this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
            this.controls.enableDamping = true;
            this.controls.target.set(0, 0, 0);

            // Raycaster
            this.raycaster = new THREE.Raycaster();
            this.raycaster.params.Line.threshold = 3;

            // Lighting
            this.scene.add(new THREE.AmbientLight(0xffffff, 0.7));
            const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
            directionalLight.position.set(50, 100, 50);
            this.scene.add(directionalLight);

            // Grid
            const gridHelper = new THREE.GridHelper(1000, 50);
            gridHelper.rotation.x = Math.PI / 2; // Orient grid to be the XY plane
            this.scene.add(gridHelper);

            // Event Listeners
            window.addEventListener('resize', this._onWindowResize.bind(this));

            // Start render loop
            this._animate();
        }

        _animate() {
            requestAnimationFrame(this._animate.bind(this));
            this.controls.update();
            this.renderer.render(this.scene, this.camera);
        }

        _onWindowResize() {
            this.camera.aspect = this.container.clientWidth / this.container.clientHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
        }

        // --- PUBLIC API ---

        getDomElement() {
            return this.renderer.domElement;
        }

        getScene() {
            return this.scene;
        }

        addObject(object) {
            this.scene.add(object);
        }

        removeObject(object) {
            if (object) {
                this.scene.remove(object);
                // Proper disposal to free up GPU memory
                object.traverse(child => {
                    if (child.geometry) child.geometry.dispose();
                    if (child.material) {
                        if (Array.isArray(child.material)) {
                            child.material.forEach(m => m.dispose());
                        } else {
                            child.material.dispose();
                        }
                    }
                });
            }
        }

        clearScene() {
            // Remove all objects except for the essentials like lights and grid
            const objectsToRemove = this.scene.children.filter(obj =>
                !(obj instanceof THREE.Light) &&
                !(obj instanceof THREE.GridHelper) &&
                !(obj instanceof THREE.AmbientLight)
            );

            objectsToRemove.forEach(obj => this.removeObject(obj));
        }

        raycast(event, objects) {
            const mouse = new THREE.Vector2();
            // Calculate mouse position in normalized device coordinates (-1 to +1)
            const rect = this.renderer.domElement.getBoundingClientRect();
            mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

            this.raycaster.setFromCamera(mouse, this.camera);
            return this.raycaster.intersectObjects(objects, true);
        }

        resetCameraToObject(object) {
            // Force an update of the object's world matrix so the bounding box is correct.
            object.updateMatrixWorld(true);

            const box = new THREE.Box3().setFromObject(object);

            if (box.isEmpty()) {
                this.controls.target.set(0, 0, 0);
                this.camera.position.set(0, 0, 100);
                this.controls.update();
                return;
            }

            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z);
            const fov = this.camera.fov * (Math.PI / 180);

            // Calculate the distance the camera should be from the object
            let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));
            cameraZ *= 1.5; // Add a 50% buffer to ensure the object is not clipped

            this.controls.target.copy(center);
            this.camera.position.set(center.x, center.y, center.z + cameraZ);
            this.controls.update();
        }
    }

    // Attach the class to the global window object
    window.Renderer = Renderer;

})();
