(function () {
    'use strict';

    class ToolpathManager {
        constructor() {
            // Assumes GCodeGenerator is loaded globally
            this.gcodeGenerator = new GCodeGenerator();
            this.worker = null;
        }

        addToolpath(toolpaths) {
            const newToolpath = {
                uuid: THREE.MathUtils.generateUUID(),
                name: `Toolpath ${toolpaths.length + 1}`,
                geometries: [], // Stores UUIDs of original vector objects
                sourceObject: null,
                previewObject: null, // Holds the "pretty preview" THREE.Group
                inflated: null,      // Holds the simple line geometry for G-code generation
                gcode: null,
                // Default CAM Parameters from your original code
                camOperation: "CNC: Vector (path outside)",
                camToolDia: 3.175,
                camFeedrate: 1000,
                camPlungerate: 200,
                camZStep: 1,
                camZDepth: 3,
                camZStart: 0,
                camStepover: 100,
            };
            toolpaths.push(newToolpath);
            return toolpaths.length - 1;
        }

        updateToolpath(toolpath, key, value) {
            if (toolpath && toolpath.hasOwnProperty(key)) {
                toolpath[key] = value;
            }
        }

        addGeometries(toolpath, selectedObjects) {
            const newGeometries = selectedObjects.map(obj => obj.uuid);
            toolpath.geometries = [...new Set([...toolpath.geometries, ...newGeometries])];
        }

        _buildSourceObject(toolpath, scene) {
            const sourceGroup = new THREE.Group();
            toolpath.geometries.forEach(uuid => {
                const originalObject = scene.getObjectByProperty('uuid', uuid);
                if (originalObject) {
                    sourceGroup.add(originalObject.clone());
                }
            });
            toolpath.sourceObject = sourceGroup;
        }

        generateAllPreviews(toolpaths, scene) {
            this.worker = new Worker('cam-worker.js');

            const promises = toolpaths.map((tp, index) => new Promise((resolve, reject) => {
                this._buildSourceObject(tp, scene);

                if (!tp.sourceObject || tp.sourceObject.children.length === 0) {
                    return resolve();
                }

                // Add CAM parameters to the userData of the object sent to the worker
                Object.assign(tp.sourceObject.userData, {
                    camOperation: tp.camOperation,
                    camToolDia: tp.camToolDia,
                    camStepover: tp.camStepover,
                    camZStart: tp.camZStart,
                    camZStep: tp.camZStep,
                    camZDepth: tp.camZDepth
                });

                const dataToProcess = {
                    toolpath: JSON.stringify(tp.sourceObject.toJSON()),
                    index: index,
                    // Pass userData separately for clarity, matching your original worker's expectation
                    userData: tp.sourceObject.userData
                };

                this.worker.postMessage({ data: dataToProcess });

                const messageHandler = (e) => {
                    if (e.data.index === index) {
                        this.worker.removeEventListener('message', messageHandler);

                        if (e.data.error) {
                            return reject(new Error(e.data.error));
                        }

                        const loader = new THREE.ObjectLoader();
                        const fullProcessedObject = loader.parse(JSON.parse(e.data.toolpath));

                        // Your worker returns a complex object. We need to handle it.
                        // The 'inflated' property holds the lines for G-code.
                        // The 'pretty' property on 'inflated' holds the preview mesh.
                        tp.inflated = fullProcessedObject.userData.inflated;

                        if (tp.inflated && tp.inflated.userData.pretty) {
                            tp.previewObject = tp.inflated.userData.pretty;
                            scene.add(tp.previewObject);
                        } else {
                            // Fallback to showing the simple lines if no pretty preview was generated
                            tp.previewObject = tp.inflated;
                            scene.add(tp.previewObject);
                        }

                        resolve();
                    }
                };
                this.worker.addEventListener('message', messageHandler);
            }));

            return Promise.all(promises).finally(() => {
                if (this.worker) {
                    this.worker.terminate();
                    this.worker = null;
                }
            });
        }

        generateAllGcode(toolpaths) {
            let finalGcode = "";
            toolpaths.forEach((tp, index) => {
                if (tp.inflated) {
                    tp.gcode = this.gcodeGenerator.generate(index, tp);
                    finalGcode += tp.gcode;
                }
            });
            return finalGcode;
        }
    }

    // Attach the class to the global window object
    window.ToolpathManager = ToolpathManager;

})();
