(function () {
    'use strict';

    class GCodeGenerator {
        constructor() {
            // Default Z-safe height, can be configured later
            this.clearanceHeight = 5;
        }

        /**
         * Generates a G-code string for a single toolpath operation.
         * @param {number} index - The index of the toolpath for labeling.
         * @param {object} toolpath - The toolpath object containing parameters and inflated geometry.
         * @returns {string} The generated G-code for this operation.
         */
        generate(index, toolpath) {
            const {
                inflated,
                camOperation,
                camToolDia,
                camFeedrate,
                camPlungerate
            } = toolpath;

            if (!inflated || inflated.children.length === 0) {
                return `; Toolpath ${index + 1} (${camOperation}) - No geometry to process.\n`;
            }

            let g = `; Operation ${index + 1}: ${camOperation}\n`;
            g += `; Tool Diameter: ${camToolDia}mm\n`;

            let isAtClearanceHeight = false;
            let lastPosition = null;

            // Traverse the THREE.Group containing all the line segments of the toolpath preview
            inflated.children.forEach((child) => {
                if (child.isLine) {
                    const positions = child.geometry.attributes.position.array;
                    if (positions.length === 0) return;

                    // The start of a new line segment always requires a rapid move.
                    const startX = positions[0].toFixed(4);
                    const startY = positions[1].toFixed(4);
                    const startZ = positions[2].toFixed(4);

                    // Check if we need to move at all (avoids redundant moves for pockets)
                    if (!lastPosition || lastPosition.x !== startX || lastPosition.y !== startY) {
                        // 1. Retract to clearance height if not already there
                        if (!isAtClearanceHeight) {
                            g += `G0 Z${this.clearanceHeight}\n`;
                            isAtClearanceHeight = true;
                        }
                        // 2. Rapid move to the start XY of the segment
                        g += `G0 X${startX} Y${startY}\n`;
                    }

                    // 3. Plunge to the cutting Z-depth
                    g += `G1 Z${startZ} F${camPlungerate}\n`;
                    isAtClearanceHeight = false;

                    // 4. Process the rest of the points in the segment as feed moves
                    for (let i = 3; i < positions.length; i += 3) {
                        const x = positions[i].toFixed(4);
                        const y = positions[i + 1].toFixed(4);
                        // Z is constant for a given line segment in a pass
                        g += `G1 X${x} Y${y} F${camFeedrate}\n`;
                    }

                    // Update last known position
                    lastPosition = {
                        x: positions[positions.length - 3].toFixed(4),
                        y: positions[positions.length - 2].toFixed(4),
                    };
                }
            });

            // Retract to a safe height at the very end of the entire operation
            g += `G0 Z${this.clearanceHeight}\n\n`;

            return g;
        }
    }

    // Attach the class to the global window object
    window.GCodeGenerator = GCodeGenerator;

})();
