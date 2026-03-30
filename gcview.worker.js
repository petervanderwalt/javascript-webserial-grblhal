
// Optimized G-code Parser for high performance (Zero-copy & Data-Oriented)
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js';

const lastLine = {
  x: 0, y: 0, z: 0, a: 0, e: 0, f: 0, s: 0,
  feedrate: null, extruding: false, tool: null
};

// Growable Float32Array wrapper
class GrowableBuffer {
  constructor(initialCapacity = 1048576) { // 1M floats initial
    this.data = new Float32Array(initialCapacity);
    this.length = 0;
  }
  push(x, y, z, x2, y2, z2) {
    if (this.length + 6 > this.data.length) {
      const newData = new Float32Array(this.data.length * 2);
      newData.set(this.data);
      this.data = newData;
    }
    const d = this.data;
    const l = this.length;
    d[l] = x; d[l + 1] = y; d[l + 2] = z;
    d[l + 3] = x2; d[l + 4] = y2; d[l + 5] = z2;
    this.length += 6;
  }
  getArray() {
    return this.data.subarray(0, this.length);
  }
}

class GrowableByteBuffer {
  constructor(initialCapacity = 1048576) {
    this.data = new Uint8Array(initialCapacity);
    this.length = 0;
  }
  push(val, count=1) {
    if (this.length + count > this.data.length) {
      const newData = new Uint8Array(this.data.length * 2);
      newData.set(this.data);
      this.data = newData;
    }
    for(let i=0; i<count; i++) this.data[this.length++] = val;
  }
  getArray() {
    return this.data.subarray(0, this.length);
  }
}

function GCodeParser(handlers) {
  this.handlers = handlers || {};
  this.lastArgs = { cmd: null };
  this.lastFeedrate = null;
  this.currentTool = null;

  this.parseLine = function (text, info) {
    if (!text) return;
    // Strip comments and trim
    const commentIdx = text.indexOf(';');
    if (commentIdx !== -1) text = text.substring(0, commentIdx);
    const parenIdx = text.indexOf('(');
    if (parenIdx !== -1) {
      text = text.replace(/\(.*?\)/g, "");
    }
    text = text.trim();
    if (!text) return;

    // Normalization: Remove whitespace between command letters and their numbers (e.g. "X 10" -> "X10")
    text = text.replace(/([gmtxyzabcijkfst])\s+/ig, "$1");

    // Fast tokenization
    const tokens = text.match(/([A-Z][\-+]?[0-9.]+)/gi);
    if (!tokens) return;

    let cmd = tokens[0].toUpperCase();
    if (!cmd.match(/^(G|M|T|S)/i)) {
      cmd = this.lastArgs.cmd;
    } else {
      tokens.shift();
    }

    if (!cmd) return;

    const args = { cmd, indx: info };
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const key = t[0].toLowerCase();
      const val = parseFloat(t.substring(1));
      args[key] = val;
      if (key === 'f') this.lastFeedrate = val;
      if (key === 't') this.currentTool = val;
    }
    args.feedrate = this.lastFeedrate;
    args.tool = this.currentTool;

    const handler = this.handlers[cmd] || this.handlers['default'];
    if (handler) {
      this.lastArgs = args;
      handler(args, info, this);
    }
  };

  this.parse = function (gcode) {
    let lineCount = 0;
    for (let i = 0; i < gcode.length; i++) if (gcode[i] === '\n') lineCount++;
    lineCount++;

    const lineMap = new Uint32Array(lineCount * 2);
    this.lineMap = lineMap;

    let start = 0;
    let end = gcode.indexOf('\n');
    let lineIdx = 0;

    while (end !== -1) {
      this.parseLine(gcode.substring(start, end), lineIdx++);
      start = end + 1;
      end = gcode.indexOf('\n', start);
      if (lineIdx % 50000 === 0) {
        self.postMessage({ progress: Math.floor((lineIdx / lineCount) * 100) });
      }
    }
    this.parseLine(gcode.substring(start), lineIdx);
  };
}

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
  return 15;
}

function createObjectFromGCode(gcode) {
  let lastLine = { x: 0, y: 0, z: 0, a: 0, e: 0, f: 0, s: 0, feedrate: null, tool: null };
  let isUnitsMm = true;
  let totalDist = 0;
  let totalTime = 0;
  let relative = false;
  const segmentLengthStats = new Array(16).fill(0);
  const rapidGeo = new GrowableBuffer();
  const feedGeo = new GrowableBuffer();
  const feedTypes = new GrowableByteBuffer();
  const extraObjects = { G17: [], G18: [], G19: [], M_codes: [] };
  const offsetG92 = { x: 0, y: 0, z: 0, e: 0 };

  function drawArc(aX, aY, aZ, endaZ, aRadius, aStartAngle, aEndAngle, aClockwise) {
    const ac = new THREE.ArcCurve(aX, aY, aRadius, aStartAngle, aEndAngle, aClockwise);
    const pts = ac.getPoints(20);
    const result = [];
    for (let i = 0; i < pts.length; i++) {
      result.push({ x: pts[i].x, y: pts[i].y, z: (((endaZ - aZ) / 20) * i) + aZ });
    }
    return result;
  }

  function drawArcFrom2PtsAndCenter(vp1, vp2, vpArc, args) {
    // Vector pointing outwards from the center to the point
    const p1d = { x: vp1.x - vpArc.x, y: vp1.y - vpArc.y, z: vp1.z - vpArc.z };
    const p2d = { x: vp2.x - vpArc.x, y: vp2.y - vpArc.y, z: vp2.z - vpArc.z };
    let a1, a2;
    if (args.plane === "G18") { a1 = Math.atan2(p1d.z, p1d.x); a2 = Math.atan2(p2d.z, p2d.x); }
    else if (args.plane === "G19") { a1 = Math.atan2(p1d.z, p1d.y); a2 = Math.atan2(p2d.z, p2d.y); }
    else { a1 = Math.atan2(p1d.y, p1d.x); a2 = Math.atan2(p2d.y, p2d.x); }

    const radius = vp1.distanceTo(vpArc);
    const clwise = args.clockwise !== false;
    let pts;
    if (a1 === a2) {
      const ea = a1 + (2 * Math.PI);
      if (args.plane === "G18") pts = drawArc(vpArc.x, vpArc.z, -vp1.y, -vp2.y, radius, a1, ea, clwise);
      else if (args.plane === "G19") pts = drawArc(vpArc.y, vpArc.z, vp1.x, vp2.x, radius, a1, ea, clwise);
      else pts = drawArc(vpArc.x, vpArc.y, vp1.z, vp2.z, radius, a1, ea, clwise);
    } else {
      if (args.plane === "G18") pts = drawArc(vpArc.x, vpArc.z, -vp1.y, -vp2.y, radius, a1, a2, clwise);
      else if (args.plane === "G19") pts = drawArc(vpArc.y, vpArc.z, vp1.x, vp2.x, radius, a1, a2, clwise);
      else pts = drawArc(vpArc.x, vpArc.y, vp1.z, vp2.z, radius, a1, a2, clwise);
    }
    return pts.map(p => {
      if (args.plane === "G18") return { x: p.x, y: -p.z, z: p.y };
      if (args.plane === "G19") return { x: p.z, y: p.x, z: p.y };
      return p;
    });
  }

  function addSegment(p1, p2, args, parser) {
    if (p2.arc) {
      const v1 = new THREE.Vector3(p1.x, p1.y, p1.z);
      const v2 = new THREE.Vector3(p2.x, p2.y, p2.z);
      let vArc;
      if (args.r != null) {
        const r = parseFloat(args.r);
        const q = v1.distanceTo(v2);
        const center = v1.clone().add(v2).multiplyScalar(0.5);
        const calc = Math.sqrt(Math.max(0, (r * r) - (q * q / 4)));
        let dir = new THREE.Vector3();
        if (args.plane === "G18") dir.set(p2.z - p1.z, 0, p1.x - p2.x).normalize();
        else if (args.plane === "G19") dir.set(0, p2.z - p1.z, p1.y - p2.y).normalize();
        else dir.set(p1.y - p2.y, p2.x - p1.x, 0).normalize();
        vArc = (p2.clockwise === (r > 0)) ? center.clone().add(dir.multiplyScalar(calc)) : center.clone().sub(dir.multiplyScalar(calc));
      } else {
        vArc = new THREE.Vector3(p2.arci, p2.arcj, p2.arck);
      }
      const pts = drawArcFrom2PtsAndCenter(v1, v2, vArc, args);
      let dSum = 0;
      const startIdx = feedGeo.length / 3;
      for (let i = 0; i < pts.length; i++) {
        const pt = pts[i];
        const prev = i === 0 ? p1 : pts[i - 1];
        const d = Math.sqrt((pt.x - prev.x) ** 2 + (pt.y - prev.y) ** 2 + (pt.z - prev.z) ** 2);
        dSum += d;
        feedGeo.push(prev.x, prev.y, prev.z, pt.x, pt.y, pt.z);
        feedTypes.push(2, 2);
      }
      totalDist += dSum;
      if (args.indx !== undefined) {
        parser.lineMap[args.indx * 2] = startIdx;
        parser.lineMap[args.indx * 2 + 1] = pts.length * 2;
      }
      segmentLengthStats[sortSegmentIntoBin(dSum)]++;
      totalTime += (dSum / (args.feedrate || 1000)) * 1.32;
    } else {
      const d = Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2 + (p2.z - p1.z) ** 2);
      if (d > 0) {
        totalDist += d;
        segmentLengthStats[sortSegmentIntoBin(d)]++;
        totalTime += (d / (args.feedrate || 100)) * 1.32;
      }
      const buf = p2.g0 ? rapidGeo : feedGeo;
      const startIdx = buf.length / 3;
      buf.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
      if (!p2.g0) {
        feedTypes.push(1, 2);
        if (args.indx !== undefined) {
          parser.lineMap[args.indx * 2] = startIdx;
          parser.lineMap[args.indx * 2 + 1] = 2;
        }
      }
    }
  }

  const parser = new GCodeParser({
    G0: (args, i, gcp) => {
      const nl = {
        x: args.x !== undefined ? (relative ? lastLine.x + args.x : args.x) + offsetG92.x : lastLine.x,
        y: args.y !== undefined ? (relative ? lastLine.y + args.y : args.y) + offsetG92.y : lastLine.y,
        z: args.z !== undefined ? (relative ? lastLine.z + args.z : args.z) + offsetG92.z : lastLine.z,
        g0: true
      };
      addSegment(lastLine, nl, args, gcp);
      lastLine = nl;
    },
    G1: (args, i, gcp) => {
      const nl = {
        x: args.x !== undefined ? (relative ? lastLine.x + args.x : args.x) + offsetG92.x : lastLine.x,
        y: args.y !== undefined ? (relative ? lastLine.y + args.y : args.y) + offsetG92.y : lastLine.y,
        z: args.z !== undefined ? (relative ? lastLine.z + args.z : args.z) + offsetG92.z : lastLine.z,
        g1: true
      };
      addSegment(lastLine, nl, args, gcp);
      lastLine = nl;
    },
    G2: (args, i, gcp) => {
      const nl = {
        x: args.x !== undefined ? (relative ? lastLine.x + args.x : args.x) + offsetG92.x : lastLine.x,
        y: args.y !== undefined ? (relative ? lastLine.y + args.y : args.y) + offsetG92.y : lastLine.y,
        z: args.z !== undefined ? (relative ? lastLine.z + args.z : args.z) + offsetG92.z : lastLine.z,
        arci: args.i !== undefined ? lastLine.x + args.i : lastLine.x,
        arcj: args.j !== undefined ? lastLine.y + args.j : lastLine.y,
        arck: args.k !== undefined ? lastLine.z + args.k : lastLine.z,
        arc: true, clockwise: true
      };
      addSegment(lastLine, nl, args, gcp);
      lastLine = nl;
    },
    G3: (args, i, gcp) => { args.arc = true; args.clockwise = false; gcp.handlers.G2(args, i, gcp); },
    G20: () => { isUnitsMm = false; },
    G21: () => { isUnitsMm = true; },
    G90: () => { relative = false; },
    G91: () => { relative = true; },
    'default': (args, i, gcp) => {
      if (args.cmd && args.cmd.startsWith('M')) {
        extraObjects.M_codes.push({ x: lastLine.x, y: lastLine.y, z: lastLine.z, cmd: args.cmd });
      }
    }
  });

  parser.parse(gcode);

  return {
    rapidGeo: rapidGeo.getArray(),
    feedGeo: feedGeo.getArray(),
    feedTypes: feedTypes.getArray(),
    lineMap: parser.lineMap,
    extraObjects,
    inch: !isUnitsMm,
    totalDist, totalTime, segmentLengthStats
  };
}

self.addEventListener('message', e => {
  const res = createObjectFromGCode(e.data.data);
  self.postMessage(res, [res.rapidGeo.buffer, res.feedGeo.buffer, res.feedTypes.buffer, res.lineMap.buffer]);
});
