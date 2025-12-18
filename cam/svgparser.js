// Create Parser object
var lwsvgparser = new SVGParser.Parser();

// Register the onTag callback
lwsvgparser.onTag(function(tag) {
  // console.log('onTag:', tag);
});

function svgtraverse(tag, callback) {
  callback(tag);
  var children = tag.children;
  for (var i = 0, l = children.length; i < l; i++) {
    svgtraverse(children[i], callback);
  }
};

function drawFile(name, tag, flip) {
  let editor = lwsvgparser.editor.name;
  let version = parseFloat(lwsvgparser.editor.version);

  if (lwsvgparser.tags.attrs["inkscape:version"] != undefined) {
    editor = "inkscape";
    version = parseFloat(lwsvgparser.tags.attrs["inkscape:version"]);
  }

  let resol = 96;
  if (editor == "inkscape") {
    if (version <= 0.91) { resol = 90; }
    else { resol = 96; }
  } else if (editor == "illustrator") {
    resol = 72;
  } else if (editor == "Opentype.js") {
    resol = 57;
  }

  console.log("File: " + name + " was created in " + editor + " version " + version + ". Setting import resolution to " + resol + "dpi");

  const scale = 1 / (resol / 25.4);
  const svgtagobject = new THREE.Group(); // Use Group instead of Object3D for modern consistency
  svgtagobject.name = name;

  svgtraverse(tag, function(child) {
    if (child.paths.length && child.paths[0].length) {
      var count = 0;
      child.getPaths().forEach(function(path) {
        count++;
        // Pass the document object from the parser to the drawing function
        const line = drawSVGLine(child, path, scale, flip, lwsvgparser.document);
        var layer = {
          label: child.layer || "unnamed layer"
        };
        line.userData.layer = layer;
        line.name = child.attrs.id || "path" + count;
        svgtagobject.add(line);
      });
    }
  });

  // This function should return the object, not add it to a global
  return svgtagobject;
}


// *** THIS FUNCTION HAS BEEN REWRITTEN FOR MODERN THREE.JS ***
function drawSVGLine(tag, path, scale, flip, document) {
    const points = [];
    path.points.forEach(function(point) {
        // The Y-flip and scaling logic is preserved from your original code
        const y = flip ? (point.y + document.height) : (-point.y + document.height);
        points.push(new THREE.Vector3(point.x, y, 0));
    });

    if (points.length < 2) {
        return new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
    }

    // Modern method: Create a BufferGeometry from the array of points
    const geometry = new THREE.BufferGeometry().setFromPoints(points);

    // Apply scaling directly to the geometry
    geometry.scale(scale, scale, 1);

    const material = createSVGLineMaterial(tag);

    return new THREE.Line(geometry, material);
}

function createSVGLineMaterial(tag) {
  var opacity = tag.getAttr('stroke-opacity', 1);
  var material = new THREE.LineBasicMaterial({
    color: createColor(
      tag.getAttr('stroke', tag.getAttr('fill', 'black'))
    )
  });

  material.depthWrite = false;
  material.depthTest = false;

  if (opacity < 1) {
    material.transparent = true;
    material.opacity = opacity;
  }

  return material;
}

function createSolidMaterial(tag) {
  var opacity = tag.getAttr('fill-opacity', 1);
  var material = new THREE.MeshBasicMaterial({
    color: createColor(tag.getAttr('fill', 'black')),
    side: THREE.DoubleSide
  });

  material.depthWrite = false;
  material.depthTest = false;

  if (opacity < 1) {
    material.transparent = true;
    material.opacity = opacity;
  }

  return material;
};

function drawShape(tag, path) {
  let shape = new THREE.Shape(path.outer.points);

  path.holes.forEach(function(hole) {
    shape.holes.push(new THREE.Path(hole.points));
  });

  var geometry = new THREE.ShapeGeometry(shape);
  var material = createSolidMaterial(tag);

  return new THREE.Mesh(geometry, material);
}

function createColor(color) {
  if (color === 'none') {
    color = 'black';
  }
  // THREE.Color can handle color names directly
  return new THREE.Color(color);
}
