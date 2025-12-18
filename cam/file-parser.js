(function () {
    'use strict';

    class FileParser {
        constructor() {
            // These are expected to be globally available from the <script> tags in cam.html
            this.dxfParser = new window.DxfParser();
            this.svgParser = window.lwsvgparser;
        }

        async parse(file) {
            const extension = file.name.split('.').pop().toLowerCase();

            if (extension === 'dxf') {
                const fileContent = await file.text();
                return this._interpretDxf(fileContent);
            } else if (extension === 'svg') {
                return this._interpretSvg(file);
            } else {
                throw new Error(`Unsupported file type: ${extension}`);
            }
        }

        // --- DXF INTERPRETATION ---

        _interpretDxf(fileContent) {
            const dxf = this.dxfParser.parseSync(fileContent);
            if (!dxf || !dxf.entities) return new THREE.Group();

            const polylines = this._processDxfEntities(dxf.entities, dxf.blocks, new THREE.Matrix4());

            const group = new THREE.Group();
            group.name = "dxf-vectors";
            polylines.forEach(poly => {
                if (poly.length < 2) return;
                const points = poly.map(p => new THREE.Vector3(p.x, p.y, 0));
                const geometry = new THREE.BufferGeometry().setFromPoints(points);
                // The material will be set by the renderer/selection logic later
                const line = new THREE.Line(geometry, new THREE.LineBasicMaterial());
                group.add(line);
            });
            return group;
        }

        _processDxfEntities(entities, blocks, parentMatrix) {
            const allPolylines = [];
            for (const entity of entities) {
                if (entity.type === 'INSERT') {
                    const block = blocks[entity.name];
                    if (!block || !block.entities) {
                        console.warn(`Skipping INSERT of missing or empty block: "${entity.name}"`);
                        continue;
                    }
                    const blockMatrix = new THREE.Matrix4().compose(
                        new THREE.Vector3(entity.position.x, entity.position.y, entity.position.z || 0),
                        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, (entity.rotation || 0) * Math.PI / 180)),
                        new THREE.Vector3(entity.xScale || 1, entity.yScale || 1, entity.zScale || 1)
                    ).premultiply(parentMatrix);
                    allPolylines.push(...this._processDxfEntities(block.entities, blocks, blockMatrix));
                } else {
                    const entityPolylines = this._processSingleDxfEntity(entity);
                    if (entityPolylines.length > 0) {
                        const transformed = entityPolylines.map(poly =>
                            poly.map(p => {
                                const vec = new THREE.Vector3(p.x, p.y, 0).applyMatrix4(parentMatrix);
                                return { x: vec.x, y: vec.y };
                            })
                        );
                        allPolylines.push(...transformed);
                    }
                }
            }
            return allPolylines;
        }

        _processSingleDxfEntity(entity) {
            let polylines = [];
            switch (entity.type) {
                case 'LINE':
                    polylines.push(entity.vertices.map(v => ({ x: v.x, y: v.y })));
                    break;
                case 'LWPOLYLINE':
                case 'POLYLINE':
                    const poly = [];
                    for (let i = 0; i < entity.vertices.length; i++) {
                        const v = entity.vertices[i];
                        poly.push({ x: v.x, y: v.y });
                        if (v.bulge) {
                            const endPoint = (i + 1 < entity.vertices.length) ? entity.vertices[i + 1] : entity.vertices[0];
                            poly.push(...this._getArcPointsFromBulge(v, endPoint, v.bulge).slice(1));
                        }
                    }
                    if (entity.shape) poly.push(poly[0]);
                    polylines.push(poly);
                    break;
                case 'CIRCLE':
                    polylines.push(this._tessellateArc(entity.center, entity.radius, 0, 360));
                    break;
                case 'ARC':
                    polylines.push(this._tessellateArc(entity.center, entity.radius, entity.startAngle, entity.endAngle));
                    break;
            }
            return polylines;
        }

        _getArcPointsFromBulge(p1, p2, bulge) {
            const p1Vec = new THREE.Vector2(p1.x, p1.y);
            const p2Vec = new THREE.Vector2(p2.x, p2.y);
            const angle = 4 * Math.atan(bulge);
            if (Math.abs(angle) < 1e-5) return [{ x: p1.x, y: p1.y }, { x: p2.x, y: p2.y }];

            const chord = p2Vec.distanceTo(p1Vec);
            const radius = Math.abs(chord / (2 * Math.sin(angle / 2)));
            if (radius === Infinity || radius === 0) return [{ x: p1.x, y: p1.y }, { x: p2.x, y: p2.y }];

            const midPoint = new THREE.Vector2().addVectors(p1Vec, p2Vec).multiplyScalar(0.5);
            const dir = new THREE.Vector2().subVectors(p2Vec, p1Vec).normalize();
            const perp = bulge > 0 ? new THREE.Vector2(-dir.y, dir.x) : new THREE.Vector2(dir.y, -dir.x);
            const centerDist = Math.sqrt(radius * radius - (chord / 2) * (chord / 2));
            const center = new THREE.Vector2().addVectors(midPoint, perp.multiplyScalar(centerDist));

            const startAngle = Math.atan2(p1Vec.y - center.y, p1Vec.x - center.x);
            const totalAngle = angle;
            const segments = Math.max(6, Math.ceil(Math.abs(totalAngle) / (Math.PI / 18)));
            const points = [];
            for (let i = 0; i <= segments; i++) {
                const t = i / segments;
                const ang = startAngle + t * totalAngle;
                points.push({ x: center.x + radius * Math.cos(ang), y: center.y + radius * Math.sin(ang) });
            }
            return points;
        }

        _tessellateArc(center, radius, startAngle, endAngle) {
            const points = [];
            let start = (startAngle || 0) * Math.PI / 180;
            let end = (endAngle === undefined ? 360 : endAngle) * Math.PI / 180;
            if (end < start) { end += 2 * Math.PI; }

            const totalAngle = end - start;
            const segments = Math.max(6, Math.ceil(Math.abs(totalAngle) / (Math.PI / 18)));
            for (let i = 0; i <= segments; i++) {
                const t = i / segments;
                const angle = start + t * totalAngle;
                points.push({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) });
            }
            return points;
        }


        // --- SVG INTERPRETATION (using your proven parser) ---

        async _interpretSvg(file) {
            await this.svgParser.loadFromFile(file);
            const tags = await this.svgParser.parse();

            // The drawFile function is part of your global svgparser.js script
            return window.drawFile(file.name, tags, false);
        }
    }

    // Attach the class to the global window object
    window.FileParser = FileParser;

})();
