import * as THREE from 'three';

/**
 * ViewCube - A 3D navigation cube that shows camera orientation
 * and allows clicking faces/edges/corners to change view
 */
export class ViewCube {
    constructor(mainCamera, mainControls, container) {
        this.mainCamera = mainCamera;
        this.mainControls = mainControls;
        this.container = container;

        // Create separate scene and camera for viewcube
        this.scene = new THREE.Scene();
        this.camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 100);
        this.camera.position.set(0, 0, 10);
        this.camera.lookAt(0, 0, 0);

        // Create renderer
        const size = 120; // Size of viewcube in pixels
        this.renderer = new THREE.WebGLRenderer({
            antialias: true,
            alpha: true
        });
        this.renderer.setSize(size, size);
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.domElement.style.position = 'absolute';
        this.renderer.domElement.style.bottom = '20px';
        this.renderer.domElement.style.right = '20px';
        this.renderer.domElement.style.pointerEvents = 'auto';
        this.renderer.domElement.style.cursor = 'pointer';
        this.renderer.domElement.style.borderRadius = '8px';


        container.appendChild(this.renderer.domElement);

        // Create the cube
        this.cube = this.createCube();
        this.scene.add(this.cube);

        // Add lighting
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambientLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight.position.set(5, 5, 5);
        this.scene.add(directionalLight);

        // Raycaster for click detection
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();

        // Bind events
        this.renderer.domElement.addEventListener('click', this.onClick.bind(this));
        this.renderer.domElement.addEventListener('mousemove', this.onMouseMove.bind(this));

        // Start animation
        this.animate();
    }

    createCube() {
        const group = new THREE.Group();
        const size = 1.8;

        // Face labels and colors (using theme gray)
        const faces = [
            { label: 'TOP', color: 0x6A6B6A, position: [0, 0, size / 2], rotation: [0, 0, 0], view: 'Top' },
            { label: 'BOTTOM', color: 0x6A6B6A, position: [0, 0, -size / 2], rotation: [0, Math.PI, 0], view: 'Bottom' },
            { label: 'FRONT', color: 0x6A6B6A, position: [0, -size / 2, 0], rotation: [Math.PI / 2, 0, 0], view: 'Front' },
            { label: 'BACK', color: 0x6A6B6A, position: [0, size / 2, 0], rotation: [-Math.PI / 2, 0, 0], view: 'Back' },
            { label: 'RIGHT', color: 0x6A6B6A, position: [size / 2, 0, 0], rotation: [0, Math.PI / 2, 0], view: 'Right' },
            { label: 'LEFT', color: 0x6A6B6A, position: [-size / 2, 0, 0], rotation: [0, -Math.PI / 2, 0], view: 'Left' }
        ];

        faces.forEach(face => {
            const faceGroup = new THREE.Group();
            faceGroup.userData = { view: face.view, isFace: true };

            // Create face plane
            const geometry = new THREE.PlaneGeometry(size, size);
            const material = new THREE.MeshStandardMaterial({
                color: face.color,
                transparent: true,
                opacity: 0.5,
                side: THREE.DoubleSide
            });
            const plane = new THREE.Mesh(geometry, material);
            plane.userData = { view: face.view, isFace: true };
            faceGroup.add(plane);

            // Create text label (white for contrast on gray)
            const textMesh = this.createTextLabel(face.label);
            textMesh.userData = { view: face.view, isFace: false };
            textMesh.position.z = 0.01;

            // Rotate text labels to be upright
            if (face.view === 'Right') {
                textMesh.rotation.z = Math.PI / 2; // 90 degrees
            } else if (face.view === 'Left') {
                textMesh.rotation.z = -Math.PI / 2; // -90 degrees (180 from Right)
            } else if (face.view === 'Bottom' || face.view === 'Back') {
                textMesh.rotation.z = Math.PI; // 180 degrees
            }

            faceGroup.add(textMesh);

            // Position and rotate face
            faceGroup.position.set(...face.position);
            faceGroup.rotation.set(...face.rotation);

            group.add(faceGroup);
        });

        // Add edge lines (dark gray from theme)
        const edgesGeometry = new THREE.BoxGeometry(size, size, size);
        const edges = new THREE.EdgesGeometry(edgesGeometry);
        const lineMaterial = new THREE.LineBasicMaterial({
            color: 0x2F373C,
            linewidth: 2
        });
        const wireframe = new THREE.LineSegments(edges, lineMaterial);
        group.add(wireframe);

        // Add corner spheres for isometric views (gray from theme)
        const cornerRadius = 0.2;
        const cornerDistance = size / 2;
        const corners = [
            { position: [cornerDistance, cornerDistance, cornerDistance], view: 'IsoTopRightFront' },
            { position: [-cornerDistance, cornerDistance, cornerDistance], view: 'IsoTopLeftFront' },
            { position: [cornerDistance, -cornerDistance, cornerDistance], view: 'IsoTopRightBack' },
            { position: [-cornerDistance, -cornerDistance, cornerDistance], view: 'IsoTopLeftBack' },
            { position: [cornerDistance, cornerDistance, -cornerDistance], view: 'IsoBottomRightFront' },
            { position: [-cornerDistance, cornerDistance, -cornerDistance], view: 'IsoBottomLeftFront' },
            { position: [cornerDistance, -cornerDistance, -cornerDistance], view: 'IsoBottomRightBack' },
            { position: [-cornerDistance, -cornerDistance, -cornerDistance], view: 'IsoBottomLeftBack' }
        ];

        corners.forEach(corner => {
            const sphereGeometry = new THREE.SphereGeometry(cornerRadius, 16, 16);
            const sphereMaterial = new THREE.MeshStandardMaterial({
                color: 0x6A6B6A, // Theme gray
                transparent: true,
                opacity: 0.7
            });
            const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
            sphere.position.set(...corner.position);
            sphere.userData = { view: corner.view, isCorner: true };
            group.add(sphere);
        });

        return group;
    }

    createTextLabel(text) {
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.width = 256;
        canvas.height = 256;

        context.fillStyle = '#ffffff';
        context.font = 'bold 62px Arial'; // Reduced slightly so BOTTOM fits
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(text, 128, 128);

        const texture = new THREE.CanvasTexture(canvas);

        // Use a flat plane instead of sprite
        const geometry = new THREE.PlaneGeometry(1.5, 1.5); // Larger for better visibility
        const material = new THREE.MeshBasicMaterial({
            map: texture,
            transparent: true,
            depthTest: false,
            side: THREE.DoubleSide
        });
        const mesh = new THREE.Mesh(geometry, material);

        return mesh;
    }

    onClick(event) {
        // Get click position relative to viewcube canvas
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        // Raycast to detect which face was clicked
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const intersects = this.raycaster.intersectObjects(this.cube.children, true);

        console.log('ViewCube clicked, intersects:', intersects.length);

        // Iterate through all intersections to find one with userData.view
        for (let i = 0; i < intersects.length; i++) {
            const clickedObject = intersects[i].object;
            console.log(`Intersection ${i}:`, clickedObject.userData);
            if (clickedObject.userData && clickedObject.userData.view) {
                console.log('Setting view to:', clickedObject.userData.view);
                this.setMainCameraView(clickedObject.userData.view);
                break;
            }
        }
    }

    onMouseMove(event) {
        // Get mouse position
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        // Raycast to detect hover
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const intersects = this.raycaster.intersectObjects(this.cube.children, true);

        // Reset all face and corner opacities
        this.cube.children.forEach(child => {
            if (child.children) {
                child.children.forEach(mesh => {
                    if (mesh.material && mesh.userData.isFace) {
                        mesh.material.opacity = 0.5;
                    }
                });
            } else if (child.material && child.userData.isCorner) {
                child.material.opacity = 0.6;
            }
        });

        // Find first valid intersection (face or corner) and highlight it
        for (let i = 0; i < intersects.length; i++) {
            const hoveredObject = intersects[i].object;
            if (hoveredObject.material && hoveredObject.userData) {
                if (hoveredObject.userData.isFace) {
                    hoveredObject.material.opacity = 1.0;
                    break;
                } else if (hoveredObject.userData.isCorner) {
                    hoveredObject.material.opacity = 1.0;
                    break;
                }
            }
        }
    }

    setMainCameraView(view) {
        const target = this.mainControls.target;
        const currentDistance = this.mainCamera.position.distanceTo(target);
        const dist = Math.max(currentDistance, 200);

        // Calculate target position and up vector based on view
        let targetPosition = new THREE.Vector3();
        let targetUp = new THREE.Vector3();

        switch (view) {
            case 'Front':
                targetPosition.set(target.x, target.y - dist, target.z);
                targetUp.set(0, 0, 1);
                break;
            case 'Back':
                targetPosition.set(target.x, target.y + dist, target.z);
                targetUp.set(0, 0, 1);
                break;
            case 'Top':
                targetPosition.set(target.x, target.y, target.z + dist);
                targetUp.set(0, 1, 0);
                break;
            case 'Bottom':
                targetPosition.set(target.x, target.y, target.z - dist);
                targetUp.set(0, -1, 0);
                break;
            case 'Right':
                targetPosition.set(target.x + dist, target.y, target.z);
                targetUp.set(0, 0, 1);
                break;
            case 'Left':
                targetPosition.set(target.x - dist, target.y, target.z);
                targetUp.set(0, 0, 1);
                break;
            // Isometric corner views
            case 'IsoTopRightFront':
                targetPosition.set(target.x + dist * 0.7, target.y + dist * 0.7, target.z + dist * 0.7);
                targetUp.set(0, 0, 1);
                break;
            case 'IsoTopLeftFront':
                targetPosition.set(target.x - dist * 0.7, target.y + dist * 0.7, target.z + dist * 0.7);
                targetUp.set(0, 0, 1);
                break;
            case 'IsoTopRightBack':
                targetPosition.set(target.x + dist * 0.7, target.y - dist * 0.7, target.z + dist * 0.7);
                targetUp.set(0, 0, 1);
                break;
            case 'IsoTopLeftBack':
                targetPosition.set(target.x - dist * 0.7, target.y - dist * 0.7, target.z + dist * 0.7);
                targetUp.set(0, 0, 1);
                break;
            case 'IsoBottomRightFront':
                targetPosition.set(target.x + dist * 0.7, target.y + dist * 0.7, target.z - dist * 0.7);
                targetUp.set(0, 0, 1);
                break;
            case 'IsoBottomLeftFront':
                targetPosition.set(target.x - dist * 0.7, target.y + dist * 0.7, target.z - dist * 0.7);
                targetUp.set(0, 0, 1);
                break;
            case 'IsoBottomRightBack':
                targetPosition.set(target.x + dist * 0.7, target.y - dist * 0.7, target.z - dist * 0.7);
                targetUp.set(0, 0, 1);
                break;
            case 'IsoBottomLeftBack':
                targetPosition.set(target.x - dist * 0.7, target.y - dist * 0.7, target.z - dist * 0.7);
                targetUp.set(0, 0, 1);
                break;
        }

        // Animate camera to target position
        this.animateCamera(targetPosition, targetUp);
    }

    animateCamera(targetPosition, targetUp) {
        const startPosition = this.mainCamera.position.clone();
        const startUp = this.mainCamera.up.clone();
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
            this.mainCamera.position.lerpVectors(startPosition, targetPosition, eased);

            // Interpolate up vector
            this.mainCamera.up.lerpVectors(startUp, targetUp, eased);

            this.mainControls.update();

            if (progress < 1) {
                requestAnimationFrame(animate);
            }
        };

        animate();
    }

    updateCamera(newCamera, newControls) {
        this.mainCamera = newCamera;
        this.mainControls = newControls;
    }

    animate() {
        requestAnimationFrame(() => this.animate());

        // Sync cube rotation with main camera
        // Extract rotation from main camera's view matrix
        const matrix = new THREE.Matrix4();
        matrix.extractRotation(this.mainCamera.matrixWorldInverse);

        // Apply inverse rotation to cube so it rotates opposite to camera
        this.cube.rotation.setFromRotationMatrix(matrix);

        this.renderer.render(this.scene, this.camera);
    }

    dispose() {
        this.renderer.domElement.removeEventListener('click', this.onClick.bind(this));
        this.renderer.domElement.removeEventListener('mousemove', this.onMouseMove.bind(this));
        this.container.removeChild(this.renderer.domElement);
        this.renderer.dispose();
    }
}
