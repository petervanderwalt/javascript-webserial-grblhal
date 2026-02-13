

// This is a simplified and updated version of http://gcode.joewalters.com/
// Updated with code from http://chilipeppr.com/tinyg's 3D viewer to support more CNC type Gcode
// Simplified by Andrew Hodel in 2015
// Updated by Pvdw in 2016 for LaserWeb3

// Import Three.js ES Module directly from CDN for the worker
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js';

let lastLine = {
  x: 0,
  y: 0,
  z: 0,
  a: 0,
  e: 0,
  f: 0,
  s: 0, // Added S (spindle speed) for lastLine tracking, if needed
  feedrate: null,
  extruding: false,
  tool: null // Initialize tool as null
};

function GCodeParser(handlers, modecmdhandlers) {
  this.handlers = handlers || {};
  this.modecmdhandlers = modecmdhandlers || {};

  this.lastArgs = {
    cmd: null
  };
  this.lastFeedrate = null;
  this.isUnitsMm = true;
  this.currentTool = null; // Add this to GCodeParser instance to track active tool

  this.parseLine = function (text, info) {
    // console.log("LINE: " + text)
    var origtext = text;
    // remove line numbers if exist
    if (text.match(/^N/i)) {
      // yes, there's a line num
      text = text.replace(/^N\d+\s*/ig, "");
    }

    // collapse leading zero g cmds to no leading zero
    text = text.replace(/G00/i, 'G0');
    text = text.replace(/G0(\d)/i, 'G$1');
    // add spaces before g cmds and xyzabcijkf params
    text = text.replace(/([gmtxyzabcijkfst])/ig, " $1");
    // remove spaces after xyzabcijkf params because a number should be directly after them
    text = text.replace(/([xyzabcijkfst])\s+/ig, "$1");
    // remove front and trailing space
    text = text.trim();

    // see if comment
    var isComment = false;
    if (text.match(/^(;|\(|<)/)) {
      text = origtext;
      isComment = true;
    } else {
      // make sure to remove inline comments
      text = text.replace(/\(.*?\)/g, "");
    }
    //console.log("gcode txt:", text);

    if (text && !isComment) {
      text = text.replace(/(;|\().*$/, ""); // ; or () trailing  // strip off end of line comment
      var tokens = [];

      // Pre-parse for T commands to set currentTool before main command handling
      // This is important because M6 might refer to the tool set by T on the same line
      const tMatch = text.match(/T(\d+)/i);
      if (tMatch) {
        this.currentTool = parseInt(tMatch[1]);
        // console.log(`Worker: Pre-parsed T command. Current tool set to: ${this.currentTool}`);
      }

      text.split(/\s+/).forEach(function (token) {
        var modehandler = modecmdhandlers[token.toUpperCase()];
        if (modehandler) {
          // Pass `this` (the parser instance) to modecmdhandlers if they need it
          modehandler(token, info, this);
        } else {
          tokens.push(token);
        }
      }.bind(this)); // Bind 'this' to access currentTool in the forEach

      if (tokens.length) {
        var cmd = tokens[0];
        cmd = cmd.toUpperCase();
        // check if a g or m cmd was included in gcode line
        // you are allowed to just specify coords on a line
        // and it should be assumed that the last specified gcode
        // cmd is what's assumed
        isComment = false;
        if (!cmd.match(/^(G|M|T|S)/i)) {
          cmd = this.lastArgs.cmd;
          tokens.unshift(cmd); // put at spot 0 in array
        } else {
          // we have a normal cmd as opposed to just an xyz pos where
          // it assumes you should use the last cmd
          // however, need to remove inline comments (TODO. it seems parser works fine for now)
        }
        var args = {
          'cmd': cmd,
          'text': text,
          'origtext': origtext,
          'indx': info,
          'isComment': isComment,
          'feedrate': null,
          'tool': this.currentTool // Pass the current active tool to args
        };
        // console.log("args:", args);
        if (tokens.length > 1 && !isComment) {
          tokens.splice(1).forEach(function (token) {
            //console.log("token:", token);
            if (token && token.length > 0) {
              var key = token[0].toLowerCase();
              var value = parseFloat(token.substring(1));
              args[key] = value;
            } else {
              //console.log("couldn't parse token in foreach. weird:", token);
            }
          });
        }
        var handler = this.handlers[cmd] || this.handlers['default'];
        // don't save if saw a comment
        if (!args.isComment) {
          this.lastArgs = args;
          //console.log("just saved lastArgs for next use:", this.lastArgs);
        } else {
          //console.log("this was a comment, so didn't save lastArgs");
        }
        //console.log("calling handler: cmd:", cmd, "args:", args, "info:", info);
        if (handler) {
          // scan for feedrate
          if (args.text.match(/F([\d.]+)/i)) {
            // we have a new feedrate
            var feedrate = parseFloat(RegExp.$1);
            args.feedrate = feedrate;
            this.lastFeedrate = feedrate;
          } else {
            // use feedrate from prior lines
            args.feedrate = this.lastFeedrate;
          }

          if (args.text.match(/S([\d.]+)/i)) {
            // we have a new S-Value
            var svalue = parseFloat(RegExp.$1);
            args.svalue = svalue;
            this.lastsvalue = svalue;
          } else {
            // use feedrate from prior lines
            args.svalue = this.lastsvalue;
          }

          // The T command itself
          if (args.text.match(/T(\d+)/i)) {
            // console.log("Worker: Explicit T command. Updating current tool to:", parseInt(RegExp.$1));
            this.currentTool = parseInt(RegExp.$1);
          }
          // Ensure args.tool is always the current tool for segments
          args.tool = this.currentTool;


          //console.log("about to call handler. args:", args, "info:", info, "this:", this);
          return handler(args, info, this); // Pass parser instance (this) as gcp
        } else {
          console.error("No handler for gcode command!!!", cmd);
        }

      }
    } else {
      // it was a comment or the line was empty
      // we still need to create a segment with xyz in p2
      // so that when we're being asked to /gotoline we have a position
      // for each gcode line, even comments. we just use the last real position
      // to give each gcode line (even a blank line) a spot to go to
      var args = {
        'cmd': 'empty or comment',
        'text': text,
        'origtext': origtext,
        'indx': info,
        'isComment': isComment,
        'tool': this.currentTool // Pass the current active tool for comments/empty lines
      };
      var handler = this.handlers['default'];
      return handler(args, info, this);
    }
  };

  this.parse = function (gcode) {
    // console.log(gcode)

    var lines = gcode.split(/\r{0,1}\n/);
    // var lines = gcode

    for (var i = 0; i < lines.length; i++) {

      if (i % 10 === 0) {
        var progress = ((i / lines.length) * 100).toFixed(0);
        self.postMessage({
          progress: progress,
        });
      }

      if (this.parseLine(lines[i], i) === false) {
        break;
      }
    }

  };
} // end GCodeParser


const colorG0 = 0x00cc00; // Rapid moves
const colorG1 = 0xcc0000; // Linear moves (default color if no tool specified)
const colorG2 = 0x0000cc; // Arc moves (default color if no tool specified)

const bins = [
  0, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
  25, 50, 100, 250, 500, 1000, Infinity
];

function sortSegmentIntoBin(length) {
  if (length < 0.01) return 0;
  if (length < 0.05) return 1;
  if (length < 0.1) return 2;
  if (length < 0.25) return 3;
  if (length < 0.5) return 4;
  if (length < 1) return 5;
  if (length < 2.5) return 6;
  if (length < 5) return 7;
  if (length < 10) return 8;
  if (length < 25) return 9;
  if (length < 50) return 10;
  if (length < 100) return 11;
  if (length < 250) return 12;
  if (length < 500) return 13;
  if (length < 1000) return 14;
  return 15; // > 1000mm
}



function createObjectFromGCode(gcode) {

  // Reset Starting Point
  let lastLine = {
    x: 0,
    y: 0,
    z: 0,
    a: 0,
    e: 0,
    f: 0,
    s: 0,
    feedrate: null,
    extruding: false,
    tool: null // Initialize tool for lastLine
  };
  var isUnitsMm = true;
  var totalDist = 0;
  var totalTime = 0;

  var segmentLengthStats = new Array(16).fill(0); // Corrected to 16 for all bins


  function setUnits(units) {
    if (units == "mm")
      isUnitsMm = true;
    else
      isUnitsMm = false;
    onUnitsChanged();
  }

  function onUnitsChanged() {
    //console.log("onUnitsChanged");
    // we need to publish back the units
    var units = "mm";
    if (!isUnitsMm) units = "inch";
    // $('.com-chilipeppr-widget-3dviewer-units-indicator').text(units);
    // console.log("USING UNITS:" + units)
  }

  // THESE are extra Object3D elements added during
  // the gcode rendering to attach to scene
  // CRITICAL FIX: Changed from `[]` to `{}` so non-numeric properties are preserved by JSON.stringify
  // Now store raw data for extra objects, not THREE.Objects
  const extraObjects = {};
  extraObjects.G17 = []; // Arcs in XY plane
  extraObjects.G18 = []; // Arcs in XZ plane
  extraObjects.G19 = []; // Arcs in YZ plane
  extraObjects.M_codes = []; // For M3, M4, M5, M6 etc points

  const offsetG92 = {
    x: 0,
    y: 0,
    z: 0,
    e: 0
  };
  setUnits("mm");


  // we have been using an approach where we just append
  // each gcode move to one monolithic geometry. we
  // are moving away from that idea and instead making each
  // gcode move be it's own full-fledged line object with
  // its own userData info
  // G2/G3 moves are their own child of lots of lines so
  // that even the simulator can follow along better
  let linePoints = [];
  totalDist = 0;
  let relative = false;

  // Modified drawArc to return data, not a THREE.Object
  function drawArc(aX, aY, aZ, endaZ, aRadius, aStartAngle, aEndAngle, aClockwise, plane, tool) { // Add tool parameter
    var ac = new THREE.ArcCurve(aX, aY, aRadius, aStartAngle, aEndAngle, aClockwise);
    let z = aZ;
    const positions = []; // Store only positions

    ac.getPoints(20).forEach((v, i) => {
      z = (((endaZ - aZ) / 20) * i) + aZ;
      positions.push(v.x, v.y, z);
    });

    return {
      positions: positions,
      gcodeType: 2, // Indicate it's an arc
      tool: tool,
      plane: plane // Keep plane info for debugging/categorization
    };
  }

  // Modified drawArcFrom2PtsAndCenter to pass tool and expect data back
  function drawArcFrom2PtsAndCenter(vp1, vp2, vpArc, args, tool) { // Add tool parameter
    var p1deltaX = vpArc.x - vp1.x;
    var p1deltaY = vpArc.y - vp1.y;
    var p1deltaZ = vpArc.z - vp1.z;

    var p2deltaX = vpArc.x - vp2.x;
    var p2deltaY = vpArc.y - vp2.y;
    var p2deltaZ = vpArc.z - vp2.z;

    // REVERTED: Restored original Math.atan for angle calculation
    switch (args.plane) {
      case "G18":
        var anglepArcp1 = Math.atan(p1deltaZ / p1deltaX);
        var anglepArcp2 = Math.atan(p2deltaZ / p2deltaX);
        break;
      case "G19":
        var anglepArcp1 = Math.atan(p1deltaZ / p1deltaY);
        var anglepArcp2 = Math.atan(p2deltaZ / p2deltaY);
        break;
      default: // G17
        var anglepArcp1 = Math.atan(p1deltaY / p1deltaX);
        var anglepArcp2 = Math.atan(p2deltaY / p2deltaX);
    }

    var radius = vpArc.distanceTo(vp1);

    var clwise = true;
    if (args.clockwise === false) clwise = false;

    // REINSTATED: Original Math.PI adjustments for atan
    switch (args.plane) {
      case "G19":
        if (p1deltaY >= 0) anglepArcp1 += Math.PI;
        if (p2deltaY >= 0) anglepArcp2 += Math.PI;
        break;
      default: // G17 and G18
        if (p1deltaX >= 0) anglepArcp1 += Math.PI;
        if (p2deltaX >= 0) anglepArcp2 += Math.PI;
    }

    let arcData; // Will store the raw data for the arc

    if (anglepArcp1 === anglepArcp2)
      // Draw full circle if angles are both zero,
      // start & end points are same point... I think
      switch (args.plane) {
        case "G18":
          arcData = drawArc(vpArc.x, vpArc.z, (-1 * vp1.y), (-1 * vp2.y), radius, anglepArcp1, (anglepArcp2 + (2 * Math.PI)), clwise, "G18", tool); // Pass tool
          break;
        case "G19":
          arcData = drawArc(vpArc.y, vpArc.z, vp1.x, vp2.x, radius, anglepArcp1, (anglepArcp2 + (2 * Math.PI)), clwise, "G19", tool); // Pass tool
          break;
        default:
          arcData = drawArc(vpArc.x, vpArc.y, vp1.z, vp2.z, radius, anglepArcp1, (anglepArcp2 + (2 * Math.PI)), clwise, "G17", tool); // Pass tool
      }
    else
      switch (args.plane) {
        case "G18":
          arcData = drawArc(vpArc.x, vpArc.z, (-1 * vp1.y), (-1 * vp2.y), radius, anglepArcp1, anglepArcp2, clwise, "G18", tool); // Pass tool
          break;
        case "G19":
          arcData = drawArc(vpArc.y, vpArc.z, vp1.x, vp2.x, radius, anglepArcp1, anglepArcp2, clwise, "G19", tool); // Pass tool
          break;
        default:
          arcData = drawArc(vpArc.x, vpArc.y, vp1.z, vp2.z, radius, anglepArcp1, anglepArcp2, clwise, "G17", tool); // Pass tool
      }
    return arcData; // Return the raw arc data
  }

  function addSegment(p1, p2, args) {

    // Ensure p2 has the tool information from args, which was populated by the parser
    p2.tool = args.tool;
    p1.tool = lastLine.tool; // Ensure p1 also has the correct tool from previous line

    if (p2.arc) {
      var vp1 = new THREE.Vector3(p1.x, p1.y, p1.z);
      var vp2 = new THREE.Vector3(p2.x, p2.y, p2.z);
      var vpArc;
      var radius;

      if (args.r != null) {
        radius = parseFloat(args.r);
        var q = Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2) + Math.pow(p2.z - p1.z, 2));
        var x3 = (p1.x + p2.x) / 2;
        var y3 = (p1.y + p2.y) / 2;
        var z3 = (p1.z + p2.z) / 2;
        var calc = Math.sqrt((radius * radius) - Math.pow(q / 2, 2));
        if (isNaN(calc)) {
          calc = 0.0;
        }

        var pArc_1 = undefined;
        var pArc_2 = undefined;

        switch (args.plane) {
          case "G18":
            pArc_1 = {
              x: x3 + calc * (p1.z - p2.z) / q,
              y: y3 + calc * (p2.y - p1.y) / q,
              z: z3 + calc * (p2.x - p1.x) / q
            };
            pArc_2 = {
              x: x3 - calc * (p1.z - p2.z) / q,
              y: y3 - calc * (p2.y - p1.y) / q,
              z: z3 - calc * (p2.x - p1.x) / q
            };
            if (((p1.x - pArc_1.x) * (p1.z + pArc_1.z)) + ((pArc_1.x - p2.x) * (pArc_1.z + p2.z)) >=
              ((p1.x - pArc_2.x) * (p1.z + pArc_2.z)) + ((pArc_2.x - p2.x) * (pArc_2.z + p2.z))) {
              var cw = pArc_1;
              var ccw = pArc_2;
            } else {
              var cw = pArc_2;
              var ccw = pArc_1;
            }
            break;
          case "G19":
            pArc_1 = {
              x: x3 + calc * (p1.x - p2.x) / q,
              y: y3 + calc * (p1.z - p2.z) / q,
              z: z3 + calc * (p2.y - p1.y) / q
            };
            pArc_2 = {
              x: x3 - calc * (p1.x - p2.x) / q,
              y: y3 - calc * (p1.z - p2.z) / q,
              z: z3 - calc * (p2.y - p1.y) / q
            };

            if (((p1.y - pArc_1.y) * (p1.z + pArc_1.z)) + ((pArc_1.y - p2.y) * (pArc_1.z + p2.z)) >=
              ((p1.y - pArc_2.y) * (p1.z + pArc_2.z)) + ((pArc_2.y - p2.y) * (pArc_2.z + p2.z))) {
              var cw = pArc_1;
              var ccw = pArc_2;
            } else {
              var cw = pArc_2;
              var ccw = pArc_1;
            }
            break;
          default:
            pArc_1 = {
              x: x3 + calc * (p1.y - p2.y) / q,
              y: y3 + calc * (p2.x - p1.x) / q,
              z: z3 + calc * (p2.z - p1.z) / q
            };
            pArc_2 = {
              x: x3 - calc * (p1.y - p2.y) / q,
              y: y3 - calc * (p2.x - p1.x) / q,
              z: z3 - calc * (p2.z - p1.z) / q
            };
            if (((p1.x - pArc_1.x) * (p1.y + pArc_1.y)) + ((pArc_1.x - p2.x) * (pArc_1.y + p2.y)) >=
              ((p1.x - pArc_2.x) * (p1.y + pArc_2.y)) + ((pArc_2.x - p2.x) * (pArc_2.y + p2.y))) {
              var cw = pArc_1;
              var ccw = pArc_2;
            } else {
              var cw = pArc_2;
              var ccw = pArc_1;
            }
        }

        if ((p2.clockwise === true && radius >= 0) || (p2.clockwise === false && radius < 0)) vpArc = new THREE.Vector3(cw.x, cw.y, cw.z);
        else vpArc = new THREE.Vector3(ccw.x, ccw.y, ccw.z);

      } else {
        var pArc = {
          x: p2.arci,
          y: p2.arcj,
          z: p2.arck,
        };
        vpArc = new THREE.Vector3(pArc.x, pArc.y, pArc.z);
      }

      const arcData = drawArcFrom2PtsAndCenter(vp1, vp2, vpArc, args, args.tool); // Get raw arc data
      extraObjects[arcData.plane].push(arcData); // Store the raw arc data in extraObjects

      // Calculate distance for arc for stats
      const arcPositions = arcData.positions;
      let arcDist = 0;
      for (let i = 0; i < arcPositions.length - 3; i += 3) {
        const x1 = arcPositions[i], y1 = arcPositions[i + 1], z1 = arcPositions[i + 2];
        const x2 = arcPositions[i + 3], y2 = arcPositions[i + 4], z2 = arcPositions[i + 5];
        const dx = x2 - x1;
        const dy = y2 - y1;
        const dz = z2 - z1;
        arcDist += Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
      if (arcDist > 0) {
        totalDist += arcDist;
        const segmentLengthbinIndex = sortSegmentIntoBin(arcDist);
        segmentLengthStats[segmentLengthbinIndex]++;
      }

      // Add to linePoints for arc simulation / detailed view
      for (let i = 0; i < arcPositions.length; i += 3) {
        const timeMinutes = (arcDist / arcPositions.length * 3 / (args.feedrate || 1000)) * 1.32; // Estimate time for small arc segment
        totalTime += timeMinutes;
        linePoints.push({
          src: 'arc_segment',
          x: arcPositions[i],
          y: arcPositions[i + 1],
          z: arcPositions[i + 2],
          a: p2.a,
          g: 2, // G-type for arc
          timeMins: timeMinutes,
          distSum: totalDist,
          timeMinsSum: totalTime,
          tool: p2.tool,
          line: p2.line // Pass line number
        });
      }

    } else { // Not an arc, just a straight line segment (G0 or G1)
      var a = new THREE.Vector3(p1.x, p1.y, p1.z);
      var b = new THREE.Vector3(p2.x, p2.y, p2.z);
      const dist = a.distanceTo(b);

      if (dist > 0) {
        totalDist += dist;
        const segmentLengthbinIndex = sortSegmentIntoBin(dist);
        segmentLengthStats[segmentLengthbinIndex]++;
      }

      var timeMinutes = 0;
      if (dist > 0) {
        var fr;
        if (args.feedrate > 0) {
          fr = args.feedrate
        } else {
          fr = 100;
        }
        timeMinutes = dist / fr;
        timeMinutes = timeMinutes * 1.32;
      }
      totalTime += timeMinutes;

      p2.feedrate = args.feedrate;
      p2.dist = dist;
      p2.distSum = totalDist;
      p2.timeMins = timeMinutes;
      p2.timeMinsSum = totalTime;

      let g = 1; // Default to G1 if not G0
      if (p2.g0) {
        g = 0
      }
      // G2/G3 are handled in the arc branch, so we only need G0 and G1 here.

      linePoints.push({
        timeMins: timeMinutes,
        src: 'line_segment',
        x: p2.x,
        y: p2.y,
        z: p2.z,
        a: p2.a,
        g: g,
        tool: p2.tool,
        line: p2.line // Pass line number
      });
    }
  }

  function delta(v1, v2) {
    return relative ? v2 : v2 - v1;
  }

  function absolute(v1, v2) {
    return relative ? v1 + v2 : v2;
  }

  var ijkrelative = true; // For Mach3 Arc IJK Absolute mode
  function ijkabsolute(v1, v2) {
    return ijkrelative ? v1 + v2 : v2;
  }

  // `addFakeSegment` is used for non-motion commands (like comments, tool changes)
  // It just creates a point in linePoints so that the UI can still track line-by-line position
  function addFakeSegment(args, tool = null) {
    let g = -1; // Indicate a non-motion command
    if (lastLine.g0) { g = 0; }
    else if (lastLine.g1) { g = 1; }
    else if (lastLine.g2) { g = 2; }

    linePoints.push({
      src: 'fake_segment',
      x: lastLine.x,
      y: lastLine.y,
      z: lastLine.z,
      a: lastLine.a,
      g: g, // Use last known g-code type for fake segments for continuity
      fake: true,
      tool: tool || lastLine.tool // Use provided tool or lastLine's tool
    });

    // For M-code indicators, just store the position
    // M6 is handled separately to update lastLine.tool
    if (args.cmd && args.cmd.startsWith('M') && args.cmd !== 'M6') {
      extraObjects.M_codes.push({ x: lastLine.x, y: lastLine.y, z: lastLine.z, cmd: args.cmd });
    }
  }


  var parser = new GCodeParser({
    //set the g92 offsets for the parser - defaults to no offset
    /* When doing CNC, generally G0 just moves to a new location
    as fast as possible which means no milling or extruding is happening in G0.
    So, let's color it uniquely to indicate it's just a toolhead move. */
    G0: function (args, indx, gcp) {
      var newLine = {
        x: args.x !== undefined ? absolute(lastLine.x, args.x) + offsetG92.x : lastLine.x,
        y: args.y !== undefined ? absolute(lastLine.y, args.y) + offsetG92.y : lastLine.y,
        z: args.z !== undefined ? absolute(lastLine.z, args.z) + offsetG92.z : lastLine.z,
        a: args.a !== undefined ? absolute(lastLine.a, args.a) + offsetG92.a : lastLine.a,
        e: args.e !== undefined ? absolute(lastLine.e, args.e) + offsetG92.e : lastLine.e,
        f: args.f !== undefined ? absolute(lastLine.f, args.f) : lastLine.f,
        s: args.s !== undefined ? absolute(lastLine.s, args.s) : lastLine.s,
        tool: args.tool // Ensure tool is passed through args
      };
      newLine.g0 = true;
      addSegment(lastLine, newLine, args);
      lastLine = newLine;
    },
    G1: function (args, indx, gcp) {
      var newLine = {
        x: args.x !== undefined ? absolute(lastLine.x, args.x) + offsetG92.x : lastLine.x,
        y: args.y !== undefined ? absolute(lastLine.y, args.y) + offsetG92.y : lastLine.y,
        z: args.z !== undefined ? absolute(lastLine.z, args.z) + offsetG92.z : lastLine.z,
        a: args.a !== undefined ? absolute(lastLine.a, args.a) + offsetG92.a : lastLine.a,
        e: args.e !== undefined ? absolute(lastLine.e, args.e) + offsetG92.e : lastLine.e,
        f: args.f !== undefined ? absolute(lastLine.f, args.f) : lastLine.f,
        s: args.s !== undefined ? absolute(lastLine.s, args.s) : lastLine.s,
        tool: args.tool // Ensure tool is passed through args
      };
      newLine.g1 = true;
      addSegment(lastLine, newLine, args);
      lastLine = newLine;
    },
    G2: function (args, indx, gcp) {
      var newLine = {
        x: args.x !== undefined ? absolute(lastLine.x, args.x) + offsetG92.x : lastLine.x,
        y: args.y !== undefined ? absolute(lastLine.y, args.y) + offsetG92.y : lastLine.y,
        z: args.z !== undefined ? absolute(lastLine.z, args.z) + offsetG92.z : lastLine.z,
        a: args.a !== undefined ? absolute(lastLine.a, args.a) + offsetG92.a : lastLine.a,
        e: args.e !== undefined ? absolute(lastLine.e, args.e) + offsetG92.e : lastLine.e,
        f: args.f !== undefined ? absolute(lastLine.f, args.f) : lastLine.f,
        s: args.s !== undefined ? absolute(lastLine.s, args.s) : lastLine.s,
        arci: args.i !== undefined ? ijkabsolute(lastLine.x, args.i) : lastLine.x,
        arcj: args.j !== undefined ? ijkabsolute(lastLine.y, args.j) : lastLine.y,
        arck: args.k !== undefined ? ijkabsolute(lastLine.z, args.k) : lastLine.z,
        arcr: args.r ? args.r : null,
        tool: args.tool, // Ensure tool is passed through args
        line: args.indx // Capture line number
      };
      newLine.arc = true;
      newLine.clockwise = true;
      if (args.clockwise === false) {
        newLine.clockwise = false
      } else {
        newLine.clockwise = true
      }
      addSegment(lastLine, newLine, args);
      lastLine = newLine;
    },
    G3: function (args, indx, gcp) {
      args.arc = true;
      args.clockwise = false;
      gcp.handlers.G2(args, indx, gcp);
    },

    G73: function (args, indx, gcp) {
      // peck drilling. just treat as g1
      gcp.handlers.G1(args);
    },

    G92: function (args) { // E0
      var newLine = lastLine;

      offsetG92.x = (args.x !== undefined ? (args.x === 0 ? newLine.x : newLine.x - args.x) : 0);
      offsetG92.y = (args.y !== undefined ? (args.y === 0 ? newLine.y : newLine.y - args.y) : 0);
      offsetG92.z = (args.z !== undefined ? (args.z === 0 ? newLine.z : newLine.z - args.z) : 0);
      offsetG92.e = (args.e !== undefined ? (args.e === 0 ? newLine.e : newLine.e - args.e) : 0);

      addFakeSegment(args, args.tool); // Pass args.tool
    },
    M30: function (args) {
      addFakeSegment(args, args.tool); // Pass args.tool
    },
    // T commands update the current tool number but do not directly cause motion
    T: function (args, indx, gcp) {
      lastLine.tool = args.tool; // Update lastLine's tool
      addFakeSegment(args, args.tool); // Pass args.tool
    },

    'default': function (args, info) {
      addFakeSegment(args, args.tool); // Pass args.tool
    },
  },
    // Mode-setting non-motion commands, of which many may appear on one line
    // These take no arguments
    {
      G17: function () { },
      G18: function () { },
      G19: function () { },
      G20: function () { setUnits("inch"); },
      G21: function () { setUnits("mm"); },

      G40: function () { },
      G41: function () { },
      G42: function () { },
      G45: function () { },
      G46: function () { },
      G47: function () { },
      G48: function () { },
      G49: function () { },
      G54: function () { },
      G55: function () { },
      G56: function () { },
      G57: function () { },
      G58: function () { },
      G59: function () { },
      G61: function () { },
      G64: function () { },
      G69: function () { },

      G90: function () { relative = false; },
      'G90.1': function () { ijkrelative = false; },
      G91: function () { relative = true; },
      'G91.1': function () { ijkrelative = true; },

      // M-codes that are just recorded, not rendered as physical geometry segments
      M3: function (token, info, gcp) { extraObjects.M_codes.push({ x: lastLine.x, y: lastLine.y, z: lastLine.z, cmd: token }); },
      M4: function (token, info, gcp) { extraObjects.M_codes.push({ x: lastLine.x, y: lastLine.y, z: lastLine.z, cmd: token }); },
      M5: function (token, info, gcp) { extraObjects.M_codes.push({ x: lastLine.x, y: lastLine.y, z: lastLine.z, cmd: token }); },
      M6: function (token, info, gcp) { extraObjects.M_codes.push({ x: lastLine.x, y: lastLine.y, z: lastLine.z, cmd: token, tool: gcp.currentTool }); }, // Store tool with M6
      M7: function (token, info, gcp) { extraObjects.M_codes.push({ x: lastLine.x, y: lastLine.y, z: lastLine.z, cmd: token }); },
      M8: function (token, info, gcp) { extraObjects.M_codes.push({ x: lastLine.x, y: lastLine.y, z: lastLine.z, cmd: token }); },
      M09: function () { },
      M10: function () { },
      M11: function () { },
      M21: function () { },
      M22: function () { },
      M23: function () { },
      M24: function () { },
      M41: function () { },
      M42: function () { },
      M43: function () { },
      M44: function () { },
      M48: function () { },
      M49: function () { },
      M52: function () { },
      M60: function () { },
      M82: function () { },
      M84: function () { },
    });

  parser.parse(gcode);

  var data = {
    linePoints: linePoints,
    extraObjects: extraObjects, // Now contains raw data for arcs and M-code markers
    inch: false,
    totalDist: totalDist,
    totalTime: totalTime,
    segmentLengthStats: segmentLengthStats
  }

  if (!isUnitsMm) {
    data.inch = true;
  } else {
    data.inch = false;
  }

  return data;
} // end of createObjectFromGCode()




self.addEventListener('message', function (e) {
  // console.log("New message received by worker", e.data.data.length)
  var data = e.data;
  // console.log(data)
  var result = createObjectFromGCode(e.data.data)
  console.log(result)
  self.postMessage(JSON.stringify(result)); // Always stringify for consistency
}, false);
