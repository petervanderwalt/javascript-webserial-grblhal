(function () {
    'use strict';

    // --- APPLICATION STATE ---
    let toolpaths = [];
    let selectedObjects = [];
    let activeToolpathIndex = -1;
    let currentFileObject = null; // THREE.Group containing the original vector geometry

    // --- MODULE INITIALIZATION ---
    // These classes are available globally because they were loaded via <script> tags in cam.html
    const renderer = new Renderer('viewer-container');
    const ui = new UI();
    const fileParser = new FileParser();
    const toolpathManager = new ToolpathManager();

    // --- EVENT LISTENERS ---
    document.addEventListener('DOMContentLoaded', init);

    function init() {
        // Initial UI setup
        ui.renderToolpathList(toolpaths, activeToolpathIndex);

        // File input
        ui.fileInput.addEventListener('change', handleFileSelect);

        // 3D Viewer Clicks
        renderer.getDomElement().addEventListener('click', handleCanvasClick);

        // UI Button Clicks
        ui.addToolpathBtn.addEventListener('click', handleAddToolpath);
        ui.generatePreviewBtn.addEventListener('click', handleGeneratePreviews);
        ui.generateGcodeBtn.addEventListener('click', handleGcodeGeneration);

        // Make setActiveToolpath globally accessible for the inline onclick attributes in the UI
        window.setActiveToolpath = handleSetActiveToolpath;
    }

    // --- EVENT HANDLERS ---

    async function handleFileSelect(event) {
        const file = event.target.files[0];
        if (!file) return;

        ui.showLoading("Parsing File...");
        renderer.clearScene();
        toolpaths = [];
        selectedObjects = [];
        activeToolpathIndex = -1;
        ui.renderToolpathList(toolpaths, activeToolpathIndex);
        ui.hideToolpathEditor();

        ui.updateStatus(`Loading ${file.name}...`);
        try {
            currentFileObject = await fileParser.parse(file);
            renderer.addObject(currentFileObject);
            renderer.resetCameraToObject(currentFileObject);
            ui.updateStatus(`<strong>${file.name}</strong> loaded successfully.`);
        } catch (error) {
            console.error("Error processing file:", error);
            ui.updateStatus(`<span class="text-red-600 font-bold">Error: ${error.message}</span>`);
            renderer.clearScene();
        } finally {
            ui.hideLoading();
            ui.fileInput.value = ''; // Reset input
        }
    }

    function handleCanvasClick(event) {
        if (!currentFileObject) return;
        const intersects = renderer.raycast(event, currentFileObject.children);

        if (intersects.length > 0) {
            const clickedObject = intersects[0].object;
            if (!event.ctrlKey) {
                clearSelection();
            }
            toggleSelection(clickedObject);
        } else {
            if (!event.ctrlKey) clearSelection();
        }
    }

    function handleAddToolpath() {
        activeToolpathIndex = toolpathManager.addToolpath(toolpaths);
        ui.renderToolpathList(toolpaths, activeToolpathIndex);
        ui.renderToolpathEditor(toolpaths[activeToolpathIndex], handleToolpathUpdate, handleAddGeometries);
    }

    function handleSetActiveToolpath(index) {
        activeToolpathIndex = index;
        ui.renderToolpathList(toolpaths, activeToolpathIndex);
        ui.renderToolpathEditor(toolpaths[activeToolpathIndex], handleToolpathUpdate, handleAddGeometries);
    }

    function handleToolpathUpdate(key, value) {
        if (activeToolpathIndex > -1) {
            toolpathManager.updateToolpath(toolpaths[activeToolpathIndex], key, value);
        }
    }

    function handleAddGeometries() {
        if (activeToolpathIndex > -1) {
            toolpathManager.addGeometries(toolpaths[activeToolpathIndex], selectedObjects);
            ui.renderToolpathList(toolpaths, activeToolpathIndex);
            clearSelection();
        }
    }

    async function handleGeneratePreviews() {
        if (toolpaths.length === 0) return;
        ui.showLoading("Generating Previews...");

        // Clear any old previews from the scene
        toolpaths.forEach(tp => {
            if (tp.previewObject) renderer.removeObject(tp.previewObject);
        });

        try {
            await toolpathManager.generateAllPreviews(toolpaths, renderer.getScene());
            ui.updateGcodeButtons(true);
        } catch (error) {
            console.error("Error generating previews:", error);
            ui.updateStatus(`<span class="text-red-600 font-bold">Preview generation failed.</span>`);
        } finally {
            ui.hideLoading();
        }
    }

    function handleGcodeGeneration() {
        ui.showLoading("Generating G-Code...");
        try {
            const finalGcode = toolpathManager.generateAllGcode(toolpaths);
            ui.displayGcode(finalGcode);
        } catch (error) {
            console.error("Error generating G-Code:", error);
            ui.updateStatus(`<span class="text-red-600 font-bold">G-Code generation failed.</span>`);
        } finally {
            ui.hideLoading();
        }
    }

    // --- SELECTION LOGIC ---

    function toggleSelection(obj) {
        const index = selectedObjects.indexOf(obj);
        if (index > -1) {
            obj.material = renderer.defaultMaterial;
            selectedObjects.splice(index, 1);
        } else {
            obj.material = renderer.selectedMaterial.clone();
            selectedObjects.push(obj);
        }
    }

    function clearSelection() {
        selectedObjects.forEach(obj => {
            if (!isObjectInAnyPreview(obj)) {
                obj.material = renderer.defaultMaterial;
            }
        });
        selectedObjects = [];
    }

    function isObjectInAnyPreview(obj) {
        return toolpaths.some(tp =>
            tp.previewObject && tp.previewObject.children.includes(obj)
        );
    }

})();
