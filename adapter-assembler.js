// Adapter Assembler — design threaded adapters in the browser and export STL / OBJ.
// https://github.com/electroluminescent/adapter-assembler
// Version 3.32.1. Booleans use the Manifold library (Apache-2.0), loaded from jsDelivr.
(function () {
  'use strict';

  // The model is kept in inches; files (STL / OBJ) and thread standards are in millimetres.
  const APP_VERSION = "3.32.1";
  const MM = 25.4;
  // Display units (Project settings): lengths in mm or inches, angles in degrees or radians.
  let UNIT_SCALE = MM, UNIT_LABEL = 'mm', ANG_SCALE = 1, ANG_LABEL = '°';
  // Points within this distance of each other (in inches, the model's units) are
  // welded into one when "Optimize" is on: 0.00001 in = 0.000254 mm.
  const WELD_TOLERANCE_IN = 0.00001;
  // Booleans and extra objects are computed with the Manifold library
  // (Apache-2.0), loaded on demand from jsDelivr. Change this to self-host it.
  const MANIFOLD_URL = 'https://cdn.jsdelivr.net/npm/manifold-3d@3.5.4/manifold.js';

  const W = window;

  const state = {
    // export settings
    helical: true,         // rebuild the zig-zag thread rings as real helical threads
    optimize: true,        // weld coincident points / split T-junctions before export
    precision: 100,        // edges around a full circle
    faces: 'ngons',        // OBJ faces / wireframe: 'ngons' (flat regions as one polygon), 'quads' or 'tris'
    format: 'stl',         // 'stl' | 'obj' | 'step'
    wire: false,           // 3D view: wireframe
    ssao: true,            // 3D view: ambient occlusion
    lenUnit: 'mm',         // displayed lengths: 'mm' or 'in'
    quality: 'high',       // 'high', or 'low': no animations and less detail (faster on slow machines)
    collapsed: [],
    secMode: 'section',    // cross-section pane: 'section' (radius / height) or 'top' (seen from above)         // property groups the user has folded (by title)
    angUnit: 'deg',        // displayed angles: 'deg' or 'rad'
    ortho: false,          // 3D view: orthographic (true) or perspective projection
    flip: false,           // turn the part upside down (export and 3D view)
    paneLeft: 40,          // editor layout: cross-section width (% of the editor)
    paneSide: 55,          // editor layout: side bar height (% of the right column, under the 3D view)
    minLeft: false, min3d: false, minSide: false,   // editor panes minimized
    selBoxCollapsed: false,
    cutMode: 'relative',   // 3D cut planes: 'relative' (turn with the view) or 'absolute' (fixed to the part)
    cuts: { x: 1, y: 1, z: 0 },
    cutLo: 0,              // (old: the slice from below as a fraction of the height; read once into cutsLo.y)
    cutsLo: { x: -1, y: -0.05, z: -1 },   // 3D: the lower slice on each axis, in the same units as cuts (at its low end = none)
    mono: false,           // cross-section: everything not selected as one grey shape
    autoSimplify: true,
    heightFrom: 'bottom',  // heights shown from the lowest point up ('bottom') or from the top down ('top'), as the part is shown
    linkSlicers: false,
    orbitSnap: 15,         // Ctrl while orbiting (the compass, the 3D view, the section knob) snaps to this many degrees
    rotMode: 'absolute',   // rotation fields and snapping: the angle itself ('absolute') or the change ('relative')
    offsetMode: 'polar',   // what a drag shows by the pointer: 'polar' (distance, angle), 'radial' (Δr, Δθ, Δh), 'xyz'    // the 2D height band is the 3D height slicer, and the 2D cross-section is cut where the blue slicer is
    linkViews: true,       // radius/height and overhead line up with each other when switching (off: each keeps its own view)
    settingsRev: 0,        // which one-time changes to saved settings have been made
    treeFolded: [],        // objects list: groups / booleans / cloners shown folded   // ... and automatically at 50 % zoom or less
    cutHandles: false,     // 3D: show the slicing handles on the model
    topCut: { lo: 0, hi: 1 },             // overhead view: the band of heights shown (fractions of the part's height)   // 3D cut planes: slider positions (1 = no cut)
    sidePanels: {},        // side bar views: { key: { size, min } }                          // the selection box in the cross-section is folded
    viewAngle: 135.8,      // angle (degrees) of the half-plane shown in the cross-section; the 3D view follows it
    // scene
    holes: [],             // holes of imported profiles (older project files)
    scene: null,           // { nodes: {id: node}, root: [ids] }
    edited: false,
    undo: [],
    redo: [],
    sel: new Set(),        // selected points/edges: "node|p|i", "node|r|run|k", "node|e|i"
    selNodes: new Set(),   // selected objects
    libMessage: null, exporting: null, exportError: null,
    // jobs
    job: 0,                // increments on every recalculation; stale results are ignored
    busy: false,
    result: null,          // { buffer, ext, preview, report } — full quality, downloadable
    preview: null,         // newest finished mesh (may be a quick one), shown in the 3D view
    liveInput: false,      // a field is being typed in: run quick jobs
    undoLock: false,
  };


  // Settings remembered in this browser.
  const SETTINGS_KEY = 'adapterAssembler.settings', SAVED_SETTINGS = ['helical', 'optimize', 'precision', 'faces', 'format', 'lenUnit', 'angUnit', 'quality', 'collapsed', 'secMode', 'mono', 'autoSimplify', 'rotMode', 'orbitSnap', 'measurePerfect', 'offsetMode', 'heightFrom', 'linkViews', 'linkSlicers', 'settingsRev', 'treeFolded', 'cutsLo', 'cutHandles', 'topCut', 'wire', 'ssao', 'ortho', 'flip', 'paneLeft', 'paneSide', 'minLeft', 'min3d', 'minSide', 'selBoxCollapsed', 'sidePanels', 'cutMode', 'cuts', 'cutLo'];
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    for (const k of SAVED_SETTINGS) if (k in saved && typeof saved[k] === typeof state[k]) state[k] = saved[k];
  } catch (_) { /* storage unavailable */ }
  // one-time: auto-simplify is on by default now
  if (!(state.settingsRev >= 1)) { state.autoSimplify = true; state.settingsRev = 1; }
  // always on: true helical threads, and welding / T-junction repair of the exported mesh
  state.helical = true; state.optimize = true;
  if (!['ngons', 'quads', 'tris'].includes(state.faces)) state.faces = 'ngons';
  if (state.secMode !== 'top') state.secMode = 'section';
  if (state.heightFrom !== 'top') state.heightFrom = 'bottom';
  state.precision = Math.max(8, Math.min(300, Math.round(+state.precision) || 100));   // circle precision: 8…300 edges
  function applyUnits() {
    if (state.lenUnit !== 'in') state.lenUnit = 'mm';
    if (state.angUnit !== 'rad') state.angUnit = 'deg';
    if (state.quality !== 'low') state.quality = 'high';
    UNIT_SCALE = state.lenUnit === 'in' ? 1 : MM; UNIT_LABEL = state.lenUnit;
    ANG_SCALE = state.angUnit === 'rad' ? Math.PI / 180 : 1; ANG_LABEL = state.angUnit === 'rad' ? ' rad' : '°';
  }
  applyUnits();
  state.sidePanels = state.sidePanels && typeof state.sidePanels === 'object' ? state.sidePanels : {};
  function saveSettings() {
    try { const o = {}; for (const k of SAVED_SETTINGS) o[k] = state[k]; localStorage.setItem(SETTINGS_KEY, JSON.stringify(o)); } catch (_) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // 3. Mesh → STL (weld, repair, solidity check). Self-contained so it can run inside a Web Worker.
  //    Returns { buffer, report }.
  // ---------------------------------------------------------------------------
  function processMesh(mesh, opts) {
    const S = 7, nv = mesh.length / S, scale = opts.unitScale, tol = opts.tolerance;

    // Centre X/Y, put the part on Z = 0, convert units.
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let v = 0; v < nv; v++) {
      const o = v * S;
      if (mesh[o] < minX) minX = mesh[o]; if (mesh[o] > maxX) maxX = mesh[o];
      if (mesh[o + 1] < minY) minY = mesh[o + 1]; if (mesh[o + 1] > maxY) maxY = mesh[o + 1];
      if (mesh[o + 2] < minZ) minZ = mesh[o + 2];
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const pos = new Float64Array(nv * 3);
    for (let v = 0; v < nv; v++) {
      pos[v * 3] = (mesh[v * S] - cx) * scale;
      pos[v * 3 + 1] = (mesh[v * S + 1] - cy) * scale;
      pos[v * 3 + 2] = (mesh[v * S + 2] - minZ) * scale;
    }

    // Give every triangle corner a vertex id.
    //  - optimize: points within `tol` of each other share an id (welded), using a
    //    spatial hash that also searches neighbouring cells so nothing near a cell
    //    border is missed.
    //  - otherwise: only bit-identical points share an id (the mesh is left as-is).
    const ids = new Int32Array(nv), uniq = [];
    // Points that are bit-identical are always the same vertex.
    const exact = new Map();
    for (let v = 0; v < nv; v++) {
      const key = pos[v * 3] + ',' + pos[v * 3 + 1] + ',' + pos[v * 3 + 2];
      if (!exact.has(key)) exact.set(key, exact.size);
    }
    const exactPoints = exact.size;
    if (opts.optimize) {
      const cells = new Map(), cs = tol * 2;
      for (let v = 0; v < nv; v++) {
        const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
        const ix = Math.floor(x / cs), iy = Math.floor(y / cs), iz = Math.floor(z / cs);
        let found = -1;
        for (let dx = -1; dx <= 1 && found < 0; dx++)
          for (let dy = -1; dy <= 1 && found < 0; dy++)
            for (let dz = -1; dz <= 1 && found < 0; dz++) {
              const list = cells.get((ix + dx) + ',' + (iy + dy) + ',' + (iz + dz));
              if (!list) continue;
              for (const u of list) {
                const p = uniq[u];
                if (Math.abs(p[0] - x) <= tol && Math.abs(p[1] - y) <= tol && Math.abs(p[2] - z) <= tol) { found = u; break; }
              }
            }
        if (found < 0) {
          found = uniq.length; uniq.push([x, y, z]);
          const key = ix + ',' + iy + ',' + iz;
          const list = cells.get(key); if (list) list.push(found); else cells.set(key, [found]);
        }
        ids[v] = found;
      }
    } else {
      const seen = new Map();
      for (let v = 0; v < nv; v++) {
        const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2], key = x + ',' + y + ',' + z;
        let id = seen.get(key);
        if (id === undefined) { id = uniq.length; uniq.push([x, y, z]); seen.set(key, id); }
        ids[v] = id;
      }
    }

    // Triangles (optimize also drops triangles that collapsed to a line or point).
    const tris = [];
    let dropped = 0;
    for (let v = 0; v < nv; v += 3) {
      const a = ids[v], b = ids[v + 1], c = ids[v + 2];
      if (opts.optimize) {
        if (a === b || b === c || a === c) { dropped++; continue; }
        const A = uniq[a], B = uniq[b], C = uniq[c];
        const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], wx = C[0] - A[0], wy = C[1] - A[1], wz = C[2] - A[2];
        if (Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) < 1e-18) { dropped++; continue; }
      }
      tris.push(a, b, c);
    }

    // Optimize, part 2: repair T-junctions (a point lying in the middle of a
    // neighbour's edge, as csg.js leaves around cut holes) by splitting that edge.
    let tjunctions = 0;
    if (opts.optimize) {
      for (let pass = 0; pass < 6; pass++) {
        const nU = uniq.length, dir = new Set();
        for (let t = 0; t < tris.length; t += 3)
          for (let k = 0; k < 3; k++) dir.add(tris[t + k] * nU + tris[t + (k + 1) % 3]);
        // open edges and the points on them
        const open = [], onOpen = new Set();
        for (let t = 0; t < tris.length; t += 3)
          for (let k = 0; k < 3; k++) {
            const a = tris[t + k], b = tris[t + (k + 1) % 3];
            if (!dir.has(b * nU + a)) { open.push(t, k); onOpen.add(a); onOpen.add(b); }
          }
        if (!open.length) break;
        // spatial hash of those points
        let total = 0;
        for (let e = 0; e < open.length; e += 2) {
          const t = open[e], k = open[e + 1], A = uniq[tris[t + k]], B = uniq[tris[t + (k + 1) % 3]];
          total += Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]);
        }
        const cs = Math.max(total / (open.length / 2), tol * 10), grid = new Map();
        const cell = (x) => Math.floor(x / cs);
        for (const v of onOpen) {
          const p = uniq[v], key = cell(p[0]) + ',' + cell(p[1]) + ',' + cell(p[2]);
          const l = grid.get(key); if (l) l.push(v); else grid.set(key, [v]);
        }
        const splits = new Map(); // triangle index -> { k, pts: [ids sorted along edge] }
        for (let e = 0; e < open.length; e += 2) {
          const t = open[e], k = open[e + 1];
          if (splits.has(t)) continue;
          const a = tris[t + k], b = tris[t + (k + 1) % 3], A = uniq[a], B = uniq[b];
          const dx = B[0] - A[0], dy = B[1] - A[1], dz = B[2] - A[2], L2 = dx * dx + dy * dy + dz * dz;
          if (L2 === 0) continue;
          const found = [];
          const x0 = cell(Math.min(A[0], B[0]) - tol), x1 = cell(Math.max(A[0], B[0]) + tol);
          const y0 = cell(Math.min(A[1], B[1]) - tol), y1 = cell(Math.max(A[1], B[1]) + tol);
          const z0 = cell(Math.min(A[2], B[2]) - tol), z1 = cell(Math.max(A[2], B[2]) + tol);
          if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 4096) continue;
          for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) for (let iz = z0; iz <= z1; iz++) {
            const l = grid.get(ix + ',' + iy + ',' + iz); if (!l) continue;
            for (const v of l) {
              if (v === a || v === b) continue;
              const P = uniq[v], s = ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy + (P[2] - A[2]) * dz) / L2;
              if (s <= 1e-9 || s >= 1 - 1e-9) continue;
              const qx = A[0] + dx * s - P[0], qy = A[1] + dy * s - P[1], qz = A[2] + dz * s - P[2];
              if (qx * qx + qy * qy + qz * qz <= tol * tol) found.push([s, v]);
            }
          }
          if (found.length) { found.sort((p, q) => p[0] - q[0]); splits.set(t, { k, pts: found.map(f => f[1]) }); }
        }
        if (!splits.size) break;
        const next = [];
        for (let t = 0; t < tris.length; t += 3) {
          const sp = splits.get(t);
          if (!sp) { next.push(tris[t], tris[t + 1], tris[t + 2]); continue; }
          const a = tris[t + sp.k], b = tris[t + (sp.k + 1) % 3], c = tris[t + (sp.k + 2) % 3];
          const chain = [a].concat(sp.pts, [b]);
          for (let q = 0; q < chain.length - 1; q++) next.push(chain[q], chain[q + 1], c);
          tjunctions += sp.pts.length;
        }
        tris.length = 0; for (const v of next) tris.push(v);
      }
    }

    // Solidity: every edge must be used exactly once in each direction
    // (closed surface, two faces per edge, consistent outward winding).
    const n = uniq.length, edges = new Map();
    for (let t = 0; t < tris.length; t += 3)
      for (let k = 0; k < 3; k++) {
        const key = tris[t + k] * n + tris[t + (k + 1) % 3];
        edges.set(key, (edges.get(key) || 0) + 1);
      }
    let openEdges = 0, nonManifoldEdges = 0;
    const badEdges = [];        // the edges that keep the part from being solid, for the 3D view
    for (const [key, count] of edges) {
      const i = Math.floor(key / n), j = key - i * n, back = edges.get(j * n + i) || 0;
      let bad = false;
      if (count > 1 || back > 1) { nonManifoldEdges++; bad = true; }
      else if (back === 0) { openEdges++; bad = true; }
      if (bad && opts.optimize && badEdges.length < 6 * 40000) { const A = uniq[i], B = uniq[j]; badEdges.push(A[0], A[1], A[2], B[0], B[1], B[2]); }
    }

    // Normals, volume, preview arrays.
    const count = tris.length / 3, nrm = new Float32Array(count * 3);
    let volume = 0;
    for (let t = 0, f = 0; t < tris.length; t += 3, f += 3) {
      const A = uniq[tris[t]], B = uniq[tris[t + 1]], C = uniq[tris[t + 2]];
      const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], wx = C[0] - A[0], wy = C[1] - A[1], wz = C[2] - A[2];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, len = Math.hypot(nx, ny, nz) || 1;
      nrm[f] = nx / len; nrm[f + 1] = ny / len; nrm[f + 2] = nz / len;
      volume += (A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0])) / 6;
    }

    // Quads: pair each triangle with a coplanar neighbour across its longest shared edge.
    const pairOf = new Int32Array(count).fill(-1);
    if (opts.faces === 'quads') {
      const edgeTri = new Map(), nU = uniq.length;
      for (let t = 0; t < count; t++)
        for (let k = 0; k < 3; k++) {
          const a = tris[t * 3 + k], b = tris[t * 3 + (k + 1) % 3];
          edgeTri.set(a * nU + b, t);
        }
      for (let t = 0; t < count; t++) {
        if (pairOf[t] >= 0) continue;
        let best = -1, bestLen = -1;
        for (let k = 0; k < 3; k++) {
          const a = tris[t * 3 + k], b = tris[t * 3 + (k + 1) % 3], o = edgeTri.get(b * nU + a);
          if (o === undefined || o === t || pairOf[o] >= 0) continue;
          if (nrm[t * 3] * nrm[o * 3] + nrm[t * 3 + 1] * nrm[o * 3 + 1] + nrm[t * 3 + 2] * nrm[o * 3 + 2] < 0.9999) continue;
          const A = uniq[a], B = uniq[b], L = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]);
          if (L > bestLen) { bestLen = L; best = o; }
        }
        if (best >= 0) { pairOf[t] = best; pairOf[best] = t; }
      }
    }
    // faces: [a,b,c], [a,b,c,d] or n-gons
    const faces = opts.faces === 'ngons' ? ngonFaces(tris, uniq, nrm, count, opts.tolerance) : [];
    for (let t = 0; opts.faces !== 'ngons' && t < count; t++) {
      const o = pairOf[t];
      if (o < 0) { faces.push([tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]]); continue; }
      if (o < t) continue;
      let quad = null;
      for (let k = 0; k < 3 && !quad; k++) {
        const x = tris[t * 3 + k], y = tris[t * 3 + (k + 1) % 3], c1 = tris[t * 3 + (k + 2) % 3];
        for (let q = 0; q < 3; q++) {
          if (tris[o * 3 + q] === y && tris[o * 3 + (q + 1) % 3] === x) { quad = [x, tris[o * 3 + (q + 2) % 3], y, c1]; break; }
        }
      }
      faces.push(quad || [tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]]);
    }

    // Preview: triangle soup with flat normals, plus the face outlines for wireframe.
    const pv = new Float32Array(count * 18);
    for (let t = 0, w = 0; t < count; t++)
      for (let k = 0; k < 3; k++) {
        const P = uniq[tris[t * 3 + k]];
        pv[w++] = P[0]; pv[w++] = P[1]; pv[w++] = P[2]; pv[w++] = nrm[t * 3]; pv[w++] = nrm[t * 3 + 1]; pv[w++] = nrm[t * 3 + 2];
      }
    let nl = 0; for (const f of faces) nl += f.length;
    const lines = new Float32Array(nl * 6);
    let lw = 0;
    for (const f of faces)
      for (let k = 0; k < f.length; k++) {
        const P = uniq[f[k]], Q = uniq[f[(k + 1) % f.length]];
        lines[lw++] = P[0]; lines[lw++] = P[1]; lines[lw++] = P[2]; lines[lw++] = Q[0]; lines[lw++] = Q[1]; lines[lw++] = Q[2];
      }

    // File: binary STL (always triangles) or OBJ (triangles, quads or n-gons).
    let buffer, ext;
    if (opts.format === 'step') {
      buffer = new TextEncoder().encode(stepFile(uniq, tris, nrm, count, opts, openEdges === 0 && nonManifoldEdges === 0)).buffer;
      ext = 'step';
    } else if (opts.format === 'obj') {
      const out = ['# Adapter Assembler, units: ' + opts.unitLabel + ', ' + (opts.faces === 'ngons' ? 'n-gons' : opts.faces === 'quads' ? 'quads' : 'triangles')];
      for (const P of uniq) out.push('v ' + P[0].toFixed(6) + ' ' + P[1].toFixed(6) + ' ' + P[2].toFixed(6));
      for (const f of faces) out.push('f ' + f.map(i => i + 1).join(' '));
      buffer = new TextEncoder().encode(out.join('\n') + '\n').buffer;
      ext = 'obj';
    } else {
      buffer = new ArrayBuffer(84 + count * 50);
      const dv = new DataView(buffer);
      const header = 'Adapter Assembler, units: ' + opts.unitLabel + (opts.optimize ? ', welded' : '');
      for (let i = 0; i < header.length && i < 80; i++) dv.setUint8(i, header.charCodeAt(i));
      dv.setUint32(80, count, true);
      let off = 84;
      for (let t = 0; t < count; t++) {
        dv.setFloat32(off, nrm[t * 3], true); dv.setFloat32(off + 4, nrm[t * 3 + 1], true); dv.setFloat32(off + 8, nrm[t * 3 + 2], true); off += 12;
        for (let k = 0; k < 3; k++) { const P = uniq[tris[t * 3 + k]]; dv.setFloat32(off, P[0], true); dv.setFloat32(off + 4, P[1], true); dv.setFloat32(off + 8, P[2], true); off += 12; }
        dv.setUint16(off, 0, true); off += 2;
      }
      ext = 'stl';
    }

    return {
      buffer, ext,
      preview: { tris: pv, lines, bad: new Float32Array(badEdges), shift: [cx, cy, minZ] },   // shift: what was taken off (model units) to centre the part and stand it on Z = 0
      report: {
        optimize: opts.optimize,
        triangles: count,
        faces: faces.length,
        quads: faces.length < count,
        droppedTriangles: dropped,
        exactPoints,
        uniquePoints: uniq.length,
        weldedPoints: exactPoints - uniq.length,
        tjunctionsFixed: tjunctions,
        openEdges,
        nonManifoldEdges,
        solid: openEdges === 0 && nonManifoldEdges === 0 && count > 0,
        volume,
        size: [(maxX - minX) * scale, (maxY - minY) * scale],
      },
    };
  }
  // ---------------------------------------------------------------------------
  // 3a. N-gon faces for OBJ export and the wireframe: connected flat regions of the triangle mesh
  //     (same plane within the weld tolerance), each written as one polygon along its outline.
  //     A region with holes (an annulus, say) is split across the middle until every piece has a
  //     single outline; whatever cannot be split cleanly stays triangles. Points on an outline are
  //     all kept, so faces still meet edge to edge (no T-junctions).
  // ---------------------------------------------------------------------------
  // A STEP file (ISO 10303-21, AP214) of the mesh as a B-rep solid: each flat region of triangles one planar face (with
  // its holes), straight edges shared between faces, in millimetres. (Not closed: a surface model of an open shell.)
  function stepFile(uniq, tris, nrm, count, opts, closed) {
    const k = opts.unitLabel === 'in' ? 25.4 : 1, nU = uniq.length, owner = new Map();
    for (let t = 0; t < count; t++) for (let j = 0; j < 3; j++) owner.set(tris[t * 3 + j] * nU + tris[t * 3 + (j + 1) % 3], t);
    // flat regions: neighbours across an edge on the same plane
    const tolP = Math.max(opts.tolerance || 0, 1e-7) * 2, region = new Int32Array(count).fill(-1), regions = [];
    const dOf = (t) => { const P = uniq[tris[t * 3]]; return nrm[t * 3] * P[0] + nrm[t * 3 + 1] * P[1] + nrm[t * 3 + 2] * P[2]; };
    for (let t0 = 0; t0 < count; t0++) {
      if (region[t0] >= 0) continue;
      const r = regions.length, n0 = [nrm[t0 * 3], nrm[t0 * 3 + 1], nrm[t0 * 3 + 2]], d0 = dOf(t0), list = [t0], st = [t0];
      region[t0] = r;
      while (st.length) {
        const t = st.pop();
        for (let j = 0; j < 3; j++) {
          const a = tris[t * 3 + j], b = tris[t * 3 + (j + 1) % 3], o = owner.get(b * nU + a);
          if (o == null || region[o] >= 0) continue;
          if (n0[0] * nrm[o * 3] + n0[1] * nrm[o * 3 + 1] + n0[2] * nrm[o * 3 + 2] < 1 - 1e-9) continue;
          let off = 0; for (let q = 0; q < 3; q++) { const P = uniq[tris[o * 3 + q]]; off = Math.max(off, Math.abs(n0[0] * P[0] + n0[1] * P[1] + n0[2] * P[2] - d0)); }
          if (off > tolP) continue;
          region[o] = r; list.push(o); st.push(o);
        }
      }
      regions.push({ n: n0, list });
    }
    // which regions meet at each point (a point on a straight edge between just two faces can be left out)
    const at = Array.from({ length: nU }, () => new Set());
    for (let t = 0; t < count; t++) for (let j = 0; j < 3; j++) at[tris[t * 3 + j]].add(region[t]);
    // each region's outlines: closed loops of directed edges
    const loopsOf = (R, r) => {
      const next = new Map();
      for (const t of R.list) for (let j = 0; j < 3; j++) {
        const a = tris[t * 3 + j], b = tris[t * 3 + (j + 1) % 3], o = owner.get(b * nU + a);
        if (o != null && region[o] === r) continue;
        if (!next.has(a)) next.set(a, []);
        next.get(a).push(b);
      }
      const loops = [];
      for (const [a0, outs] of next) while (outs.length) {
        const L = [a0]; let b = outs.pop(), guard = 0;
        while (b !== a0 && guard++ < 1e6) { L.push(b); const nx = next.get(b); if (!nx || !nx.length) break; b = nx.pop(); }
        if (b === a0 && L.length >= 3) loops.push(L);
      }
      // points in the middle of a straight run between the same two faces
      return loops.map(L => {
        const keep = L.filter((v, i) => {
          if (at[v].size !== 2) return true;
          const A = uniq[L[(i + L.length - 1) % L.length]], P = uniq[v], B = uniq[L[(i + 1) % L.length]];
          const u = [P[0] - A[0], P[1] - A[1], P[2] - A[2]], w = [B[0] - P[0], B[1] - P[1], B[2] - P[2]];
          const cx = u[1] * w[2] - u[2] * w[1], cy = u[2] * w[0] - u[0] * w[2], cz = u[0] * w[1] - u[1] * w[0];
          return Math.hypot(cx, cy, cz) > 1e-9 * Math.hypot(...u) * Math.hypot(...w) || (u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) < 0;
        });
        return keep.length >= 3 ? keep : L;
      });
    };
    // entities
    const E = [], add = (s) => { E.push(s); return '#' + E.length; };
    const num = (x) => { let s = (Math.abs(x) < 1e-12 ? 0 : +x.toFixed(9)).toString(); if (/e/i.test(s)) { const [m, e] = s.split(/e/i); s = (m.includes('.') ? m : m + '.') + 'E' + e; } else if (!s.includes('.')) s += '.'; return s; };
    const pt = (P) => add("CARTESIAN_POINT('',(" + num(P[0] * k) + ',' + num(P[1] * k) + ',' + num(P[2] * k) + '))');
    const dir = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return add("DIRECTION('',(" + num(v[0] / l) + ',' + num(v[1] / l) + ',' + num(v[2] / l) + '))'); };
    const ctx = add("APPLICATION_CONTEXT('core data for automotive mechanical design processes')");
    add("APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000," + ctx + ')');
    const pctx = add("PRODUCT_CONTEXT(''," + ctx + ",'mechanical')"), dctx = add("PRODUCT_DEFINITION_CONTEXT('part definition'," + ctx + ",'design')");
    const name = String(opts.name || 'adapter').replace(/'/g, '');
    const prod = add("PRODUCT('" + name + "','" + name + "',''," + '(' + pctx + '))');
    add("PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(" + prod + '))');
    const pdf = add("PRODUCT_DEFINITION_FORMATION('',''," + prod + ')'), pd = add("PRODUCT_DEFINITION('design',''," + pdf + ',' + dctx + ')');
    const pds = add("PRODUCT_DEFINITION_SHAPE(''," + "''," + pd + ')');
    const lu = add('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))'), au = add('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))'), su = add('(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())');
    const unc = add('UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(' + num(Math.max(1e-6, tolP * k)) + '),' + lu + ",'distance_accuracy_value','confusion accuracy')");
    const gctx = add('(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((' + unc + '))GLOBAL_UNIT_ASSIGNED_CONTEXT((' + lu + ',' + au + ',' + su + "))REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY'))");
    const vtx = new Map(), edges = new Map();
    const vertex = (i) => { if (!vtx.has(i)) vtx.set(i, add("VERTEX_POINT(''," + pt(uniq[i]) + ')')); return vtx.get(i); };
    const edge = (a, b) => {
      const key = Math.min(a, b) * nU + Math.max(a, b);
      if (!edges.has(key)) {
        const A = uniq[a], B = uniq[b], v = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
        const line = add("LINE(''," + pt(A) + ',' + add("VECTOR(''," + dir(v) + ',' + num(Math.hypot(v[0], v[1], v[2]) * k) + ')') + ')');
        edges.set(key, { a, id: add("EDGE_CURVE(''," + vertex(a) + ',' + vertex(b) + ',' + line + ',.T.)') });
      }
      const e = edges.get(key);
      return add("ORIENTED_EDGE('',*,*," + e.id + ',' + (e.a === a ? '.T.' : '.F.') + ')');
    };
    const faces = [];
    regions.forEach((R, r) => {
      const loops = loopsOf(R, r); if (!loops.length) return;
      // the outer outline: the largest (area in the face's plane)
      const n = R.n, area = (L) => { let x = 0, y = 0, z = 0; for (let i = 0; i < L.length; i++) { const P = uniq[L[i]], Q = uniq[L[(i + 1) % L.length]]; x += P[1] * Q[2] - P[2] * Q[1]; y += P[2] * Q[0] - P[0] * Q[2]; z += P[0] * Q[1] - P[1] * Q[0]; } return (x * n[0] + y * n[1] + z * n[2]) / 2; };
      let oi = 0; loops.forEach((L, i) => { if (area(L) > area(loops[oi])) oi = i; });
      const bounds = loops.map((L, i) => add((i === oi ? 'FACE_OUTER_BOUND' : 'FACE_BOUND') + "(''," + add("EDGE_LOOP('',(" + L.map((v, j) => edge(v, L[(j + 1) % L.length])).join(',') + '))') + ',.T.)'));
      const P0 = uniq[loops[oi][0]], P1 = uniq[loops[oi][1]], u = [P1[0] - P0[0], P1[1] - P0[1], P1[2] - P0[2]], dn = u[0] * n[0] + u[1] * n[1] + u[2] * n[2];
      const ref = [u[0] - dn * n[0], u[1] - dn * n[1], u[2] - dn * n[2]];
      const plane = add("PLANE(''," + add("AXIS2_PLACEMENT_3D(''," + pt(P0) + ',' + dir(n) + ',' + dir(Math.hypot(...ref) > 1e-12 ? ref : Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]) + ')') + ')');
      faces.push(add("ADVANCED_FACE('',(" + bounds.join(',') + '),' + plane + ',.T.)'));
    });
    const origin = add("AXIS2_PLACEMENT_3D(''," + pt([0, 0, 0]) + ',' + dir([0, 0, 1]) + ',' + dir([1, 0, 0]) + ')');
    let rep;
    if (closed) {
      const solid = add("MANIFOLD_SOLID_BREP(''," + add("CLOSED_SHELL('',(" + faces.join(',') + '))') + ')');
      rep = add("ADVANCED_BREP_SHAPE_REPRESENTATION(''," + '(' + origin + ',' + solid + '),' + gctx + ')');
    } else {
      const sm = add("SHELL_BASED_SURFACE_MODEL('',(" + add("OPEN_SHELL('',(" + faces.join(',') + '))') + '))');
      rep = add("MANIFOLD_SURFACE_SHAPE_REPRESENTATION(''," + '(' + origin + ',' + sm + '),' + gctx + ')');
    }
    add('SHAPE_DEFINITION_REPRESENTATION(' + pds + ',' + rep + ')');
    const stamp = new Date().toISOString().slice(0, 19);
    return ['ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('Adapter Assembler'),'2;1');",
      "FILE_NAME('" + name + ".step','" + stamp + "',(''),(''),'Adapter Assembler','Adapter Assembler','');",
      "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));", 'ENDSEC;', 'DATA;',
      ...E.map((s, i) => '#' + (i + 1) + '=' + s + ';'), 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n');
  }
  function ngonFaces(tris, uniq, nrm, count, tolerance) {
    const nU = uniq.length, owner = new Map();
    for (let t = 0; t < count; t++) for (let k = 0; k < 3; k++) owner.set(tris[t * 3 + k] * nU + tris[t * 3 + (k + 1) % 3], t);
    const region = new Int32Array(count).fill(-1), tolP = Math.max(tolerance || 0, 1e-7) * 2, faces = [];
    const triFace = (t) => [tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]];
    // the outlines of a set of triangles: closed loops of directed edges, or null if a point is pinched
    const outlines = (list) => {
      const inSet = new Set(), next = new Map();
      for (const t of list) for (let k = 0; k < 3; k++) inSet.add(tris[t * 3 + k] * nU + tris[t * 3 + (k + 1) % 3]);
      for (const t of list) for (let k = 0; k < 3; k++) {
        const a = tris[t * 3 + k], b = tris[t * 3 + (k + 1) % 3];
        if (inSet.has(b * nU + a)) continue;
        if (next.has(a)) return null;
        next.set(a, b);
      }
      const loops = [], used = new Set();
      for (const s of next.keys()) {
        if (used.has(s)) continue;
        const loop = [];
        let v = s;
        while (!used.has(v)) { used.add(v); loop.push(v); v = next.get(v); if (v === undefined) return null; }
        if (v !== s) return null;
        loops.push(loop);
      }
      return loops;
    };
    // pieces of a set of triangles that hang together across shared edges
    const components = (list) => {
      const inList = new Map(list.map((t, i) => [t, i])), seen = new Uint8Array(list.length), out = [];
      for (let i = 0; i < list.length; i++) {
        if (seen[i]) continue;
        seen[i] = 1;
        const comp = [list[i]];
        for (let q = 0; q < comp.length; q++) {
          const t = comp[q];
          for (let k = 0; k < 3; k++) {
            const o = owner.get(tris[t * 3 + (k + 1) % 3] * nU + tris[t * 3 + k]), j = o === undefined ? undefined : inList.get(o);
            if (j !== undefined && !seen[j]) { seen[j] = 1; comp.push(o); }
          }
        }
        out.push(comp);
      }
      return out;
    };
    const emit = (list, n, depth) => {
      if (list.length === 1) { faces.push(triFace(list[0])); return; }
      const loops = outlines(list);
      if (loops && loops.length === 1 && loops[0].length >= 3) { faces.push(loops[0]); return; }
      if (depth >= 10) { for (const t of list) faces.push(triFace(t)); return; }
      // split across the middle, alternating between two directions in the face's plane
      const ax = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      let u = [n[1] * ax[2] - n[2] * ax[1], n[2] * ax[0] - n[0] * ax[2], n[0] * ax[1] - n[1] * ax[0]];
      if (depth % 2) u = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
      const cen = (t) => { const A = uniq[tris[t * 3]], B = uniq[tris[t * 3 + 1]], C = uniq[tris[t * 3 + 2]]; return ((A[0] + B[0] + C[0]) * u[0] + (A[1] + B[1] + C[1]) * u[1] + (A[2] + B[2] + C[2]) * u[2]) / 3; };
      const cs = list.map(cen), mid = cs.reduce((s, c) => s + c, 0) / cs.length;
      const lo = list.filter((t, i) => cs[i] < mid), hi = list.filter((t, i) => cs[i] >= mid);
      if (!lo.length || !hi.length) { if (depth % 2 === 0) { emit(list, n, depth + 1); return; } for (const t of list) faces.push(triFace(t)); return; }
      for (const half of [lo, hi]) for (const comp of components(half)) emit(comp, n, depth + 1);
    };
    for (let s = 0; s < count; s++) {
      if (region[s] >= 0) continue;
      region[s] = s;
      const n = [nrm[s * 3], nrm[s * 3 + 1], nrm[s * 3 + 2]], A = uniq[tris[s * 3]], d0 = n[0] * A[0] + n[1] * A[1] + n[2] * A[2], list = [s];
      for (let q = 0; q < list.length; q++) {
        const t = list[q];
        for (let k = 0; k < 3; k++) {
          const o = owner.get(tris[t * 3 + (k + 1) % 3] * nU + tris[t * 3 + k]);
          if (o === undefined || region[o] >= 0) continue;
          if (n[0] * nrm[o * 3] + n[1] * nrm[o * 3 + 1] + n[2] * nrm[o * 3 + 2] < 1 - 1e-6) continue;
          let flat = true;
          for (let c = 0; c < 3 && flat; c++) { const V = uniq[tris[o * 3 + c]]; flat = Math.abs(n[0] * V[0] + n[1] * V[1] + n[2] * V[2] - d0) <= tolP; }
          if (!flat) continue;
          region[o] = s; list.push(o);
        }
      }
      emit(list, n, 0);
    }
    return faces;
  }
  // ---------------------------------------------------------------------------
  // 3b. Outline checks (page).
  // ---------------------------------------------------------------------------
  function polygonSelfIntersects(poly) {
    const n = poly.length;
    const cross = (a, b, c) => (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y);
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const c = poly[j], d = poly[(j + 1) % n];
        const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
        if (((d1 > 1e-12 && d2 < -1e-12) || (d1 < -1e-12 && d2 > 1e-12)) && ((d3 > 1e-12 && d4 < -1e-12) || (d3 < -1e-12 && d4 > 1e-12))) return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // 3c. Shared geometry (used on the page and inside the worker).
  //     A "profile" is a closed polygon in the (radius y, axial z) half-plane,
  //     in inches. Points may carry a bevel: { trim: d } (a straight
  //     chamfer) or { r, segs, out } (round bevel of radius r, segs edges,
  //     out = bulging outward / rounded, otherwise a cove), or { r, segs,
  //     shape: 'outA' | 'outB' } (a flare outside the corner: the edge toward
  //     the next point (outA) or the previous one (outB) carried on straight
  //     past the corner, and a cove of radius r joining it to the other edge).
  // ---------------------------------------------------------------------------
  // (the Measurement view's perfect drawing: round bevels as true arcs, whatever their edge count; never set inside
  // the worker, where it does not exist)
  let ARC_PERFECT = false;
  // Tangent distance a bevel wants at corner P (how far it eats into each edge).
  function bevelReach(A, P, B, bv) {
    if (!bv || P.y < 1e-9) return 0;
    const ax = A.y - P.y, az = A.z - P.z, bx = B.y - P.y, bz = B.z - P.z, la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la < 1e-9 || lb < 1e-9) return 0;
    if (bv.trim) return bv.trim;
    if (!(bv.r > 0)) return 0;
    const ang = Math.acos(Math.max(-1, Math.min(1, (ax * bx + az * bz) / (la * lb))));
    if (ang < 1e-3 || Math.PI - ang < 1e-3) return 0;
    if (bv.shape === 'outA' || bv.shape === 'outB') return bv.r / Math.tan((Math.PI - ang) / 2);   // how far along the edge its cove touches
    return bv.r / Math.tan(ang / 2);
  }
  function cornerPoints(A, P, B, bv, tFix) {
    if (!bv || P.y < 1e-9) return [{ y: P.y, z: P.z }];
    const ax = A.y - P.y, az = A.z - P.z, bx = B.y - P.y, bz = B.z - P.z;
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la < 1e-9 || lb < 1e-9) return [{ y: P.y, z: P.z }];
    const u1 = [ax / la, az / la], u2 = [bx / lb, bz / lb];
    if (bv.trim) {
      const ba = tFix != null ? tFix : Math.min(bv.trim, la * 0.45), bb = tFix != null ? tFix : Math.min(bv.trim, lb * 0.45);
      return [{ y: P.y + u1[0] * ba, z: P.z + u1[1] * ba }, { y: P.y + u2[0] * bb, z: P.z + u2[1] * bb }];
    }
    if (!(bv.r > 0)) return [{ y: P.y, z: P.z }];
    const ang = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
    if (ang < 1e-3 || Math.PI - ang < 1e-3) return [{ y: P.y, z: P.z }];
    if (bv.shape === 'outA' || bv.shape === 'outB') {
      // a flare: one edge carried on straight past the corner, and a cove joining it to the other edge outside the part
      // (outward A: edge B carried on, the cove touching edge A; outward B: the other way round)
      const flip = bv.shape === 'outB', ua = flip ? u2 : u1, ub = flip ? u1 : u2, lA = flip ? lb : la;
      const ext = [-ub[0], -ub[1]];                         // edge B, carried on past the corner
      const open = Math.PI - ang, h2 = open / 2;            // the angle outside, between edge A and that extension
      if (h2 < 1e-3) return [{ y: P.y, z: P.z }];
      const t = Math.min(tFix != null ? tFix : bv.r / Math.tan(h2), lA * 0.9), r = t * Math.tan(h2);
      const T1 = [P.y + ua[0] * t, P.z + ua[1] * t], T2 = [P.y + ext[0] * t, P.z + ext[1] * t];
      const bx = ua[0] + ext[0], bz = ua[1] + ext[1], bl = Math.hypot(bx, bz), dd = r / Math.sin(h2);
      const C = [P.y + bx / bl * dd, P.z + bz / bl * dd];
      const a1 = Math.atan2(T1[1] - C[1], T1[0] - C[0]);
      let da = Math.atan2(T2[1] - C[1], T2[0] - C[0]) - a1;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      const segs = typeof ARC_PERFECT !== 'undefined' && ARC_PERFECT ? 96 : Math.max(1, Math.min(64, bv.segs | 0 || 1));
      let out = [];
      for (let i = 0; i <= segs; i++) { const a = a1 + da * i / segs; out.push({ y: C[0] + r * Math.cos(a), z: C[1] + r * Math.sin(a) }); }
      out.push({ y: P.y, z: P.z });                         // back along the carried-on edge to the corner
      if (flip) out = out.reverse();
      for (const p of out) if (p.y < 0) p.y = 0;
      return out;
    }
    const half = ang / 2;
    const t = tFix != null ? tFix : Math.min(bv.r / Math.tan(half), la * 0.45, lb * 0.45), r = t * Math.tan(half);
    const T1 = [P.y + u1[0] * t, P.z + u1[1] * t], T2 = [P.y + u2[0] * t, P.z + u2[1] * t];
    const segs = typeof ARC_PERFECT !== 'undefined' && ARC_PERFECT ? 96 : Math.max(1, Math.min(64, bv.segs | 0 || 1));
    let out;
    if (segs === 1) out = [{ y: T1[0], z: T1[1] }, { y: T2[0], z: T2[1] }];
    else {
      const bx2 = u1[0] + u2[0], bz2 = u1[1] + u2[1], bl = Math.hypot(bx2, bz2), d = r / Math.sin(half);
      const C = [P.y + bx2 / bl * d, P.z + bz2 / bl * d];
      const a1 = Math.atan2(T1[1] - C[1], T1[0] - C[0]);
      let da = Math.atan2(T2[1] - C[1], T2[0] - C[0]) - a1;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      out = [];
      for (let i = 0; i <= segs; i++) { const a = a1 + da * i / segs; out.push({ y: C[0] + r * Math.cos(a), z: C[1] + r * Math.sin(a) }); }
      if (!bv.out) {
        // cove: mirror the rounded corner across the chord between the two tangent points
        const cx = T2[0] - T1[0], cz = T2[1] - T1[1], cl2 = cx * cx + cz * cz;
        for (const p of out) {
          const s = ((p.y - T1[0]) * cx + (p.z - T1[1]) * cz) / cl2, fy = T1[0] + cx * s, fz = T1[1] + cz * s;
          p.y = 2 * fy - p.y; p.z = 2 * fz - p.z;
        }
      }
    }
    for (const p of out) if (p.y < 0) p.y = 0;
    return out;
  }

  // Loop of items for revolving: plain points (bevels expanded) and thread bands.
  function expandProfile(pts, runs) {
    const np = pts.length, inRun = new Int32Array(np).fill(-1);
    if (!np) return [];                  // (a geometric object has no profile)
    (runs || []).forEach((r, ri) => { for (let k = r.start; k <= r.end; k++) inRun[k] = ri; });
    let s0 = 0; while (s0 < np && inRun[s0] >= 0) s0++;
    if (s0 === np) throw new Error('profile is all thread');
    // Bevels may reach past the middle of an edge; when the two bevels on one edge
    // overlap, the most recently set one keeps its size and the other shrinks.
    const want = new Float64Array(np), pri = new Float64Array(np), bvAt = [];
    for (let i = 0; i < np; i++) {
      const prev = (i - 1 + np) % np, next = (i + 1) % np;
      const bv = inRun[i] < 0 && inRun[prev] < 0 && inRun[next] < 0 ? pts[i].bevel : null;
      bvAt[i] = bv;
      want[i] = bv ? bevelReach(pts[prev], pts[i], pts[next], bv) : 0;
      pri[i] = bv ? (bv.pri || 0) : 0;
    }
    const reach = Float64Array.from(want);
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < np; i++) {
        const j = (i + 1) % np;
        const L = Math.hypot(pts[j].y - pts[i].y, pts[j].z - pts[i].z);
        if (reach[i] > L) reach[i] = L;
        if (reach[j] > L) reach[j] = L;
        if (reach[i] + reach[j] > L) {
          if (pri[i] >= pri[j]) reach[j] = Math.max(0, L - reach[i]); else reach[i] = Math.max(0, L - reach[j]);
        }
      }
    }
    const items = [];
    for (let c = 0; c < np; c++) {
      const i = (s0 + c) % np;
      if (inRun[i] >= 0) {
        if (i === runs[inRun[i]].start) {
          const r = runs[inRun[i]];
          items.push({ band: { rFirst: r.rFirst, rOther: r.rOther, zFirst: r.zFirst, zLast: r.zLast, pitch: r.pitch, hand: r.hand, flatA: r.flatA || 0, flatB: r.flatB || 0,
            inner: r.kind === 'internal', dir: Math.sign(r.zLast - r.zFirst) || 1, zMin: Math.min(r.zFirst, r.zLast), zMax: Math.max(r.zFirst, r.zLast), runout: r.runout || null } });
        }
        continue;
      }
      const prev = (i - 1 + np) % np, next = (i + 1) % np, bv = bvAt[i];
      const used = bv && reach[i] > 1e-9;
      // points made by a bevel remember their corner (the editor uses this to grab the bevel)
      for (const p of cornerPoints(pts[prev], pts[i], pts[next], used ? bv : null, bv ? reach[i] : null)) items.push(used ? { y: p.y, z: p.z, corner: i } : p);
    }
    // Optimize the outline: merge consecutive points closer than 0.00001 in.
    const out = [];
    for (const it of items) {
      const last = out[out.length - 1];
      if (last && !last.band && !it.band && Math.hypot(last.y - it.y, last.z - it.z) < 1e-5) continue;
      out.push(it);
    }
    while (out.length > 3) {
      const a = out[out.length - 1], b = out[0];
      if (!a.band && !b.band && Math.hypot(a.y - b.y, a.z - b.z) < 1e-5) out.pop(); else break;
    }
    return out;
  }

  // One period of a thread tooth, as (phase, radius) corners measured upward from zFirst:
  // an optional flat at rFirst (flatA × pitch), a flank, an optional flat at rOther (flatB × pitch),
  // and the return flank. Without flats this is a plain zig-zag.
  function toothPattern(r) {
    const P = r.pitch, fa = Math.max(0, r.flatA || 0) * P, fb = Math.max(0, r.flatB || 0) * P, fl = Math.max(0, (P - fa - fb) / 2);
    const out = [{ u: 0, r: r.rFirst, g: 'first' }];
    if (fa > 1e-12) out.push({ u: fa, r: r.rFirst, g: 'first' });
    out.push({ u: fa + fl, r: r.rOther, g: 'other' });
    if (fb > 1e-12) out.push({ u: fa + fl + fb, r: r.rOther, g: 'other' });
    return out;
  }
  function toothAt(r, pat, u) {
    const P = r.pitch, t = ((u % P) + P) % P;
    for (let e = 0; e < pat.length; e++) {
      const a = pat[e], b = e + 1 < pat.length ? pat[e + 1] : { u: P, r: pat[0].r };
      if (t >= a.u - 1e-12 && t <= b.u + 1e-12) return b.u - a.u < 1e-12 ? a.r : a.r + (b.r - a.r) * (t - a.u) / (b.u - a.u);
    }
    return pat[0].r;
  }
  // Lead-in (run-out) of a thread's end: within a pitch of a tapered end the teeth are offset inward, toward
  // their root, a little more the nearer the end, until nothing is left at the end face. An offset keeps the
  // flank angles, so each tooth narrows about its own centre as it retracts. (Replaces the old cone cut.)
  function runoutOf(node, r) {
    const q = node && node.params;
    if (!q || node.type !== 'thread' || !(q.taperTop || q.taperBottom) || !r) return null;
    const internal = q.kind === 'internal', root = internal ? Math.max(r.rFirst, r.rOther) : Math.min(r.rFirst, r.rOther);
    const crest = internal ? Math.min(r.rFirst, r.rOther) : Math.max(r.rFirst, r.rOther), depth = Math.abs(crest - root);
    if (!(depth > 1e-9)) return null;
    const fl = Math.max(1e-9, (1 - (r.flatA || 0) - (r.flatB || 0)) / 2 * r.pitch);
    return { top: !!q.taperTop, bottom: !!q.taperBottom, root, s: Math.sign(crest - root), depth, fl, k: fl / depth, len: r.pitch,
      zMin: Math.min(r.zFirst, r.zLast), zMax: Math.max(r.zFirst, r.zLast) };
  }
  // a thread node's runs, with their run-out
  function runsOf(node) { return (node.runs || []).map(r => { const ro = runoutOf(node, r); return ro ? { ...r, runout: ro } : r; }); }
  // how far inward the teeth are offset at height z
  function runoutDelta(ro, z) {
    let t = 0;
    if (ro.top) t = Math.max(t, 1 - (ro.zMax - z) / ro.len);
    if (ro.bottom) t = Math.max(t, 1 - (z - ro.zMin) / ro.len);
    return ro.depth * Math.max(0, Math.min(1, t));
  }
  // The tooth pattern with each corner knowing its tooth: root corners which way their flank rises (a sharp root
  // is split in two, so it can open into a flat), and every corner the offset c from it to its tooth's centre, so
  // a whole tooth is offset by the same amount and shrinks evenly about its centre.
  function runoutPattern(b) {
    const ro = b.runout, base = toothPattern(b), n = base.length, P = b.pitch, isRoot = (e) => Math.abs(e.r - ro.root) < 1e-12, out = [];
    // the crest's centre in the period (the middle of its flat, or its tip)
    const crests = base.filter(e => !isRoot(e)), uc = crests.length ? (crests[0].u + crests[crests.length - 1].u) / 2 : P / 2;
    for (let i = 0; i < n; i++) {
      const e = base[i], pR = isRoot(base[(i - 1 + n) % n]), nR = isRoot(base[(i + 1) % n]);
      if (!isRoot(e)) { out.push({ ...e, kind: 'crest', c: uc - e.u }); continue; }
      const toward = (dir, u) => { let c = uc; while (dir > 0 ? c < u : c > u) c += dir * P; while (dir > 0 ? c - P >= u : c + P <= u) c -= dir * P; return c - u; };
      if (!pR && !nR) { out.push({ ...e, kind: 'root', dir: -1, c: toward(-1, e.u) }); const u2 = e.u + 1e-7 * P; out.push({ ...e, u: u2, kind: 'root', dir: 1, c: toward(1, u2) }); }
      else { const dir = nR ? -1 : 1; out.push({ ...e, kind: 'root', dir, c: toward(dir, e.u) }); }
    }
    out.uc = uc;
    return out;
  }
  // The thread's radius at any height z (on a band, with the helix shift at that angle), the tooth there sunk
  // by the amount at its own centre: used where the band ends, so a tooth crossing an end face is cut there as
  // it stands rather than dropped to the root early.
  function runoutRadiusAt(b, pat, z, shift) {
    const ro = b.runout, P = b.pitch, uu = z - b.zFirst - shift, r0 = toothAt(b, pat, uu);
    let dc = pat.uc - (((uu % P) + P) % P);
    if (dc > P / 2) dc -= P; else if (dc < -P / 2) dc += P;
    return ro.root + ro.s * Math.max(0, ro.s * (r0 - ro.root) - runoutDelta(ro, z + dc));
  }
  // a corner after the offset: root corners slide along the root toward their flank, the rest move toward the root.
  // The offset is the one at the corner's tooth centre (z + e.c), the same for the whole tooth.
  function runoutCorner(ro, e, z) {
    const dl = runoutDelta(ro, z + (e.c || 0));
    if (!(dl > 0)) return { r: e.r, z };
    if (e.kind === 'root') return { r: e.r, z: Math.max(ro.zMin, Math.min(ro.zMax, z + e.dir * Math.min(ro.fl * (1 - 1e-6), dl * ro.k))) };
    return { r: ro.root + ro.s * Math.max(0, ro.s * (e.r - ro.root) - dl), z };
  }
  // Tooth corners as drawn at angle 0, ordered along the run (first, middles, last).
  function runVertices(r) {
    const dir = Math.sign(r.zLast - r.zFirst) || 1, P = r.pitch, pat = toothPattern(r);
    const zMin = Math.min(r.zFirst, r.zLast), zMax = Math.max(r.zFirst, r.zLast);
    const mids = [];
    const mLo = Math.floor((zMin - r.zFirst) / P) - 1, mHi = Math.ceil((zMax - r.zFirst) / P) + 1;
    for (let m = mLo; m <= mHi; m++) for (const e of pat) {
      const z = r.zFirst + m * P + e.u;
      if (z - zMin > 1e-7 && zMax - z > 1e-7) mids.push({ y: e.r, z, role: 'mid', group: e.g });
    }
    mids.sort((a, b) => dir * (a.z - b.z));
    const yl = toothAt(r, pat, r.zLast - r.zFirst);
    const gl = Math.abs(yl - r.rFirst) < 1e-9 ? 'first' : Math.abs(yl - r.rOther) < 1e-9 ? 'other' : null;
    return [{ y: r.rFirst, z: r.zFirst, role: 'first', group: 'first' }, ...mids, { y: yl, z: r.zLast, role: 'last', group: gl }];
  }

  // Flat outline of a profile (bevels expanded, threads drawn as at angle 0).
  function outlineOf(pts, runs) {
    const out = [];
    for (const it of expandProfile(pts, runs)) {
      if (it.band) for (const v of runVertices(it.band)) out.push({ y: v.y, z: v.z });
      else out.push(it);
    }
    return out;
  }

  // Outline generated from the parameters of a circular / n-sided object.
  function paramProfile(p) {
    const z0 = p.z, z1 = p.z + p.h;
    const rib = p.rib, rit = p.linkIn ? p.rib : p.rit, rob = p.rob, rot = p.linkOut ? p.rob : p.rot;
    const bv = p.bevel > 0 ? { r: p.bevel, segs: p.bevelSegs, out: p.bevelOut, ...(p.bevelShape ? { shape: p.bevelShape } : {}) } : null;
    return [{ y: rib, z: z0 }, { y: rob, z: z0 }, { y: rot, z: z1 }, { y: rit, z: z1 }]
      .map(q => ({ y: Math.max(0, q.y), z: q.z, bevel: bv && q.y > 1e-9 ? { ...bv } : null }));
  }

  // Revolve a loop of items into an indexed, outward-facing, closed mesh.
  //   segments: columns around the axis; scale: radius factor at the columns
  //   (n-sided objects sized about their face centres); phase: start angle;
  //   helical: thread bands climb (hand ±1) or stay rings (false).
  function revolve(items, opts) {
    const A = opts.angles, N = A ? A.length : Math.max(3, opts.segments | 0), TAU = Math.PI * 2, scale = opts.scale || 1, phase = opts.phase || 0;
    const V = [], axisCache = new Map(), warp = opts.warp;
    let col = 0;
    function vert(r, z, phi) {
      r = warp ? warp(r, col) : r * scale;
      if (r < 1e-12) {
        const k = String(z); let id = axisCache.get(k);
        if (id === undefined) { id = V.length / 3; V.push(0, 0, z); axisCache.set(k, id); }
        return id;
      }
      V.push(r * Math.cos(phi + phase), r * Math.sin(phi + phase), z);
      return V.length / 3 - 1;
    }
    const pats = new Map();
    const patOf = (b) => { let p = pats.get(b); if (!p) { p = b.runout ? runoutPattern(b) : toothPattern(b); pats.set(b, p); } return p; };
    const hand = (b) => opts.helical ? (b.hand || 0) : 0;
    // A female thread's surface is made of flat facets between the columns, which lie inside the circle through
    // its points, into the hole: its points go out by the facets' sag, so the facets lie on the circle and the hole
    // is never smaller than drawn. (A male's facets only lie inside its material.)
    const SAG = 1 / Math.cos(Math.PI / N);
    function column(j) {
      col = j;
      const phi = A ? A[j] : TAU * j / N, out = [];
      items.forEach((it, pi) => {
        if (!it.band) { out.push({ id: vert(it.y, it.z, phi), key: [pi, 0] }); return; }
        const b = it.band, shift = hand(b) * b.pitch * phi / TAU, d = b.dir, P = b.pitch, pat = patOf(b), ro = b.runout, kf = b.inner && !warp ? SAG : 1;
        const zs = d > 0 ? b.zMin : b.zMax, ze = d > 0 ? b.zMax : b.zMin;
        const endR = (z) => ro ? runoutRadiusAt(b, pat, z, shift) : toothAt(b, pat, z - b.zFirst - shift);
        out.push({ id: vert(endR(zs) * kf, zs, phi), key: [pi, -Infinity] });
        // tooth corners lie on helices: z = zFirst + (m·pitch + corner phase) + shift
        const mLo = Math.floor((b.zMin - b.zFirst - shift) / P) - 1, mHi = Math.ceil((b.zMax - b.zFirst - shift) / P) + 1;
        const vs = [];
        for (let m = mLo; m <= mHi; m++) for (const e of pat) {
          const uu = m * P + e.u, z = b.zFirst + uu + shift;
          const c = ro ? runoutCorner(ro, e, z) : { r: e.r, z };
          if (c.z - b.zMin > 1e-7 && b.zMax - c.z > 1e-7) vs.push({ uu, z, c });
        }
        vs.sort((x, y) => d * (x.z - y.z));
        for (const v of vs) out.push({ id: vert(v.c.r * kf, v.c.z, phi), key: [pi, d * (b.zFirst + v.uu)] });
        out.push({ id: vert(endR(ze) * kf, ze, phi), key: [pi, Infinity] });
      });
      return out;
    }
    const cmp = (a, b) => a[0] !== b[0] ? a[0] - b[0] : (a[1] === b[1] ? 0 : (a[1] < b[1] ? -1 : 1));
    const T = [];
    function zipper(A, B) {
      const end = items.length;
      const a = A.concat([{ id: A[0].id, key: [end, 0] }]), b = B.concat([{ id: B[0].id, key: [end, 0] }]);
      let i = 0, k = 0;
      while (i < a.length - 1 || k < b.length - 1) {
        let adv;
        if (i === a.length - 1) adv = 'b';
        else if (k === b.length - 1) adv = 'a';
        else { const c = cmp(a[i + 1].key, b[k + 1].key); adv = c < 0 ? 'a' : c > 0 ? 'b' : 'both'; }
        if (adv === 'a' || adv === 'both') { T.push(a[i].id, b[k].id, a[i + 1].id); i++; }
        if (adv === 'b' || adv === 'both') { T.push(a[i].id, b[k].id, b[k + 1].id); k++; }
      }
    }
    const first = column(0);
    let prev = first;
    for (let j = 1; j <= N; j++) {
      const cur = j < N ? column(j) : first.map(c => {
        const it = items[c.key[0]];
        return it.band && isFinite(c.key[1]) ? { id: c.id, key: [c.key[0], c.key[1] - it.band.dir * hand(it.band) * it.band.pitch] } : c;
      });
      zipper(prev, cur);
      prev = cur;
    }
    const tris = [];
    for (let t = 0; t < T.length; t += 3) { const a = T[t], b = T[t + 1], c = T[t + 2]; if (a !== b && b !== c && a !== c) tris.push(a, b, c); }
    let vol = 0;
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
      vol += V[a] * (V[b + 1] * V[c + 2] - V[b + 2] * V[c + 1]) - V[a + 1] * (V[b] * V[c + 2] - V[b + 2] * V[c]) + V[a + 2] * (V[b] * V[c + 1] - V[b + 1] * V[c]);
    }
    if (vol < 0) for (let t = 0; t < tris.length; t += 3) { const x = tris[t + 1]; tris[t + 1] = tris[t + 2]; tris[t + 2] = x; }
    return { V, T: tris };
  }

  // Hole cylinders of imported profiles (radius, length, transform list), as indexed meshes.
  function holeMesh(h) {
    const mul = (A, B) => { const C = new Array(16).fill(0); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) C[r * 4 + c] += A[r * 4 + k] * B[k * 4 + c]; return C; };
    const rot = (axis, deg) => {
      const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
      if (axis === 'x') return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1];
      if (axis === 'y') return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1];
      return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    };
    if (h.type !== 'cylinder' && h.type !== 'square') throw new Error('unknown hole type: ' + h.type);
    let M = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (const t of h.transform || []) {
      if (t.type === 'translate') M = mul(M, [1, 0, 0, t.x || 0, 0, 1, 0, t.y || 0, 0, 0, 1, t.z || 0, 0, 0, 0, 1]);
      else if (t.type === 'rotate') M = mul(mul(mul(M, rot('x', t.x || 0)), rot('y', t.y || 0)), rot('z', t.z || 0));
      else throw new Error('unknown transform: ' + t.type);
    }
    const segs = h.type === 'square' ? 4 : 15, V = [], T = [];
    const P = (x, y, z) => { V.push(M[0] * x + M[1] * y + M[2] * z + M[3], M[4] * x + M[5] * y + M[6] * z + M[7], M[8] * x + M[9] * y + M[10] * z + M[11]); return V.length / 3 - 1; };
    const b0 = P(0, 0, 0), t0 = P(0, 0, h.length), ring = [];
    for (let i = 0; i < segs; i++) { const a = Math.PI * 2 * i / segs; ring.push([P(Math.sin(a) * h.radius, Math.cos(a) * h.radius, 0), P(Math.sin(a) * h.radius, Math.cos(a) * h.radius, h.length)]); }
    for (let i = 0; i < segs; i++) {
      const [a0, a1] = ring[i], [c0, c1] = ring[(i + 1) % segs];
      T.push(a0, c0, c1, a0, c1, a1, b0, c0, a0, t0, a1, c1);
    }
    let vol = 0;
    for (let t = 0; t < T.length; t += 3) { const a = T[t] * 3, b = T[t + 1] * 3, c = T[t + 2] * 3; vol += V[a] * (V[b + 1] * V[c + 2] - V[b + 2] * V[c + 1]) - V[a + 1] * (V[b] * V[c + 2] - V[b + 2] * V[c]) + V[a + 2] * (V[b] * V[c + 1] - V[b + 1] * V[c]); }
    if (vol < 0) for (let t = 0; t < T.length; t += 3) { const x = T[t + 1]; T[t + 1] = T[t + 2]; T[t + 2] = x; }
    return { V, T };
  }

  // Outline of a thread object: a ring with an ISO-style (or plain V) thread on its outside
  // (external) or inside (internal) surface. All lengths in inches.
  function threadProfile(q) {
    const P = q.pitch, L = Math.max(P, q.turns * P), z0 = q.z, z1 = q.z + L, c = q.clearance || 0, iso = q.profile !== 'v';
    // solid material behind the teeth (inside a male thread, outside a female one): a multiple of the depth
    q = { ...q, wall: q.backing != null ? q.backing * q.depth : q.wall };
    // Each kind is made to take a standard (ISO) thread of the other kind: a male's crests sit at the standard major
    // diameter and its depth runs inward from there; a female's crests sit at the standard minor diameter
    // (d − 1.0825 × pitch, the innermost a standard male leaves free) and its depth runs outward. With the ISO
    // profile that is the basic profile of each; a sharp V female then has its sharp crests at the minor diameter
    // and its roots past the major, so it never reaches into a standard male's roots or flanks.
    if (q.kind === 'internal') {
      const rCrest = Math.max(0, q.d / 2 + c - 5 * Math.sqrt(3) / 16 * P), rRoot = rCrest + q.depth, rOut = rRoot + Math.max(0.001, q.wall);
      return {
        pts: [{ y: rOut, z: z0, bevel: null }, { y: rOut, z: z1, bevel: null }, { y: rCrest, z: z1, bevel: null }, { y: rCrest, z: z0, bevel: null }],
        runs: [{ start: 2, end: 3, rFirst: rCrest, rOther: rRoot, zFirst: z1, zLast: z0, pitch: P, pitchDrawn: P, hand: q.hand || 1,
          flatA: iso ? 0.25 : 0, flatB: iso ? 0.125 : 0, kind: 'internal', label: 'Thread' }],
      };
    }
    const rCrest = q.d / 2 - c, rRoot = Math.max(0, rCrest - q.depth), rIn = Math.max(0, rRoot - Math.max(0.001, q.wall));
    return {
      pts: [{ y: rIn, z: z0, bevel: null }, { y: rRoot, z: z0, bevel: null }, { y: rRoot, z: z1, bevel: null }, { y: rIn, z: z1, bevel: null }],
      runs: [{ start: 1, end: 2, rFirst: rRoot, rOther: rCrest, zFirst: z0, zLast: z1, pitch: P, pitchDrawn: P, hand: q.hand || 1,
        flatA: iso ? 0.25 : 0, flatB: iso ? 0.125 : 0, kind: 'external', label: 'Thread' }],
    };
  }

  // A cog (spur gear with involute teeth), seen from above: its outline as radii at increasing angles over one
  // turn, one tooth per 2π/teeth. q: teeth, module, pressure (°), addendum and dedendum (× module), backlash
  // (taken off each tooth at the pitch circle), rotation (°). perFlank: points along each tooth side.
  // An internal cog (ring gear, teeth pointing inward): the spaces between its teeth have the shape of an outside
  // cog's teeth, so it is built as that shape (addendum and dedendum swapped, backlash widening the spaces),
  // turned half a tooth so its teeth sit where an outside cog's would.
  //   prec: circular precision (edges round a full circle): it sets the steps along the root and tip circles and
  //   the roundings, and how many points each tooth side gets.
  function cogShape(q, prec) {
    if (q.kind === 'internal') {
      const n = Math.max(3, Math.round(q.teeth) || 3), m = Math.max(1e-4, q.module);
      const s = cogShape({ ...q, kind: 'external', addendum: q.dedendum, dedendum: q.addendum, backlash: -(q.backlash || 0), rotation: (q.rotation || 0) + 180 / n,
        toothWidth: 1 - (q.toothWidth > 0 ? q.toothWidth : 0.5),
        tipRound: q.rootRound, rootRound: q.tipRound }, prec);
      return { ...s, ra: s.rf, rf: s.ra, tip: m * (n / 2 - Math.max(0, q.addendum)), internal: true, corners: { tip: s.corners.root, root: s.corners.tip } };
    }
    const N = Math.max(3, Math.round(q.teeth) || 3), m = Math.max(1e-4, q.module), al = Math.max(1, Math.min(45, q.pressure || 20)) * Math.PI / 180;
    const rp = m * N / 2, rb = rp * Math.cos(al), ra0 = rp + Math.max(0, q.addendum) * m, rf = Math.max(m * 0.05, rp - Math.max(0, q.dedendum) * m);
    const inv = (a) => Math.tan(a) - a, half = Math.PI / N;
    // toothWidth: the tooth's share of the circular pitch, at the pitch circle (½ = teeth as wide as the gaps)
    const tw = Math.max(0.05, Math.min(0.95, q.toothWidth > 0 ? q.toothWidth : 0.5));
    const psiP = Math.max(1e-4, (Math.PI * m * tw - (q.backlash || 0)) / (2 * rp));
    const psiInv = (r) => psiP + inv(al) - inv(Math.acos(Math.min(1, rb / r)));      // half the tooth's angle at radius r (r ≥ rb)
    // a tooth too thin for its tip ends in a point
    let ra = ra0;
    if (psiInv(ra) < 0) { let lo = Math.max(rb, rf), hi = ra; for (let k = 0; k < 50; k++) { const mid = (lo + hi) / 2; if (psiInv(mid) > 0) lo = mid; else hi = mid; } ra = lo; }
    const r0 = Math.max(rb, rf), psiB = psiInv(r0);
    // below the base circle the side runs down to the root, widening a little into it (a simple fillet)
    const fil = rf < rb ? Math.max(0, 0.25 * (half - psiB)) : 0;
    // (never past the middle of the gap: teeth too wide for their pitch meet their neighbours there)
    const psi = (r) => Math.min(0.995 * half, r >= r0 ? psiInv(r) : psiB + fil * (r0 - r) / Math.max(1e-12, r0 - rf));
    const P = Math.max(8, Math.min(300, Math.round(prec) || 100)), step = 2 * Math.PI / P;
    const K = Math.max(2, Math.min(40, Math.round(P / 10))), side = [];
    if (rf < rb) for (let i = 0; i < 2; i++) side.push(rf + (r0 - rf) * i / 2);
    for (let i = 0; i <= K; i++) side.push(r0 + (ra - r0) * (1 - Math.cos(Math.PI / 2 * i / K)));   // denser near the base
    const arc = (a0, a1) => Math.max(1, Math.ceil((a1 - a0) / step));
    let tooth = [];
    const psiR = psi(rf), psiA = Math.max(0, psi(ra)), mark = {};
    const push = (a, r) => { if (!tooth.length || a - tooth[tooth.length - 1][0] > 1e-9) tooth.push([a, r]); };
    { const n = arc(-half, -psiR); for (let i = 0; i <= n; i++) push(-half + (half - psiR) * i / n, rf); }
    mark.rootL = tooth.length - 1;
    for (const r of side) push(-psi(r), r);
    mark.tipL = tooth.length - 1;
    { const n = arc(-psiA, psiA); for (let i = 0; i <= n; i++) push(-psiA + 2 * psiA * i / n, ra); }
    mark.tipR = tooth.length - 1;
    for (let i = side.length - 1; i >= 0; i--) push(psi(side[i]), side[i]);
    mark.rootR = tooth.length - 1;
    { const n = arc(psiR, half); for (let i = 0; i < n; i++) push(psiR + (half - psiR) * i / n, rf); }
    // rounded corners (vertical bevels): at the teeth's tips and in their roots, worked on the outline seen from above
    const C = tooth.map(([a, r]) => [r * Math.cos(a), r * Math.sin(a)]);
    const corner = (c) => {
      // (a corner at an end of the outline, as when the teeth have no sides: the neighbours wrap round the tooth)
      const nC = C.length, V = C[c], P = C[(c - 1 + nC) % nC], Q = C[(c + 1) % nC];
      if (nC < 3 || !V || !P || !Q) return { V: V || [0, 0], d1: [1, 0], d2: [1, 0], phi: 0, u: [-1, 0], k: 1 };
      const l1 = Math.hypot(V[0] - P[0], V[1] - P[1]) || 1, l2 = Math.hypot(Q[0] - V[0], Q[1] - V[1]) || 1;
      const d1 = [(V[0] - P[0]) / l1, (V[1] - P[1]) / l1], d2 = [(Q[0] - V[0]) / l2, (Q[1] - V[1]) / l2];
      const phi = Math.acos(Math.max(-1, Math.min(1, d1[0] * d2[0] + d1[1] * d2[1]))), bx = d2[0] - d1[0], by = d2[1] - d1[1], bl = Math.hypot(bx, by) || 1;
      // u: from the corner toward the rounding's middle; k: how far that is, per unit of radius
      return { V, d1, d2, phi, u: [bx / bl, by / bl], k: 1 / Math.max(1e-6, Math.cos(phi / 2)) - 1 };
    };
    const info = { tip: corner(mark.tipL), root: corner(mark.rootL) };
    const tr = Math.max(0, q.tipRound || 0), rr0 = Math.max(0, q.rootRound || 0);
    const sharp = tooth.slice();
    if ((tr > 0 || rr0 > 0) && mark.tipL - mark.rootL >= 1) try {
      // Round the leading side of the tooth, then mirror it, so both sides come out the same. Each rounding is a true
      // fillet: a circle touching the side of the tooth and the root (or tip) circle. When it is too big for half the
      // gap (or half the tip) it becomes the full round: centred on the gap's (or the tooth's) middle.
      const rootArc = C.slice(0, mark.rootL + 1), flank = C.slice(mark.rootL, mark.tipL + 1), tipArc = C.slice(mark.tipL);
      const S = [];
      for (let i = 0; i + 1 < flank.length; i++) {
        const P = flank[i], Q = flank[i + 1], L = Math.hypot(Q[0] - P[0], Q[1] - P[1]) || 1e-12, dd = [(Q[0] - P[0]) / L, (Q[1] - P[1]) / L];
        S.push({ P, Q, gap: [dd[1], -dd[0]], tooth: [-dd[1], dd[0]] });
      }
      const nrm = (v) => Math.hypot(v[0], v[1]);
      // nearest point of the tooth's side to O
      const foot = (O) => {
        let best = null;
        S.forEach((g, i) => {
          const vx = g.Q[0] - g.P[0], vy = g.Q[1] - g.P[1], L2 = vx * vx + vy * vy || 1e-24;
          const t = Math.max(0, Math.min(1, ((O[0] - g.P[0]) * vx + (O[1] - g.P[1]) * vy) / L2)), p = [g.P[0] + vx * t, g.P[1] + vy * t], dd = Math.hypot(O[0] - p[0], O[1] - p[1]);
          if (!best || dd < best.d) best = { p, d: dd, i, t };
        });
        return best;
      };
      // the centre at rho from the side (on the given side of it) and at radius target from the axis, searched from one end
      const along = (rho, side, target, fromTip) => {
        const order = S.map((_, i) => i); if (fromTip) order.reverse();
        for (const i of order) {
          const g = S[i], n = g[side], O0 = [g.P[0] + n[0] * rho, g.P[1] + n[1] * rho], O1 = [g.Q[0] + n[0] * rho, g.Q[1] + n[1] * rho];
          const f0 = nrm(O0) - target, f1 = nrm(O1) - target;
          if (f0 === 0 || f0 * f1 < 0 || f1 === 0) {
            const t = f0 === f1 ? 0 : f0 / (f0 - f1);
            return { O: [O0[0] + (O1[0] - O0[0]) * t, O0[1] + (O1[1] - O0[1]) * t], F: [g.P[0] + (g.Q[0] - g.P[0]) * t, g.P[1] + (g.Q[1] - g.P[1]) * t], i, t };
          }
        }
        return null;
      };
      const bisect = (g, lo, hi) => { let flo = g(lo); for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2, fm = g(m); if ((fm > 0) === (flo > 0)) { lo = m; flo = fm; } else hi = m; } return (lo + hi) / 2; };
      const arcPts = (O, A, B) => {
        const r = nrm([A[0] - O[0], A[1] - O[1]]), a0 = Math.atan2(A[1] - O[1], A[0] - O[0]);
        let da = Math.atan2(B[1] - O[1], B[0] - O[0]) - a0;
        while (da > Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        const m = Math.max(2, Math.ceil(Math.abs(da) / step)), out = [];
        for (let i = 0; i <= m; i++) out.push([O[0] + r * Math.cos(a0 + da * i / m), O[1] + r * Math.sin(a0 + da * i / m)]);
        return out;
      };
      const ang = (p) => Math.atan2(p[1], p[0]);
      let lower = null, upper = null;     // { pts (the rounding, in order of increasing angle), i, t: where it leaves the side }
      if (rr0 > 0) {
        let sol = along(rr0, 'gap', rf + rr0, false), A = sol && [sol.O[0] * rf / nrm(sol.O), sol.O[1] * rf / nrm(sol.O)];
        if (!sol || ang(A) <= -half + 1e-9) {
          // the full round: centred on the gap's middle, touching the root circle there
          const u = [Math.cos(-half), Math.sin(-half)], Oof = (r) => [u[0] * (rf + r), u[1] * (rf + r)];
          const r = bisect((x) => foot(Oof(x)).d - x, 0, ra - rf);
          const O = Oof(r), f = foot(O);
          sol = { O, F: f.p, i: f.i, t: f.t }; A = [u[0] * rf, u[1] * rf];
        }
        lower = { pts: arcPts(sol.O, A, sol.F), i: sol.i, t: sol.t };
      }
      if (tr > 0) {
        let sol = along(tr, 'tooth', ra - tr, true), B = sol && [sol.O[0] * ra / nrm(sol.O), sol.O[1] * ra / nrm(sol.O)];
        if (!sol || ang(B) >= -1e-9) {
          // the full round: centred on the tooth's middle (for a pointed tooth: the given radius, inside the point)
          const pointed = psiA < 1e-9;
          let O, top;
          if (pointed) { const x = bisect((xx) => foot([xx, 0]).d - tr, Math.max(rf, ra - 50 * tr), ra); O = [x, 0]; top = [x + tr, 0]; }
          else { const r = bisect((x) => foot([ra - x, 0]).d - x, 0, ra - rf); O = [ra - r, 0]; top = [ra, 0]; }
          const f = foot(O);
          sol = { O, F: f.p, i: f.i, t: f.t }; B = top;
        }
        upper = { pts: arcPts(sol.O, sol.F, B), i: sol.i, t: sol.t, end: B };
      }
      // the leading half: root arc, (rounding), side, (rounding), tip arc up to the middle
      const lead = [];
      const add = (p) => { const a = ang(p); if (a <= 1e-12 && (!lead.length || a - ang(lead[lead.length - 1]) > 1e-10)) lead.push(p); };
      const lowA = lower ? ang(lower.pts[0]) : Infinity;
      for (const p of rootArc) if (ang(p) < lowA - 1e-10) add(p);
      if (lower) lower.pts.forEach(add);
      const fromI = lower ? lower.i : 0, fromT = lower ? lower.t : 0, toI = upper ? upper.i : S.length - 1, toT = upper ? upper.t : 1;
      for (let i = fromI; i <= toI; i++) {
        const t0 = i === fromI ? fromT : 0, t1 = i === toI ? toT : 1, g = S[i];
        for (const t of [t0, t1]) add([g.P[0] + (g.Q[0] - g.P[0]) * t, g.P[1] + (g.Q[1] - g.P[1]) * t]);
      }
      if (upper) upper.pts.forEach(add);
      const upA = upper ? ang(upper.end) : -Infinity;
      for (const p of tipArc) if (ang(p) > upA + 1e-10) add(p);
      tooth = [];
      const polar = lead.map((p) => [ang(p), nrm(p)]);
      for (const [a, r] of polar) push(a, r);
      for (let i = polar.length - 1; i >= 1; i--) if (polar[i][0] < -1e-12) push(-polar[i][0], polar[i][1]);   // not the middle twice, nor the gap's middle
      if (tooth.length < 2) tooth = sharp;
    } catch (_) { tooth = sharp; }       // an outline too odd to round stays sharp
    const rot = (q.rotation || 0) * Math.PI / 180, ang = new Float64Array(N * tooth.length), rad = new Float64Array(N * tooth.length);
    for (let k = 0, o = 0; k < N; k++) for (const [a, r] of tooth) { ang[o] = rot + 2 * half * k + a; rad[o] = r; o++; }
    const cr = Math.cos(rot), sr = Math.sin(rot), turn = (v) => [v[0] * cr - v[1] * sr, v[0] * sr + v[1] * cr];
    const corners = {};
    for (const w of ['tip', 'root']) corners[w] = { V: turn(info[w].V), u: turn(info[w].u), k: info[w].k };
    return { ang, rad, N, rp, rb, ra, rf, tip: ra0, corners };
  }
  // The cog's radius at an angle (between its outline points).
  function cogRadiusAt(sh, theta) {
    const A = sh.ang, n = A.length, TAU = 2 * Math.PI, t = A[0] + ((((theta - A[0]) % TAU) + TAU) % TAU);
    let lo = 0, hi = n;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (A[mid] <= t) lo = mid; else hi = mid; }
    const a0 = A[lo], a1 = lo + 1 < n ? A[lo + 1] : A[0] + TAU, r1 = sh.rad[(lo + 1) % n];
    return sh.rad[lo] + (r1 - sh.rad[lo]) * (t - a0) / Math.max(1e-12, a1 - a0);
  }
  // A cog's profile is drawn with its outer edge at the tip radius; around the axis the outer edge follows the teeth,
  // and everything between the bore and the tip is stretched to match (the bore stays round).
  //   rFix: the edge that stays round (an outside cog's bore, an inside cog's rim); tip: the edge drawn at the teeth's tips.
  function cogWarp(y, R, rFix, tip) {
    const span = tip - rFix;
    if (Math.abs(span) < 1e-9 || (y - rFix) / span <= 0) return y;
    return rFix + (y - rFix) * Math.max((R - rFix) / span, 0.02);
  }

  // ---- Geometric objects: a flat shape seen from above (x, y), stood up between two heights ----
  // its corners in the scene: the shape round its centre (cx, cy)
  // Its outline from above, turned by its rotation about the height axis and placed at its centre (raw: the corners
  // themselves; otherwise with any bevelled corners rounded; local: in its own frame, round its centre, not turned)
  // (ring: -1 its bottom, 1 its top, 0 half way: a corner can lean, its top tx, ty from its bottom, about its middle)
  function geoCorners(node, raw, local, ring) {
    const q = node.params, k = (ring || 0) / 2, sh = (node.shape || []).map(p => k && (p.tx || p.ty) ? { ...p, x: p.x + k * (p.tx || 0), y: p.y + k * (p.ty || 0) } : p);
    const own = raw || !sh.some(p => p.bevel && p.bevel.r > 0) ? sh.map(p => [p.x, p.y])
      : expandProfile(sh.map(p => ({ y: p.x, z: p.y, bevel: p.bevel || null })), []).map(it => [it.y, it.z]);
    if (local) return own;
    const a = (q.rz || 0) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
    return own.map(([x, y]) => [q.cx + x * c - y * sn, q.cy + x * sn + y * c]);
  }
  // its rotation: about x, then y, then the height axis (degrees), as one matrix (rows)
  function geoRot(q) {
    const a = (q.rx || 0) * Math.PI / 180, b = (q.ry || 0) * Math.PI / 180, g = (q.rz || 0) * Math.PI / 180;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
    return [[cg * cb, cg * sb * sa - sg * ca, cg * sb * ca + sg * sa], [sg * cb, sg * sb * sa + cg * ca, sg * sb * ca - cg * sa], [-sb, cb * sa, cb * ca]];
  }
  function polyArea(P) { let a = 0; for (let i = 0; i < P.length; i++) { const A = P[i], B = P[(i + 1) % P.length]; a += A[0] * B[1] - B[0] * A[1]; } return a / 2; }
  // triangles covering a simple polygon given counter-clockwise (ear clipping): index triples into P
  function earClip(P) {
    const idx = P.map((_, i) => i), out = [];
    const cross = (a, b, c) => (P[b][0] - P[a][0]) * (P[c][1] - P[a][1]) - (P[b][1] - P[a][1]) * (P[c][0] - P[a][0]);
    const inside = (p, a, b, c) => { const A = P[a], B = P[b], C = P[c], q = P[p];
      const d1 = (B[0] - A[0]) * (q[1] - A[1]) - (B[1] - A[1]) * (q[0] - A[0]), d2 = (C[0] - B[0]) * (q[1] - B[1]) - (C[1] - B[1]) * (q[0] - B[0]), d3 = (A[0] - C[0]) * (q[1] - C[1]) - (A[1] - C[1]) * (q[0] - C[0]);
      return d1 >= 0 && d2 >= 0 && d3 >= 0; };
    let guard = 0;
    while (idx.length > 3 && guard++ < 10000) {
      let cut = false;
      for (let k = 0; k < idx.length; k++) {
        const a = idx[(k - 1 + idx.length) % idx.length], b = idx[k], c = idx[(k + 1) % idx.length];
        if (cross(a, b, c) <= 1e-14) continue;                                   // a reflex (or flat) corner is not an ear
        if (idx.some(p => p !== a && p !== b && p !== c && inside(p, a, b, c))) continue;
        out.push([a, b, c]); idx.splice(k, 1); cut = true; break;
      }
      if (!cut) {                                                                 // (a shape that crosses itself: fan what is left)
        for (let k = 1; k + 1 < idx.length; k++) out.push([idx[0], idx[k], idx[k + 1]]);
        return out;
      }
    }
    if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
    return out;
  }
  // a geometric object as a closed, outward-facing mesh (scene units)
  function geoMesh(node) {
    const q = node.params, sh = node.shape || [];
    // its bottom and its top (the same corners, each top where its corner leans to), matched corner for corner, each
    // point with its own height offset (dt, db: a corner's top and bottom up from the object's top and bottom; a
    // bevelled corner's points take their corner's)
    const ring = (r, key) => {
      const P = geoCorners(node, false, true, r), O = geoCorners(node, true, true, r);
      return P.map(p => {
        let k = 0, d = Infinity;
        O.forEach((o, i) => { const e = Math.hypot(o[0] - p[0], o[1] - p[1]); if (e < d) { d = e; k = i; } });
        return [p[0], p[1], sh[k] ? +sh[k][key] || 0 : 0];
      });
    };
    let B = ring(-1, 'db'), U = ring(1, 'dt');
    const keep = B.map((p, i) => { const b = B[(i + 1) % B.length], u = U[i], w = U[(i + 1) % U.length]; return Math.hypot(p[0] - b[0], p[1] - b[1]) > 1e-9 || Math.hypot(u[0] - w[0], u[1] - w[1]) > 1e-9; });
    B = B.filter((_, i) => keep[i]); U = U.filter((_, i) => keep[i]);
    if (B.length < 3) throw new Error((node.name || 'a geometric object') + ' needs at least three corners');
    if (polyArea(B) + polyArea(U) < 0) { B = B.slice().reverse(); U = U.slice().reverse(); }
    // built round its centre (half its height either side), turned, then placed
    const n = B.length, hh = Math.abs(q.h) / 2, zc = Math.min(q.z, q.z + q.h) + hh, M = geoRot(q), V = [], T = [];
    const put = (x, y, z) => V.push(M[0][0] * x + M[0][1] * y + M[0][2] * z + q.cx, M[1][0] * x + M[1][1] * y + M[1][2] * z + q.cy, M[2][0] * x + M[2][1] * y + M[2][2] * z + zc);
    for (const [x, y, o] of B) put(x, y, -hh + o);
    for (const [x, y, o] of U) put(x, y, hh + o);
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; T.push(i, j, n + j, i, n + j, n + i); }
    for (const [a, b, c] of earClip(U)) T.push(n + a, n + b, n + c);
    for (const [a, b, c] of earClip(B)) T.push(c, b, a);
    return { V, T };
  }

  // Mesh for one leaf node of the scene.
  function nodeMesh(node, settings) {
    if (node.type === 'geo') return geoMesh(node);
    if (node.type === 'source' || node.type === 'thread') {
      return revolve(expandProfile(node.pts, runsOf(node)), { segments: Math.min(300, node.precision > 2 ? node.precision : settings.precision), helical: settings.helical });
    }
    const items = expandProfile(node.pts, []);
    if (node.type === 'cog') {
      const sh = cogShape(node.params, node.precision > 2 ? node.precision : settings.precision), ys = items.map(it => it.y), fix = sh.internal ? Math.max(...ys) : Math.min(...ys);
      return revolve(items, { angles: sh.ang, warp: (r, j) => cogWarp(r, sh.rad[j], fix, sh.tip) });
    }
    if (node.type === 'ngon') {
      const n = Math.max(3, node.params.sides | 0);
      return revolve(items, { segments: n, scale: node.params.about === 'faces' ? 1 / Math.cos(Math.PI / n) : 1, phase: (node.params.rotation || 0) * Math.PI / 180 });
    }
    return revolve(items, { segments: Math.min(300, node.precision > 2 ? node.precision : settings.precision) });
  }

  // Evaluate the scene (worker). Booleans, holes and several objects need the
  // Manifold library; a single object without holes does not.
  async function evaluateScene(scene, holes, settings) {
    const nodes = scene.nodes;
    const holesOf = (n) => n.type === 'source' ? (n.holes || (n.id === 'src' ? holes || [] : [])) : [];
    if (!scene.root.length) throw new Error('the scene is empty');
    const only = scene.root.length === 1 ? nodes[scene.root[0]] : null;
    if (only && only.type !== 'boolean' && only.type !== 'group' && only.type !== 'cloner' && only.type !== 'holes' && !holesOf(only).length) return { mesh: nodeMesh(only, settings), engine: 'direct' };
    let mf;
    try {
      if (!self.__aaManifold) {
        const mod = await import(settings.manifoldUrl);
        const wasm = await mod.default();
        wasm.setup();
        self.__aaManifold = wasm;
      }
      mf = self.__aaManifold;
    } catch (e) {
      throw new Error('booleans, groups, holes and multiple objects need the Manifold library, which could not be loaded from ' + settings.manifoldUrl + ' (' + e + ')');
    }
    const garbage = [];
    const keep = (m) => { garbage.push(m); return m; };
    const toM = (mesh, what) => {
      const m = new mf.Mesh({ numProp: 3, vertProperties: new Float32Array(mesh.V), triVerts: new Uint32Array(mesh.T) });
      m.merge();
      try { return keep(new mf.Manifold(m)); } catch (e) { throw new Error(what + ' is not a closed solid (' + (e.message || e) + ')'); }
    };
    const unionAll = (ids) => {
      let total = null;
      for (const id of ids) { if (id == null) continue; const m = evalNode(id); if (m) total = total ? keep(total.add(m)) : m; }
      return total;
    };
    function evalNode(id) {
      const node = nodes[id];
      if (!node) return null;
      if (node.type === 'group') return unionAll(node.children);
      if (node.type === 'cloner') {
        // copies of the children around the main axis; children are built in their own frame:
        // 'axial' keeps their axis parallel to the main axis, 'radial' points it outward
        const base = unionAll(node.children);
        if (!base) return null;
        // (keepOrient: the copies are only moved round the axis, each keeping the orientation of the first)
        const q = node.params, n = Math.max(1, q.count | 0), R = q.radius * 1, spread = q.spread == null ? 360 : q.spread;
        const step = spread >= 360 - 1e-9 ? 360 / n : (n > 1 ? spread / (n - 1) : 0);
        let total = null;
        for (let k = 0; k < n; k++) {
          const a = (q.angle || 0) + k * step, ar = a * Math.PI / 180, at = [R * Math.cos(ar), R * Math.sin(ar)];
          const c = q.orient === 'radial'
            ? (q.keepOrient ? keep(keep(base.rotate([0, 90, 0])).translate([at[0], at[1], q.height || 0])) : keep(keep(keep(base.rotate([0, 90, 0])).translate([R, 0, q.height || 0])).rotate([0, 0, a])))
            : (q.keepOrient ? keep(base.translate([at[0], at[1], 0])) : keep(keep(base.translate([R, 0, 0])).rotate([0, 0, a])));
          total = total ? keep(total.add(c)) : c;
        }
        return total;
      }
      if (node.type === 'boolean') {
        const a = node.children[0] != null ? evalNode(node.children[0]) : null;
        const b = node.children[1] != null ? evalNode(node.children[1]) : null;
        if (!a || !b) return node.op === 'intersection' ? null : (a || (node.op === 'union' ? b : null));
        if (node.op === 'union') return keep(a.add(b));
        if (node.op === 'intersection') return keep(a.intersect(b));
        return keep(a.subtract(b));
      }
      if (node.type === 'holes') {
        // holes of an imported profile, as one solid (subtract it in a boolean)
        let total = null;
        for (const h of node.holes || []) { const m = toM(holeMesh(h), 'a hole'); total = total ? keep(total.add(m)) : m; }
        return total;
      }
      let m = toM(nodeMesh(node, settings), node.name || node.type);
      for (const h of holesOf(node)) m = keep(m.subtract(toM(holeMesh(h), 'a hole')));
      return m;
    }
    const total = unionAll(scene.root);
    if (!total || total.isEmpty()) { garbage.forEach(g => { try { g.delete(); } catch (_) {} }); throw new Error('the scene is empty'); }
    const out = total.getMesh(), np = out.numProp, V = [], T = Array.from(out.triVerts);
    for (let i = 0; i < out.vertProperties.length; i += np) V.push(out.vertProperties[i], out.vertProperties[i + 1], out.vertProperties[i + 2]);
    garbage.forEach(g => { try { g.delete(); } catch (_) {} });
    return { mesh: { V, T }, engine: 'manifold' };
  }

  function soup(mesh) {
    const { V, T } = mesh, out = new Float32Array(T.length * 7);
    for (let t = 0; t < T.length; t++) { const o = t * 7, v = T[t] * 3; out[o] = V[v]; out[o + 1] = V[v + 1]; out[o + 2] = V[v + 2]; }
    return out;
  }

  // ---------------------------------------------------------------------------
  // 4. Pipeline: scene → solid (direct revolve, or Manifold booleans) →
  //    weld/repair/check → STL or OBJ. Runs in a module Web Worker.
  // ---------------------------------------------------------------------------
  async function runJob(data) {
    let mesh = data.mesh, engine = 'direct', solid = null;
    // (the Measurement view's perfect drawing: round bevels as true arcs; declared on the page and in the worker)
    if (typeof ARC_PERFECT !== 'undefined') ARC_PERFECT = !!(data.settings && data.settings.perfect);
    if (data.scene) {
      const r = await evaluateScene(data.scene, data.holes, data.settings);
      mesh = soup(r.mesh); engine = r.engine;
      // the solid as it was built (scene units, upright, its faces joined as the solid has them): what the overhead
      // monomorphic drawing is worked out from. (The export's welded copy can join faces that only touch.)
      solid = { V: new Float32Array(r.mesh.V), T: new Uint32Array(r.mesh.T) };
    }
    if (data.opts && data.opts.flip) {
      // upside down: a half turn about the X axis (not a mirror), so a right-hand thread is still right-hand
      mesh = mesh.slice();
      for (let o = 0; o < mesh.length; o += 7) { mesh[o + 1] = -mesh[o + 1]; mesh[o + 2] = -mesh[o + 2]; }
    }
    const res = processMesh(mesh, data.opts);
    res.report.engine = engine; res.preview.flip = !!(data.opts && data.opts.flip); res.preview.solid = solid;
    return res;
  }

  const exportJobs = new Map();   // job id → callback, for one-off exports
  let worker = null, workerFailed = false;
  function getWorker() {
    if (worker || workerFailed) return worker;
    try {
      const src = [processMesh, stepFile, ngonFaces, bevelReach, cornerPoints, toothPattern, toothAt, runoutOf, runsOf, runoutDelta, runoutPattern, runoutCorner, runoutRadiusAt, threadProfile, expandProfile, runVertices, cogShape, cogWarp, revolve, holeMesh, geoCorners, geoRot, polyArea, earClip, geoMesh, nodeMesh, evaluateScene, soup, runJob]
        .map(f => f.toString()).join('\n') + '\nlet ARC_PERFECT = false;' +
        '\nself.onmessage = async function (e) {' +
        '  try { const r = await runJob(e.data); self.postMessage({ job: e.data.job, result: r }, [r.buffer, r.preview.tris.buffer, r.preview.lines.buffer, r.preview.bad.buffer].concat(r.preview.solid ? [r.preview.solid.V.buffer, r.preview.solid.T.buffer] : [])); }' +
        '  catch (err) { self.postMessage({ job: e.data.job, error: String(err && err.message || err) }); }' +
        '};';
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { type: 'module' });
      worker.onmessage = (e) => dispatch(e.data.job, e.data.result, e.data.error);
      worker.onerror = () => { workerFailed = true; worker = null; if (state.busy) { inflight = false; startJob(); } };
    } catch (_) { workerFailed = true; worker = null; }
    return worker;
  }
  function post(data) {
    const w = getWorker();
    if (w) w.postMessage(data);
    else setTimeout(() => (ARC_PERFECT = false, runJob(data)).then(r => dispatch(data.job, r), err => dispatch(data.job, null, String(err && err.message || err))), 0);
  }
  function dispatch(job, result, error) {
    const cb = exportJobs.get(job);
    if (cb) { exportJobs.delete(job); cb(result, error); return; }
    finish(job, result, error);
  }

  function haveInput() { return !!(state.scene && state.scene.root.length); }
  function jobOpts(fast) {
    return { flip: state.flip, optimize: fast ? false : state.optimize, unitScale: MM, unitLabel: 'mm', tolerance: WELD_TOLERANCE_IN * MM, format: fast && state.format === 'step' ? 'stl' : state.format, faces: state.faces };
  }
  // (the Measurement view, drawn perfect: the part built with every circle as fine as it goes and bevels as true
  // arcs, so its sections and its view from above are drawn true; files are always built as set)
  const perfectNow = () => !!(state.measure && state.measurePerfect);
  function jobSettings(forFile) {
    const perfect = !forFile && perfectNow();
    return { precision: perfect ? 300 : state.precision, perfect, helical: state.helical, manifoldUrl: W.__aaManifoldUrl || MANIFOLD_URL };
  }

  // Live recalculation: at most one job runs at a time. Edits made while a job
  // runs are coalesced into one follow-up job, started the moment it finishes,
  // so the preview keeps up with dragging and typing. While the user is still
  // interacting ("fast" jobs) the welding/repair pass is skipped; a full-quality
  // job always runs at the end, and only that one can be downloaded.
  let inflight = false, pending = false, wantFast = false;
  function recalc(o) {
    rememberScene();
    if (!haveInput()) { state.result = null; state.preview = null; state.busy = false; renderAll(); return; }
    wantFast = !!((o && o.fast) || state.liveInput);
    state.busy = true;
    state.result = null;
    if (inflight) pending = true; else startJob();
    renderAll();
  }
  function startJob() {
    pending = false; inflight = true;
    const job = ++state.job, fast = wantFast;
    const data = { job, opts: jobOpts(fast) };
    if (state.scene) { data.scene = sceneFor3d(state.scene); data.holes = state.holes; data.settings = jobSettings(); }
    state.jobFast = fast; state.jobPerfect = !!(data.settings && data.settings.perfect);
    post(data);
  }
  function finish(job, result, error) {
    if (job !== state.job) return;
    inflight = false;
    const fast = state.jobFast;
    if (result && result.preview) state.preview = result;   // the 3D view always shows the newest mesh
    if (error) console.error('[adapter-assembler]', error);
    if (pending) { startJob(); renderAll(); return; }    // more edits arrived meanwhile
    if (fast && !error) { wantFast = false; state.liveInput = false; startJob(); renderAll(); return; }
    state.busy = false;
    state.result = error ? { error } : result;
    renderAll();
  }

  // One-off export of part of the scene (an object, a group, a saved model).
  let exportSeq = 0;
  function exportScene(scene, name) {
    const job = 'x' + (++exportSeq);
    state.exporting = name;
    renderAll();
    exportJobs.set(job, (result, error) => {
      state.exporting = null;
      if (error || !result) { state.exportError = 'Export of ' + name + ' failed: ' + (error || 'no result'); renderAll(); return; }
      state.exportError = null;
      saveFile(result.buffer, result.ext, name);
      renderAll();
    });
    post({ job, opts: jobOpts(false), scene, holes: state.holes, settings: jobSettings(true) });
  }
  function saveFile(buffer, ext, name) {
    const blob = new Blob([buffer], { type: ext === 'json' ? 'application/json' : ext === 'obj' ? 'text/plain' : ext === 'step' ? 'application/step' : 'model/stl' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = String(name).replace(/[\\/:*?"<>|]+/g, '_') + '.' + ext;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function freshScene() { return { nodes: {}, root: [], seq: 1 }; }
  // ---- Adapter assembler: thread A at the bottom, thread B at the top, joined by a transition ----
  // spec: { a: {male, d, pitch, len}, b: {...}, length, wall, steep, angle } (mm); returns { scene, notes }.
  function buildAdapter(spec) {
    const U = 1 / MM, notes = [], H = spec.length, wall = Math.max(0.4, spec.wall || 2.5);
    const side = (s) => {
      const depth = ISO_DEPTH * s.pitch, rRoot = s.male ? s.d / 2 - depth : s.d / 2;
      return { ...s, depth, rRoot,
        ringIn: s.male ? Math.max(0, rRoot - wall) : rRoot, ringOut: s.male ? rRoot : rRoot + wall,
        bore: s.male ? Math.max(0, rRoot - wall) : s.d / 2 - depth,
        len: s.len > 0 ? s.len : Math.min(10, Math.max(5, 6 * s.pitch)) };
    };
    const A = side(spec.a), B = side(spec.b);
    const tanA = Math.tan(Math.max(10, Math.min(85, spec.angle || 60)) * Math.PI / 180);
    // what the middle needs: a steep cone between the two ends, or at least one wall's thickness
    const need = () => spec.steep ? Math.max(Math.abs(B.ringIn - A.ringIn), Math.abs(B.ringOut - A.ringOut)) * tanA : wall;
    let mid = H - A.len - B.len;
    if (mid < need()) {
      // shorten the threads (to 3 turns at least) to make room
      const minA = 3 * A.pitch, minB = 3 * B.pitch, short = need() - mid, room = (A.len - minA) + (B.len - minB);
      if (room > 0) { const k = Math.min(1, short / room); A.len -= (A.len - minA) * k; B.len -= (B.len - minB) * k; }
      mid = H - A.len - B.len;
      if (A.len < spec.a.len - 1e-9 || B.len < spec.b.len - 1e-9 || !(spec.a.len > 0 && spec.b.len > 0)) notes.push('Threads shortened to ' + A.len.toFixed(2) + ' / ' + B.len.toFixed(2) + ' mm to fit.');
      if (mid < need() - 1e-6) notes.push(spec.steep ? 'Too short for the steep transition: its walls are at ' + (Math.atan2(Math.max(0.01, mid), Math.max(Math.abs(B.ringIn - A.ringIn), Math.abs(B.ringOut - A.ringOut), 1e-6)) * 180 / Math.PI).toFixed(0) + '° instead.' : 'Very short middle section.');
      if (mid <= 0) { notes.push('The total length is shorter than the two threads; they were made to meet.'); mid = 0; }
    }
    const sc = { nodes: {}, root: [], seq: 1 }, nid = (p) => p + (++sc.seq), body = [];
    const ring = (name, z, h, rib, rit, rob, rot) => {
      if (h <= 1e-6) return;
      const params = { z: z * U, h: h * U, rib: rib * U, rit: rit * U, rob: rob * U, rot: rot * U, linkIn: Math.abs(rib - rit) < 1e-9, linkOut: Math.abs(rob - rot) < 1e-9,
        bevel: 0, bevelOut: true, bevelSegs: 4, sides: 6, about: 'faces', rotation: 0 };
      const id = nid('c'); sc.nodes[id] = { id, type: 'circle', name, params, pts: tagPts(paramProfile(params)), custom: false }; body.push(id);
    };
    const thread = (name, s, z, top) => {
      const pr = THREAD_PRESETS.find(p => Math.abs(p[2] - s.d) < 0.01 && Math.abs(p[3] - s.pitch) < 1e-4);
      const params = { preset: pr ? pr[0] : '', kind: s.male ? 'external' : 'internal', profile: 'iso', d: s.d * U, pitch: s.pitch * U, depth: s.depth * U,
        turns: Math.max(1, s.len / s.pitch), backing: Math.max(1, Math.min(wall, s.depth * 1.5) / s.depth), z: z * U, hand: 1, clearance: (spec.clearance || 0) * U,
        taperTop: !!top, taperBottom: !top };
      const id = nid('t'); sc.nodes[id] = { id, type: 'thread', name, params }; regenThread(sc.nodes[id]); body.push(id);
    };
    const label = (s) => { const pr = THREAD_PRESETS.find(p => Math.abs(p[2] - s.d) < 0.01 && Math.abs(p[3] - s.pitch) < 1e-4); return (pr ? pr[1].split(' — ')[0] : 'M' + s.d + '×' + s.pitch) + ' ' + (s.male ? 'male' : 'female'); };
    ring('Ring A', 0, A.len, A.ringIn, A.ringIn, A.ringOut, A.ringOut);
    thread('Thread A (' + label(A) + ')', A, 0, false);
    if (mid > 1e-6) {
      if (spec.steep) ring('Transition', A.len, mid, A.ringIn, B.ringIn, A.ringOut, B.ringOut);
      else {
        // plain steps: a flat-walled middle covering both ends
        const inn = Math.min(A.bore, B.bore, A.ringIn, B.ringIn), out = Math.max(A.ringOut, B.ringOut);
        ring('Middle', A.len, mid, inn, inn, out, out);
      }
    }
    ring('Ring B', H - B.len, B.len, B.ringIn, B.ringIn, B.ringOut, B.ringOut);
    thread('Thread B (' + label(B) + ')', B, H - B.len, true);
    const g = nid('g');
    sc.nodes[g] = { id: g, type: 'group', name: 'Adapter ' + label(A) + ' → ' + label(B), children: body };
    sc.root.push(g);
    return { scene: sc, notes };
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function partName() {
    // the only top-level object's name (e.g. "Adapter M48×0.75 F → T2 M"), as a file name
    const sc = state.scene, top = sc && sc.root.length === 1 && sc.nodes[sc.root[0]];
    const slug = String((top && top.name) || '').toLowerCase().replace(/[×x](?=\d)/g, 'x').replace(/→/g, 'to').replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
    return slug || 'adapter-assembler';
  }
  function download() {
    if (state.busy || !state.result || !state.result.buffer) return;
    // (with objects hidden from the 3D view, the file is built from all of them)
    if (state.scene && (state.jobPerfect || Object.values(state.scene.nodes).some(n => n && n.hide3d))) { exportScene({ nodes: state.scene.nodes, root: state.scene.root }, partName() + (!state.helical ? '-rings' : '')); return; }
    saveFile(state.result.buffer, state.result.ext || 'stl', partName() + (state.scene && !state.helical ? '-rings' : ''));
  }

  // ---------------------------------------------------------------------------
  // 5. Scene helpers. The root and groups are unions of their children; a
  //    boolean has two slots (A, B). Positions: { parent: id|null, slot }.
  // ---------------------------------------------------------------------------
  const isContainer = (n) => !!n && (n.type === 'boolean' || n.type === 'group' || n.type === 'cloner');
  function findParent(sc, id) {
    const ri = sc.root.indexOf(id);
    if (ri >= 0) return { parent: null, slot: ri };
    for (const n of Object.values(sc.nodes)) if (isContainer(n)) { const s = n.children.indexOf(id); if (s >= 0) return { parent: n.id, slot: s }; }
    return null;
  }
  function detach(sc, id) {
    const p = findParent(sc, id);
    if (!p) return null;
    if (p.parent === null) sc.root.splice(p.slot, 1);
    else { const c = sc.nodes[p.parent]; if (c.type === 'boolean') c.children[p.slot] = null; else c.children.splice(p.slot, 1); }
    return p;
  }
  function place(sc, id, t) {
    if (!t || t.parent === null) {
      const i = t && t.slot != null ? Math.min(t.slot, sc.root.length) : sc.root.length;
      sc.root.splice(i, 0, id); return;
    }
    const c = sc.nodes[t.parent];
    if (c.type === 'boolean') { c.children[t.slot] = id; return; }
    const i = t.slot != null ? Math.min(t.slot, c.children.length) : c.children.length;
    c.children.splice(i, 0, id);
  }
  function subtreeIds(sc, id, out = new Set()) {
    out.add(id);
    const n = sc.nodes[id];
    if (isContainer(n)) n.children.forEach(c => { if (c != null) subtreeIds(sc, c, out); });
    return out;
  }
  // Move a node to a position; a filled boolean slot swaps its occupant into the node's old place.
  function moveNodeTo(sc, id, target) {
    if (target.parent !== null && subtreeIds(sc, id).has(target.parent)) return false;
    const old = findParent(sc, id);
    if (!old) return false;
    if (target.parent !== null && sc.nodes[target.parent].type === 'boolean') {
      const b = sc.nodes[target.parent], occ = b.children[target.slot];
      if (occ === id) return false;
      detach(sc, id);
      if (occ != null) { b.children[target.slot] = null; place(sc, occ, old); }
      b.children[target.slot] = id;
      return true;
    }
    detach(sc, id);
    const t = { ...target };
    if (old.parent === t.parent && t.slot != null && old.slot < t.slot) t.slot--;
    place(sc, id, t);
    return true;
  }
  // Per-object switches from the object list, inherited by what is inside: hide2d (not drawn in the cross-section
  // views), hide3d (left out of the 3D view; exports still have it), locked (cannot be picked in the views).
  function nodeFlag(sc, id, k) {
    for (let cur = id, guard = 0; cur != null && guard < 64; guard++) {
      const n = sc.nodes[cur]; if (!n) return false; if (n[k]) return true;
      const pr = findParent(sc, cur); if (!pr || pr.parent === null) return false; cur = pr.parent;
    }
    return false;
  }
  // the scene the 3D view is built from: without what is hidden there (a boolean keeps the slot, empty)
  function sceneFor3d(sc) {
    if (!Object.values(sc.nodes).some(n => n && n.hide3d)) return { nodes: sc.nodes, root: sc.root };
    const hid = (id) => !!(sc.nodes[id] && sc.nodes[id].hide3d), nodes = {};
    for (const [id, n] of Object.entries(sc.nodes)) nodes[id] = n && n.children ? { ...n, children: n.type === 'boolean' ? n.children.map(c => c != null && hid(c) ? null : c) : n.children.filter(c => c == null || !hid(c)) } : n;
    return { nodes, root: sc.root.filter(id => !hid(id)) };
  }
  function leafOrder(sc) {
    const out = [];
    const walk = (id) => { const n = sc.nodes[id]; if (!n) return; if (isContainer(n)) n.children.forEach(c => c != null && walk(c)); else if (n.type !== 'holes') out.push(id); };
    sc.root.forEach(walk);
    return out;
  }
  function leavesUnder(sc, ids) {
    const out = new Set();
    for (const id of ids) for (const s of subtreeIds(sc, id)) if (sc.nodes[s] && !isContainer(sc.nodes[s])) out.add(s);
    return out;
  }
  // 'positive' | 'negative' (being subtracted) | 'intersect'
  function roleOf(sc, id) {
    let role = 'positive', cur = id;
    for (let guard = 0; guard < 64; guard++) {
      const p = findParent(sc, cur);
      if (!p || p.parent === null) break;
      const b = sc.nodes[p.parent];
      if (b.type === 'boolean') {
        if (b.op === 'difference' && p.slot === 1) role = role === 'negative' ? 'positive' : 'negative';
        else if (b.op === 'intersection' && role === 'positive') role = 'intersect';
      }
      cur = p.parent;
    }
    return role;
  }
  // Selected nodes without the ones whose ancestor is also selected.
  function topSelected(sc) {
    const ids = [...state.selNodes].filter(id => sc.nodes[id]);
    return ids.filter(id => !ids.some(o => o !== id && subtreeIds(sc, o).has(id)));
  }
  // Heights are always shown from the lowest point of the whole model (as in the exported file).
  // Heights are shown from zero at the part's lowest point up, or (top down) from zero at its top downward, as the part
  // is shown: flipped upside down, its lowest point is what was its top. zBase is that zero (scene units); HS the sign.
  function zBase(sc = state.scene) {
    let lo = Infinity, hi = -Infinity;
    if (!sc) return 0;
    for (const id of leafOrder(sc)) {
      const n = sc.nodes[id];
      if (n.type === 'geo') { const gw = geoWorld(sc, id); if (gw) { lo = Math.min(lo, gw.z0); hi = Math.max(hi, gw.z1); } continue; }
      const xf = xfOf(sc, id), o = outlineOf(n.pts, n.runs);
      for (const p of o) { if (xf.id) { lo = Math.min(lo, p.z); hi = Math.max(hi, p.z); continue; } const a = xf.fwd(p), b = xf.mir(p); lo = Math.min(lo, a.z, b.z); hi = Math.max(hi, a.z, b.z); }
    }
    if (!isFinite(lo)) return 0;
    return (state.heightFrom === 'top') !== !!state.flip ? hi : lo;
  }
  const HS = () => (state.flip ? -1 : 1) * (state.heightFrom === 'top' ? -1 : 1);
  const hDisp = (z, base) => HS() * (z - base) * UNIT_SCALE;
  const hInv = (v, base) => base + HS() * v / UNIT_SCALE;      // a shown height → scene
  // an object from z up by its height: the end shown at the bottom (its top, when the part is upside down), and back
  const lowEnd = (z, height) => (state.flip ? z + (height || 0) : z);
  const fromLowEnd = (z, height) => (state.flip ? z - (height || 0) : z);
  function newId(prefix) { state.scene.seq = (state.scene.seq || 1) + 1; return prefix + state.scene.seq; }
  const PREFIX = { circle: 'c', ngon: 'n', cog: 'w', boolean: 'b', group: 'g', source: 's', thread: 't', cloner: 'k', holes: 'h', geo: 'q' };

  // ---- Geometric objects in the scene ----
  // A symmetry's copies of a geometric object: for each, a map from its own (x, y, z) to the scene's, and whether a
  // symmetry lays it on its side. (As the 3D build places them.)
  function geoCopies(sc, id) {
    let list = [{ f: (p) => p, side: false }];
    for (let cur = id, guard = 0; guard < 64; guard++) {
      const pr = findParent(sc, cur);
      if (!pr || pr.parent === null) break;
      const c = sc.nodes[pr.parent]; cur = pr.parent;
      if (c.type !== 'cloner') continue;
      const q = c.params, cnt = Math.max(1, q.count | 0), R = q.radius || 0, H = q.height || 0, spread = q.spread == null ? 360 : q.spread;
      const step = spread >= 360 - 1e-9 ? 360 / cnt : (cnt > 1 ? spread / (cnt - 1) : 0), radial = q.orient === 'radial', keep = !!q.keepOrient, out = [];
      for (const L of list) for (let k = 0; k < cnt; k++) {
        const a = ((q.angle || 0) + k * step) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
        out.push({ side: L.side || radial, f: (p0) => {
          const p = L.f(p0);
          let x = p[0], y = p[1], z = p[2];
          if (radial) { const t = x; x = z; z = H - t; }                 // laid on its side (a quarter turn about y)
          if (keep) return [x + R * ca, y + R * sa, z];
          x += R; return [x * ca - y * sa, x * sa + y * ca, z];
        } });
      }
      list = out;
    }
    return list;
  }
  const hull2 = (P) => {
    const p = P.map(v => [v[0], v[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]), cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], hi = [];
    for (const v of p) { while (lo.length > 1 && cr(lo[lo.length - 2], lo[lo.length - 1], v) <= 0) lo.pop(); lo.push(v); }
    for (const v of p.slice().reverse()) { while (hi.length > 1 && cr(hi[hi.length - 2], hi[hi.length - 1], v) <= 0) hi.pop(); hi.push(v); }
    return lo.slice(0, -1).concat(hi.slice(0, -1));
  };
  // A geometric object placed in the scene: its triangles (every copy), each copy's outline from above and heights,
  // and its heights in all. Kept for as long as it and the symmetries around it stay the same.
  const geoCache = new Map();
  function geoWorld(sc, id) {
    const n = sc.nodes[id];
    if (!n || n.type !== 'geo') return null;
    const chain = [];
    for (let cur = id, guard = 0; guard < 64; guard++) { const pr = findParent(sc, cur); if (!pr || pr.parent === null) break; cur = pr.parent; if (sc.nodes[cur].type === 'cloner') chain.push(sc.nodes[cur].params); }
    const key = JSON.stringify([n.params, n.shape, chain, ARC_PERFECT]);
    const hit = geoCache.get(key);
    if (hit) return hit;
    let m;
    try { m = geoMesh(n); } catch (_) { return null; }
    const V = [], T = [], foot = [], corners = geoCorners(n);
    let z0 = Infinity, z1 = -Infinity;
    for (const c of geoCopies(sc, id)) {
      const base = V.length / 3, pts = [];
      let a = Infinity, b = -Infinity;
      for (let i = 0; i < m.V.length; i += 3) { const w = c.f([m.V[i], m.V[i + 1], m.V[i + 2]]); V.push(w[0], w[1], w[2]); pts.push(w); a = Math.min(a, w[2]); b = Math.max(b, w[2]); }
      for (const t of m.T) T.push(base + t);
      foot.push({ side: c.side, zr: [a, b], poly: c.side || geoTilted(n.params) || geoSkewed(n) ? hull2(pts) : corners.map(([x, y]) => c.f([x, y, 0]).slice(0, 2)) });
      z0 = Math.min(z0, a); z1 = Math.max(z1, b);
    }
    const out = { V, T, foot, z0, z1, per: m.V.length / 3 };
    if (geoCache.size > 200) geoCache.clear();
    geoCache.set(key, out);
    return out;
  }
  // Triangles (scene units) cut by the vertical plane through the axis at angle theta: closed loops of
  // (place along the plane, height), the place negative on the far side of the axis.
  function sliceLoops(V, T, theta, off = 0) {
    const c = Math.cos(theta), s = Math.sin(theta), segs = [];
    const P = (i) => { const x = V[i * 3], y = V[i * 3 + 1]; return [-x * s + y * c, x * c + y * s, V[i * 3 + 2]]; };
    for (let t = 0; t + 2 < T.length; t += 3) {
      const A = P(T[t]), B = P(T[t + 1]), C = P(T[t + 2]), pts = [];
      for (const [p, q] of [[A, B], [B, C], [C, A]]) if ((p[0] < off) !== (q[0] < off)) { const k = (p[0] - off) / (p[0] - q[0]); pts.push([p[1] + (q[1] - p[1]) * k, p[2] + (q[2] - p[2]) * k]); }
      if (pts.length === 2) segs.push(pts);
    }
    const key = (p) => Math.round(p[0] * 1e6) + ',' + Math.round(p[1] * 1e6), ends = new Map();
    segs.forEach((sg, i) => { for (const e of [0, 1]) { const k = key(sg[e]); if (!ends.has(k)) ends.set(k, []); ends.get(k).push([i, e]); } });
    const used = new Uint8Array(segs.length), loops = [];
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      used[i] = 1;
      const loop = [segs[i][0], segs[i][1]];
      for (let guard = 0; guard < segs.length; guard++) {
        const nxt = (ends.get(key(loop[loop.length - 1])) || []).find(([j]) => !used[j]);
        if (!nxt) break;
        used[nxt[0]] = 1; loop.push(segs[nxt[0]][1 - nxt[1]]);
      }
      if (loop.length > 2) loops.push(loop);
    }
    return loops;
  }
  // ---- rotations of geometric objects ----
  const matMul = (A, B) => A.map((r, i) => [0, 1, 2].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
  // a turn by a (radians) about a unit axis
  function axisRot(ax, a) {
    const [x, y, z] = ax, c = Math.cos(a), s = Math.sin(a), t = 1 - c;
    return [[t * x * x + c, t * x * y - s * z, t * x * z + s * y], [t * x * y + s * z, t * y * y + c, t * y * z - s * x], [t * x * z - s * y, t * y * z + s * x, t * z * z + c]];
  }
  // the angles (degrees: about x, then y, then the height axis) of a rotation matrix
  function eulerOf(M) {
    const ry = Math.asin(Math.max(-1, Math.min(1, -M[2][0])));
    let rx, rz;
    if (Math.abs(M[2][0]) < 0.999999) { rx = Math.atan2(M[2][1], M[2][2]); rz = Math.atan2(M[1][0], M[0][0]); }
    else { rx = Math.atan2(-M[1][2], M[1][1]); rz = 0; }
    const d = (v) => { const r = Math.round(v * 180 / Math.PI * 1e9) / 1e9; return r <= -180 ? r + 360 : r; };
    return { rx: d(rx), ry: d(ry * 1), rz: d(rz) };
  }
  // turn a geometric object about a direction in the scene (through its centre) by a (radians)
  function geoTurn(q, ax, a) { Object.assign(q, eulerOf(matMul(axisRot(ax, a), geoRot(q)))); }
  // Keep a geometric object's centre at the middle of its shape (the centroid of its area), leaving the
  // shape where it is in the scene: its corners shift one way in its own frame, its centre the other way (turned).
  function geoRecentre(n) {
    if (!n || n.type !== 'geo' || !n.shape || !n.shape.length) return;
    // the middle is the shape's centroid (centre of its area); a shape with no area: the average of its corners
    const S = n.shape, N = S.length;
    let A = 0, ax = 0, ay = 0, vx = 0, vy = 0;
    for (let i = 0; i < N; i++) {
      const a = S[i], b = S[(i + 1) % N], c = a.x * b.y - b.x * a.y;
      A += c; ax += (a.x + b.x) * c; ay += (a.y + b.y) * c; vx += a.x / N; vy += a.y / N;
    }
    let x0 = Infinity, x1 = -Infinity;
    for (const p of S) { x0 = Math.min(x0, p.x, p.y); x1 = Math.max(x1, p.x, p.y); }
    const big = Math.abs(A) / 2 > 1e-9 * Math.max(1e-6, (x1 - x0) * (x1 - x0));
    const mx = big ? ax / (3 * A) : vx, my = big ? ay / (3 * A) : vy;
    if (Math.abs(mx) < 1e-10 && Math.abs(my) < 1e-10) return;
    for (const p of n.shape) { p.x -= mx; p.y -= my; }
    const q = n.params, M = geoRot(q);
    q.cx += M[0][0] * mx + M[0][1] * my; q.cy += M[1][0] * mx + M[1][1] * my; q.z += M[2][0] * mx + M[2][1] * my;
  }
  // n evenly spaced new corners on edge i of a geometric object (after corner i); their keys
  // a corner part way from A to B (leaning part way between theirs)
  function geoMidCorner(A, B, t) {
    const p = { x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t }, at = (k) => (+A[k] || 0) + ((+B[k] || 0) - (+A[k] || 0)) * t;
    const tx = at('tx'), ty = at('ty'), dt = at('dt'), db = at('db');
    if (Math.abs(tx) > 1e-12 || Math.abs(ty) > 1e-12) { p.tx = tx; p.ty = ty; }
    if (Math.abs(dt) > 1e-12) p.dt = dt;
    if (Math.abs(db) > 1e-12) p.db = db;
    return p;
  }
  // whether any corner leans (its top not over its bottom)
  const geoSkewed = (n) => (n.shape || []).some(p => Math.abs(p.tx || 0) > 1e-12 || Math.abs(p.ty || 0) > 1e-12);
  function geoInsert(n, i, count) {
    const A = n.shape[i], B = n.shape[(i + 1) % n.shape.length], add = [];
    for (let k = 1; k <= count; k++) add.push(geoMidCorner(A, B, k / (count + 1)));
    n.shape.splice(i + 1, 0, ...add);
    return add.map((_, k) => n.id + '|q|' + (i + 1 + k));
  }
  const geoTilted = (q) => Math.abs(q.rx || 0) > 1e-9 || Math.abs(q.ry || 0) > 1e-9;
  const snapAng = (v, st = 15) => Math.round(v / st) * st;
  // which way the radius/height view's drags on a geometric object go: the side of the axis it was grabbed on
  let GEO_SIDE = 1;
  // and which of its ends a corner or edge was grabbed by there (-1 its bottom, 1 its top, 0 both)
  let GEO_RING = 0;
  // Where an object sits from above: its first copy in the symmetries around it, as a turn a and a centre C
  // (world = rot(a)·own + C). side: the innermost symmetry lays it on its side, so from above its outline is seen
  // edge on, as (height along the copies' radius, ± radius across). A symmetry whose copies keep their orientation
  // only moves them.
  function placeOf(sc, id) {
    let a = 0, C = [0, 0], side = false, first = true;
    for (let cur = id, guard = 0; guard < 64; guard++) {
      const p = findParent(sc, cur);
      if (!p || p.parent === null) break;
      const c = sc.nodes[p.parent]; cur = p.parent;
      if (c.type !== 'cloner') continue;
      const q = c.params, as = (q.angle || 0) * Math.PI / 180, R = q.radius || 0;
      if (q.orient === 'radial' && first) side = true;
      first = false;
      if (q.keepOrient) C = [C[0] + R * Math.cos(as), C[1] + R * Math.sin(as)];
      else { const x = C[0] + R, y = C[1]; C = [x * Math.cos(as) - y * Math.sin(as), x * Math.sin(as) + y * Math.cos(as)]; a += as; }
    }
    const ca = Math.cos(a), sa = Math.sin(a);
    return { a, C, side, w: (x, y) => [x * ca - y * sa + C[0], x * sa + y * ca + C[1]], inv: (dx, dy) => [dx * ca + dy * sa, -dx * sa + dy * ca] };
  }

  // Children of a radial cloner are built in their own frame; in the cross-section the editor
  // shows its first copy. xfOf gives the mapping between an object's own frame and the view.
  const ID_XF = { id: true, fwd: (p) => ({ y: p.y, z: p.z }), mir: null, inv: (a, b) => ({ y: a, z: b }), invP: (a, b) => ({ y: a, z: b }) };
  function xfOf(sc, id) {
    const steps = [];
    for (let cur = id, guard = 0; guard < 64; guard++) {
      const p = findParent(sc, cur);
      if (!p || p.parent === null) break;
      const c = sc.nodes[p.parent];
      if (c.type === 'cloner') {
        const q = c.params, R = q.radius || 0, H = q.height || 0;
        steps.push(q.orient === 'radial'
          ? { f: (y, z) => ({ y: R + z, z: H - y }), il: (a, b) => ({ y: -b, z: a }), ip: (Y, Z) => ({ y: H - Z, z: Y - R }) }
          : { f: (y, z) => ({ y: R + y, z }), il: (a, b) => ({ y: a, z: b }), ip: (Y, Z) => ({ y: Y - R, z: Z }) });
      }
      cur = p.parent;
    }
    if (!steps.length) return ID_XF;
    const fwd = (p) => { let q = { y: p.y, z: p.z }; for (const s of steps) q = s.f(q.y, q.z); return q; };
    return {
      id: false, fwd,
      mir: (p) => fwd({ y: -p.y, z: p.z }),   // the other half of the copy's section
      inv: (a, b) => { let q = { y: a, z: b }; for (let i = steps.length - 1; i >= 0; i--) q = steps[i].il(q.y, q.z); return q; },
      invP: (a, b) => { let q = { y: a, z: b }; for (let i = steps.length - 1; i >= 0; i--) q = steps[i].ip(q.y, q.z); return q; },
    };
  }
  // An object's outline as shown in the view.
  function viewOutline(sc, id) {
    const n = sc.nodes[id];
    if (n.type === 'geo') {
      // (a geometric object: the box its sections can reach, for extents and fitting)
      const gw = geoWorld(sc, id); if (!gw) return [];
      let r = 0; for (let i = 0; i < gw.V.length; i += 3) r = Math.max(r, Math.hypot(gw.V[i], gw.V[i + 1]));
      return [{ y: 0, z: gw.z0 }, { y: r, z: gw.z0 }, { y: r, z: gw.z1 }, { y: 0, z: gw.z1 }];
    }
    const xf = xfOf(sc, id), o = outlineOf(n.pts, n.runs); return xf.id ? o : o.map(xf.fwd);
  }
  // Move points given a move in view coordinates (each object converts it into its own frame).
  function moveKeysView(sc, keys, dY, dZ) {
    const by = {};
    for (const k of keys) { const id = parseKey(k).node; (by[id] = by[id] || []).push(k); }
    for (const id in by) {
      const n = sc.nodes[id];
      if (n && n.type === 'geo') {
        // corners (and both ends of edges): the move along the section's plane and up or down, in its own (turned)
        // frame; the part across its height is left out (that is the height lines' work)
        const th = state.viewAngle * Math.PI / 180, d = placeOf(sc, id).inv(dY * GEO_SIDE * Math.cos(th), dY * GEO_SIDE * Math.sin(th)), M = geoRot(n.params);
        const lx = M[0][0] * d[0] + M[1][0] * d[1] + M[2][0] * dZ, ly = M[0][1] * d[0] + M[1][1] * d[1] + M[2][1] * dZ, idx = new Set();
        for (const k of by[id]) { const h = parseKey(k); if (h.kind === 'q') idx.add(h.i); else if (h.kind === 'qe') { idx.add(h.i); idx.add((h.i + 1) % n.shape.length); } }
        // grabbed by its top or bottom: only that end of each corner moves, across (the corner leans) and up or down (its
        // own height there: the top or bottom is no longer flat, new faces follow); never below its other end
        const R = GEO_RING, lz = M[0][2] * d[0] + M[1][2] * d[1] + M[2][2] * dZ, hh = Math.abs(n.params.h), eps = 0.01 / MM;
        for (const i of idx) {
          const p = n.shape[i]; if (!p) continue;
          if (!R) { p.x += lx; p.y += ly; continue; }
          p.x += lx / 2; p.y += ly / 2; p.tx = (p.tx || 0) + R * lx; p.ty = (p.ty || 0) + R * ly;
          if (Math.abs(p.tx) < 1e-12 && Math.abs(p.ty) < 1e-12) { delete p.tx; delete p.ty; }
          const k = R > 0 ? 'dt' : 'db', other = R > 0 ? +p.db || 0 : +p.dt || 0;
          let v = (+p[k] || 0) + lz;
          v = R > 0 ? Math.max(v, other - hh + eps) : Math.min(v, other + hh - eps);
          if (Math.abs(v) < 1e-12) delete p[k]; else p[k] = v;
        }
        geoRecentre(n);
        continue;
      }
      const d = xfOf(sc, id).inv(dY, dZ); moveKeys(sc, by[id], d.y, d.z);
    }
  }
  function moveNodeView(sc, id, dY, dZ) {
    const n = sc.nodes[id];
    if (n && n.type === 'geo') {
      // a move in the radius/height view: along the section's plane (on the side it is on), and up or down
      const th = state.viewAngle * Math.PI / 180, d = placeOf(sc, id).inv(dY * GEO_SIDE * Math.cos(th), dY * GEO_SIDE * Math.sin(th));
      n.params.cx += d[0]; n.params.cy += d[1]; n.params.z += dZ;
      return;
    }
    const d = xfOf(sc, id).inv(dY, dZ); moveNode(n, d.y, d.z);
  }
  const singleSel = () => state.selNodes.size === 1 ? state.scene.nodes[[...state.selNodes][0]] : null;

  function defaultParams(view) {
    const cy = view ? view.cy : 1, cz = view ? view.cz : 0, w = 3 / MM;
    return { z: cz - 2.5 / MM, h: 5 / MM, rib: Math.max(0, cy - w), rit: Math.max(0, cy - w), rob: cy + w, rot: cy + w,
      linkIn: true, linkOut: true, bevel: 0, bevelOut: true, bevelSegs: 4, sides: 6, about: 'faces', rotation: 0 };
  }
  // Where a new object goes: into the single selected group, or the selected boolean's empty slot.
  function insertTarget() {
    const sel = singleSel();
    if (sel && sel.type === 'group') return { parent: sel.id, slot: null };
    if (sel && sel.type === 'boolean') { const s = sel.children.indexOf(null); if (s >= 0) return { parent: sel.id, slot: s }; }
    return null;
  }
  // Standard telescope threads, by category. Entries: [id, label, major Ø mm, pitch mm, category].
  // Inch threads are listed as Ø"-TPI and stored in mm.
  const THREAD_GROUPS = [
    ['Small screws (ISO metric coarse)', [
      ['ISO-M1', 'M1×0.25', 1, 0.25], ['ISO-M1.2', 'M1.2×0.25', 1.2, 0.25], ['ISO-M1.4', 'M1.4×0.3', 1.4, 0.3],
      ['ISO-M1.6', 'M1.6×0.35', 1.6, 0.35], ['ISO-M2', 'M2×0.4', 2, 0.4], ['ISO-M2.5', 'M2.5×0.45', 2.5, 0.45],
      ['ISO-M3', 'M3×0.5', 3, 0.5], ['ISO-M3.5', 'M3.5×0.6', 3.5, 0.6], ['ISO-M4', 'M4×0.7', 4, 0.7], ['ISO-M5', 'M5×0.8', 5, 0.8],
      ['ISO-M6', 'M6×1', 6, 1], ['ISO-M8', 'M8×1.25', 8, 1.25], ['ISO-M10', 'M10×1.5', 10, 1.5], ['ISO-M12', 'M12×1.75', 12, 1.75],
    ]],
    ['Tripod & mount screws (UNC)', [
      ['UNC-1/4', '1/4"-20 — camera / tripod', 0.25, '20tpi'], ['UNC-3/8', '3/8"-16 — tripod / mount', 0.375, '16tpi'],
    ]],
    ['Eyepieces & filters', [
      ['M28.5x0.6', 'M28.5×0.6 — 1.25" filter / eyepiece', 28.5, 0.6],
      ['M48x0.75', 'M48×0.75 — 2" filter / eyepiece', 48, 0.75],
      ['TK-M43x0.75', 'M43×0.75 — Takahashi eyepiece extension tubes', 43, 0.75],
    ]],
    ['Cameras & imaging train', [
      ['M12x0.5', 'M12×0.5 — webcam / S-mount', 12, 0.5],
      ['C', '1"-32 — C-mount (video)', 1, '32tpi'],
      ['M42x0.75', 'M42×0.75 — T / T2', 42, 0.75],
      ['M42x1', 'M42×1 — Pentax screw / T-1', 42, 1],
      ['CAM-M48x0.75', 'M48×0.75 — wide T', 48, 0.75],
      ['M54x0.75', 'M54×0.75 — full-frame cameras, filter wheels / drawers', 54, 0.75],
      ['M56x0.75', 'M56×0.75 — large-format camera adapters', 56, 0.75],
      ['M62x0.75', 'M62×0.75 — PlaneWave camera adapters', 62, 0.75],
      ['M68x1', 'M68×1 — Zeiss / Baader / large-sensor', 68, 1],
      ['STL', '2.156"-24 — SBIG STL', 2.156, '24tpi'],
      ['FLI', '3.005"-24 — FLI filter wheels', 3.005, '24tpi'],
    ]],
    ['Schmidt-Cassegrain & Maksutov', [
      ['SCT', '2"-24 — SCT (5"–9.25", Meade & Celestron)', 2, '24tpi'],
      ['SCT-C', '3.29"-16 — large Celestron SCT (C11, C14, 9.25" EdgeHD)', 3.29, '16tpi'],
      ['SCT-M', '3.25"-16 — large Meade SCT (10"–14")', 3.25, '16tpi'],
      ['SCT-M16', '4"-16 — Meade 16" SCT', 4, '16tpi'],
      ['ETX', '1.375"-24 — Meade ETX / Celestron NexStar 4SE', 1.375, '24tpi'],
      ['M44.5x1', 'M44.5×1 — Maksutov (Orion, Sky-Watcher)', 44.5, 1],
      ['M90x1', 'M90×1 — Sky-Watcher refractors / GSO RC tube', 90, 1],
    ]],
    ['Takahashi', [
      ['M72x1', 'M72×1 — FSQ-106 rear / camera side', 72, 1],
      ['M92x1', 'M92×1 — FSQ-106N, focuser standard', 92, 1],
      ['M98x1', 'M98×1 — large focusers', 98, 1],
      ['TK-M54x0.75', 'M54×0.75 — CA-35 wide T', 54, 0.75],
      ['M117x1', 'M117×1 — large focusers', 117, 1],
    ]],
    ['Astro-Physics, Tele Vue & DSI (inch)', [
      ['AP27', '2.7"-24 — Astro-Physics 2.7" focuser / accessories', 2.7, '24tpi'],
      ['TV24', '2.56"-24 — Tele Vue 2.4" Imaging System', 2.56, '24tpi'],
      ['DSI35', '3.5"-24 — Deep Sky Instruments 3.5"', 3.5, '24tpi'],
    ]],
    ['Refractor focusers (metric)', [
      ['M56x1', 'M56×1 — Celestron / Sky-Watcher refractor back', 56, 1],
      ['M61x1', 'M61×1', 61, 1],
      ['M63x1', 'M63×1 — William Optics, Feather Touch 2.5" drawtube', 63, 1],
      ['M68x0.75', 'M68×0.75 — Explore Scientific / Bresser drawtube', 68, 0.75],
      ['M74x1', 'M74×1 — Sky-Watcher Esprit, TS / Omegon APOs', 74, 1],
      ['M75x1', 'M75×1 — Feather Touch 3" R&P drawtube', 75, 1],
      ['M77x0.75', 'M77×0.75 — TS Optics', 77, 0.75],
      ['M78x0.75', 'M78×0.75', 78, 0.75],
      ['M78x1', 'M78×1 — TS Optics / Starlight 3" focusers', 78, 1],
      ['M80x0.75', 'M80×0.75 — William Optics Flat68III', 80, 0.75],
      ['M82x0.75', 'M82×0.75', 82, 0.75],
      ['M84x1', 'M84×1 — Askar 103 / 120', 84, 1],
      ['M86x1', 'M86×1 — Feather Touch 3" drawtube', 86, 1],
      ['M88x1', 'M88×1', 88, 1],
      ['ASK-M92x1', 'M92×1 — Askar 140 / 185', 92, 1],
      ['M95x1', 'M95×1 — Feather Touch 2.5" collar', 95, 1],
    ]],
  ];
  const THREAD_PRESETS = THREAD_GROUPS.flatMap(([g, list]) => list.map(([k, label, d, p]) =>
    typeof p === 'string' ? [k, label, d * 25.4, 25.4 / parseFloat(p), g] : [k, label, d, p, g]));
  const ISO_DEPTH = 5 * Math.sqrt(3) / 16, V_DEPTH = Math.sqrt(3) / 2;   // × pitch: ISO basic profile (5H/8), sharp 60° V (H)
  function threadDefaults(view) {
    const pr = THREAD_PRESETS.find(p => p[0] === 'M48x0.75'), P = pr[3] / MM;
    return { preset: pr[0], kind: 'external', profile: 'iso', d: pr[2] / MM, pitch: P, depth: ISO_DEPTH * P, turns: 8, backing: 1,
      z: view ? view.cz : 0, hand: 1, clearance: 0, taperTop: true, taperBottom: true };
  }
  // ---- Parametric objects (circle, n-sided, thread) ----
  // Generated points carry their index (g), so a parameter change can be applied on top of hand edits,
  // and an outline edited in the cross-section is read back into the parameters when it still fits them.
  const tagPts = (pts) => { pts.forEach((p, i) => { p.g = i; }); return pts; };
  // a cog's outer edge is its tip circle, set by the teeth, module and addendum
  //   (an inside cog's inner edge is its teeth's tips, and its outer edge a round rim)
  const cogIn = (q) => q.kind === 'internal';
  const cogTip = (q) => q.module * (q.teeth / 2 + (cogIn(q) ? -q.addendum : q.addendum));
  const cogRoot = (q) => q.module * (q.teeth / 2 + (cogIn(q) ? q.dedendum : -q.dedendum));
  const profileOf = (type, q) => paramProfile(type !== 'cog' ? q : cogIn(q) ? { ...q, rib: cogTip(q), rit: cogTip(q), linkIn: true } : { ...q, rob: cogTip(q), rot: cogTip(q), linkOut: true });
  // an outside cog's bore stays inside its root circle; an inside cog's rim outside its roots
  function cogClamp(t) {
    if (cogIn(t)) { t.addendum = Math.min(t.addendum, t.teeth / 2 - 0.05); const lim = cogRoot(t) + 0.02 * t.module; t.rob = Math.max(t.rob, lim); t.rot = Math.max(t.rot, lim); }
    else { t.dedendum = Math.min(t.dedendum, t.teeth / 2 - 0.05); const lim = Math.max(0, cogRoot(t) - 0.02 * t.module); t.rib = Math.min(t.rib, lim); t.rit = Math.min(t.rit, lim); }
  }
  const cogFix = (q, o) => cogIn(q) ? Math.max(...o.map(p => p.y)) : Math.min(...o.map(p => p.y));
  function genOf(n, q) {
    if (n.type === 'thread') { const t = threadProfile(q); return { pts: t.pts, runs: t.runs }; }
    return { pts: profileOf(n.type, q), runs: [] };
  }
  function regenThread(n) { const t = threadProfile(n.params); n.pts = tagPts(t.pts); n.runs = t.runs.map(r => ({ ...r, label: n.name || 'Thread' })); n.custom = false; }
  function regenNode(n) { if (n.type === 'thread') regenThread(n); else { n.pts = tagPts(profileOf(n.type, n.params)); n.custom = false; } }
  const bevelKey = (b) => b && (b.r > 0 || b.trim > 0) ? [b.r || 0, b.trim || 0, b.segs || 0, !!b.out, b.shape || ''].join('|') : '';
  // a bevel's shape for the menus, and back
  const BEVEL_SHAPES = [['convex', 'convex (rounded)'], ['concave', 'concave (cove)'], ['outA', 'outward A (flare)'], ['outB', 'outward B (flare)']];
  const bevelShapeOf = (b) => b && b.shape ? b.shape : b && b.out === false ? 'concave' : 'convex';
  const bevelFromShape = (v) => v === 'outA' || v === 'outB' ? { out: true, shape: v } : { out: v === 'convex' };
  const RUN_POS = ['rFirst', 'rOther', 'zFirst', 'zLast'], RUN_KEYS = ['pitch', 'pitchDrawn', 'hand', 'flatA', 'flatB', 'kind'];
  // Move the outline by exactly what the parameter change moves in the generated outline.
  function transferParams(n, oldQ, newQ) {
    const A = genOf(n, oldQ), B = genOf(n, newQ), runs = n.runs || [];
    const same = A.pts.length === B.pts.length && A.runs.length === B.runs.length && runs.length === A.runs.length &&
      A.runs.every((r, i) => r.kind === B.runs[i].kind && r.start === B.runs[i].start && r.end === B.runs[i].end && runs[i].start != null);
    if (!same) { regenNode(n); return; }
    if (!n.pts.some(p => p.g != null) && n.pts.length === A.pts.length) tagPts(n.pts);
    const N = n.pts.length, ok = (p) => p.g != null && p.g < A.pts.length;
    const base = n.pts.map(p => ok(p) ? { y: B.pts[p.g].y - A.pts[p.g].y, z: B.pts[p.g].z - A.pts[p.g].z } : null);
    if (!base.some(Boolean)) { regenNode(n); return; }
    const dist = (i, j) => Math.hypot(n.pts[i].y - n.pts[j].y, n.pts[i].z - n.pts[j].z);
    const d = base.map((v, i) => {
      if (v) return v;
      // a point added by hand moves with the generated points on either side, by distance along the outline
      let a = i, la = 0; do { const p = a; a = (a - 1 + N) % N; la += dist(p, a); } while (!base[a]);
      let b = i, lb = 0; do { const p = b; b = (b + 1) % N; lb += dist(p, b); } while (!base[b]);
      const t = la + lb > 1e-12 ? la / (la + lb) : 0.5;
      return { y: base[a].y + (base[b].y - base[a].y) * t, z: base[a].z + (base[b].z - base[a].z) * t };
    });
    n.pts.forEach((p, i) => {
      p.y = Math.max(0, p.y + d[i].y); p.z += d[i].z;
      // a bevel the parameters made follows them; one set by hand stays
      if (ok(p) && bevelKey(p.bevel) === bevelKey(A.pts[p.g].bevel)) p.bevel = B.pts[p.g].bevel ? { ...B.pts[p.g].bevel } : null;
    });
    runs.forEach((r, i) => {
      const a = A.runs[i], b = B.runs[i];
      for (const k of RUN_POS) r[k] += b[k] - a[k];
      r.rFirst = Math.max(0, r.rFirst); r.rOther = Math.max(0, r.rOther);
      for (const k of RUN_KEYS) if (a[k] !== b[k]) r[k] = b[k];
    });
  }
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  // Parameters that reproduce the object's current outline, or null.
  function fitParams(n) {
    const q = n.params, P = n.pts;
    if (n.type === 'thread') {
      const r = (n.runs || [])[0], c = q.clearance || 0, f = { ...q };
      if (P.length !== 4 || n.runs.length !== 1 || r.kind !== q.kind) return null;
      let keep;
      if (q.kind === 'internal') {
        if (r.start !== 2 || r.end !== 3) return null;
        f.z = r.zLast; f.turns = (r.zFirst - r.zLast) / r.pitch; f.depth = r.rOther - r.rFirst; f.d = 2 * (r.rFirst - c + ISO_DEPTH * r.pitch);
        f.backing = (P[0].y - r.rOther) / f.depth; keep = [0, 1];
      } else {
        if (r.start !== 1 || r.end !== 2) return null;
        f.z = r.zFirst; f.turns = (r.zLast - r.zFirst) / r.pitch; f.depth = r.rOther - r.rFirst; f.d = 2 * (r.rOther + c);
        f.backing = (r.rFirst - P[0].y) / f.depth; keep = [0, 3];
      }
      f.pitch = r.pitch; f.hand = r.hand || 1;
      if (!(f.depth > 0) || !(f.backing > 0) || f.turns < 1 - 1e-9) return null;
      const g = threadProfile(f), gr = g.runs[0];
      if (!keep.every(i => near(g.pts[i].y, P[i].y) && near(g.pts[i].z, P[i].z))) return null;
      if (!RUN_POS.every(k => near(gr[k], r[k])) || !near(gr.flatA, r.flatA || 0) || !near(gr.flatB, r.flatB || 0)) return null;
      const pr = THREAD_PRESETS.find(p => p[0] === f.preset);
      if (pr && !(near(pr[2] / MM, f.d) && near(pr[3] / MM, f.pitch))) f.preset = '';
      return f;
    }
    if (P.length !== 4 || !near(P[0].z, P[1].z) || !near(P[2].z, P[3].z) || P[2].z - P[0].z <= 1e-9) return null;
    const f = { ...q, z: P[0].z, h: P[2].z - P[0].z, rib: P[0].y, rob: P[1].y, rot: P[2].y, rit: P[3].y };
    if (f.linkIn && !near(f.rib, f.rit)) f.linkIn = false;
    if (n.type === 'cog') {
      // the edge at the teeth's tips (outer, or inner for an inside cog) sets the tip: read back as the module
      if (cogIn(f)) {
        if (!near(f.rib, f.rit)) return null;
        f.linkIn = true; f.module = f.rib / (f.teeth / 2 - f.addendum);
      } else {
        if (!near(f.rob, f.rot)) return null;
        f.linkOut = true; f.module = f.rob / (f.teeth / 2 + f.addendum);
      }
      if (!(f.module > 0) || !isFinite(f.module)) return null;
    }
    if (f.linkOut && !near(f.rob, f.rot)) f.linkOut = false;
    if (P.some(p => p.y <= 1e-9 && bevelKey(p.bevel))) return null;
    const kinds = [...new Set(P.filter(p => p.y > 1e-9).map(p => bevelKey(p.bevel)))];
    if (kinds.length > 1) return null;
    if (kinds[0]) { const b = P.find(p => p.y > 1e-9).bevel; if (b.trim) return null; f.bevel = b.r; f.bevelSegs = b.segs || f.bevelSegs; f.bevelOut = !!b.out; f.bevelShape = b.shape || null; }
    else f.bevel = 0;
    const g = profileOf(n.type, f);
    return g.every((p, i) => near(p.y, P[i].y) && near(p.z, P[i].z)) ? f : null;
  }
  function rationalize(n) {
    if (n && n.type === 'geo') { geoRecentre(n); return; }
    if (!n || !n.params || !(n.type === 'thread' || n.type === 'circle' || n.type === 'ngon' || n.type === 'cog')) return;
    const f = fitParams(n);
    if (f) { Object.assign(n.params, f); n.custom = false; tagPts(n.pts); } else n.custom = true;
  }
  // Change parameters (one undo step per field edit; live typing re-applies to the state before the edit).
  let editBase = null;
  function setParams(n, mutate) {
    if (!state.undoLock || !editBase || editBase.id !== n.id) { pushUndo(); editBase = { id: n.id, q: clone(n.params), pts: clone(n.pts), runs: n.runs ? clone(n.runs) : null }; }
    else {
      for (const k of Object.keys(n.params)) delete n.params[k];
      Object.assign(n.params, clone(editBase.q)); n.pts = clone(editBase.pts); if (editBase.runs) n.runs = clone(editBase.runs);
    }
    const before = clone(n.params);
    mutate(n.params);
    transferParams(n, before, n.params);
    markEdited(); recalc();
  }
  function addObject(type, view, at) {
    pushUndo();
    const sc = state.scene, id = newId(PREFIX[type]);
    if (type === 'geo') {
      // a 10 mm square, 5 mm high, where the view is looking; then seen from above, centred on it
      const s = 5 / MM, h = 5 / MM, a = at || { x: 0, y: 0, z: 0 };
      sc.nodes[id] = { id, type: 'geo', name: 'Geometric ' + id.slice(1), params: { cx: a.x, cy: a.y, z: a.z, h }, pts: [],
        shape: [{ x: -s, y: -s }, { x: s, y: -s }, { x: s, y: s }, { x: -s, y: s }] };
      place(sc, id, insertTarget());
      state.selNodes = new Set([id]); state.sel = new Set();
      markEdited(); recalc();
      if (editor && editor.geoSpawned) editor.geoSpawned(id);
      return;
    }
    if (type === 'thread') {
      sc.nodes[id] = { id, type, name: 'Thread ' + id.slice(1), params: threadDefaults(view) };
      regenThread(sc.nodes[id]);
      place(sc, id, insertTarget());
      state.selNodes = new Set([id]); state.sel = new Set();
      markEdited(); recalc(); return;
    }
    const params = defaultParams(view);
    // a cog: 24 teeth of module 1 mm round a 6 mm bore
    if (type === 'cog') Object.assign(params, { teeth: 24, module: 1 / MM, pressure: 20, addendum: 1, dedendum: 1.25, backlash: 0, rotation: 0, rib: 3 / MM, rit: 3 / MM, linkIn: true, linkOut: true });
    sc.nodes[id] = { id, type, name: (type === 'ngon' ? 'N-sided ' : type === 'cog' ? 'Cog ' : 'Radial ') + id.slice(1), params, pts: tagPts(profileOf(type, params)), custom: false };
    place(sc, id, insertTarget());
    state.selNodes = new Set([id]); state.sel = new Set();
    markEdited(); recalc();
  }
  // Wrap the selection in a container: group (any number) or boolean (one → A, two → A and B).
  function wrapSelection(type) {
    const sc = state.scene, ids = topSelected(sc);
    pushUndo();
    const id = newId(PREFIX[type]);
    const node = type === 'group' ? { id, type: 'group', name: 'Group ' + id.slice(1), children: [] }
      : type === 'cloner' ? { id, type: 'cloner', name: 'Symmetry ' + id.slice(1), children: [],
        params: { count: 6, radius: 0, angle: 0, spread: 360, orient: 'axial', height: zBase(), keepOrient: false } }
      : { id, type: 'boolean', name: 'Boolean ' + id.slice(1), op: 'difference', children: [null, null] };
    sc.nodes[id] = node;
    const usable = type === 'boolean' ? ids.slice(0, 2) : ids;
    if (!usable.length) { place(sc, id, insertTarget()); }
    else {
      const pos = findParent(sc, usable[0]);
      detach(sc, usable[0]);
      place(sc, id, pos);
      node.children[0] = usable[0];
      for (let i = 1; i < usable.length; i++) {
        detach(sc, usable[i]);
        if (type !== 'boolean') node.children.push(usable[i]); else node.children[i] = usable[i];
      }
    }
    state.selNodes = new Set([id]); state.sel = new Set();
    markEdited(); recalc();
  }
  function ungroup(id) {
    const sc = state.scene, n = sc.nodes[id];
    if (!n || n.type !== 'group') return;
    pushUndo();
    const pos = findParent(sc, id), kids = n.children.slice();
    detach(sc, id);
    delete sc.nodes[id];
    if (pos.parent !== null && sc.nodes[pos.parent].type === 'boolean') {
      place(sc, kids[0] != null ? kids.shift() : null, pos);
      kids.forEach(k => sc.root.push(k));
    } else kids.forEach((k, i) => place(sc, k, { parent: pos.parent, slot: pos.slot + i }));
    state.selNodes = new Set(kids);
    markEdited(); recalc();
  }
  // ---- The cross-section at an angle around the axis ----
  // Threads advance along their helix and n-sided objects change radius between their face centres
  // and edges; everything else is the same at every angle. theta: radians, as in the revolve.
  function bandSection(b, phi, helical) {
    const ro = b.runout, pat = ro ? runoutPattern(b) : toothPattern(b), P = b.pitch, d = b.dir, shift = (helical ? (b.hand || 0) : 0) * P * phi / (2 * Math.PI);
    const endR = (z) => ro ? runoutRadiusAt(b, pat, z, shift) : toothAt(b, pat, z - b.zFirst - shift);
    const zs = d > 0 ? b.zMin : b.zMax, ze = d > 0 ? b.zMax : b.zMin, out = [{ y: endR(zs), z: zs }], vs = [];
    const mLo = Math.floor((b.zMin - b.zFirst - shift) / P) - 1, mHi = Math.ceil((b.zMax - b.zFirst - shift) / P) + 1;
    for (let m = mLo; m <= mHi; m++) for (const e of pat) {
      const z = b.zFirst + m * P + e.u + shift;
      const c = ro ? runoutCorner(ro, e, z) : { r: e.r, z };
      if (c.z - b.zMin > 1e-7 && b.zMax - c.z > 1e-7) vs.push({ y: c.r, z: c.z, o: z });
    }
    vs.sort((x, y) => d * (x.o - y.o));
    return out.concat(vs.map(v => ({ y: v.y, z: v.z })), [{ y: endR(ze), z: ze }]);
  }
  function ngonScaleAt(q, theta) {
    const n = Math.max(3, q.sides | 0), seg = 2 * Math.PI / n, scale = q.about === 'faces' ? 1 / Math.cos(Math.PI / n) : 1;
    const a = (((theta - (q.rotation || 0) * Math.PI / 180) % seg) + seg) % seg;
    return scale * Math.cos(Math.PI / n) / Math.cos(a - Math.PI / n);
  }
  // a cog's outline from above, cached per set of tooth parameters
  const cogCache = new Map();
  // (prec: the object's own circular precision, or the project's)
  function cogShapeOf(q, prec) {
    prec = prec > 2 ? prec : state.precision;
    if (ARC_PERFECT) prec = Math.max(prec, 720);
    const k = [prec, q.toothWidth, q.kind, q.teeth, q.module, q.pressure, q.addendum, q.dedendum, q.backlash, q.rotation, q.tipRound, q.rootRound].join('|');
    let s = cogCache.get(k);
    if (!s) { if (cogCache.size > 64) cogCache.clear(); s = cogShape(q, prec); cogCache.set(k, s); }
    return s;
  }
  function sectionOutline(n, theta) {
    if (n.type === 'cog') {
      const sh = cogShapeOf(n.params, n.precision), o = outlineOf(n.pts, []), fix = cogFix(n.params, o), R = cogRadiusAt(sh, theta);
      return o.map(p => ({ y: cogWarp(p.y, R, fix, sh.tip), z: p.z }));
    }
    if (n.type === 'ngon') { const s = ngonScaleAt(n.params, theta); return outlineOf(n.pts, []).map(p => ({ y: p.y * s, z: p.z })); }
    if (!(n.runs || []).length) return outlineOf(n.pts, n.runs);
    const out = [];
    for (const it of expandProfile(n.pts, runsOf(n))) { if (it.band) out.push(...bandSection(it.band, theta, state.helical)); else out.push({ y: it.y, z: it.z }); }
    return out;
  }

  // Copy an object (and everything inside it) under new ids; returns the copy's id.
  function cloneSubtree(sc, id, top = true) {
    const n = sc.nodes[id], nid = newId(PREFIX[n.type] || 'x'), c = clone(n);
    c.id = nid;
    if (top) c.name = (n.name || n.id) + ' copy';
    if (isContainer(n)) c.children = n.children.map(k => k != null && sc.nodes[k] ? cloneSubtree(sc, k, false) : null);
    if (c.type === 'thread') for (const r of c.runs || []) r.label = c.name || 'Thread';
    sc.nodes[nid] = c;
    return nid;
  }
  // Duplicate objects: next to each original, or all at a target position (a drop in the list).
  function duplicateNodes(ids, target) {
    const sc = state.scene;
    ids = ids.filter(id => sc.nodes[id] && findParent(sc, id));
    if (!ids.length) return [];
    pushUndo();
    const out = [];
    for (const id of ids) {
      const nid = cloneSubtree(sc, id);
      let t = target;
      if (!t) {
        // right after the original; a copy of a boolean operand goes after the boolean
        let p = findParent(sc, id);
        while (p.parent !== null && sc.nodes[p.parent].type === 'boolean') p = findParent(sc, p.parent);
        t = { parent: p.parent, slot: p.slot + 1 };
      } else if (t.parent !== null && sc.nodes[t.parent].type === 'boolean' && sc.nodes[t.parent].children[t.slot] != null) {
        // an occupied boolean slot: use the other slot if it is empty, else put the copy after the boolean
        const b = sc.nodes[t.parent], s = b.children.indexOf(null);
        if (s >= 0) t = { parent: t.parent, slot: s };
        else { const p = findParent(sc, t.parent); t = { parent: p.parent, slot: p.slot + 1 }; }
      }
      place(sc, nid, t);
      if (target && target.slot != null && (target.parent === null || sc.nodes[target.parent].type !== 'boolean')) target = { ...target, slot: target.slot + 1 };
      out.push(nid);
    }
    state.selNodes = new Set(out); state.sel = new Set();
    markEdited(); recalc();
    return out;
  }
  function deleteNodes(ids) {
    const sc = state.scene;
    ids = ids.filter(id => sc.nodes[id]);
    if (!ids.length) return;
    pushUndo();
    for (const id of ids) {
      if (!sc.nodes[id]) continue;
      const n = sc.nodes[id];
      detach(sc, id);
      // children of a deleted container move to the top level
      if (isContainer(n)) n.children.forEach(c => { if (c != null && sc.nodes[c]) sc.root.push(c); });
      delete sc.nodes[id];
      state.selNodes.delete(id);
    }
    state.sel = new Set([...state.sel].filter(k => sc.nodes[parseKey(k).node]));
    markEdited(); recalc();
  }

  // ---------------------------------------------------------------------------
  // 6. Saved models (this browser's localStorage).
  // ---------------------------------------------------------------------------
  const LIB_KEY = 'adapterAssembler.savedModels';
  function libLoad() { try { const v = JSON.parse(localStorage.getItem(LIB_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } }
  function libStore(list) { try { localStorage.setItem(LIB_KEY, JSON.stringify(list)); return true; } catch (_) { return false; } }
  function extractSubtree(sc, id) {
    const nodes = {};
    for (const i of subtreeIds(sc, id)) if (sc.nodes[i]) nodes[i] = clone(sc.nodes[i]);
    return { rootId: id, nodes };
  }
  function remapSubtree(sub, mkId) {
    const map = {};
    for (const id in sub.nodes) map[id] = mkId(sub.nodes[id]);
    const nodes = {};
    for (const id in sub.nodes) {
      const n = clone(sub.nodes[id]);
      n.id = map[id];
      if (n.children) n.children = n.children.map(c => c == null ? null : map[c]);
      nodes[n.id] = n;
    }
    return { rootId: map[sub.rootId], nodes };
  }
  function saveToLibrary(ids, name) {
    const sc = state.scene;
    ids = ids.filter(id => sc.nodes[id]);
    if (!ids.length) { state.libMessage = 'Nothing to save: the scene is empty.'; renderAll(); return; }
    let sub;
    if (ids.length === 1) sub = extractSubtree(sc, ids[0]);
    else {
      // several objects are saved together as one group
      sub = { rootId: '__g', nodes: { __g: { id: '__g', type: 'group', name: name || 'Saved group', children: ids.slice() } } };
      for (const id of ids) Object.assign(sub.nodes, extractSubtree(sc, id).nodes);
    }
    const root = sub.nodes[sub.rootId];
    const list = libLoad();
    list.push({ id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name || ((root.name || root.type) + (ids.length > 1 ? ' (' + ids.length + ' objects)' : '')),
      date: new Date().toISOString(), units: 'in', model: sub });
    state.libMessage = libStore(list) ? 'Saved "' + list[list.length - 1].name + '" to this browser.' : 'Could not save: browser storage is unavailable or full.';
    renderAll();
  }
  function saveScene() {
    const sc = state.scene;
    saveToLibrary(sc.root.slice(), 'Scene ' + partName() + ' ' + new Date().toLocaleString());
  }
  function insertFromLibrary(entry) {
    pushUndo();
    const sc = state.scene;
    const sub = remapSubtree(entry.model, (n) => newId(PREFIX[n.type] || 'x'));
    Object.assign(sc.nodes, sub.nodes);
    place(sc, sub.rootId, insertTarget());
    state.selNodes = new Set([sub.rootId]); state.sel = new Set();
    markEdited(); recalc();
  }
  function exportNode(id) {
    const sub = extractSubtree(state.scene, id);
    exportScene({ nodes: sub.nodes, root: [id] }, partName() + '-' + (state.scene.nodes[id].name || id));
  }
  function exportEntry(entry) { exportScene({ nodes: entry.model.nodes, root: [entry.model.rootId] }, entry.name); }

  // ---- The last scene, remembered in this browser ----
  const LAST_KEY = 'adapterAssembler.lastScenes';
  const sceneKey = () => 'last';
  function lastScenes() { try { const v = JSON.parse(localStorage.getItem(LAST_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; } }
  function lastScene(key) {
    const all = lastScenes();
    const rec = key ? all[key] : Object.values(all).sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
    return rec && validScene(rec.scene) ? rec : null;
  }
  let rememberTimer = 0;
  function rememberScene() {
    clearTimeout(rememberTimer);
    rememberTimer = setTimeout(() => {
      if (!state.scene) return;
      const all = lastScenes(), key = sceneKey();
      // an empty scene needs no copy
      if (!state.scene.root.length) { if (all[key]) { delete all[key]; try { localStorage.setItem(LAST_KEY, JSON.stringify(all)); } catch (_) { /* ignore */ } } return; }
      all[key] = { scene: sceneForFile(state.scene), angle: state.viewAngle, date: new Date().toISOString(), name: partName() };
      // keep the 8 most recent
      const keys = Object.keys(all).sort((a, b) => (all[b].date || '').localeCompare(all[a].date || ''));
      for (const k of keys.slice(8)) delete all[k];
      try { localStorage.setItem(LAST_KEY, JSON.stringify(all)); } catch (_) { /* storage full or unavailable */ }
    }, 400);
  }

  // ---- JSON files: a whole scene, or saved models, that can be loaded again to rebuild everything ----
  // Lengths are in inches; every object keeps its own outline, thread parameters and bevels,
  // so the file rebuilds the scene on its own.
  const JSON_FORMAT = 'adapter-assembler', JSON_FORMATS_READ = new Set([JSON_FORMAT, 'preciseparts-stl-export']);
  const NODE_TYPES = new Set(['source', 'circle', 'ngon', 'cog', 'thread', 'group', 'boolean', 'cloner', 'holes', 'geo']);
  function sceneForFile(sc) {
    const s = clone(sc);
    return s;
  }
  function saveJson(obj, name) { saveFile(new TextEncoder().encode(JSON.stringify(obj, null, 1)), 'json', name); }
  function exportSceneJson() {
    saveJson({ format: JSON_FORMAT, version: 1, kind: 'scene', units: 'in', created: new Date().toISOString(),
      scene: sceneForFile(state.scene), view: { angle: state.viewAngle, helical: state.helical, flip: state.flip } }, partName() + '-scene');
  }
  function exportModelsJson(entries, name) {
    saveJson({ format: JSON_FORMAT, version: 1, kind: 'models', units: 'in', created: new Date().toISOString(), models: clone(entries) }, name);
  }
  function validScene(sc) {
    if (!sc || typeof sc.nodes !== 'object' || !Array.isArray(sc.root)) return false;
    for (const [id, n] of Object.entries(sc.nodes)) {
      if (!n || n.id !== id || !NODE_TYPES.has(n.type)) return false;
      if (n.children && !n.children.every(c => c == null || sc.nodes[c])) return false;
      if (!n.children && n.type !== 'holes' && !Array.isArray(n.pts)) return false;
      if (n.type === 'geo' && (!Array.isArray(n.shape) || n.shape.length < 3 || !n.params)) return false;
    }
    if (!sc.root.every(id => sc.nodes[id])) return false;
    for (const n of Object.values(sc.nodes)) if (n.type === 'geo') geoRecentre(n);   // shapes from older versions too
    return true;
  }
  // Load a JSON file: a scene replaces the current scene (Undo brings the old one back);
  // saved models are added to My saved models.
  function importJsonFile(file) {
    const rd = new FileReader();
    rd.onload = () => {
      let data;
      try { data = JSON.parse(rd.result); } catch (e) { state.libMessage = 'Could not read ' + file.name + ': not a JSON file.'; renderAll(); return; }
      if (!data || !JSON_FORMATS_READ.has(data.format)) { state.libMessage = file.name + ' is not a scene or model file from this tool.'; renderAll(); return; }
      if (W.__aaOnProjectLoaded) W.__aaOnProjectLoaded();
      if (data.kind === 'scene') {
        if (!validScene(data.scene)) { state.libMessage = file.name + ': the scene in the file is damaged.'; renderAll(); return; }
        if (state.scene) pushUndo();
        state.scene = clone(data.scene);
        state.scene.seq = Math.max(state.scene.seq || 1, Object.keys(state.scene.nodes).length + 1);
        if (data.view && isFinite(data.view.angle)) state.viewAngle = data.view.angle;
        state.sel = new Set(); state.selNodes = new Set(); state.edited = true; sceneReplaced();
        state.libMessage = 'Loaded the scene from ' + file.name + ' (Undo returns to the previous scene).';
        markEdited(); recalc(); return;
      }
      const models = data.kind === 'models' ? data.models : data.kind === 'model' ? [data.model] : null;
      const ok = (models || []).filter(m => m && m.model && validScene({ nodes: m.model.nodes, root: [m.model.rootId] }));
      if (!ok.length) { state.libMessage = file.name + ': no usable models in the file.'; renderAll(); return; }
      const list = libLoad();
      for (const m of ok) list.push({ ...clone(m), id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), date: m.date || new Date().toISOString() });
      if (!state.scene || !state.scene.root.length) {
        // nothing open yet: open the models as the scene
        state.scene = { nodes: {}, root: [], seq: 1 };
        for (const m of ok) { const sub = remapSubtree(m.model, (n) => newId(PREFIX[n.type] || 'x')); Object.assign(state.scene.nodes, sub.nodes); state.scene.root.push(sub.rootId); }
        state.edited = true; sceneReplaced(); markEdited(); recalc();
      }
      state.libMessage = libStore(list) ? 'Added ' + ok.length + ' model' + (ok.length === 1 ? '' : 's') + ' from ' + file.name + ' to My saved models.' : 'Could not save: browser storage is unavailable or full.';
      renderAll();
    };
    rd.readAsText(file);
  }
  function pickJsonFile() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,application/json'; inp.style.display = 'none';
    inp.addEventListener('change', () => { if (inp.files && inp.files[0]) importJsonFile(inp.files[0]); inp.remove(); });
    document.body.appendChild(inp); inp.click();
  }

  // ---------------------------------------------------------------------------
  // 7. Point and edge editing (all lengths in inches).
  //    Selection keys: "node|p|i" point, "node|r|run|k" thread vertex,
  //    "node|e|i" edge from point i to point i+1.
  // ---------------------------------------------------------------------------
  function parseKey(k) { const [node, kind, a, b] = k.split('|'); return { node, kind, i: +a, ri: +a, k: +b }; }
  function syncRunPts(node, r) { const a = node.pts[r.start], b = node.pts[r.end]; a.y = r.rFirst; a.z = r.zFirst; b.z = r.zLast; }
  function inRunIndex(node, i) { return (node.runs || []).some(r => i >= r.start && i <= r.end); }
  // Edges whose two ends are ordinary points.
  function edgeOk(node, i) { const n = node.pts.length; return !inRunIndex(node, i) && !inRunIndex(node, (i + 1) % n); }
  // Expand edges into their two end points.
  function pointKeys(keys, sc = state.scene) {
    const out = new Set();
    for (const k of keys) {
      const h = parseKey(k);
      if (h.kind === 'e') { const n = sc.nodes[h.node]; if (!n) continue; out.add(h.node + '|p|' + h.i); out.add(h.node + '|p|' + ((h.i + 1) % n.pts.length)); }
      else out.add(k);
    }
    return [...out];
  }

  function moveKeys(scene, keys, dy, dz) {
    const groupsDone = new Set(), runSel = new Map();
    for (const key of pointKeys(keys, scene)) {
      const h = parseKey(key), node = scene.nodes[h.node];
      if (!node || h.kind === 'q' || h.kind === 'qe') continue;           // (a geometric object's corners move from above)
      if (h.kind === 'p') {
        const p = node.pts[h.i]; if (!p) continue;
        p.y = Math.max(0, p.y + dy); p.z += dz;
        if (node.params) node.custom = true;
      } else {
        const r = node.runs[h.ri]; if (!r) continue;
        const v = runVertices(r)[h.k]; if (!v) continue;
        const gk = h.node + '|' + h.ri + '|' + v.group;
        if (v.group && !groupsDone.has(gk)) {
          groupsDone.add(gk);
          if (v.group === 'first') r.rFirst = Math.max(0, r.rFirst + dy); else r.rOther = Math.max(0, r.rOther + dy);
        }
        const rk = h.node + '|' + h.ri;
        const s = runSel.get(rk) || { node, r, first: false, last: false, mid: false };
        s[v.role] = true;
        runSel.set(rk, s);
      }
    }
    // A middle thread vertex (or both ends) moves the whole thread up/down; one end alone changes where it starts or ends.
    for (const s of runSel.values()) {
      const r = s.r;
      if (dz) {
        if (s.mid || (s.first && s.last)) { r.zFirst += dz; r.zLast += dz; }
        else if (s.first && Math.abs(r.zLast - (r.zFirst + dz)) >= r.pitch) r.zFirst += dz;
        else if (s.last && Math.abs(r.zLast + dz - r.zFirst) >= r.pitch) r.zLast += dz;
      }
      syncRunPts(s.node, r);
    }
  }
  function moveNode(node, dy, dz) {
    if (node.type === 'geo') { node.params.cx += dy; node.params.z += dz; return; }
    for (const p of node.pts) { p.y = Math.max(0, p.y + dy); p.z += dz; }
    for (const r of node.runs || []) { r.rFirst = Math.max(0, r.rFirst + dy); r.rOther = Math.max(0, r.rOther + dy); r.zFirst += dz; r.zLast += dz; }
    if (node.params) {
      const q = node.params; q.z += dz;
      if (node.type === 'thread') q.d = Math.max(0, q.d + 2 * dy);
      else for (const k of ['rib', 'rit', 'rob', 'rot']) q[k] = Math.max(0, q[k] + dy);
    }
  }
  function setBevel(keys, bevel) {
    for (const key of pointKeys(keys)) {
      const h = parseKey(key), node = state.scene.nodes[h.node];
      if (!node || h.kind !== 'p' || !node.pts[h.i]) continue;
      node.pts[h.i].bevel = bevel ? { ...bevel } : null;
      if (node.params) node.custom = true;
    }
  }
  function deletePoints(keys) {
    const byNode = {};
    const byGeo = {};
    for (const key of pointKeys(keys)) { const h = parseKey(key); if (h.kind === 'p') (byNode[h.node] = byNode[h.node] || []).push(h.i); else if (h.kind === 'q') (byGeo[h.node] = byGeo[h.node] || []).push(h.i); }
    let refused = false;
    // a geometric object's corners (it keeps at least three)
    for (const id in byGeo) {
      const node = state.scene.nodes[id];
      if (!node || !node.shape) continue;
      const idx = [...new Set(byGeo[id])].sort((a, b) => b - a);
      if (node.shape.length - idx.length < 3) { refused = true; continue; }
      for (const i of idx) node.shape.splice(i, 1);
      geoRecentre(node);
    }
    for (const id in byNode) {
      const node = state.scene.nodes[id];
      const idx = [...new Set(byNode[id])].filter(i => !inRunIndex(node, i)).sort((a, b) => b - a);
      if (node.pts.length - idx.length < 3) { refused = true; continue; }
      for (const i of idx) { node.pts.splice(i, 1); for (const r of node.runs || []) if (r.start > i) { r.start--; r.end--; } }
      if (node.params) node.custom = true;
    }
    return !refused;
  }
  // Positions of n evenly spaced new points on the edge after point i.
  function edgeSamples(node, i, count) {
    const n = node.pts.length, a = node.pts[i], b = node.pts[(i + 1) % n], out = [];
    for (let k = 1; k <= count; k++) { const t = k / (count + 1); out.push({ y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }); }
    return out;
  }
  // Insert points after point i (on the edge to the next point); returns their keys.
  function insertOnEdge(nodeId, i, count) {
    const node = state.scene.nodes[nodeId];
    if (!node || count < 1) return [];
    const pts = edgeSamples(node, i, count).map(p => ({ y: p.y, z: p.z, bevel: null }));
    node.pts.splice(i + 1, 0, ...pts);
    for (const r of node.runs || []) if (r.start >= i + 1) { r.start += count; r.end += count; }
    if (node.params) node.custom = true;
    return pts.map((_, k) => nodeId + '|p|' + (i + 1 + k));
  }

  function pushSnap(s) { state.undo.push(s); if (state.undo.length > 100) state.undo.shift(); state.redo = []; }
  function pushUndo() { if (state.undoLock) return; if (state.scene) pushSnap(clone(state.scene)); }
  function markEdited() { state.edited = true; if (state.scene) for (const n of Object.values(state.scene.nodes)) rationalize(n); }
  function pruneSelection() {
    const sc = state.scene;
    state.sel = new Set([...state.sel].filter(k => { const h = parseKey(k), n = sc.nodes[h.node]; return n && (h.kind !== 'p' && h.kind !== 'e' || h.i < n.pts.length); }));
    state.selNodes = new Set([...state.selNodes].filter(id => sc.nodes[id]));
  }
  function undo() {
    if (!state.undo.length) return;
    state.redo.push(clone(state.scene));
    state.scene = state.undo.pop();
    pruneSelection();
    state.edited = JSON.stringify(state.scene) !== JSON.stringify(freshScene());
    recalc();
  }
  function redo() {
    if (!state.redo.length) return;
    state.undo.push(clone(state.scene));
    state.scene = state.redo.pop();
    pruneSelection();
    state.edited = JSON.stringify(state.scene) !== JSON.stringify(freshScene());
    recalc();
  }

  // ---------------------------------------------------------------------------
  // 8. DOM helpers and shared widgets.
  // ---------------------------------------------------------------------------
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const k in attrs || {}) {
      const v = attrs[k];
      if (v == null) continue;
      if (k === 'style') e.style.cssText = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (typeof v !== 'string') e[k] = v;
      else e.setAttribute(k, v);
    }
    for (const c of kids) if (c != null && c !== false) e.append(c);
    return e;
  }
  // Small animations for menus and panels that appear or change with the selection.
  const lowQuality = () => state.quality === 'low';
  const reduceMotion = () => { if (lowQuality()) return true; try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; } };
  function animIn(e, o = {}) {
    if (!e || !e.animate || reduceMotion()) return;
    e.animate([{ opacity: 0, transform: o.from || 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: o.ms || 170, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  // Rebuild an element and animate its height from the old size to the new one.
  function animResize(e, rebuild) {
    if (!e.animate || reduceMotion() || e.style.display === 'none') { rebuild(); return; }
    const h0 = e.offsetHeight;
    rebuild();
    const h1 = e.offsetHeight;
    if (Math.abs(h1 - h0) > 1 && h0 > 0) e.animate([{ height: h0 + 'px', overflow: 'hidden' }, { height: h1 + 'px', overflow: 'hidden' }], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  const selectionSig = () => [...state.selNodes].sort().join(',') + '|' + [...state.sel].sort().join(',');
  function appendKids(parent, ...kids) { for (const c of kids) if (c != null && c !== false) parent.append(c); }
  const SVGNS = 'http://www.w3.org/2000/svg';
  function sv(tag, attrs) { const e = document.createElementNS(SVGNS, tag); for (const k in attrs || {}) e.setAttribute(k, attrs[k]); return e; }
  const mm = (v) => v * UNIT_SCALE;
  const fmt = (v, d) => (v * UNIT_SCALE).toFixed(d);
  const num = (v, d = 3) => (+(+v).toFixed(d)).toString();
  const BTN = 'padding:4px 8px;font:600 12px/1.2 sans-serif;color:#fff;background:#1f6feb;border:0;border-radius:4px;cursor:pointer';
  const BTN2 = 'padding:3px 7px;font:600 12px/1.2 sans-serif;color:#1f2328;background:#eaeef2;border:1px solid #d0d7de;border-radius:4px;cursor:pointer';
  const BOX = 'padding:4px 6px;border:1px solid #d0d7de;border-radius:4px;background:#f6f8fa;font-size:12px;margin-bottom:5px';
  // Line icons, all drawn in the same 16 × 16 box so they line up at one size.
  const ARC = 'A4.2 4.2 0 ';
  const ICONS = {
    circle: '<circle cx="8" cy="8" r="5.5"/>',
    ngon: '<path d="M8 2.2 13 5.1v5.8L8 13.8 3 10.9V5.1z"/>',
    geo: '<path d="M2.5 13 5.8 2.6 13.6 10.2z"/>',
    cog: '<path d="M12.85 6.79L14.75 7.20L14.75 8.80L12.85 9.21L12.28 10.58L13.34 12.21L12.21 13.34L10.58 12.28L9.21 12.85L8.80 14.75L7.20 14.75L6.79 12.85L5.42 12.28L3.79 13.34L2.66 12.21L3.72 10.58L3.15 9.21L1.25 8.80L1.25 7.20L3.15 6.79L3.72 5.42L2.66 3.79L3.79 2.66L5.42 3.72L6.79 3.15L7.20 1.25L8.80 1.25L9.21 3.15L10.58 3.72L12.21 2.66L13.34 3.79L12.28 5.42z"/><circle cx="8" cy="8" r="2.2"/>',
    sideview: '<path d="M8 1.5v13" stroke-dasharray="1.6 1.6"/><rect x="10" y="4" width="3.8" height="8"/><rect x="2.2" y="4" width="3.8" height="8"/>',
    topview: '<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="2.4"/><path d="M8 8h6"/>',
    mono: '<path d="M2.5 6.5h5v-4h6v8h-5v3h-6z"/>',
    transform: '<path d="M8 1.5v13M1.5 8h13M6 3.5 8 1.5l2 2M6 12.5l2 2 2-2M3.5 6 1.5 8l2 2M12.5 6l2 2-2 2"/>',
    thread: '<path d="M2 5l3-2 3 2 3-2 3 2M2 9l3-2 3 2 3-2 3 2M2 13l3-2 3 2 3-2 3 2"/>',
    cloner: '<circle cx="8" cy="8" r="1.3"/><circle cx="8" cy="2.9" r="1.3"/><circle cx="12.4" cy="10.6" r="1.3"/><circle cx="3.6" cy="10.6" r="1.3"/><path d="M8 6.7V4.2M9.1 8.6l2.2 1.3M6.9 8.6 4.7 9.9" stroke-width="1"/>',
    group: '<rect x="2" y="5" width="8.5" height="8.5" rx="1"/><path d="M5.5 5V2.5H14V11h-3.5"/>',
    boolean: '<circle cx="6" cy="8" r="4.2"/><circle cx="10" cy="8" r="4.2"/>',
    union: '<path d="M8 4.31' + ARC + '1 0 8 11.69' + ARC + '1 0 8 4.31z" fill="currentColor" fill-opacity=".25"/>',
    difference: '<path d="M8 4.31' + ARC + '1 0 8 11.69' + ARC + '0 1 8 4.31z" fill="currentColor" fill-opacity=".25"/><path d="M8 4.31' + ARC + '1 1 8 11.69" stroke-dasharray="1.4 1.6" stroke-width="1"/>',
    intersection: '<circle cx="6" cy="8" r="4.2" stroke-width="1" stroke-dasharray="1.4 1.6"/><circle cx="10" cy="8" r="4.2" stroke-width="1" stroke-dasharray="1.4 1.6"/><path d="M8 4.31' + ARC + '0 0 8 11.69' + ARC + '0 0 8 4.31z" fill="currentColor" fill-opacity=".3"/>',
    holes: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2"/>',
    source: '<path d="M3 13.5v-11h4l2 3.5h4v7.5z"/>',
    undo: '<path d="M5.5 3 2.5 6l3 3M2.5 6H10a3.5 3.5 0 0 1 0 7H6"/>',
    redo: '<path d="m10.5 3 3 3-3 3M13.5 6H6a3.5 3.5 0 0 0 0 7h4"/>',
    save: '<path d="M3 2.5h8l2.5 2.5v8.5H3z"/><path d="M5.5 2.5V6h4.5V2.5M5 13.5v-4h6v4"/>',
    download: '<path d="M8 2.5v8M4.5 7.5 8 11l3.5-3.5M2.5 13.5h11"/>',
    upload: '<path d="M8 11V3M4.5 6.5 8 3l3.5 3.5M2.5 13.5h11"/>',
    fit: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>',
    duplicate: '<rect x="5" y="5" width="8.5" height="8.5" rx="1"/><path d="M11 5V2.5H2.5V11H5"/>',
    trash: '<path d="M2.5 4.5h11M6 4.5v-2h4v2M4 4.5l.8 9h6.4l.8-9"/>',
    ungroup: '<rect x="2" y="2" width="5.5" height="5.5" rx="1"/><rect x="8.5" y="8.5" width="5.5" height="5.5" rx="1"/>',
    list: '<path d="M6 4h7.5M6 8h7.5M6 12h7.5M2.5 4h.5M2.5 8h.5M2.5 12h.5"/>',
    add: '<path d="M8 3v10M3 8h10"/>',
    pin: '<path d="M6 2h4l-.6 4 2.6 2.4H4L6.6 6z"/><path d="M8 8.4V14"/>',
    ruler: '<path d="M1.8 11.2 11.2 1.8l3 3-9.4 9.4z"/><path d="M4.6 8.4l1.4 1.4M6.6 6.4l.9.9M8.6 4.4l1.4 1.4"/>',
    eye: '<path d="M1.5 8s2.4-4.3 6.5-4.3S14.5 8 14.5 8s-2.4 4.3-6.5 4.3S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.9"/>',
    eyeoff: '<path d="M1.5 8s2.4-4.3 6.5-4.3S14.5 8 14.5 8s-2.4 4.3-6.5 4.3S1.5 8 1.5 8z" stroke-opacity=".45"/><path d="M2.5 13.5 13.5 2.5"/>',
    pick: '<path d="M4 2.2l8.2 6.1-3.7.7 2.1 4-1.7.9-2.1-4L4 12.6z"/>',
    pickoff: '<path d="M4 2.2l8.2 6.1-3.7.7 2.1 4-1.7.9-2.1-4L4 12.6z" stroke-opacity=".45"/><path d="M2.5 13.5 13.5 2.5"/>',
    json: '<path d="M6 2.5c-1.5 0-2 .7-2 2v1.5c0 1-.5 2-1.5 2 1 0 1.5 1 1.5 2v1.5c0 1.3.5 2 2 2M10 2.5c1.5 0 2 .7 2 2v1.5c0 1 .5 2 1.5 2-1 0-1.5 1-1.5 2v1.5c0 1.3-.5 2-2 2"/>',
  };
  function icon(name, size) {
    const s = document.createElementNS(SVGNS, 'svg'), px = String(size || 14);
    for (const [k, v] of Object.entries({ viewBox: '0 0 16 16', width: px, height: px, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, v);
    s.style.cssText = 'flex:0 0 auto;display:block';
    s.innerHTML = ICONS[name] || ICONS.source;
    return s;
  }
  const nodeIcon = (n) => n.type === 'boolean' ? (n.op || 'union') : n.type;
  // compact buttons for view headers and the side bar footer: an icon, and a label that hides when there is no room
  const HBTN = 'display:inline-flex;align-items:center;gap:3px;height:20px;box-sizing:border-box;padding:0 5px;font:600 11px/1 sans-serif;color:#1f2328;background:#fff;border:1px solid #ced4da;border-radius:4px;cursor:pointer;white-space:nowrap;flex:0 0 auto';
  function hbtn(ic, label, onclick, opts) {
    opts = opts || {};
    const b = el('button', { type: 'button', style: HBTN + (opts.color ? ';color:' + opts.color : ''), title: opts.title || label }, icon(ic, 13), label ? el('span', { class: 'aa-hl' }, label) : null);
    if (opts.disabled) { b.disabled = true; b.style.opacity = '0.45'; b.style.cursor = 'default'; }
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => { e.stopPropagation(); onclick(e); });
    return b;
  }
  const H = 'font-weight:700;font-size:12px;margin:0 0 3px;color:#1f2328';

  function checkRow(text, get, set, title) {
    const box = el('input', { type: 'checkbox' });
    box.checked = !!get();
    box.addEventListener('change', () => set(box.checked));
    return el('label', { style: 'display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;margin:3px 0', title: title || null }, box, document.createTextNode(text));
  }
  // A number field. value may be a function: the field then refreshes while another field is being edited.
  // ---- Numbers typed with units: "1in", "25.4 mm", "2.5cm", "1 1/4\"", "1ft 3in", "90deg", "0.5 turn", and sums or
  //      products ("10 + 2mm", "3*1.5"). They are converted to the unit the field shows. Fields: 'len', 'ang' or none. ----
  const LEN_UNITS = [['millimeters|millimetres|millimeter|millimetre|mm', 1 / 25.4], ['centimeters|centimetres|centimeter|centimetre|cm', 10 / 25.4],
    ['micrometers|micrometres|microns|micron|µm|um', 0.001 / 25.4], ['meters|metres|meter|metre|m', 1000 / 25.4], ['inches|inch|in|"|”|″', 1],
    ['feet|foot|ft|\'|’|′', 12], ['yards|yard|yd', 36], ['thou|mils|mil', 0.001]];
  const ANG_UNITS = [['degrees|degree|deg|°', 1], ['radians|radian|rad', 180 / Math.PI], ['revolutions|revolution|turns|turn|revs|rev', 360],
    ['gradians|gradian|grads|grad|gons|gon', 0.9], ['arcminutes|arcminute|arcmin|\'|’|′', 1 / 60], ['arcseconds|arcsecond|arcsec|"|”|″', 1 / 3600]];
  function parseQty(text, kind) {
    const s = String(text == null ? '' : text).trim().toLowerCase().replace(/,/g, '.').replace(/[−–]/g, '-').replace(/[×·]/g, '*').replace(/÷/g, '/');
    if (!s) return NaN;
    if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return parseFloat(s);
    // each unit's factor to the field's shown unit
    const units = (kind === 'len' ? LEN_UNITS.map(([a, f]) => [a, f * UNIT_SCALE]) : kind === 'ang' ? ANG_UNITS.map(([a, f]) => [a, f * ANG_SCALE]) : [])
      .flatMap(([a, f]) => a.split('|').map(w => [w, f])).sort((x, y) => y[0].length - x[0].length);
    const tk = [];
    for (let i = 0; i < s.length;) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      const nm = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
      if (nm) { tk.push({ n: parseFloat(nm[1]) }); i += nm[1].length; continue; }
      if ('+-*/()^'.includes(c)) { tk.push({ op: c }); i++; continue; }
      const fn = /^(sqrt|abs|sin|cos|tan|pi|π)(?![a-z])/.exec(s.slice(i));
      if (fn) { tk.push(fn[1] === 'pi' || fn[1] === 'π' ? { n: Math.PI } : { fn: fn[1] }); i += fn[1].length; continue; }
      const un = units.find(([w]) => s.startsWith(w, i) && !(/[a-zµ]/.test(w[w.length - 1]) && /[a-zµ]/.test(s[i + w.length] || '')));
      if (un) { tk.push({ u: un[1] }); i += un[0].length; continue; }
      return NaN;
    }
    let p = 0;
    const peek = () => tk[p], isN = (t) => t && t.n != null, isOp = (t, o) => t && t.op === o;
    function primary() {
      let v, t = peek();
      if (t && t.fn) {
        // sqrt(…), abs(…), sin/cos/tan(… in degrees)
        p++; if (!isOp(peek(), '(')) throw 0; p++;
        const a = expr(); if (!isOp(peek(), ')')) throw 0; p++;
        v = t.fn === 'sqrt' ? Math.sqrt(a) : t.fn === 'abs' ? Math.abs(a) : Math[t.fn](a * Math.PI / 180);
      } else if (isOp(t, '(')) { p++; v = expr(); if (!isOp(peek(), ')')) throw 0; p++; }
      else if (isN(t)) {
        p++; v = t.n;
        // a mixed number (1 1/4) or a fraction (3/8) stays together, so a unit after it applies to all of it
        if (isN(peek()) && isOp(tk[p + 1], '/') && isN(tk[p + 2])) { v += peek().n / tk[p + 2].n; p += 3; }
        else if (isOp(peek(), '/') && isN(tk[p + 1]) && tk[p + 2] && tk[p + 2].u != null) { v /= tk[p + 1].n; p += 2; }
      } else throw 0;
      if (peek() && peek().u != null) { v *= peek().u; p++; primary.unit = true; }
      return v;
    }
    function power() { const v = primary(); if (isOp(peek(), '^')) { p++; return Math.pow(v, factor()); } return v; }
    function factor() { if (isOp(peek(), '-')) { p++; return -factor(); } if (isOp(peek(), '+')) { p++; return factor(); } return power(); }
    function term() {
      let v = factor();
      while (isOp(peek(), '*') || isOp(peek(), '/')) { const o = tk[p++].op, w = factor(); v = o === '*' ? v * w : v / w; }
      return v;
    }
    function expr() {
      primary.unit = false;
      let v = term();
      for (;;) {
        if (isOp(peek(), '+') || isOp(peek(), '-')) { const o = tk[p++].op; primary.unit = false; const w = term(); v = o === '+' ? v + w : v - w; }
        else if (primary.unit && (isN(peek()) || isOp(peek(), '(') || (peek() && peek().fn))) { primary.unit = false; v += term(); }    // 1ft 3in, 5' 3"
        else return v;
      }
    }
    try { const v = expr(); return p === tk.length && isFinite(v) ? v : NaN; } catch (_) { return NaN; }
  }
  // A number field takes typed units: on the first key that is not part of a plain number it becomes a text field
  // (its live updates wait), and when it is committed the text is worked out and it becomes a number field again.
  const plainKey = (k) => /^[0-9.\-]$/.test(k);
  function unitKey(e, inp) {
    if (inp.tagName !== 'INPUT' || inp.type !== 'number' || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || plainKey(e.key)) return;
    const v = inp.value;
    e.preventDefault();
    // (a number field can't say what is selected in it: __all says the whole of it is, as after Tab or Ctrl+A)
    inp.type = 'text'; inp.__unitText = true; inp.value = (inp.__all ? '' : v) + e.key; inp.__all = false;
    try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (_) { /* ignore */ }
  }
  function unitCommit(inp) {
    if (!inp.__unitText) return;
    const v = parseQty(inp.value, inp.dataset.unit);
    inp.__unitText = false; inp.type = 'number';
    inp.value = isFinite(v) ? String(+v.toFixed(6)) : '';
  }
  if (typeof document !== 'undefined' && !W.__aaUnitFields) {
    W.__aaUnitFields = true;
    // typed text with units: no live update until it is committed
    document.addEventListener('input', (e) => { const t = e.target; if (t && t.__unitText && !/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t.value.trim())) e.stopImmediatePropagation(); }, true);
    document.addEventListener('change', (e) => unitCommit(e.target), true);
    // whether all of a number field is selected: on reaching it with Tab (everything selected) and after Ctrl+A,
    // not after a click in it or any other key
    document.addEventListener('focusin', (e) => { if (e.target && e.target.type === 'number') e.target.__all = true; }, true);
    document.addEventListener('click', (e) => { if (e.target && e.target.type === 'number') e.target.__all = false; }, true);
    document.addEventListener('blur', (e) => { const t = e.target; if (t && t.__unitText) { unitCommit(t); t.dispatchEvent(new Event('change', { bubbles: true })); } }, true);
    document.addEventListener('keydown', (e) => { const t = e.target; if (t && t.__unitText && e.key === 'Enter') { unitCommit(t); t.dispatchEvent(new Event('change', { bubbles: true })); } }, true);
  }
  function numInput(value, set, o = {}) {
    const get = typeof value === 'function' ? value : () => value, dg = o.digits != null ? o.digits : 4;
    const show = () => { const v = get(); return v == null || v === '' || !isFinite(v) ? '' : num(v, dg); };
    const inp = el('input', { type: 'number', step: o.step || '0.01', value: show(), style: 'width:' + (o.width || 80) + 'px;box-sizing:border-box', placeholder: o.placeholder || null, title: o.title || null });
    if (o.min != null) inp.min = String(o.min);
    if (o.max != null) inp.max = String(o.max);
    inp.disabled = !!o.disabled;
    if (typeof value === 'function') inp.__get = show;
    const src = String(value) + String(set);
    inp.dataset.unit = o.unit || (/ANG_SCALE/.test(src) ? 'ang' : /UNIT_SCALE|\bmm\(|hDisp/.test(src) ? 'len' : '');
    // live: every keystroke updates the model (one undo step per field edit)
    inp.addEventListener('focus', () => { inp.__fresh = true; });
    const apply = (live) => {
      const empty = inp.value.trim() === '', v = parseFloat(inp.value);
      if (!(empty && o.allowEmpty) && !isFinite(v)) { if (!live) inp.value = show(); return; }
      const first = inp.__fresh !== false; inp.__fresh = false;
      state.undoLock = !first; state.liveInput = live;
      try { set(empty && o.allowEmpty ? null : v); } finally { state.undoLock = false; state.liveInput = false; }
    };
    if (!o.noLive) inp.addEventListener('input', () => apply(true));
    inp.addEventListener('change', () => { inp.__fresh = false; apply(false); });
    return inp;
  }
  function numRow(label, value, set, o = {}) {
    return el('label', { style: 'display:inline-flex;align-items:center;gap:4px;margin:2px 10px 2px 0;white-space:nowrap' }, label, numInput(value, set, o));
  }
  function selectInput(value, options, set, style) {
    const s = el('select', { style: 'font-size:12px;max-width:260px;' + (style || '') });
    for (const [v, t] of options) { const o = el('option', { value: v }, t); if (v === value) o.selected = true; s.append(o); }
    s.addEventListener('change', () => set(s.value));
    return s;
  }
  function selectRow(label, value, options, set) {
    return el('label', { style: 'display:inline-flex;align-items:center;gap:4px;margin:2px 10px 2px 0' }, label, selectInput(value, options, set));
  }
  function checkInput(get, set, text) {
    const box = el('input', { type: 'checkbox' });
    box.checked = !!get();
    box.addEventListener('change', () => set(box.checked));
    return text ? el('label', { style: 'display:inline-flex;align-items:center;gap:4px;cursor:pointer' }, box, text) : box;
  }
  // Text that refreshes while a field is being edited.
  function dyn(fn, style) { const s = el('span', { style: style || 'color:#666' }, fn()); s.__text = fn; return s; }
  // Properties laid out as aligned label / value columns. Items: [label, ...value nodes], { wide: node }, GBR (end the row), null.
  const GBR = { br: true };
  let pgridMaxCols = 2;          // 1 when the side bar is narrow
  function pgrid(cols, ...items) {
    cols = Math.max(1, Math.min(cols, pgridMaxCols));
    const g = el('div', { style: 'display:grid;grid-template-columns:repeat(' + cols + ',max-content minmax(0,max-content));column-gap:6px;row-gap:3px;align-items:center;justify-content:start;margin:3px 0' });
    let col = 0;
    const pad = () => { while (col && col < cols) { g.append(el('div'), el('div')); col++; } col = 0; };
    for (const it of items) {
      if (it == null) continue;
      if (it === GBR) { pad(); continue; }
      // full-width rows wrap to the columns' width instead of widening them
      if (it.wide) { pad(); g.append(el('div', { style: 'grid-column:1/-1;width:0;min-width:100%;white-space:normal' }, it.wide)); continue; }
      const [k, ...v] = it;
      g.append(el('div', { style: 'color:#444;white-space:nowrap' + (col ? ';padding-left:10px' : '') }, k),
        el('div', { style: 'display:flex;align-items:center;gap:4px;white-space:nowrap;min-width:0' }, ...v.filter(x => x != null)));
      col = (col + 1) % cols;
    }
    return g;
  }

  // Number fields: drag a field sideways to change it, faster the further the pointer is from the field;
  // or move onto the ruler that appears under it to pick a tick (major ticks are sticky).
  function installScrub() {
    if (W.__aaScrubOn) return;
    W.__aaScrubOn = true;
    const PX = 8, RW = 380, RH = 40;
    document.addEventListener('pointerdown', (e) => {
      const inp = e.target;
      if (!(inp instanceof HTMLInputElement) || inp.type !== 'number' || inp.disabled || e.button !== 0) return;
      if (!inp.closest('.aa-editor')) return;
      const box = inp.getBoundingClientRect();
      if (e.clientX > box.right - 18) return;      // the spin arrows keep working
      const step = parseFloat(inp.step) > 0 ? parseFloat(inp.step) : 1;
      const dec = Math.max(0, Math.min(8, Math.ceil(-Math.log10(step) - 1e-9)));
      const lo = inp.min !== '' ? parseFloat(inp.min) : -Infinity, hi = inp.max !== '' ? parseFloat(inp.max) : Infinity;
      const fmtV = (v) => (+v.toFixed(dec)).toString();
      let on = false, val = parseFloat(inp.value), center, ptr = { x: e.clientX, y: e.clientY }, raf = 0, tPrev = 0, acc = 0, ruler = null, cv = null, rr = null, snapX = null;
      if (!isFinite(val)) val = isFinite(lo) ? lo : 0;
      center = val;
      const setVal = (v) => {
        v = Math.min(hi, Math.max(lo, +(+v).toFixed(dec)));
        if (v === val && inp.value !== '') return;
        val = v; inp.value = fmtV(v);
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const draw = () => {
        const dpr = window.devicePixelRatio || 1, g = cv.getContext('2d');
        if (cv.width !== RW * dpr || cv.height !== RH * dpr) { cv.width = RW * dpr; cv.height = RH * dpr; }
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, RW, RH);
        g.fillStyle = '#fff'; g.fillRect(0, 0, RW, RH);
        const cx = RW / 2, k0 = Math.ceil(center / step - cx / PX) - 1, k1 = Math.floor(center / step + cx / PX) + 1;
        g.font = '10px sans-serif'; g.textAlign = 'center'; g.fillStyle = '#444';
        for (let k = k0; k <= k1; k++) {
          const v = k * step, x = cx + (v / step - center / step) * PX;
          if (v < lo - 1e-9 || v > hi + 1e-9) continue;
          const major = k % 10 === 0, mid = k % 5 === 0, h = major ? 16 : mid ? 10 : 6;
          g.strokeStyle = major ? '#333' : '#999'; g.lineWidth = 1;
          g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, h); g.stroke();
          if (major) g.fillText(fmtV(v), x, 28);
        }
        const xv = cx + (val - center) / step * PX;
        g.strokeStyle = '#e03131'; g.lineWidth = 2; g.beginPath(); g.moveTo(xv, 0); g.lineTo(xv, RH); g.stroke();
        if (snapX != null) { g.fillStyle = 'rgba(31,111,235,.25)'; g.fillRect(snapX - 4, 0, 8, RH); }
        g.fillStyle = '#e03131'; g.font = 'bold 11px sans-serif'; g.textAlign = xv > RW - 40 ? 'right' : 'left';
        g.fillText(fmtV(val), xv + (xv > RW - 40 ? -4 : 4), RH - 3);
      };
      const overRuler = () => rr && ptr.y >= rr.top - 6 && ptr.y <= rr.bottom + 8 && ptr.x >= rr.left && ptr.x <= rr.right;
      const tick = (t) => {
        raf = requestAnimationFrame(tick);
        const dt = tPrev ? Math.min(0.1, (t - tPrev) / 1000) : 0; tPrev = t;
        if (overRuler()) {
          // snap to the tick under the pointer; major ticks are sticky
          const raw = center + (ptr.x - (rr.left + RW / 2)) / PX * step, major = Math.round(raw / (10 * step)) * 10 * step;
          const v = Math.abs(major - raw) / step * PX <= 6 ? major : Math.round(raw / step) * step;
          snapX = rr.left + RW / 2 + (v - center) / step * PX - rr.left;
          setVal(v); acc = 0;
        } else {
          snapX = null;
          const dx = ptr.x < box.left ? ptr.x - box.left : ptr.x > box.right ? ptr.x - box.right : 0;
          acc += Math.sign(dx) * step * 4 * Math.pow(Math.abs(dx) / 12, 1.7) * dt;
          const n = Math.trunc(acc / step);
          if (n) { acc -= n * step; setVal(val + n * step); }
          center = val;      // the ruler scrolls with the value
        }
        draw();
      };
      const start = () => {
        on = true;
        inp.focus({ preventScroll: true });
        ruler = el('div', { style: 'position:fixed;z-index:2147483647;pointer-events:none;border:1px solid #8c959f;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.25);overflow:hidden;background:#fff' });
        cv = el('canvas', { style: 'display:block;width:' + RW + 'px;height:' + RH + 'px' });
        ruler.append(cv);
        const left = Math.max(4, Math.min(window.innerWidth - RW - 4, box.left + box.width / 2 - RW / 2));
        const top = box.bottom + RH + 14 < window.innerHeight ? box.bottom + 6 : box.top - RH - 6;
        Object.assign(ruler.style, { left: left + 'px', top: top + 'px' });
        document.body.append(ruler);
        rr = { left, top, right: left + RW, bottom: top + RH };
        document.documentElement.style.cursor = 'ew-resize';
        raf = requestAnimationFrame(tick);
      };
      const move = (ev) => {
        ptr = { x: ev.clientX, y: ev.clientY };
        if (!on && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) > 4) start();
        if (on) { ev.preventDefault(); const s = window.getSelection && window.getSelection(); if (s) s.removeAllRanges(); }
      };
      const up = () => {
        window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true);
        if (!on) return;
        cancelAnimationFrame(raf); ruler.remove(); document.documentElement.style.cursor = '';
        inp.blur();
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      };
      window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', up, true);
    }, true);
  }
  installScrub();

  function settingsBlock() {
    const set = (k, v) => { if (k === 'flip') { setFlip(v); return; } state[k] = v; saveSettings(); recalc(); };
    // units: everything shown and typed follows them (files stay in millimetres)
    const setUnit = (k, v) => { state[k] = v; applyUnits(); saveSettings(); remountEditor(); };
    // grouped, two columns where there is room
    const group = (title, ...kids) => el('div', { style: 'min-width:0' },
      el('div', { style: 'font:700 10px/1.4 sans-serif;letter-spacing:.05em;text-transform:uppercase;color:#868e96;margin:2px 0 3px' }, title), ...kids);
    return el('div', { style: 'display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 18px;align-items:start' },
      group('Units and display',
        selectRow('Lengths', state.lenUnit, [['mm', 'metric (mm)'], ['in', 'imperial (in)']], v => setUnit('lenUnit', v)),
        selectRow('Angles', state.angUnit, [['deg', 'degrees (°)'], ['rad', 'radians']], v => setUnit('angUnit', v)),
        selectRow('Quality', state.quality, [['high', 'high'], ['low', 'low (no animations, less detail)']], v => setUnit('quality', v))),
      group('Heights',
        checkRow('Invert y axis', () => state.flip, v => set('flip', v)),
        el('div', null, selectRow('Heights', state.heightFrom, [['bottom', 'bottom up (0 at the lowest point)'], ['top', 'top down (0 at the top)']], v => { state.heightFrom = v; saveSettings(); renderAll(); }))),
      group('Editing',
        el('div', null, selectRow('Rotation', state.rotMode || 'absolute', [['absolute', 'absolute (the angle)'], ['relative', 'relative (the change)']], v => { state.rotMode = v; saveSettings(); renderAll(); })),
        el('div', null, selectRow('Move readout', state.offsetMode || 'polar', [['polar', 'distance, angle'], ['radial', 'radial (Δr Δθ Δh)'], ['xyz', 'orthogonal (Δx Δy Δz)']], v => { state.offsetMode = v; saveSettings(); renderAll(); }))),
      group('Views',
        checkRow('Linked slicers', () => !!state.linkSlicers, v => setLinkSlicers(v), 'The 2D height band and the 3D height slicer are one; the 2D cross-section is cut where the blue slicer is'),
        checkRow('Linked cross-section views', () => state.linkViews !== false, v => { state.linkViews = v; saveSettings(); renderAll(); }, 'Radius/height and overhead line up when switching; the height band is set in both'),
        numRow('Orbit snap with Ctrl (°)', state.orbitSnap, v => { state.orbitSnap = Math.max(0.5, Math.min(180, v)); saveSettings(); }, { step: '0.5', min: 0.5, max: 180, digits: 1, width: 56 }),
        checkRow('Auto-simplify', () => !!state.autoSimplify, v => { state.autoSimplify = v; saveSettings(); renderAll(); }, 'The cross-section is drawn monomorphic at 50% zoom or less (the Monomorphic button turns that off)')),
      group('Export',
        numRow('Circular precision (edges)', state.precision, v => set('precision', Math.max(8, Math.min(300, Math.round(v)))), { step: '1', min: 8, max: 300, digits: 0, width: 64 }),
        selectRow('Faces', state.faces, [['ngons', 'N-gons'], ['quads', 'Quads'], ['tris', 'Triangles']], v => set('faces', v)),
        selectRow('Format', state.format, [['stl', 'STL'], ['obj', 'OBJ'], ['step', 'STEP']], v => set('format', v))));
  }

  function statusText() {
    const r = state.result;
    if (state.scene && !state.scene.root.length) return { text: 'The scene is empty — add objects with the buttons below, or use New / open….', color: '#444', ready: false };
    if (!haveInput()) return { text: 'Start a project with New / open….', color: '#444', ready: false };
    if (state.busy || !r) return { text: 'Updating…', color: '#444', ready: false };
    if (r.error) return { text: 'Error: ' + r.error.split('\n')[0], color: '#b42318', ready: false };
    const rep = r.report;
    const k = UNIT_SCALE / MM, dg = UNIT_SCALE === MM ? 1 : 3, dims = (rep.size[0] * k).toFixed(dg) + ' × ' + (rep.size[1] * k).toFixed(dg) + ' ' + UNIT_LABEL;
    const fixes = [];
    if (rep.optimize && rep.weldedPoints) fixes.push(rep.weldedPoints.toLocaleString() + ' overlapping points welded');
    if (rep.optimize && rep.tjunctionsFixed) fixes.push(rep.tjunctionsFixed.toLocaleString() + ' T-junctions split');
    if (rep.optimize && rep.droppedTriangles) fixes.push(rep.droppedTriangles.toLocaleString() + ' degenerate triangles removed');
    const extra = '';      // welding / repair counts are not shown
    const faces = (rep.quads ? rep.faces.toLocaleString() + ' faces (' + rep.triangles.toLocaleString() + ' triangles)' : rep.triangles.toLocaleString() + ' triangles');
    const crossing = state.scene && leafOrder(state.scene).some(id => { const n = state.scene.nodes[id]; return polygonSelfIntersects(outlineOf(n.pts, n.runs)); });
    if (crossing) return { text: '✘ Not solid — an edited cross-section crosses itself (' + faces + ')', color: '#b45309', ready: true };
    if (rep.solid) return { text: '✔ Solid (watertight) — ' + faces + ', ' + dims + extra, color: '#1a7f37', ready: true };
    const issues = [];
    if (rep.openEdges) issues.push(rep.openEdges.toLocaleString() + ' open edges');
    if (rep.nonManifoldEdges) issues.push(rep.nonManifoldEdges.toLocaleString() + ' non-manifold edges');
    return { text: '✘ Not solid — ' + issues.join(', ') + ' (' + faces + '); the problem edges are shown in magenta in the 3D view', color: '#b45309', ready: true };
  }
  function downloadLabel(s) {
    return s.ready ? 'Download ' + (state.result.ext || 'stl').toUpperCase() + ' (' + partName() + ', ' + UNIT_LABEL + ')' : (haveInput() ? 'Updating…' : 'Download');
  }

  function renderAll() { if (editor) editor.render(); }
  // The scene was replaced whole (opened, imported, built): the views fit it afresh, and the list's folds, which go by
  // object id, start over.
  let sceneSwaps = 0;
  function sceneReplaced() { sceneSwaps++; if ((state.treeFolded || []).length) { state.treeFolded = []; saveSettings(); } }
  function setLinkSlicers(v) {
    if (!!state.linkSlicers === !!v) return;
    state.linkSlicers = !!v; saveSettings();
    if (editor && editor.slicersLinked) editor.slicersLinked();
    renderAll();
  }
  // turning the part over: the views turn with it, keeping the same part of it in the middle
  function setFlip(v) {
    if (!!state.flip === !!v) return;
    state.flip = !!v; saveSettings();
    if (editor && editor.flipped) editor.flipped();
    recalc();
  }

  // ---------------------------------------------------------------------------
  // 9. The editor fills the page.
  // ---------------------------------------------------------------------------
  let editor = null;
  function mountEditor(container) {
    if (editor) editor.destroy();
    editor = createEditor(container);
    window.dispatchEvent(new Event('resize'));
    renderAll();
  }
  // rebuild the editor in place (after a change of units): labels, boxes and fields all redrawn
  function remountEditor() {
    if (!editor) return;
    const host = editor.root.parentElement;
    if (host) mountEditor(host);
    recalc();
  }

  function createEditor(container) {
    const root = el('div', { class: 'aa-editor', style: 'position:absolute;inset:0;z-index:10;display:flex;flex-direction:column;background:#fff;color:#222;font:13px/1.35 sans-serif;text-align:left' });
    const bar = el('div', { style: 'padding:3px 8px;border-bottom:1px solid #ddd;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-right:36px' },
      el('b', { style: 'font-size:14px' }, 'Adapter Assembler'),
      el('button', { type: 'button', style: BTN2, onclick: () => showSplash(), title: 'Blank project, open a project file, or build an adapter between two threads' }, 'New / open…'),
      el('button', { type: 'button', style: BTN2, onclick: () => { if (state.scene && state.scene.root.length) saveScene(); }, title: 'Save everything in the scene to Saved models' }, 'Save scene'),
      el('button', { type: 'button', style: BTN2, onclick: () => { if (state.scene) { fit(); drawSection(); } resetCamera(); }, title: 'Frame the whole part in the cross-section and the 3D view' }, 'Frame all'),
      el('span', { style: 'margin-left:auto;color:#868e96;font-size:11px', title: 'Adapter Assembler version' }, 'v' + APP_VERSION));

    // left: cross-section
    const svg = sv('svg', { style: 'position:relative;width:100%;height:100%;display:block;touch-action:none;background:transparent;user-select:none;-webkit-user-select:none' });
    // the inside of the part seen through the middle, painted behind the cross-section
    const wrapCanvas = el('canvas', { style: 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none' });
    const left = el('div', { style: 'flex:0 0 ' + state.paneLeft + '%;position:relative;min-width:0;background:#fbfbfc' }, wrapCanvas, svg);
    const zoomTag = el('div', { style: 'font-size:11px;color:#495057;background:rgba(255,255,255,.9);padding:2px 6px;border-radius:3px;cursor:pointer;user-select:none', title: 'Zoom (100% = fitted). Click to fit.' });
    zoomTag.addEventListener('click', () => { fit(); drawSection(); });
    // the pane shows either the cross-section (radius / height) or the part from above
    const modeBtn = (m, ic, label, title) => { const b = hbtn(ic, label, () => setSecMode(m), { title }); b.__mode = m; return b; };
    const monoBtn = hbtn('mono', 'Monomorphic', () => {
      if (monoOn()) { state.mono = false; if (autoMono()) monoAutoOff = true; } else state.mono = true;
      saveSettings(); syncModeBtns(); drawSection();
    },
      { title: 'Draw everything not selected as one grey shape, without handles' });
    // the Measurement view: rulers only (the part monomorphic, its points to snap to), and its drawing to export
    const measureBtn = hbtn('ruler', 'Measure', () => setMeasure(!state.measure), { title: 'Measurement view: draw rulers on the part (drag; Ctrl snaps to points), right-click for more; export the drawing as PNG or PDF' });
    const perfectBtn = hbtn('circle', 'Perfect', () => { state.measurePerfect = !state.measurePerfect; saveSettings(); syncModeBtns(); drawSection(); recalc(); },
      { title: 'Perfect drawing: round bevels and cog roundings as true curves, whatever their edge count (straight-sided shapes stay as they are)' });
    const pinBtn = hbtn('pin', 'Pin', () => mPinSelected(), { title: 'Pin the selected measurement (or, with none selected, every unpinned one here) to this section angle, or from above to the heights shown' });
    for (const b of [perfectBtn, pinBtn]) { b.style.whiteSpace = 'nowrap'; b.style.flexShrink = '0'; }
    const measureBar = el('div', { style: 'display:none;gap:2px;white-space:nowrap' }, perfectBtn, pinBtn,
      hbtn('trash', 'Clear', () => { if (!Object.keys(measures().pts).some(k => measures().pts[k].v === mView())) return; pushUndo(); mClear(true); mSel = null; mChanged(); }, { title: 'Remove the measurements in this view' }),
      hbtn('download', 'PNG', () => exportDrawing('png'), { title: 'Export the drawing as a PNG picture' }),
      hbtn('download', 'PDF', () => exportDrawing('pdf'), { title: 'Export the drawing as a PDF' }));
    const modeBar = el('div', { style: 'display:inline-flex;gap:2px' },
      modeBtn('section', 'sideview', 'Radius/height', 'Cross-section: radius across, height up'),
      modeBtn('top', 'topview', 'Overhead', 'Seen from above: teeth of cogs, sides of n-sided objects, the section\'s angle'));
    // the selection's transforms open from a button beside the view buttons
    const selBtn = hbtn('transform', 'Selection', () => { state.selBoxCollapsed = !state.selBoxCollapsed; saveSettings(); renderSelBox(); },
      { title: 'Move, scale or rotate the selection' });
    selBtn.style.display = 'none';
    const viewBar = el('div', { style: 'position:absolute;right:30px;top:6px;display:flex;flex-wrap:wrap;justify-content:flex-end;max-width:calc(100% - 40px);gap:6px;align-items:center;z-index:4' }, selBtn, measureBar, measureBtn, monoBtn, modeBar, zoomTag);
    for (const b of measureBar.children) { b.style.whiteSpace = 'nowrap'; b.style.flexShrink = '0'; }
    const coord = el('div', { style: 'position:absolute;right:30px;top:32px;font-size:11px;color:#555;background:rgba(255,255,255,.9);padding:2px 6px;border-radius:3px;pointer-events:none' });
    const loading = el('div', { style: 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#666;background:#fbfbfc' }, 'Start a project with New / open…');
    const overlay = el('div', { style: 'position:absolute;inset:0;pointer-events:none;overflow:hidden' });
    // 1-D compass under the cross-section: the angle of the section around the axis (drag to turn)
    const compass1 = el('canvas', { style: 'position:absolute;left:50%;transform:translateX(-50%);bottom:' + (44 + 4) + 'px;width:600px;height:26px;cursor:ew-resize;touch-action:none;z-index:2;' +
      '-webkit-mask-image:linear-gradient(to right,transparent 0,#000 15%,#000 85%,transparent 100%);mask-image:linear-gradient(to right,transparent 0,#000 15%,#000 85%,transparent 100%)', title: 'Section angle: drag to turn the part (the 3D view turns with it)' });
    // the band of heights shown from above: a slider at the right of the pane. In the radius/height view it slices
    // nothing; it is there to set where the view from above will look down from. Flipped, the slider turns over too
    // (its top is what is shown on top).
    const TB_COL = '#12b886';
    const tbTrack = el('div', { style: 'position:absolute;left:50%;top:0;bottom:0;width:4px;margin-left:-2px;border-radius:2px;background:rgba(0,0,0,.12)' });
    const tbRange = el('div', { style: 'position:absolute;left:50%;width:4px;margin-left:-2px;border-radius:2px;background:' + TB_COL + ';cursor:grab' });
    const tbKnob = (which) => el('div', { style: 'position:absolute;left:50%;width:16px;height:10px;margin:-5px 0 0 -8px;border-radius:3px;background:' + TB_COL + ';border:1.5px solid #fff;box-sizing:border-box;cursor:ns-resize;box-shadow:0 1px 3px rgba(0,0,0,.35)',
      title: which === 'hi' ? 'Show only what lies below this height (double-click to clear)' : 'Show only what lies above this height (double-click to clear)' });
    const tbHi = tbKnob('hi'), tbLo = tbKnob('lo');
    const tbLab = () => el('div', { style: 'position:absolute;right:20px;margin-top:-7px;font-size:10px;color:#495057;white-space:nowrap;pointer-events:none;background:rgba(255,255,255,.85);padding:0 3px;border-radius:2px' });
    const tbHiL = tbLab(), tbLoL = tbLab();
    const topBox = el('div', { style: 'position:absolute;right:6px;top:64px;bottom:64px;width:20px;touch-action:none;z-index:6', title: 'Heights shown from above' }, tbTrack, tbRange, tbHiL, tbLoL, tbHi, tbLo);
    let tbDrag = null;
    function syncTopBox() {
      topBox.style.display = state.scene && (topMode() || LINK()) ? '' : 'none';
      topBox.title = topMode() ? 'Heights shown from above' : 'Heights the view from above will show (nothing is cut here)';
      const c = state.topCut || { lo: 0, hi: 1 }, lo = Math.max(0, Math.min(1, c.lo)), hi = Math.max(0, Math.min(1, c.hi)), top = (t) => (1 - tbF(t)) * 100 + '%';
      tbHi.style.top = top(hi); tbLo.style.top = top(lo); tbHiL.style.top = top(hi); tbLoL.style.top = top(lo);
      tbRange.style.top = (1 - Math.max(tbF(lo), tbF(hi))) * 100 + '%'; tbRange.style.height = (hi - lo) * 100 + '%';
      const r = sceneZRange(), at = (t) => r ? num(hDisp(r[0] + (r[1] - r[0]) * t, zBase()), 3) + ' ' + UNIT_LABEL : '';
      tbHiL.textContent = hi < 0.999 ? at(hi) : ''; tbLoL.textContent = lo > 0.001 ? at(lo) : '';
      // heights overhead measurements are pinned to: marks beside the slider (click one to show those heights)
      for (const m of [...topBox.querySelectorAll('[data-pincut]')]) m.remove();
      for (const pc of pinnedCuts()) {
        const m = el('div', { 'data-pincut': '1', style: 'position:absolute;left:-7px;width:5px;border-left:2px solid #1864ab;border-top:2px solid #1864ab;border-bottom:2px solid #1864ab;box-sizing:border-box;cursor:pointer;top:' + (1 - Math.max(tbF(pc[0]), tbF(pc[1]))) * 100 + '%;height:' + Math.max(0.6, Math.abs(pc[1] - pc[0]) * 100) + '%', title: 'Measurements pinned to the heights ' + at(pc[0]) + '–' + at(pc[1]) + ': click to show them' });
        m.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); setTopCut(pc[0], pc[1]); saveSettings(); });
        topBox.append(m);
      }
    }
    // a band end drawn to the end of a pinned band when it comes within a few pixels
    const tbMagnet = (t, which) => {
      const px = Math.max(1, topBox.getBoundingClientRect().height), reach = 6 / px;
      let best = t, bd = reach;
      for (const pc of pinnedCuts()) for (const v of which === 'lo' ? [pc[0]] : which === 'hi' ? [pc[1]] : pc) { const d = Math.abs(v - t); if (d < bd) { bd = d; best = v; } }
      return best;
    };
    const setTopCut = (lo, hi) => {
      lo = Math.max(0, Math.min(1, lo)); hi = Math.max(0, Math.min(1, hi));
      if (hi < lo + 0.005) { if (tbDrag && tbDrag.which === 'lo') lo = hi - 0.005; else hi = lo + 0.005; }
      state.topCut = { lo: Math.max(0, lo), hi: Math.min(1, hi) };
      if (state.linkSlicers) { cutsFromBand(); draw3d(); }
      drawSection();
    };
    const tbF = (t) => (state.flip ? 1 - t : t);     // height in the scene's range ↔ place up the slider
    // Ctrl: a height of the band goes to the nearest point's height, when one is within reach
    // a height (Ctrl): onto a point's height, a slicer's (the band's lines), another geometric object's top or bottom,
    // or else the grid (heights from the part's bottom)
    function snapHeight(z, self) {
      const reach = snapThr(), c = [];
      for (const id of leafOrder(state.scene)) {
        const n = state.scene.nodes[id];
        if (n.type === 'geo') { if (id !== self) c.push(n.params.z, n.params.z + n.params.h); continue; }
        for (const hd of handlesOf(id)) c.push(hd.z);
      }
      { const bz = bandZs(); if (bz) c.push(...bz); }
      let best = null;
      for (const v of c) { const d = Math.abs(v - z); if (d < reach && (best == null || d < Math.abs(best - z))) best = v; }
      if (best != null) return best;
      const st = gridStep() / 2, base = zBase(state.scene);
      return base + Math.round((z - base) / st) * st;
    }
    function snapBandZ(z, reach) {
      let best = null;
      for (const id of leafOrder(state.scene)) for (const hd of handlesOf(id)) { const dd = Math.abs(hd.z - z); if (dd < reach && (!best || dd < best.d)) best = { z: hd.z, d: dd }; }
      return best ? best.z : z;
    }
    const tbSnap = (e, t) => {
      const r = sceneZRange();
      if (!(e.ctrlKey || e.metaKey) || !r) return t;
      const px = Math.max(1, topBox.getBoundingClientRect().height);
      return (snapBandZ(r[0] + (r[1] - r[0]) * t, 8 / px * (r[1] - r[0])) - r[0]) / (r[1] - r[0]);
    };
    const tbAt = (e) => { const r = topBox.getBoundingClientRect(); return tbF(Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / Math.max(1, r.height)))); };
    for (const [k, which] of [[tbHi, 'hi'], [tbLo, 'lo'], [tbRange, 'both']]) {
      k.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation(); k.setPointerCapture(e.pointerId);
        const c = state.topCut || { lo: 0, hi: 1 };
        tbDrag = { which, t0: tbAt(e), lo: c.lo, hi: c.hi };
      });
      k.addEventListener('pointermove', (e) => {
        if (!tbDrag) return;
        const g0 = tbDrag, t0 = g0.which === 'both' ? tbAt(e) : tbSnap(e, tbAt(e)), t = e.ctrlKey || e.metaKey || g0.which === 'both' ? t0 : tbMagnet(t0, g0.which);
        if (g0.which === 'hi') setTopCut(g0.lo, t); else if (g0.which === 'lo') setTopCut(t, g0.hi);
        else {
          let dt = Math.max(-g0.lo, Math.min(1 - g0.hi, t - g0.t0));
          // (the whole band onto a pinned one when both ends come close)
          for (const pc of pinnedCuts()) if (Math.abs(pc[0] - (g0.lo + dt)) < 0.01 && Math.abs(pc[1] - (g0.hi + dt)) < 0.01) { setTopCut(pc[0], pc[1]); return; }
          setTopCut(g0.lo + dt, g0.hi + dt);
        }
      });
      const end = () => { if (tbDrag) { tbDrag = null; saveSettings(); } };
      k.addEventListener('pointerup', end); k.addEventListener('pointercancel', end);
      k.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const c = state.topCut || { lo: 0, hi: 1 };
        if (which === 'hi') setTopCut(c.lo, 1); else if (which === 'lo') setTopCut(0, c.hi); else setTopCut(0, 1);
        saveSettings();
      });
    }
    topBox.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target !== topBox && e.target !== tbTrack)) return;
      e.preventDefault(); e.stopPropagation();
      const t = tbAt(e), c = state.topCut || { lo: 0, hi: 1 };
      if (Math.abs(t - c.lo) < Math.abs(t - c.hi)) setTopCut(t, c.hi); else setTopCut(c.lo, t);
      saveSettings();
    });
    // how far a drag has moved what it moves, by the pointer (the project setting chooses how it is given)
    const offTag = el('div', { style: 'position:absolute;display:none;pointer-events:none;font-size:11px;line-height:1.35;color:#1f2328;background:rgba(255,249,219,.95);border:1px solid #ffc078;border-radius:3px;padding:1px 5px;white-space:nowrap;z-index:5' });
    // above the compass's ends: pinned measurements out of its range (click: turn to the nearest that way)
    const pinHint = (dir) => {
      const b = el('div', { style: 'position:absolute;bottom:' + (44 + 4 + 28) + 'px;font-size:10px;color:#1864ab;background:rgba(255,255,255,.92);border:1px solid #a5d8ff;border-radius:3px;padding:1px 5px;cursor:pointer;z-index:2;display:none;' + (dir < 0 ? '' : 'transform:translateX(-100%);'), title: 'Measurements pinned to section angles that way: click to turn to the nearest' });
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        let best = null;
        for (const a of pinnedAngles()) { const d = (((a - state.viewAngle) % 360) + 540) % 360 - 180; if (d * dir > 0.3 && (best == null || Math.abs(d) < Math.abs(best))) best = d; }
        if (best != null) setViewAngle(state.viewAngle + best);
      });
      return b;
    };
    const pinHintL = pinHint(-1), pinHintR = pinHint(1);
    left.append(overlay, viewBar, coord, loading, compass1, pinHintL, pinHintR, topBox, offTag);

    // right: 3D preview + side panel
    const canvas = el('canvas', { style: 'width:100%;height:100%;display:block;touch-action:none;cursor:grab;background:#1c1f24' });
    const busyTag = el('div', { style: 'position:absolute;right:30px;top:6px;font-size:11px;color:#ddd' });
    const cutModeSel = el('select', { style: 'font-size:11px;background:#2b3036;color:#ddd;border:1px solid #495057;border-radius:3px', title: 'Relative: the cut planes turn with the view (X across, Z toward you). Absolute: they stay fixed to the part.' },
      el('option', { value: 'relative' }, 'relative'), el('option', { value: 'absolute' }, 'absolute'));
    cutModeSel.value = state.cutMode === 'absolute' ? 'absolute' : 'relative';
    const cutReset = el('button', { type: 'button', style: 'font-size:11px;background:#2b3036;color:#ddd;border:1px solid #495057;border-radius:3px;cursor:pointer;padding:0 6px', title: 'Back to the default: half cut away toward you' }, 'reset cuts');
    const wireBox = el('input', { type: 'checkbox' }); wireBox.checked = !!state.wire;
    const ssaoBox = el('input', { type: 'checkbox' }); ssaoBox.checked = state.ssao !== false;
    const flipBox = el('input', { type: 'checkbox' }); flipBox.checked = !!state.flip;
    const orthoBox = el('input', { type: 'checkbox' }); orthoBox.checked = !!state.ortho;
    const cutHBox = el('input', { type: 'checkbox' }); cutHBox.checked = !!state.cutHandles;
    const linkSBox = el('input', { type: 'checkbox' }); linkSBox.checked = !!state.linkSlicers;
    linkSBox.addEventListener('change', () => setLinkSlicers(linkSBox.checked));
    const toggles3d = el('div', { style: 'position:absolute;left:8px;top:6px;font-size:11px;color:#ddd;display:flex;gap:10px;flex-wrap:wrap;right:90px' },
      el('label', { title: 'Cut planes: relative to the view or fixed to the part' }, 'cuts ', cutModeSel), cutReset,
      el('label', { style: 'cursor:pointer', title: 'Slicing handles on the model: two on each axis, the same cuts as the sliders' }, cutHBox, ' slicers on model'),
      el('label', { style: 'cursor:pointer', title: 'The height (green) slicer is the 2D height band, and the 2D cross-section is cut where the blue slicer is instead of through the axis' }, linkSBox, ' linked slicers'),
      el('label', { style: 'cursor:pointer' }, wireBox, ' wireframe'),
      el('label', { style: 'cursor:pointer', title: 'Ambient occlusion: darkens creases and corners' }, ssaoBox, ' SSAO'),
      el('label', { style: 'cursor:pointer', title: 'Orthographic view (no perspective): parallel lines stay parallel' }, orthoBox, ' orthographic'),
      el('label', { style: 'cursor:pointer', title: 'Invert the y axis: the part is turned over, in every view and in the exported file' }, flipBox, ' invert y axis'),
      (() => { const b = hbtn('fit', 'Fit', () => resetCamera(), { title: 'Frame the part in the 3D view' }); b.style.height = '18px'; return b; })());
    const hint3d = el('div', { style: 'position:absolute;left:8px;bottom:5px;font-size:10px;color:#9aa;pointer-events:none' }, 'drag: turn the part');
    const view3d = el('div', { style: 'flex:1;position:relative;min-height:0;min-width:0' }, canvas, busyTag, toggles3d, hint3d);
    // minimizing panes: a pane shrinks to a bar; click the bar to bring it back
    root.append(el('style', null, '.aa-min>:not(.aa-minbar){display:none!important}.aa-minbar{display:none}.aa-min>.aa-minbar{display:flex!important}'));
    // every text and number field alike: the same height, border and padding, with the up/down buttons inside the box
    root.append(el('style', null, '.aa-editor input[type=number],.aa-editor input[type=text]{box-sizing:border-box;height:21px;padding:1px 1px 1px 4px;margin:0;border:1px solid #c4cad0;border-radius:3px;background:#fff;color:#1f2328;font-family:sans-serif;font-size:12px;line-height:1.2;vertical-align:middle}' +
      '.aa-editor input[type=number]:focus,.aa-editor input[type=text]:focus{outline:1px solid #54aeff;outline-offset:0;border-color:#54aeff}' +
      '.aa-editor input[type=number]::-webkit-inner-spin-button{margin:0 0 0 2px;height:17px;align-self:center}'));
    const minBtn = (key) => {
      const b = el('button', { type: 'button', title: 'Minimize', style: 'position:absolute;top:4px;right:4px;z-index:6;width:20px;height:18px;padding:0;border:1px solid #adb5bd;border-radius:3px;background:rgba(255,255,255,.88);cursor:pointer;font:bold 12px/14px sans-serif;color:#333' }, '–');
      b.addEventListener('click', (e) => { e.stopPropagation(); state[key] = true; saveSettings(); applyLayout(true); });
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      return b;
    };
    const minBar = (key, title, vertical) => {
      const b = el('div', { class: 'aa-minbar', title: 'Restore ' + title.toLowerCase(), style: 'flex:1;height:100%;box-sizing:border-box;align-items:center;justify-content:center;gap:6px;cursor:pointer;background:#f1f3f5;color:#333;font:12px sans-serif;user-select:none;border:1px solid #dee2e6' + (vertical ? ';writing-mode:vertical-rl' : '') }, '▢ ' + title);
      b.addEventListener('click', () => { state[key] = false; saveSettings(); applyLayout(true); });
      return b;
    };
    left.append(minBtn('minLeft'), minBar('minLeft', 'Cross-section', true));
    view3d.append(minBtn('min3d'), minBar('min3d', '3D view', false));

    // ---- the side bar: Project, Objects, Properties, Saved models and Export, each its own view
    //      (fold any of them; drag the bars between them to share the height) ----
    const PANELS = [['project', 'Project', 0.8], ['objects', 'Objects', 1.1], ['props', 'Properties', 1.7]];
    const sp = (state.sidePanels && typeof state.sidePanels === 'object') ? state.sidePanels : (state.sidePanels = {});
    for (const [k, , w] of PANELS) if (!sp[k] || !(sp[k].size > 0)) sp[k] = { size: w, min: !!(sp[k] && sp[k].min) };
    const panels = {};
    const rightBar = el('div', { style: 'position:relative;display:flex;flex-direction:column;min-width:0;min-height:0;background:#fff' });
    const side = rightBar;
    PANELS.forEach(([k, title], i) => {
      const arrow = el('span', { style: 'display:inline-block;width:12px;color:#495057;transition:transform .2s' }, '▾');
      const extra = el('span', { style: 'flex:0 1 auto;font-weight:400;color:#666;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0' });
      const tools = el('div', { style: 'margin-left:auto;display:flex;align-items:center;gap:3px;flex:0 0 auto' });
      // only the arrow, the title and what follows it fold the section (up to the buttons), so a missed button does not
      const fold = el('div', { 'data-fold': '1', style: 'flex:1 1 auto;min-width:0;align-self:stretch;display:flex;align-items:center;gap:5px;cursor:pointer', title: 'Fold / unfold' },
        arrow, el('span', { style: 'flex:0 0 auto' }, title), extra);
      const head = el('div', { style: 'flex:0 0 auto;display:flex;align-items:center;gap:5px;height:24px;box-sizing:border-box;padding:0 ' + (i ? 4 : 28) + 'px 0 6px;background:#f1f3f5;border-bottom:1px solid #dee2e6;font:700 12px sans-serif;color:#343a40;user-select:none' }, fold, tools);
      const body = el('div', { style: 'flex:1 1 auto;overflow:auto;padding:4px 6px;min-height:0' });
      const wrap = el('div', { style: 'display:flex;flex-direction:column;min-height:0;overflow:hidden;border-bottom:1px solid #dee2e6' }, head, body);
      fold.addEventListener('click', () => { sp[k].min = !sp[k].min; saveSettings(); applyPanels(true); });
      panels[k] = { wrap, head, body, arrow, extra, tools };
      if (i) {
        // between two views: drag to give one more height than the other
        const s = el('div', { style: 'flex:0 0 4px;cursor:row-resize;background:#e9ecef;touch-action:none', title: 'Drag to resize' });
        s.addEventListener('pointerenter', () => { s.style.background = '#a5d8ff'; });
        s.addEventListener('pointerleave', () => { if (!s.__drag) s.style.background = '#e9ecef'; });
        s.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          const above = PANELS.slice(0, i).map(p => p[0]).reverse().find(x => !sp[x].min), below = PANELS.slice(i).map(p => p[0]).find(x => !sp[x].min);
          if (!above || !below) return;
          e.preventDefault(); s.setPointerCapture(e.pointerId); s.__drag = true;
          const A = panels[above].wrap, B = panels[below].wrap, hA = A.getBoundingClientRect().height, hB = B.getBoundingClientRect().height, wSum = sp[above].size + sp[below].size, y0 = e.clientY;
          A.style.transition = B.style.transition = 'none';
          const move = (ev) => {
            const d = Math.max(36 - hA, Math.min(hB - 36, ev.clientY - y0));
            sp[above].size = wSum * (hA + d) / (hA + hB); sp[below].size = wSum - sp[above].size; applyPanels(false);
          };
          const up = () => { s.__drag = false; s.style.background = '#e9ecef'; s.removeEventListener('pointermove', move); s.removeEventListener('pointerup', up); saveSettings(); };
          s.addEventListener('pointermove', move); s.addEventListener('pointerup', up);
        });
        panels[k].split = s;
        rightBar.append(s);
      }
      rightBar.append(wrap);
    });
    // saved models: a list that drops down under the Objects header
    const libPop = el('div', { style: 'position:absolute;left:4px;right:4px;top:0;z-index:7;display:none;max-height:60%;overflow:auto;background:#fff;border:1px solid #ced4da;border-radius:5px;box-shadow:0 4px 12px rgba(0,0,0,.15);padding:4px 6px;font-size:12px' });
    let libOpen = false, libBtn = null;
    const toggleLib = (v) => { libOpen = v == null ? !libOpen : v; renderSide(); };
    document.addEventListener('pointerdown', (e) => { if (libOpen && !libPop.contains(e.target) && !(libBtn && libBtn.contains(e.target))) toggleLib(false); }, true);
    rightBar.append(libPop);
    rightBar.append(minBtn('minSide'), minBar('minSide', 'Side bar', false));
    rightBar.append(el('style', null, '.aa-icononly .aa-hl{display:none}.aa-hov{box-shadow:inset 3px 0 0 #868e96;background-color:#f1f3f5}'));
    // header labels hide (icons stay) when a header has no room for them
    function fitHead(h, keep) {
      h.classList.remove('aa-icononly');
      // (the folding part fills the space up to the buttons: what it needs is what it holds)
      const kids = [...h.children].filter(c => c.tagName !== 'STYLE').flatMap(c => c.dataset && c.dataset.fold ? [...c.children] : [c]);
      const need = kids.reduce((s, c) => s + (c === keep ? Math.min(c.scrollWidth, 70) : c.scrollWidth), 0) + 5 * kids.length;
      const cs = getComputedStyle(h), room = h.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      if (need > room) h.classList.add('aa-icononly');
    }
    function fitHeads() { for (const k in panels) fitHead(panels[k].head, panels[k].extra); }
    function applyPanels(animate) {
      const ms = animate && !reduceMotion() ? 220 : 0;
      PANELS.forEach(([k], i) => {
        const p = panels[k], s = sp[k];
        p.wrap.style.transition = ms ? 'flex-grow ' + ms + 'ms cubic-bezier(.2,.8,.2,1), flex-basis ' + ms + 'ms cubic-bezier(.2,.8,.2,1)' : 'none';
        p.wrap.style.flex = s.min ? '0 0 24px' : s.size + ' 1 0px';
        p.body.style.display = s.min ? 'none' : '';
        p.arrow.style.transform = s.min ? 'rotate(-90deg)' : 'none';
        if (p.split) {
          const above = PANELS.slice(0, i).some(q => !sp[q[0]].min), below = PANELS.slice(i).some(q => !sp[q[0]].min);
          p.split.style.visibility = above && below ? 'visible' : 'hidden';
        }
      });
    }
    applyPanels(false);

    // resizable panes (sizes remembered in this browser): cross-section | 3D view over the side bar
    const splitter = (which) => {
      const vertical = which === 'left';
      const s = el('div', { style: (vertical ? 'flex:0 0 6px;cursor:col-resize;border-width:0 1px;' : 'flex:0 0 6px;cursor:row-resize;border-width:1px 0;') + 'background:#e9ecef;border-style:solid;border-color:#d0d7de;touch-action:none', title: 'Drag to resize' });
      s.addEventListener('pointerenter', () => { s.style.background = '#a5d8ff'; });
      s.addEventListener('pointerleave', () => { if (!s.__drag) s.style.background = '#e9ecef'; });
      s.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault(); s.setPointerCapture(e.pointerId); s.__drag = true;
        left.style.transition = rightBar.style.transition = view3d.style.transition = 'none';
        const box = (vertical ? s.parentElement : right).getBoundingClientRect();
        const move = (ev) => {
          if (vertical) { state.paneLeft = Math.max(10, Math.min(85, (ev.clientX - box.left) / box.width * 100)); left.style.flex = '0 0 ' + state.paneLeft + '%'; }
          else { state.paneSide = Math.max(10, Math.min(90, (box.bottom - ev.clientY) / box.height * 100)); rightBar.style.flex = '0 0 ' + state.paneSide + '%'; }
        };
        const up = () => { s.__drag = false; s.style.background = '#e9ecef'; s.removeEventListener('pointermove', move); s.removeEventListener('pointerup', up); saveSettings(); };
        s.addEventListener('pointermove', move); s.addEventListener('pointerup', up);
      });
      s.addEventListener('dblclick', () => {
        if (vertical) { state.paneLeft = 50; left.style.flex = '0 0 50%'; } else { state.paneSide = 55; rightBar.style.flex = '0 0 55%'; }
        saveSettings();
      });
      return s;
    };
    const right = el('div', { style: 'flex:1 1 0;display:flex;flex-direction:column;min-width:0;min-height:0' });
    const splitV = splitter('left'), splitH = splitter('side');
    right.append(view3d, splitH, rightBar);
    root.append(bar, el('div', { style: 'flex:1;display:flex;min-height:0' }, left, splitV, right));
    // Pane sizes are explicit flex-basis values so that minimizing and restoring can slide.
    function applyLayout(animate) {
      const ms = animate && !reduceMotion() ? 240 : 0, ease = 'cubic-bezier(.2,.8,.2,1)';
      for (const e of [left, rightBar, view3d]) e.style.transition = ms ? 'flex-basis ' + ms + 'ms ' + ease + ', flex-grow ' + ms + 'ms ' + ease : 'none';
      left.classList.toggle('aa-min', !!state.minLeft); view3d.classList.toggle('aa-min', !!state.min3d); rightBar.classList.toggle('aa-min', !!state.minSide);
      const rightMin = state.min3d && state.minSide;
      left.style.flex = '0 0 ' + (state.minLeft ? '26px' : rightMin ? 'calc(100% - 172px)' : state.paneLeft + '%');
      view3d.style.flex = rightMin ? '0 0 26px' : '1 1 0';
      rightBar.style.flex = '0 0 ' + (state.minSide ? '26px' : state.min3d ? 'calc(100% - 26px)' : state.paneSide + '%');
      splitV.style.display = state.minLeft || rightMin ? 'none' : '';
      splitH.style.display = state.min3d || state.minSide ? 'none' : '';
      for (const [pane, on] of [[left, state.minLeft], [view3d, state.min3d], [rightBar, state.minSide]]) {
        if (!ms || pane.__wasMin === on) { pane.__wasMin = on; continue; }
        pane.__wasMin = on;
        if (pane.animate) pane.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: ms, easing: ease });
      }
      if (ms) setTimeout(() => { if (root.isConnected) { drawSection(); draw3d(); } }, ms + 20);
    }
    applyLayout();

    // ---- start screen: blank project, open a project, adapter assembler ----
    const splash = el('div', { style: 'position:absolute;inset:0;z-index:40;display:none;overflow:auto;background:rgba(241,243,245,.97);padding:24px;box-sizing:border-box' });
    root.append(splash);
    function hideSplash() { splash.style.display = 'none'; W.__aaOnProjectLoaded = null; }
    function openScene(sc, msg) {
      if (state.scene) pushUndo();
      state.scene = sc; state.sel = new Set(); state.selNodes = new Set(); state.edited = true; state.libMessage = msg || null;
      sceneReplaced(); hideSplash(); markEdited(); recalc();
    }
    function threadPicker(title, init) {
      // gender, standard (or custom diameter and pitch), thread length
      const g = selectInput(init.male ? 'male' : 'female', [['male', 'male (external)'], ['female', 'female (internal)']], () => {});
      const std = el('select', { style: 'font-size:12px;max-width:260px' }, el('option', { value: '' }, 'custom'),
        ...THREAD_GROUPS.map(([gr, list]) => el('optgroup', { label: gr }, ...list.map(([k, label]) => el('option', { value: k }, label)))));
      const k = MM / UNIT_SCALE, show = (mmv) => String(+(mmv / k).toFixed(UNIT_SCALE === MM ? 4 : 5));   // mm per shown unit
      const dIn = el('input', { 'data-unit': 'len', type: 'number', step: UNIT_SCALE === MM ? '0.1' : '0.005', min: '0', value: show(init.d), style: 'width:80px' });
      const pIn = el('input', { 'data-unit': 'len', type: 'number', step: UNIT_SCALE === MM ? '0.05' : '0.001', min: '0', value: show(init.pitch), style: 'width:80px' });
      const lIn = el('input', { 'data-unit': 'len', type: 'number', step: '0.5', min: '0', placeholder: 'auto', style: 'width:80px' });
      const pr0 = THREAD_PRESETS.find(p => Math.abs(p[2] - init.d) < 1e-6 && Math.abs(p[3] - init.pitch) < 1e-6); std.value = pr0 ? pr0[0] : '';
      std.addEventListener('change', () => { const p = THREAD_PRESETS.find(x => x[0] === std.value); if (p) { dIn.value = show(p[2]); pIn.value = show(p[3]); } });
      const custom = () => { std.value = THREAD_PRESETS.find(p => Math.abs(p[2] - +dIn.value * k) < 1e-3 && Math.abs(p[3] - +pIn.value * k) < 1e-4) ? THREAD_PRESETS.find(p => Math.abs(p[2] - +dIn.value * k) < 1e-3 && Math.abs(p[3] - +pIn.value * k) < 1e-4)[0] : ''; };
      dIn.addEventListener('input', custom); pIn.addEventListener('input', custom);
      return { el: el('div', null, el('div', { style: 'font-weight:700;margin:4px 0' }, title),
          pgrid(1, ['Gender', g], ['Standard', std], ['Major Ø (' + UNIT_LABEL + ')', dIn], ['Pitch (' + UNIT_LABEL + ')', pIn], ['Thread length (' + UNIT_LABEL + ')', lIn])),
        get: () => ({ male: g.value === 'male', d: +dIn.value * k, pitch: +pIn.value * k, len: (+lIn.value || 0) * k }) };
    }
    function showSplash() {
      splash.textContent = '';
      const card = (title, ...kids) => el('div', { style: 'background:#fff;border:1px solid #dee2e6;border-radius:6px;padding:10px 12px;box-shadow:0 1px 4px rgba(0,0,0,.08);min-width:240px;flex:1 1 260px;max-width:640px' },
        el('div', { style: 'font-weight:700;font-size:15px;margin-bottom:4px' }, title), ...kids);
      const lib = libLoad();
      // adapter assembler
      const A = threadPicker('Thread A (bottom)', { male: true, d: 48, pitch: 0.75 }), B = threadPicker('Thread B (top)', { male: false, d: 42, pitch: 0.75 });
      const km = MM / UNIT_SCALE, sh = (mmv) => String(+(mmv / km).toFixed(UNIT_SCALE === MM ? 3 : 4)), im = UNIT_SCALE === MM;
      const lenIn = el('input', { 'data-unit': 'len', type: 'number', step: im ? '0.5' : '0.02', min: '0', value: sh(20), style: 'width:80px' });
      const wallIn = el('input', { 'data-unit': 'len', type: 'number', step: im ? '0.1' : '0.005', min: '0', value: sh(2.5), style: 'width:80px' });
      const clrIn = el('input', { 'data-unit': 'len', type: 'number', step: im ? '0.05' : '0.002', value: '0', style: 'width:80px' });
      const steepBox = el('input', { type: 'checkbox' }); steepBox.checked = true;
      const angIn = el('input', { 'data-unit': 'ang', type: 'number', step: ANG_SCALE === 1 ? '5' : '0.05', min: String(+(20 * ANG_SCALE).toFixed(3)), max: String(+(85 * ANG_SCALE).toFixed(3)), value: String(+(60 * ANG_SCALE).toFixed(4)), style: 'width:60px' });
      const out = el('div', { style: 'color:#9a6700;margin-top:6px' });
      const build = () => {
        const a = A.get(), b = B.get(), H = +lenIn.value * km;
        if (!(a.d > 0 && a.pitch > 0 && b.d > 0 && b.pitch > 0 && H > 0)) { out.textContent = 'Enter a diameter and pitch for both threads, and a total length.'; return; }
        const r = buildAdapter({ a, b, length: H, wall: (+wallIn.value * km) || 2.5, clearance: (+clrIn.value * km) || 0, steep: steepBox.checked, angle: (+angIn.value / ANG_SCALE) || 60 });
        openScene(r.scene, r.notes.length ? 'Adapter: ' + r.notes.join(' ') : 'Adapter created: thread A at the bottom, thread B at the top. Every part is editable.');
      };
      splash.append(
        el('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:14px' },
          el('div', { style: 'font-size:20px;font-weight:700' }, 'Adapter Assembler'),
          state.scene ? el('button', { type: 'button', style: BTN2, onclick: hideSplash }, 'Back to the current project') : null),
        el('div', { style: 'display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start' },
          (() => {
            const last = lastScene(null);
            return last ? card('Last scene', el('div', { style: 'color:#666;margin-bottom:8px' }, (last.name || 'Scene') + ', ' + new Date(last.date).toLocaleString() + ' — remembered in this browser.'),
              el('button', { type: 'button', style: BTN, onclick: () => { if (isFinite(last.angle)) state.viewAngle = last.angle; openScene(clone(last.scene)); } }, 'Continue')) : null;
          })(),
          card('Blank project',
            el('button', { type: 'button', style: BTN, onclick: () => openScene({ nodes: {}, root: [], seq: 1 }) }, 'Start blank')),
          card('Open a project',
            el('button', { type: 'button', style: BTN, onclick: () => { W.__aaOnProjectLoaded = hideSplash; pickJsonFile(); } }, 'Open JSON file…'),
            lib.length ? el('div', { style: 'margin-top:10px' }, el('div', { style: 'font-weight:700;margin-bottom:4px' }, 'My saved models'),
              ...lib.map(entry => el('div', { style: 'display:flex;gap:6px;align-items:center;margin:2px 0' },
                el('button', { type: 'button', style: BTN2, onclick: () => {
                  const sc = { nodes: {}, root: [], seq: 1 }, sub = remapSubtree(entry.model, (n) => n.type.charAt(0) + (++sc.seq));
                  Object.assign(sc.nodes, sub.nodes); sc.root.push(sub.rootId); openScene(sc, 'Opened "' + entry.name + '".');
                } }, 'Open'), el('span', null, entry.name)))) : null),
          card('Adapter assembler',
            el('div', { style: 'display:flex;gap:18px;flex-wrap:wrap' }, A.el, B.el),
            pgrid(2, ['Total length (' + UNIT_LABEL + ')', lenIn], ['Wall (' + UNIT_LABEL + ')', wallIn], ['Fit clearance (' + UNIT_LABEL + ')', clrIn], GBR,
              ['Avoid right angles', el('label', { style: 'display:inline-flex;gap:4px;align-items:center' }, steepBox, 'steep walls, at least'), angIn, ANG_LABEL.trim() + ' from horizontal']),
            el('button', { type: 'button', style: BTN + ';margin-top:6px', onclick: build }, 'Create adapter'), out)));
      splash.style.display = 'block';
    }
    const menu = el('div', { style: 'position:fixed;z-index:2147483647;display:none;transform-origin:top left;background:#fff;border:1px solid #bbb;border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,.25);padding:6px;font:12px/1.4 sans-serif;color:#222;min-width:230px;max-width:320px' });
    root.append(menu);
    container.append(root);

    let view = null, drag = null, hoverEdge = null, hoverNode = null, previewMarks = [];

    // ---- keyboard ----
    const onKey = (e) => {
      if (!root.isConnected) return;
      const ae = document.activeElement || {}, typing = /SELECT|TEXTAREA/.test(ae.tagName || '') || (ae.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|range|color)$/.test(ae.type));
      if (typing) {
        if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) ae.__all = true;
        else if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key) && !(e.key.length === 1 && !plainKey(e.key) && ae.type === 'number')) ae.__all = false;
        unitKey(e, ae);
        if (ae.__unitText && e.key === 'Enter') { unitCommit(ae); ae.dispatchEvent(new Event('change', { bubbles: true })); }
        if (ae.__onKey) ae.__onKey(e);
        e.stopPropagation(); return;
      }
      if (e.key === 'Escape') {
        if (splash.style.display !== 'none' && state.scene) { hideSplash(); e.stopPropagation(); e.preventDefault(); return; }
        if (menu.style.display !== 'none') { hideMenu(); e.stopPropagation(); e.preventDefault(); return; }
        if (state.measure && (mConnect || mSel)) { mConnect = null; mSel = null; drawSection(); e.stopPropagation(); e.preventDefault(); return; }
        if (state.sel.size || state.selNodes.size) { state.sel = new Set(); state.selNodes = new Set(); renderAll(); e.stopPropagation(); e.preventDefault(); }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { redo(); e.preventDefault(); e.stopPropagation(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { undo(); e.preventDefault(); e.stopPropagation(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && state.selNodes.size) { duplicateNodes(topSelected(state.scene)); e.preventDefault(); e.stopPropagation(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && state.measure) {
        if (mSel) { pushUndo(); mDelete(mSel); mSel = null; mChanged(); }
        e.preventDefault(); e.stopPropagation(); return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (state.sel.size) { pushUndo(); deletePoints([...state.sel]); state.sel = new Set(); markEdited(); recalc(); }
        else if (state.selNodes.size) deleteNodes(topSelected(state.scene));
        e.preventDefault(); e.stopPropagation(); return;
      }
      const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
      if (arrows[e.key] && (state.sel.size || state.selNodes.size)) {
        const step = (e.shiftKey ? 1 : 0.1) * (UNIT_SCALE === MM ? 1 : 0.1) / UNIT_SCALE, ay = arrows[e.key][0], az = arrows[e.key][1] * FZ();   // up the screen
        pushUndo();
        if (state.sel.size) moveKeysView(state.scene, [...state.sel], ay * step, az * step);
        else for (const id of leavesUnder(state.scene, topSelected(state.scene))) moveNodeView(state.scene, id, ay * step, az * step);
        markEdited(); recalc({ fast: true }); e.preventDefault(); e.stopPropagation();
      }
    };
    const onKeyUp = (e) => { if (root.isConnected && /^Arrow/.test(e.key) && state.busy) recalc(); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp, true);

    // ---- geometry helpers for the view ----
    // the pane's own size (not the drawn one, which shrinks while the view tips over in a transition)
    // Read once per drawing (and when the pane is resized), not per point: asking the page for it after the drawing has
    // changed makes it lay everything out again, and the view's transforms ask for it thousands of times.
    const SZ = { w: 800, h: 600 };
    const measure = () => { SZ.w = left.clientWidth || 800; SZ.h = left.clientHeight || 600; };
    const size = () => SZ;
    // The 3D view looks square at the cross-section's plane: its turn for a section angle, and back. The model is
    // turned over about its own x axis when the y axis is inverted, which mirrors its angles, so the turn mirrors too
    // (the same section then faces the viewer either way).
    function yawOf(deg) { return (state.flip ? -deg - 90 : deg - 90) * Math.PI / 180; }
    // Ctrl while orbiting: the step, in degrees (project settings)
    const orbitStep = () => { const v = +state.orbitSnap; return isFinite(v) && v >= 0.5 ? Math.min(180, v) : 15; };
    function degOf(yw) { const a = yw * 180 / Math.PI; return state.flip ? -a - 90 : a + 90; }
    function fit() {
      if (topMode()) { fitTop(); return; }
      let y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const id of leafOrder(state.scene)) {
        const n = state.scene.nodes[id];
        const f = n.type === 'ngon' && n.params.about !== 'edges' ? 1 / Math.cos(Math.PI / Math.max(3, n.params.sides)) : 1;
        for (const p of viewOutline(state.scene, id)) { y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y * f); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
      }
      if (!isFinite(y0)) { y0 = 0; y1 = 1; z0 = 0; z1 = 1; }
      // keep the copies' axis of radial cloners in view
      for (const k of Object.values(state.scene.nodes)) if (k.type === 'cloner' && findParent(state.scene, k.id) && leavesUnder(state.scene, [k.id]).size) {
        const p = xfOf(state.scene, k.id).fwd({ y: k.params.radius || 0, z: k.params.height || z0 });
        y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
      }
      const { w, h } = size();
      const R = Math.max(Math.abs(y0), Math.abs(y1), 1e-6);    // both sides of the axis
      view = { cy: 0, cz: FZ() * (z0 + z1) / 2, s: Math.min(w / (2 * R * 1.15), h / ((z1 - z0) * 1.2 || 1)) };
      fitScale = view.s; view.fit = view.s; fitScales[topMode() ? 'top' : 'section'] = view.s;
    }
    // The cross-section shows both sides of the axis: the section at the view angle on the right, and the one
    // opposite it (view angle + 180°) mirrored on the left, which works just the same. MS is the side being drawn
    // or worked on (1 right, -1 left); radii stay positive on both sides.
    let MS = 1, dragSide = 1, fitScale = 0;
    // From above the part is turned so the section's direction points right, as the radius does from the side: the two
    // views line up, scale for scale (rotOff: the grid's strips work in that turned frame directly).
    let rotOff = false;
    const topTurn = () => (topMode() && !rotOff ? state.viewAngle * Math.PI / 180 : 0);
    // flipped upside down (a half turn about the radius axis): heights run down the screen; from above, the part is seen
    // from what was its underside, so the second axis reverses too. The view's own frame (view.cy / cz) is the shown one.
    const FZ = () => (state.flip ? -1 : 1);
    const toScreen = (y, z) => {
      const { w, h } = size(), t = topTurn();
      if (t) { const c = Math.cos(t), s = Math.sin(t), a = y * c + z * s; z = -y * s + z * c; y = a; }
      if (!rotOff) z *= FZ();
      return [w / 2 + (MS * y - view.cy) * view.s, h / 2 - (z - view.cz) * view.s];
    };
    const toWorld = (sx, sy) => {
      const { w, h } = size(), t = topTurn(), y = view.cy + (sx - w / 2) / view.s;
      let z = view.cz - (sy - h / 2) / view.s;
      if (!rotOff) z *= FZ();
      if (!t) return [y, z];
      const c = Math.cos(t), s = Math.sin(t);
      return [y * c - z * s, y * s + z * c];
    };
    const local = (e) => { const r = svg.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const pathOf = (poly) => poly.map((p, i) => (i ? 'L' : 'M') + toScreen(p.y, p.z).map(v => v.toFixed(1)).join(' ')).join(' ') + 'Z';

    function handlesOf(id, sc = state.scene) {
      const n = sc.nodes[id], out = [], xf = xfOf(sc, id);
      n.pts.forEach((p, i) => { if (!inRunIndex(n, i)) { const q = xf.fwd(p); out.push({ key: id + '|p|' + i, y: q.y, z: q.z, run: false, bevel: !!(p.bevel && (p.bevel.r > 0 || p.bevel.trim > 0)) }); } });
      (n.runs || []).forEach((r, ri) => {
        // helical teeth move along the axis as the view turns: their handles follow the section at the view angle
        const s = xf.id ? runShift(r) : 0, zMin = Math.min(r.zFirst, r.zLast), zMax = Math.max(r.zFirst, r.zLast);
        const ro = runoutOf(n, r), vs = runVertices(r);
        vs.forEach((v, k) => {
          let p = v;
          if (s && v.role === 'mid') { p = { y: v.y, z: v.z + s }; if (!(p.z - zMin > 1e-7 && zMax - p.z > 1e-7)) return; }
          // near a lead-in the teeth run out: the handles sit on the retracted tooth
          if (ro) {
            // the same offset for the whole tooth: the one at its crest's centre
            const isRoot = (w) => w && Math.abs(w.y - ro.root) < 1e-9;
            const crestCentre = (j) => { const w = vs[j], o = [vs[j - 1], vs[j + 1]].find(x => x && x.role === 'mid' && Math.abs(x.y - w.y) < 1e-9); return o ? (w.z + o.z) / 2 : w.z; };
            if (v.role !== 'mid') { const bb = { ...r, runout: ro }, pt = runoutPattern(bb); p = { y: runoutRadiusAt(bb, pt, p.z, runShift(r)), z: p.z }; }
            else if (!isRoot(v)) p = { y: runoutCorner(ro, { r: v.y, kind: 'crest', c: crestCentre(k) - v.z }, p.z).r, z: p.z };
            else {
              const j = !isRoot(vs[k + 1]) && vs[k + 1] && vs[k + 1].role === 'mid' ? k + 1 : !isRoot(vs[k - 1]) && vs[k - 1] && vs[k - 1].role === 'mid' ? k - 1 : -1;
              if (j >= 0) { const c = runoutCorner(ro, { r: v.y, kind: 'root', dir: Math.sign(vs[j].z - v.z) || 1, c: crestCentre(j) - v.z }, p.z); p = { y: c.r, z: c.z }; }
            }
          }
          const q = xf.fwd(p); out.push({ key: id + '|r|' + ri + '|' + k, y: q.y, z: q.z, run: true });
        });
      });
      return out;
    }
    // how far the teeth of a helical run sit from their drawn place in the section at the view angle (within ± half a pitch)
    function runShift(r) {
      if (!state.helical || !r.hand || !(r.pitch > 0)) return 0;
      const P = r.pitch, s = r.hand * P * viewTheta() / (2 * Math.PI);
      return s - P * Math.round(s / P);
    }
    function edgesOf(id, sc = state.scene) {
      const n = sc.nodes[id], out = [], np = n.pts.length, xf = xfOf(sc, id);
      for (let i = 0; i < np; i++) if (edgeOk(n, i)) out.push({ key: id + '|e|' + i, a: xf.fwd(n.pts[i]), b: xf.fwd(n.pts[(i + 1) % np]), i });
      return out;
    }
    function segDistPx(sx, sy, a, b) {
      const [ax, ay] = toScreen(a.y, a.z), [bx, by] = toScreen(b.y, b.z);
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((sx - ax) * dx + (sy - ay) * dy) / L2)) : 0;
      return { d: Math.hypot(ax + dx * t - sx, ay + dy * t - sy), t };
    }
    function edgeAt(sx, sy) {
      // edges of selected objects win over others nearby
      let best = null;
      const order = frontOrder(), front = new Set(order.filter(id => selectedAncestorOf(id) || [...state.sel].some(k => parseKey(k).node === id)));
      for (const id of order) if (canPick(id)) for (const e of edgesOf(id)) {
        const r = segDistPx(sx, sy, e.a, e.b), score = r.d - (front.has(id) ? 4 : 0);
        if (r.d < 6 && r.t > 0.05 && r.t < 0.95 && (!best || score < best.score)) best = { key: e.key, score };
      }
      return best && best.key;
    }
    // Points connected to a handle (its neighbours along the outline), for tangent directions.
    function neighboursOf(sc, key) {
      const h = parseKey(key), n = sc.nodes[h.node], out = [];
      if (!n) return out;
      const np = n.pts.length, xf = xfOf(sc, h.node);
      const ptAt = (i) => {
        i = (i + np) % np;
        const r = (n.runs || []).find(r => i >= r.start && i <= r.end);
        if (!r) return n.pts[i];
        const v = runVertices(r);
        return i === r.start ? v[0] : v[v.length - 1];
      };
      if (h.kind === 'p') out.push(ptAt(h.i - 1), ptAt(h.i + 1));
      else {
        const r = n.runs[h.ri], v = runVertices(r);
        out.push(h.k > 0 ? v[h.k - 1] : ptAt(r.start - 1));
        out.push(h.k < v.length - 1 ? v[h.k + 1] : ptAt(r.end + 1));
      }
      return out.map(p => p && xf.fwd(p));
    }
    function unitDirs(P, nbrs) {
      const out = [];
      for (const q of nbrs) {
        if (!q) continue;
        const dy = q.y - P.y, dz = q.z - P.z, l = Math.hypot(dy, dz);
        if (l > 1e-9) out.push([dy / l, dz / l]);
      }
      return out;
    }
    // Snap data for a drag: the grabbed (primary) point, its tangent directions, every point
    // that is not moving (with its edge directions), and the midpoints of edges that are not moving.
    function prepareSnap(sc, primaryKey, movingKey) {
      const all = [];
      for (const id of leafOrder(sc)) for (const hd of handlesOf(id, sc)) all.push(hd);
      const prim = all.find(hd => hd.key === primaryKey);
      const targets = all.filter(hd => !movingKey(hd.key)).map(hd => ({ y: hd.y, z: hd.z, dirs: unitDirs(hd, neighboursOf(sc, hd.key)) }));
      for (const id of leafOrder(sc)) {
        const n = sc.nodes[id];
        for (const e of edgesOf(id, sc)) {
          if (movingKey(id + '|p|' + e.i) || movingKey(id + '|p|' + ((e.i + 1) % n.pts.length))) continue;
          const m = { y: (e.a.y + e.b.y) / 2, z: (e.a.z + e.b.z) / 2 };
          targets.push({ y: m.y, z: m.z, dirs: unitDirs(m, [e.a]), mid: true });
        }
      }
      // the axis (and the part's bottom), and other geometric objects' sections' corners
      targets.push({ y: 0, z: zBase(sc), dirs: [] });
      for (const id of leafOrder(sc)) {
        if (sc.nodes[id].type !== 'geo' || sc.nodes[id].shape.some((_, i) => movingKey(id + '|q|' + i) || movingKey(id + '|qe|' + i))) continue;
        const gw = geoWorld(sc, id); if (!gw) continue;
        for (const L of sliceLoops(gw.V, gw.T, state.viewAngle * Math.PI / 180)) for (const q of L) targets.push({ y: Math.abs(q[0]), z: q[1], dirs: [] });
      }
      // geometric objects' corners as seen here (at their tops and bottoms), its own among them: all but what is being
      // moved (a corner's other end still counts), to line up with, level or upright (on the side being worked on)
      for (const id of leafOrder(sc)) {
        if (sc.nodes[id].type !== 'geo' || !state.scene.nodes[id] || nodeFlag(sc, id, 'hide2d')) continue;
        for (const c of geoSidePts(id).pts) {
          if (movingKey(c.key) && (!GEO_RING || (GEO_RING > 0) === c.top)) continue;
          targets.push({ y: GEO_SIDE * c.along, z: c.z, dirs: [] });
        }
      }
      return { P0: prim ? { y: prim.y, z: prim.z } : null, tangents: prim ? unitDirs(prim, neighboursOf(sc, primaryKey)) : [], targets, base: zBase(sc) };
    }
    const sameDir = (a, b) => Math.abs(a[0] * b[1] - a[1] * b[0]) < 1e-6;
    function axisLock(info, dy, dz) {
      const dirs = [[1, 0], [0, 1]];
      for (const t of info.tangents) if (!dirs.some(d => sameDir(d, t))) dirs.push(t);
      const len = Math.hypot(dy, dz);
      if (len < 1e-12) return { dy: 0, dz: 0, dir: dirs[0] };
      let best = dirs[0], bc = -1;
      for (const d of dirs) { const c = Math.abs(d[0] * dy + d[1] * dz) / len; if (c > bc) { bc = c; best = d; } }
      const s = best[0] * dy + best[1] * dz;
      return { dy: best[0] * s, dz: best[1] * s, dir: best };
    }
    function snapTo(info, Q, lock) {
      const thr = 8 / view.s, lines = [];
      for (const T of info.targets) {
        const dirs = [[1, 0], [0, 1]];
        for (const d of T.dirs) if (!dirs.some(x => sameDir(x, d))) dirs.push(d);
        for (const d of dirs) lines.push({ p: T, d });
      }
      // the heights the view from above shows (the band's lines)
      { const bz = bandZs(); if (bz) for (const z of bz) lines.push({ p: { y: 0, z }, d: [1, 0] }); }
      // and the axis
      lines.push({ p: { y: 0, z: info.base || 0 }, d: [0, 1] });
      // the grid: the nearest vertical and horizontal grid lines (heights measured from the lowest point)
      {
        const st = gridStep(), base = info.base || 0;
        const G = { y: Math.round(Q.y / st) * st, z: base + Math.round((Q.z - base) / st) * st };
        lines.push({ p: G, d: [0, 1], grid: true }, { p: G, d: [1, 0], grid: true });
      }
      const distToLine = (L, P) => Math.abs((P.y - L.p.y) * L.d[1] - (P.z - L.p.z) * L.d[0]);
      const project = (L, P) => { const s = (P.y - L.p.y) * L.d[0] + (P.z - L.p.z) * L.d[1]; return { y: L.p.y + L.d[0] * s, z: L.p.z + L.d[1] * s }; };
      const intersect = (A, B) => {
        const den = A.d[0] * B.d[1] - A.d[1] * B.d[0];
        if (Math.abs(den) < 1e-9) return null;
        const t = ((B.p.y - A.p.y) * B.d[1] - (B.p.z - A.p.z) * B.d[0]) / den;
        return { y: A.p.y + A.d[0] * t, z: A.p.z + A.d[1] * t };
      };
      if (lock) {
        let best = null;
        for (const T of info.targets) {
          const P = project(lock, T), d = Math.hypot(P.y - Q.y, P.z - Q.z);
          if (distToLine(lock, T) < thr * 0.25 && d < thr && (!best || d < best.d)) best = { pos: P, d, guides: [{ from: T, to: P }], point: true, mid: T.mid };
        }
        if (best) return best;
        for (const L of lines) {
          const X = intersect(lock, L); if (!X) continue;
          const d = Math.hypot(X.y - Q.y, X.z - Q.z);
          if (d < thr && (!best || d < best.d)) best = { pos: X, d, guides: [{ from: L.p, to: X }] };
        }
        return best;
      }
      let bestPt = null;
      for (const T of info.targets) { const d = Math.hypot(T.y - Q.y, T.z - Q.z); if (d < thr && (!bestPt || d < bestPt.d)) bestPt = { pos: { y: T.y, z: T.z }, d, guides: [], point: true, mid: T.mid }; }
      if (bestPt) return bestPt;
      const near = lines.map(L => ({ L, d: distToLine(L, Q) })).filter(o => o.d < thr).sort((a, b) => a.d - b.d).slice(0, 40);
      let best = null;
      for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) {
        if (sameDir(near[i].L.d, near[j].L.d)) continue;
        const X = intersect(near[i].L, near[j].L); if (!X) continue;
        const d = Math.hypot(X.y - Q.y, X.z - Q.z);
        if (d < thr && (!best || d < best.d)) best = { pos: X, d, guides: [{ from: near[i].L.p, to: X }, { from: near[j].L.p, to: X }] };
      }
      if (best) return best;
      if (near.length) { const L = near[0].L, P = project(L, Q); return { pos: P, d: near[0].d, guides: [{ from: L.p, to: P }] }; }
      return null;
    }
    function pointInPoly(y, z, poly) {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a.z > z) !== (b.z > z) && y < (b.y - a.y) * (z - a.z) / (b.z - a.z) + a.y) inside = !inside;
      }
      return inside;
    }
    const canPick = (id) => !nodeFlag(state.scene, id, 'locked');
    function frontOrder() {
      const all = leafOrder(state.scene).filter(id => !nodeFlag(state.scene, id, 'hide2d')), sel = all.filter(id => selectedAncestorOf(id) || [...state.sel].some(k => parseKey(k).node === id));
      return all.filter(id => !sel.includes(id)).concat(sel);
    }
    function nodeAt(y, z) {
      const sc = state.scene, order = frontOrder(), th = viewTheta();
      for (let i = order.length - 1; i >= 0; i--) {
        const id = order[i], n = sc.nodes[id], xf = xfOf(sc, id);
        if (!canPick(id)) continue;
        if (n.type === 'geo') { if (inLoops(MS * y, z, geoSection(id)) || inLoops(MS * y, z, geoProjection(id))) return id; continue; }
        if (sliceView()) continue;
        if (pointInPoly(y, z, viewOutline(sc, id))) return id;
        if (xf.id && pointInPoly(y, z, sectionOutline(n, th))) return id;
        // anywhere in a thread's teeth (root to crest, along its length)
        for (const r of n.runs || []) {
          const a = xf.fwd({ y: Math.min(r.rFirst, r.rOther), z: Math.min(r.zFirst, r.zLast) }), b = xf.fwd({ y: Math.max(r.rFirst, r.rOther), z: Math.max(r.zFirst, r.zLast) });
          if (y >= Math.min(a.y, b.y) && y <= Math.max(a.y, b.y) && z >= Math.min(a.z, b.z) && z <= Math.max(a.z, b.z)) return id;
        }
      }
      return null;
    }
    // Selected nodes that contain (or are) a leaf.
    const selectedAncestorOf = (leaf) => [...state.selNodes].some(id => state.scene.nodes[id] && subtreeIds(state.scene, id).has(leaf));
    // Where a radial cloner's handle goes (view coordinates), when it or something in or around it is selected.
    function clonerHandle(id) {
      const sc = state.scene, k = sc.nodes[id];
      if (!k || k.type !== 'cloner' || !findParent(sc, id)) return null;
      const sub = subtreeIds(sc, id);
      if (![...state.selNodes].some(s => sub.has(s)) && !selectedAncestorOf(id) && !(drag && drag.type === 'cloner' && drag.id === id)) return null;
      const q = k.params, R = q.radius || 0, xf = xfOf(sc, id);
      let z0 = Infinity, z1 = -Infinity, y1 = -Infinity;
      for (const leaf of leavesUnder(sc, [id])) for (const p of viewOutline(sc, leaf)) { z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); y1 = Math.max(y1, p.y); }
      if (q.orient === 'radial') {
        const at = xf.fwd({ y: R, z: q.height || 0 });
        return { radial: true, at, a: at, b: { y: Math.max(at.y + 10 / view.s, isFinite(y1) ? y1 : at.y), z: at.z } };
      }
      if (!isFinite(z0)) { z0 = zBase(); z1 = z0 + 10 / MM; }
      const a = xf.fwd({ y: R, z: z0 }), b = xf.fwd({ y: R, z: z1 });
      return { radial: false, at: a, a, b };
    }

    // ---- drawing ----
    const AX_B = 44, AX_L = 64;
    // grid spacing (inches) for the current zoom: a round number of mm about every 55 px
    function gridStep() {
      const pxPerUnit = view.s / UNIT_SCALE;
      return ([0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50].find(s => s * pxPerUnit >= 55) || 100) / UNIT_SCALE;
    }   // bottom axis strip (radius + diameter + cursor rows), left axis strip
    // Grid lines and axis ticks at round steps; the next finer step fades in as the zoom spreads it out, so
    // zooming moves the ticks smoothly instead of swapping them.
    const GRID_STEPS = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
    function grid(g, base, top) {
      rotOff = !!top;
      try { gridIn(g, base, top); } finally { rotOff = false; }
    }
    function gridIn(g, base, top) {
      const { w, h } = size();
      const [ya, zA] = toWorld(0, h), [yb, zB] = toWorld(w, 0), za = Math.min(zA, zB), zb = Math.max(zA, zB), offS = !top && sliceView();
      const pxu = view.s / UNIT_SCALE; let i = GRID_STEPS.findIndex(s => s * pxu >= 55); if (i < 0) i = GRID_STEPS.length - 1;
      const main = GRID_STEPS[i] / UNIT_SCALE, fine = i > 0 ? GRID_STEPS[i - 1] / UNIT_SCALE : main, finePx = i > 0 ? fine * view.s : 0;
      const clamp01 = (x) => Math.max(0, Math.min(1, x));
      const aLine = clamp01((finePx - 12) / (55 - 12)), aLab = clamp01((finePx - 36) / (55 - 36));
      const lab = (x, y, text, o = {}) => { const t = sv('text', { x, y, 'font-size': 10, fill: o.fill || '#868e96', 'text-anchor': o.anchor || 'start', opacity: o.op == null ? 1 : o.op }); t.textContent = text; g.append(t); };
      const isMain = (v) => Math.abs(v / main - Math.round(v / main)) < 1e-6;
      const levels = [[main, 1, 1]];
      if (aLine > 0.01 && !lowQuality()) levels.unshift([fine, aLine, aLab]);
      if (top) {
        // from above: rings at round distances from the axis, and spokes every 30° (15° faint)
        const [ox, oy] = toScreen(0, 0), far = Math.max(...[[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => Math.hypot(x - ox, y - oy))) / view.s;
        const near0 = (ox < 0 || ox > w || oy < 0 || oy > h) ? Math.max(0, Math.hypot(Math.max(0 - ox, 0, ox - w), Math.max(0 - oy, 0, oy - h)) / view.s) : 0;
        for (const [st, aL] of levels) {
          if ((far - near0) / st > 600) continue;
          for (let r = Math.max(st, Math.ceil(near0 / st) * st); r <= far; r += st) {
            if (st !== main && isMain(r)) continue;
            g.append(sv('circle', { cx: ox.toFixed(1), cy: oy.toFixed(1), r: (r * view.s).toFixed(1), fill: 'none', stroke: '#e9ecef', 'stroke-opacity': aL }));
          }
        }
        const L = far * view.s;
        for (let a = 0; a < 360; a += 15) {
          const t = FZ() * (a * Math.PI / 180 - state.viewAngle * Math.PI / 180), ax = a % 90 === 0;     // spokes at the part's own angles
          g.append(sv('line', { x1: ox, y1: oy, x2: ox + L * Math.cos(t), y2: oy - L * Math.sin(t), stroke: ax ? '#adb5bd' : '#e9ecef', 'stroke-opacity': ax || a % 30 === 0 ? 1 : 0.6 }));
        }
      } else for (const [st, aL] of levels) {
        for (let y = Math.ceil(ya / st) * st; y <= yb; y += st) {
          if (st !== main && isMain(y)) continue;
          const [x] = toScreen(y, 0);
          g.append(sv('line', { x1: x, y1: 0, x2: x, y2: h - AX_B, stroke: Math.abs(y) < st / 2 ? '#adb5bd' : '#e9ecef', 'stroke-opacity': aL }));
        }
        for (let zr = Math.ceil((za - base) / st) * st; zr <= zb - base; zr += st) {
          if (st !== main && isMain(zr)) continue;
          const [, y] = toScreen(0, base + zr);
          g.append(sv('line', { x1: AX_L, y1: y, x2: w, y2: y, stroke: Math.abs(zr) < st / 2 ? '#adb5bd' : '#e9ecef', 'stroke-opacity': aL }));
        }
      }
      // axis strips (their own group, raised over the drawing once it is drawn)
      { const axG = sv('g', { 'data-axes': '1' }); g.append(axG); g = axG; }
      g.append(sv('rect', { x: 0, y: h - AX_B, width: w, height: AX_B, fill: 'rgba(248,249,250,.95)', stroke: '#dee2e6' }));
      g.append(sv('rect', { x: 0, y: 0, width: AX_L, height: h - AX_B, fill: 'rgba(248,249,250,.95)', stroke: '#dee2e6' }));
      for (const [st, aL, aT] of levels) {
        for (let y = Math.ceil(ya / st) * st; y <= yb; y += st) {
          if (st !== main && isMain(y)) continue;
          const [x] = toScreen(y, 0);
          if (x < AX_L) continue;
          g.append(sv('line', { x1: x, y1: h - AX_B, x2: x, y2: h - AX_B + (st === main ? 4 : 3), stroke: '#adb5bd', 'stroke-opacity': aL }));
          if (aT > 0.01) {        // (from above too: the section line is level, so this is still the radius along it)
            lab(x, h - 4, num(mm(Math.abs(y)), 3) + ' ' + UNIT_LABEL, { anchor: 'middle', op: aT });                 // radius (positive on both sides)
            if (!offS) lab(x, h - 17, 'Ø' + num(mm(2 * Math.abs(y)), 3) + ' ' + UNIT_LABEL, { anchor: 'middle', fill: '#adb5bd', op: aT });  // diameter (not at a slice off the axis)
          }
        }
        for (let zr = Math.ceil((za - base) / st) * st; zr <= zb - base; zr += st) {
          if (st !== main && isMain(zr)) continue;
          const [, y] = toScreen(0, base + zr);
          if (y > h - AX_B) continue;
          g.append(sv('line', { x1: AX_L - (st === main ? 4 : 3), y1: y, x2: AX_L, y2: y, stroke: '#adb5bd', 'stroke-opacity': aL }));
          if (aT > 0.01) lab(AX_L - 6, y + 3, num((top ? Math.abs(zr) : HS() * zr) * UNIT_SCALE, 3) + ' ' + UNIT_LABEL, { anchor: 'end', op: aT });
        }
      }
      const t1 = sv('text', { x: AX_L + 4, y: h - AX_B - 4, 'font-size': 10, fill: '#adb5bd' }); t1.textContent = offS ? 'x: along the slice →' : 'x: radius / Ø →'; g.append(t1);
      const t2 = sv('text', { x: 4, y: 12, 'font-size': 10, fill: '#adb5bd' }); t2.textContent = top ? 'distance' : state.heightFrom === 'top' ? 'y: depth from the top ↓' : 'y: height ↑'; g.append(t2);
    }
    // Ticks on both axes for the mouse position, or for the point being dragged.
    let cursorW = null;
    function drawCursor() {
      const old = svg.querySelector('#aa-cursor'); if (old) old.remove();
      if (!state.scene || !view || topMode()) return;
      const P = drag && drag.cur ? drag.cur : cursorW;
      if (!P) return;
      const MSc = MS; MS = drag ? dragSide : (cursorW && cursorW.side) || 1;
      const { w, h } = size(), base = drag && drag.base != null ? drag.base : sceneBase, [x, y] = toScreen(P.y, P.z);
      MS = MSc;
      const g = sv('g', { id: 'aa-cursor', 'pointer-events': 'none' });
      const col = drag && drag.cur ? '#e03131' : '#1f6feb';
      if (x >= AX_L && x <= w) {
        g.append(sv('line', { x1: x, y1: h - AX_B - 6, x2: x, y2: h - AX_B + 6, stroke: col, 'stroke-width': 2 }));
        const tx = Math.max(AX_L + 70, Math.min(w - 70, x));
        g.append(sv('rect', { x: tx - 78, y: h - AX_B - 22, width: 156, height: 15, rx: 3, fill: col, opacity: 0.9 }));
        const t = sv('text', { x: tx, y: h - AX_B - 11, 'font-size': 10, fill: '#fff', 'text-anchor': 'middle' });
        t.textContent = 'x: r ' + num(mm(P.y), 3) + ' / Ø ' + num(mm(2 * P.y), 3) + ' ' + UNIT_LABEL; g.append(t);
      }
      if (y >= 0 && y <= h - AX_B) {
        g.append(sv('line', { x1: AX_L - 6, y1: y, x2: AX_L + 6, y2: y, stroke: col, 'stroke-width': 2 }));
        g.append(sv('rect', { x: AX_L + 8, y: y - 8, width: 84, height: 15, rx: 3, fill: col, opacity: 0.9 }));
        const t = sv('text', { x: AX_L + 50, y: y + 3, 'font-size': 10, fill: '#fff', 'text-anchor': 'middle' });
        t.textContent = 'y: ' + num(hDisp(P.z, base), 3) + ' ' + UNIT_LABEL; g.append(t);
      }
      svg.append(g);
    }
    // A small label with a light halo.
    function label(parent, x, y, lines, o = {}) {
      const g = sv('g', { 'pointer-events': 'none' });
      const lh = 12, wpx = Math.max(...lines.map(l => l.length)) * 5.6 + 8;
      g.append(sv('rect', { x: x - 3, y: y - 10, width: wpx, height: lines.length * lh + 4, rx: 3, fill: o.bg || 'rgba(255,255,255,.88)', stroke: o.border || '#ced4da' }));
      lines.forEach((l, i) => { const t = sv('text', { x, y: y + i * lh, 'font-size': 10, fill: o.fill || '#343a40', 'font-weight': i === 0 && o.boldFirst ? 700 : 400 }); t.textContent = l; g.append(t); });
      parent.append(g);
    }
    let sceneBase = 0;
    const COLORS = { geo: '#0b7285', source: '#1f6feb', circle: '#2f9e44', ngon: '#7048e8', cog: '#a61e4d', thread: '#e8590c', group: '#495057', boolean: '#495057', cloner: '#495057', holes: '#c92a2a' };
    const viewTheta = () => state.viewAngle * Math.PI / 180 + (MS < 0 ? Math.PI : 0);
    // A, B: the scene point moved (x, y, height) before and after; ang: the move's direction on the screen (degrees);
    // extra: a line about the thing itself
    function showTag(e, lines) {
      const [sx, sy] = local(e);
      offTag.textContent = '';
      lines.forEach((t, i) => offTag.append(el('div', i ? { style: 'color:#868e96' } : null, t)));
      offTag.style.display = '';
      const w = offTag.offsetWidth || 160, { w: W } = size();
      offTag.style.left = (sx + 16 + w > W ? sx - w - 12 : sx + 16) + 'px'; offTag.style.top = (sy + 18) + 'px';
    }
    function showOff(e, A, B, ang, extra) {
      const [sx, sy] = local(e), d = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], L = (v) => num(mm(v), 3), m = state.offsetMode || 'polar';
      const ad = (v) => num(v * ANG_SCALE, ANG_SCALE === 1 ? 1 : 4) + ANG_LABEL;
      let t;
      if (m === 'xyz') t = 'Δx ' + L(d[0]) + ' · Δy ' + L(HS() * d[2]) + ' · Δz ' + L(d[1]) + ' ' + UNIT_LABEL;
      else if (m === 'radial') {
        let da = (Math.atan2(B[1], B[0]) - Math.atan2(A[1], A[0])) * 180 / Math.PI;
        da = ((da + 540) % 360) - 180;
        if (Math.hypot(A[0], A[1]) < 1e-9 || Math.hypot(B[0], B[1]) < 1e-9) da = 0;
        t = 'Δr ' + L(Math.hypot(B[0], B[1]) - Math.hypot(A[0], A[1])) + ' ' + UNIT_LABEL + ' · Δθ ' + ad(da) + ' · Δh ' + L(HS() * d[2]) + ' ' + UNIT_LABEL;
      } else t = L(Math.hypot(d[0], d[1], d[2])) + ' ' + UNIT_LABEL + ' at ' + ad((((ang || 0) % 360) + 360) % 360);
      offTag.textContent = '';
      offTag.append(el('div', null, t));
      if (extra) offTag.append(el('div', { style: 'color:#868e96' }, extra));
      offTag.style.display = '';
      const w = offTag.offsetWidth || 160, { w: W } = size();
      offTag.style.left = (sx + 16 + w > W ? sx - w - 12 : sx + 16) + 'px'; offTag.style.top = (sy + 18) + 'px';
    }
    // a geometric object's section in the radius/height view: loops of (place along the section, height)
    // A geometric object's corners (each at its bottom and its top) and its edges, seen square-on to the section's
    // plane: (place along the plane, height), its first copy, keyed as from above
    function geoSidePts(id) {
      const n = state.scene.nodes[id], q = n.params, M = geoRot(q), hh = Math.abs(q.h) / 2, zc = Math.min(q.z, q.z + q.h) + hh;
      const f = geoCopies(state.scene, id)[0].f, th = state.viewAngle * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
      const at = (x, y, z) => { const w = f([q.cx + M[0][0] * x + M[0][1] * y + M[0][2] * z, q.cy + M[1][0] * x + M[1][1] * y + M[1][2] * z, zc + M[2][0] * x + M[2][1] * y + M[2][2] * z]); return [w[0] * c + w[1] * s, w[2]]; };
      const pts = [], edges = [], N = n.shape.length;
      for (const top of [false, true]) {
        const zz = top ? hh : -hh, P = geoCorners(n, true, true, top ? 1 : -1).map(([x, y], i) => at(x, y, zz + (+n.shape[i][top ? 'dt' : 'db'] || 0)));
        P.forEach((v, i) => { pts.push({ i, top, key: id + '|q|' + i, along: v[0], z: v[1] }); edges.push({ i, top, key: id + '|qe|' + i, a: v, b: P[(i + 1) % N] }); });
      }
      return { pts, edges };
    }
    // the edges of the same end (top or bottom) of a geometric object that lie over each other at a place on the
    // section's plane (front and back, seen square-on), and where along each that place is
    function geoOverlapEdges(id, top, along, z) {
      const tol = 6 / view.s;
      return geoSidePts(id).edges.filter(E => {
        if (E.top !== top || Math.abs(E.b[0] - E.a[0]) < 1e-9) return false;
        const t = (along - E.a[0]) / (E.b[0] - E.a[0]);
        return t > -0.02 && t < 1.02 && Math.abs(E.a[1] + (E.b[1] - E.a[1]) * t - z) < tol;
      }).map(E => ({ i: E.i, key: E.key, t: Math.max(0.02, Math.min(0.98, (along - E.a[0]) / (E.b[0] - E.a[0]))) }));
    }
    function geoSection(id) { const gw = geoWorld(state.scene, id); return gw ? sliceLoops(gw.V, gw.T, state.viewAngle * Math.PI / 180, sliceOff()) : []; }
    // its outline seen square-on to the section's plane (each copy's), wherever it is: (place along the plane, height)
    function geoProjection(id) {
      const gw = geoWorld(state.scene, id); if (!gw || !gw.per) return [];
      const th = state.viewAngle * Math.PI / 180, c = Math.cos(th), sn = Math.sin(th), out = [];
      for (let b = 0; b < gw.V.length / 3; b += gw.per) {
        const pts = [];
        for (let i = b; i < b + gw.per; i++) pts.push([gw.V[i * 3] * c + gw.V[i * 3 + 1] * sn, gw.V[i * 3 + 2]]);
        const h = hull2(pts); if (h.length > 2) out.push(h);
      }
      return out;
    }
    const inLoops = (x, y, loops) => {
      let c = false;
      for (const L of loops) for (let i = 0, j = L.length - 1; i < L.length; j = i++) { const A = L[i], B = L[j]; if ((A[1] > y) !== (B[1] > y) && x < (B[0] - A[0]) * (y - A[1]) / (B[1] - A[1]) + A[0]) c = !c; }
      return c;
    };
    // where a new geometric object goes: the middle of the view (radius/height: on the section's plane, half its
    // height below the middle; from above: at the bottom of the part)
    function geoSpawnPoint() {
      if (!view) return { x: 0, y: 0, z: 0 };
      measure();
      const th = state.viewAngle * Math.PI / 180, { w, h } = size();
      if (topMode()) { MS = 1; const [X, Y] = toWorld(AX_L + (w - AX_L) / 2, (h - AX_B) / 2), r = sceneZRange(); return { x: X, y: Y, z: r ? r[0] : 0 }; }
      return { x: view.cy * Math.cos(th), y: view.cy * Math.sin(th), z: FZ() * view.cz - 2.5 / MM };
    }
    // a new geometric object: seen from above, centred on it
    function geoSpawned(id) {
      const n = state.scene.nodes[id]; if (!n) return;
      if (!topMode()) setSecMode('top');
      if (!view) fit();
      const [X, Y] = placeOf(state.scene, id).w(n.params.cx, n.params.cy), t = topTurn(), c = Math.cos(t), s = Math.sin(t);
      view.cy = X * c + Y * s - AX_L / 2 / view.s; view.cz = FZ() * (-X * s + Y * c) - AX_B / 2 / view.s;
      drawSection();
    }

    // ---- Monomorphic (or auto-simplified when zoomed out to 50 % or less): what is not selected is one grey shape ----
    // (auto-simplify: at half the fitted zoom or less, measured against this view's own fit; the button turns it off
    // again until the view is zoomed back in past half)
    const fitScales = { section: 0, top: 0 };
    let monoAutoOff = false;
    const autoMono = () => {
      const f = fitScales[topMode() ? 'top' : 'section'] || (view && view.fit) || 0;
      const zoomedOut = !!(state.autoSimplify && view && f > 0 && view.s / f <= 0.5 + 1e-9);
      if (!zoomedOut) monoAutoOff = false;
      return zoomedOut && !monoAutoOff;
    };
    // (the Measurement view: everything monomorphic, nothing to select)
    const monoOn = () => !!(state.mono || autoMono() || state.measure);
    const monoHid = (id) => monoOn() && (state.measure || !selectedAncestorOf(id));
    // one shape from these outlines: their edges first, then their fills over them (hiding the edges between them);
    // the subtracted ones are holes (the grid shows through), edged only where they cut the shape
    function drawMono(into, pos, neg, key) {
      if (!pos.length) return;
      const cid = 'aa-mono-c' + key, mid = 'aa-mono-m' + key, clip = sv('clipPath', { id: cid });
      for (const dd of pos) clip.append(sv('path', { d: dd, 'clip-rule': 'evenodd' }));
      const mask = sv('mask', { id: mid, maskUnits: 'userSpaceOnUse', x: -1e5, y: -1e5, width: 2e5, height: 2e5 });
      mask.append(sv('rect', { x: -1e5, y: -1e5, width: 2e5, height: 2e5, fill: '#fff' }));
      for (const dd of neg) mask.append(sv('path', { d: dd, fill: '#000', 'fill-rule': 'evenodd', stroke: '#000', 'stroke-width': 1 }));
      into.append(clip, mask);
      const body = sv('g', neg.length ? { mask: 'url(#' + mid + ')' } : {});
      for (const dd of pos) body.append(sv('path', { d: dd, fill: 'none', stroke: '#868e96', 'stroke-width': 2.4, 'stroke-linejoin': 'round' }));
      for (const dd of pos) body.append(sv('path', { d: dd, fill: '#dee2e6', 'fill-rule': 'evenodd', stroke: 'none' }));
      into.append(body);
      for (const dd of neg) into.append(sv('path', { d: dd, fill: 'none', stroke: '#868e96', 'stroke-width': 2.4, 'stroke-linejoin': 'round', 'clip-path': 'url(#' + cid + ')' }));
    }

    // The finished part (after every union, subtraction and intersection) cut by the section's plane: closed loops of
    // (signed radius, height) in scene units, the left half at negative radius. From the 3D model, so it is exact;
    // null until there is one. Cached per model, angle and distance. (off: the plane's distance from the axis along
    // its normal, for the linked slicers; the first number of a loop's points is then the place along the plane.)
    let meshSecCache = null;
    function meshSection(theta, off = 0) {
      const t = meshTris;
      if (!t || !t.length) return null;
      if (meshSecCache && meshSecCache.t === t && meshSecCache.theta === theta && meshSecCache.off === off) return meshSecCache.loops;
      const c = Math.cos(theta), s = Math.sin(theta), fy = meshFlip ? -1 : 1, segs = [], sh = meshShift || [0, 0, 0];
      // a mesh point (mm, centred, stood on Z = 0, turned over when flipped) → back where the scene has it → across the plane, along it, height
      const P = (o) => { const x = t[o] / MM + sh[0], y = (t[o + 1] / MM + sh[1]) * fy, z = (t[o + 2] / MM + sh[2]) * fy; return [(-x * s + y * c), (x * c + y * s), z]; };
      for (let o = 0; o + 17 < t.length; o += 18) {
        const A = P(o), B = P(o + 6), C = P(o + 12), pts = [];
        for (const [p, q] of [[A, B], [B, C], [C, A]]) {
          if ((p[0] < off) !== (q[0] < off)) { const k = (p[0] - off) / (p[0] - q[0]); pts.push([p[1] + (q[1] - p[1]) * k, p[2] + (q[2] - p[2]) * k]); }
        }
        if (pts.length === 2) segs.push(pts);
      }
      // chain the pieces into loops
      const key = (p) => Math.round(p[0] * 1e6) + ',' + Math.round(p[1] * 1e6), ends = new Map();
      segs.forEach((sg, i) => { for (const e of [0, 1]) { const k = key(sg[e]); if (!ends.has(k)) ends.set(k, []); ends.get(k).push([i, e]); } });
      const used = new Uint8Array(segs.length), loops = [];
      for (let i = 0; i < segs.length; i++) {
        if (used[i]) continue;
        used[i] = 1;
        const loop = [segs[i][0], segs[i][1]];
        for (let guard = 0; guard < segs.length; guard++) {
          const nxt = (ends.get(key(loop[loop.length - 1])) || []).find(([j]) => !used[j]);
          if (!nxt) break;
          used[nxt[0]] = 1; loop.push(segs[nxt[0]][1 - nxt[1]]);
        }
        if (loop.length > 2) loops.push(loop);
      }
      meshSecCache = { t, theta, off, loops };
      return loops;
    }

    // ---- monomorphic from above: the finished part itself, so a subtraction only takes away what it really removes ----
    // The outline is Manifold's projection of the solid cut to the height band (exact, with the holes that go right
    // through); the lines inside are the part's sharp edges in the band (where one part stands over another, steps,
    // bores), where nothing of the part covers them from where it is looked at (above; the other side with the y axis
    // inverted). Worked out off the drawing (it can take a moment) and kept per model, band and side.
    let topMonoSolid = null, topMonoCache = null, topMonoWant = null, topMonoTimer = 0;
    async function mainManifold() {
      if (W.__aaManifold) return W.__aaManifold;
      const mod = await import(jobSettings().manifoldUrl), wasm = await mod.default();
      wasm.setup(); W.__aaManifold = wasm;
      return wasm;
    }
    // faces lying against faces turned the other way (two solids just touching): inside the part, not its surface
    function ghostFaces(V, T, N) {
      const nt = T.length / 3, ghost = new Uint8Array(nt), buckets = new Map();
      for (let f = 0; f < nt; f++) {
        const nx = N[f * 3], ny = N[f * 3 + 1], nz = N[f * 3 + 2];
        if (!(nx || ny || nz)) continue;
        const a = T[f * 3] * 3, d0 = nx * V[a] + ny * V[a + 1] + nz * V[a + 2];
        const flip = (Math.abs(nx) > 1e-6 ? nx : Math.abs(ny) > 1e-6 ? ny : nz) < 0, s = flip ? -1 : 1;
        const key = Math.round(nx * s * 500) + ',' + Math.round(ny * s * 500) + ',' + Math.round(nz * s * 500) + ',' + Math.round(d0 * s * 2000);
        let b = buckets.get(key); if (!b) buckets.set(key, b = [[], []]);
        b[flip ? 1 : 0].push(f);
      }
      const area = (P) => { let s = 0; for (let i = 0; i < P.length; i++) { const A = P[i], B = P[(i + 1) % P.length]; s += A[0] * B[1] - B[0] * A[1]; } return s / 2; };
      const ccw = (P) => area(P) < 0 ? P.reverse() : P;
      // the area two triangles share (one clipped by the other)
      const shared = (P, Q) => {
        let out = P;
        for (let i = 0; i < 3 && out.length; i++) {
          const A = Q[i], B = Q[(i + 1) % 3], inp = out; out = [];
          const side = (p) => (B[0] - A[0]) * (p[1] - A[1]) - (B[1] - A[1]) * (p[0] - A[0]);
          for (let k = 0; k < inp.length; k++) {
            const p = inp[k], q = inp[(k + 1) % inp.length], sp = side(p), sq = side(q);
            if (sp >= 0) out.push(p);
            if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
          }
        }
        return out.length > 2 ? Math.abs(area(out)) : 0;
      };
      for (const [up, dn] of buckets.values()) {
        if (!up.length || !dn.length) continue;
        const f0 = up[0], big = [0, 1, 2].reduce((m, i) => Math.abs(N[f0 * 3 + i]) > Math.abs(N[f0 * 3 + m]) ? i : m, 0), ax = [[1, 2], [0, 2], [0, 1]][big];
        const tri = (f) => { const o = []; for (let k = 0; k < 3; k++) { const v = T[f * 3 + k] * 3; o.push([V[v + ax[0]], V[v + ax[1]]]); } return ccw(o); };
        const box = (P) => [Math.min(P[0][0], P[1][0], P[2][0]), Math.max(P[0][0], P[1][0], P[2][0]), Math.min(P[0][1], P[1][1], P[2][1]), Math.max(P[0][1], P[1][1], P[2][1])];
        const U = up.map(tri), D = dn.map(tri), UB = U.map(box), DB = D.map(box);
        const cu = new Float64Array(up.length), cd = new Float64Array(dn.length);
        for (let i = 0; i < up.length; i++) for (let j = 0; j < dn.length; j++) {
          const a = UB[i], b = DB[j];
          if (a[1] <= b[0] || b[1] <= a[0] || a[3] <= b[2] || b[3] <= a[2]) continue;
          const s = shared(U[i], D[j]); cu[i] += s; cd[j] += s;
        }
        // mostly against another face: inside
        up.forEach((f, i) => { if (cu[i] > 0.6 * Math.abs(area(U[i]))) ghost[f] = 1; });
        dn.forEach((f, j) => { if (cd[j] > 0.6 * Math.abs(area(D[j]))) ghost[f] = 1; });
      }
      return ghost;
    }
    // What lies over each place of the part, for telling which edges can be seen: the model's faces (the upright ones
    // left out) in a grid from above, each with its plane worked out. Built once per model.
    function coverIndex(V, T) {
      const nt = T.length / 3;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < V.length; i += 3) { x0 = Math.min(x0, V[i]); x1 = Math.max(x1, V[i]); y0 = Math.min(y0, V[i + 1]); y1 = Math.max(y1, V[i + 1]); z0 = Math.min(z0, V[i + 2]); z1 = Math.max(z1, V[i + 2]); }
      if (!isFinite(x0)) return null;
      const diag = Math.hypot(x1 - x0, y1 - y0, z1 - z0) || 1, G = Math.max(16, Math.min(256, Math.round(Math.sqrt(nt) * 1.5)));
      const sx = G / ((x1 - x0) || 1), sy = G / ((y1 - y0) || 1);
      const cx = (x) => Math.max(0, Math.min(G - 1, Math.floor((x - x0) * sx))), cy = (y) => Math.max(0, Math.min(G - 1, Math.floor((y - y0) * sy)));
      // per face: a corner, the two rows that turn (x, y) into its (u, v), and the heights across it
      const F = new Float64Array(nt * 9), box = new Int32Array(nt * 4), start = new Uint32Array(G * G + 1);
      for (let f = 0; f < nt; f++) {
        const a = T[f * 3] * 3, b = T[f * 3 + 1] * 3, c = T[f * 3 + 2] * 3, o = f * 9;
        const d = (V[b] - V[a]) * (V[c + 1] - V[a + 1]) - (V[c] - V[a]) * (V[b + 1] - V[a + 1]);
        box[f * 4] = -1;
        if (Math.abs(d) < 1e-14) continue;                          // upright: seen edge-on from above
        F[o] = V[a]; F[o + 1] = V[a + 1]; F[o + 2] = V[a + 2];
        F[o + 3] = (V[c + 1] - V[a + 1]) / d; F[o + 4] = -(V[c] - V[a]) / d; F[o + 5] = -(V[b + 1] - V[a + 1]) / d; F[o + 6] = (V[b] - V[a]) / d;
        F[o + 7] = V[b + 2] - V[a + 2]; F[o + 8] = V[c + 2] - V[a + 2];
        const i0 = cx(Math.min(V[a], V[b], V[c])), i1 = cx(Math.max(V[a], V[b], V[c])), j0 = cy(Math.min(V[a + 1], V[b + 1], V[c + 1])), j1 = cy(Math.max(V[a + 1], V[b + 1], V[c + 1]));
        box[f * 4] = i0; box[f * 4 + 1] = i1; box[f * 4 + 2] = j0; box[f * 4 + 3] = j1;
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) start[j * G + i + 1]++;
      }
      for (let i = 0; i < G * G; i++) start[i + 1] += start[i];
      const items = new Uint32Array(start[G * G]), fill = start.slice(0, G * G);
      for (let f = 0; f < nt; f++) {
        if (box[f * 4] < 0) continue;
        for (let j = box[f * 4 + 2]; j <= box[f * 4 + 3]; j++) for (let i = box[f * 4]; i <= box[f * 4 + 1]; i++) items[fill[j * G + i]++] = f;
      }
      // (nudged off any shared edge, so a ray from the place crosses each surface once)
      return { F, start, items, G, cx, cy, eps: diag * 2e-5, step: Math.hypot(x1 - x0, y1 - y0) / 700, DX: diag * 1.37e-7, DY: diag * 0.73e-7, span: Math.max(Math.abs(x0), Math.abs(x1), Math.abs(y0), Math.abs(y1)) };
    }
    // Is the place covered, looking at it along dir (1: from above, -1: from below)?
    // Past the lid (the end of the height band on the viewer's side) the inside of the part covers it: the cut is a lid.
    function covered(ix, x, y, z, lid, dir) {
      x += ix.DX; y += ix.DY;
      const { F, start, items } = ix, c = ix.cy(y) * ix.G + ix.cx(x);
      let past = 0;
      for (let k = start[c], e = start[c + 1]; k < e; k++) {
        const o = items[k] * 9, px = x - F[o], py = y - F[o + 1], u = F[o + 3] * px + F[o + 4] * py;
        if (u < 0) continue;
        const v = F[o + 5] * px + F[o + 6] * py;
        if (v < 0 || u + v > 1) continue;
        const zf = F[o + 2] + F[o + 7] * u + F[o + 8] * v;
        if ((zf - z) * dir <= ix.eps) continue;
        if ((zf - lid) * dir <= 0) return true;
        past++;
      }
      return (past & 1) === 1;
    }
    // Is any of the part over this place within the heights lo…hi (not counting what only touches them)?
    function inBand(ix, x, y, lo, hi) {
      x += ix.DX; y += ix.DY;
      const { F, start, items } = ix, c = ix.cy(y) * ix.G + ix.cx(x), a = lo + ix.eps, b = hi - ix.eps;
      let above = 0;
      for (let k = start[c], e = start[c + 1]; k < e; k++) {
        const o = items[k] * 9, px = x - F[o], py = y - F[o + 1], u = F[o + 3] * px + F[o + 4] * py;
        if (u < 0) continue;
        const v = F[o + 5] * px + F[o + 6] * py;
        if (v < 0 || u + v > 1) continue;
        const zf = F[o + 2] + F[o + 7] * u + F[o + 8] * v;
        if (zf > a && zf < b) return true;          // a surface inside the band: material next to it
        if (zf > a) above++;
      }
      return (above & 1) === 1;                      // inside the part all the way through the band
    }
    // the pieces of these segments ([ax, ay, az, bx, by, bz] …) that can be seen, as a path (x y pairs in scene units)
    function visiblePath(ix, segs, lid, dir, f, lo, hi) {
      const banded = isFinite(lo) || isFinite(hi);
      let out = '';
      for (let k = 0; k < segs.length; k += 6) {
        const ax = segs[k], ay = segs[k + 1], az = segs[k + 2], bx = segs[k + 3], by = segs[k + 4], bz = segs[k + 5];
        const L = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.min(64, Math.ceil(L / ix.step)));
        // hidden only when covered just to both sides of it (an edge right under the rim of a wall is still seen)
        const ox = -(by - ay) / (L || 1) * ix.eps * 5, oy = (bx - ax) / (L || 1) * ix.eps * 5;
        let from = -1;
        for (let i = 0; i <= n; i++) {
          const mx = ax + (bx - ax) * (i + 0.5) / n, my = ay + (by - ay) * (i + 0.5) / n, mz = az + (bz - az) * (i + 0.5) / n;
          // (with a band of heights: not the outline of something the band holds none of, lying just at its edge)
          const vis = i < n && !(covered(ix, mx + ox, my + oy, mz, lid, dir) && covered(ix, mx - ox, my - oy, mz, lid, dir)) &&
            (!banded || inBand(ix, mx + ox, my + oy, lo, hi) || inBand(ix, mx - ox, my - oy, lo, hi));
          if (vis && from < 0) from = i;
          if (!vis && from >= 0) { out += 'M' + f(ax + (bx - ax) * from / n) + ' ' + f(ay + (by - ay) * from / n) + 'L' + f(ax + (bx - ax) * i / n) + ' ' + f(ay + (by - ay) * i / n); from = -1; }
        }
      }
      return out;
    }
    // the model welded, in scene units where the scene has it; its sharp edges as 3D segments
    function topMonoMesh(t) {
      const fy = meshFlip ? -1 : 1, sh = meshShift || [0, 0, 0], ids = new Map(), V = [], T = new Uint32Array(t.length / 6);
      for (let o = 0, k = 0; o + 17 < t.length; o += 18) for (let c = 0; c < 3; c++, k++) {
        const p = o + c * 6, key = t[p] + ',' + t[p + 1] + ',' + t[p + 2];
        let id = ids.get(key);
        if (id === undefined) { id = V.length / 3; ids.set(key, id); V.push(t[p] / MM + sh[0], (t[p + 1] / MM + sh[1]) * fy, (t[p + 2] / MM + sh[2]) * fy); }
        T[k] = id;
      }
      const nt = T.length / 3, N = new Float64Array(nt * 3), edges = new Map();
      for (let f = 0; f < nt; f++) {
        const a = T[f * 3] * 3, b = T[f * 3 + 1] * 3, c = T[f * 3 + 2] * 3;
        const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2], vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1;
        N[f * 3] = nx / l; N[f * 3 + 1] = ny / l; N[f * 3 + 2] = nz / l;
        for (let e = 0; e < 3; e++) {
          const i = T[f * 3 + e], j = T[f * 3 + (e + 1) % 3], key = i < j ? i * 4294967296 + j : j * 4294967296 + i;
          const s = edges.get(key); if (s) s.push(f); else edges.set(key, [f]);
        }
      }
      // where two solids just touch, their touching faces are inside the part: no lines from them
      const ghost = ghostFaces(V, T, N), seg = [], COS = Math.cos(25 * Math.PI / 180);
      for (const [key, fs0] of edges) {
        const fs = fs0.filter(f => !ghost[f]);
        let sharp = false;
        if (fs.length === 2) {
          const [f, g] = fs, dot = N[f * 3] * N[g * 3] + N[f * 3 + 1] * N[g * 3 + 1] + N[f * 3 + 2] * N[g * 3 + 2];
          const zf = N[f * 3 + 2], zg = N[g * 3 + 2];
          sharp = dot < COS || (zf > 1e-3 && zg < -1e-3) || (zf < -1e-3 && zg > 1e-3);   // a crease, or where the surface turns away from above
        }
        if (!sharp) continue;
        const i = Math.floor(key / 4294967296) * 3, j = (key % 4294967296) * 3;
        if (Math.hypot(V[i] - V[j], V[i + 1] - V[j + 1]) < 1e-7) continue;          // upright: a point from above
        seg.push(V[i], V[i + 1], V[i + 2], V[j], V[j + 1], V[j + 2]);
      }
      return { V: new Float32Array(V), T, seg };
    }
    // The drawing for this band of heights, as two paths in scene units ({ dd: outline, ln: lines inside }); the last
    // one made until the new one is ready, null when there is none (or it cannot be made).
    function topMono(band) {
      const t = meshTris;
      if (!t || !t.length) { topMonoCache = null; return null; }
      const lo = band ? band.lo : -Infinity, hi = band ? band.hi : Infinity, fl = !!state.flip;
      const same = (k) => k && k.t === t && k.lo === lo && k.hi === hi && k.fl === fl;
      if (same(topMonoCache)) return topMonoCache.res;
      if (!same(topMonoWant)) {
        topMonoWant = { t, lo, hi, fl };
        clearTimeout(topMonoTimer);
        // while something is being dragged the model changes many times a second: wait for a pause
        topMonoTimer = setTimeout(topMonoRun, drag && drag.moved ? 250 : 0);
      }
      return topMonoCache ? topMonoCache.res : null;
    }
    async function topMonoRun() {
      const job = topMonoWant;
      if (!job) return;
      const { t, lo, hi, fl } = job;
      let res = null;
      try {
        const mf = await mainManifold();
        if (job !== topMonoWant) return;
        if (!topMonoSolid || topMonoSolid.t !== t) {
          if (topMonoSolid && topMonoSolid.m) topMonoSolid.m.delete();
          const mesh = topMonoMesh(t);
          const build = (V, T) => { try { const mm = new mf.Mesh({ numProp: 3, vertProperties: V, triVerts: T }); mm.merge(); return new mf.Manifold(mm); } catch (_) { return null; } };
          // The solid as it was built. (Not the export's welded copy: welding joins faces that only touch along an
          // edge, which Manifold then refuses as not a solid, at some circle precisions and not others; that copy
          // is only the stand-in for a model that came without its solid.)
          const m = (meshSolid && build(meshSolid.V, meshSolid.T)) || build(mesh.V, mesh.T);
          topMonoSolid = { t, m, seg: mesh.seg, ix: m ? coverIndex(mesh.V, mesh.T) : null };
        }
        const S = topMonoSolid;
        if (S.m && S.ix) {
          const tmp = [], f = (v) => v.toFixed(5);
          let m = S.m;
          if (isFinite(lo)) { m = m.trimByPlane([0, 0, 1], lo); tmp.push(m); }
          if (isFinite(hi)) { m = m.trimByPlane([0, 0, -1], -hi); tmp.push(m); }
          const cs = m.project(), polys = cs.toPolygons();
          cs.delete(); for (const x of tmp) x.delete();
          // (no slivers: where faces just touch, Manifold leaves loops with no area)
          const xy = (P) => P.map(p => Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y]);
          const area = (L) => { let a = 0; for (let i = 0; i < L.length; i++) { const A = L[i], B = L[(i + 1) % L.length]; a += A[0] * B[1] - B[0] * A[1]; } return Math.abs(a) / 2; };
          const tiny = (S.ix.span * 2e-3) ** 2, real = (L) => L.length > 2 && area(L) > tiny;
          const path = (L) => 'M' + L.map(p => f(p[0]) + ' ' + f(p[1])).join('L') + 'Z';
          const dd = polys.map(xy).filter(real).map(path).join('');
          // the sharp edges, cut to the band; only what can be seen from where the part is looked at: from above, or,
          // with the y axis inverted, from what is then its top (the scene's underside), down from that end of the band
          const seg3 = [], s = S.seg, dir = fl ? -1 : 1, lid = fl ? lo : hi;
          for (let k = 0; k < s.length; k += 6) {
            let ax = s[k], ay = s[k + 1], az = s[k + 2], bx = s[k + 3], by = s[k + 4], bz = s[k + 5];
            if (Math.max(az, bz) < lo - 1e-9 || Math.min(az, bz) > hi + 1e-9) continue;
            const cut = (z) => { const g = (z - az) / (bz - az); return [ax + (bx - ax) * g, ay + (by - ay) * g]; };
            if (az < lo && bz > lo || az > lo && bz < lo) { const [x, y] = cut(lo); if (az < lo) { ax = x; ay = y; az = lo; } else { bx = x; by = y; bz = lo; } }
            if (az > hi && bz < hi || az < hi && bz > hi) { const [x, y] = cut(hi); if (az > hi) { ax = x; ay = y; az = hi; } else { bx = x; by = y; bz = hi; } }
            seg3.push(ax, ay, az, bx, by, bz);
          }
          let ln = visiblePath(S.ix, seg3, lid, dir, f, lo, hi);
          // where the band's end on the viewer's side cuts through material: the cut's own edges (on top, so seen)
          // (taken just inside the band, so that something starting exactly at that end is not outlined)
          if (isFinite(lid)) { const sl = S.m.slice(lid - dir * S.ix.eps); ln += sl.toPolygons().map(xy).filter(real).map(path).join(''); sl.delete(); }
          res = { dd, ln };
        }
      } catch (e) { res = null; }
      if (job !== topMonoWant) return;
      topMonoWant = null;
      topMonoCache = { t, lo, hi, fl, res };
      if (topMode() && monoOn()) drawSection();
    }

    // ---- the part seen from above: x across, y up (the plane the part turns in) ----
    const topMode = () => state.secMode === 'top';
    let lastTop = [];
    // the part's middle height: the overhead view's centre sits on it in the side view
    function partZMid() {
      let z0 = Infinity, z1 = -Infinity;
      if (state.scene) for (const id of leafOrder(state.scene)) for (const p of viewOutline(state.scene, id)) { z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
      return isFinite(z0) ? (z0 + z1) / 2 : 0;
    }
    // the other view, lined up with this one
    // radius/height → above: the radius stays where it was, and the section line (the x axis from above) lands where the
    // height the view from above looks down from (the top of its height band) was on the screen.
    // above → radius/height: back at the height the radius/height view had (or the part's middle height, if none yet).
    // the height the view from above looks down from: the top of its band (flipped: what is on top)
    function lookFromZ() {
      const r = sceneZRange(), band = topBand(), up = state.flip ? 0 : 1;
      return band ? (up ? band.hi : band.lo) : r ? r[up] : partZMid();
    }
    // the band's two heights (all of it when it is not narrowed), or null
    function bandZs() {
      const b = topBand(); if (b) return [b.lo, b.hi];
      const r = sceneZRange(); return r ? [r[0], r[1]] : null;
    }
    // (when that height is off the screen, the section line goes to the middle instead)
    const onScreen = (y) => y >= 0 && y <= size().h - AX_B;
    const LINK = () => state.linkViews !== false;
    // where each view was left (not linked: it comes back just so; linked: the radius/height view's height does)
    const ownViews = { section: null, top: null };
    const otherView = (v, toTop) => {
      if (!v) return v;
      if (!LINK()) {
        const o = ownViews[toTop ? 'top' : 'section'];
        return o ? { ...o } : toTop ? null : { cy: v.cy, cz: FZ() * partZMid(), s: v.s, fit: v.fit };
      }
      let cz;
      if (toTop) { cz = v.cz - FZ() * lookFromZ(); if (!onScreen(size().h / 2 + cz * v.s)) cz = 0; }
      else cz = ownViews.section ? ownViews.section.cz : v.cz + FZ() * partZMid();
      return { cy: v.cy, cz, s: v.s, fit: v.fit };
    };
    function setSecMode(m) {
      if (topMode() === (m === 'top')) return;
      const toTop = m === 'top';
      zoomAnim = null;
      const before = view;
      if (view) ownViews[toTop ? 'section' : 'top'] = { ...view };
      view = otherView(view, toTop);
      state.secMode = toTop ? 'top' : 'section'; saveSettings();
      if (!view) fit();
      drag = null; hoverNode = null; hoverEdge = null; cursorW = null; hoverTopH = null;
      // the old view tips away as the new one tips in (side → top: as if looking down onto the part; and back)
      const ghost = !reduceMotion() && svg.isConnected ? svg.cloneNode(true) : null;
      if (ghost) {
        const shot = document.createElement('canvas');
        shot.width = wrapCanvas.width; shot.height = wrapCanvas.height;
        try { shot.getContext('2d').drawImage(wrapCanvas, 0, 0); } catch (_) { /* ignore */ }
        shot.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
        ghost.style.position = 'absolute'; ghost.style.inset = '0';
        // the radius/height view turns about a level line through the middle of the pane
        const pv = '50% 50%';
        // linked views: the radius/height view turns about the height the view from above looks down from (the top of
        // its height band), and the view from above about its own x axis (the section line), so the two meet there.
        // (not linked: both turn about the middle of the pane.)
        let pSide = pv, pTop = pv;
        if (LINK()) {
          const sideV = toTop ? before : view, topV = toTop ? view : before, zTop = lookFromZ(), H = size().h;
          // (a line off the screen: about the middle instead)
          const yS = sideV && zTop != null ? H / 2 - (FZ() * zTop - sideV.cz) * sideV.s : NaN, yT = topV ? H / 2 + topV.cz * topV.s : NaN;
          if (onScreen(yS)) pSide = '50% ' + yS.toFixed(1) + 'px';
          if (onScreen(yT)) pTop = '50% ' + yT.toFixed(1) + 'px';
        }
        const box = el('div', { style: 'position:absolute;inset:0;pointer-events:none;background:#fbfbfc;transform-origin:' + (toTop ? pSide : pTop) }, shot, ghost);
        for (const n of [svg, wrapCanvas]) n.style.transformOrigin = toTop ? pTop : pSide;
        left.insertBefore(box, overlay);
        const down = state.secMode !== 'top', ms = 380, ease = 'cubic-bezier(.45,0,.2,1)';
        box.animate([{ transform: 'perspective(1400px) rotateX(0deg)', opacity: 1 }, { transform: 'perspective(1400px) rotateX(' + (down ? 70 : -70) + 'deg)', opacity: 0 }], { duration: ms, easing: ease, fill: 'forwards' })
          .onfinish = () => box.remove();
        for (const n of [svg, wrapCanvas])
          n.animate([{ transform: 'perspective(1400px) rotateX(' + (down ? -70 : 70) + 'deg)', opacity: 0 }, { transform: 'perspective(1400px) rotateX(0deg)', opacity: 1 }], { duration: ms, easing: ease });
      }
      syncModeBtns(); drawSection();
    }
    function syncModeBtns() {
      if (typeof pinBtn !== 'undefined') pinBtn.style.display = state.measure ? 'inline-flex' : 'none';
      // (the readout under the view's buttons, however many rows they take)
      if (viewBar.isConnected && viewBar.offsetHeight) coord.style.top = (viewBar.offsetTop + viewBar.offsetHeight + 4) + 'px';
      for (const b of [...modeBar.children, monoBtn, measureBtn, perfectBtn]) { const on = b === monoBtn ? monoOn() : b === measureBtn ? !!state.measure : b === perfectBtn ? !!state.measurePerfect : (b.__mode === 'top') === topMode(); b.style.background = on ? '#ddf4ff' : '#fff'; b.style.borderColor = on ? '#54aeff' : '#ced4da'; }
    }
    // where new objects go: the cross-section's view, whichever is showing
    const secView = () => topMode() ? otherView(view, false) : view;
    // where new objects go: the middle of the cross-section, in the scene's own heights
    const addView = () => { const v = secView(); return v && { ...v, cz: FZ() * v.cz }; };
    // an object from above in its own frame: outer edge, bore, and dashed details (pitch circle, thread roots)
    // the outline cut to the heights a ≤ z ≤ b (Sutherland–Hodgman)
    function clipZ(poly, a, b) {
      const cut = (P, inside, z) => {
        const out = [];
        for (let i = 0; i < P.length; i++) {
          const A = P[i], B = P[(i + 1) % P.length], ia = inside(A), ib = inside(B);
          if (ia) out.push(A);
          if (ia !== ib) { const t = (z - A.z) / (B.z - A.z); out.push({ y: A.y + (B.y - A.y) * t, z }); }
        }
        return out;
      };
      let P = cut(poly, (p) => p.z >= a, a);
      if (P.length) P = cut(P, (p) => p.z <= b, b);
      return P;
    }
    // the heights shown from above (scene units), or null for all of them
    function topBand() {
      const c = state.topCut || { lo: 0, hi: 1 };
      if (!(c.lo > 0.001) && !(c.hi < 0.999)) return null;
      const r = sceneZRange();
      return r ? { lo: r[0] + (r[1] - r[0]) * Math.max(0, c.lo), hi: r[0] + (r[1] - r[0]) * Math.min(1, c.hi) } : null;
    }
    function sceneZRange() {
      let z0 = Infinity, z1 = -Infinity;
      if (state.scene) for (const id of leafOrder(state.scene)) for (const p of viewOutline(state.scene, id)) { z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
      return isFinite(z0) && z1 > z0 ? [z0, z1] : null;
    }
    function topLocal(n, band) {
      const full = outlineOf(n.pts, n.runs);
      if (full.length < 3) return null;
      // from above, only what lies in the band of heights (band: in the object's own heights)
      const o = band ? clipZ(full, band.lo, band.hi) : full;
      if (o.length < 3) return null;
      let r0 = Infinity, r1 = 0;
      for (const p of o) { r0 = Math.min(r0, p.y); r1 = Math.max(r1, p.y); }
      const ring = (r, k = 120) => { const a = []; for (let i = 0; i < k; i++) { const t = 2 * Math.PI * i / k; a.push([r * Math.cos(t), r * Math.sin(t)]); } return a; };
      const S = { outer: null, inner: null, marks: [], outline: o, r0, r1 };
      if (n.type === 'cog') {
        const sh = cogShapeOf(n.params, n.precision), teeth = (rr, fix) => Array.from(sh.ang, (a, j) => { const r = cogWarp(rr, sh.rad[j], fix, sh.tip); return [r * Math.cos(a), r * Math.sin(a)]; });
        S.marks.push(ring(sh.rp));
        const fix = cogFix(n.params, full);       // the round edge of the whole cog, which the teeth are measured from
        if (sh.internal) { S.outer = ring(r1); S.inner = teeth(r0, fix); return S; }
        S.outer = teeth(r1, fix);
      } else if (n.type === 'ngon') {
        const q = n.params, k = Math.max(3, q.sides | 0), sc = q.about === 'faces' ? 1 / Math.cos(Math.PI / k) : 1, ph = (q.rotation || 0) * Math.PI / 180;
        const poly = (r) => { const a = []; for (let i = 0; i < k; i++) { const t = ph + 2 * Math.PI * i / k; a.push([r * sc * Math.cos(t), r * sc * Math.sin(t)]); } return a; };
        S.outer = poly(r1); if (r0 > 1e-9) S.inner = poly(r0);
        return S;
      } else {
        S.outer = ring(r1);
        for (const r of n.runs || []) for (const rr of [r.rFirst, r.rOther]) if (rr > r0 + 1e-9 && rr < r1 - 1e-9) S.marks.push(ring(rr));
      }
      if (r0 > 1e-9) S.inner = ring(r0);
      return S;
    }
    // ... placed in the scene: every copy of the radial cloners it is in
    function topShapes(id) {
      const sc = state.scene, band = topBand();
      if (sc.nodes[id].type === 'geo') {
        // a geometric object: each copy's outline from above (one lying on its side: what it covers), where it has
        // anything in the band of heights
        const gw = geoWorld(sc, id); if (!gw) return [];
        return gw.foot.filter(f => !band || (f.zr[1] >= band.lo - 1e-9 && f.zr[0] <= band.hi + 1e-9)).map(f => ({ outer: f.poly, inner: null, marks: [] }));
      }
      const P0 = band ? topPlace(sc, id) : null;
      // the band in the object's own heights (an object on its side is shown whole)
      const dz = band && !P0.side ? xfOf(sc, id).fwd({ y: 1, z: 0 }).z : 0;
      const L = topLocal(sc.nodes[id], band && !P0.side ? { lo: band.lo - dz, hi: band.hi - dz } : null);
      if (!L) return [];
      let shapes = [{ outer: L.outer, inner: L.inner, marks: L.marks }], first = true;
      for (let cur = id, guard = 0; guard < 64; guard++) {
        const p = findParent(sc, cur);
        if (!p || p.parent === null) break;
        const c = sc.nodes[p.parent]; cur = p.parent;
        if (c.type !== 'cloner') continue;
        const q = c.params, cnt = Math.max(1, q.count | 0), R = q.radius || 0, spread = q.spread == null ? 360 : q.spread;
        const step = spread >= 360 - 1e-9 ? 360 / cnt : (cnt > 1 ? spread / (cnt - 1) : 0);
        if (q.orient === 'radial' && first) {
          // lying on its side, its axis along the copies' radius: from above, its length by its full width
          let z0 = Infinity, z1 = -Infinity;
          for (const v of L.outline) { z0 = Math.min(z0, v.z); z1 = Math.max(z1, v.z); }
          shapes = [{ outer: [[z0, -L.r1], [z1, -L.r1], [z1, L.r1], [z0, L.r1]], inner: null, marks: [L.outline.map(v => [v.z, v.y]), L.outline.map(v => [v.z, -v.y])] }];
        }
        first = false;
        const out = [];
        for (let k = 0; k < cnt; k++) {
          const a = ((q.angle || 0) + k * step) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
          const f = q.keepOrient ? (v) => [v[0] + R * ca, v[1] + R * sa] : (v) => { const x = v[0] + R, y = v[1]; return [x * ca - y * sa, x * sa + y * ca]; };
          for (const s of shapes) out.push({ outer: s.outer.map(f), inner: s.inner && s.inner.map(f), marks: s.marks.map(m => m.map(f)) });
        }
        shapes = out;
      }
      return shapes;
    }
    const inPoly2 = (x, y, P) => {
      let c = false;
      for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
        const [xi, yi] = P[i], [xj, yj] = P[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    // an edge of a geometric object under the pointer (screen), as { id, i, W: the nearest place on it }
    function geoEdgeAt(sx, sy) {
      const sc = state.scene;
      for (let k = lastTop.length - 1; k >= 0; k--) {
        const id = lastTop[k].id, n = sc.nodes[id];
        if (n.type !== 'geo' || monoHid(id) || geoTilted(n.params) || !canPick(id)) continue;
        const P = topPlace(sc, id); if (P.side) continue;
        const C = geoCorners(n, true).map(([x, y]) => P.w(x, y));
        for (let i = 0; i < C.length; i++) {
          const a = C[i], b = C[(i + 1) % C.length], [ax, ay] = toScreen(a[0], a[1]), [bx, by] = toScreen(b[0], b[1]);
          const L2 = (bx - ax) ** 2 + (by - ay) ** 2, t = L2 ? Math.max(0, Math.min(1, ((sx - ax) * (bx - ax) + (sy - ay) * (by - ay)) / L2)) : 0;
          if (Math.hypot(sx - ax - (bx - ax) * t, sy - ay - (by - ay) * t) < 6) return { id, i, P, W: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] };
        }
      }
      return null;
    }
    function topNodeAt(x, y) {
      // (what is selected first: so a selected object can be grabbed where others overlap it)
      for (let i = lastTop.length - 1; i >= 0; i--) if (selectedAncestorOf(lastTop[i].id) && canPick(lastTop[i].id)) for (const s of lastTop[i].shapes) if (inPoly2(x, y, s.outer) && !(s.inner && inPoly2(x, y, s.inner))) return lastTop[i].id;
      for (let i = lastTop.length - 1; i >= 0; i--) if (canPick(lastTop[i].id)) for (const s of lastTop[i].shapes) if (inPoly2(x, y, s.outer) && !(s.inner && inPoly2(x, y, s.inner))) return lastTop[i].id;
      return null;
    }
    function topItems() {
      const rank = { positive: 0, intersect: 1, negative: 2 };
      return frontOrder().map(id => ({ id, role: roleOf(state.scene, id), shapes: topShapes(id) })).sort((a, b) => rank[a.role] - rank[b.role]);
    }
    function fitTop() {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      const t = state.viewAngle * Math.PI / 180, c = Math.cos(t), sn = Math.sin(t);
      for (const it of topItems()) for (const s of it.shapes) for (const [x0w, y0w] of s.outer) {
        const x = x0w * c + y0w * sn, y = FZ() * (-x0w * sn + y0w * c);
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      if (!isFinite(x0)) { x0 = y0 = -1; x1 = y1 = 1; }
      const { w, h } = size();
      view = { cy: (x0 + x1) / 2, cz: (y0 + y1) / 2, s: Math.min((w - AX_L) / ((x1 - x0) * 1.2 || 1), (h - AX_B) / ((y1 - y0) * 1.2 || 1)) };
      view.cy -= AX_L / 2 / view.s; view.cz -= AX_B / 2 / view.s;     // centred in the space between the axis strips
      fitScale = view.s; view.fit = view.s; fitScales[topMode() ? 'top' : 'section'] = view.s;
    }
    function drawTop(g) {
      grid(g, 0, true);
      const P = (v) => toScreen(v[0], v[1]).map(c => c.toFixed(1)).join(' ');
      const pd = (pts) => pts.length ? 'M' + pts.map(P).join('L') + 'Z' : '';
      lastTop = topItems(); lastPolys = { 1: {}, '-1': {} };
      let reach = 0;
      const monoG = sv('g', { 'pointer-events': 'none' }), monoPos = [], monoNeg = [];
      g.append(monoG);
      for (const it of lastTop) {
        const n = state.scene.nodes[it.id], col = COLORS[n.type] || '#1f6feb', selected = selectedAncestorOf(it.id);
        const d = it.shapes.map(s => pd(s.outer) + (s.inner ? pd(s.inner) : '')).join('');
        if (monoHid(it.id)) {
          (it.role === 'negative' ? monoNeg : monoPos).push(d);
          for (const s of it.shapes) for (const [x, y] of s.outer) reach = Math.max(reach, Math.hypot(x, y));
          lastPolys[1][it.id] = { d, col };
          continue;
        }
        const fill = it.role === 'negative' ? 'url(#aa-hatch)' : col + (it.role === 'intersect' ? '18' : '26');
        g.append(sv('path', { d, fill, 'fill-rule': 'evenodd', stroke: it.role === 'negative' ? '#e03131' : col, 'stroke-width': selected ? 2.8 : 1.4,
          'stroke-dasharray': it.role === 'negative' ? '6 3' : 'none', 'stroke-linejoin': 'round' }));
        for (const s of it.shapes) {
          for (const m of s.marks) g.append(sv('path', { d: pd(m), fill: 'none', stroke: col, 'stroke-width': 0.8, 'stroke-dasharray': '3 3', opacity: 0.7, 'pointer-events': 'none' }));
          for (const [x, y] of s.outer) reach = Math.max(reach, Math.hypot(x, y));
        }
        lastPolys[1][it.id] = { d, col };
      }
      const exactTop = monoPos.length + monoNeg.length ? topMono(topBand()) : null;
      if (exactTop) {
        // world → screen is a turn, a scale and a shift: one transform for the whole drawing
        const [x0, y0] = toScreen(0, 0), [x1, y1] = toScreen(1, 0), [x2, y2] = toScreen(0, 1);
        const gT = sv('g', { transform: 'matrix(' + [x1 - x0, y1 - y0, x2 - x0, y2 - y0, x0, y0].map(v => +v.toFixed(6)).join(' ') + ')' });
        const { dd, ln } = exactTop;
        if (dd) {
          gT.append(sv('path', { d: dd, fill: 'none', stroke: '#868e96', 'stroke-width': 2.4, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }));
          gT.append(sv('path', { d: dd, fill: '#dee2e6', 'fill-rule': 'evenodd', stroke: 'none' }));
        }
        if (ln) gT.append(sv('path', { d: ln, fill: 'none', stroke: '#868e96', 'stroke-width': 1, 'stroke-linecap': 'round', opacity: 0.8, 'vector-effect': 'non-scaling-stroke' }));
        monoG.append(gT);
      } else drawMono(monoG, monoPos, monoNeg, 't');
      // the axis, and the plane the cross-section is cut in: its right half solid, the mirrored left half dashed
      const { w, h } = size(), [ox, oy] = toScreen(0, 0), th = state.viewAngle * Math.PI / 180, far = Math.hypot(w, h) / view.s + Math.hypot(view.cy, view.cz);
      const [ex, ey] = toScreen(far * Math.cos(th), far * Math.sin(th)), [bx, by] = toScreen(-far * Math.cos(th), -far * Math.sin(th));
      g.append(sv('line', { x1: ox, y1: oy, x2: bx, y2: by, stroke: '#1f6feb', 'stroke-width': 1, 'stroke-dasharray': '6 4', opacity: 0.6, 'pointer-events': 'none' }));
      g.append(sv('line', { x1: ox, y1: oy, x2: ex, y2: ey, stroke: '#1f6feb', 'stroke-width': 1.5, 'pointer-events': 'none' }));
      g.append(sv('path', { d: 'M' + (ox - 6) + ' ' + oy + 'h12M' + ox + ' ' + (oy - 6) + 'v12', stroke: '#495057', 'stroke-width': 1.2, 'pointer-events': 'none' }));
      const hit = sv('line', { x1: ox, y1: oy, x2: ex, y2: ey, stroke: 'transparent', 'stroke-width': 10, style: 'cursor:grab' });
      hit.__secLine = true; g.append(hit);
      const rh = Math.min(reach > 0 ? reach * 1.08 : 1, (Math.min(w, h) * 0.45) / view.s), [hx, hy] = toScreen(rh * Math.cos(th), rh * Math.sin(th));
      const knob = sv('circle', { cx: hx.toFixed(1), cy: hy.toFixed(1), r: 6, fill: '#1f6feb', stroke: '#fff', 'stroke-width': 1.5, style: 'cursor:grab' });
      knob.__secLine = true;
      const tip = sv('title'); tip.textContent = 'Section angle: drag to turn'; knob.append(tip); hit.append(tip.cloneNode(true));
      g.append(knob);
      if (state.linkSlicers) {
        // linked slicers: the radius/height view is cut along this line (where the blue slicer is); its handle slides it
        const offT = sliceOff(), nx = -Math.sin(th), ny = Math.cos(th), cs = Math.cos(th), sn = Math.sin(th);
        const at = (a) => toScreen(nx * offT + cs * a, ny * offT + sn * a), [lx0, ly0] = at(-far), [lx1, ly1] = at(far), [kx, ky] = at(-rh);
        if (offT) g.append(sv('line', { x1: lx0, y1: ly0, x2: lx1, y2: ly1, stroke: '#1c7ed6', 'stroke-width': 1.5, 'pointer-events': 'none' }));
        const sk = sv('rect', { x: (kx - 6).toFixed(1), y: (ky - 6).toFixed(1), width: 12, height: 12, rx: 2, fill: '#4dabf7', stroke: '#fff', 'stroke-width': 1.5, style: 'cursor:ns-resize' });
        sk.__sliceKnob = true;
        const st = sv('title'); st.textContent = 'Where the radius/height view is cut (the blue slicer): drag across to move it; it snaps to the axis (Alt: freely)'; sk.append(st);
        g.append(sk);
      }
      label(g, hx + 10, hy - 8, ['section ' + num(state.viewAngle * ANG_SCALE, ANG_SCALE === 1 ? 1 : 4) + ANG_LABEL]);
      // selected edges of geometric objects
      for (const k of state.sel) {
        const hq = parseKey(k); if (hq.kind !== 'qe') continue;
        const n = state.scene.nodes[hq.node]; if (!n || !n.shape || geoTilted(n.params)) continue;
        const P = topPlace(state.scene, hq.node), C = geoCorners(n, true), a = P.w(...C[hq.i]), b = P.w(...C[(hq.i + 1) % C.length]);
        const [x1, y1] = toScreen(a[0], a[1]), [x2, y2] = toScreen(b[0], b[1]);
        g.append(sv('line', { x1, y1, x2, y2, stroke: '#e03131', 'stroke-width': 3.5, 'stroke-linecap': 'round', 'pointer-events': 'none' }));
      }
      // handles: drag them to edit from above
      for (const hd of topHandles()) {
        const [x, y] = toScreen(hd.x, hd.y), on = (drag && drag.h && drag.h.key === hd.key) || (hd.pkey && state.sel.has(hd.pkey));
        const shape = hd.shape === 'diamond' ? sv('path', { d: 'M' + x.toFixed(1) + ' ' + (y - 6).toFixed(1) + 'l6 6l-6 6l-6-6z' })
          : sv('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: hd.shape === 'ring' ? 5 : 4.5 });
        shape.setAttribute('fill', on ? '#e03131' : hd.shape === 'ring' ? '#fff' : hd.col);
        shape.setAttribute('stroke', hd.shape === 'ring' ? hd.col : hd.bevel ? '#fab005' : '#fff'); shape.setAttribute('stroke-width', hd.shape === 'ring' || hd.bevel ? 2.2 : 1.4);
        shape.setAttribute('style', 'cursor:' + (hd.kind === 'radius' || hd.kind === 'cog' || hd.kind === 'thr' ? 'ew-resize' : 'move'));
        if (hd.kind === 'width') shape.setAttribute('stroke', '#fff');
        shape.__topH = hd;
        const tip = sv('title'); tip.textContent = hd.tip; shape.append(tip);
        svg.append(shape);
      }
      if (drag && drag.snapShow) {
        const S = drag.snapShow, P2 = (v) => toScreen(v[0], v[1]);
        if (S.circle) { const [cx, cy] = P2(S.circle.C); svg.append(sv('circle', { cx, cy, r: S.circle.r * view.s, fill: 'none', stroke: 'rgba(240,140,0,.75)', 'stroke-width': 1.2, 'stroke-dasharray': '5 4', 'pointer-events': 'none' })); }
        for (const [a, b] of S.lines || []) { const [x1, y1] = P2(a), [x2, y2] = P2(b); svg.append(sv('line', { x1, y1, x2, y2, stroke: 'rgba(240,140,0,.7)', 'stroke-width': 1, 'stroke-dasharray': '5 4', 'pointer-events': 'none' })); }
        if (S.mark) { const [x, y] = P2(S.mark); svg.append(sv('rect', { x: x - 6, y: y - 6, width: 12, height: 12, fill: 'none', stroke: '#f08c00', 'stroke-width': 1.5, 'pointer-events': 'none' })); }
      }
      if (drag && drag.label && drag.labelAt) {
        const wpx = drag.label.length * 5.6 + 8, lx = drag.labelAt[0] + 12 + wpx > size().w ? drag.labelAt[0] - wpx - 12 : drag.labelAt[0] + 12;
        label(svg, lx, drag.labelAt[1] - 14, [drag.label], { border: '#ffc078', bg: 'rgba(255,249,219,.95)' });
      }
    }
    // Where an object sits from above: its first copy in the radial cloners around it, as a turn a and a centre C
    // (world = rot(a)·own + C). side: the innermost cloner lays it on its side, so from above its outline is seen
    // edge on, as (height along the copies' radius, ± radius across).
    function topPlace(sc, id) { return placeOf(sc, id); }
    // Handles from above:
    //  · an object lying on its side (in a radial cloner): every point of its outline, as in the cross-section (drag,
    //    select, right-click for bevels);
    //  · otherwise each radius of its outline (those points move in or out together) on the section's direction, and
    //    for the selected object a quarter turn apart all round; an n-sided object's corners (drag: size and turn);
    //  · a cog's teeth (tip, pitch circle, root) and a ring to turn it;
    //  · a radial cloner's first copy (distance from the axis and angle).
    function topHandles(all = false) {
      const sc = state.scene, out = [], th = state.viewAngle * Math.PI / 180, pad = 9 / view.s;
      for (const it of lastTop) {
        if (!all && (monoHid(it.id) || !canPick(it.id))) continue;      // (no handles on the monomorphic shape or what is locked; still something to snap to)
        const n = sc.nodes[it.id], col = COLORS[n.type] || '#1f6feb', name = n.name || n.id, P = topPlace(sc, it.id), q = n.params || {};
        if (n.type === 'geo') {
          // its corners, its centre, and (selected) the middles of its edges, to add a corner
          if (P.side) continue;
          {
            // the rotation handle: beside the centre, along its own x (drag round the centre; Ctrl snaps to 15°)
            const a = (q.rz || 0) * Math.PI / 180 + P.a, rr = 22 / view.s, [x, y] = P.w(q.cx, q.cy);
            out.push({ key: it.id + '|gr', id: it.id, kind: 'grot', P, x: x + rr * Math.cos(a), y: y + rr * Math.sin(a), cx: x, cy: y, col: '#f08c00', shape: 'ring',
              tip: name + ': turn it about the height axis (now ' + num((q.rz || 0) * ANG_SCALE, 3) + ANG_LABEL + '); Ctrl snaps to 15°' });
          }
          if (geoTilted(q)) {
            const [x, y] = P.w(q.cx, q.cy); out.push({ key: it.id + '|gc', id: it.id, kind: 'gcen', P, x, y, col, shape: 'diamond', tip: name + ': centre — drag to move the shape (its corners are edited with no tilt)' });
            continue;
          }
          const C = geoCorners(n, true), sel = !!selectedAncestorOf(it.id) || [...state.sel].some(k => k.startsWith(it.id + '|q|'));
          C.forEach(([x0, y0], i) => {
            const [x, y] = P.w(x0, y0), key = it.id + '|q|' + i, bv = n.shape[i].bevel, bev = !!(bv && bv.r > 0);
            out.push({ key, pkey: key, id: it.id, kind: 'gpt', i, P, x, y, col, shape: 'dot', bevel: bev, tip: name + ': corner ' + (i + 1) + (bev ? ' (bevelled ' + num(mm(bv.r), 3) + ' ' + UNIT_LABEL + ')' : '') + ' — drag to move it (Ctrl snaps); right-click to bevel or delete it. Drag an edge to move it; right-click an edge to add corners.' });
          });
          { const [x, y] = P.w(q.cx, q.cy); out.push({ key: it.id + '|gc', id: it.id, kind: 'gcen', P, x, y, col, shape: 'diamond', tip: name + ': centre — drag to move the shape (Ctrl snaps the centre to points)' }); }
          void sel;
          continue;
        }
        if (P.side) {
          n.pts.forEach((p, i) => {
            if (inRunIndex(n, i)) return;
            const key = it.id + '|p|' + i, bev = !!(p.bevel && (p.bevel.r > 0 || p.bevel.trim > 0));
            for (const m of [1, -1]) {
              const [x, y] = P.w(p.z, m * p.y);
              out.push({ key: key + '|' + m, pkey: key, id: it.id, kind: 'pt', m, P, x, y, col, shape: 'dot', bevel: bev,
                tip: name + ': r ' + num(mm(p.y), 3) + ', y ' + num(mm(p.z), 3) + ' ' + UNIT_LABEL + (bev ? ' (bevelled)' : '') + ' — right-click for bevels' });
            }
          });
          continue;
        }
        const sel = !!selectedAncestorOf(it.id), dirs = sel ? [0, 1, 2, 3].map(k => th + k * Math.PI / 2) : [th];
        const at = (r, phi) => P.w(r * Math.cos(phi - P.a), r * Math.sin(phi - P.a));    // phi: world direction from the object's centre
        const cog = n.type === 'cog', ngon = n.type === 'ngon';
        if (ngon) {
          // corners of the outer and inner outline: drag to size and turn it
          const o = outlineOf(n.pts, []), k = Math.max(3, q.sides | 0), sv0 = q.about === 'faces' ? 1 / Math.cos(Math.PI / k) : 1;
          const rs = [...new Set(o.map(p => +p.y.toFixed(9)))].filter(r => r > 1e-9), shown = k <= 24 ? k : 1;
          for (const r of rs) for (let j = 0; j < shown; j++) {
            const loc = (q.rotation || 0) * Math.PI / 180 + 2 * Math.PI * j / k, [x, y] = P.w(r * sv0 * Math.cos(loc), r * sv0 * Math.sin(loc));
            const keys = n.pts.map((p, i) => Math.abs(p.y - r) < 1e-9 ? it.id + '|p|' + i : null).filter(Boolean);
            out.push({ key: it.id + '|v|' + r + '|' + j, id: it.id, kind: 'vtx', j, k, sv: sv0, r0: r, keys, P, x, y, col, shape: 'dot',
              tip: name + ': corner — drag out or in to size it, round to turn it' });
          }
          continue;
        }
        // radii (a cog keeps only its round edge here; its toothed edge has the tooth handles)
        const only = cog ? cogFix(q, outlineOf(n.pts, [])) : null, groups = new Map();
        n.pts.forEach((p, i) => {
          if (inRunIndex(n, i) || (only != null && Math.abs(p.y - only) > 1e-9)) return;
          const g = Math.round(p.y * 1e6);
          if (!groups.has(g)) groups.set(g, { r: p.y, keys: [] });
          groups.get(g).keys.push(it.id + '|p|' + i);
        });
        // a thread's crest and root: drag to change its diameter
        for (const [ri, r] of (n.runs || []).entries()) for (const [what, rr] of [['crest', Math.max(r.rFirst, r.rOther)], ['root', Math.min(r.rFirst, r.rOther)]])
          for (const phi of dirs) { const [x, y] = at(rr, phi); out.push({ key: it.id + '|t|' + ri + '|' + what + '|' + phi, id: it.id, kind: 'thr', ri, r0: rr, phi, P, x, y, col: '#d9480f', shape: 'dot', tip: name + ': thread ' + what + ' — drag in or out to change the diameter' }); }
        for (const [g, gr] of groups) for (const phi of dirs) {
          const [x, y] = at(gr.r, phi);
          out.push({ key: it.id + '|g|' + g + '|' + phi, id: it.id, kind: 'radius', keys: gr.keys, r0: gr.r, phi, P, x, y, col, shape: 'dot',
            tip: name + ': radius ' + num(mm(gr.r), 3) + ' ' + UNIT_LABEL + ' (' + gr.keys.length + ' point' + (gr.keys.length > 1 ? 's' : '') + ') — drag in or out' });
        }
        if (cog) {
          for (const ch of cogHandles(n)) for (const phi of dirs) { const [x, y] = at(ch.r, phi); out.push({ key: it.id + '|c|' + ch.what + '|' + phi, id: it.id, kind: 'cog', what: ch.what, phi, P, x, y, col: ch.col, shape: 'diamond', tip: name + ': ' + ch.tip }); }
          // rounding of the first tooth's corners: drag across the corner
          const shF = cogShapeOf(q, n.precision);
          for (const [what, key, lab] of [['tip', 'tipRound', 'tip rounding'], ['root', 'rootRound', 'root rounding']]) {
            const c = shF.corners && shF.corners[what];
            if (!c) continue;
            const r = q[key] || 0, d = Math.max(r * c.k, 7 / view.s), [x, y] = P.w(c.V[0] + c.u[0] * d, c.V[1] + c.u[1] * d);
            out.push({ key: it.id + '|f|' + what, id: it.id, kind: 'fillet', what, pkeyName: key, c, P, x, y, col: '#f08c00', shape: 'dot', bevel: true,
              tip: name + ': ' + lab + ' ' + num(mm(r), 3) + ' ' + UNIT_LABEL + ' — drag into the corner to round it' });
          }
          {
            // the first tooth's width: a handle on its side at the pitch circle (drag round to widen or narrow the teeth)
            const rp = q.module * q.teeth / 2, tw = q.toothWidth > 0 ? q.toothWidth : 0.5, psi = (Math.PI * q.module * tw - (q.backlash || 0)) / (2 * rp);
            const a = (q.rotation || 0) * Math.PI / 180 + psi, [x, y] = P.w(rp * Math.cos(a), rp * Math.sin(a));
            out.push({ key: it.id + '|w', id: it.id, kind: 'width', P, x, y, col: '#7048e8', shape: 'diamond', tip: name + ': tooth width ' + num(tw, 3) + ' × pitch — drag round the pitch circle' });
          }
          const sh = cogShapeOf(q, n.precision), loc = (q.rotation || 0) * Math.PI / 180, R = Math.max(sh.ra, sh.rf) + pad, [x, y] = P.w(R * Math.cos(loc), R * Math.sin(loc));
          out.push({ key: it.id + '|rot', id: it.id, kind: 'rot', P, x, y, col, shape: 'ring', tip: name + ': turn the teeth (rotation ' + num((q.rotation || 0) * ANG_SCALE, 3) + ANG_LABEL + ')' });
        }
      }
      for (const n of Object.values(sc.nodes)) {
        if (n.type !== 'cloner' || !findParent(sc, n.id)) continue;
        const P = topPlace(sc, n.id), q = n.params, a = (q.angle || 0) * Math.PI / 180, R = q.radius || 0, [x, y] = P.w(R * Math.cos(a), R * Math.sin(a));
        out.push({ key: n.id + '|clone', id: n.id, kind: 'clone', P, x, y, col: '#d9480f', shape: 'diamond',
          tip: (n.name || n.id) + ': the first copy — drag to set the copies\' distance from the axis and their angle' });
      }
      return out;
    }
    // what a handle from above works on, drawn over the view while the pointer is on it: the ring of that radius, the
    // n-sided outline through that corner, the edges at that point, or a radial cloner's copies
    function topHandleLinks(h) {
      const sc = state.scene, n = sc.nodes[h.id], out = [];
      if (!n) return out;
      const col = h.kind === 'clone' ? '#d9480f' : h.col || COLORS[n.type] || '#1f6feb', P = h.P;
      const line = (pts, closed, o = {}) => out.push(sv('path', { d: pts.length ? 'M' + pts.map(v => toScreen(v[0], v[1]).map(c => c.toFixed(1)).join(' ')).join('L') + (closed ? 'Z' : '') : '',
        fill: 'none', stroke: col, 'stroke-width': o.w || 3.5, 'stroke-opacity': o.op || 0.55, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-dasharray': o.dash || 'none' }));
      const ring = (r) => { const a = []; for (let i = 0; i < 120; i++) { const t = 2 * Math.PI * i / 120; a.push(P.w(r * Math.cos(t), r * Math.sin(t))); } return a; };
      if (h.kind === 'radius' || h.kind === 'thr') line(ring(h.r0), true);
      else if (h.kind === 'cog') {
        // the teeth's tips, pitch circle or roots
        const q = n.params, r = h.what === 'tip' ? cogTip(q) : h.what === 'root' ? cogRoot(q) : q.module * q.teeth / 2;
        line(ring(r), true, h.what === 'pitch' ? { dash: '6 4' } : {});
      } else if (h.kind === 'vtx') {
        const q = n.params, a0 = (q.rotation || 0) * Math.PI / 180, pts = [];
        for (let j = 0; j < h.k; j++) { const t = a0 + 2 * Math.PI * j / h.k; pts.push(P.w(h.r0 * h.sv * Math.cos(t), h.r0 * h.sv * Math.sin(t))); }
        line(pts, true);
      } else if (h.kind === 'pt') {
        const i = +h.pkey.split('|')[2], np = n.pts.length, at = (j) => { const p = n.pts[(j + np) % np]; return P.w(p.z, h.m * p.y); };
        line([at(i - 1), at(i), at(i + 1)], false);
      } else if (h.kind === 'rot' || h.kind === 'fillet' || h.kind === 'width') {
        const sh = cogShapeOf(n.params, n.precision), o = outlineOf(n.pts, []), fix = cogFix(n.params, o), rr = cogIn(n.params) ? Math.min(...o.map(p => p.y)) : Math.max(...o.map(p => p.y));
        line(Array.from(sh.ang, (a, j) => { const r = cogWarp(rr, sh.rad[j], fix, sh.tip); return P.w(r * Math.cos(a), r * Math.sin(a)); }), true);
      } else if (h.kind === 'clone') {
        for (const id of leavesUnder(sc, [h.id])) { const lp = lastPolys[1][id]; if (lp) out.push(sv('path', { d: lp.d, fill: col + '14', 'fill-rule': 'evenodd', stroke: col, 'stroke-width': 4, 'stroke-opacity': 0.4 })); }
      }
      return out;
    }
    // ---- Ctrl-snapping from above: to the other objects' points (corners, handles, edge middles, the axis), to their
    //      circles (the same radius round the same centre, touching them, or where the handle's line crosses them),
    //      and to lines level or upright with a point; the grid when nothing is near. ----
    function topSnapTargets(h) {
      const sc = state.scene, pts = [{ p: [0, 0] }], circles = [], moving = new Set();
      if (h.pkey) { if (state.sel.has(h.pkey)) for (const k of state.sel) moving.add(k); else moving.add(h.pkey); }
      const isPt = (k) => k === 'pt' || k === 'gpt';
      const own = (hd) => hd.id === h.id && (!isPt(h.kind) || !isPt(hd.kind) || moving.has(hd.pkey) || h.kind !== hd.kind);
      for (const hd of topHandles(true)) {
        if (own(hd) || hd.kind === 'rot' || hd.kind === 'fillet' || hd.kind === 'gmid') continue;
        pts.push({ p: [hd.x, hd.y] });
        const r = hd.kind === 'radius' || hd.kind === 'thr' ? hd.r0 : hd.kind === 'cog' ? Math.hypot(hd.x - hd.P.C[0], hd.y - hd.P.C[1]) : null;
        if (r != null && r > 1e-9 && !circles.some(c => Math.abs(c.r - r) < 1e-9 && Math.hypot(c.C[0] - hd.P.C[0], c.C[1] - hd.P.C[1]) < 1e-9)) circles.push({ C: hd.P.C, r });
        if (hd.kind === 'clone') pts.push({ p: [hd.x, hd.y] });
      }
      // middles of the edges of objects on their side, and of geometric objects
      for (const it of lastTop) {
        const n = sc.nodes[it.id], P = topPlace(sc, it.id);
        if (n.type === 'geo') {
          if (P.side || (h.id === it.id && h.kind !== 'gpt')) continue;
          const C = geoCorners(n, true);
          C.forEach((a, i) => {
            const j = (i + 1) % C.length, b = C[j];
            if (moving.has(it.id + '|q|' + i) || moving.has(it.id + '|q|' + j)) return;
            pts.push({ p: P.w((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), mid: true });
          });
          continue;
        }
        if (!P.side) continue;
        const np = n.pts.length;
        for (let i = 0; i < np; i++) {
          const a = n.pts[i], b = n.pts[(i + 1) % np];
          if (moving.has(it.id + '|p|' + i) || moving.has(it.id + '|p|' + ((i + 1) % np))) continue;
          for (const m of [1, -1]) pts.push({ p: P.w((a.z + b.z) / 2, m * (a.y + b.y) / 2), mid: true });
        }
      }
      // the slicer lines (across the view, in its turned frame): the section's line through the axis, and the blue
      // slicer's line when it is linked and off the axis
      const levels = [0]; { const o = state.linkSlicers ? sliceOff() : 0; if (o) levels.push(o); }
      return { pts, circles, levels };
    }
    const snapThr = () => 10 / view.s;
    // a length along a ray from C (direction u) near r: the best snap, or null
    function snapRadius(C, u, r, T) {
      const thr = snapThr();
      let best = null;
      const offer = (v, g) => { if (v > 0 && Math.abs(v - r) < thr && (!best || Math.abs(v - r) < Math.abs(best.r - r))) best = { r: v, ...g }; };
      for (const c of T.circles) {
        const dx = c.C[0] - C[0], dy = c.C[1] - C[1], d = Math.hypot(dx, dy);
        if (d < 1e-9) { offer(c.r, { circle: c }); continue; }
        for (const v of [d - c.r, d + c.r, c.r - d]) offer(v, { circle: c });          // touching it
        const b = dx * u[0] + dy * u[1], disc = b * b - (d * d - c.r * c.r);         // where the ray crosses it
        if (disc >= 0) for (const v of [b - Math.sqrt(disc), b + Math.sqrt(disc)]) offer(v, { circle: c, mark: [C[0] + u[0] * v, C[1] + u[1] * v] });
      }
      for (const t of T.pts) {
        const dx = t.p[0] - C[0], dy = t.p[1] - C[1], al = dx * u[0] + dy * u[1];
        offer(Math.hypot(dx, dy), { through: t.p });                                   // a circle through the point
        if (Math.abs(-dx * u[1] + dy * u[0]) < thr) offer(al, { mark: t.p });          // the point on the ray
      }
      return best;
    }
    // a point near p: the best snap { p, mark, lines }, or null (grid: with nothing near, across and up each onto the
    // grid, in the view's own (turned) frame, as it is drawn)
    function snapPoint2(p, T, grid) {
      const thr = snapThr();
      let best = null;
      for (const t of T.pts) { const d = Math.hypot(t.p[0] - p[0], t.p[1] - p[1]); if (d < thr && (!best || d < best.d)) best = { d, p: t.p }; }
      if (best) return { p: best.p, mark: best.p, lines: [] };
      // level or upright with a point (on screen)
      const th = state.viewAngle * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
      const F = (v) => [v[0] * c + v[1] * s, -v[0] * s + v[1] * c], Wd = (f) => [f[0] * c - f[1] * s, f[0] * s + f[1] * c];
      const fp = F(p);
      let bx = null, by = null;
      for (const t of T.pts) {
        const ft = F(t.p);
        if (Math.abs(ft[0] - fp[0]) < thr && (!bx || Math.abs(ft[0] - fp[0]) < Math.abs(bx[0] - fp[0]))) bx = ft;
        if (Math.abs(ft[1] - fp[1]) < thr && (!by || Math.abs(ft[1] - fp[1]) < Math.abs(by[1] - fp[1]))) by = ft;
      }
      for (const b of T.levels || []) if (Math.abs(b - fp[1]) < thr && (!by || Math.abs(b - fp[1]) < Math.abs(by[1] - fp[1]))) by = [fp[0], b];
      if (!bx && !by && !grid) return null;
      const g = (v) => grid ? Math.round(v / grid) * grid : v;
      const out = [bx ? bx[0] : g(fp[0]), by ? by[1] : g(fp[1])], lines = [];
      if (bx) lines.push([Wd(bx), Wd(out)]);
      if (by) lines.push([Wd(by), Wd(out)]);
      return { p: Wd(out), lines, mark: !bx && !by ? Wd(out) : undefined };
    }
    // drag a handle from above to (X, Y)
    function dragTopHandle(X, Y, snap, lock) {
      const h = drag.h, st = gridStep() / 2, rs = (v) => snap ? Math.round(v / st) * st : v;
      const P = h.P, rel = P.inv(X - P.C[0], Y - P.C[1]);          // the pointer in the object's own frame
      const along = (phi) => { const u = phi - P.a; return rel[0] * Math.cos(u) + rel[1] * Math.sin(u); };
      drag.snapShow = null; drag.offW = null; drag.rotText = null;
      // a radius along the handle's line: snapped to the others, or to the grid
      const radial = (r, phi) => {
        if (!snap) return Math.max(0, r);
        const u = [Math.cos(phi), Math.sin(phi)], s = snapRadius(P.C, u, r, drag.targets);
        if (s) { drag.snapShow = { circle: s.circle || (s.through ? { C: P.C, r: s.r } : null), mark: s.mark || s.through || [P.C[0] + u[0] * s.r, P.C[1] + u[1] * s.r], C: P.C, r: s.r }; return s.r; }
        return Math.max(0, rs(r));
      };
      state.scene = clone(drag.snap);
      const n = state.scene.nodes[h.id];
      if (!n) return;
      if (h.kind === 'grot') {
        // round its centre: the change of the pointer's direction from the centre
        const q = n.params, q0 = drag.snap.nodes[h.id].params, d0 = Math.atan2(drag.from[1] - h.cy, drag.from[0] - h.cx), d1 = Math.atan2(Y - h.cy, X - h.cx);
        let dd = ((d1 - d0) * 180 / Math.PI + 540) % 360 - 180;
        if (snap) { if (state.rotMode === 'relative') dd = snapAng(dd); else dd = snapAng((q0.rz || 0) + dd) - (q0.rz || 0); }
        q.rz = (((q0.rz || 0) + dd + 540) % 360) - 180;
        drag.rotText = state.rotMode === 'relative' ? 'turned ' + num(dd * ANG_SCALE, 3) + ANG_LABEL : 'rotation ' + num(q.rz * ANG_SCALE, 3) + ANG_LABEL + ' (Δ ' + num(dd * ANG_SCALE, 3) + ANG_LABEL + ')';
        return;
      }
      if (h.kind === 'gpt' || h.kind === 'gcen' || h.kind === 'gmid' || h.kind === 'gedge') {
        // a corner, the centre, or a new corner from an edge's middle: follows the pointer (Shift: across or up only;
        // Ctrl: onto points and middles)
        const W0 = [h.x, h.y];
        let Wt = [W0[0] + X - drag.from[0], W0[1] + Y - drag.from[1]];
        if (lock) { if (Math.abs(Wt[0] - W0[0]) > Math.abs(Wt[1] - W0[1])) Wt[1] = W0[1]; else Wt[0] = W0[0]; }
        if (snap) {
          // onto points, lines level or upright with them (the axis among them), or the grid; Shift keeps the lock
          const s = snapPoint2(Wt, drag.targets, gridStep() / 2);
          if (s) {
            if (lock) { if (Wt[1] === W0[1]) Wt = [s.p[0], W0[1]]; else Wt = [W0[0], s.p[1]]; } else Wt = s.p;
            drag.snapShow = { mark: s.mark, lines: s.lines };
          }
        }
        let dl = P.inv(Wt[0] - W0[0], Wt[1] - W0[1]);
        if (h.kind === 'gcen') { n.params.cx += dl[0]; n.params.cy += dl[1]; }
        else {
          { const a = -(n.params.rz || 0) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a); dl = [dl[0] * c - dl[1] * sn, dl[0] * sn + dl[1] * c]; }   // into its own (turned) frame
          let idx;
          if (h.kind === 'gmid') {
            const A = n.shape[h.i], B = n.shape[(h.i + 1) % n.shape.length];
            n.shape.splice(h.i + 1, 0, geoMidCorner(A, B, 0.5));
            idx = [h.i + 1]; state.sel = new Set([h.id + '|q|' + (h.i + 1)]);
          } else if (h.kind === 'gedge') idx = [h.i, (h.i + 1) % n.shape.length];
          else idx = state.sel.has(h.pkey) ? [...state.sel].filter(k => k.startsWith(h.id + '|q|')).map(k => +k.split('|')[2]) : [h.i];
          for (const i of idx) if (n.shape[i]) { n.shape[i].x += dl[0]; n.shape[i].y += dl[1]; }
          geoRecentre(n);
        }
        drag.offW = [W0, Wt];
        drag.label = (h.kind === 'gcen' ? 'centre' : h.kind === 'gedge' ? 'edge' : 'corner') + ' x ' + num(mm(Wt[0]), 3) + ' · y ' + num(mm(Wt[1]), 3) + ' ' + UNIT_LABEL;
        return;
      }
      if (h.kind === 'pt') {
        // a point of an object on its side: the move in its own frame (height along, radius across)
        const p0 = drag.snap.nodes[h.id].pts[+h.pkey.split('|')[2]], W0 = P.w(p0.z, h.m * p0.y);
        let Wt = [W0[0] + X - drag.from[0], W0[1] + Y - drag.from[1]], gridded = false;
        if (snap && !lock) { const s = snapPoint2(Wt, drag.targets); if (s) { Wt = s.p; drag.snapShow = { mark: s.mark, lines: s.lines }; } else gridded = true; }
        const d0 = P.inv(Wt[0] - W0[0], Wt[1] - W0[1]);
        let dz = d0[0], dy = h.m * d0[1];
        if (lock) { if (Math.abs(dz) > Math.abs(dy)) dy = 0; else dz = 0; }
        if ((snap && lock) || gridded) { dz = rs(p0.z + dz) - p0.z; dy = rs(p0.y + dy) - p0.y; }
        const keys = state.sel.has(h.pkey) ? [...state.sel].filter(k => parseKey(k).kind === 'p') : [h.pkey];
        moveKeys(state.scene, keys, dy, dz);
        const p = n.pts[+h.pkey.split('|')[2]];
        drag.label = 'r ' + num(mm(p.y), 3) + ' · y ' + num(mm(p.z), 3) + ' ' + UNIT_LABEL;
      } else if (h.kind === 'radius') {
        const r = radial(along(h.phi), h.phi);
        moveKeys(state.scene, h.keys, r - h.r0, 0);
        drag.offW = [[h.x, h.y], P.w(r * Math.cos(h.phi - P.a), r * Math.sin(h.phi - P.a))];
        drag.label = 'radius ' + num(mm(r), 3) + ' / Ø ' + num(mm(2 * r), 3) + ' ' + UNIT_LABEL;
      } else if (h.kind === 'thr') {
        // the whole thread in or out (its diameter), as dragging the object in the cross-section
        const r = radial(along(h.phi), h.phi);
        moveNode(n, r - h.r0, 0);
        drag.label = 'thread ' + (n.params && n.params.d ? 'Ø ' + num(mm(n.params.d), 3) : 'r ' + num(mm(r), 3)) + ' ' + UNIT_LABEL;
      } else if (h.kind === 'vtx') {
        const q = n.params, wa = Math.atan2(rel[1], rel[0]) + P.a, r = radial(Math.hypot(rel[0], rel[1]), wa) / h.sv;
        let rot = Math.atan2(rel[1], rel[0]) * 180 / Math.PI - 360 * h.j / h.k;
        if (snap) rot = Math.round(rot / 5) * 5;
        if (!lock || Math.abs(r - h.r0) * view.s < 4) q.rotation = ((rot % 360) + 540) % 360 - 180;
        if (!lock || Math.abs(r - h.r0) * view.s >= 4) moveKeys(state.scene, h.keys, r - h.r0, 0);
        drag.label = 'radius ' + num(mm(r), 3) + ' ' + UNIT_LABEL + ' · rotation ' + num(q.rotation * ANG_SCALE, ANG_SCALE === 1 ? 1 : 4) + ANG_LABEL;
      } else if (h.kind === 'cog') {
        drag.id = h.id; drag.what = h.what;
        const r0 = along(h.phi), r = snap ? radial(r0, h.phi) : r0;
        dragCog(Math.max(0, r), snap && !drag.snapShow);
      } else if (h.kind === 'fillet') {
        // how far into the corner, along its bisector, sets the rounding's radius
        const q = n.params, d = (rel[0] - h.c.V[0]) * h.c.u[0] + (rel[1] - h.c.V[1]) * h.c.u[1];
        let r = Math.max(0, d / h.c.k);
        if (d * view.s < 6) r = 0;
        if (snap) r = rs(r);
        q[h.pkeyName] = r;
        drag.label = (h.what === 'tip' ? 'tip' : 'root') + ' rounding ' + num(mm(r), 3) + ' ' + UNIT_LABEL;
      } else if (h.kind === 'width') {
        // how far round from the tooth's middle the pointer is, at the pitch circle: half the tooth's width
        const q = n.params, rp = q.module * q.teeth / 2, c0 = (q.rotation || 0) * Math.PI / 180;
        let d = Math.atan2(rel[1], rel[0]) - c0;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        let tw = (2 * Math.abs(d) * rp + (q.backlash || 0)) / (Math.PI * q.module);
        if (snap) tw = Math.round(tw / 0.05) * 0.05;
        q.toothWidth = Math.max(0.1, Math.min(0.9, tw));
        drag.label = 'tooth width ' + num(q.toothWidth, 3) + ' × pitch (' + num(mm(Math.PI * q.module * q.toothWidth), 3) + ' ' + UNIT_LABEL + ' at the pitch circle)';
      } else if (h.kind === 'rot') {
        const q = n.params, a = Math.atan2(rel[1], rel[0]) * 180 / Math.PI, f = P.inv(drag.from[0] - P.C[0], drag.from[1] - P.C[1]), a0 = Math.atan2(f[1], f[0]) * 180 / Math.PI;
        let rot = drag.snapRot + (a - a0);
        if (snap) rot = Math.round(rot / 5) * 5;
        q.rotation = ((rot % 360) + 540) % 360 - 180;
        drag.label = 'rotation ' + num(q.rotation * ANG_SCALE, ANG_SCALE === 1 ? 1 : 4) + ANG_LABEL;
      } else if (h.kind === 'clone') {
        const q = n.params, s = snap ? snapPoint2([X, Y], drag.targets) : null;
        if (s) { const r2 = P.inv(s.p[0] - P.C[0], s.p[1] - P.C[1]); rel[0] = r2[0]; rel[1] = r2[1]; drag.snapShow = { mark: s.mark, lines: s.lines }; snap = false; }
        let a = Math.atan2(rel[1], rel[0]) * 180 / Math.PI;
        if (snap) a = Math.round(a / 5) * 5;
        q.radius = Math.max(0, rs(Math.hypot(rel[0], rel[1]))); q.angle = ((a % 360) + 360) % 360;
        drag.label = 'distance ' + num(mm(q.radius), 3) + ' ' + UNIT_LABEL + ' · angle ' + num(q.angle * ANG_SCALE, ANG_SCALE === 1 ? 1 : 4) + ANG_LABEL;
      }
    }
    // where a cog's tooth handles sit: the tip, pitch and root radii, half way up its toothed edge
    function cogHandles(n) {
      const q = n.params, o = outlineOf(n.pts, []), z = (Math.min(...o.map(p => p.z)) + Math.max(...o.map(p => p.z))) / 2, rp = q.module * q.teeth / 2;
      return [
        { what: 'tip', r: cogTip(q), z, col: '#c2255c', tip: 'teeth tips — drag across to change the addendum' },
        { what: 'pitch', r: rp, z, col: '#495057', tip: 'pitch circle — drag across to change the module (the size of the teeth)' },
        { what: 'root', r: cogRoot(q), z, col: '#0c8599', tip: 'teeth roots — drag across to change the dedendum' }];
    }
    // drag a cog's tooth handle to radius r (in the object's own frame)
    function dragCog(r, snap) {
      const n = state.scene.nodes[drag.id], q = n.params, before = clone(q), N = q.teeth, m = q.module, inside = cogIn(q);
      const step = (v, s) => snap ? Math.round(v / s) * s : v;
      if (drag.what === 'pitch') q.module = Math.max(0.01 / MM, step(2 * r / N * UNIT_SCALE, UNIT_SCALE === 1 ? 0.005 : 0.05) / UNIT_SCALE);
      else if (drag.what === 'tip') q.addendum = Math.max(0, Math.min(3, step((inside ? N / 2 - r / m : r / m - N / 2), 0.05)));
      else q.dedendum = Math.max(0, Math.min(3, step((inside ? r / m - N / 2 : N / 2 - r / m), 0.05)));
      cogClamp(q);
      transferParams(n, before, q);
      drag.label = drag.what === 'pitch' ? 'module ' + num(mm(q.module), 3) + ' ' + UNIT_LABEL + ' · pitch Ø ' + num(mm(q.module * N), 3)
        : drag.what === 'tip' ? 'addendum ' + num(q.addendum, 3) + ' × module · tip Ø ' + num(mm(2 * cogTip(q)), 3)
        : 'dedendum ' + num(q.dedendum, 3) + ' × module · root Ø ' + num(mm(2 * cogRoot(q)), 3);
      drag.label += ' ' + UNIT_LABEL;
    }
    let seenSwaps = sceneSwaps;
    function drawSection() {
      ARC_PERFECT = !!(state.measure && state.measurePerfect);
      measure();
      if (seenSwaps !== sceneSwaps) { seenSwaps = sceneSwaps; view = null; ownViews.section = ownViews.top = null; }
      syncModeBtns(); syncTopBox();
      svg.textContent = '';
      if (!state.scene) return;
      if (!view) fit();
      const defs = sv('defs');
      const pat = sv('pattern', { id: 'aa-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
      pat.append(sv('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: 'rgba(224,49,49,.45)', 'stroke-width': 2 }));
      defs.append(pat); svg.append(defs);
      const g = sv('g'); svg.append(g);
      sceneBase = drag && drag.base != null ? drag.base : zBase();
      const MS0 = MS; MS = 1;
      if (topMode()) {
        drawWrap(); drawTop(g); for (const a of g.querySelectorAll('[data-axes]')) g.append(a); drawHover(); drawMeasures();
        zoomTag.textContent = (view.fit || fitScale) > 0 ? Math.round(view.s / (view.fit || fitScale) * 100) + '%' : '';
        if (state.measure) for (const [k, tb] of threadBoxes) { tb.box.remove(); threadBoxes.delete(k); }
        else syncThreadBoxes();
        renderSelBox();
        MS = MS0; return;
      }
      drawWrap();
      grid(g, sceneBase);
      // the heights the view from above will show (set with the slider at the right): guides only, nothing is cut
      // (drag a line to move it; Ctrl snaps it to points; dragged points snap to the lines with Ctrl)
      const bandS = topBand(), bz = LINK() ? bandZs() : null;
      if (bz) {
        const { w: wS } = size(), hot = drag && drag.type === 'bandline';
        if (bandS) {
          const [y0S, y1S] = [toScreen(0, bz[0])[1], toScreen(0, bz[1])[1]].sort((a, b) => a - b);
          g.append(sv('rect', { x: AX_L, y: y0S, width: Math.max(0, wS - AX_L), height: y1S - y0S, fill: '#12b886', opacity: 0.04, 'pointer-events': 'none' }));
        }
        bz.forEach((z, i) => {
          const yS = toScreen(0, z)[1], which = i ? 'hi' : 'lo', on = hot && drag.which === which;
          g.append(sv('line', { x1: AX_L, y1: yS, x2: wS, y2: yS, stroke: '#12b886', 'stroke-width': on ? 2 : 1, 'stroke-dasharray': '8 4', opacity: bandS || on ? 0.85 : 0.35, 'pointer-events': 'none' }));
          const grab = sv('line', { x1: AX_L, y1: yS, x2: wS, y2: yS, stroke: 'transparent', 'stroke-width': 9, style: 'cursor:ns-resize' });
          grab.__bandLine = which;
          grab.append(sv('title', null, (which === 'hi' ? 'Top' : 'Bottom') + ' of the heights the view from above shows: drag to move (Ctrl snaps to points; double-click to clear)'));
          g.append(grab);
        });
      }
      // Linked slicers with the blue one off the axis: the plane no longer holds the objects' outlines (those are
      // their shapes through the axis), so what is drawn is the finished part's own section there, from the 3D model:
      // threads, cogs, n-sided rings and subtractions are all as they really are at that place. To look at; the
      // objects are edited at the axis.
      // With Monomorphic off, the objects are drawn (and edited) as usual at the axis, with the part's section at the
      // blue slicer outlined under them.
      const off = sliceOff();
      if (off && !monoOn()) {
        const loops = meshSection(state.viewAngle * Math.PI / 180, off);
        if (loops && loops.length) {
          const dd = loops.map(L => 'M' + L.map(p => toScreen(p[0], p[1]).map(v => v.toFixed(1)).join(' ')).join('L') + 'Z').join('');
          g.append(sv('path', { d: dd, fill: '#1c7ed60d', 'fill-rule': 'evenodd', stroke: '#1c7ed6', 'stroke-width': 1.2, 'stroke-dasharray': '5 3', 'stroke-linejoin': 'round', 'pointer-events': 'none' }));
        }
      }
      if (off && monoOn()) {
        const loops = meshSection(state.viewAngle * Math.PI / 180, off);
        if (loops && loops.length) {
          const dd = loops.map(L => 'M' + L.map(p => toScreen(p[0], p[1]).map(v => v.toFixed(1)).join(' ')).join('L') + 'Z').join('');
          g.append(sv('path', { d: dd, fill: 'none', stroke: '#868e96', 'stroke-width': 2.4, 'stroke-linejoin': 'round', 'pointer-events': 'none' }));
          g.append(sv('path', { d: dd, fill: '#dee2e6', 'fill-rule': 'evenodd', stroke: '#868e96', 'stroke-width': 1.2, 'stroke-linejoin': 'round', 'pointer-events': 'none' }));
        }
        const note = sv('text', { x: AX_L + 8, y: 64, 'font-size': 11, fill: '#1c7ed6', 'pointer-events': 'none' });
        note.textContent = 'slice ' + num(mm(Math.abs(off)), 3) + ' ' + UNIT_LABEL + ' off the axis (blue slicer)' + (loops ? loops.length ? '' : ' — nothing of the part here' : ' — waiting for the 3D model');
        g.append(note);
      }
      // (there, of the objects only the geometric ones are drawn over it, to work on: they are cut where the slice is)
      const cutOnly = !!(off && monoOn() && !state.measure);
      // selected objects are drawn last (on top), so their points and edges can be picked over others
      const order = cutOnly ? frontOrder().filter(id => state.scene.nodes[id].type === 'geo') : off && state.measure ? [] : frontOrder(), ext = { y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity };
      lastPolys = { 1: {}, '-1': {} };
      // monomorphic: everything not selected drawn as one grey shape, without handles
      for (const sideK of [-1, 1]) {
      MS = sideK;
      const monoG = sv('g', { 'pointer-events': 'none' }), monoPos = [], monoNeg = [];
      g.append(monoG);
      for (const id of order) {
        if (state.scene.nodes[id].type === 'geo') {
          // a geometric object: its own section, both sides of the axis as they are (not mirrored), drawn once
          const loops = geoSection(id), proj = geoProjection(id), role = roleOf(state.scene, id), col = COLORS.geo, selected = selectedAncestorOf(id);
          for (const L of loops.concat(proj)) for (const p of L) { ext.y0 = Math.min(ext.y0, Math.abs(p[0])); ext.y1 = Math.max(ext.y1, Math.abs(p[0])); ext.z0 = Math.min(ext.z0, p[1]); ext.z1 = Math.max(ext.z1, p[1]); }
          const MSg = MS; MS = 1;
          const dG = loops.map(L => 'M' + L.map(p => toScreen(p[0], p[1]).map(v => v.toFixed(1)).join(' ')).join('L') + 'Z').join('');
          const dP = proj.map(L => 'M' + L.map(p => toScreen(p[0], p[1]).map(v => v.toFixed(1)).join(' ')).join('L') + 'Z').join('');
          MS = MSg;
          lastPolys[1][id] = lastPolys[-1][id] = { d: dG || dP, col };
          if (monoHid(id)) { if (dG) (role === 'negative' ? monoNeg : monoPos).push(dG); continue; }
          if (MS < 0) continue;
          // all of it, seen square-on to the plane, dashed (and a faint fill, to pick it by); where the plane cuts it, solid
          // (the dashed lines stop where the section is: masked out by it, a little wider than its own line)
          let mask = null;
          if (dP && dG) {
            const mid = 'aa-gm-' + String(id).replace(/[^\w-]/g, '_'), mk = sv('mask', { id: mid, maskUnits: 'userSpaceOnUse', x: -1e5, y: -1e5, width: 2e5, height: 2e5 });
            mk.append(sv('rect', { x: -1e5, y: -1e5, width: 2e5, height: 2e5, fill: '#fff' }));
            mk.append(sv('path', { d: dG, fill: '#000', 'fill-rule': 'evenodd', stroke: '#000', 'stroke-width': selected ? 5 : 4, 'stroke-linejoin': 'round' }));
            g.append(mk); mask = 'url(#' + mid + ')';
          }
          if (dP) g.append(sv('path', { ...(mask ? { mask } : {}), d: dP, fill: col + '0a', 'fill-rule': 'nonzero', stroke: role === 'negative' ? '#e03131' : col, 'stroke-width': selected ? 1.8 : 1, 'stroke-dasharray': '5 3', 'stroke-linejoin': 'round', opacity: 0.8, 'pointer-events': 'none' }));
          if (dG) g.append(sv('path', { d: dG, fill: role === 'negative' ? 'url(#aa-hatch)' : col + (role === 'intersect' ? '18' : '26'), 'fill-rule': 'evenodd',
            stroke: role === 'negative' ? '#e03131' : col, 'stroke-width': selected ? 2.8 : 1.4, 'stroke-dasharray': role === 'negative' ? '6 3' : 'none', 'stroke-linejoin': 'round' }));
          {
            // its top and bottom: drag a line up or down to change the height (Ctrl: onto the height of a point)
            const gq = state.scene.nodes[id].params, P = placeOf(state.scene, id);
            let s0 = Infinity, s1 = -Infinity;
            for (const L of loops.length ? loops : proj) for (const p of L) { s0 = Math.min(s0, p[0]); s1 = Math.max(s1, p[0]); }
            if (!P.side && isFinite(s0) && selectedAncestorOf(id) && canPick(id)) {
              // the rotation handle: beside its centre on the section's plane; turns it in the plane of the view
              const th = state.viewAngle * Math.PI / 180, [Cx, Cy] = P.w(gq.cx, gq.cy), al = Cx * Math.cos(th) + Cy * Math.sin(th), zc = Math.min(gq.z, gq.z + gq.h) + Math.abs(gq.h) / 2;
              const MSh = MS; MS = 1;
              const [px, py] = toScreen(al, zc), [ex] = toScreen(s1, zc);
              MS = MSh;
              const rk = sv('circle', { cx: (ex + 18).toFixed(1), cy: py.toFixed(1), r: 5, fill: '#fff', stroke: '#f08c00', 'stroke-width': 2.2, style: 'cursor:grab' });
              rk.__geoRot = { id, piv: [al, zc] };
              rk.append(sv('title', null, (state.scene.nodes[id].name || id) + ': turn it in this view\'s plane, about its centre; Ctrl snaps to 15°'));
              g.append(sv('path', { d: 'M' + (px - 4) + ' ' + py + 'h8M' + px + ' ' + (py - 4) + 'v8', stroke: '#f08c00', 'stroke-width': 1.2, 'pointer-events': 'none' }));
              g.append(sv('line', { x1: ex, y1: py, x2: ex + 13, y2: py, stroke: '#f08c00', 'stroke-width': 1, 'stroke-dasharray': '2 2', 'pointer-events': 'none' }));
              g.append(rk);
            }
            if (!P.side && isFinite(s0) && canPick(id)) {
              const MSh = MS; MS = 1;
              for (const [which, zz] of [['bottom', Math.min(gq.z, gq.z + gq.h)], ['top', Math.max(gq.z, gq.z + gq.h)]]) {
                const [x0, yy] = toScreen(s0, zz), [x1] = toScreen(s1, zz), hot = drag && drag.type === 'geoh' && drag.id === id && drag.which === which;
                if (hot) g.append(sv('line', { x1: x0, y1: yy, x2: x1, y2: yy, stroke: '#f08c00', 'stroke-width': 3, 'pointer-events': 'none' }));
                const gl = sv('line', { x1: x0, y1: yy, x2: x1, y2: yy, stroke: 'transparent', 'stroke-width': 9, style: 'cursor:ns-resize' });
                gl.__geoH = { id, which };
                gl.append(sv('title', null, (state.scene.nodes[id].name || id) + ': ' + which + ' — drag up or down to change the height (Ctrl: onto a point\'s height)'));
                g.append(gl);
              }
              MS = MSh;
            }
            // its corners and edges, seen square-on to the plane (each corner at its bottom and its top): corners to
            // pick and drag along the plane, edges to pick (right-click: add points on them)
            if (!P.side && selected && canPick(id)) {
              const GP = geoSidePts(id), MSh = MS; MS = 1;
              for (const E of GP.edges) {
                const [x1, y1] = toScreen(E.a[0], E.a[1]), [x2, y2] = toScreen(E.b[0], E.b[1]), on = state.sel.has(E.key);
                if (on) g.append(sv('line', { x1, y1, x2, y2, stroke: '#e03131', 'stroke-width': 3.5, 'stroke-linecap': 'round', 'pointer-events': 'none' }));
                const hl = sv('line', { x1, y1, x2, y2, stroke: 'transparent', 'stroke-width': 8, style: 'cursor:pointer' });
                hl.__key = E.key; hl.__side = 1; hl.__gtop = E.top;
                hl.append(sv('title', null, (state.scene.nodes[id].name || id) + ': edge ' + (E.i + 1) + ' (right-click to add points on it)'));
                g.append(hl);
              }
              const qn = state.scene.nodes[id];
              for (const C of GP.pts) {
                const [x, y] = toScreen(C.along, C.z), on = state.sel.has(C.key), bv = qn.shape[C.i] && qn.shape[C.i].bevel > 0;
                const c = sv('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: on ? 5.5 : 4, fill: on ? '#e03131' : col, stroke: bv ? '#fab005' : '#fff', 'stroke-width': bv ? 2.2 : 1.4, style: 'cursor:move' });
                c.__key = C.key; c.__side = C.along < 0 ? -1 : 1; c.__gpt = { along: C.along, z: C.z, top: C.top };
                c.append(sv('title', null, (qn.name || id) + ': corner ' + (C.i + 1) + ' (' + (C.top ? 'top' : 'bottom') + ')'));
                g.append(c);
              }
              MS = MSh;
            }
          }
          continue;
        }
        // the section at the view angle (copies in radial cloners are shown as their first copy)
        const n = state.scene.nodes[id], xf = xfOf(state.scene, id), local = outlineOf(n.pts, n.runs), poly = xf.id ? sectionOutline(n, viewTheta()) : (n.type === 'thread' ? sectionOutline(n, 0) : local).map(xf.fwd), role = roleOf(state.scene, id);
        // a copy in a radial cloner: its section has two halves, either side of the copy's own axis; both are drawn
        // (and, like everything, mirrored on the left)
        const twin = xf.id ? null : local.map(xf.mir);
        if (MS > 0) for (const p of twin ? poly.concat(twin) : poly) { ext.y0 = Math.min(ext.y0, p.y); ext.y1 = Math.max(ext.y1, p.y); ext.z0 = Math.min(ext.z0, p.z); ext.z1 = Math.max(ext.z1, p.z); }
        const col = COLORS[n.type] || '#1f6feb', crossing = polygonSelfIntersects(local), selected = selectedAncestorOf(id);
        const fill = role === 'negative' ? 'url(#aa-hatch)' : crossing ? 'rgba(220,38,38,.18)' : col + (role === 'intersect' ? '18' : '26');
        const dAll = pathOf(poly) + (twin ? pathOf(twin) : '');
        lastPolys[MS][id] = { d: dAll, col };      // for the hover highlight
        if (monoHid(id)) { (role === 'negative' ? monoNeg : monoPos).push(pathOf(poly)); if (twin) (role === 'negative' ? monoNeg : monoPos).push(pathOf(twin)); continue; }
        for (const part of twin ? [poly, twin] : [poly])
          g.append(sv('path', { d: pathOf(part), fill, stroke: crossing || role === 'negative' ? '#e03131' : col, 'stroke-width': selected ? 2.8 : 1.4,
            'stroke-dasharray': role === 'negative' ? '6 3' : 'none', 'stroke-linejoin': 'round' }));
        if (n.type === 'cog') {
          // the range the section moves through as the view turns: root (min) and tip (max)
          const sh = cogShapeOf(n.params, n.precision), fix = cogFix(n.params, local), lo = Math.min(sh.rf, sh.ra), hi = Math.max(sh.rf, sh.ra);
          for (const [R, st, dash] of [[lo, '#0c8599', 'none'], [hi, '#c2255c', '6 4'], [sh.rp, '#868e96', '2 3']])
            g.append(sv('path', { d: pathOf(local.map(p => xf.fwd({ y: cogWarp(p.y, R, fix, sh.tip), z: p.z }))), fill: 'none', stroke: st, 'stroke-width': 1.2, 'stroke-dasharray': dash, 'pointer-events': 'none' }));
        }
        if (n.type === 'ngon') {
          // the range the section moves through as the view turns: face-centre radius (min) and edge radius (max)
          const k = Math.cos(Math.PI / Math.max(3, n.params.sides | 0)), faces = n.params.about === 'faces';
          const minK = faces ? 1 : k, maxK = faces ? 1 / k : 1;
          g.append(sv('path', { d: pathOf(local.map(p => xf.fwd({ y: p.y * minK, z: p.z }))), fill: 'none', stroke: '#0c8599', 'stroke-width': 1.2, 'pointer-events': 'none' }));
          g.append(sv('path', { d: pathOf(local.map(p => xf.fwd({ y: p.y * maxK, z: p.z }))), fill: 'none', stroke: '#c2255c', 'stroke-width': 1.2, 'stroke-dasharray': '6 4', 'pointer-events': 'none' }));
        }
      }
      // the grey shape is the finished part's own section (both sides at once), when the 3D model is there
      const exact = state.mono || monoPos.length ? meshSection(state.viewAngle * Math.PI / 180) : null;
      if (exact && monoPos.length + monoNeg.length) {
        if (MS < 0) {
          const MS0 = MS; MS = 1;
          const dd = exact.map(L => 'M' + L.map(p => toScreen(p[0], p[1]).map(v => v.toFixed(1)).join(' ')).join('L') + 'Z').join('');
          MS = MS0;
          monoG.append(sv('path', { d: dd, fill: 'none', stroke: '#868e96', 'stroke-width': 2.4, 'stroke-linejoin': 'round' }));
          monoG.append(sv('path', { d: dd, fill: '#dee2e6', 'fill-rule': 'evenodd', stroke: '#868e96', 'stroke-width': 1.2, 'stroke-linejoin': 'round' }));
        }
      } else drawMono(monoG, monoPos, monoNeg, MS > 0 ? 'r' : 'l');
      // bevels: grab one to make it bigger or smaller
      for (const id of order) {
        if (monoHid(id)) continue;
        const n = state.scene.nodes[id], arcs = new Map(), xf = xfOf(state.scene, id);
        for (const it of expandProfile(n.pts, n.runs)) if (!it.band && it.corner != null) { if (!arcs.has(it.corner)) arcs.set(it.corner, []); arcs.get(it.corner).push(xf.fwd(it)); }
        for (const [i, arc] of arcs) {
          if (arc.length < 2) continue;
          const d = arc.map((p, k) => (k ? 'L' : 'M') + toScreen(p.y, p.z).map(v => v.toFixed(1)).join(' ')).join(' ');
          const hot = drag && drag.type === 'bevel' && drag.node === id && drag.i === i;
          g.append(sv('path', { d, fill: 'none', stroke: hot ? '#f08c00' : 'rgba(250,176,5,.55)', 'stroke-width': hot ? 3 : 2, 'stroke-linecap': 'round', 'pointer-events': 'none' }));
          const hit = sv('path', { d, fill: 'none', stroke: 'transparent', 'stroke-width': 12, style: 'cursor:nwse-resize' });
          hit.__bevel = { node: id, i }; hit.__side = MS;
          const tip = sv('title'); tip.textContent = 'Drag to change this bevel'; hit.append(tip);
          g.append(hit);
        }
      }
      // radial cloners in the selection: the copies' axis, with a handle for its distance from the main axis
      for (const id of MS > 0 && !cutOnly ? Object.keys(state.scene.nodes) : []) {
        if (!canPick(id) || nodeFlag(state.scene, id, 'hide2d') || state.measure) continue;
        const hp = clonerHandle(id); if (!hp) continue;
        const [x1, y1] = toScreen(hp.a.y, hp.a.z), [x2, y2] = toScreen(hp.b.y, hp.b.z), [hx, hy] = toScreen(hp.at.y, hp.at.z);
        const hot = drag && drag.type === 'cloner' && drag.id === id;
        g.append(sv('line', { x1, y1, x2, y2, stroke: '#f08c00', 'stroke-width': 1.3, 'stroke-dasharray': '7 3 2 3', 'pointer-events': 'none' }));
        const HS = 14;      // big enough to grab around a point drawn on top of it
        const d = sv('path', { d: 'M' + hx + ' ' + (hy - HS) + 'L' + (hx + HS) + ' ' + hy + 'L' + hx + ' ' + (hy + HS) + 'L' + (hx - HS) + ' ' + hy + 'Z',
          fill: hot ? '#f08c00' : '#ffd8a8', stroke: '#d9480f', 'stroke-width': 1.5, style: 'cursor:' + (hp.radial ? 'move' : 'ew-resize') });
        d.__cloner = id;
        const tip = sv('title'); tip.textContent = (state.scene.nodes[id].name || id) + ': drag to set the distance of the copies from the axis' + (hp.radial ? ' and their height' : ''); d.append(tip);
        g.append(d);
        if (hot || state.selNodes.has(id)) {
          const q = state.scene.nodes[id].params;
          label(g, hx + 18, hy + (hp.radial ? -16 : 20), ['copies\' axis · distance ' + num(mm(q.radius), 3) + ' ' + UNIT_LABEL + (hp.radial ? ' · y ' + num(hDisp(q.height, sceneBase), 3) + ' ' + UNIT_LABEL : '')], { border: '#ffc078', bg: 'rgba(255,249,219,.95)' });
        }
      }
      // selected edges
      for (const id of order) for (const e of edgesOf(id)) {
        if (!state.sel.has(e.key)) continue;
        const [x1, y1] = toScreen(e.a.y, e.a.z), [x2, y2] = toScreen(e.b.y, e.b.z);
        g.append(sv('line', { x1, y1, x2, y2, stroke: '#e03131', 'stroke-width': 3.5, 'stroke-linecap': 'round' }));
      }
      // handles that would cover each other are fanned out around their common point (with a thin leader), so each can be grabbed
      const hds = [];
      for (const id of order) if (!monoHid(id) && canPick(id)) for (const hd of handlesOf(id)) { const [x, y] = toScreen(hd.y, hd.z); hds.push({ id, hd, x, y, dx: 0, dy: 0 }); }
      const grid2 = new Map(), cell = (x, y) => Math.floor(x / 6) + ',' + Math.floor(y / 6);
      hds.forEach((h, i) => { const c = cell(h.x, h.y); if (!grid2.has(c)) grid2.set(c, []); grid2.get(c).push(i); });
      const seen = new Set();
      hds.forEach((h, i) => {
        if (seen.has(i)) return;
        const near = [];
        const [cx, cy] = [Math.floor(h.x / 6), Math.floor(h.y / 6)];
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const j of grid2.get((cx + a) + ',' + (cy + b)) || []) if (!seen.has(j) && Math.hypot(hds[j].x - h.x, hds[j].y - h.y) < 5) near.push(j);
        near.forEach(j => seen.add(j));
        if (near.length < 2 || near.length > 8) return;
        const A = hds[near[0]], B = hds[near[1]], gap = near.length === 2 ? Math.hypot(B.x - A.x, B.y - A.y) : 0;
        if (gap > 0.5) {
          // two close handles (e.g. the ends of a tooth's flat): just push them apart along their own line
          const ux = (B.x - A.x) / gap, uy = (B.y - A.y) / gap, push = (10 - gap) / 2;
          A.dx = -ux * push; A.dy = -uy * push; B.dx = ux * push; B.dy = uy * push;
          return;
        }
        const R = 7 + near.length * 1.2;
        near.forEach((j, m) => { const t = -Math.PI / 4 + 2 * Math.PI * m / near.length; hds[j].dx = Math.cos(t) * R; hds[j].dy = Math.sin(t) * R; });
        svg.append(sv('circle', { cx: h.x.toFixed(1), cy: h.y.toFixed(1), r: 1.8, fill: '#495057', 'pointer-events': 'none' }));
      });
      for (const { id, hd, x: x0, y: y0, dx, dy } of hds) {
        const n = state.scene.nodes[id];
        {
          const x = x0 + dx, y = y0 + dy, on = state.sel.has(hd.key);
          if (dx || dy) svg.append(sv('line', { x1: x0.toFixed(1), y1: y0.toFixed(1), x2: x.toFixed(1), y2: y.toFixed(1), stroke: '#868e96', 'stroke-width': 1, 'pointer-events': 'none' }));
          const c = sv('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: on ? 5.5 : 4,
            fill: on ? '#e03131' : hd.run ? '#d9480f' : (COLORS[n.type] || '#1f6feb'), stroke: hd.bevel ? '#fab005' : '#fff', 'stroke-width': hd.bevel ? 2.2 : 1.4, style: 'cursor:move' });
          c.__key = hd.key; c.__side = MS;
          if (!hd.run) { const tip = sv('title'); tip.textContent = (n.name || id) + ': r ' + fmt(hd.y, 3) + ', z ' + fmt(hd.z, 3) + ' ' + UNIT_LABEL + (hd.bevel ? ' (bevelled)' : ''); c.append(tip); }
          svg.append(c);
        }
      }
      // cogs' teeth, like a thread's: handles at the tips, the pitch circle and the roots, half way up the toothed edge
      // (drag across to change the addendum, the module or the dedendum)
      for (const id of order) {
        const n = state.scene.nodes[id];
        if (n.type !== 'cog' || monoHid(id) || !canPick(id)) continue;
        const xf = xfOf(state.scene, id);
        for (const ch of cogHandles(n)) {
          const at = xf.fwd({ y: ch.r, z: ch.z }), [x, y] = toScreen(at.y, at.z), hot = drag && drag.type === 'cog' && drag.id === id && drag.what === ch.what;
          const c = sv('path', { d: 'M' + x.toFixed(1) + ' ' + (y - 6).toFixed(1) + 'l6 6l-6 6l-6-6z', fill: hot ? '#e03131' : ch.col, stroke: '#fff', 'stroke-width': 1.4, style: 'cursor:ew-resize' });
          c.__cog = { id, what: ch.what }; c.__side = MS;
          const tip = sv('title'); tip.textContent = (n.name || id) + ': ' + ch.tip; c.append(tip);
          svg.append(c);
        }
      }
      }
      MS = 1;
      boldExtents(g, ext);
      // coordinates beside each selected point (x = radius, y = height from the lowest point)
      const selHandles = [];
      for (const id of order) for (const hd of handlesOf(id)) if (state.sel.has(hd.key)) selHandles.push(hd);
      for (const k of state.sel) {
        const h = parseKey(k);
        if (h.kind !== 'e') continue;
        const n = state.scene.nodes[h.node]; if (!n) continue;
        const xf = xfOf(state.scene, h.node);
        for (const i of [h.i, (h.i + 1) % n.pts.length]) if (!selHandles.some(s => s.key === h.node + '|p|' + i)) { const q = xf.fwd(n.pts[i]); selHandles.push({ key: h.node + '|p|' + i, y: q.y, z: q.z }); }
      }
      for (const hd of selHandles.slice(0, 60)) {
        const [x, y] = toScreen(hd.y, hd.z), text = 'x r ' + num(mm(hd.y), 3) + ' / Ø ' + num(mm(2 * hd.y), 3) + ' · y ' + num(hDisp(hd.z, sceneBase), 3) + ' ' + UNIT_LABEL;
        const wpx = text.length * 5.6 + 8, { w } = size();
        label(svg, x + 9 + wpx > w ? x - wpx - 6 : x + 9, y - 8, [text]);
      }
      // length and angle beside each selected edge
      for (const k of state.sel) {
        const h = parseKey(k);
        if (h.kind !== 'e') continue;
        const n = state.scene.nodes[h.node]; if (!n) continue;
        const xf = xfOf(state.scene, h.node), a = xf.fwd(n.pts[h.i]), b = xf.fwd(n.pts[(h.i + 1) % n.pts.length]), L = Math.hypot(b.y - a.y, b.z - a.z);
        const ang = Math.atan2(FZ() * (b.z - a.z), b.y - a.y) * 180 / Math.PI;      // as shown
        const [x, y] = toScreen((a.y + b.y) / 2, (a.z + b.z) / 2);
        label(svg, x + 8, y + 14, ['length ' + num(mm(L), 3) + ' ' + UNIT_LABEL + ' · angle ' + num((((ang % 180) + 180) % 180) * ANG_SCALE, ANG_SCALE === 1 ? 2 : 4) + ANG_LABEL, 'Δx (radius) ' + num(mm(b.y - a.y), 3) + ' · Δy (height) ' + num(HS() * mm(b.z - a.z), 3) + ' ' + UNIT_LABEL], { border: '#ffa8a8' });
      }
      // sample positions of points that would be inserted (menu hover)
      for (const p of previewMarks) {
        const [x, y] = toScreen(p.y, p.z);
        svg.append(sv('circle', { cx: x, cy: y, r: 5, fill: 'rgba(250,176,5,.35)', stroke: '#f08c00', 'stroke-width': 1.5, 'stroke-dasharray': '2 2', 'pointer-events': 'none' }));
      }
      MS = drag ? dragSide : 1;
      if (drag && drag.guides && drag.guides.length) {
        const ext = 60 / view.s;
        for (const gd of drag.guides) {
          const dy = gd.to.y - gd.from.y, dz = gd.to.z - gd.from.z, l = Math.hypot(dy, dz);
          let a = gd.from, b = gd.to;
          if (l > 1e-12) { a = { y: gd.from.y - dy / l * ext, z: gd.from.z - dz / l * ext }; b = { y: gd.to.y + dy / l * ext, z: gd.to.z + dz / l * ext }; }
          const [x1, y1] = toScreen(a.y, a.z), [x2, y2] = toScreen(b.y, b.z);
          svg.append(sv('line', { x1, y1, x2, y2, stroke: gd.lock ? 'rgba(112,72,232,.55)' : 'rgba(240,140,0,.6)', 'stroke-width': 1, 'stroke-dasharray': gd.lock ? '2 3' : '5 4', 'pointer-events': 'none' }));
        }
      }
      if (drag && drag.mark) {
        const [x, y] = toScreen(drag.mark.y, drag.mark.z);
        if (drag.markMid) svg.append(sv('path', { d: 'M' + x + ' ' + (y - 7) + 'L' + (x + 7) + ' ' + (y + 5) + 'L' + (x - 7) + ' ' + (y + 5) + 'Z', fill: 'none', stroke: '#f08c00', 'stroke-width': 1.5, 'pointer-events': 'none' }));
        else svg.append(sv('rect', { x: x - 6, y: y - 6, width: 12, height: 12, fill: 'none', stroke: '#f08c00', 'stroke-width': 1.5, 'pointer-events': 'none' }));
      }
      MS = 1;
      if (drag && drag.type === 'box') {
        const x0 = Math.min(drag.sx, drag.cx), y0 = Math.min(drag.sy, drag.cy);
        svg.append(sv('rect', { x: x0, y: y0, width: Math.abs(drag.cx - drag.sx), height: Math.abs(drag.cy - drag.sy), fill: 'rgba(31,111,235,.08)', stroke: '#1f6feb', 'stroke-dasharray': '4 3' }));
      }
      if (drag && drag.type === 'cog' && drag.label && drag.labelAt) {
        const wpx = drag.label.length * 5.6 + 8, lx = drag.labelAt[0] + 12 + wpx > size().w ? drag.labelAt[0] - wpx - 12 : drag.labelAt[0] + 12;
        label(svg, lx, drag.labelAt[1] - 14, [drag.label], { border: '#faa2c1', bg: 'rgba(255,240,246,.95)' });
      }
      if (drag && drag.type === 'bevel' && drag.label) label(svg, drag.labelAt[0] + 12, drag.labelAt[1] - 10, [drag.label], { border: '#ffc078', bg: 'rgba(255,249,219,.95)' });
      for (const a of g.querySelectorAll('[data-axes]')) g.append(a);   // (the axes over the drawing)
      drawMeasures();
      if (!mExporting) drawCursor();
      drawHover();
      zoomTag.textContent = (view.fit || fitScale) > 0 ? Math.round(view.s / (view.fit || fitScale) * 100) + '%' : '';
      if (cutOnly || state.measure) for (const [k, tb] of threadBoxes) { tb.box.remove(); threadBoxes.delete(k); }
      else syncThreadBoxes();
      renderSelBox();
      MS = MS0;
    }
    // the object under the pointer (a soft halo round its section, both sides) and the edge under it, drawn over
    // the section on their own so moving the pointer does not redraw everything
    let hoverTopH = null, lastPolys = { 1: {}, '-1': {} }, treeAnchor = null, lastRowClick = { id: null, t: 0 };
    function renameRow(id) {
      const n = state.scene && state.scene.nodes[id], row = side.querySelector('[data-node="' + id + '"]');
      if (!n || !row) return;
      const inp = el('input', { type: 'text', value: n.name || '', style: 'width:100%;max-width:220px' });
      let done = false;
      const finish = (keep) => {
        if (done) return; done = true;
        const v = inp.value.trim();
        if (keep && v && v !== n.name) { pushUndo(); n.name = v; if (n.type === 'thread') for (const r of n.runs) r.label = v; markEdited(); rememberScene(); }
        inp.blur(); renderAll();
      };
      inp.__onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); } };
      inp.addEventListener('blur', () => finish(true));
      inp.addEventListener('click', (e) => e.stopPropagation());
      inp.addEventListener('pointerdown', (e) => e.stopPropagation());
      row.draggable = false;
      const lead = [...row.children].slice(0, 3);   // tree lines, fold arrow, icon
      row.textContent = ''; row.append(...lead, inp);
      inp.focus(); inp.select();
    }
    function drawHover() {
      for (const r of side.querySelectorAll('[data-node]')) r.classList.toggle('aa-hov', !drag && r.dataset.node === hoverNode);
      const old = svg.querySelector('#aa-hover'); if (old) old.remove();
      if (drag || !state.scene || !view || (!hoverNode && !hoverEdge)) return;
      const g = sv('g', { id: 'aa-hover', 'pointer-events': 'none' }), MSh = MS;
      for (const s of [1, -1]) {
        MS = s;
        const p = hoverNode && lastPolys[s][hoverNode];
        if (p) g.append(sv('path', { d: p.d, fill: p.col + '1a', 'fill-rule': 'evenodd', stroke: p.col, 'stroke-width': 6, 'stroke-opacity': 0.3, 'stroke-linejoin': 'round' }));
        if (hoverEdge && !state.sel.has(hoverEdge)) {
          const h = parseKey(hoverEdge), e = state.scene.nodes[h.node] && edgesOf(h.node).find(x => x.key === hoverEdge);
          if (e) { const [x1, y1] = toScreen(e.a.y, e.a.z), [x2, y2] = toScreen(e.b.y, e.b.z); g.append(sv('line', { x1, y1, x2, y2, stroke: 'rgba(224,49,49,.45)', 'stroke-width': 3, 'stroke-linecap': 'round' })); }
        }
      }
      MS = MSh;
      if (topMode() && hoverTopH) g.append(...topHandleLinks(hoverTopH));
      // under the handles, so they stay on top and easy to grab
      const firstHandle = [...svg.children].find(c => c.tagName === 'circle');
      if (firstHandle) svg.insertBefore(g, firstHandle); else svg.append(g);
    }
    // The far inside of the part, seen through the middle behind the cut, very lightly in the colour of whatever is
    // nearest the axis. A screen point at distance x from the axis sees the inside wall where it turns away from the
    // cut by α = acos(x / r): so the shading is built in layers of α (even steps of x / r), each layer being the inner
    // edge of the section at that angle (threads' teeth shift with it, n-sided walls move), squeezed toward the axis
    // by cos α. Strongest beside the part, fading off hyperbolically toward the axis. Redrawn with every edit and turn.
    function innerRuns(polys) {
      // per height: the colour nearest the axis and its inner radius, as runs of { col, pts: [{y, z}], z0, z1 }
      const items = [];
      for (const { col, poly } of polys) {
        const N = poly.length, zs = [...new Set(poly.map(p => p.z))].sort((a, b) => a - b);
        if (zs.length < 2) continue;
        const e = ((zs[zs.length - 1] - zs[0]) || 1) * 1e-7, dn = zs.map(() => Infinity), up = zs.map(() => Infinity);
        const lb = (z) => { let lo = 0, hi = zs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (zs[m] < z) lo = m + 1; else hi = m; } return lo; };
        for (let i = 0; i < N; i++) {
          const A = poly[i], B = poly[(i + 1) % N];
          if (A.z === B.z) continue;
          const z0 = Math.min(A.z, B.z), z1 = Math.max(A.z, B.z), at = (z) => A.y + (B.y - A.y) * (z - A.z) / (B.z - A.z);
          for (let k = lb(z0); k < zs.length && zs[k] <= z1; k++) {
            if (zs[k] > z0) { const y = at(zs[k] - e); if (y < dn[k]) dn[k] = y; }
            if (zs[k] < z1) { const y = at(zs[k] + e); if (y < up[k]) up[k] = y; }
          }
        }
        items.push({ col, prof: zs.map((z, k) => ({ z, dn: dn[k], up: up[k] })) });
      }
      const span = (it, zm) => { const P = it.prof; if (zm <= P[0].z || zm >= P[P.length - 1].z) return -1; let lo = 0, hi = P.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P[m].z <= zm) lo = m; else hi = m; } return lo; };
      const yOn = (it, s, z) => { const a = it.prof[s], b = it.prof[s + 1]; return a.up + (b.dn - a.up) * (z - a.z) / (b.z - a.z); };
      const cuts = [...new Set(items.flatMap(it => it.prof.map(p => p.z)))].sort((a, b) => a - b), runs = [];
      let run = null;
      for (let k = 0; k + 1 < cuts.length; k++) {
        const a = cuts[k], b = cuts[k + 1], zm = (a + b) / 2;
        if (b - a < 1e-12) continue;
        let best = null, bs = -1, by = Infinity;
        for (const it of items) { const s = span(it, zm); if (s < 0) continue; const y = yOn(it, s, zm); if (y < by) { by = y; best = it; bs = s; } }
        // a tie (a thread's root on its ring's wall): keep the colour already running, so there are no stripes
        if (run && best && best !== run.it) { const s = span(run.it, zm); if (s >= 0 && Math.abs(yOn(run.it, s, zm) - by) < 1e-7) { best = run.it; bs = s; } }
        if (!best || !isFinite(by)) { run = null; continue; }
        const ya = yOn(best, bs, a), yb = yOn(best, bs, b);
        if (!run || run.it !== best || Math.abs(run.pts[run.pts.length - 1].y - ya) > 1e-9 || Math.abs(run.z1 - a) > 1e-12) { run = { it: best, col: best.col, z0: a, z1: b, pts: [{ y: ya, z: a }, { y: yb, z: b }] }; runs.push(run); }
        else { run.pts.push({ y: yb, z: b }); run.z1 = b; }
      }
      return runs;
    }
    let wrapKey = '', wrapTimer = 0;
    function drawWrap(settled) {
      if (state.measure) { const c = wrapCanvas.getContext('2d'); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, wrapCanvas.width, wrapCanvas.height); wrapCanvas.style.transform = ''; wrapKey = ''; return; }
      if (topMode() || sliceView()) {
        // nothing behind the view from above
        clearTimeout(wrapTimer);
        if (wrapKey !== 'top') { const c = wrapCanvas.getContext('2d'); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, wrapCanvas.width, wrapCanvas.height); wrapCanvas.style.transform = ''; wrapKey = 'top'; }
        return;
      }
      const { w, h } = size();
      const key = [state.job, state.viewAngle, !!state.flip, view && view.s, view && view.cy, view && view.cz, w, h, UNIT_SCALE, state.quality, state.scene ? state.scene.root.length : 0].join('|');
      if (key === wrapKey) return;
      const busy = !settled && !!((drag && (drag.moved || drag.type === 'pan')) || zoomAnim);
      clearTimeout(wrapTimer);
      if (busy && wrapView) {
        // keep the shading drawn last, moved and scaled to the current view, until things settle
        const a = view.s / wrapView.s, bx = w / 2 - a * w / 2 + (wrapView.cy - view.cy) * view.s, by = h / 2 - a * h / 2 - (wrapView.cz - view.cz) * view.s;
        wrapCanvas.style.transformOrigin = '0 0'; wrapCanvas.style.transform = 'matrix(' + a + ',0,0,' + a + ',' + bx + ',' + by + ')';
        wrapKey = '';
        // (a pan that pauses gets its shading at once; other drags when they end)
        wrapTimer = setTimeout(() => { if (!(drag && drag.moved && drag.type !== 'pan') && !zoomAnim && root.isConnected) drawWrap(true); }, 140);
        return;
      }
      drawWrapNow(false);
      wrapCanvas.style.transform = '';
      wrapView = view ? { s: view.s, cy: view.cy, cz: view.cz } : null;
      wrapKey = key;
    }
    let wrapView = null;
    function drawWrapNow(quick) {
      // drawn at one canvas pixel per screen pixel (a soft shading needs no more), then the opacity is worked out per
      // pixel from how far it is from the part toward the axis, with ordered dithering so the faint gradient has no bands
      const ctx = wrapCanvas.getContext('2d', { willReadFrequently: true }), { w, h } = size(), W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h));
      if (wrapCanvas.width !== W || wrapCanvas.height !== H) { wrapCanvas.width = W; wrapCanvas.height = H; }
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over'; ctx.clearRect(0, 0, W, H);
      if (!state.scene || !view) return;
      const objs = [];
      for (const id of leafOrder(state.scene)) {
        const n = state.scene.nodes[id], xf = xfOf(state.scene, id);
        if (!xf.id || roleOf(state.scene, id) === 'negative') continue;
        objs.push({ n, col: COLORS[n.type] || '#1f6feb', turns: n.type === 'ngon' || n.type === 'cog' || (n.runs || []).some(r => r.hand) });
      }
      if (!objs.length) return;
      const low = lowQuality() || quick, K = low ? 6 : 24, MSw = MS, theta = state.viewAngle * Math.PI / 180;
      wrapCanvas.style.opacity = low ? '0.05' : '1';
      // per side: the inner radius at the cut for each pixel row (to measure the fade), and the colour layers
      const wall = { 1: new Float32Array(H).fill(NaN), '-1': new Float32Array(H).fill(NaN) };
      for (const s of [1, -1]) {
        MS = s;
        const still = new Map();
        for (let k = 0; k < K; k++) {
          const u = 1 - k / K, alpha = Math.acos(u), az = s > 0 ? theta + alpha : theta + Math.PI - alpha;
          const polys = objs.map(o => {
            if (!o.turns) { if (!still.has(o)) still.set(o, sectionOutline(o.n, az)); return { col: o.col, poly: still.get(o) }; }
            return { col: o.col, poly: sectionOutline(o.n, az) };
          }).filter(p => p.poly.length >= 3);
          const runs = innerRuns(polys);
          if (k === 0) for (const run of runs) for (let q = 0; q + 1 < run.pts.length; q++) {
            const A = run.pts[q], B = run.pts[q + 1], ya = toScreen(0, A.z)[1], yb = toScreen(0, B.z)[1];
            for (let row = Math.max(0, Math.ceil(Math.min(ya, yb))); row <= Math.min(H - 1, Math.floor(Math.max(ya, yb))); row++) {
              const t = yb === ya ? 0 : (row - ya) / (yb - ya), r = A.y + (B.y - A.y) * t, cur = wall[s][row];
              if (!(cur <= r)) wall[s][row] = r;
            }
          }
          for (const run of runs) {
            const pts = [toScreen(0, run.z0), ...run.pts.map(p => toScreen(p.y * u, p.z)), toScreen(0, run.z1)];
            ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath();
            ctx.fillStyle = run.col; ctx.fill();       // opaque: nearer the axis (further round the inside) covers what is under it
          }
        }
      }
      MS = MSw;
      // opacity per pixel: 1.05× the base beside the part, falling off hyperbolically to 0.25× at the axis
      const BASE = 0.0675, c = 4, h0 = 1 / (1 + c), axisX = w / 2 - view.cy * view.s;
      const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
      if (low) return;
      const img = ctx.getImageData(0, 0, W, H), D = img.data;
      for (let row = 0; row < H; row++) {
        const rR = wall[1][row], rL = wall[-1][row];
        for (let col = 0, o = row * W * 4; col < W; col++, o += 4) {
          const a0 = D[o + 3]; if (!a0) continue;
          const X = (col + 0.5 - axisX) / view.s, r = X >= 0 ? rR : rL;
          const uu = r > 0 ? Math.min(1, Math.abs(X) / r) : 1, t = 1 - uu, hy = (1 / (1 + c * t) - h0) / (1 - h0);
          const a = BASE * (0.25 + 1.325 * hy) * (a0 / 255) * 255 + (BAYER[(col & 3) + (row & 3) * 4] + 0.5) / 16 - 0.5;
          D[o + 3] = a < 0 ? 0 : a > 255 ? 255 : Math.round(a);
        }
      }
      ctx.putImageData(img, 0, 0);
    }
    // the model's smallest and largest radius (both sides) and its lowest and highest point, in bold on the axes
    function boldExtents(g, ext) {
      if (!isFinite(ext.y0)) return;
      const { w, h } = size(), base = sceneBase;
      const tag = (x, y, text, anchor, plain) => {
        const t = sv('text', { x, y, 'font-size': 10, 'font-weight': plain ? 400 : 700, fill: plain ? '#495057' : '#000', 'text-anchor': anchor }); t.textContent = text;
        const wpx = text.length * 6 + 6, x0 = anchor === 'middle' ? x - wpx / 2 : anchor === 'end' ? x - wpx + 3 : x - 3;
        g.append(sv('rect', { x: x0, y: y - 10, width: wpx, height: 13, fill: 'rgba(248,249,250,.97)' }), t);
      };
      const radii = [ext.y1]; if (ext.y0 > 1e-9 && Math.abs(ext.y1 - ext.y0) * view.s > 4) radii.push(ext.y0);
      // close together: the outer value reads outward, the inner one inward, so they do not overlap
      const close = radii.length > 1 && Math.abs(ext.y1 - ext.y0) * view.s < 90;
      radii.forEach((r, ri) => { for (const sgn of [-1, 1]) {
        const x = w / 2 + (sgn * r - view.cy) * view.s;
        if (x < AX_L || x > w) continue;
        const out = ri === 0;     // the largest radius in bold; the smallest plain
        g.append(sv('line', { x1: x, y1: h - AX_B - 5, x2: x, y2: h - AX_B + 7, stroke: out ? '#000' : '#495057', 'stroke-width': out ? 2 : 1 }));
        const anchor = !close ? 'middle' : (out === (sgn > 0) ? 'start' : 'end'), xx = !close ? x : x + (anchor === 'start' ? 3 : -3);
        tag(xx, h - 4, num(mm(r), 3) + ' ' + UNIT_LABEL, anchor, !out);
        tag(xx, h - 17, 'Ø' + num(mm(2 * r), 3) + ' ' + UNIT_LABEL, anchor, !out);
      } });
      for (const z of [ext.z0, ext.z1]) {
        const y = toScreen(0, z)[1];
        if (y < 0 || y > h - AX_B) continue;
        g.append(sv('line', { x1: AX_L - 7, y1: y, x2: AX_L + 5, y2: y, stroke: '#000', 'stroke-width': 2 }));
        tag(AX_L - 6, y + 3, num(hDisp(z, base), 3) + ' ' + UNIT_LABEL, 'end');
      }
    }

    // ---- thread data boxes with editable values (live) ----
    const threadBoxes = new Map();
    const INP = 'width:66px;font-size:11px;padding:1px 3px';
    function runOf(nodeId, ri) { const n = state.scene && state.scene.nodes[nodeId]; return n && n.runs && n.runs[ri] ? { n, r: n.runs[ri] } : null; }
    function threadValues(r, base) {
      const rMin = Math.min(r.rFirst, r.rOther), rMax = Math.max(r.rFirst, r.rOther), depth = rMax - rMin, len = Math.abs(r.zLast - r.zFirst);
      const flank = Math.max(0, (1 - (r.flatA || 0) - (r.flatB || 0)) / 2) * r.pitch;
      return { pitch: mm(r.pitch), turns: len / r.pitch, depth: mm(depth), angle: 2 * Math.atan2(flank, depth) * 180 / Math.PI,
        dmin: mm(2 * rMin), dmax: mm(2 * rMax), len: mm(len), from: Math.min(hDisp(r.zFirst, base), hDisp(r.zLast, base)), to: Math.max(hDisp(r.zFirst, base), hDisp(r.zLast, base)) };
    }
    // Apply an edited value; the values that depend on it follow.
    function setThreadValue(r, kind, f, v, base) {
      const lowKey = r.zFirst <= r.zLast ? 'zFirst' : 'zLast', highKey = lowKey === 'zFirst' ? 'zLast' : 'zFirst';
      const firstIsMin = r.rFirst <= r.rOther;
      const setRadii = (rMin, rMax) => { if (firstIsMin) { r.rFirst = rMin; r.rOther = rMax; } else { r.rFirst = rMax; r.rOther = rMin; } };
      const rMin = Math.min(r.rFirst, r.rOther), rMax = Math.max(r.rFirst, r.rOther), len = Math.abs(r.zLast - r.zFirst);
      // thread height changes keep the crest diameter of an external thread, or the minor diameter of an internal one
      const setDepth = (d) => { d = Math.max(1e-4, d); if (kind === 'internal') setRadii(rMin, rMin + d); else setRadii(Math.max(0, rMax - d), rMax); };
      const inch = v / UNIT_SCALE;
      switch (f) {
        case 'pitch': if (inch > 1e-4 && inch < len) r.pitch = inch; break;
        case 'turns': if (v > 0) { const L = Math.max(r.pitch, v * r.pitch); r[highKey] = r[lowKey] + L; } break;
        case 'depth': setDepth(inch); break;
        case 'angle': if (v > 1 && v < 179) setDepth((Math.max(0, (1 - (r.flatA || 0) - (r.flatB || 0)) / 2) * r.pitch) / Math.tan(v * Math.PI / 360)); break;
        case 'dmin': if (inch / 2 < rMax) setRadii(Math.max(0, inch / 2), rMax); break;
        case 'dmax': if (inch / 2 > rMin) setRadii(rMin, inch / 2); break;
        case 'len': if (inch >= r.pitch) r[highKey] = r[lowKey] + inch; break;
        // (from: the end with the smaller shown height; heights shown top down or flipped run the other way)
        case 'from': case 'to': {
          const z = hInv(v, base), lowEnd = (f === 'from') === (HS() > 0);
          if (lowEnd) { if (r[highKey] - z >= r.pitch) r[lowKey] = z; } else if (z - r[lowKey] >= r.pitch) r[highKey] = z;
          break;
        }
      }
    }
    function makeThreadBox(nodeId, ri) {
      const box = el('div', { style: 'position:absolute;pointer-events:auto;background:rgba(255,249,219,.96);border:1px solid #ffc078;border-radius:5px;padding:4px 6px;font:11px/1.35 sans-serif;color:#343a40;box-shadow:0 1px 4px rgba(0,0,0,.12)' });
      const title = el('div', { style: 'font-weight:700;cursor:pointer;user-select:none;display:flex;gap:6px;align-items:center' });
      const body = el('div', { style: 'display:grid;grid-template-columns:auto auto auto auto;gap:2px 6px;align-items:center;margin-top:3px' });
      const hand = el('select', { style: 'font-size:11px' }, el('option', { value: '1' }, 'standard'), el('option', { value: '-1' }, 'reverse'));
      hand.addEventListener('change', () => { const o = runOf(nodeId, ri); if (!o) return; pushUndo(); o.r.hand = +hand.value; recalc(); });
      const tb = { box, inputs: {}, collapsed: true };
      body.style.display = 'none';
      title.addEventListener('click', (e) => {
        if (e.target === hand || hand.contains(e.target)) return;
        tb.collapsed = !tb.collapsed;
        animResize(box, () => { body.style.display = tb.collapsed ? 'none' : 'grid'; tb.update(); });
        if (!tb.collapsed) animIn(body, { ms: 200 });
        syncThreadBoxes();
      });
      const fields = [['pitch', 'pitch', UNIT_LABEL], ['turns', 'turns', ''], ['depth', 'thread depth (x)', UNIT_LABEL], ['angle', 'V angle', ANG_LABEL.trim()],
        ['dmin', 'minor Ø', UNIT_LABEL], ['dmax', 'major Ø', UNIT_LABEL], ['len', 'length (y)', UNIT_LABEL], ['from', 'starts at y', UNIT_LABEL], ['to', 'ends at y', UNIT_LABEL]];
      for (const [f, lab, unit] of fields) {
        const inp = el('input', { 'data-unit': f === 'angle' ? 'ang' : f === 'turns' ? '' : 'len', type: 'number', step: f === 'turns' ? '0.25' : f === 'angle' ? '0.5' : '0.01', style: INP });
        inp.addEventListener('focus', () => { inp.__fresh = true; });
        const apply = (live) => {
          const v = parseFloat(inp.value), o = runOf(nodeId, ri);
          if (!isFinite(v) || !o) return;
          if (inp.__fresh !== false) pushUndo();
          inp.__fresh = false;
          setThreadValue(o.r, o.r.kind, f, f === 'angle' ? v / ANG_SCALE : v, zBase());
          syncRunPts(o.n, o.r); markEdited();
          state.liveInput = live; try { recalc(); } finally { state.liveInput = false; }
        };
        inp.addEventListener('input', () => apply(true));
        inp.addEventListener('change', () => { apply(false); inp.__fresh = false; });
        tb.inputs[f] = { inp, label: el('span', { style: 'color:#666;white-space:nowrap' }, lab) };
        body.append(tb.inputs[f].label, el('span', { style: 'white-space:nowrap' }, inp, unit ? ' ' + unit : ''));
      }
      box.append(title, body);
      tb.update = () => {
        const o = runOf(nodeId, ri); if (!o) return;
        const r = o.r, vals = threadValues(r, zBase());
        title.textContent = '';
        title.append(el('span', { style: 'color:#999' }, tb.collapsed ? '▸' : '▾'), el('span', null, (r.label || 'Thread') + ' — ' + r.kind),
          tb.collapsed ? el('span', { style: 'font-weight:400;color:#555' }, num(vals.pitch, 3) + ' ' + UNIT_LABEL + ' pitch · ' + num(vals.depth, 3) + ' deep · ' + num(vals.turns, 2) + ' turns')
            : (state.helical ? hand : el('span', { style: 'font-weight:400;color:#666' }, 'rings (helical off)')));
        hand.value = String(r.hand < 0 ? -1 : 1);
        tb.inputs.dmin.label.textContent = r.kind === 'internal' ? 'minor Ø' : 'root Ø';
        tb.inputs.dmax.label.textContent = r.kind === 'internal' ? 'major Ø' : 'crest Ø';
        for (const f in tb.inputs) {
          const inp = tb.inputs[f].inp;
          if (document.activeElement === inp) continue;   // never overwrite what the user is typing
          inp.value = f === 'angle' ? num(vals[f] * ANG_SCALE, ANG_SCALE === 1 ? 2 : 4) : num(vals[f], f === 'turns' ? 3 : 4);
        }
      };
      return tb;
    }
    function syncThreadBoxes() {
      const seen = new Set(), { w, h } = size();
      if (state.scene && state.threadCallouts && !topMode()) for (const id of frontOrder().filter(canPick)) {
        const n = state.scene.nodes[id];
        (n.runs || []).forEach((r, ri) => {
          const key = id + '|' + ri;
          seen.add(key);
          let tb = threadBoxes.get(key);
          if (!tb) { tb = makeThreadBox(id, ri); threadBoxes.set(key, tb); overlay.append(tb.box); }
          tb.update();
          // beside the thread, on its open side (inside for internal threads)
          const rMin = Math.min(r.rFirst, r.rOther), rMax = Math.max(r.rFirst, r.rOther), xf = xfOf(state.scene, id);
          const A = xf.fwd({ y: rMax, z: Math.max(r.zFirst, r.zLast) }), B = xf.fwd({ y: rMax, z: Math.min(r.zFirst, r.zLast) }), C = xf.fwd({ y: rMin, z: r.zFirst });
          const [xo, ya] = toScreen(A.y, A.z), [, yb] = toScreen(B.y, B.z), [xi] = toScreen(C.y, C.z);
          const bw = tb.box.offsetWidth || 260, bh = tb.box.offsetHeight || 120;
          let x = r.kind === 'internal' ? xi - bw - 14 : xo + 14, y = (ya + yb) / 2 - bh / 2;
          x = Math.max(AX_L + 4, Math.min(w - bw - 4, x)); y = Math.max(4, Math.min(h - AX_B - bh - 4, y));
          tb.box.style.left = x + 'px'; tb.box.style.top = y + 'px';
        });
      }
      for (const [k, tb] of threadBoxes) if (!seen.has(k)) { tb.box.remove(); threadBoxes.delete(k); }
    }

    // ---- selection box (inside the cross-section): coordinates, Translate, Scale, Rotate ----
    const selBox = el('div', { style: 'position:absolute;right:30px;top:30px;z-index:3;pointer-events:auto;background:rgba(255,255,255,.97);border:1px solid #ced4da;border-radius:6px;padding:6px 8px;font:11px/1.4 sans-serif;color:#343a40;box-shadow:0 1px 6px rgba(0,0,0,.15);width:max-content;max-width:calc(100% - 90px);box-sizing:border-box;display:none' });
    overlay.append(selBox);
    const tf = { dx: 0, dy: 0, sx: 1, sy: 1, linkScale: true, angle: 0, pivot: 'centre' };
    // The points a transform acts on: selected points/edges, or every point of the selected objects.
    function transformTargets() {
      const sc = state.scene, out = { pts: [], runs: [], nodes: [] };
      const keys = pointKeys([...state.sel]);
      if (keys.length) {
        const runSeen = new Set();
        for (const k of keys) {
          const h = parseKey(k), n = sc.nodes[h.node]; if (!n) continue;
          if (h.kind === 'p') out.pts.push({ n, i: h.i });
          else if (h.kind === 'q' || h.kind === 'qe') continue;
          else if (!runSeen.has(h.node + '|' + h.ri)) { runSeen.add(h.node + '|' + h.ri); out.runs.push({ n, r: n.runs[h.ri] }); }
        }
      } else {
        for (const id of leavesUnder(sc, topSelected(sc))) {
          const n = sc.nodes[id];
          out.nodes.push(n);
          n.pts.forEach((p, i) => { if (!inRunIndex(n, i)) out.pts.push({ n, i }); });
          (n.runs || []).forEach(r => out.runs.push({ n, r }));
        }
      }
      return out;
    }
    function pivotOf(t) {
      if (tf.pivot === 'origin') return { y: 0, z: zBase() };
      let sy = 0, sz = 0, c = 0;
      for (const { n, i } of t.pts) { const q = xfOf(state.scene, n.id).fwd(n.pts[i]); sy += q.y; sz += q.z; c++; }
      for (const { n, r } of t.runs) { const q = xfOf(state.scene, n.id).fwd({ y: (r.rFirst + r.rOther) / 2, z: (r.zFirst + r.zLast) / 2 }); sy += q.y; sz += q.z; c++; }
      return c ? { y: sy / c, z: sz / c } : { y: 0, z: 0 };
    }
    // Scale/rotate act on ordinary points; threads keep their shape and move with their centre.
    function applyTransform(kind) {
      const t = transformTargets();
      if (!t.pts.length && !t.runs.length && !(kind === 'translate' && t.nodes.some(n => n.type === 'geo'))) return;
      pushUndo();
      if (kind === 'translate') {
        const dy = tf.dx / UNIT_SCALE, dz = HS() * tf.dy / UNIT_SCALE;       // Δy as heights are shown
        if (state.sel.size) moveKeysView(state.scene, [...state.sel], dy, dz); else t.nodes.forEach(n => moveNodeView(state.scene, n.id, dy, dz));
      } else {
        const P = pivotOf(t), a = FZ() * tf.angle / ANG_SCALE * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);     // counter-clockwise as shown
        const map = kind === 'scale'
          ? (q) => ({ y: P.y + (q.y - P.y) * tf.sx, z: P.z + (q.z - P.z) * (tf.linkScale ? tf.sx : tf.sy) })
          : (q) => ({ y: P.y + (q.y - P.y) * c - (q.z - P.z) * s, z: P.z + (q.y - P.y) * s + (q.z - P.z) * c });
        for (const { n, i } of t.pts) {
          const xf = xfOf(state.scene, n.id), q = map(xf.fwd(n.pts[i])), l = xf.invP(q.y, q.z);
          n.pts[i].y = Math.max(0, l.y); n.pts[i].z = l.z; if (n.params) n.custom = true;
        }
        for (const { n, r } of t.runs) {
          const xf = xfOf(state.scene, n.id), cen = { y: (r.rFirst + r.rOther) / 2, z: (r.zFirst + r.zLast) / 2 }, q = map(xf.fwd(cen)), l = xf.invP(q.y, q.z), dy = l.y - cen.y, dz = l.z - cen.z;
          r.rFirst = Math.max(0, r.rFirst + dy); r.rOther = Math.max(0, r.rOther + dy); r.zFirst += dz; r.zLast += dz; syncRunPts(n, r);
        }
      }
      markEdited(); recalc();
    }
    let selBoxSig = null;
    function renderSelBox() {
      const any = state.scene && (state.sel.size || state.selNodes.size);
      selBtn.style.display = any ? 'inline-flex' : 'none';
      const open = any && !state.selBoxCollapsed;
      selBtn.style.background = open ? '#ddf4ff' : '#fff'; selBtn.style.borderColor = open ? '#54aeff' : '#ced4da';
      if (any) { const keys = [...state.sel], pk = pointKeys(keys), objs = topSelected(state.scene);
        selBtn.querySelector('.aa-hl').textContent = 'Selection — ' + (keys.length ? pk.length + ' point' + (pk.length === 1 ? '' : 's') + (keys.some(k => parseKey(k).kind === 'e') ? ' (with edges)' : '')
          : objs.length + ' object' + (objs.length === 1 ? '' : 's')); }
      if (!open) {
        coord.style.top = (viewBar.offsetHeight ? viewBar.offsetTop + viewBar.offsetHeight + 4 : 32) + 'px';
        if (selBox.style.display !== 'none' && selBox.animate && !reduceMotion()) {
          const a = selBox.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-6px)' }], { duration: 120, easing: 'ease-in' });
          a.onfinish = () => { if ((!state.sel.size && !state.selNodes.size) || state.selBoxCollapsed) selBox.style.display = 'none'; };
        } else selBox.style.display = 'none';
        selBoxSig = null;
        return;
      }
      const appearing = selBox.style.display === 'none';
      selBox.style.display = '';
      if (selBox.contains(document.activeElement) && /INPUT|SELECT/.test(document.activeElement.tagName)) return;
      const sig = selectionSig(), changed = sig !== selBoxSig;
      selBoxSig = sig;
      if (appearing) { buildSelBox(); animIn(selBox); }
      else if (changed) animResize(selBox, buildSelBox);
      else buildSelBox();
    }
    function buildSelBox() {
      const keys = [...state.sel], pk = pointKeys(keys), base = zBase();
      const btn = (kind) => el('button', { type: 'button', style: BTN2 + ';padding:2px 8px;font-size:11px', onclick: () => applyTransform(kind) }, 'Apply');
      // columns: name | label | field | label | field | note | Apply
      const grid = el('div', { style: 'display:grid;grid-template-columns:58px 30px 64px 30px 64px max-content auto;gap:3px 5px;align-items:center' });
      const cell = (x) => x == null ? el('span') : typeof x === 'string' ? el('span', { style: 'color:#666;white-space:nowrap' }, x) : x;
      const add = (name, c, kind) => {
        grid.append(el('b', { style: 'white-space:nowrap' }, name));
        if (c.span) grid.append(el('span', { style: 'grid-column:2 / 7;display:flex;gap:4px;align-items:center' }, ...c.span));
        else for (let i = 0; i < 5; i++) grid.append(cell(c[i]));
        grid.append(kind ? btn(kind) : el('span'));
      };
      selBox.textContent = '';
      if (pk.length === 1 && parseKey(pk[0]).kind === 'p') {
        const h = parseKey(pk[0]), p = xfOf(state.scene, h.node).fwd(state.scene.nodes[h.node].pts[h.i]);
        const live = (val, set) => { const i = el('input', { 'data-unit': 'len', type: 'number', step: '0.01', value: num(val, 4), style: 'width:64px;font-size:11px;box-sizing:border-box' });
          i.addEventListener('focus', () => { i.__fresh = true; });
          const go = (liveInput) => { const v = parseFloat(i.value); if (!isFinite(v)) return; if (i.__fresh !== false) pushUndo(); i.__fresh = false; set(v); markEdited(); state.liveInput = liveInput; try { recalc(); } finally { state.liveInput = false; } };
          i.addEventListener('input', () => go(true)); i.addEventListener('change', () => { go(false); i.__fresh = false; }); return i; };
        const cur = () => xfOf(state.scene, h.node).fwd(state.scene.nodes[h.node].pts[h.i]);
        add('Point', ['x r', live(mm(p.y), v => moveKeysView(state.scene, pk, v / UNIT_SCALE - cur().y, 0)), 'Ø', live(mm(2 * p.y), v => moveKeysView(state.scene, pk, v / 2 / UNIT_SCALE - cur().y, 0)), UNIT_LABEL], null);
        add('', ['y', live(hDisp(p.z, base), v => moveKeysView(state.scene, pk, 0, hInv(v, base) - cur().z)), null, null, UNIT_LABEL], null);
      }
      const inp = (key, o = {}) => {
        const i = el('input', { 'data-unit': key === 'dx' || key === 'dy' ? 'len' : key === 'angle' ? 'ang' : '', type: 'number', step: o.step || '0.1', value: num(tf[key], 4), style: 'width:64px;font-size:11px;box-sizing:border-box', title: o.title || null });
        i.addEventListener('change', () => { const v = parseFloat(i.value); if (isFinite(v)) tf[key] = v; else i.value = num(tf[key], 4); });
        return i;
      };
      add('Translate', ['Δx', inp('dx', { title: 'radius change (' + UNIT_LABEL + ')' }), 'Δy', inp('dy', { title: 'height change (' + UNIT_LABEL + ')' }), UNIT_LABEL], 'translate');
      const link = el('input', { type: 'checkbox' }); link.checked = tf.linkScale;
      link.addEventListener('change', () => { tf.linkScale = link.checked; buildSelBox(); });
      const uni = el('label', { style: 'cursor:pointer;display:inline-flex;gap:3px;align-items:center;white-space:nowrap' }, link, 'uniform');
      add('Scale', tf.linkScale ? ['×', inp('sx', { step: '0.05' }), null, null, uni] : ['× x', inp('sx', { step: '0.05' }), '× y', inp('sy', { step: '0.05' }), uni], 'scale');
      add('Rotate', [ANG_LABEL.trim(), inp('angle', { step: ANG_SCALE === 1 ? '1' : '0.01', title: (ANG_SCALE === 1 ? 'degrees' : 'radians') + ', counter-clockwise' }), null, null, 'counter-clockwise'], 'rotate');
      const piv = el('select', { style: 'font-size:11px;max-width:100%' }, el('option', { value: 'centre' }, 'selection centre'), el('option', { value: 'origin' }, 'axis at height 0'));
      piv.value = tf.pivot; piv.addEventListener('change', () => { tf.pivot = piv.value; });
      add('About', { span: [piv] }, null);
      selBox.append(grid);
      coord.style.top = (selBox.offsetTop + selBox.offsetHeight + 4) + 'px';
    }

    // ---- pointer interaction ----
    svg.addEventListener('contextmenu', (e) => e.preventDefault());
    // ---- Measurements: rulers on the cross-section views, kept with the scene ----
    // scene.measures = { pts: { id: { v: 'side' | 'top', x, y, call?, co? } }, segs: { id: { a, b, call?, co? } } }
    // (side: x across the view, signed, and y the height; top: the scene's x and y). In the Measurement view only they can
    // be worked on; the part is drawn monomorphic, its points still there to snap to (Ctrl).
    const mView = () => topMode() ? 'top' : 'side';
    function measures() {
      const sc = state.scene;
      if (!sc.measures || typeof sc.measures !== 'object') sc.measures = { pts: {}, segs: {} };
      if (!sc.measures.pts) sc.measures.pts = {};
      if (!sc.measures.segs) sc.measures.segs = {};
      if (!sc.measures.angs) sc.measures.angs = {};
      if (!sc.measures.rads) sc.measures.rads = {};
      return sc.measures;
    }
    // (side-view measurements can be pinned to a section angle: shown only there, marked on the compass)
    function angNear(a, b) { return Math.abs((((a - b) % 360) + 540) % 360 - 180) < 0.26; }
    // (overhead ones to the heights shown from above, the band on the slider at the right)
    function curCut() { const c = state.topCut || { lo: 0, hi: 1 }; return [Math.max(0, Math.min(1, c.lo)), Math.max(0, Math.min(1, c.hi))]; }
    function cutNear(a, b) { return Math.abs(a[0] - b[0]) < 0.004 && Math.abs(a[1] - b[1]) < 0.004; }
    const mVisible = (P) => !!P && P.v === mView() && (P.v === 'side' ? P.ang == null || angNear(P.ang, state.viewAngle) : !P.cut || cutNear(P.cut, curCut()));
    const mObj = (ref) => { const M = measures(); return !ref ? null : ref.kind === 'p' ? M.pts[ref.id] : ref.kind === 's' ? M.segs[ref.id] : ref.kind === 'r' ? M.rads[ref.id] : M.angs[ref.id]; };
    // the points a measurement joins up with (through rulers and angles)
    function mGroup(ref) {
      const M = measures(), pts = new Set(), seen = new Set();
      const start = ref.kind === 'p' ? [ref.id] : ref.kind === 's' ? [M.segs[ref.id].a, M.segs[ref.id].b] : ref.kind === 'r' ? [M.rads[ref.id].a, M.rads[ref.id].b] : [M.angs[ref.id].a, M.angs[ref.id].o, M.angs[ref.id].b];
      const st = start.filter(Boolean);
      while (st.length) {
        const p = st.pop(); if (pts.has(p)) continue; pts.add(p);
        for (const [k, s] of Object.entries(M.segs)) if (!seen.has(k) && (s.a === p || s.b === p)) { seen.add(k); st.push(s.a, s.b); }
        for (const [k, a] of Object.entries(M.angs)) if (!seen.has(k) && [a.a, a.o, a.b].includes(p)) { seen.add(k); st.push(...[a.a, a.o, a.b].filter(Boolean)); }
        for (const [k, r] of Object.entries(M.rads)) if (!seen.has(k) && (r.a === p || r.b === p)) { seen.add(k); st.push(r.a, r.b); }
      }
      return pts;
    }
    // the section angles measurements are pinned to
    function pinnedCuts() { if (!state.scene || !state.scene.measures) return []; const out = []; for (const p of Object.values(state.scene.measures.pts || {})) if (p.v === 'top' && p.cut && !out.some(c => cutNear(c, p.cut))) out.push(p.cut); return out; }
    function pinnedAngles() { if (!state.scene || !state.scene.measures) return []; const out = []; for (const p of Object.values(state.scene.measures.pts || {})) if (p.v === 'side' && p.ang != null && !out.some(a => angNear(a, p.ang))) out.push(p.ang); return out; }
    // a section angle drawn to a pinned one when it comes close (within a few pixels of the compass tape)
    function pinMagnet(deg) { for (const a of pinnedAngles()) { const d = (((deg - a) % 360) + 540) % 360 - 180; if (Math.abs(d) < 2.5) return deg - d; } return deg; }
    let mSel = null, mConnect = null, mHoverSnap = null, mExporting = false;
    const mId = (pre) => pre + Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 6);
    const mScreen = (P) => { const M0 = MS; MS = 1; const r = toScreen(P.x, P.y); MS = M0; return r; };
    const mWorld = (sx, sy) => { const M0 = MS; MS = 1; const r = toWorld(sx, sy); MS = M0; return r; };
    const mAng = (v) => num(v * ANG_SCALE, ANG_SCALE === 1 ? 1 : 4) + ANG_LABEL;
    const mLen = (v) => num(mm(v), 3) + ' ' + UNIT_LABEL;
    // the points of the part (and other measurements) to snap to
    function mTargets(except) {
      const T = [], v = mView();
      if (v === 'top') {
        for (const h of topHandles(true)) if (isFinite(h.x) && isFinite(h.y)) T.push([h.x, h.y]);
        T.push([0, 0]);
      } else {
        for (const id of sliceOff() ? [] : frontOrder()) {
          const n = state.scene.nodes[id];
          if (n.type === 'geo') { for (const c of geoSidePts(id).pts) T.push([c.along, c.z]); continue; }
          for (const h of handlesOf(id)) { T.push([h.y, h.z]); T.push([-h.y, h.z]); }
        }
        const loops = meshSection(state.viewAngle * Math.PI / 180, sliceOff() || 0);
        if (loops) for (const L of loops) for (const p of L) T.push([p[0], p[1]]);
        T.push([0, zBase()]);
      }
      for (const [id, p] of Object.entries(measures().pts)) if (mVisible(p) && id !== except) T.push([p.x, p.y]);
      return T;
    }
    // onto a point near; else level or upright with one (each way on its own); { p, mark, lines }
    function mSnap(P, T) {
      const thr = snapThr();
      let best = null, bd = thr;
      for (const t of T) { const d = Math.hypot(t[0] - P[0], t[1] - P[1]); if (d < bd) { bd = d; best = t; } }
      if (best) return { p: [best[0], best[1]], mark: best, lines: [] };
      let bx = null, by = null;
      for (const t of T) {
        if (Math.abs(t[0] - P[0]) < thr && (!bx || Math.abs(t[0] - P[0]) < Math.abs(bx[0] - P[0]))) bx = t;
        if (Math.abs(t[1] - P[1]) < thr && (!by || Math.abs(t[1] - P[1]) < Math.abs(by[1] - P[1]))) by = t;
      }
      const p = [bx ? bx[0] : P[0], by ? by[1] : P[1]], lines = [];
      if (bx) lines.push([bx, p]);
      if (by) lines.push([by, p]);
      return { p, mark: bx || by ? p : null, lines };
    }
    function mSegExists(a, b) { return Object.values(measures().segs).some(s => (s.a === a && s.b === b) || (s.a === b && s.b === a)); }
    function mChanged() { state.edited = true; rememberScene(); drawSection(); }
    // removes a point and its rulers; a ruler and the points it leaves alone
    function mDelete(sel) {
      const M = measures();
      if (sel.kind === 'p') {
        delete M.pts[sel.id];
        for (const [k, s] of Object.entries(M.segs)) if (s.a === sel.id || s.b === sel.id) delete M.segs[k];
        for (const [k, a] of Object.entries(M.angs)) if ([a.a, a.o, a.b].includes(sel.id)) delete M.angs[k];
        for (const [k, r] of Object.entries(M.rads)) if (r.a === sel.id || r.b === sel.id) delete M.rads[k];
      } else if (sel.kind === 's') delete M.segs[sel.id];
      else if (sel.kind === 'r') delete M.rads[sel.id];
      else delete M.angs[sel.id];
      mTidy();
    }
    // points left with nothing joined to them go
    // a point put where another already is becomes that one (what joined it joins the other); nothing repeated
    function mMerge(pid) {
      const M = measures(), P = M.pts[pid]; if (!P || !mVisible(P)) return pid;
      const [x, y] = mScreen(P);
      for (const [k, Q] of Object.entries(M.pts)) {
        if (k === pid || !mVisible(Q)) continue;
        const [qx, qy] = mScreen(Q);
        if (Math.hypot(qx - x, qy - y) >= 2.5) continue;
        for (const s of Object.values(M.segs)) { if (s.a === pid) s.a = k; if (s.b === pid) s.b = k; }
        for (const a of Object.values(M.angs)) for (const f of ['a', 'o', 'b']) if (a[f] === pid) a[f] = k;
        for (const r of Object.values(M.rads)) { if (r.a === pid) r.a = k; if (r.b === pid) r.b = k; }
        delete M.pts[pid]; mDedupe(); return k;
      }
      return pid;
    }
    function mDedupe() {
      const M = measures(), ss = new Set(), sa = new Set();
      for (const [k, s] of Object.entries(M.segs)) { const key = [s.a, s.b].sort().join('|'); if (s.a === s.b || ss.has(key)) delete M.segs[k]; else ss.add(key); }
      for (const [k, a] of Object.entries(M.angs)) { const key = a.o + '|' + [a.a || '', a.b].sort().join('|'); if (a.o === a.b || a.a === a.b || a.a === a.o || sa.has(key)) delete M.angs[k]; else sa.add(key); }
      mTidy();
    }
    function mTidy() {
      const M = measures(), used = new Set();
      for (const s of Object.values(M.segs)) used.add(s.a), used.add(s.b);
      for (const a of Object.values(M.angs)) for (const p of [a.a, a.o, a.b]) if (p) used.add(p);
      for (const r of Object.values(M.rads)) used.add(r.a), used.add(r.b);
      for (const k of Object.keys(M.pts)) if (!used.has(k)) delete M.pts[k];
    }
    function mClear(viewOnly) {
      const M = measures();
      for (const [k, p] of Object.entries(M.pts)) if (!viewOnly || mVisible(p)) delete M.pts[k];
      for (const [k, s] of Object.entries(M.segs)) if (!M.pts[s.a] || !M.pts[s.b]) delete M.segs[k];
      for (const [k, a] of Object.entries(M.angs)) if ((a.a && !M.pts[a.a]) || !M.pts[a.o] || !M.pts[a.b]) delete M.angs[k];
      for (const [k, r] of Object.entries(M.rads)) if (!M.pts[r.a] || !M.pts[r.b]) delete M.rads[k];
    }
    // the circle through three places (x, y), or null when they are in a line
    function circle3(a, b, c) {
      const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
      if (Math.abs(d) < 1e-14) return null;
      const A2 = a[0] * a[0] + a[1] * a[1], B2 = b[0] * b[0] + b[1] * b[1], C2 = c[0] * c[0] + c[1] * c[1];
      const x = (A2 * (b[1] - c[1]) + B2 * (c[1] - a[1]) + C2 * (a[1] - b[1])) / d, y = (A2 * (c[0] - b[0]) + B2 * (a[0] - c[0]) + C2 * (b[0] - a[0])) / d;
      return { c: [x, y], r: Math.hypot(a[0] - x, a[1] - y) };
    }
    // the part's outline points in this view (round bevels as true arcs), to find an arc on
    function mOutlinePts() {
      const was = ARC_PERFECT; ARC_PERFECT = true;
      const T = [];
      try {
        if (topMode()) { for (const it of topItems()) for (const sh of it.shapes || []) for (const L of [sh.outer, sh.inner]) if (L) for (const p of L) if (p && isFinite(p[0])) T.push([p[0], p[1]]); }
        else for (const id of frontOrder()) {
          const n = state.scene.nodes[id];
          if (n.type === 'geo') { for (const L of geoSection(id)) for (const p of L) T.push([p[0], p[1]]); continue; }
          for (const p of viewOutline(state.scene, id)) { T.push([p.y, p.z]); T.push([-p.y, p.z]); }
        }
      } finally { ARC_PERFECT = was; }
      return T;
    }
    // a radius measurement from a drag across an arc: the arc's point half way between the ends picked, and the
    // circle through the three
    function mRadiusOf(d) {
      const T = d.O || (d.O = mOutlinePts());
      // the ends onto the outline when near it (the arc's own points, drawn true)
      const onto = (P) => { const [px, py] = mScreen({ x: P[0], y: P[1] }); let best = null, bd = 6; for (const t of T) { const [x, y] = mScreen({ x: t[0], y: t[1] }), dd = Math.hypot(x - px, y - py); if (dd < bd) { bd = dd; best = t; } } return best || P; };
      const A = onto(d.A), B = onto(d.B), [ax, ay] = mScreen({ x: A[0], y: A[1] }), [bx, by] = mScreen({ x: B[0], y: B[1] });
      const L = Math.hypot(bx - ax, by - ay); if (L < 4) return null;
      const ux = (bx - ax) / L, uy = (by - ay) / L;
      let best = null, bt = 1;
      for (const t of T) {
        const [x, y] = mScreen({ x: t[0], y: t[1] }), along = ((x - ax) * ux + (y - ay) * uy) / L, off = Math.abs(-(x - ax) * uy + (y - ay) * ux);
        if (along < 0.1 || along > 0.9 || off < 0.4 || off > L) continue;
        if (Math.abs(along - 0.5) < bt) { bt = Math.abs(along - 0.5); best = t; }
      }
      if (!best) return null;
      const C = circle3(A, best, B);
      return C ? { a: A, b: B, m: best, ...C } : null;
    }

    // drawn over the view (only in the Measurement view)
    function drawMeasures() {
      if (!state.measure || !state.scene || !view) return;
      const M = measures(), v = mView(), g = sv('g', { id: 'aa-measures' }), INK = '#1864ab', PTC = '#0c8599', ANG = '#7048e8', SEL = '#e03131';
      svg.append(g);
      const { w: VW, h: VH } = size(), halo = { 'paint-order': 'stroke', stroke: '#fff', 'stroke-width': 3, 'stroke-linejoin': 'round' };
      // an angle worth showing: not along or across the view (0, 90, 180, 270 …)
      const square = (deg) => { const r = ((deg % 90) + 90) % 90; return r < 0.05 || r > 89.95; };
      // where the part is (labels that have to move off it become callouts)
      const loops = v === 'side' ? meshSection(state.viewAngle * Math.PI / 180, sliceOff() || 0) : null;
      const onModel = (sx, sy) => { const [X, Y] = mWorld(sx, sy); return v === 'side' ? !!(loops && inLoops(X, Y, loops)) : !!topNodeAt(X, Y); };
      // what labels must keep clear of: points, ruler lines, labels already placed
      const boxes = [], segs = [];
      const textW = (lines) => Math.max(...lines.map(s => s.length)) * 6.3 + 6, textH = (lines) => lines.length * 13 + 3;
      const hitBox = (b) => {
        if (b.x0 < AX_L || b.y0 < 0 || b.x1 > VW - 34 || b.y1 > VH - AX_B) return true;   // (clear of the height slider on the right)
        for (const o of boxes) if (b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0) return true;
        for (const s of segs) {
          if (s.own === b.own && b.own != null) continue;
          // the segment against the box (a few samples along it)
          for (let k = 0; k <= 8; k++) { const x = s[0] + (s[2] - s[0]) * k / 8, y = s[1] + (s[3] - s[1]) * k / 8; if (x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1) return true; }
        }
        return false;
      };
      boxes.push({ x0: AX_L, y0: 26, x1: AX_L + 260, y1: 58 });   // (the key, top left)
      const offModel = (b) => !onModel(b.x0, b.y0) && !onModel(b.x1, b.y0) && !onModel(b.x0, b.y1) && !onModel(b.x1, b.y1) && !onModel((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
      const reqs = [], drawn = [];
      // two rulers over each other (along the same line, overlapping): the later one is set off to the side, with
      // extension lines back to its points, as dimension lines are
      const overlaps = (a, b) => {
        const La = Math.hypot(a[2] - a[0], a[3] - a[1]), Lb = Math.hypot(b[2] - b[0], b[3] - b[1]);
        if (La < 1 || Lb < 1) return false;
        const ux = (a[2] - a[0]) / La, uy = (a[3] - a[1]) / La, vx = (b[2] - b[0]) / Lb, vy = (b[3] - b[1]) / Lb;
        if (Math.abs(ux * vy - uy * vx) > 0.035) return false;
        const dist = (x, y) => Math.abs((x - a[0]) * -uy + (y - a[1]) * ux);
        if (dist(b[0], b[1]) > 6 || dist(b[2], b[3]) > 6) return false;
        const t = (x, y) => (x - a[0]) * ux + (y - a[1]) * uy, t0 = Math.min(t(b[0], b[1]), t(b[2], b[3])), t1 = Math.max(t(b[0], b[1]), t(b[2], b[3]));
        return Math.min(t1, La) - Math.max(t0, 0) > 4;
      };
      const ruler = (A, B, o) => {
        let [x1, y1] = mScreen(A), [x2, y2] = mScreen(B);
        const L = Math.hypot(x2 - x1, y2 - y1);
        if (!o.temp && L > 1) {
          const nx = -(y2 - y1) / L, ny = (x2 - x1) / L, p1 = [x1, y1], p2 = [x2, y2];
          for (let k = 1, tries = 0; drawn.some(d => overlaps(d, [x1, y1, x2, y2])) && tries < 12; tries++) {
            const off = (tries % 2 ? -1 : 1) * 14 * k; if (tries % 2) k++;
            x1 = p1[0] + nx * off; y1 = p1[1] + ny * off; x2 = p2[0] + nx * off; y2 = p2[1] + ny * off;
          }
          if (x1 !== p1[0] || y1 !== p1[1]) {
            const ex = Math.sign(x1 - p1[0]) * 3, ey = Math.sign(y1 - p1[1]) * 3;
            for (const [a, b] of [[p1, [x1, y1]], [p2, [x2, y2]]]) g.append(sv('line', { x1: a[0] + ex * 0.6, y1: a[1] + ey * 0.6, x2: b[0] + ex, y2: b[1] + ey, stroke: o.col, 'stroke-width': 0.8 }));
          }
          drawn.push([x1, y1, x2, y2]);
        }
        g.append(sv('line', { x1, y1, x2, y2, stroke: o.col, 'stroke-width': 1.3, ...(o.temp ? { 'stroke-dasharray': '5 3' } : {}) }));
        if (L > 1e-6) {
          const ux = (x2 - x1) / L, uy = (y2 - y1) / L, ah = Math.min(9, L / 3), aw = ah * 0.38;
          for (const [px, py, sx] of [[x1, y1, 1], [x2, y2, -1]])
            g.append(sv('path', { d: 'M' + px + ' ' + py + 'L' + (px + sx * ux * ah - uy * aw) + ' ' + (py + sx * uy * ah + ux * aw) + 'L' + (px + sx * ux * ah + uy * aw) + ' ' + (py + sx * uy * ah - ux * aw) + 'Z', fill: o.col }));
        }
        if (!o.temp) { const hl = sv('line', { x1, y1, x2, y2, stroke: 'transparent', 'stroke-width': 9, style: 'cursor:pointer' }); hl.__mseg = o.id; g.append(hl); }
        const sg = [x1, y1, x2, y2]; sg.own = o.id; segs.push(sg);
        // its length, and its angle to the view's level when that says something
        let ang = Math.atan2(-(y2 - y1), x2 - x1) * 180 / Math.PI; ang = ((ang % 180) + 180) % 180;
        const hd = o.hide || {}, showAng = hd.ang === false || (hd.ang == null && !square(ang));
        const text = [[hd.len ? '' : mLen(Math.hypot(B.x - A.x, B.y - A.y)), showAng ? mAng(ang) : ''].filter(Boolean).join('  ')];
        let rot = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI; if (rot > 90) rot -= 180; if (rot <= -90) rot += 180;
        const rr = rot * Math.PI / 180, nx = Math.sin(rr), ny = -Math.cos(rr), tw = textW(text);
        // along the line, either side of it, at its middle or toward its ends
        const cands = [];
        for (const t of [0.5, 0.33, 0.67, 0.2, 0.8]) for (const side of [1, -1]) {
          const cx = x1 + (x2 - x1) * t + nx * side * 9, cy = y1 + (y2 - y1) * t + ny * side * 9;
          const hw = (Math.abs(Math.cos(rr)) * tw + Math.abs(Math.sin(rr)) * 13) / 2, hh = (Math.abs(Math.sin(rr)) * tw + Math.abs(Math.cos(rr)) * 13) / 2;
          if (tw > L - 6 && t !== 0.5) continue;
          cands.push({ x: cx, y: cy + 4, box: { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh, own: o.id }, anchor: 'middle', rot });
        }
        if (!o.temp && text[0]) reqs.push({ ax: (x1 + x2) / 2, ay: (y1 + y2) / 2, lines: text, o, cands, w: tw, h: textH(text) });
        else for (const t of [sv('text', { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 8, 'font-size': 11, fill: o.col, 'text-anchor': 'middle', ...halo, 'pointer-events': 'none' })]) { t.textContent = text[0]; g.append(t); }
      };
      const twice = new Set(), at2 = (P) => mScreen(P).map(v => Math.round(v * 2)).join(',');
      for (const [sid, s] of Object.entries(M.segs)) {
        const A = M.pts[s.a], B = M.pts[s.b]; if (!mVisible(A) || !mVisible(B)) continue;
        const key = [at2(A), at2(B)].sort().join('|'); if (twice.has(key)) continue; twice.add(key);
        const on = !mExporting && mSel && mSel.kind === 's' && mSel.id === sid;
        ruler(A, B, { id: sid, col: on ? SEL : INK, call: s.call, co: s.co, ref: { kind: 's', id: sid }, hide: s.hide || {} });
      }
      // angle measurements: about a point, between two others (or from the view's level)
      const angleMark = (O, A, B, o) => {
        const [px, py] = mScreen(O), [bx, by] = mScreen(B);
        let ax, ay;
        if (A) [ax, ay] = mScreen(A); else { ax = px + (bx >= px ? 40 : -40); ay = py; }
        const a0 = Math.atan2(ay - py, ax - px); let da = Math.atan2(by - py, bx - px) - a0;
        while (da > Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        const deg = Math.abs(da) * 180 / Math.PI, r = 24;
        g.append(sv('line', { x1: px, y1: py, x2: ax, y2: ay, stroke: o.col, 'stroke-width': A ? 1 : 0.8, ...(A ? {} : { 'stroke-dasharray': '4 3' }) }));
        g.append(sv('line', { x1: px, y1: py, x2: bx, y2: by, stroke: o.col, 'stroke-width': 1, ...(o.temp ? { 'stroke-dasharray': '5 3' } : {}) }));
        const arc = 'M' + (px + r * Math.cos(a0)) + ' ' + (py + r * Math.sin(a0)) + 'A' + r + ' ' + r + ' 0 0 ' + (da > 0 ? 1 : 0) + ' ' + (px + r * Math.cos(a0 + da)) + ' ' + (py + r * Math.sin(a0 + da));
        g.append(sv('path', { d: arc, fill: 'none', stroke: o.col, 'stroke-width': 1.4 }));
        if (!o.temp) { const hp = sv('path', { d: arc, fill: 'none', stroke: 'transparent', 'stroke-width': 10, style: 'cursor:pointer' }); hp.__mang = o.id; g.append(hp); }
        segs.push(Object.assign([px, py, bx, by], { own: o.id }));
        if (A) segs.push(Object.assign([px, py, ax, ay], { own: o.id }));
        const am = a0 + da / 2, text = ['∠ ' + mAng(deg)], tw = textW(text), cands = [];
        for (const rad of [r + 14, r + 28, r + 44]) { const cx = px + rad * Math.cos(am), cy = py + rad * Math.sin(am); cands.push({ x: cx, y: cy + 4, box: { x0: cx - tw / 2, y0: cy - 7, x1: cx + tw / 2, y1: cy + 7 }, anchor: 'middle' }); }
        if (o.temp) { const t = sv('text', { x: cands[0].x, y: cands[0].y, 'font-size': 11, fill: o.col, 'text-anchor': 'middle', ...halo, 'pointer-events': 'none' }); t.textContent = text[0]; g.append(t); return; }
        reqs.push({ ax: px + r * Math.cos(am), ay: py + r * Math.sin(am), lines: text, o, cands, w: tw, h: textH(text) });
      };
      // radius measurements: the arc picked, its centre marked, a line from the centre to the arc with R …
      const RAD = '#d6336c';
      for (const [rid, rd] of Object.entries(M.rads)) {
        const A = M.pts[rd.a], B = M.pts[rd.b]; if (!mVisible(A) || !mVisible(B) || !rd.m) continue;
        const C = circle3([A.x, A.y], rd.m, [B.x, B.y]); if (!C) continue;
        const on = !mExporting && mSel && mSel.kind === 'r' && mSel.id === rid, col = on ? SEL : RAD;
        const [cx, cy] = mScreen({ x: C.c[0], y: C.c[1] }), [x1, y1] = mScreen(A), [x2, y2] = mScreen(B), [mx, my] = mScreen({ x: rd.m[0], y: rd.m[1] });
        const R = Math.hypot(x1 - cx, y1 - cy);
        // the arc from A through m to B
        const cross = (x1 - cx) * (my - cy) - (y1 - cy) * (mx - cx), a1 = Math.atan2(y1 - cy, x1 - cx), a2 = Math.atan2(y2 - cy, x2 - cx), am = Math.atan2(my - cy, mx - cx);
        const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), sweep = cross > 0 ? 1 : 0;
        const span = sweep ? norm(a2 - a1) : norm(a1 - a2), large = span > Math.PI ? 1 : 0;
        const arcD = 'M' + x1 + ' ' + y1 + 'A' + R + ' ' + R + ' 0 ' + large + ' ' + sweep + ' ' + x2 + ' ' + y2;
        g.append(sv('path', { d: arcD, fill: 'none', stroke: col, 'stroke-width': 2.2, opacity: 0.85 }));
        const hp = sv('path', { d: arcD, fill: 'none', stroke: 'transparent', 'stroke-width': 10, style: 'cursor:pointer' }); hp.__mrad = rid; g.append(hp);
        g.append(sv('path', { d: 'M' + (cx - 5) + ' ' + cy + 'h10M' + cx + ' ' + (cy - 5) + 'v10', stroke: col, 'stroke-width': 1.2 }));
        // the radius line, from the centre to the arc's middle, arrow at the arc
        const ex = cx + R * Math.cos(am), ey = cy + R * Math.sin(am), ux = Math.cos(am), uy = Math.sin(am), ah = Math.min(9, R / 3), aw = ah * 0.38;
        g.append(sv('line', { x1: cx, y1: cy, x2: ex, y2: ey, stroke: col, 'stroke-width': 1.2 }));
        g.append(sv('path', { d: 'M' + ex + ' ' + ey + 'L' + (ex - ux * ah - uy * aw) + ' ' + (ey - uy * ah + ux * aw) + 'L' + (ex - ux * ah + uy * aw) + ' ' + (ey - uy * ah - ux * aw) + 'Z', fill: col }));
        segs.push(Object.assign([cx, cy, ex, ey], { own: rid }));
        const text = ['R ' + mLen(C.r)], tw = textW(text), cands = [];
        for (const k of [0.5, 0.3, 0.7]) for (const sd of [1, -1]) { const px = cx + (ex - cx) * k - uy * sd * 9, py = cy + (ey - cy) * k + ux * sd * 9; cands.push({ x: px, y: py + 4, box: { x0: px - tw / 2, y0: py - 7, x1: px + tw / 2, y1: py + 7 }, anchor: 'middle' }); }
        for (const k of [1.25, 1.5]) { const px = cx + (ex - cx) * k, py = cy + (ey - cy) * k; cands.push({ x: px, y: py + 4, box: { x0: px - tw / 2, y0: py - 7, x1: px + tw / 2, y1: py + 7 }, anchor: 'middle' }); }
        reqs.push({ ax: (cx + ex) / 2, ay: (cy + ey) / 2, lines: text, o: { col, call: rd.call, co: rd.co, ref: { kind: 'r', id: rid } }, cands, w: tw, h: textH(text) });
      }
      for (const [aid, a] of Object.entries(M.angs)) {
        const O = M.pts[a.o], A = a.a ? M.pts[a.a] : null, B = M.pts[a.b];
        if (!mVisible(O) || !mVisible(B) || (a.a && !mVisible(A))) continue;
        const on = !mExporting && mSel && mSel.kind === 'a' && mSel.id === aid;
        angleMark(O, A, B, { id: aid, col: on ? SEL : ANG, call: a.call, co: a.co, ref: { kind: 'a', id: aid } });
      }
      // where two rulers meet: the angle between them (nothing when it is square: 90° or 180°)
      const at = {};
      for (const s of Object.values(M.segs)) if (mVisible(M.pts[s.a]) && mVisible(M.pts[s.b])) for (const [p, q] of [[s.a, s.b], [s.b, s.a]]) (at[p] = at[p] || []).push(q);
      for (const [pid, others] of Object.entries(at)) {
        const P = M.pts[pid]; if (!mVisible(P) || others.length !== 2) continue;
        const [px, py] = mScreen(P), [ax, ay] = mScreen(M.pts[others[0]] || P), [bx, by] = mScreen(M.pts[others[1]] || P);
        const a0 = Math.atan2(ay - py, ax - px); let da = Math.atan2(by - py, bx - px) - a0;
        while (da > Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        const deg = Math.abs(da) * 180 / Math.PI;
        if (deg < 0.05 || deg > 179.95) continue;
        // (square to each other, 90° or 180°: says nothing, not drawn)
        if (square(deg)) continue;
        const r = 20;
        g.append(sv('path', { d: 'M' + (px + r * Math.cos(a0)) + ' ' + (py + r * Math.sin(a0)) + 'A' + r + ' ' + r + ' 0 0 ' + (da > 0 ? 1 : 0) + ' ' + (px + r * Math.cos(a0 + da)) + ' ' + (py + r * Math.sin(a0 + da)), fill: 'none', stroke: ANG, 'stroke-width': 1 }));
        const am = a0 + da / 2, text = [mAng(deg)], tw = textW(text), cands = [];
        for (const rad of [r + 12, r + 24]) { const cx = px + rad * Math.cos(am), cy = py + rad * Math.sin(am); cands.push({ x: cx, y: cy + 4, box: { x0: cx - tw / 2, y0: cy - 7, x1: cx + tw / 2, y1: cy + 7 }, anchor: 'middle' }); }
        reqs.push({ ax: px + r * Math.cos(am), ay: py + r * Math.sin(am), lines: text, o: { col: ANG }, cands, w: tw, h: textH(text) });
      }
      // the points: radius and height (across and up), or radius and angle (from above)
      const dots = [], placed = [];
      for (const [pid, P] of Object.entries(M.pts)) {
        if (!mVisible(P)) continue;
        const [x, y] = mScreen(P), on = !mExporting && ((mSel && mSel.kind === 'p' && mSel.id === pid) || mConnect === pid), col = on ? SEL : PTC;
        // (points in the same place: one marker, one label)
        if (placed.some(q => Math.hypot(q[0] - x, q[1] - y) < 2.5)) continue;
        placed.push([x, y]);
        boxes.push({ x0: x - 5, y0: y - 5, x1: x + 5, y1: y + 5 });
        // a point is its place: (radius, height) across and up, or (radius, angle) from above; one of them alone is named
        const ph = P.hide || {}, rTxt = num(mm(v === 'side' ? Math.abs(P.x) : Math.hypot(P.x, P.y)), 3), sTxt = v === 'side' ? num(hDisp(P.y, zBase()), 3) : mAng(((Math.atan2(P.y, P.x) * 180 / Math.PI) + 360) % 360);
        const text = [!ph.a && !ph.b ? (v === 'side' ? '(' + rTxt + ', ' + sTxt + ') ' + UNIT_LABEL : '(' + rTxt + ' ' + UNIT_LABEL + ', ' + sTxt + ')')
          : !ph.a ? 'radius ' + rTxt + ' ' + UNIT_LABEL : !ph.b ? (v === 'side' ? 'height ' + sTxt + ' ' + UNIT_LABEL : 'angle ' + sTxt) : ''];
        dots.push({ pid, x, y, on, col });
        if (!text[0]) continue;
        const tw = textW(text), th = textH(text), cands = [];
        for (const [dx, dy, an] of [[7, -9, 'start'], [-7, -9, 'end'], [7, 15, 'start'], [-7, 15, 'end']]) {
          const x0 = an === 'start' ? x + dx - 2 : x + dx - tw + 2;
          cands.push({ x: x + dx, y: y + dy, box: { x0, y0: y + dy - 11, x1: x0 + tw, y1: y + dy + th - 11 }, anchor: an });
        }
        reqs.push({ ax: x, ay: y, lines: text, o: { col, call: P.call, co: P.co, ref: { kind: 'p', id: pid } }, cands, w: tw, h: th });
      }
      // labels: each where it is clear, else a callout, its box set off the part where there is room
      const callout = (rq, co, auto) => {
        const { ax, ay, lines, o } = rq, bx = ax + co[0], by = ay + co[1], w = rq.w + 4, h = rq.h + 3;
        const left = co[0] < 0 ? bx - w : bx, top = by - h / 2;
        boxes.push({ x0: left, y0: top, x1: left + w, y1: top + h });
        g.append(sv('line', { x1: ax, y1: ay, x2: co[0] < 0 ? left + w : left, y2: by, stroke: o.col, 'stroke-width': 1 }));
        g.append(sv('circle', { cx: ax, cy: ay, r: 1.8, fill: o.col }));
        const box = sv('rect', { x: left, y: top, width: w, height: h, rx: 3, fill: '#fff', stroke: o.col, 'stroke-width': 1, style: o.ref ? 'cursor:move' : '' });
        if (o.ref) box.__mcall = o.ref;
        box.__mauto = auto; box.__co = co;
        g.append(box);
        lines.forEach((s, i) => { const t = sv('text', { x: left + 5, y: top + 13 + i * 13, 'font-size': 11, fill: o.col, 'pointer-events': 'none' }); t.textContent = s; g.append(t); });
      };
      for (const rq of reqs) {
        const { o } = rq;
        if (o.call) { callout(rq, o.co || [36, -30], false); continue; }
        const c = rq.cands.find(c => !hitBox(c.box));
        if (c) {
          boxes.push(c.box);
          const t = sv('text', { x: c.x, y: c.y, 'font-size': 11, fill: o.col, 'text-anchor': c.anchor, ...halo, ...(c.rot != null ? { transform: 'rotate(' + c.rot.toFixed(2) + ' ' + c.x.toFixed(1) + ' ' + (c.y - 4).toFixed(1) + ')' } : {}), 'pointer-events': 'none' });
          t.textContent = rq.lines[0]; g.append(t);
          continue;
        }
        // nowhere clear beside it: a callout, its box in the first clear place round it, off the part if it can be
        let best = null;
        for (const dist of [40, 60, 85, 120, 170]) {
          for (let k = 0; k < 16 && !(best && best.off); k++) {
            const a = -Math.PI / 4 + k * Math.PI / 8, co = [Math.cos(a) * dist, Math.sin(a) * dist];
            const w = rq.w + 4, h = rq.h + 3, left = co[0] < 0 ? rq.ax + co[0] - w : rq.ax + co[0], top = rq.ay + co[1] - h / 2, b = { x0: left, y0: top, x1: left + w, y1: top + h };
            if (hitBox(b)) continue;
            const off = offModel(b);
            if (!best || (off && !best.off)) best = { co, off };
          }
          if (best && best.off) break;
        }
        callout(rq, best ? best.co : [36, -30], true);
      }
      for (const d of dots) { const c = sv('circle', { cx: d.x, cy: d.y, r: d.on ? 5 : 4, fill: d.col, stroke: '#fff', 'stroke-width': 1.5, style: 'cursor:move' }); c.__mpt = d.pid; g.append(c); }
      // what is what
      if (dots.length || reqs.length) {
        const lx = AX_L + 8, ly = 36, lg = sv('g', { 'pointer-events': 'none' });
        const item = (x, y, mark, text, col) => { lg.append(mark); const t = sv('text', { x: x + 14, y: y + 4, 'font-size': 10, fill: col, ...halo }); t.textContent = text; lg.append(t); return x + 14 + text.length * 5.6 + 14; };
        const y2 = ly + 14;
        const x1 = item(lx, ly, sv('circle', { cx: lx + 5, cy: ly, r: 3.5, fill: PTC, stroke: '#fff', 'stroke-width': 1.2 }), 'point (radius, ' + (v === 'side' ? 'height)' : 'angle)'), PTC);
        item(x1, ly, sv('path', { d: 'M' + x1 + ' ' + (ly + 4) + 'A8 8 0 0 1 ' + (x1 + 8) + ' ' + (ly - 4) + 'M' + (x1 + 3) + ' ' + ly + 'h-3v-3', stroke: '#d6336c', fill: 'none', 'stroke-width': 1.4 }), 'R arc radius', '#d6336c');
        const x = item(lx, y2, sv('path', { d: 'M' + lx + ' ' + y2 + 'h11M' + lx + ' ' + y2 + 'l3 -2v4zM' + (lx + 11) + ' ' + y2 + 'l-3 -2v4z', stroke: INK, fill: INK, 'stroke-width': 1 }), 'ruler: length (angle)', INK);
        item(x, y2, sv('path', { d: 'M' + (x + 11) + ' ' + (y2 + 3) + 'H' + x + 'L' + (x + 9) + ' ' + (y2 - 5), stroke: ANG, fill: 'none', 'stroke-width': 1.2 }), 'angle', ANG);
        g.append(lg);
      }
      // a ruler being drawn, and the snap
      if (drag && drag.type === 'mnew' && drag.moved) {
        if (drag.mode === 'angle') { const V = mAngleVertex(drag); angleMark({ x: V.o[0], y: V.o[1] }, V.a ? { x: V.a[0], y: V.a[1] } : null, { x: drag.B[0], y: drag.B[1] }, { col: SEL, temp: true }); }
        else if (drag.mode === 'radius') {
          const rr = mRadiusOf(drag), [x1, y1] = mScreen({ x: drag.A[0], y: drag.A[1] }), [x2, y2] = mScreen({ x: drag.B[0], y: drag.B[1] });
          g.append(sv('line', { x1, y1, x2, y2, stroke: SEL, 'stroke-width': 1, 'stroke-dasharray': '3 3' }));
          if (rr) {
            const [cx, cy] = mScreen({ x: rr.c[0], y: rr.c[1] }), [mx, my] = mScreen({ x: rr.m[0], y: rr.m[1] });
            g.append(sv('circle', { cx, cy, r: Math.hypot(mx - cx, my - cy), fill: 'none', stroke: SEL, 'stroke-width': 1, 'stroke-dasharray': '4 3', opacity: 0.6 }));
            g.append(sv('line', { x1: cx, y1: cy, x2: mx, y2: my, stroke: SEL, 'stroke-width': 1.2 }));
            const t = sv('text', { x: (cx + mx) / 2, y: (cy + my) / 2 - 6, 'font-size': 11, fill: SEL, 'text-anchor': 'middle', ...halo, 'pointer-events': 'none' }); t.textContent = 'R ' + mLen(rr.r); g.append(t);
          }
        } else ruler({ x: drag.A[0], y: drag.A[1] }, { x: drag.B[0], y: drag.B[1] }, { col: SEL, temp: true });
      }
      if (drag && drag.type === 'mnew' && !mExporting) {
        const t = sv('text', { x: AX_L + 8, y: 18, 'font-size': 11, fill: '#868e96', ...halo, 'pointer-events': 'none' });
        const nm = { line: 'Ruler', angle: 'Angle', radius: 'Radius (across an arc: from one end to the other)' }[drag.mode || 'line'];
        t.textContent = nm + ' — scroll for ' + { line: 'an angle', angle: 'a radius', radius: 'a ruler' }[drag.mode || 'line']; g.append(t);
      }
      const sn = drag && drag.snapShow || mHoverSnap;
      if (sn && !mExporting) {
        for (const [a, b] of sn.lines || []) { const [x1, y1] = mScreen({ x: a[0], y: a[1] }), [x2, y2] = mScreen({ x: b[0], y: b[1] }); g.append(sv('line', { x1, y1, x2, y2, stroke: '#f08c00', 'stroke-width': 1, 'stroke-dasharray': '3 3', 'pointer-events': 'none' })); }
        if (sn.mark) { const [x, y] = mScreen({ x: sn.mark[0], y: sn.mark[1] }); g.append(sv('rect', { x: x - 5, y: y - 5, width: 10, height: 10, fill: 'none', stroke: '#f08c00', 'stroke-width': 1.6, 'pointer-events': 'none' })); }
      }
      if (mConnect && !mExporting) {
        const t = sv('text', { x: AX_L + 8, y: 18, 'font-size': 11, fill: SEL, ...halo, 'pointer-events': 'none' });
        t.textContent = 'Pick a point (or a place) to join it to — Esc to stop'; g.append(t);
      }
    }

    function mAngleVertex(d) {
      const [ax, ay] = mScreen({ x: d.A[0], y: d.A[1] });
      let best = null, bd = 60;
      for (const t of d.T) { const [x, y] = mScreen({ x: t[0], y: t[1] }), dd = Math.hypot(x - ax, y - ay); if (dd < bd) { bd = dd; best = t; } }
      if (!best || bd < 2) return { o: d.A, a: null };
      return { o: [best[0], best[1]], a: d.A };
    }
    function measureDown(e) {
      const [sx, sy] = local(e), W = mWorld(sx, sy), M = measures(), v = mView(), t = e.target, ctrl = e.ctrlKey || e.metaKey;
      if (e.button === 2) {
        const ref = t.__mpt ? { kind: 'p', id: t.__mpt } : t.__mseg ? { kind: 's', id: t.__mseg } : t.__mang ? { kind: 'a', id: t.__mang } : t.__mrad ? { kind: 'r', id: t.__mrad } : t.__mcall || null;
        mSel = ref; mConnect = null; drawSection(); showMeasureMenu(e.clientX, e.clientY, ref); return;
      }
      svg.setPointerCapture(e.pointerId);
      const T = mTargets(t.__mpt);
      const pin = v === 'side' && mConnect && M.pts[mConnect] && M.pts[mConnect].ang != null ? { ang: M.pts[mConnect].ang } : {};
      if (mConnect) {
        const a = mConnect; mConnect = null; pushUndo();
        let b = t.__mpt;
        if (!b) { const P = ctrl ? mSnap(W, T).p : W; b = mId('p'); M.pts[b] = { v, x: P[0], y: P[1], ...pin }; }
        if (b !== a && M.pts[a] && !mSegExists(a, b)) M.segs[mId('s')] = { a, b };
        b = mMerge(b);
        mSel = { kind: 'p', id: b }; drag = { type: 'mnone' }; mChanged(); return;
      }
      if (t.__mcall) {
        const o = mObj(t.__mcall);
        // (an automatic callout: where it is now, from its anchor)
        const co0 = t.__co || (o && o.co) || [36, -30];
        mSel = t.__mcall; drag = { type: 'mcall', ref: t.__mcall, sx, sy, co0, auto: !!t.__mauto, undo: false }; drawSection(); return;
      }
      // (Shift: a new ruler from the point, instead of moving it)
      if (t.__mpt && !e.shiftKey) { mSel = { kind: 'p', id: t.__mpt }; drag = { type: 'mpt', id: t.__mpt, T, undo: false }; drawSection(); return; }
      if (t.__mpt && M.pts[t.__mpt]) { const P = M.pts[t.__mpt]; drag = { type: 'mnew', A: [P.x, P.y], B: [P.x, P.y], T: mTargets(), sx, sy, moved: false }; mSel = null; drawSection(); return; }
      if (t.__mseg) { mSel = { kind: 's', id: t.__mseg }; drag = { type: 'mnone' }; drawSection(); return; }
      if (t.__mang) { mSel = { kind: 'a', id: t.__mang }; drag = { type: 'mnone' }; drawSection(); return; }
      if (t.__mrad) { mSel = { kind: 'r', id: t.__mrad }; drag = { type: 'mnone' }; drawSection(); return; }
      // a new ruler, from here to where the button is let go
      const s0 = ctrl ? mSnap(W, T) : null;
      drag = { type: 'mnew', A: s0 ? s0.p : W, B: s0 ? s0.p : W, T, sx, sy, moved: false, snapShow: s0 };
      mSel = null; mHoverSnap = null; drawSection();
    }
    function measureMove(e) {
      const [sx, sy] = local(e), W = mWorld(sx, sy), ctrl = e.ctrlKey || e.metaKey, M = measures();
      if (topMode()) { const r = Math.hypot(W[0], W[1]), a = ((Math.atan2(W[1], W[0]) * 180 / Math.PI) + 360) % 360; coord.textContent = 'x ' + fmt(W[0], 3) + ' · y ' + fmt(W[1], 3) + ' · r ' + fmt(r, 3) + ' ' + UNIT_LABEL + ' · ' + mAng(a); }
      else coord.textContent = 'radius ' + fmt(Math.abs(W[0]), 3) + ' · height ' + num(hDisp(W[1], zBase()), 3) + ' ' + UNIT_LABEL;
      if (!drag) {
        const s = ctrl ? mSnap(W, mTargets()) : null, had = !!mHoverSnap;
        mHoverSnap = s && (s.mark || s.lines.length) ? s : null;
        svg.style.cursor = e.target.__mpt || e.target.__mcall ? 'move' : e.target.__mseg ? 'pointer' : 'crosshair';
        if (had || mHoverSnap) drawSection();
        return;
      }
      if (drag.type === 'mnew') {
        const s = ctrl ? mSnap(W, drag.T) : null;
        drag.B = s ? s.p : W; drag.snapShow = s;
        if (Math.hypot(sx - drag.sx, sy - drag.sy) > 3) drag.moved = true;
        drawSection(); return;
      }
      if (drag.type === 'mpt') {
        const P = M.pts[drag.id]; if (!P) return;
        if (!drag.undo) { pushUndo(); drag.undo = true; }
        const s = ctrl ? mSnap(W, drag.T) : null, Q = s ? s.p : W;
        P.x = Q[0]; P.y = Q[1]; drag.snapShow = s; drag.moved = true; drawSection(); return;
      }
      if (drag.type === 'mcall') {
        const o = mObj(drag.ref); if (!o) return;
        if (!drag.undo) { pushUndo(); drag.undo = true; }
        if (drag.auto) o.call = true;
        o.co = [drag.co0[0] + sx - drag.sx, drag.co0[1] + sy - drag.sy]; drag.moved = true; drawSection();
      }
    }
    function measureUp(d) {
      if (d.type === 'mnew' && d.moved && Math.hypot(d.B[0] - d.A[0], d.B[1] - d.A[1]) > 1e-9) {
        const M = measures(), v = mView(), mk = (P) => { const id = mId('p'); M.pts[id] = { v, x: P[0], y: P[1] }; return id; };
        pushUndo();
        if (d.mode === 'radius') {
          const rr = mRadiusOf(d);
          if (!rr) { state.undo.pop(); drawSection(); return; }
          const a = mk(rr.a), b = mk(rr.b), id = mId('r');
          M.rads[id] = { a, b, m: [rr.m[0], rr.m[1]] }; mSel = { kind: 'r', id };
          mMerge(a); mMerge(b);
        } else if (d.mode === 'angle') {
          const V = mAngleVertex(d), o = mk(V.o), a = V.a ? mk(V.a) : null, b = mk(d.B), id = mId('a');
          M.angs[id] = { a, o, b }; mSel = { kind: 'a', id };
          for (const p of [o, a, b]) if (p) mMerge(p);
          if (!M.angs[id]) mSel = null;
        } else {
          const a = mk(d.A), b = mk(d.B), s = mId('s'); M.segs[s] = { a, b }; mSel = { kind: 's', id: s };
          mMerge(a); mMerge(b);
          if (!M.segs[s]) mSel = null;
        }
        mChanged(); return;
      }
      if (d.type === 'mpt' && d.moved) { const k = mMerge(d.id); if (k !== d.id) mSel = { kind: 'p', id: k }; }
      if (d.moved) mChanged(); else drawSection();
    }
    function showMeasureMenu(x, y, ref) {
      const M = measures(), o = mObj(ref);
      menu.textContent = '';
      const B = (label, f, title) => el('button', { type: 'button', style: BTN2, title: title || label, onclick: () => { hideMenu(); f(); } }, label);
      const edit = (f) => { pushUndo(); f(); mChanged(); };
      // a datapoint shown or not (kept open, to set several)
      const tick = (text, get, set) => checkRow(text, get, (v) => { pushUndo(); set(v); mChanged(); });
      const flag = (obj, k) => [() => !(obj.hide && obj.hide[k]), (v) => { obj.hide = obj.hide || {}; if (v) delete obj.hide[k]; else obj.hide[k] = true; if (!Object.keys(obj.hide).length) delete obj.hide; }];
      const ptTicks = (pid, name) => {
        const P = M.pts[pid]; if (!P) return [];
        const [ga, sa] = flag(P, 'a'), [gb, sb] = flag(P, 'b');
        return [tick(name + ': radius', ga, sa), tick(name + ': ' + (P.v === 'side' ? 'height' : 'angle'), gb, sb)];
      };
      if (o) {
        const title = ref.kind === 'p' ? 'Measurement point' : ref.kind === 's' ? 'Ruler' : ref.kind === 'r' ? 'Radius' : 'Angle';
        const grp = mGroup(ref), side = [...grp].some(p => M.pts[p] && M.pts[p].v === 'side'), pinned = [...grp].some(p => M.pts[p] && (side ? M.pts[p].ang != null : !!M.pts[p].cut));
        menu.append(el('div', { style: 'font-weight:700;margin-bottom:4px' }, title),
          row(ref.kind === 'p' ? B('Connect to…', () => { mConnect = ref.id; drawSection(); }, 'Join it to another point (or a new one) to make a ruler') : null,
            B(o.call ? 'Label on the drawing' : 'Label as a callout', () => edit(() => { if (o.call) { delete o.call; delete o.co; } else o.call = true; })),
            B('Delete ' + title.toLowerCase(), () => edit(() => { mDelete(ref); mSel = null; }))),
          row(pinned ? B('Unpin', () => edit(() => { for (const p of grp) if (M.pts[p]) { delete M.pts[p].ang; delete M.pts[p].cut; } drawCompasses(); }), side ? 'Show it at every section angle' : 'Show it whatever heights are shown')
            : B('Pin to ' + pinWhere(), () => edit(() => { mPinPts(grp); }), side ? 'Show it only at this section angle (marked on the compass, which snaps to it)' : 'Show it only with these heights shown from above (marked on the height slider, which snaps to them)')));
        // its datapoints
        const ticks = [];
        if (ref.kind === 's') {
          const [gl, sl] = flag(o, 'len');
          ticks.push(tick('Length', gl, sl));
          ticks.push(checkRow('Angle', () => { const A = M.pts[o.a], Bp = M.pts[o.b]; if (o.hide && o.hide.ang != null) return !o.hide.ang; if (!A || !Bp) return true; const [x1, y1] = mScreen(A), [x2, y2] = mScreen(Bp); let a = Math.atan2(-(y2 - y1), x2 - x1) * 180 / Math.PI; a = ((a % 90) + 90) % 90; return !(a < 0.05 || a > 89.95); },
            (v) => { pushUndo(); o.hide = o.hide || {}; o.hide.ang = !v; mChanged(); }));
          ticks.push(...ptTicks(o.a, 'Start'), ...ptTicks(o.b, 'End'));
        } else if (ref.kind === 'p') ticks.push(...ptTicks(ref.id, 'Point'));
        else if (ref.kind === 'r') ticks.push(...ptTicks(o.a, 'Start'), ...ptTicks(o.b, 'End'));
        else ticks.push(...ptTicks(o.o, 'Vertex'));
        if (ticks.length) menu.append(el('div', { style: 'margin-top:4px;color:#555;font-size:11px' }, 'Shown'), ...ticks);
        menu.append(hr());
      }
      const n = Object.values(M.pts).filter(p => mVisible(p)).length;
      menu.append(el('div', { style: 'font-weight:700;margin-bottom:4px' }, 'Measurements'),
        n ? row(
          B('Pin all shown to ' + pinWhere(), () => edit(() => { mPinPts(Object.keys(M.pts).filter(k => mVisible(M.pts[k]))); }), mView() === 'side' ? 'Pin every measurement shown here to this section angle (marked on the compass, which snaps to it)' : 'Pin every measurement shown here to the heights shown (marked on the height slider, which snaps to them)'),
          Object.values(M.pts).some(p => mVisible(p) && (p.ang != null || p.cut)) ? B('Unpin all shown', () => edit(() => { for (const p of Object.values(M.pts)) if (mVisible(p)) { delete p.ang; delete p.cut; } drawCompasses(); }), 'Show the measurements shown here at every section angle or height') : null) : null,
        row(B('Clear this view', () => edit(() => { mClear(true); mSel = null; }), 'Remove the measurements in this view (' + n + ' points)'),
          B('Clear all', () => edit(() => { mClear(false); mSel = null; }), 'Remove every measurement, in both views')),
        row(B('Export PNG', () => exportDrawing('png')), B('Export PDF', () => exportDrawing('pdf'))),
        el('div', { style: 'color:#666;font-size:11px;margin-top:4px;max-width:260px' }, 'Drag to draw a ruler (Shift-drag from a point to start one there); hold Ctrl to snap to points and line up with them; scroll while drawing for an angle.'));
      openMenu(x, y);
    }
    // the drawing (the view as it is, measurements and all) as a picture or a one-page PDF
    async function exportDrawing(kind) {
      if (!view) return;
      mExporting = true; mHoverSnap = null; drawSection();
      const { w, h } = size(), c2 = svg.cloneNode(true);
      mExporting = false; drawSection();
      for (const x of c2.querySelectorAll('#aa-cursor')) x.remove();
      c2.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); c2.setAttribute('width', w); c2.setAttribute('height', h); c2.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
      c2.setAttribute('style', 'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#fff');
      const img = new Image(), xml = new XMLSerializer().serializeToString(c2);
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
      try { await img.decode(); } catch (_) { state.exportError = 'Could not draw the view to export it'; renderAll(); return; }
      const k = 2, cv = document.createElement('canvas'); cv.width = Math.round(w * k); cv.height = Math.round(h * k);
      const cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height); cx.drawImage(img, 0, 0, cv.width, cv.height);
      const name = partName() + '-' + (topMode() ? 'overhead' : 'section') + '-drawing';
      const save = (blob, ext) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = String(name).replace(/[\\/:*?"<>|]+/g, '_') + '.' + ext; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); };
      if (kind === 'png') { cv.toBlob(b => b && save(b, 'png'), 'image/png'); return; }
      const jpg = Uint8Array.from(atob(cv.toDataURL('image/jpeg', 0.95).split(',')[1]), ch => ch.charCodeAt(0));
      save(new Blob([pdfOfJpeg(jpg, cv.width, cv.height, w * 0.75, h * 0.75)], { type: 'application/pdf' }), 'pdf');
    }
    // a one-page PDF holding a JPEG picture, the page its size (points)
    function pdfOfJpeg(jpg, iw, ih, pw, ph) {
      const enc = new TextEncoder(), parts = [], offs = [];
      let len = 0;
      const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
      const obj = (n, body) => { offs[n] = len; push(n + ' 0 obj\n' + body + '\nendobj\n'); };
      push('%PDF-1.4\n%âãÏÓ\n');
      obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
      obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
      obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pw.toFixed(2) + ' ' + ph.toFixed(2) + '] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>');
      offs[4] = len;
      push('4 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + iw + ' /Height ' + ih + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpg.length + ' >>\nstream\n');
      push(jpg); push('\nendstream\nendobj\n');
      const cs = 'q ' + pw.toFixed(2) + ' 0 0 ' + ph.toFixed(2) + ' 0 0 cm /Im0 Do Q';
      obj(5, '<< /Length ' + cs.length + ' >>\nstream\n' + cs + '\nendstream');
      const xref = len;
      push('xref\n0 6\n0000000000 65535 f \n' + [1, 2, 3, 4, 5].map(n => String(offs[n]).padStart(10, '0') + ' 00000 n \n').join(''));
      push('trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
      const out = new Uint8Array(len); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
      return out;
    }
    // where measurements pin to here: the section angle, or (from above) the heights shown
    function pinWhere() {
      if (mView() === 'side') return mAng(state.viewAngle);
      const [lo, hi] = curCut(), r = sceneZRange(), at = (t) => r ? num(hDisp(r[0] + (r[1] - r[0]) * t, zBase()), 3) : num(t, 3);
      return 'heights ' + at(lo) + '–' + at(hi) + ' ' + UNIT_LABEL;
    }
    function mPinPts(ids) {
      const M = measures(), side = mView() === 'side';
      for (const p of ids) if (M.pts[p]) { if (side) M.pts[p].ang = state.viewAngle; else M.pts[p].cut = curCut(); }
      drawCompasses(); syncTopBox();
    }
    function mPinSelected() {
      if (!state.scene) return;
      const M = measures(), pts = new Set(), side = mView() === 'side';
      if (mSel && mObj(mSel)) for (const p of mGroup(mSel)) pts.add(p);
      else for (const [k, p] of Object.entries(M.pts)) if (mVisible(p) && (side ? p.ang == null : !p.cut)) pts.add(k);
      if (!pts.size) return;
      pushUndo(); mPinPts(pts); mChanged();
    }
    function setMeasure(on) {
      const was = perfectNow();
      state.measure = !!on; mSel = null; mConnect = null; mHoverSnap = null;
      if (perfectNow() !== was) recalc();
      if (on) { state.sel = new Set(); state.selNodes = new Set(); }
      measureBar.style.display = on ? 'inline-flex' : 'none';
      syncModeBtns(); renderAll();
    }

    svg.addEventListener('pointerdown', (e) => {
      if (!state.scene) return;
      hideMenu();
      if (state.measure && e.button !== 1) { measureDown(e); return; }
      if (topMode()) {
        // from above: click an object to select it, drag the section line to turn the section; middle/right-drag pans
        const [sx, sy] = local(e); MS = 1;
        const [X, Y] = toWorld(sx, sy), add = e.shiftKey || e.ctrlKey || e.metaKey, hit = topNodeAt(X, Y);
        const th0 = e.target.__topH;
        if (e.button === 2 && th0 && th0.pkey) {
          if (!state.sel.has(th0.pkey)) { state.sel = new Set([th0.pkey]); state.selNodes = new Set([th0.id]); }
          drawSection(); showPointMenu(e.clientX, e.clientY); return;
        }
        const ge = th0 ? null : geoEdgeAt(sx, sy);
        if (e.button === 2 && ge) {
          const k = ge.id + '|qe|' + ge.i;
          if (!state.sel.has(k)) { state.sel = new Set([k]); state.selNodes = new Set([ge.id]); }
          drawSection(); showPointMenu(e.clientX, e.clientY); return;
        }
        if (e.button === 2 && hit) {
          if (!selectedAncestorOf(hit)) { state.selNodes = new Set([hit]); state.sel = new Set(); renderAll(); }
          showObjectMenu(e.clientX, e.clientY); return;
        }
        svg.setPointerCapture(e.pointerId);
        if (e.button === 1 || e.button === 2) { drag = { type: 'pan', sx, sy, cy: view.cy, cz: view.cz }; return; }
        if (e.target.__sliceKnob) { drag = { type: 'sliceline' }; return; }
        if (e.target.__topH) {
          const h = e.target.__topH, n = state.scene.nodes[h.id];
          drag = { type: 'toph', h, from: [X, Y], snap: clone(state.scene), moved: false, snapRot: n && n.params ? n.params.rotation || 0 : 0 };
          if (h.pkey) {
            // a point: select it (Shift/Ctrl adds); dragging a selected point moves all the selected points
            if (add) { if (state.sel.has(h.pkey)) state.sel.delete(h.pkey); else state.sel.add(h.pkey); }
            else if (!state.sel.has(h.pkey)) state.sel = new Set([h.pkey]);
            state.selNodes = new Set([h.id]);
          } else if (!add) { state.selNodes = new Set([h.id]); state.sel = new Set(); }
          drag.targets = topSnapTargets(h);      // what Ctrl can snap to, as things stand before the drag
          drawSection(); return;
        }
        const hitN = hit && state.scene.nodes[hit];
        if (!ge && e.button === 0 && !add && hitN && hitN.type === 'geo' && !e.target.__secLine && !e.target.__sliceKnob) {
          // a geometric object's body: select it and drag it (by its centre, which Ctrl snaps)
          const P = topPlace(state.scene, hit);
          if (!P.side) {
            const [cx, cy] = P.w(hitN.params.cx, hitN.params.cy), h = { kind: 'gcen', id: hit, P, x: cx, y: cy, key: hit + '|gc' };
            state.selNodes = new Set([hit]); state.sel = new Set();
            drag = { type: 'toph', h, from: [X, Y], snap: clone(state.scene), moved: false };
            drag.targets = topSnapTargets(h);
            drawSection(); return;
          }
        }
        if (ge && e.button === 0) {
          // an edge of a geometric object: select it; drag it to move its two corners
          const k = ge.id + '|qe|' + ge.i, h = { kind: 'gedge', id: ge.id, i: ge.i, P: ge.P, x: ge.W[0], y: ge.W[1], key: k };
          if (add) { if (state.sel.has(k)) state.sel.delete(k); else state.sel.add(k); } else state.sel = new Set([k]);
          state.selNodes = new Set([ge.id]);
          drag = { type: 'toph', h, from: [X, Y], snap: clone(state.scene), moved: false };
          drag.targets = topSnapTargets(h);
          drawSection(); return;
        }
        if (e.target.__secLine) { const [ox, oy] = toScreen(0, 0); drag = { type: 'angle', a0: state.viewAngle, sl: Math.atan2(oy - sy, sx - ox) * 180 / Math.PI, acc: 0, hit, add, sx, sy, moved: false }; svg.style.cursor = 'grabbing'; return; }
        drag = { type: 'topclick', hit, add };
        return;
      }
      if (e.target.__bandLine && e.button === 0) {
        const w = e.target.__bandLine, now = performance.now();
        if (lastBandDown.w === w && now - lastBandDown.t < 400) {       // double-click: the whole height that way
          lastBandDown = { w: null, t: 0 };
          const c = state.topCut || { lo: 0, hi: 1 }; setTopCut(w === 'lo' ? 0 : c.lo, w === 'hi' ? 1 : c.hi); saveSettings(); return;
        }
        lastBandDown = { w, t: now };
        svg.setPointerCapture(e.pointerId);
        drag = { type: 'bandline', which: w }; return;
      }
      if (sliceView()) {
        // a slice off the axis is to look at, but for geometric objects (theirs is cut where it is): any other drag
        // moves the view
        const [px0, py0] = local(e), r0 = toWorld(px0, py0), sd = e.target.__side || (r0[0] < 0 ? -1 : 1), t = e.target;
        const tk = t.__key ? parseKey(t.__key) : null, onGeo = (tk && (tk.kind === 'q' || tk.kind === 'qe')) || t.__geoH || t.__geoRot;
        MS = sd; const hit = onGeo ? null : nodeAt(sd * r0[0], r0[1]); MS = 1;
        if (!onGeo && !(hit && state.scene.nodes[hit].type === 'geo')) {
          svg.setPointerCapture(e.pointerId); drag = { type: 'pan', sx: px0, sy: py0, cy: view.cy, cz: view.cz }; return;
        }
      }
      const [sx, sy] = local(e), raw = toWorld(sx, sy), side = e.target.__side || (raw[0] < 0 ? -1 : 1);
      MS = dragSide = GEO_SIDE = side;
      GEO_RING = e.target.__gpt ? (e.target.__gpt.top ? 1 : -1) : e.target.__gtop != null ? (e.target.__gtop ? 1 : -1) : 0;
      const wy = side * raw[0], wz = raw[1];
      const key = e.target.__key || (!e.target.__key ? edgeAt(sx, sy) : null);
      const add = e.shiftKey || e.ctrlKey || e.metaKey;
      if (e.button === 0 && key && e.target.__gtop != null && parseKey(key).kind === 'qe') {
        const now = performance.now(), L = lastGeoEdgeDown;
        if (L && now - L.t < 450 && Math.hypot(sx - L.sx, sy - L.sy) < 6 && L.node === parseKey(key).node) { lastGeoEdgeDown = null; geoEdgeDouble(L.node, e.target.__gtop, raw[0], raw[1]); return; }
        lastGeoEdgeDown = { t: now, sx, sy, node: parseKey(key).node };
      }
      if (e.button === 2) {
        if (key) {
          if (!state.sel.has(key)) state.sel = new Set([key]);
          // a geometric object's edge: with those over it at that place, so points go on both sides alike
          if (e.target.__gtop != null && parseKey(key).kind === 'qe') for (const o of geoOverlapEdges(parseKey(key).node, e.target.__gtop, raw[0], raw[1])) state.sel.add(o.key);
          drawSection(); showPointMenu(e.clientX, e.clientY); return;
        }
        const hit = nodeAt(wy, wz);
        if (hit) {
          if (!selectedAncestorOf(hit)) { state.selNodes = new Set([hit]); state.sel = new Set(); renderAll(); }
          showObjectMenu(e.clientX, e.clientY); return;
        }
      }
      svg.setPointerCapture(e.pointerId);
      if (e.button === 1 || e.button === 2) { drag = { type: 'pan', sx, sy, cy: view.cy, cz: view.cz }; return; }
      if (e.target.__bevel) {
        const { node: id, i } = e.target.__bevel, n = state.scene.nodes[id], np = n.pts.length;
        const xf = xfOf(state.scene, id), bv = n.pts[i].bevel, P = xf.fwd(n.pts[i]), A = xf.fwd(n.pts[(i - 1 + np) % np]), B = xf.fwd(n.pts[(i + 1) % np]);
        const ua = [A.y - P.y, A.z - P.z], ub = [B.y - P.y, B.z - P.z], la = Math.hypot(...ua), lb = Math.hypot(...ub);
        const u1 = [ua[0] / la, ua[1] / la], u2 = [ub[0] / lb, ub[1] / lb], bl = Math.hypot(u1[0] + u2[0], u1[1] + u2[1]);
        const half = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]))) / 2;
        // distance from the corner to the middle of the bevel, per unit of bevel size
        const sh = Math.sin(half), ch = Math.cos(half);
        let k = bv.trim ? ch : (bv.segs | 0) <= 1 ? ch * ch / sh : bv.out ? 1 / sh - 1 : Math.cos(2 * half) / sh + 1, bis = [(u1[0] + u2[0]) / bl, (u1[1] + u2[1]) / bl];
        if (bv.shape === 'outA' || bv.shape === 'outB') {
          // a bead reaches out past the corner: drag it outward; k from a small sample of the same shape
          bis = [-bis[0], -bis[1]];
          const rt = Math.min(la, lb) * 0.1, arc = cornerPoints(A, P, B, { r: rt, segs: 16, shape: bv.shape }, null);
          k = Math.max(...arc.map(p => (p.y - P.y) * bis[0] + (p.z - P.z) * bis[1])) / rt;
        }
        if (bl > 1e-9 && k > 1e-9) {
          drag = { type: 'bevel', node: id, i, P: { y: P.y, z: P.z }, bis, k, snap: clone(state.scene), moved: false };
          state.sel = new Set([id + '|p|' + i]); state.selNodes = new Set([id]);
          drawSection(); return;
        }
      }
      if (e.target.__cog) {
        const { id, what } = e.target.__cog;
        drag = { type: 'cog', id, what, snap: clone(state.scene), moved: false };
        state.selNodes = new Set([id]); state.sel = new Set();
        drawSection(); return;
      }
      if (e.target.__geoRot && e.button === 0) {
        const { id, piv } = e.target.__geoRot;
        drag = { type: 'georot', id, piv, a0: Math.atan2(raw[1] - piv[1], raw[0] - piv[0]), snap: clone(state.scene), moved: false };
        state.selNodes = new Set([id]); state.sel = new Set();
        return;
      }
      if (e.target.__geoH && e.button === 0) {
        const { id, which } = e.target.__geoH;
        drag = { type: 'geoh', id, which, from: [wy, wz], snap: clone(state.scene), moved: false };
        state.selNodes = new Set([id]); state.sel = new Set();
        drawSection(); return;
      }
      if (e.target.__cloner) {
        const id = e.target.__cloner;
        drag = { type: 'cloner', id, from: [wy, wz], q0: { ...state.scene.nodes[id].params }, snap: clone(state.scene), moved: false };
        drawSection(); return;
      }
      if (key) {
        let toggleOff = false;
        if (!state.sel.has(key)) { if (!add) state.sel = new Set(); state.sel.add(key); }
        else if (add) toggleOff = true;
        // a geometric object's corner or edge that others lie exactly over here (front and back, seen square-on): those
        // are taken too, so the shape stays alike on both sides (Alt: just the one)
        if (e.altKey && !add && (e.target.__gtop != null || e.target.__gpt)) state.sel = new Set([key]);
        if (!toggleOff && !e.altKey && (e.target.__gtop != null || e.target.__gpt)) {
          const hq = parseKey(key), top = e.target.__gpt ? e.target.__gpt.top : e.target.__gtop, GP = geoSidePts(hq.node), tol = 3 / view.s, near = (u, v) => Math.hypot(u[0] - v[0], u[1] - v[1]) < tol;
          if (hq.kind === 'q') { const me = GP.pts.find(c => c.top === top && c.i === hq.i); if (me) for (const c of GP.pts) if (c.top === top && near([c.along, c.z], [me.along, me.z])) state.sel.add(c.key); }
          else if (hq.kind === 'qe') { const me = GP.edges.find(E => E.top === top && E.i === hq.i); if (me) for (const E of GP.edges) if (E.top === top && ((near(E.a, me.a) && near(E.b, me.b)) || (near(E.a, me.b) && near(E.b, me.a)))) state.sel.add(E.key); }
        }
        const snapScene = clone(state.scene), keys = pointKeys([...state.sel], snapScene);
        const keySet = new Set(keys);
        const runPrefixes = keys.filter(k => parseKey(k).kind === 'r').map(k => { const h = parseKey(k); return h.node + '|r|' + h.ri + '|'; });
        const moving = (k) => keySet.has(k) || runPrefixes.some(p => k.startsWith(p));
        // an edge leads with its end nearest to the cursor
        let primary = key;
        if (parseKey(key).kind === 'e') {
          const h = parseKey(key), n = snapScene.nodes[h.node], xf = xfOf(snapScene, h.node), a = xf.fwd(n.pts[h.i]), b = xf.fwd(n.pts[(h.i + 1) % n.pts.length]);
          primary = Math.hypot(a.y - wy, a.z - wz) <= Math.hypot(b.y - wy, b.z - wz) ? h.node + '|p|' + h.i : h.node + '|p|' + ((h.i + 1) % n.pts.length);
        }
        drag = { type: 'points', from: [wy, wz], snap: snapScene, moved: false, toggleOff, key, info: prepareSnap(snapScene, primary, moving) };
        // a geometric object's corner leads with itself; its edge, with the end nearest to the pointer
        if (!drag.info.P0 && e.target.__gpt) drag.info.P0 = { y: side * e.target.__gpt.along, z: e.target.__gpt.z };
        else if (!drag.info.P0 && parseKey(key).kind === 'qe' && e.target.__key) {
          const hq = parseKey(key), E = geoSidePts(hq.node).edges.filter(x => x.i === hq.i).map(x => [x.a, x.b]).flat();
          let bp = null; for (const v of E) if (!bp || Math.hypot(side * v[0] - wy, v[1] - wz) < Math.hypot(side * bp[0] - wy, bp[1] - wz)) bp = v;
          if (bp) drag.info.P0 = { y: side * bp[0], z: bp[1] };
        }
      } else {
        const hit = nodeAt(wy, wz);
        if (hit && selectedAncestorOf(hit)) {
          // drag every selected object (and everything inside selected groups/booleans)
          const snapScene = clone(state.scene), leaves = leavesUnder(snapScene, topSelected(snapScene));
          let prim = null, pd = Infinity;
          for (const hd of handlesOf(hit, snapScene)) { const d = Math.hypot(hd.y - wy, hd.z - wz); if (d < pd) { pd = d; prim = hd.key; } }
          const info = prepareSnap(snapScene, prim, k => leaves.has(parseKey(k).node));
          if (!info.P0 && snapScene.nodes[hit].type === 'geo') {
            // a geometric object leads with its centre (on the section's plane)
            const gq = snapScene.nodes[hit].params, th = state.viewAngle * Math.PI / 180, [Cx, Cy] = placeOf(snapScene, hit).w(gq.cx, gq.cy);
            info.P0 = { y: side * (Cx * Math.cos(th) + Cy * Math.sin(th)), z: Math.min(gq.z, gq.z + gq.h) + Math.abs(gq.h) / 2 };
          }
          drag = { type: 'nodes', leaves: [...leaves], hit, add, from: [wy, wz], snap: snapScene, moved: false, info };
        } else drag = { type: 'box', sx, sy, cx: sx, cy: sy, hit, add, moved: false };
      }
      drawSection();
    });
    svg.addEventListener('pointermove', (e) => {
      if (!state.scene) return;
      if (state.measure && (!drag || /^m(new|pt|call|none)$/.test(drag.type))) { measureMove(e); return; }
      if (topMode()) {
        const [sx, sy] = local(e); MS = 1;
        const [X, Y] = toWorld(sx, sy), r = Math.hypot(X, Y), a = ((Math.atan2(Y, X) * 180 / Math.PI) + 360) % 360;
        coord.textContent = 'x ' + fmt(X, 3) + ' · y ' + fmt(Y, 3) + ' · r ' + fmt(r, 3) + ' ' + UNIT_LABEL + ' · ' + num(a * ANG_SCALE, ANG_SCALE === 1 ? 1 : 4) + ANG_LABEL;
        if (!drag) {
          const th = e.target.__topH || null, hn = th ? th.id : topNodeAt(X, Y);
          if (hn !== hoverNode || hoverEdge || th !== hoverTopH) { hoverNode = hn; hoverEdge = null; hoverTopH = th; drawHover(); }
          svg.style.cursor = !th && geoEdgeAt(sx, sy) ? 'move' : e.target.__secLine ? 'grab' : hn ? 'pointer' : '';
          return;
        }
        if (drag.type === 'pan') { view.cy = drag.cy - (sx - drag.sx) / view.s; view.cz = drag.cz + (sy - drag.sy) / view.s; drawSection(); return; }
        if (drag.type === 'sliceline') {
          // the pointer's distance from the axis across the section line → the blue slicer's place
          const f = cutFrame(); if (!f) return;
          const thS = state.viewAngle * Math.PI / 180;
          let dN = -Math.sin(thS) * X + Math.cos(thS) * Y;
          if (Math.abs(dN) * view.s < 7 && !e.altKey) dN = 0;
          const v = Math.max(LO_END.z + 0.002, Math.min(0.998, (state.flip ? 1 : -1) * dN * MM / f.ext.z));
          setCut('z', Math.min(loOf('z'), v - 0.002), v, 'hi');
          return;
        }
        if (drag.type === 'toph') {
          if (!drag.moved && Math.hypot(X - drag.from[0], Y - drag.from[1]) * view.s < 3) return;
          if (!drag.moved) { pushSnap(drag.snap); drag.moved = true; }
          dragTopHandle(X, Y, e.ctrlKey || e.metaKey, e.shiftKey);
          drag.labelAt = [sx, sy];
          if (drag.rotText) showTag(e, [drag.rotText]);
          else {
            // the handle's place before and after (in the scene's plan), or the pointer's
            const A = drag.offW ? drag.offW[0] : drag.from, B = drag.offW ? drag.offW[1] : [X, Y], [a0, b0] = toScreen(A[0], A[1]), [a1, b1] = toScreen(B[0], B[1]);
            showOff(e, [A[0], A[1], 0], [B[0], B[1], 0], Math.atan2(b0 - b1, a1 - a0) * 180 / Math.PI);
          }
          markEdited(); drawSection(); recalc({ fast: true });
          return;
        }
        if (drag.type === 'angle') {
          // the part turns with the pointer, under the level section line
          if (!drag.moved && Math.hypot(sx - drag.sx, sy - drag.sy) < 3) return;
          drag.moved = true;
          const [ox, oy] = toScreen(0, 0), sNow = Math.atan2(oy - sy, sx - ox) * 180 / Math.PI;
          drag.acc += ((sNow - drag.sl + 540) % 360) - 180; drag.sl = sNow;
          let deg = drag.a0 - FZ() * drag.acc;
          if (e.ctrlKey || e.metaKey) deg = Math.round(deg / orbitStep()) * orbitStep(); else deg = pinMagnet(deg);
          setViewAngle(deg, false); drawSection();
        }
        return;
      }
      const [sx, sy] = local(e), raw = toWorld(sx, sy), side = drag ? dragSide : (e.target.__side || (raw[0] < 0 ? -1 : 1));
      MS = side;
      const wy = side * raw[0], wz = raw[1];
      cursorW = { y: wy, z: wz, side };
      const offP = sliceView();
      coord.textContent = (offP ? 'x: ' + fmt(wy, 3) + ' along the slice · radius ' + fmt(Math.hypot(wy, offP), 3) : 'x: radius ' + fmt(wy, 3) + ' / Ø ' + fmt(2 * wy, 3)) + ' · y: height ' + num(hDisp(wz, sceneBase), 3) + ' ' + UNIT_LABEL;
      if (!drag && offP) { drawCursor(); if (hoverEdge || hoverNode) { hoverEdge = null; hoverNode = null; svg.style.cursor = ''; } return; }
      if (!drag) {
        drawCursor();
        const he = e.target.__key ? null : edgeAt(sx, sy), hk = e.target.__key || he, hn = hk ? parseKey(hk).node : null;
        if (he !== hoverEdge || hn !== hoverNode) { hoverEdge = he; hoverNode = hn; svg.style.cursor = he ? 'pointer' : ''; drawHover(); }
        return;
      }
      if (drag.type === 'pan') { view.cy = drag.cy - (sx - drag.sx) / view.s; view.cz = drag.cz + (sy - drag.sy) / view.s; drawSection(); return; }
      if (drag.type === 'georot') {
        const rw = toWorld(sx, sy), a1 = Math.atan2(rw[1] - drag.piv[1], rw[0] - drag.piv[0]);
        let dd = ((a1 - drag.a0) * 180 / Math.PI + 540) % 360 - 180;
        if (!drag.moved && Math.abs(dd) < 1) return;
        if (!drag.moved) { pushSnap(drag.snap); drag.moved = true; }
        if ((e.ctrlKey || e.metaKey) && state.rotMode === 'relative') dd = snapAng(dd);
        state.scene = clone(drag.snap);
        const q = state.scene.nodes[drag.id].params, th = state.viewAngle * Math.PI / 180;
        // a turn from the plane's direction toward up is about (along × up)
        geoTurn(q, [Math.sin(th), -Math.cos(th), 0], dd * Math.PI / 180);
        if ((e.ctrlKey || e.metaKey) && state.rotMode !== 'relative') { q.rx = snapAng(q.rx); q.ry = snapAng(q.ry); q.rz = snapAng(q.rz); }
        showTag(e, [state.rotMode === 'relative' ? 'turned ' + num(dd * ANG_SCALE, 3) + ANG_LABEL : 'x ' + num(q.rx * ANG_SCALE, 3) + ' · y ' + num(q.ry * ANG_SCALE, 3) + ' · height ' + num(q.rz * ANG_SCALE, 3) + ANG_LABEL, 'about ' + (state.rotMode === 'relative' ? 'its centre' : 'x, y and the height axis')]);
        markEdited(); drawSection(); recalc({ fast: true });
        return;
      }
      if (drag.type === 'geoh') {
        if (!drag.moved && Math.abs(wz - drag.from[1]) * view.s < 2) return;
        if (!drag.moved) { pushSnap(drag.snap); drag.moved = true; }
        state.scene = clone(drag.snap);
        const q0 = drag.snap.nodes[drag.id].params, q = state.scene.nodes[drag.id].params, lo = Math.min(q0.z, q0.z + q0.h), hi = Math.max(q0.z, q0.z + q0.h), eps = 0.01 / MM;
        const z = e.ctrlKey || e.metaKey ? snapHeight(wz, drag.id) : wz;
        if (drag.which === 'top') { q.z = lo; q.h = Math.max(eps, z - lo); } else { const b = Math.min(hi - eps, z); q.z = b; q.h = hi - b; }
        const was = drag.which === 'top' ? hi : lo, now = drag.which === 'top' ? q.z + q.h : q.z;
        showOff(e, [0, 0, was], [0, 0, now], (now - was) * FZ() >= 0 ? 90 : -90, 'height ' + num(mm(q.h), 3) + ' ' + UNIT_LABEL);
        markEdited(); drawSection(); recalc({ fast: true });
        return;
      }
      if (drag.type === 'bandline') {
        const r = sceneZRange(); if (!r) return;
        const z = e.ctrlKey || e.metaKey ? snapBandZ(wz, snapThr()) : wz;      // onto the height of a point
        const t = (z - r[0]) / (r[1] - r[0]), c = state.topCut || { lo: 0, hi: 1 };
        tbDrag = { which: drag.which };
        if (drag.which === 'hi') setTopCut(c.lo, t); else setTopCut(t, c.hi);
        tbDrag = null;
        return;
      }
      if (drag.type === 'box') { drag.cx = sx; drag.cy = sy; drag.moved = drag.moved || Math.hypot(sx - drag.sx, sy - drag.sy) > 3; drawSection(); return; }
      if (drag.type === 'bevel') {
        if (!drag.moved) { pushSnap(drag.snap); drag.moved = true; }
        const d = Math.max(0, (wy - drag.P.y) * drag.bis[0] + (wz - drag.P.z) * drag.bis[1]), size = d / drag.k;
        state.scene = clone(drag.snap);
        const n = state.scene.nodes[drag.node], bv = n.pts[drag.i].bevel;
        if (size * drag.k * view.s < 3) n.pts[drag.i].bevel = null;   // dragged into the corner: no bevel
        else n.pts[drag.i].bevel = bv.trim ? { trim: size, pri: Date.now() } : { ...bv, r: size, pri: Date.now() };
        if (n.params) n.custom = true;
        drag.label = (bv.trim ? 'chamfer ' : 'bevel radius ') + num(mm(size), 3) + ' ' + UNIT_LABEL;
        drag.labelAt = [sx, sy];
        markEdited(); drawSection(); recalc({ fast: true });
        return;
      }
      if (drag.type === 'cog') {
        if (!state.scene.nodes[drag.id]) return;
        if (!drag.moved) { pushSnap(drag.snap); drag.moved = true; }
        state.scene = clone(drag.snap);
        dragCog(xfOf(state.scene, drag.id).invP(wy, wz).y, e.ctrlKey || e.metaKey);
        drag.labelAt = [sx, sy];
        markEdited(); drawSection(); recalc({ fast: true });
        return;
      }
      if (drag.type === 'cloner') {
        const k = state.scene.nodes[drag.id];
        if (!k) return;
        if (!drag.moved && Math.hypot(wy - drag.from[0], wz - drag.from[1]) * view.s < 3) return;
        if (!drag.moved) { pushSnap(drag.snap); drag.moved = true; }
        const d = xfOf(state.scene, drag.id).inv(wy - drag.from[0], wz - drag.from[1]);
        let R = Math.max(0, drag.q0.radius + d.y), Hh = drag.q0.height + d.z;
        if (e.ctrlKey || e.metaKey) { const s = gridStep() / 2; R = Math.round(R / s) * s; Hh = sceneBase + Math.round((Hh - sceneBase) / s) * s; }
        k.params.radius = R;
        if (k.params.orient === 'radial') k.params.height = Hh;
        markEdited(); drawSection(); recalc({ fast: true });
        return;
      }
      let dy = wy - drag.from[0], dz = wz - drag.from[1];
      if (!drag.moved && Math.hypot(dy, dz) * view.s < 3) return;
      if (!drag.moved) { pushSnap(drag.snap); drag.moved = true; drag.base = zBase(drag.snap); }
      drag.guides = []; drag.mark = null;
      const info = drag.info, P0 = info && info.P0;
      let lock = null;
      if (e.shiftKey && P0) {
        const l = axisLock(info, dy, dz);
        dy = l.dy; dz = l.dz; lock = { p: P0, d: l.dir };
        drag.guides.push({ from: P0, to: { y: P0.y + dy, z: P0.z + dz }, lock: true });
      }
      if ((e.ctrlKey || e.metaKey) && P0) {
        const s = snapTo(info, { y: P0.y + dy, z: P0.z + dz }, lock);
        if (s) { dy = s.pos.y - P0.y; dz = s.pos.z - P0.z; drag.guides.push(...s.guides); drag.mark = s.pos; drag.markMid = !!s.mid; if (lock) drag.guides[0].to = s.pos; }
        else if (drag.type === 'nodes' && state.scene.nodes[drag.hit] && state.scene.nodes[drag.hit].type === 'geo') {
          // a geometric object's centre: onto the grid (heights from the part's bottom), the lock kept
          const st = gridStep() / 2, base = info.base || 0, G = { y: Math.round((P0.y + dy) / st) * st, z: base + Math.round((P0.z + dz - base) / st) * st };
          if (!lock || Math.abs(lock.d[1]) < 1e-9) dy = G.y - P0.y;
          if (!lock || Math.abs(lock.d[0]) < 1e-9) dz = G.z - P0.z;
          drag.mark = { y: P0.y + dy, z: P0.z + dz };
        }
      }
      if (P0) drag.cur = { y: P0.y + dy, z: P0.z + dz };
      state.scene = clone(drag.snap);
      if (drag.type === 'points') moveKeysView(state.scene, [...state.sel], dy, dz);
      else for (const id of drag.leaves) moveNodeView(state.scene, id, dy, dz);
      {
        // the moved point (or the grabbed place) on the section's plane, before and after
        const th = state.viewAngle * Math.PI / 180, S0 = P0 || { y: drag.from[0], z: drag.from[1] }, c = Math.cos(th) * dragSide, s = Math.sin(th) * dragSide;
        showOff(e, [S0.y * c, S0.y * s, S0.z], [(S0.y + dy) * c, (S0.y + dy) * s, S0.z + dz], Math.atan2(FZ() * dz, dragSide * dy) * 180 / Math.PI);
      }
      markEdited();
      drawSection(); recalc({ fast: true });
    });
    const endDrag = () => {
      offTag.style.display = 'none';
      if (!drag) return;
      const d = drag; drag = null;
      if (/^m(new|pt|call|none)$/.test(d.type)) { measureUp(d); return; }
      if (d.type === 'pan') return;
      if (d.type === 'bandline' || d.type === 'sliceline') { saveSettings(); drawSection(); return; }
      if (d.type === 'geoh' || d.type === 'georot') { if (d.moved) recalc(); else renderAll(); return; }
      if (d.type === 'angle' && d.moved) { svg.style.cursor = ''; drawSection(); return; }
      if (d.type === 'toph' && !d.moved && d.h.kind === 'gmid') {
        const n = state.scene.nodes[d.h.id];
        if (n && n.shape) {
          pushUndo();
          const A = n.shape[d.h.i], B = n.shape[(d.h.i + 1) % n.shape.length];
          n.shape.splice(d.h.i + 1, 0, geoMidCorner(A, B, 0.5));
          geoRecentre(n);
          state.sel = new Set([d.h.id + '|q|' + (d.h.i + 1)]); markEdited(); recalc();
        }
        return;
      }
      if (d.type === 'toph') { if (d.moved) recalc(); else renderAll(); return; }   // (points stay selected, for the right-click menu)
      if (d.type === 'topclick' || d.type === 'angle') {      // (a click on the section line selects what is under it)
        svg.style.cursor = '';
        if (d.hit) {
          state.sel = d.add ? state.sel : new Set();
          if (d.add) { if (state.selNodes.has(d.hit)) state.selNodes.delete(d.hit); else state.selNodes.add(d.hit); }
          else state.selNodes = new Set([d.hit]);
        } else if (!d.add) { state.sel = new Set(); state.selNodes = new Set(); }
        renderAll(); return;
      }
      if (d.type === 'box') {
        if (d.moved) {
          const [y0, zP] = toWorld(Math.min(d.sx, d.cx), Math.min(d.sy, d.cy)), [y1, zQ] = toWorld(Math.max(d.sx, d.cx), Math.max(d.sy, d.cy)), z0 = Math.min(zP, zQ), z1 = Math.max(zP, zQ);
          if (!d.add) state.sel = new Set();
          const MSb = MS;
          for (const s of [1, -1]) {
            MS = s;
            const lo = s > 0 ? y0 : -y1, hi = s > 0 ? y1 : -y0;
            for (const id of frontOrder().filter(canPick)) for (const hd of handlesOf(id)) if (hd.y >= lo && hd.y <= hi && hd.z >= z0 && hd.z <= z1) state.sel.add(hd.key);
            // (a geometric object has no points here: the box takes the object, where it touches its section)
            if (s > 0) for (const id of frontOrder().filter(canPick)) {
              if (state.scene.nodes[id].type !== 'geo') continue;
              const loops = geoSection(id).concat(geoProjection(id));
              if (loops.some(L => L.some(p => p[0] >= y0 && p[0] <= y1 && p[1] >= z0 && p[1] <= z1)) || inLoops((y0 + y1) / 2, (z0 + z1) / 2, loops)) {
                if (!d.add) state.selNodes = new Set(); state.selNodes.add(id); d.add = true;
              }
            }
          }
          MS = MSb;
        } else if (d.hit) {
          // click on an object: select it (Shift/Ctrl toggles it in the selection)
          state.sel = d.add ? state.sel : new Set();
          if (d.add) { if (state.selNodes.has(d.hit)) state.selNodes.delete(d.hit); else state.selNodes.add(d.hit); }
          else state.selNodes = new Set([d.hit]);
        } else if (!d.add) { state.sel = new Set(); state.selNodes = new Set(); }
        renderAll(); return;
      }
      if (d.type === 'cog' && !d.moved) { renderAll(); return; }
      if (d.type === 'cloner' && !d.moved) { state.selNodes = new Set([d.id]); state.sel = new Set(); renderAll(); return; }
      if (d.type === 'points' && !d.moved) {
        if (d.toggleOff) state.sel.delete(d.key);
        state.selNodes = new Set([parseKey(d.key).node]);
      }
      if (d.type === 'nodes' && !d.moved && d.add) state.selNodes.delete(d.hit);
      if (d.moved) recalc(); else renderAll();
    };
    let lastBandDown = { w: null, t: 0 };
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', endDrag);
    svg.addEventListener('pointerleave', () => { cursorW = null; if (hoverTopH) { hoverTopH = null; drawHover(); } if ((hoverEdge || hoverNode) && !drag) { hoverEdge = null; hoverNode = null; drawHover(); } drawCursor(); });
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!view) return;
      if (state.measure && drag && drag.type === 'mnew') {
        // (one switch per scroll gesture)
        const now = performance.now();
        if (!drag.lastWheel || now - drag.lastWheel > 250) { const order = ['line', 'angle', 'radius'], i = order.indexOf(drag.mode || 'line'); drag.mode = order[(i + (e.deltaY < 0 ? 2 : 1)) % 3]; drag.moved = true; drawSection(); }
        drag.lastWheel = now; return;
      }
      const [sx, sy] = local(e);
      zoomTo((zoomAnim ? zoomAnim.s : view.s) * Math.exp(-e.deltaY * 0.0015), sx, sy);
    }, { passive: false });
    // zooming eases toward its target over a few frames; the point under the pointer stays where it is
    let zoomAnim = null;
    function zoomTo(s, sx, sy) {
      // the point under the pointer, in the view's own frame (from above: the turned one)
      rotOff = true;
      const [wy, wz] = toWorld(sx, sy);
      rotOff = false;
      const fresh = !zoomAnim;
      zoomAnim = { s, sx, sy, wy, wz };
      if (!fresh) return;
      const step = () => {
        const z = zoomAnim; if (!z || !view || !root.isConnected) { zoomAnim = null; return; }
        const k = reduceMotion() ? 1 : 0.71, ls = Math.log(view.s), lt = Math.log(z.s), done = Math.abs(lt - ls) < 0.002;
        view.s = done ? z.s : Math.exp(ls + (lt - ls) * k);
        const { w, h } = size();
        view.cy = z.wy - (z.sx - w / 2) / view.s; view.cz = z.wz + (z.sy - h / 2) / view.s;
        drawSection();
        if (done) zoomAnim = null; else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
    // a double click on a geometric object's edge in the radius/height view: a corner there, and on the edges over it
    // (both sides alike). (Told apart from two clicks by hand: the view is redrawn between them.)
    let lastGeoEdgeDown = null;
    function geoEdgeDouble(id, top, al, z) {
      const n = state.scene.nodes[id]; if (!n || !n.shape) return;
      const list = geoOverlapEdges(id, top, al, z).sort((a, b) => a.i - b.i);
      if (!list.length) return;
      pushUndo();
      for (const o of list.slice().reverse()) { const A = n.shape[o.i], B = n.shape[(o.i + 1) % n.shape.length]; n.shape.splice(o.i + 1, 0, geoMidCorner(A, B, o.t)); }
      state.sel = new Set(list.map((o, k) => id + '|q|' + (o.i + 1 + k))); state.selNodes = new Set([id]);
      geoRecentre(n); markEdited(); recalc();
    }
    svg.addEventListener('dblclick', (e) => {
      if (!e.target.__key && !e.target.__bandLine && performance.now() - lastBandDown.t > 600) { fit(); drawSection(); }
    });

    // ---- context menus ----
    function hideMenu() { menu.style.display = 'none'; if (previewMarks.length) { previewMarks = []; drawSection(); } }
    function openMenu(x, y) {
      const wasOpen = menu.style.display !== 'none';
      menu.style.display = 'block';
      if (!wasOpen) animIn(menu, { from: 'scale(.96) translateY(-4px)', ms: 150 });
      const r = menu.getBoundingClientRect();
      menu.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
      menu.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
    }
    const hr = () => el('hr', { style: 'border:0;border-top:1px solid #eee;margin:7px 0' });
    const row = (...k) => el('div', { style: 'display:flex;gap:4px;flex-wrap:wrap;align-items:center' }, ...k);
    // a button that shows where new points would go while hovered
    function previewButton(label, marks, action) {
      return el('button', { type: 'button', style: BTN2,
        onmouseenter: () => { previewMarks = marks(); drawSection(); },
        onmouseleave: () => { previewMarks = []; drawSection(); },
        onclick: () => { previewMarks = []; action(); } }, label);
    }
    function objectActions(ids) {
      const one = ids.length === 1 ? state.scene.nodes[ids[0]] : null;
      return [
        row(el('button', { type: 'button', style: BTN2, onclick: () => { hideMenu(); saveToLibrary(ids); } }, ids.length > 1 ? 'Save ' + ids.length + ' objects as a model' : 'Save to my models'),
          one ? el('button', { type: 'button', style: BTN2, onclick: () => { hideMenu(); exportNode(one.id); } }, 'Export ' + state.format.toUpperCase()) : null),
        row(el('button', { type: 'button', style: BTN2, onclick: () => { hideMenu(); wrapSelection('group'); } }, 'Group'),
          ids.length <= 2 ? el('button', { type: 'button', style: BTN2, onclick: () => { hideMenu(); wrapSelection('boolean'); } }, ids.length === 2 ? 'Boolean of these two' : 'Wrap in boolean') : null,
          one && one.type === 'group' ? el('button', { type: 'button', style: BTN2, onclick: () => { hideMenu(); ungroup(one.id); } }, 'Ungroup') : null,
          el('button', { type: 'button', style: BTN2, onclick: () => { hideMenu(); duplicateNodes(ids); }, title: 'Ctrl+D, or Ctrl-drag in the list to place the copy' }, 'Duplicate'),
          el('button', { type: 'button', style: BTN2, onclick: () => { hideMenu(); deleteNodes(ids); } }, 'Delete')),
      ];
    }
    function showObjectMenu(x, y) {
      const ids = topSelected(state.scene);
      if (!ids.length) return;
      menu.textContent = '';
      appendKids(menu, el('div', { style: 'font-weight:700;margin-bottom:6px' }, ids.length === 1 ? (state.scene.nodes[ids[0]].name || ids[0]) : ids.length + ' objects selected'),
        ...objectActions(ids).map(r => el('div', { style: 'margin-bottom:5px' }, r)));
      openMenu(x, y);
    }
    function showPointMenu(x, y) {
      const qe = [...state.sel].filter(k => parseKey(k).kind === 'qe');
      if (qe.length && qe.length === state.sel.size) {
        // edges of a geometric object: corners added on them, evenly spaced
        menu.textContent = '';
        const nIn = el('input', { type: 'number', min: '1', max: '200', step: '1', value: '1', style: 'width:52px' });
        menu.append(el('div', { style: 'font-weight:700;margin-bottom:4px' }, qe.length + ' edge' + (qe.length === 1 ? '' : 's') + ' selected'),
          row(el('button', { type: 'button', style: BTN2, onclick: () => {
            const c = Math.max(1, Math.min(200, parseInt(nIn.value, 10) || 1)), added = [];
            pushUndo();
            qe.map(parseKey).sort((a, b) => a.node === b.node ? b.i - a.i : 0).forEach(hq => { const n = state.scene.nodes[hq.node]; if (n && n.shape) added.push(...geoInsert(n, hq.i, c)); });
            for (const id of new Set(qe.map(k => parseKey(k).node))) geoRecentre(state.scene.nodes[id]);
            state.sel = new Set(added.slice(-c)); markEdited(); hideMenu(); recalc();
          } }, 'Insert'), nIn, 'point(s) on ' + (qe.length === 1 ? 'this edge' : 'each edge')));
        openMenu(x, y); return;
      }
      const qk = [...state.sel].filter(k => parseKey(k).kind === 'q');
      if (qk.length && qk.length === state.sel.size) {
        // corners of a geometric object
        menu.textContent = '';
        const first = qk.map(k => { const hq = parseKey(k), nq = state.scene.nodes[hq.node]; return nq && nq.shape[hq.i] && nq.shape[hq.i].bevel; }).find(b => b && b.r > 0);
        const rIn = el('input', { 'data-unit': 'len', type: 'number', step: '0.05', min: '0', value: num(mm(first ? first.r : 0), 3), style: 'width:60px' });
        const sIn = el('input', { type: 'number', step: '1', min: '1', max: '64', value: String(first ? first.segs : 6), style: 'width:46px' });
        const oIn = selectInput(bevelShapeOf(first), BEVEL_SHAPES, () => {});
        let bevelUndo = false;
        // each selected corner (only the corner: the edges either side keep their straight run up to it)
        const applyBevel = (live) => {
          const r = Math.max(0, parseFloat(rIn.value) || 0) / UNIT_SCALE, sg = Math.max(1, Math.min(64, parseInt(sIn.value, 10) || 1));
          if (!bevelUndo) { pushUndo(); bevelUndo = true; }
          for (const k of qk) { const hq = parseKey(k), nq = state.scene.nodes[hq.node]; if (nq && nq.shape[hq.i]) nq.shape[hq.i].bevel = r > 0 ? { r, segs: sg, ...bevelFromShape(oIn.value), pri: Date.now() } : null; }
          markEdited(); state.liveInput = live; try { recalc(); } finally { state.liveInput = false; }
        };
        rIn.addEventListener('input', () => applyBevel(true)); sIn.addEventListener('input', () => applyBevel(true));
        rIn.addEventListener('change', () => applyBevel(false)); sIn.addEventListener('change', () => applyBevel(false)); oIn.addEventListener('change', () => applyBevel(false));
        menu.append(el('div', { style: 'font-weight:700;margin-bottom:4px' }, qk.length + ' corner' + (qk.length === 1 ? '' : 's') + ' selected'),
          el('div', { style: 'margin:2px 0' }, 'Bevel radius (' + UNIT_LABEL + ', 0 = none) ', rIn),
          el('div', { style: 'margin:2px 0' }, 'edges ', sIn, ' shape ', oIn), hr(),
          row(el('button', { type: 'button', style: BTN2, onclick: () => {
            hideMenu(); pushUndo();
            if (!deletePoints(qk)) state.libMessage = 'A geometric object keeps at least three corners.';
            state.sel = new Set(); markEdited(); recalc();
          } }, 'Delete')));
        openMenu(x, y); return;
      }
      const keys = [...state.sel], pts = pointKeys(keys).filter(k => parseKey(k).kind === 'p');
      const edges = keys.filter(k => parseKey(k).kind === 'e'), runs = keys.filter(k => parseKey(k).kind === 'r');
      const firstBevel = pts.map(k => { const h = parseKey(k); return state.scene.nodes[h.node].pts[h.i].bevel; }).find(b => b && b.r > 0);
      const bv = { r: firstBevel ? firstBevel.r : 0, segs: firstBevel ? firstBevel.segs : 4, out: firstBevel ? firstBevel.out : true, shape: firstBevel ? firstBevel.shape : null };
      menu.textContent = '';
      const what = [pts.length ? pts.length + ' point' + (pts.length === 1 ? '' : 's') : null, edges.length ? edges.length + ' edge' + (edges.length === 1 ? '' : 's') : null, runs.length ? runs.length + ' thread point' + (runs.length === 1 ? '' : 's') : null].filter(Boolean).join(', ');
      menu.append(el('div', { style: 'font-weight:700;margin-bottom:4px' }, what + ' selected'));
      // insert points on edges: any number, evenly spaced
      if (edges.length) {
        const nIn = el('input', { type: 'number', min: '1', max: '200', step: '1', value: '1', style: 'width:52px' });
        const count = () => Math.max(1, Math.min(200, parseInt(nIn.value, 10) || 1));
        const marks = () => edges.flatMap(k => { const h = parseKey(k), xf = xfOf(state.scene, h.node); return edgeSamples(state.scene.nodes[h.node], h.i, count()).map(xf.fwd); });
        nIn.addEventListener('input', () => { if (previewMarks.length) { previewMarks = marks(); drawSection(); } });
        menu.append(row(previewButton('Insert', marks, () => {
          pushUndo();
          const c = count(), added = [];
          // insert from the highest index down so earlier edge indices stay valid
          edges.map(parseKey).sort((a, b) => a.node === b.node ? b.i - a.i : 0).forEach(h => added.push(...insertOnEdge(h.node, h.i, c)));
          state.sel = new Set(added.length ? added.slice(-c) : []); markEdited(); hideMenu(); recalc();
        }), nIn, 'point(s) on ' + (edges.length === 1 ? 'this edge' : 'each edge')));
      }
      if (pts.length) {
        if (edges.length) menu.append(hr());
        // bevel: radius 0 = none; very small bevels merge away when the outline is optimized
        const rIn = el('input', { 'data-unit': 'len', type: 'number', step: '0.05', min: '0', value: num(mm(bv.r), 3), style: 'width:60px' });
        const sIn = el('input', { type: 'number', step: '1', min: '1', max: '64', value: String(bv.segs), style: 'width:46px' });
        const oIn = selectInput(bevelShapeOf(bv), BEVEL_SHAPES, () => {});
        menu.append(
          el('div', { style: 'margin:2px 0' }, 'Bevel radius (' + UNIT_LABEL + ', 0 = none) ', rIn),
          el('div', { style: 'margin:2px 0' }, 'edges ', sIn, ' shape ', oIn));
        // live: every change re-applies the bevel (one undo step for this menu)
        let bevelUndo = false;
        const applyBevel = (live) => {
          const r = Math.max(0, parseFloat(rIn.value) || 0) / UNIT_SCALE, s = Math.max(1, Math.min(64, parseInt(sIn.value, 10) || 1));
          if (!bevelUndo) { pushUndo(); bevelUndo = true; }
          setBevel(pts, r > 0 ? { r, segs: s, ...bevelFromShape(oIn.value), pri: Date.now() } : null); markEdited();
          state.liveInput = live; try { recalc(); } finally { state.liveInput = false; }
        };
        rIn.addEventListener('input', () => applyBevel(true)); sIn.addEventListener('input', () => applyBevel(true));
        rIn.addEventListener('change', () => applyBevel(false)); sIn.addEventListener('change', () => applyBevel(false));
        oIn.addEventListener('change', () => applyBevel(false));
        if (pts.length === 1 && !edges.length) {
          const h = parseKey(pts[0]), n = state.scene.nodes[h.node], np = n.pts.length, prev = (h.i - 1 + np) % np, xfm = xfOf(state.scene, h.node);
          menu.append(hr(), row(
            edgeOk(n, prev) ? previewButton('Insert point before', () => edgeSamples(n, prev, 1).map(xfm.fwd), () => {
              pushUndo(); const k = insertOnEdge(h.node, prev, 1); state.sel = new Set(k); markEdited(); hideMenu(); recalc();
            }) : null,
            edgeOk(n, h.i) ? previewButton('Insert point after', () => edgeSamples(n, h.i, 1).map(xfm.fwd), () => {
              pushUndo(); const k = insertOnEdge(h.node, h.i, 1); state.sel = new Set(k); markEdited(); hideMenu(); recalc();
            }) : null));
        }
        menu.append(hr(), row(el('button', { type: 'button', style: BTN2, onclick: () => {
          pushUndo();
          if (!deletePoints(pts)) { state.undo.pop(); menu.append(el('div', { style: 'color:#b42318;margin-top:6px' }, 'A cross-section needs at least 3 points.')); return; }
          state.sel = new Set(); markEdited(); hideMenu(); recalc();
        } }, 'Delete point' + (pts.length === 1 ? '' : 's'))));
      }
      // whole-object actions for the object these points belong to
      const owners = [...new Set(keys.map(k => parseKey(k).node))];
      if (owners.length === 1) {
        menu.append(hr(), el('div', { style: 'color:#666;margin-bottom:4px' }, 'Object: ' + (state.scene.nodes[owners[0]].name || owners[0])),
          row(el('button', { type: 'button', style: BTN2, onclick: () => { hideMenu(); saveToLibrary(owners); } }, 'Save to my models'),
            el('button', { type: 'button', style: BTN2, onclick: () => { hideMenu(); exportNode(owners[0]); } }, 'Export ' + state.format.toUpperCase())));
      }
      openMenu(x, y);
    }
    document.addEventListener('pointerdown', (e) => { if (menu.style.display !== 'none' && !menu.contains(e.target) && e.target !== svg && !svg.contains(e.target)) hideMenu(); }, true);

    // ---- side panel: hierarchy (drag and drop), selection, properties, saved models ----
    let dragNodeId = null;
    const copyKey = (e) => e.ctrlKey || e.metaKey || e.altKey;
    function dropAllowed(target, copy) {
      if (!dragNodeId || !target) return false;
      if (copy) return true;      // a copy can go anywhere, even inside the original
      const sc = state.scene;
      if (target.parent !== null && (target.parent === dragNodeId || subtreeIds(sc, dragNodeId).has(target.parent))) return false;
      return true;
    }
    function treeBlock() {
      const sc = state.scene, rows = el('div', { style: 'margin:4px 0' });
      const mkRow = (opts) => {
        const r = el('div', { style: opts.style, draggable: opts.id ? 'true' : null, title: opts.title || null }, ...opts.kids);
        if (opts.id) r.dataset.node = opts.id;
        if (opts.id) {
          r.addEventListener('dragstart', (e) => { dragNodeId = opts.id; e.dataTransfer.setData('text/plain', opts.id); e.dataTransfer.effectAllowed = 'copyMove'; });
          r.addEventListener('dragend', () => { dragNodeId = null; });
          r.addEventListener('click', (e) => {
            // a second click on the same row soon after: rename it right there
            const now = performance.now();
            if (!e.shiftKey && !e.ctrlKey && !e.metaKey && lastRowClick.id === opts.id && now - lastRowClick.t < 400) { lastRowClick = { id: null, t: 0 }; renameRow(opts.id); return; }
            lastRowClick = { id: opts.id, t: now };
            // Shift: everything listed between the last clicked object and this one; Ctrl: add / remove one
            const rows = [...side.querySelectorAll('[data-node]')].map(x => x.dataset.node), a = rows.indexOf(treeAnchor), b = rows.indexOf(opts.id);
            if (e.shiftKey && a >= 0 && b >= 0) {
              const range = rows.slice(Math.min(a, b), Math.max(a, b) + 1);
              state.selNodes = new Set(e.ctrlKey || e.metaKey ? [...state.selNodes, ...range] : range); state.sel = new Set();
            } else if (e.shiftKey || e.ctrlKey || e.metaKey) { if (state.selNodes.has(opts.id)) state.selNodes.delete(opts.id); else state.selNodes.add(opts.id); treeAnchor = opts.id; }
            else { state.selNodes = new Set([opts.id]); state.sel = new Set(); treeAnchor = opts.id; }
            renderAll();
          });
          r.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (!state.selNodes.has(opts.id)) { state.selNodes = new Set([opts.id]); state.sel = new Set(); renderAll(); }
            showObjectMenu(e.clientX, e.clientY);
          });
        }
        if (opts.drop) {
          r.addEventListener('dragover', (e) => {
            const copy = copyKey(e);
            if (!dropAllowed(opts.drop, copy)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = copy ? 'copy' : 'move';
            r.style.boxShadow = copy ? 'inset 0 0 0 2px #2f9e44' : 'inset 0 0 0 2px #1f6feb';
            r.title = copy ? 'Drop to place a copy here' : (opts.title || '');
          });
          r.addEventListener('dragleave', () => { r.style.boxShadow = ''; });
          r.addEventListener('drop', (e) => {
            e.preventDefault(); r.style.boxShadow = '';
            const copy = copyKey(e), id = dragNodeId, ok = dropAllowed(opts.drop, copy);
            dragNodeId = null;
            if (!id || !ok) return;
            if (copy) {
              // copy every selected object when the dragged row is part of the selection
              const ids = state.selNodes.has(id) ? topSelected(state.scene) : [id];
              duplicateNodes(ids, opts.drop); return;
            }
            const snap = clone(state.scene);
            if (moveNodeTo(state.scene, id, opts.drop)) { pushSnap(snap); markEdited(); recalc(); } else renderAll();
          });
        }
        rows.append(r);
      };
      // the tree's lines, left of a row at this depth: trail[L-1] says whether level L carries on below this row
      const LINE = 'position:absolute;background:#ced4da;';
      const treeLines = (depth, trail) => {
        const box = el('span', { style: 'position:absolute;left:' + (-depth * 14) + 'px;top:0;bottom:0;width:' + depth * 14 + 'px;pointer-events:none' });
        for (let L = 1; L <= depth; L++) {
          const x = (L - 1) * 14 + 6;
          if (L === depth) {
            box.append(el('span', { style: LINE + 'left:' + x + 'px;width:1px;top:0;' + (trail[L - 1] ? 'bottom:0' : 'height:50%') }));
            box.append(el('span', { style: LINE + 'left:' + x + 'px;right:2px;height:1px;top:50%' }));
          } else if (trail[L - 1]) box.append(el('span', { style: LINE + 'left:' + x + 'px;width:1px;top:0;bottom:0' }));
        }
        return box;
      };
      const folded = new Set(state.treeFolded || []);
      const selIds = new Set([...state.selNodes, ...[...state.sel].map(k => parseKey(k).node)]);
      const holdsSel = (id) => { const n = sc.nodes[id]; return !!n && isContainer(n) && n.children.some(c => c != null && (selIds.has(c) || holdsSel(c))); };
      // groups, booleans and cloners fold their contents away (remembered)
      const twisty = (n) => {
        if (!isContainer(n)) return el('span', { style: 'display:inline-block;width:11px' });
        const t = el('span', { style: 'display:inline-block;width:11px;color:#868e96;font-size:10px;cursor:pointer', title: folded.has(n.id) ? 'Show its contents' : 'Hide its contents' }, folded.has(n.id) ? '▸' : '▾');
        t.addEventListener('click', (e) => {
          e.stopPropagation();
          if (folded.has(n.id)) folded.delete(n.id); else folded.add(n.id);
          state.treeFolded = [...folded]; saveSettings(); renderAll();
        });
        t.addEventListener('dblclick', (e) => e.stopPropagation());
        return t;
      };
      // the switches on the right of each row: drawn in the cross-section views, drawn in 3D, can be picked in the views
      // (a switch turned off on a group or symmetry holds for everything inside; inside, it shows faded)
      const COLS = [['hide2d', 'eye', 'eyeoff', 'Shown in the cross-section views (radius/height and overhead)'], ['hide3d', 'eye', 'eyeoff', 'Shown in the 3D view (exports always have it)'], ['locked', 'pick', 'pickoff', 'Can be picked and changed in the views (the list still selects it)']];
      const flagCells = (id) => {
        const n = sc.nodes[id], pr = findParent(sc, id), par = pr && pr.parent != null ? pr.parent : null;
        return el('span', { style: 'position:absolute;right:2px;top:0;bottom:0;display:flex;align-items:center;gap:2px;background:inherit' },
          ...COLS.map(([k, on, off, tip]) => {
            const own = !!n[k], inh = !own && par != null && nodeFlag(sc, par, k), offNow = own || inh;
            const b = el('span', { style: 'display:inline-flex;width:18px;justify-content:center;cursor:pointer;color:' + (offNow ? '#adb5bd' : '#495057') + ';opacity:' + (inh ? 0.5 : 1),
              title: tip + (own ? ' — off (click to turn on)' : inh ? ' — off, from what holds it' : ' — on (click to turn off)'), 'data-flag': k }, icon(offNow ? off : on, 13));
            b.addEventListener('click', (e) => {
              e.stopPropagation();
              pushUndo();
              if (n[k]) delete n[k]; else n[k] = true;
              if (k === 'locked' && n[k]) state.sel = new Set([...state.sel].filter(x => !subtreeIds(sc, id).has(parseKey(x).node)));
              state.edited = true;
              if (k === 'hide3d') recalc(); else renderAll();
            });
            b.addEventListener('dblclick', (e) => e.stopPropagation());
            return b;
          }));
      };
      const nodeRow = (id, depth, label, drop, trail = []) => {
        const n = sc.nodes[id], selected = state.selNodes.has(id);
        // dropping onto a group adds to it; onto a boolean fills its first empty slot; onto anything else inserts before it
        let target = drop;
        if (n.type === 'group' || n.type === 'cloner') target = { parent: id, slot: null };
        else if (n.type === 'boolean') { const s = n.children.indexOf(null); target = s >= 0 ? { parent: id, slot: s } : drop; }
        mkRow({ id, drop: target, title: 'Drag onto a group, a boolean slot or the scene to move it',
          style: 'position:relative;padding:1px 64px 1px 4px;margin-left:' + depth * 14 + 'px;border-radius:4px;cursor:pointer;user-select:none;background-color:#fff;transition:background-color .15s,outline-color .15s;' + (selected ? 'background:#ddf4ff;outline:1px solid #54aeff' : folded.has(id) && holdsSel(id) ? 'background:#eef8ff;outline:1px dashed #a5d8ff' : ''),
          kids: [treeLines(depth, trail), twisty(n),
            el('span', { style: 'display:inline-flex;vertical-align:-2px;margin-right:4px;color:' + (COLORS[n.type] || '#555') }, icon(nodeIcon(n), 14)), (label ? label + ' ' : '') + (n.name || id),
            n.type === 'boolean' ? el('span', { style: 'color:#888' }, ' (' + (n.op === 'difference' ? 'A − B' : n.op) + ')') : n.type === 'group' ? el('span', { style: 'color:#888' }, ' (group, ' + n.children.length + ')')
              : n.type === 'cloner' ? el('span', { style: 'color:#888' }, ' (×' + n.params.count + ', ' + n.params.orient + (n.params.keepOrient ? ', fixed' : '') + ')') : null, flagCells(id)] });
        if (folded.has(id)) return;
        if (n.type === 'boolean') n.children.forEach((c, s) => {
          const tr = [...trail, s < n.children.length - 1];
          if (c != null) nodeRow(c, depth + 1, s ? 'B:' : 'A:', { parent: id, slot: s }, tr);
          else mkRow({ drop: { parent: id, slot: s }, style: 'position:relative;padding:1px 4px;margin-left:' + (depth + 1) * 14 + 'px;color:#999;font-style:italic;border-radius:4px',
            kids: [treeLines(depth + 1, tr), (s ? 'B' : 'A') + ': empty — drop an object here'] });
        });
        if (n.type === 'group' || n.type === 'cloner') {
          n.children.forEach((c, i) => nodeRow(c, depth + 1, null, { parent: id, slot: i }, [...trail, i < n.children.length - 1]));
          if (!n.children.length) mkRow({ drop: { parent: id, slot: null }, style: 'position:relative;padding:1px 4px;margin-left:' + (depth + 1) * 14 + 'px;color:#999;font-style:italic;border-radius:4px', kids: [treeLines(depth + 1, [...trail, false]), 'empty — drop objects here'] });
        }
      };
      mkRow({ drop: { parent: null, slot: null }, style: 'position:relative;color:#666;padding:1px 64px 1px 4px;border-radius:4px', title: 'Drop here to move to the top level (hold Ctrl to copy)',
        kids: ['Scene', el('span', { style: 'position:absolute;right:2px;top:0;bottom:0;display:flex;align-items:center;gap:2px;font:700 9px/1 sans-serif;color:#868e96' },
          ...[['2D', COLS[0][3]], ['3D', COLS[1][3]], ['pick', COLS[2][3]]].map(([t, tip]) => el('span', { style: 'display:inline-flex;width:18px;justify-content:center', title: tip }, t)))] });
      sc.root.forEach((id, i) => nodeRow(id, 1, null, { parent: null, slot: i }, [i < sc.root.length - 1]));
      return el('div', { style: BOX },
        el('div', { style: H }, 'Objects'),
        rows);
    }

    function parentChoices(id) {
      const sc = state.scene, own = subtreeIds(sc, id), cur = findParent(sc, id), out = [['root', 'Scene (top level)']];
      for (const n of Object.values(sc.nodes)) {
        if (!isContainer(n) || own.has(n.id)) continue;
        if (n.type === 'group' || n.type === 'cloner') out.push([n.id + ':g', (n.name || n.id) + ' (' + n.type + ')']);
        else n.children.forEach((c, s) => out.push([n.id + ':' + s, (n.name || n.id) + ' — ' + (s ? 'B' : 'A') + (c != null && c !== id ? ' (swap with ' + (sc.nodes[c].name || c) + ')' : '')]));
      }
      const value = !cur || cur.parent === null ? 'root' : sc.nodes[cur.parent].type !== 'boolean' ? cur.parent + ':g' : cur.parent + ':' + cur.slot;
      return { out, value };
    }

    function propsBlock() {
      const sc = state.scene, ids = topSelected(sc);
      if (!ids.length) return el('div', { style: BOX }, el('div', { style: H }, 'Properties'), 'Select an object in the list or click inside its cross-section.');
      if (ids.length > 1) return el('div', { style: BOX }, el('div', { style: H }, ids.length + ' objects selected'), el('div', { style: 'color:#666' }, ids.length + ' objects selected'));
      const n = sc.nodes[ids[0]], U = ' (' + UNIT_LABEL + ')', UX = ', ' + UNIT_LABEL + ')';
      const box = el('div', { style: BOX }, el('div', { style: H }, 'Properties — ' + (n.name || n.id)));
      const nameIn = el('input', { type: 'text', value: n.name || '', style: 'width:160px;box-sizing:border-box' });
      nameIn.addEventListener('change', () => { pushUndo(); n.name = nameIn.value; if (n.type === 'thread') for (const r of n.runs) r.label = n.name || 'Thread'; renderAll(); });
      const pc = parentChoices(n.id);
      box.append(el('div', { style: 'font:700 10px/1.4 sans-serif;letter-spacing:.05em;text-transform:uppercase;color:#868e96' }, 'Object'), pgrid(2, ['Name', nameIn], ['Parent', selectInput(pc.value, pc.out, v => {
          const snap = clone(sc);
          const t = v === 'root' ? { parent: null, slot: null } : v.endsWith(':g') ? { parent: v.slice(0, -2), slot: null } : { parent: v.split(':')[0], slot: +v.split(':')[1] };
          if (moveNodeTo(sc, n.id, t)) { pushSnap(snap); markEdited(); recalc(); }
        }, 'max-width:180px')]));
      // a titled group; clicking its title folds it (remembered across objects and visits)
      const sect = (title, ...kids) => {
        const folded = (state.collapsed || []).includes(title), body = el('div', { style: folded ? 'display:none' : '' }, ...kids.filter(k => k != null));
        const head = el('div', { style: 'display:inline-block;font:700 10px/1.4 sans-serif;letter-spacing:.05em;text-transform:uppercase;color:#868e96;cursor:pointer;user-select:none', title: folded ? 'Show' : 'Hide' },
          el('span', { style: 'display:inline-block;width:10px' }, folded ? '▸' : '▾'), title);
        head.addEventListener('click', () => {
          const set = new Set(state.collapsed || []);
          if (set.has(title)) set.delete(title); else set.add(title);
          state.collapsed = [...set]; saveSettings(); renderSide();
        });
        return el('div', { style: 'border-top:1px solid #e9ecef;margin-top:5px;padding-top:3px' }, head, body);
      };
      // circle precision for this object (blank = the export setting)
      const precisionField = () => ['Circular precision (edges)', numInput(() => n.precision || '', v => {
        pushUndo(); n.precision = v == null ? null : Math.max(3, Math.min(300, Math.round(v))); markEdited(); recalc();
      }, { step: '1', min: 3, max: 300, digits: 0, width: 96, allowEmpty: true, placeholder: 'default ' + state.precision, title: 'Edges around a full circle for this object; leave blank to use the export setting' })];

      if (n.type === 'boolean') {
        box.append(sect('Boolean', pgrid(1, ['Operation', selectInput(n.op, [['union', 'Union (A ∪ B)'], ['difference', 'Difference (A − B)'], ['intersection', 'Intersection (A ∩ B)']], v => { pushUndo(); n.op = v; markEdited(); recalc(); }),
          el('button', { type: 'button', style: BTN2, onclick: () => { pushUndo(); n.children.reverse(); markEdited(); recalc(); } }, 'Swap A ↔ B')])));
        return box;
      }
      if (n.type === 'group') return box;
      if (n.type === 'geo') {
        const q = n.params;
        const setG = (mut) => {
          if (!state.undoLock || !editBase || editBase.id !== n.id) { pushUndo(); editBase = { id: n.id, q: clone(n.params) }; }
          else Object.assign(n.params, clone(editBase.q));
          mut(n.params); markEdited(); recalc();
        };
        box.append(sect('Geometric', pgrid(2,
          ['Bottom y offset' + U, numInput(() => hDisp(lowEnd(q.z, q.h), zBase()), v => setG(t => { t.z = fromLowEnd(hInv(v, zBase()), t.h); }))],
          ['Height' + U, numInput(() => mm(q.h), v => setG(t => { t.h = Math.max(0.01 / UNIT_SCALE, v / UNIT_SCALE); }), { min: 0.01 })],
          ['Centre x' + U, numInput(() => mm(q.cx), v => setG(t => { t.cx = v / UNIT_SCALE; }))],
          ['Centre y' + U, numInput(() => mm(q.cy), v => setG(t => { t.cy = v / UNIT_SCALE; }))]),
          state.rotMode === 'relative'
            ? pgrid(3, ...[['x', [1, 0, 0]], ['y', [0, 1, 0]], ['height', [0, 0, 1]]].map(([lab, ax]) => ['Turn about ' + lab + ' by (' + ANG_LABEL.trim() + ')',
              numInput(() => 0, v => { if (v) setG(t => geoTurn(t, ax, v / ANG_SCALE * Math.PI / 180)); }, { step: ANG_SCALE === 1 ? '15' : '0.25', digits: 4, width: 70, title: 'Turn it about the scene\'s ' + lab + ' axis, through its centre, by this much' })]))
            : pgrid(3, ...[['x', 'rx'], ['y', 'ry'], ['height', 'rz']].map(([lab, k]) => ['Rotation about ' + lab + ' (' + ANG_LABEL.trim() + ')',
              numInput(() => (q[k] || 0) * ANG_SCALE, v => setG(t => { t[k] = v / ANG_SCALE; }), { step: ANG_SCALE === 1 ? '15' : '0.25', digits: 4, width: 70 })])),
          el('div', { style: 'color:#666;font-size:11px;margin-top:3px' }, n.shape.length + ' corners. From above: drag it, a corner or an edge to move them (Ctrl snaps); right-click an edge to add corners, a corner to bevel or delete it. Its centre stays the middle of its corners.')));
        return box;
      }
      if (n.type === 'cloner') {
        const q = n.params;
        const setC = (k, v) => { pushUndo(); q[k] = v; markEdited(); recalc(); };
        box.append(sect('Copies', pgrid(2,
          ['Copies', numInput(() => q.count, v => setC('count', Math.max(1, Math.min(360, Math.round(v)))), { step: '1', min: 1, max: 360, digits: 0, width: 80 })],
          ['Orientation', selectInput(q.orient, [['axial', 'axial (parallel to the axis)'], ['radial', 'radial (pointing outward)']], v => setC('orient', v))],
          ['Copies turn', selectInput(q.keepOrient ? 'keep' : 'turn', [['turn', 'with their place round the axis'], ['keep', 'not (keep the first copy\'s orientation)']], v => setC('keepOrient', v === 'keep'))],
          ['Angle offset (' + ANG_LABEL.trim() + ')', numInput(() => q.angle * ANG_SCALE, v => setC('angle', v / ANG_SCALE), { step: ANG_SCALE === 1 ? '1' : '0.01', digits: 4, width: 80 })],
          ['Spread (' + ANG_LABEL.trim() + ')', numInput(() => q.spread * ANG_SCALE, v => setC('spread', Math.max(0, Math.min(360, v / ANG_SCALE))), { step: ANG_SCALE === 1 ? '5' : '0.05', min: 0, max: 360 * ANG_SCALE, digits: 4, width: 80 })])),
          sect('Placement', pgrid(2,
          ['Distance from axis (x' + UX, numInput(() => mm(q.radius), v => setC('radius', Math.max(0, v / UNIT_SCALE)), { min: 0 })],
          q.orient === 'radial' ? ['Copies\' axis height (y' + UX, numInput(() => hDisp(q.height, zBase()), v => setC('height', hInv(v, zBase())))] : null)));
        return box;
      }
      if (n.type === 'thread') {
        const q = n.params, setT = (mut) => setParams(n, mut);
        const stdOf = (P, prof) => (prof === 'v' ? V_DEPTH : ISO_DEPTH) * P;
        const isStd = (t) => near(t.depth, stdOf(t.pitch, t.profile));       // depth not overridden
        const presetSel = el('select', { style: 'font-size:12px;max-width:330px' }, el('option', { value: '' }, 'custom'),
          ...THREAD_GROUPS.map(([g, list]) => el('optgroup', { label: g }, ...list.map(([k, label]) => el('option', { value: k }, label)))));
        presetSel.value = THREAD_PRESETS.some(p => p[0] === q.preset) ? q.preset : '';
        presetSel.addEventListener('change', () => {
          const p = THREAD_PRESETS.find(x => x[0] === presetSel.value); if (!p) return;
          setT(t => { const std = isStd(t), L = t.turns * t.pitch; t.preset = p[0]; t.d = p[2] / MM; t.pitch = p[3] / MM; t.turns = Math.max(1, L / t.pitch); if (std) t.depth = stdOf(t.pitch, t.profile); });
        });
        const backing = () => q.backing != null ? q.backing : q.wall / q.depth;
        const diam = () => (q.kind === 'internal' ? 'Minor Ø ' + num(mm(q.d - 2 * ISO_DEPTH * q.pitch + 2 * (q.clearance || 0)), 3) + ', major Ø ' + num(mm(q.d - 2 * ISO_DEPTH * q.pitch + 2 * q.depth + 2 * (q.clearance || 0)), 3)
          : 'Major Ø ' + num(mm(q.d - 2 * (q.clearance || 0)), 3) + ', minor Ø ' + num(mm(q.d - 2 * q.depth - 2 * (q.clearance || 0)), 3)) + ' ' + UNIT_LABEL + ' (basic sizes).';
        box.append(sect('Standard', pgrid(2,
          ['Standard', presetSel], GBR,
          ['Gender', selectInput(q.kind, [['external', 'male (external)'], ['internal', 'female (internal)']], v => setT(t => { t.kind = v; }))],
          ['Direction', selectInput(String(q.hand), [['1', 'standard (right-hand)'], ['-1', 'reverse (left-hand)']], v => setT(t => { t.hand = +v; }), 'max-width:180px')])),
          sect('Size', pgrid(2,
          ['Nominal Ø' + U, numInput(() => mm(q.d), v => setT(t => { t.d = Math.max(0.1 / UNIT_SCALE, v / UNIT_SCALE); t.preset = ''; }), { min: 0.1 })],
          ['Pitch' + U, numInput(() => mm(q.pitch), v => setT(t => {
            const P = Math.max(0.05 / UNIT_SCALE, v / UNIT_SCALE), std = isStd(t), L = t.turns * t.pitch;
            t.pitch = P; t.turns = Math.max(1, L / P); t.preset = ''; if (std) t.depth = stdOf(P, t.profile);
          }), { step: '0.05', min: 0.05 }), dyn(() => '= ' + num(1 / q.pitch, 2) + ' TPI')],
          ['Profile', selectInput(q.profile, [['iso', 'ISO 60° (flats)'], ['v', 'sharp 60° V']], v => setT(t => { const std = isStd(t); t.profile = v; if (std) t.depth = stdOf(t.pitch, v); }))],
          ['Depth (x' + UX, numInput(() => mm(q.depth), v => setT(t => { t.depth = Math.max(0.01 / UNIT_SCALE, v / UNIT_SCALE); }), { step: '0.01', min: 0.01 }),
            el('button', { type: 'button', style: BTN2 + ';padding:2px 6px', onclick: () => setT(t => { t.depth = stdOf(t.pitch, t.profile); }), title: 'ISO basic depth 5H/8 = 0.541 × pitch, or H = 0.866 × pitch for a sharp V' }, 'standard')],
          { wide: dyn(diam, 'color:#666;font-size:11px') })),
          sect('Length and position', pgrid(2,
          ['Turns', numInput(() => q.turns, v => setT(t => { t.turns = Math.max(1, v); }), { step: '0.5', min: 1, digits: 3 })],
          ['Length (y' + UX, numInput(() => mm(q.turns * q.pitch), v => setT(t => { t.turns = Math.max(1, v / UNIT_SCALE / t.pitch); }), { step: '0.5' })],
          ['Bottom y offset' + U, numInput(() => hDisp(lowEnd(q.z, q.turns * q.pitch), zBase()), v => setT(t => { t.z = fromLowEnd(hInv(v, zBase()), t.turns * t.pitch); }))])),
          sect('Backing', pgrid(2,
          ['Solid backing (× depth)', numInput(backing, v => setT(t => { t.backing = Math.max(0.05, v); }), { step: '0.25', min: 0.05, digits: 3 })],
          ['Backing (x' + UX, numInput(() => mm(backing() * q.depth), v => setT(t => { t.backing = Math.max(0.05, v / UNIT_SCALE / t.depth); }), { step: '0.1' })])),
          sect('Ends and fit', pgrid(2,
          ['Lead-in taper', checkInput(() => q.taperBottom, v => setT(t => { t.taperBottom = v; }), 'bottom'), checkInput(() => q.taperTop, v => setT(t => { t.taperTop = v; }), 'top')],
          ['Clearance (x' + UX, numInput(() => mm(q.clearance || 0), v => setT(t => { t.clearance = v / UNIT_SCALE; }), { step: '0.05', title: 'Shrinks a male thread / enlarges a female one, for printed fits' })])),
          sect('Detail', pgrid(2, precisionField())));
        return box;
      }
      if (n.type === 'holes') {
        box.append(sect('Holes', el('div', { style: 'color:#666' }, (n.holes || []).length + ' hole(s) from an imported project, as one solid. Put it in the B slot of a difference boolean to cut them out. They are not drawn in the cross-section.')));
        return box;
      }
      if (n.type === 'source') {
        box.append(sect('Detail', pgrid(2, precisionField())));
        if ((n.holes || []).length) box.append(el('div', { style: 'color:#666' }, n.holes.length + ' hole(s) are cut out.'));
        return box;
      }
      const q = n.params, cg = n.type === 'cog';
      // a cog's bore stays inside its root circle
      const setP = (mut) => setParams(n, t => { mut(t); if (cg) cogClamp(t); });
      const len = (k, o) => numInput(() => mm(q[k]), v => setP(t => {
        t[k] = Math.max(k === 'h' ? 0.01 / UNIT_SCALE : 0, v / UNIT_SCALE);
        if (k === 'rib' && t.linkIn) t.rit = t.rib;
        if (k === 'rob' && t.linkOut) t.rot = t.rob;
      }), o);
      const ng = n.type === 'ngon';
      appendKids(box, ng ? sect('N-sided', pgrid(2,
        ['Sides', numInput(() => q.sides, v => setP(t => { t.sides = Math.max(3, Math.min(256, Math.round(v))); }), { step: '1', min: 3, max: 256, digits: 0 })],
        ['Radius about', selectInput(q.about, [['faces', 'face centres'], ['edges', 'edges']], v => setP(t => { t.about = v; }))],
        ['Rotation (' + ANG_LABEL.trim() + ')', numInput(() => (q.rotation || 0) * ANG_SCALE, v => setP(t => { t.rotation = v / ANG_SCALE; }), { step: ANG_SCALE === 1 ? '1' : '0.01', digits: 4 })])) : null,
        cg ? sect('Teeth', pgrid(2,
        ['Teeth on the', selectInput(cogIn(q) ? 'internal' : 'external', [['external', 'outside (spur gear)'], ['internal', 'inside (ring gear)']], v => setP(t => {
          t.kind = v;
          if (v === 'internal') { const r = cogRoot(t) + 2.5 / MM; t.rob = Math.max(t.rob, r); t.rot = Math.max(t.rot, r); }
          else { const r = Math.min(3 / MM, cogRoot(t) / 2); t.rib = Math.min(t.rib, r); t.rit = Math.min(t.rit, r); }
        }), 'max-width:180px')], GBR,
        ['Teeth', numInput(() => q.teeth, v => setP(t => {
          // the cog keeps its size: more teeth are smaller ones (the tips stay on the same circle; the module follows)
          const tip = cogTip(t), n = Math.max(3, Math.min(400, Math.round(v))), per = n / 2 + (cogIn(t) ? -t.addendum : t.addendum);
          t.teeth = n;
          if (per > 0.05 && tip > 0) {
            // ... and keep their shape: the lengths set per tooth (roundings, backlash) scale with the module
            const m0 = t.module;
            t.module = Math.max(0.01 / MM, tip / per);
            const f = t.module / m0;
            for (const k of ['tipRound', 'rootRound', 'backlash']) if (t[k]) t[k] *= f;
          }
        }), { step: '1', min: 3, max: 400, digits: 0, title: 'The cog keeps its size; the teeth get smaller or bigger to fit' })],
        ['Module' + U, numInput(() => mm(q.module), v => setP(t => { t.module = Math.max(0.01 / MM, v / UNIT_SCALE); }), { step: UNIT_SCALE === 1 ? '0.005' : '0.1', min: 0.01, title: 'Pitch diameter ÷ teeth' })],
        ['Pressure angle (' + ANG_LABEL.trim() + ')', numInput(() => q.pressure * ANG_SCALE, v => setP(t => { t.pressure = Math.max(5, Math.min(40, v / ANG_SCALE)); }), { step: ANG_SCALE === 1 ? '0.5' : '0.01', digits: 4 })],
        ['Rotation (' + ANG_LABEL.trim() + ')', numInput(() => (q.rotation || 0) * ANG_SCALE, v => setP(t => { t.rotation = v / ANG_SCALE; }), { step: ANG_SCALE === 1 ? '1' : '0.01', digits: 4 })],
        ['Addendum (× module)', numInput(() => q.addendum, v => setP(t => { t.addendum = Math.max(0, Math.min(3, v)); }), { step: '0.05', min: 0, max: 3, digits: 3, title: 'Tooth height above the pitch circle' })],
        ['Dedendum (× module)', numInput(() => q.dedendum, v => setP(t => { t.dedendum = Math.max(0, cogIn(t) ? Math.min(3, v) : Math.min(q.teeth / 2 - 0.05, v)); }), { step: '0.05', min: 0, max: 3, digits: 3, title: 'Tooth depth below the pitch circle' })],
        ['Tooth width (× pitch)', numInput(() => q.toothWidth > 0 ? q.toothWidth : 0.5, v => setP(t => { t.toothWidth = Math.max(0.1, Math.min(0.9, v)); }), { step: '0.01', min: 0.1, max: 0.9, digits: 3, title: 'The tooth\'s share of the pitch at the pitch circle (0.5: as wide as the gaps)' })],
        ['Tip rounding' + U, numInput(() => mm(q.tipRound || 0), v => setP(t => { t.tipRound = Math.max(0, v / UNIT_SCALE); }), { step: UNIT_SCALE === 1 ? '0.005' : '0.05', min: 0, title: 'Rounds the teeth\'s top corners (seen from above)' })],
        ['Root rounding' + U, numInput(() => mm(q.rootRound || 0), v => setP(t => { t.rootRound = Math.max(0, v / UNIT_SCALE); }), { step: UNIT_SCALE === 1 ? '0.005' : '0.05', min: 0, title: 'Rounds the corners between the teeth (seen from above)' })],
        ['Backlash' + U, numInput(() => mm(q.backlash || 0), v => setP(t => { t.backlash = Math.max(0, v / UNIT_SCALE); }), { step: UNIT_SCALE === 1 ? '0.001' : '0.02', min: 0, title: 'Taken off each tooth\'s width at the pitch circle, for a looser mesh' })],
        { wide: dyn(() => 'Pitch Ø ' + num(mm(q.module * q.teeth), 3) + ', tip Ø ' + num(mm(2 * cogTip(q)), 3) + ', root Ø ' + num(mm(2 * cogRoot(q)), 3) + ' ' + UNIT_LABEL +
          (UNIT_SCALE === 1 ? ' · diametral pitch ' + num(1 / q.module, 3) : '') + ' · circular pitch ' + num(mm(Math.PI * q.module), 3) + ' ' + UNIT_LABEL, 'color:#666;font-size:11px') })) : null,
        sect('Position and height', pgrid(2,
        ['Bottom y offset' + U, numInput(() => hDisp(lowEnd(q.z, q.h), zBase()), v => setP(t => { t.z = fromLowEnd(hInv(v, zBase()), t.h); }))],
        ['Height' + U, len('h', { min: 0.01 })])),
        cg && cogIn(q) ? sect('Rim', pgrid(2,
        ['Rim radius bottom (x' + UX, len('rob', { min: 0 })],
        ['Rim radius top (x' + UX, len('rot', { min: 0, disabled: q.linkOut })],
        ['Linked', checkInput(() => q.linkOut, v => setP(t => { t.linkOut = v; t.rot = t.rob; }), 'top = bottom')])) :
        cg ? sect('Bore', pgrid(2,
        ['Bore radius bottom (x' + UX, len('rib', { min: 0 })],
        ['Bore radius top (x' + UX, len('rit', { min: 0, disabled: q.linkIn })],
        ['Linked', checkInput(() => q.linkIn, v => setP(t => { t.linkIn = v; t.rit = t.rib; }), 'top = bottom')])) : sect('Radii', pgrid(2,
        ['Inner bottom (x' + UX, len('rib', { min: 0 })],
        ['Inner top (x' + UX, len('rit', { min: 0, disabled: q.linkIn })],
        ['Outer bottom (x' + UX, len('rob', { min: 0 })],
        ['Outer top (x' + UX, len('rot', { min: 0, disabled: q.linkOut })],
        ['Linked inner', checkInput(() => q.linkIn, v => setP(t => { t.linkIn = v; t.rit = t.rib; }), 'top = bottom')],
        ['Linked outer', checkInput(() => q.linkOut, v => setP(t => { t.linkOut = v; t.rot = t.rob; }), 'top = bottom')])),
        sect('Bevel', pgrid(2,
        ['Bevel radius' + U, len('bevel', { min: 0 })],
        ['Bevel edges', numInput(() => q.bevelSegs, v => setP(t => { t.bevelSegs = Math.max(1, Math.min(64, Math.round(v))); }), { step: '1', min: 1, max: 64, digits: 0 })],
        ['Bevel shape', selectInput(q.bevelShape || (q.bevelOut ? 'convex' : 'concave'), BEVEL_SHAPES, v => setP(t => { const b = bevelFromShape(v); t.bevelOut = b.out; t.bevelShape = b.shape || null; }), 'max-width:200px')])),
        ng ? null : sect('Detail', pgrid(2, precisionField())));
      return box;
    }

    function libraryBlock() {
      const list = libLoad();
      const box = el('div', null, el('div', { style: H + ';display:flex;align-items:center;gap:6px' }, 'Saved models (this browser)',
        list.length ? hbtn('json', 'Export all', () => exportModelsJson(list, 'saved-models'), { title: 'All saved models in one JSON file' }) : null));
      if (!list.length) box.append(el('div', { style: 'color:#666' }, 'Nothing saved yet.'));
      for (const entry of list) {
        const nameIn = el('input', { type: 'text', value: entry.name, style: 'flex:1 1 120px;min-width:80px;font-size:12px' });
        nameIn.addEventListener('change', () => { const l = libLoad(), it = l.find(x => x.id === entry.id); if (it) { it.name = nameIn.value; libStore(l); } });
        const count = Object.keys(entry.model.nodes).length;
        box.append(el('div', { style: 'display:flex;gap:3px;align-items:center;flex-wrap:wrap;padding:2px 0;border-top:1px solid #e6e8eb' },
          nameIn, el('span', { style: 'color:#888;font-size:11px;white-space:nowrap' }, count + ' obj · ' + new Date(entry.date).toLocaleDateString()),
          hbtn('add', 'Insert', () => insertFromLibrary(entry), { title: 'Adds a copy to the current scene (into the selected group or empty boolean slot if one is selected)' }),
          hbtn('download', state.format.toUpperCase(), () => exportEntry(entry), { title: 'Export ' + state.format.toUpperCase() }),
          hbtn('json', 'JSON', () => exportModelsJson([entry], entry.name), { title: 'A file that can be loaded again (Import JSON) to rebuild this model' }),
          hbtn('trash', '', () => { libStore(libLoad().filter(x => x.id !== entry.id)); state.libMessage = null; renderAll(); }, { title: 'Delete', color: '#b42318' })));
      }
      return box;
    }

    let sideSig = null;
    // A block from the old single panel, shown bare inside its own view (its own title row dropped).
    function bare(b, keepHead) {
      if (!b) return null;
      Object.assign(b.style, { border: '0', padding: '0', margin: '0', background: 'none', boxShadow: 'none' });
      if (!keepHead && b.firstChild && b.firstChild.nodeType === 1) b.firstChild.remove();
      return b;
    }
    // the project's state, short, beside the Project header (the full text on hover)
    function headStatus(s) {
      const x = panels.project.extra;
      x.textContent = s.text.startsWith('Error') ? '✘ error' : state.busy ? 'updating…' : '';
      x.style.color = s.color; x.title = s.text;
      // the download button follows the chosen format (and the state) even while a field is being edited
      const b = panels.project.tools.querySelector('[data-dl]');
      if (b) {
        const l = b.querySelector('.aa-hl'); if (l) l.textContent = 'Download ' + (state.format || 'stl').toUpperCase();
        b.disabled = !s.ready; b.style.opacity = s.ready ? '' : '0.45'; b.style.cursor = s.ready ? '' : 'default';
        b.title = s.ready ? downloadLabel(s) : 'The part is still being built';
      }
    }
    function renderSide() {
      const fe = document.activeElement;
      const s = statusText();
      if (side.contains(fe) && (fe.tagName === 'SELECT' || (fe.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|range|color)$/.test(fe.type)))) {
        // keep the other fields up to date while one is being edited
        for (const i of side.querySelectorAll('input')) if (i !== document.activeElement && i.__get) i.value = i.__get();
        for (const t of side.querySelectorAll('span')) if (t.__text) t.textContent = t.__text();
        headStatus(s);
        return;
      }
      const tops = {};
      pgridMaxCols = rightBar.clientWidth && rightBar.clientWidth < 560 ? 1 : 2;
      for (const k in panels) { tops[k] = panels[k].body.scrollTop; panels[k].body.textContent = ''; }
      for (const k in panels) panels[k].tools.textContent = '';
      appendKids(panels.project.tools,
        hbtn('undo', 'Undo', undo, { title: 'Undo (Ctrl+Z)', disabled: !state.undo.length }),
        hbtn('redo', 'Redo', redo, { title: 'Redo (Ctrl+Y or Ctrl+Shift+Z)', disabled: !state.redo.length }),
        hbtn('save', 'Save scene', saveScene, { title: 'Save everything in the scene to Saved models', disabled: !(state.scene && state.scene.root.length) }),
        hbtn('json', 'Export', exportSceneJson, { title: 'Export the whole scene as a JSON file that Import can rebuild it from', disabled: !state.scene }),
        hbtn('upload', 'Import', pickJsonFile, { title: 'Import a scene or saved models from a JSON file' }),
        hbtn('fit', 'Fit', () => { fit(); drawSection(); }, { title: 'Fit the cross-section view' }),
        (() => { const b = hbtn('download', 'Download ' + (state.format || 'stl').toUpperCase(), download, { title: s.ready ? downloadLabel(s) : 'The part is still being built', disabled: !s.ready });
          b.style.background = '#1f6feb'; b.style.color = '#fff'; b.style.borderColor = '#1f6feb'; b.setAttribute('data-dl', '1'); return b; })());
      const msg = state.exportError || (state.exporting ? 'Exporting ' + state.exporting + '…' : state.libMessage) || '';
      appendKids(panels.project.body,
        msg ? el('div', { style: 'margin-bottom:4px;color:' + (state.exportError ? '#b42318' : '#1a7f37') }, msg) : null,
        el('div', { style: 'margin-top:5px;padding-top:4px;border-top:1px solid #e9ecef' }, settingsBlock()));
      headStatus(s);
      if (state.scene) {
        panels.objects.body.append(bare(treeBlock()));
        const nSel = state.selNodes.size;
        appendKids(panels.objects.tools,
          hbtn('circle', 'Radial', () => addObject('circle', addView()), { title: 'Add a radial (round) ring', color: COLORS.circle }),
          hbtn('ngon', 'N-sided', () => addObject('ngon', addView()), { title: 'Add an n-sided ring', color: COLORS.ngon }),
          hbtn('cog', 'Cog', () => addObject('cog', addView()), { title: 'Add a cog (spur gear with involute teeth)', color: COLORS.cog }),
          hbtn('thread', 'Thread', () => addObject('thread', addView()), { title: 'Add a threaded ring, with standard sizes', color: COLORS.thread }),
          hbtn('geo', 'Geometric', () => addObject('geo', null, geoSpawnPoint()), { title: 'Add a geometric object: a flat shape seen from above, stood up between two heights', color: COLORS.geo }),
          hbtn('cloner', 'Symmetry', () => wrapSelection('cloner'), { title: nSel ? 'Put the selected objects in a symmetry (copies round the axis)' : 'Add an empty symmetry (copies round the axis)' }),
          hbtn('group', 'Group', () => wrapSelection('group'), { title: nSel ? 'Group the selected objects' : 'Add an empty group' }),
          hbtn('boolean', 'Boolean', () => wrapSelection('boolean'), { title: 'Add a boolean: with one object selected it becomes A; with two, A and B' }),
          el('span', { style: 'width:1px;height:16px;background:#ced4da;margin:0 2px' }),
          libBtn = hbtn('list', 'Saved models' + (libLoad().length ? ' (' + libLoad().length + ')' : ''), () => toggleLib(), { title: 'Show the saved models, to add one to the scene' }));
        if (libOpen) { libBtn.style.background = '#ddf4ff'; libBtn.style.borderColor = '#54aeff'; }
        panels.objects.extra.textContent = Object.keys(state.scene.nodes).length + ' object' + (Object.keys(state.scene.nodes).length === 1 ? '' : 's');
        const pb = bare(propsBlock());
        if (sideSig !== null && sideSig !== selectionSig()) animIn(pb);
        panels.props.body.append(pb);
        const ids = topSelected(state.scene);
        panels.props.extra.textContent = ids.length === 1 ? (state.scene.nodes[ids[0]].name || ids[0]) : ids.length ? ids.length + ' selected' : '';
        if (ids.length) {
          const one = ids.length === 1 ? state.scene.nodes[ids[0]] : null;
          appendKids(panels.props.tools,
            hbtn('save', 'Save', () => saveToLibrary(ids), { title: ids.length > 1 ? 'Save these ' + ids.length + ' objects as one model in Saved models' : 'Save to Saved models' }),
            one ? hbtn('download', state.format.toUpperCase(), () => exportNode(one.id), { title: 'Export this object as ' + state.format.toUpperCase() }) : null,
            hbtn('group', 'Group', () => wrapSelection('group'), { title: 'Group' }),
            ids.length <= 2 ? hbtn('boolean', 'Boolean', () => wrapSelection('boolean'), { title: ids.length === 2 ? 'Boolean of these two' : 'Wrap in a boolean' }) : null,
            one && one.type === 'group' ? hbtn('ungroup', 'Ungroup', () => ungroup(one.id), { title: 'Ungroup' }) : null,
            hbtn('duplicate', 'Duplicate', () => duplicateNodes(ids), { title: 'Duplicate (Ctrl+D, or Ctrl-drag in the list)' }),
            hbtn('trash', 'Delete', () => deleteNodes(ids), { title: 'Delete', color: '#b42318' }));
        }
      }
      libPop.style.top = (panels.objects.wrap.offsetTop + 24) + 'px';
      libPop.style.display = libOpen ? 'block' : 'none';
      if (libOpen) { const t = libPop.scrollTop; libPop.textContent = ''; libPop.append(libraryBlock()); libPop.scrollTop = t; }
      requestAnimationFrame(fitHeads);
      for (const k in panels) panels[k].body.scrollTop = tops[k];
      sideSig = selectionSig();
    }

    // ---- 3D preview: the mesh that would be downloaded, with filled cut faces ----
    // Passes: (1) normals + depth of the part and its cut faces into a texture, (2) wireframe into its
    // own texture against that depth (so it stays 1 px and aliased), (3) ambient occlusion (SSAO) from
    // the normals and depth, blurred, (4) the shaded part with the occlusion applied, (5) the wireframe.
    const gl = canvas.getContext('webgl', { antialias: true, stencil: true });
    let gridProg = null, gridBuf = null, prog = null, gProg = null, aoProg = null, blurProg = null, copyProg = null, texProg = null, quadBuf = null, fb = null, bbox = null;
    let triBuf = null, lineBuf = null, capBuf = null, triCount = 0, lineCount = 0, center = [0, 0, 0], radius = 1, yaw = yawOf(state.viewAngle), pitchA = 0.5, dist = 3, shown = null, pan = [0, 0, 0];
    if (gl) {
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn('[adapter-assembler] shader', gl.getShaderInfoLog(s)); return s; };
      const program = (vs, fs) => { const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); return p; };
      const VS = 'attribute vec3 pos; attribute vec3 nrm; uniform mat4 mvp; uniform mat4 mv; varying vec3 vN; varying vec3 vP; varying vec3 vVN; varying float vD;' +
        'void main(){ vN = nrm; vP = pos; vVN = (mv * vec4(nrm, 0.0)).xyz; vD = -(mv * vec4(pos, 1.0)).z; gl_Position = mvp * vec4(pos, 1.0); }';
      // up to six cut planes (two on each axis: one cutting away beyond it, one before it): clip[i] = (normal, offset); a point p is cut away when dot(n, p) > offset.
      // mode 0 surfaces, 1 wireframe, 2 cap of plane capPlane (coloured capCol), 3 stencil pass for that cap.
      const CUT = 'uniform vec4 clip[6]; uniform float clipOn[6]; uniform float skip; uniform vec4 capPlane; uniform float capSide; uniform vec3 capCol; uniform float mode;' +
        'bool cutAway(vec3 p){ for (int i = 0; i < 6; i++) { if (clipOn[i] > 0.5 && abs(float(i) - skip) > 0.5 && dot(clip[i].xyz, p) - clip[i].w > 0.0) return true; } return false; }';
      prog = program(VS, [
        'precision highp float; varying vec3 vN; varying vec3 vP; varying vec3 vVN; varying float vD; uniform vec3 eye; ' + CUT,
        'uniform sampler2D aoTex; uniform float aoOn; uniform vec2 res;',
        'void main(){',
        '  float ao = aoOn > 0.5 ? texture2D(aoTex, gl_FragCoord.xy / res).r : 1.0;',
        '  float aoK = 0.3 + 0.7 * ao;',
        // stencil pass for a cap: every surface beyond its plane counts, whatever the other cuts take away (a point of the
        // plane is inside the whole part when an odd number lie beyond it); the cap itself is then cut by the other planes
        '  if (mode > 2.5) { float dd = dot(capPlane.xyz, vP) - capPlane.w; if (dd * capSide >= 0.0) discard; gl_FragColor = vec4(1.0); return; }',
        '  if (mode > 1.5) {',   // cap: the cut face, in its plane's colour, lit from the camera side
        '    if (cutAway(vP)) discard;',
        '    float k = 0.62 + 0.38 * abs(dot(normalize(capPlane.xyz), normalize(eye - vP)));',
        '    gl_FragColor = vec4(capCol * k * aoK, 1.0); return;',
        '  }',
        '  if (cutAway(vP)) discard;',
        '  vec3 n = normalize(vVN); vec3 v = vec3(0.0, 0.0, 1.0); if (n.z < 0.0) n = -n;',     // view space: lights stay with the camera
        '  vec3 base = vec3(0.74, 0.76, 0.8);',
        '  vec3 L1 = normalize(vec3(0.35, 0.55, 0.75)); vec3 L2 = normalize(vec3(-0.5, -0.35, 0.45));',
        '  vec3 col = base * (0.22 * aoK + (0.62 * max(dot(n, L1), 0.0) + 0.25 * max(dot(n, L2), 0.0)) * (0.55 + 0.45 * ao));',
        '  vec3 h = normalize(L1 + v); col += vec3(0.45) * pow(max(dot(n, h), 0.0), 50.0) * ao;',
        '  gl_FragColor = vec4(pow(col, vec3(1.0/1.5)), 1.0);',
        '}'].join('\n'));
      // normals (view space) in rg, linear depth / far packed in ba; mode 1 draws the wireframe colour
      gProg = program(VS, [
        'precision highp float; varying vec3 vN; varying vec3 vP; varying vec3 vVN; varying float vD; uniform float far; uniform float dn; uniform vec3 eye; uniform mat4 mv; ' + CUT,
        'void main(){',
        '  if (mode > 2.5) { float d = dot(capPlane.xyz, vP) - capPlane.w; if (d * capSide >= 0.0) discard; gl_FragColor = vec4(1.0); return; }',
        '  if (cutAway(vP)) discard;',
        '  if (mode > 0.5 && mode < 1.5) { gl_FragColor = vec4(0.1, 0.1, 0.12, 1.0); return; }',
        '  vec3 n = normalize(mode > 1.5 ? (mv * vec4(capPlane.xyz, 0.0)).xyz : vVN); if (n.z < 0.0) n = -n;',
        '  float d = clamp((vD - dn) / (far - dn), 0.0, 0.999); vec2 e = fract(vec2(1.0, 255.0) * d); e.x -= e.y / 255.0;',
        '  gl_FragColor = vec4(n.xy * 0.5 + 0.5, e);',
        '}'].join('\n'));
      const QVS = 'attribute vec2 q; varying vec2 uv; void main(){ uv = q * 0.5 + 0.5; gl_Position = vec4(q, 0.0, 1.0); }';
      const kernel = [];
      for (let i = 0; i < 16; i++) {
        // points in the hemisphere around +z, denser near the centre
        const a = i * 2.399963, rr = Math.sqrt((i + 0.5) / 16), zz = Math.sqrt(Math.max(0, 1 - rr * rr)), s = 0.15 + 0.85 * Math.pow((i + 1) / 16, 2);
        kernel.push(Math.cos(a) * rr * s, Math.sin(a) * rr * s, Math.max(0.1, zz) * s);
      }
      aoProg = program(QVS, [
        'precision highp float; varying vec2 uv; uniform sampler2D g; uniform vec2 proj; uniform float far; uniform float dn; uniform float R; uniform vec3 K[16];',
        'float depthAt(vec2 t){ vec4 c = texture2D(g, t); return dn + dot(c.ba, vec2(1.0, 1.0/255.0)) * (far - dn); }',
        'vec3 posAt(vec2 t, float d){ return vec3((t * 2.0 - 1.0) / proj * d, -d); }',
        'void main(){',
        '  vec4 c = texture2D(g, uv); float d0 = dot(c.ba, vec2(1.0, 1.0/255.0));',
        '  if (d0 > 0.998) { gl_FragColor = vec4(1.0); return; }',
        '  float d = dn + d0 * (far - dn); vec3 p = posAt(uv, d);',
        '  vec2 nxy = c.rg * 2.0 - 1.0; vec3 n = vec3(nxy, sqrt(max(0.0, 1.0 - dot(nxy, nxy))));',
        '  float ang = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;',
        '  vec3 rv = vec3(cos(ang), sin(ang), 0.0);',
        '  vec3 t = normalize(rv - n * dot(rv, n)); vec3 b = cross(n, t);',
        '  float occ = 0.0;',
        '  for (int i = 0; i < 16; i++) {',
        '    vec3 s = p + (t * K[i].x + b * K[i].y + n * K[i].z) * R;',
        '    vec2 st = (s.xy * proj / -s.z) * 0.5 + 0.5;',
        '    if (st.x < 0.0 || st.y < 0.0 || st.x > 1.0 || st.y > 1.0) continue;',
        '    float sd = depthAt(st);',
        '    float range = smoothstep(0.0, 1.0, R / max(abs(d - sd), 1e-6));',
        '    occ += (sd < -s.z - R * 0.03 ? 1.0 : 0.0) * range;',
        '  }',
        '  gl_FragColor = vec4(vec3(1.0 - occ / 16.0), 1.0);',
        '}'].join('\n'));
      blurProg = program(QVS, 'precision highp float; varying vec2 uv; uniform sampler2D t; uniform vec2 px; void main(){ float s = 0.0; for (int x = -2; x < 2; x++) for (int y = -2; y < 2; y++) s += texture2D(t, uv + (vec2(float(x), float(y)) + 0.5) * px).r; gl_FragColor = vec4(vec3(s / 16.0), 1.0); }');
      copyProg = program(QVS, 'precision highp float; varying vec2 uv; uniform sampler2D t; void main(){ gl_FragColor = texture2D(t, uv); }');
      texProg = program('attribute vec3 pos; attribute vec4 col; uniform mat4 mvp; varying vec4 vC; void main(){ vC = col; gl_Position = mvp * vec4(pos, 1.0); }',
        'precision highp float; varying vec4 vC; void main(){ gl_FragColor = vC; }');
      // the ground compass, drawn per pixel (any extent and zoom costs the same): rings every minor step
      // (9 minor between majors), spokes at the major angles, and the angle scale's rim with its ticks
      if (gl.getExtension('OES_standard_derivatives')) gridProg = program('attribute vec3 pos; uniform mat4 mvp; varying vec2 vXY; void main(){ vXY = pos.xy; gl_Position = mvp * vec4(pos, 1.0); }', [
        '#extension GL_OES_standard_derivatives : enable',
        'precision highp float; varying vec2 vXY; uniform vec2 C; uniform float minor; uniform float major; uniform float spoke; uniform float Ra; uniform float aMinor; uniform float kU; uniform float sub;',
        'float band(float d, float px, float wpx){ return 1.0 - smoothstep(max(wpx * 0.5 - 0.5, 0.0) * px, (wpx * 0.5 + 0.5) * px, abs(d)); }',
        'void main(){',
        '  vec2 q = vXY - C; float r = length(q); float px = max(length(vec2(dFdx(r), dFdy(r))), 1e-9);',
        '  float a = degrees(atan(q.y, q.x)); if (a < 0.0) a += 360.0;',
        '  float k = 0.0; vec3 col = vec3(0.78, 0.81, 0.85);',
        // ring spacings in tens of the shown unit, chosen per pixel: the finest fades out as it gets crowded and the
        // next one grows into a major line, so zooming changes the grid smoothly (and near / far parts differ)
        '  float e = log(max(px / kU, 1e-12) * 14.0) / log(10.0), n = floor(e), f = e - n;',
        '  float s1 = pow(10.0, n + 1.0) * kU, s0 = s1 / sub, s2 = s1 * 10.0;',      // (sub: minor rings per major: 10, or 2 at low quality)
        '  k = max(k, band(r - s0 * floor(r / s0 + 0.5), px, 0.7) * 0.16 * (1.0 - f));',
        '  k = max(k, band(r - s1 * floor(r / s1 + 0.5), px, mix(0.7, 1.1, f)) * mix(0.16, 0.42, f));',
        '  k = max(k, band(r - s2 * floor(r / s2 + 0.5), px, 1.1) * 0.42);',
        // spokes: the major angles beyond the first ring, the four quarters from the centre
        '  float ds = (a - spoke * floor(a / spoke + 0.5)) * 0.0174533 * r, dq = (a - 90.0 * floor(a / 90.0 + 0.5)) * 0.0174533 * r;',
        // a line's width in pixels: its distance divided by how fast that distance changes on screen
        // (across a spoke: the sideways change of position, worked out from q so the 0°/360° seam does not matter)
        '  vec2 qx = dFdx(q), qy = dFdy(q); float pt = max(length(vec2(q.x * qx.y - q.y * qx.x, q.x * qy.y - q.y * qy.x)) / max(r, 1e-9), 1e-9);',
        '  if (r > minor) k = max(k, band(ds, pt, 0.8) * 0.18);',
        '  k = max(k, band(dq, pt, 1.2) * 0.42);',
        // the rim, and ticks inside it: majors (every 10th) longest, every 5th middle, the rest short
        '  float rim = band(r - Ra, px, 1.2);',
        '  float i = floor(a / aMinor + 0.5), dt = (a - i * aMinor) * 0.0174533 * r;',
        '  float mj = abs(mod(i, sub)) < 0.5 ? 1.0 : 0.0, md = sub > 5.5 && abs(mod(i, 5.0)) < 0.5 ? 1.0 : 0.0;',
        '  float len = mix(mix(4.0, 6.0, md), 8.0, mj) * px, inTick = step(Ra - len, r) * step(r, Ra);',
        '  float tick = band(dt, pt, mix(0.8, 1.0, mj)) * inTick;',
        '  float quarter = abs(i * aMinor - 90.0 * floor(i * aMinor / 90.0 + 0.5)) < 1e-4 ? 1.0 : 0.0;',
        '  float t = max(rim * 0.8, tick * mix(mix(0.42, 0.8, mj), 0.95, quarter));',
        '  if (t > k) { k = t; col = mix(vec3(0.81, 0.83, 0.85), vec3(0.97, 0.98, 1.0), quarter * tick); }',
        '  if (k < 0.004) discard;',
        '  gl_FragColor = vec4(col, k);',
        '}'].join('\n'));
      gl.useProgram(aoProg); gl.uniform3fv(gl.getUniformLocation(aoProg, 'K'), new Float32Array(kernel));
      quadBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      triBuf = gl.createBuffer(); lineBuf = gl.createBuffer(); capBuf = gl.createBuffer();
    } else view3d.append(el('div', { style: 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#ddd' }, 'WebGL is not available for the 3D preview.'));

    // offscreen targets, sized to the canvas
    function targets(W2, H2) {
      if (fb && fb.w === W2 && fb.h === H2) return fb.ok ? fb : null;
      if (fb) { for (const t of fb.tex) gl.deleteTexture(t); for (const f of fb.fbs) gl.deleteFramebuffer(f); gl.deleteRenderbuffer(fb.ds); }
      const tex = () => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W2, H2, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; };
      const ds = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, ds); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_STENCIL, W2, H2);
      const gT = tex(), lT = tex(), aT = tex(), bT = tex();
      const mk = (t, withDepth) => { const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
        if (withDepth) gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, ds); return f; };
      const gF = mk(gT, true), lF = mk(lT, true), aF = mk(aT, false), bF = mk(bT, false);
      const ok = [gF, lF, aF, bF].every(f => { gl.bindFramebuffer(gl.FRAMEBUFFER, f); return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE; });
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      fb = { w: W2, h: H2, ok, ds, tex: [gT, lT, aT, bT], fbs: [gF, lF, aF, bF], gT, lT, aT, bT, gF, lF, aF, bF };
      return ok ? fb : null;
    }

    function setMesh(result) {
      if (!gl || !result || !result.preview || result === shown) return;
      shown = result;
      const firstMesh = !triCount;
      // the linked blue slicer, off the axis, stays where it is (it is kept as a share of the part's reach, which this
      // changes), so what was snapped onto it stays on it
      const off0 = bbox && state.linkSlicers ? sliceOff() : 0;
      const t = result.preview.tris, l = result.preview.lines;
      meshTris = t; meshShift = result.preview.shift || null; meshFlip = !!result.preview.flip; meshSolid = result.preview.solid || null; cutEdgeCache = null;
      gl.bindBuffer(gl.ARRAY_BUFFER, triBuf); gl.bufferData(gl.ARRAY_BUFFER, t, gl.STATIC_DRAW); triCount = t.length / 6;
      const lv = new Float32Array(l.length * 2);
      for (let i = 0, j = 0; i < l.length; i += 3) { lv[j++] = l[i]; lv[j++] = l[i + 1]; lv[j++] = l[i + 2]; lv[j++] = 0; lv[j++] = 0; lv[j++] = 1; }
      gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf); gl.bufferData(gl.ARRAY_BUFFER, lv, gl.STATIC_DRAW); lineCount = l.length / 3;
      const bad = result.preview.bad;
      if (!badBuf) badBuf = gl.createBuffer();
      badCount = bad && !(result.report && result.report.solid) ? bad.length / 3 : 0;
      if (badCount) { gl.bindBuffer(gl.ARRAY_BUFFER, badBuf); gl.bufferData(gl.ARRAY_BUFFER, bad, gl.STATIC_DRAW); }
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < t.length; i += 6) for (let c = 0; c < 3; c++) { if (t[i + c] < mn[c]) mn[c] = t[i + c]; if (t[i + c] > mx[c]) mx[c] = t[i + c]; }
      const nr = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 2 || 1;
      if (firstMesh || Math.abs(nr - radius) / nr > 0.25) { dist = nr * 2.2; pan = [0, 0, 0]; }
      center = [0, 1, 2].map(c => (mn[c] + mx[c]) / 2); radius = nr; bbox = { mn, mx };
      if (off0) {
        const f = cutFrame(), v = f && f.ext.z > 1e-9 ? (state.flip ? 1 : -1) * off0 * MM / f.ext.z : null;
        if (v != null && v > LO_END.z + 0.002 && v < 0.998) { state.cuts = { ...state.cuts, z: v }; drawSection(); }
      }
      draw3d();
    }
    // pixels per mm on the plane through the view's centre (the same for perspective and orthographic)
    function pxPerMm() { return canvas.clientHeight / Math.max(1e-9, 2 * dist * Math.tan(0.35)); }
    let projT = state.ortho ? 0 : 1, projAnim = 0;   // 1 = perspective, 0 = orthographic (animated in between)
    let camBasis = null, lastM = null, badBuf = null, badCount = 0, gizmoBuf = null, cutDrag = null;
    const cross3 = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
    const norm3 = (p) => { const l = Math.hypot(p[0], p[1], p[2]) || 1; return [p[0] / l, p[1] / l, p[2] / l]; };
    // The three cut axes through the middle of the part's base: X across (red), Y up (green), Z depth (blue).
    // Relative: X and Z turn with the view (Z points toward you); absolute: fixed to the part.
    const CUT_AXES = [['x', [1, 0.42, 0.42], [1, 0.72, 0.72]], ['y', [0.42, 0.85, 0.45], [0.7, 0.92, 0.72]], ['z', [0.45, 0.6, 1], [0.7, 0.78, 1]]];
    function cutFrame() {
      if (!bbox) return null;
      // the origin is the part's axis at its base (the same origin as the 2D views; the middle of a part that is the
      // same all round)
      const { mn, mx } = bbox, ax = meshShift ? -meshShift[0] * MM : (mn[0] + mx[0]) / 2, ay = meshShift ? -meshShift[1] * MM : (mn[1] + mx[1]) / 2, O = [ax, ay, mn[2]];
      const rel = state.cutMode !== 'absolute';
      const X = rel ? [-Math.sin(yaw), Math.cos(yaw), 0] : [1, 0, 0], Z = rel ? [Math.cos(yaw), Math.sin(yaw), 0] : [0, 1, 0], Y = [0, 0, 1];
      const half = Math.max(mx[0] - ax, ax - mn[0], mx[1] - ay, ay - mn[1]) * 1.15, H = (mx[2] - mn[2]) * CUT_H;
      return { O, dirs: { x: X, y: Y, z: Z }, ext: { x: half, y: H, z: half }, lo: { x: -1, y: -0.05, z: -1 } };
    }
    // the lower slice on axis k (its low end = none); the old height-only setting is read into it once
    if (state.cutLo > 0 && (!state.cutsLo || !(state.cutsLo.y > -0.05))) state.cutsLo = { ...(state.cutsLo || {}), y: state.cutLo / 1.12 };
    state.cutLo = 0;
    const LO_END = { x: -1, y: -0.05, z: -1 }, CUT_H = 1.12;     // (the height slicer reaches CUT_H × the part's height)
    // ---- linked slicers ----
    // The 3D height (green) slicer and the 2D height band are the same heights, each in its own measure: the 3D one
    // up from the shown base in units of its reach, the band as fractions of the scene's height.
    function bandFrom3d() {
      const gLo = loOf('y') <= LO_END.y + 0.001 ? 0 : Math.max(0, Math.min(1, loOf('y') * CUT_H)), gHi = hiOf('y') >= 0.999 ? 1 : Math.max(0, Math.min(1, hiOf('y') * CUT_H));
      let lo = state.flip ? 1 - gHi : gLo, hi = state.flip ? 1 - gLo : gHi;
      if (hi < lo + 0.005) { if (lo + 0.005 <= 1) hi = lo + 0.005; else lo = hi - 0.005; }
      state.topCut = { lo, hi };
    }
    function cutsFromBand() {
      const c = state.topCut || { lo: 0, hi: 1 }, gLo = state.flip ? 1 - c.hi : c.lo, gHi = state.flip ? 1 - c.lo : c.hi;
      state.cutsLo = { ...(state.cutsLo || {}), y: gLo <= 0.001 ? LO_END.y : gLo / CUT_H };
      state.cuts = { ...state.cuts, y: gHi >= 0.999 ? 1 : gHi / CUT_H };
    }
    // The cross-section is cut where the blue slicer is: its distance from the axis along the section's normal, in
    // scene units (0: through the axis, as when the slicers are not linked or the blue one cuts nothing).
    // the radius/height view shows the slice off the axis only (to look at) when Monomorphic is on
    function sliceView() { return monoOn() ? sliceOff() : 0; }
    function sliceOff() {
      if (!state.linkSlicers) return 0;
      const f = cutFrame(), v = hiOf('z');
      if (!f || v >= 0.999) return 0;
      const dd = (state.flip ? 1 : -1) * v * f.ext.z / MM;
      return Math.abs(dd) < 1e-9 ? 0 : dd;
    }
    const loOf = (k) => { const v = (state.cutsLo || {})[k]; return v == null || !isFinite(v) ? LO_END[k] : Math.max(LO_END[k], Math.min(1, v)); };
    const hiOf = (k) => { const v = (state.cuts || {})[k]; return v == null || !isFinite(v) ? 1 : v; };
    function cutPlanes() {
      const f = cutFrame(), cuts = state.cuts || {};
      const out = CUT_AXES.map(([k, axisCol, cap]) => {
        if (!f) return { on: false, n: [0, 0, 1], w: 0, cap, key: k };
        const n = f.dirs[k], v = cuts[k] == null ? 1 : cuts[k], s = v * f.ext[k];
        return { on: v < 0.999, n, w: n[0] * f.O[0] + n[1] * f.O[1] + n[2] * f.O[2] + s, cap, key: k, axisCol };
      });
      // the lower slices: everything before them along their axis is cut away
      for (const [k, axisCol, cap] of CUT_AXES) {
        const lo = loOf(k);
        if (!f || lo <= LO_END[k] + 0.001) { out.push({ on: false, n: [0, 0, 1], w: 0, cap, key: k + 'lo' }); continue; }
        const d = f.dirs[k], s = lo * f.ext[k];
        out.push({ on: true, n: [-d[0], -d[1], -d[2]], w: -(d[0] * f.O[0] + d[1] * f.O[1] + d[2] * f.O[2] + s), cap, key: k + 'lo', axisCol });
      }
      return out;
    }
    // ---- slicing sliders on the 3D view, one per axis (X along the bottom, Y and Z up the right side): the low handle
    //      cuts away what lies before it, the high one what lies beyond; drag between them to move both. They are the
    //      same cuts as the handles on the model. ----
    function setCut(k, lo, hi, which) {
      const L = LO_END[k];
      lo = Math.max(L, Math.min(1, lo)); hi = Math.max(L, Math.min(1, hi));
      if (hi < lo + 0.002) { if (which === 'lo') lo = Math.max(L, hi - 0.002); else hi = Math.min(1, lo + 0.002); }
      state.cutsLo = { ...(state.cutsLo || {}), [k]: lo <= L + 0.001 ? L : lo };
      state.cuts = { ...state.cuts, [k]: hi >= 0.999 ? 1 : hi };
      draw3d();
      if (state.linkSlicers && (k === 'y' || k === 'z')) { if (k === 'y') bandFrom3d(); drawSection(); }
    }
    const SLIDE_COL = { x: '#ff6b6b', y: '#51cf66', z: '#4dabf7' };
    const sliders = {};
    let sliceDrag = null;
    function makeSlider(k, horiz, place, labRight) {
      const col = SLIDE_COL[k], L = LO_END[k];
      const track = el('div', { style: 'position:absolute;border-radius:2px;background:rgba(255,255,255,.18);' + (horiz ? 'top:50%;left:0;right:0;height:4px;margin-top:-2px' : 'left:50%;top:0;bottom:0;width:4px;margin-left:-2px') });
      const range = el('div', { style: 'position:absolute;border-radius:2px;cursor:grab;background:' + col + ';' + (horiz ? 'top:50%;height:4px;margin-top:-2px' : 'left:50%;width:4px;margin-left:-2px') });
      const knob = (which) => el('div', { style: 'position:absolute;border-radius:3px;border:1.5px solid #fff;box-sizing:border-box;box-shadow:0 1px 3px rgba(0,0,0,.5);background:' + col + ';' +
        (horiz ? 'top:50%;width:10px;height:16px;margin:-8px 0 0 -5px;cursor:ew-resize' : 'left:50%;width:16px;height:10px;margin:-5px 0 0 -8px;cursor:ns-resize'),
        title: (which === 'hi' ? 'Slice away beyond this on the ' : 'Slice away before this on the ') + k.toUpperCase() + ' axis (double-click to clear)' });
      const hiK = knob('hi'), loK = knob('lo');
      // the origin (the middle of the base; the base itself on Y)
      const tick = el('div', { style: 'position:absolute;pointer-events:none;background:rgba(255,255,255,.75);' + (horiz ? 'top:50%;width:2px;height:14px;margin:-7px 0 0 -1px' : 'left:50%;height:2px;width:14px;margin:-1px 0 0 -7px') });
      const lab = () => el('div', { style: 'position:absolute;font-size:10px;color:#ddd;white-space:nowrap;pointer-events:none;text-shadow:0 0 3px #000;' + (horiz ? 'top:-13px;transform:translateX(-50%)' : 'right:' + (labRight || 20) + 'px;margin-top:-7px') });
      const hiL = lab(), loL = lab();
      const box = el('div', { style: 'position:absolute;touch-action:none;z-index:2;' + place, title: 'Slice the part along ' + k.toUpperCase() }, track, range, tick, hiL, loL, hiK, loK);
      const tOf = (v) => (v - L) / (1 - L), vOf = (t) => L + t * (1 - L);
      const at = (e) => { const r = box.getBoundingClientRect(); return horiz ? (e.clientX - r.left) / Math.max(1, r.width) : 1 - (e.clientY - r.top) / Math.max(1, r.height); };
      const pos = (t) => horiz ? { left: t * 100 + '%' } : { top: (1 - t) * 100 + '%' };
      const sync = () => {
        const f = cutFrame(), lo = tOf(loOf(k)), hi = tOf(hiOf(k));
        const down = k === 'y' && state.heightFrom === 'top';      // heights counted from the top down
        Object.assign(tick.style, pos(tOf(down ? 1 : 0)));
        Object.assign(hiK.style, pos(hi)); Object.assign(loK.style, pos(lo)); Object.assign(hiL.style, pos(hi)); Object.assign(loL.style, pos(lo));
        if (horiz) { range.style.left = lo * 100 + '%'; range.style.width = (hi - lo) * 100 + '%'; }
        else { range.style.top = (1 - hi) * 100 + '%'; range.style.height = (hi - lo) * 100 + '%'; }
        // the mesh is in mm: distance from the middle of the base (the height above it, for Y), in the display unit
        const txt = (v) => f ? num(mm((down ? 1 - v : v) * f.ext[k] / MM), 2) + ' ' + UNIT_LABEL : '';
        hiL.textContent = hiOf(k) < 0.999 ? txt(hiOf(k)) : '';
        loL.textContent = loOf(k) > L + 0.001 ? txt(loOf(k)) : '';
        box.style.display = bbox ? '' : 'none';
      };
      // a handle near the origin's tick goes onto it (Alt: freely), as the handles on the model do
      const snapT = (e, t) => { if (e.altKey) return t; const r = box.getBoundingClientRect(), t0 = tOf(0); return Math.abs(t - t0) * (horiz ? r.width : r.height) < 7 ? t0 : t; };
      for (const [el0, which] of [[hiK, 'hi'], [loK, 'lo'], [range, 'both']]) {
        el0.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault(); e.stopPropagation(); el0.setPointerCapture(e.pointerId);
          sliceDrag = { k, which, t0: at(e), lo: tOf(loOf(k)), hi: tOf(hiOf(k)) };
        });
        el0.addEventListener('pointermove', (e) => {
          if (!sliceDrag || sliceDrag.k !== k) return;
          const t = Math.max(0, Math.min(1, at(e))), g = sliceDrag;
          if (g.which === 'hi') setCut(k, vOf(g.lo), vOf(snapT(e, t)), 'hi');
          else if (g.which === 'lo') setCut(k, vOf(snapT(e, t)), vOf(g.hi), 'lo');
          else { const dt = Math.max(-g.lo, Math.min(1 - g.hi, t - g.t0)); setCut(k, vOf(g.lo + dt), vOf(g.hi + dt), 'both'); }
        });
        const end = () => { if (sliceDrag) { sliceDrag = null; saveSettings(); draw3d(); } };
        el0.addEventListener('pointerup', end); el0.addEventListener('pointercancel', end);
        el0.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          if (which === 'hi') setCut(k, loOf(k), 1, 'hi'); else if (which === 'lo') setCut(k, L, hiOf(k), 'lo'); else setCut(k, L, 1, 'both');
          saveSettings();
        });
      }
      // a click on the track moves the nearer handle there
      box.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || (e.target !== box && e.target !== track)) return;
        e.preventDefault(); e.stopPropagation();
        const t = at(e), lo = tOf(loOf(k)), hi = tOf(hiOf(k));
        if (Math.abs(t - lo) < Math.abs(t - hi)) setCut(k, vOf(snapT(e, t)), hiOf(k), 'lo'); else setCut(k, loOf(k), vOf(snapT(e, t)), 'hi');
        saveSettings();
      });
      sliders[k] = { box, sync };
      view3d.append(box);
    }
    makeSlider('y', false, 'right:10px;top:44px;bottom:44px;width:20px', 44);
    makeSlider('z', false, 'right:34px;top:44px;bottom:44px;width:20px');
    makeSlider('x', true, 'left:150px;right:64px;bottom:10px;height:20px');
    const syncSlice = () => { for (const s of Object.values(sliders)) s.sync(); };
    // where each cut handle is drawn: at its place on its axis, or moved aside in the view when handles would cover each other
    const HANDLE_KEYS = ['x', 'y', 'z', 'xlo', 'ylo', 'zlo'];
    function handleSpots() {
      const out = {}, scr = {};
      for (const k of HANDLE_KEYS) { out[k] = handlePos(k); scr[k] = toScreen3(out[k]); }
      if (!camBasis || !radius) return out;
      const keys = HANDLE_KEYS.filter(k => scr[k]), done = new Set();
      for (const k of keys) {
        if (done.has(k)) continue;
        const group = keys.filter(j => !done.has(j) && Math.hypot(scr[j][0] - scr[k][0], scr[j][1] - scr[k][1]) < 18);
        group.forEach(j => done.add(j));
        if (group.length < 2) continue;
        const p = out[k], q = toScreen3([p[0] + camBasis.x[0] * radius, p[1] + camBasis.x[1] * radius, p[2] + camBasis.x[2] * radius]);
        const pxPer = q ? Math.hypot(q[0] - scr[k][0], q[1] - scr[k][1]) / radius : 0;
        if (!(pxPer > 0)) continue;
        // the handle being dragged stays under the pointer; the others step aside
        const still = cutDrag && group.includes(cutDrag.k) ? cutDrag.k : null, movers = group.filter(j => j !== still);
        movers.forEach((j, m) => {
          const ang = (still ? Math.PI / 4 + Math.PI / 2 * m : Math.PI / 4 + 2 * Math.PI * m / movers.length), d = 22 / pxPer;
          const ox = Math.cos(ang) * d, oy = Math.sin(ang) * d, b = out[j];
          out[j] = [b[0] + camBasis.x[0] * ox + camBasis.y[0] * oy, b[1] + camBasis.x[1] * ox + camBasis.y[1] * oy, b[2] + camBasis.x[2] * ox + camBasis.y[2] * oy];
          out[j].moved = b;
        });
      }
      return out;
    }
    function handlePos(key) {
      const k = key[0], f = cutFrame(), v = key.length > 1 ? loOf(k) : hiOf(k), d = f.dirs[k], s = v * f.ext[k];
      return [f.O[0] + d[0] * s, f.O[1] + d[1] * s, f.O[2] + d[2] * s];
    }
    function toScreen3(p) {
      if (!lastM) return null;
      const M = lastM, x = M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12], y = M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13], w = M[3] * p[0] + M[7] * p[1] + M[11] * p[2] + M[15];
      if (w <= 1e-9) return null;
      return [(x / w + 1) / 2 * canvas.clientWidth, (1 - y / w) / 2 * canvas.clientHeight];
    }
    // the axes (just past the part), the active planes (faintly) and the slider handles
    function drawGizmo() {
      const f = cutFrame(); if (!f || !camBasis || !state.cutHandles) return;
      const v = [], vx = camBasis.z;
      const tri = (a, b, c, col) => { for (const p of [a, b, c]) v.push(p[0], p[1], p[2], col[0], col[1], col[2], col[3]); };
      const seg = (p, q, w, col) => {
        const d = norm3([q[0] - p[0], q[1] - p[1], q[2] - p[2]]), s = norm3(cross3(d, vx)).map(c => c * w / 2);
        const a = [p[0] + s[0], p[1] + s[1], p[2] + s[2]], b = [p[0] - s[0], p[1] - s[1], p[2] - s[2]], c = [q[0] - s[0], q[1] - s[1], q[2] - s[2]], e = [q[0] + s[0], q[1] + s[1], q[2] + s[2]];
        tri(a, b, c, col); tri(a, c, e, col);
      };
      const disc = (p, r, col) => {
        const { x, y } = camBasis;
        for (let i = 0; i < 20; i++) { const t0 = i / 20 * 2 * Math.PI, t1 = (i + 1) / 20 * 2 * Math.PI;
          tri(p, [p[0] + (x[0] * Math.cos(t0) + y[0] * Math.sin(t0)) * r, p[1] + (x[1] * Math.cos(t0) + y[1] * Math.sin(t0)) * r, p[2] + (x[2] * Math.cos(t0) + y[2] * Math.sin(t0)) * r],
            [p[0] + (x[0] * Math.cos(t1) + y[0] * Math.sin(t1)) * r, p[1] + (x[1] * Math.cos(t1) + y[1] * Math.sin(t1)) * r, p[2] + (x[2] * Math.cos(t1) + y[2] * Math.sin(t1)) * r], col); }
      };
      const G = Math.min(radius, 250 / Math.max(1e-9, pxPerMm()));     // handles and axes keep a sensible size on screen when zoomed in
      const W = G * 0.007;
      const lines = [], handles = [], sheets = [], spots = handleSpots();
      CUT_AXES.forEach(([k, col], i) => {
        const d = f.dirs[k], lo = f.lo[k] * f.ext[k], hi = f.ext[k];
        lines.push([[f.O[0] + d[0] * lo, f.O[1] + d[1] * lo, f.O[2] + d[2] * lo], [f.O[0] + d[0] * hi, f.O[1] + d[1] * hi, f.O[2] + d[2] * hi], col]);
        handles.push([spots[k], col, cutDrag && cutDrag.k === k]);
        handles.push([spots[k + 'lo'], col, cutDrag && cutDrag.k === k + 'lo', true]);
      });
      // faint planes (depth-tested), axes (depth-tested, plus a faint see-through copy), handles on top
      for (const [a, b, c, e, col] of sheets) { const cc = [col[0], col[1], col[2], 0.08]; tri(a, b, c, cc); tri(a, c, e, cc); }
      const nSheet = v.length / 7;
      for (const [p, q, col] of lines) seg(p, q, W, [col[0], col[1], col[2], 0.95]);
      const nLines = v.length / 7;
      for (const [p, q, col] of lines) seg(p, q, W, [col[0], col[1], col[2], 0.25]);
      const nGhost = v.length / 7;
      for (const [p, col] of handles) if (p.moved) seg(p.moved, p, W * 0.6, [col[0], col[1], col[2], 0.9]);
      for (const [p, col, hot, low] of handles) {
        // a snapped handle gets a white ring; the lower slice's handle has a dark middle
        disc(p, G * (hot ? 0.05 : 0.04), hot && cutDrag.snapped ? [1, 1, 1, 0.95] : [0.1, 0.11, 0.13, 0.9]);
        disc(p, G * (hot ? 0.042 : 0.032), [col[0], col[1], col[2], 1]);
        if (low) disc(p, G * 0.014, [0.1, 0.11, 0.13, 1]);
      }
      const nAll = v.length / 7;
      if (!gizmoBuf) gizmoBuf = gl.createBuffer();
      gl.useProgram(texProg);
      gl.uniformMatrix4fv(gl.getUniformLocation(texProg, 'mvp'), false, new Float32Array(lastM));
      gl.bindBuffer(gl.ARRAY_BUFFER, gizmoBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.DYNAMIC_DRAW);
      const aP = gl.getAttribLocation(texProg, 'pos'), aC = gl.getAttribLocation(texProg, 'col');
      gl.enableVertexAttribArray(aP); gl.enableVertexAttribArray(aC);
      gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 28, 0); gl.vertexAttribPointer(aC, 4, gl.FLOAT, false, 28, 12);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
      gl.enable(gl.DEPTH_TEST);
      gl.drawArrays(gl.TRIANGLES, 0, nLines);
      gl.disable(gl.DEPTH_TEST);
      gl.drawArrays(gl.TRIANGLES, nLines, nAll - nLines);
      gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND);
      gl.disableVertexAttribArray(aC);
      void nSheet; void nGhost;
    }
    // edges that keep the part from being solid, drawn on top in magenta
    // The outline where each active cut plane meets the part, as a bright line in that plane's colour
    // (cut back by the other planes). The crossings are found once per mesh and plane position.
    let meshTris = null, meshShift = null, meshFlip = false, meshSolid = null, cutEdgeCache = null, cutEdgeBuf = null;
    const EDGE_COL = { x: [1, 0.28, 0.28, 1], y: [0.3, 1, 0.38, 1], z: [0.32, 0.62, 1, 1] };
    for (const k of ['x', 'y', 'z']) EDGE_COL[k + 'lo'] = EDGE_COL[k];
    function cutSegments(planes) {
      const key = planes.map(p => p.on ? p.n.join(',') + ':' + p.w : '-').join('|');
      if (cutEdgeCache && cutEdgeCache.key === key && cutEdgeCache.mesh === meshTris) return cutEdgeCache.segs;
      const t = meshTris, segs = [];
      planes.forEach((p, i) => {
        if (!p.on || !t) return;
        const [nx, ny, nz] = p.n, w = p.w, others = planes.filter((q, j) => j !== i && q.on);
        const dOf = (o) => nx * t[o] + ny * t[o + 1] + nz * t[o + 2] - w;
        const out = [];
        for (let o = 0; o + 17 < t.length; o += 18) {
          const d = [dOf(o), dOf(o + 6), dOf(o + 12)];
          if ((d[0] > 0 && d[1] > 0 && d[2] > 0) || (d[0] < 0 && d[1] < 0 && d[2] < 0)) continue;
          const pts = [];
          for (let e = 0; e < 3; e++) {
            const a = e, b = (e + 1) % 3, da = d[a], db = d[b];
            if ((da < 0) !== (db < 0) && da !== db) {
              const k = da / (da - db), A = o + a * 6, B = o + b * 6;
              pts.push([t[A] + (t[B] - t[A]) * k, t[A + 1] + (t[B + 1] - t[A + 1]) * k, t[A + 2] + (t[B + 2] - t[A + 2]) * k]);
            }
          }
          if (pts.length < 2) continue;
          // keep only the part of the segment the other planes leave
          let [P, Q] = pts, ok = true;
          for (const q of others) {
            const dp = q.n[0] * P[0] + q.n[1] * P[1] + q.n[2] * P[2] - q.w, dq = q.n[0] * Q[0] + q.n[1] * Q[1] + q.n[2] * Q[2] - q.w;
            if (dp > 0 && dq > 0) { ok = false; break; }
            if (dp > 0 || dq > 0) { const k = dp / (dp - dq), X = [P[0] + (Q[0] - P[0]) * k, P[1] + (Q[1] - P[1]) * k, P[2] + (Q[2] - P[2]) * k]; if (dp > 0) P = X; else Q = X; }
          }
          if (ok) out.push(P, Q);
        }
        segs.push({ col: EDGE_COL[p.key] || [1, 1, 1, 1], pts: out });
      });
      // where two cut faces meet inside the part: their line, in the two planes' colours added together; where three
      // meet, a point in all three added
      const act = planes.filter(p => p.on);
      const addCol = (...ps) => { const c = [0, 0, 0, 1]; for (const p of ps) { const e = EDGE_COL[p.key] || [1, 1, 1]; for (let i = 0; i < 3; i++) c[i] = Math.min(1, c[i] + e[i]); } return c; };
      const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      const lineIn = (P0, u, skip) => {
        // where the line crosses the part's surface (inside between odd and even crossings), then cut by the other planes
        const ts = [];
        for (let o = 0; o + 17 < t.length; o += 18) {
          const A = [t[o], t[o + 1], t[o + 2]], e1 = [t[o + 6] - A[0], t[o + 7] - A[1], t[o + 8] - A[2]], e2 = [t[o + 12] - A[0], t[o + 13] - A[1], t[o + 14] - A[2]];
          const h = cross3(u, e2), a = dot3(e1, h);
          if (Math.abs(a) < 1e-12) continue;
          const s = [P0[0] - A[0], P0[1] - A[1], P0[2] - A[2]], f = 1 / a, bu = f * dot3(s, h);
          if (bu < 0 || bu > 1) continue;
          const q = cross3(s, e1), bv = f * dot3(u, q);
          if (bv < 0 || bu + bv > 1) continue;
          ts.push(f * dot3(e2, q));
        }
        ts.sort((x, y) => x - y);
        const out = [];
        for (let i = 0; i + 1 < ts.length; i += 2) {
          let a = ts[i], b = ts[i + 1];
          for (const q of act) {
            if (skip.includes(q)) continue;
            const c0 = dot3(q.n, P0) - q.w, c1 = dot3(q.n, u);          // kept where c0 + c1 t <= 0
            if (Math.abs(c1) < 1e-12) { if (c0 > 0) { a = 1; b = 0; } continue; }
            const tq = -c0 / c1;
            if (c1 > 0) b = Math.min(b, tq); else a = Math.max(a, tq);
          }
          if (b > a) out.push([a, b]);
        }
        return out;
      };
      if (t && act.length >= 2) for (let i = 0; i < act.length; i++) for (let j = i + 1; j < act.length; j++) {
        const A = act[i], B = act[j], u0 = cross3(A.n, B.n), L = Math.hypot(u0[0], u0[1], u0[2]);
        if (L < 1e-6) continue;
        const u = [u0[0] / L, u0[1] / L, u0[2] / L], nn = dot3(A.n, B.n), den = 1 - nn * nn;
        const ca = (A.w - B.w * nn) / den, cb = (B.w - A.w * nn) / den, P0 = [A.n[0] * ca + B.n[0] * cb, A.n[1] * ca + B.n[1] * cb, A.n[2] * ca + B.n[2] * cb];
        const pts = [];
        for (const [a, b] of lineIn(P0, u, [A, B])) pts.push([P0[0] + u[0] * a, P0[1] + u[1] * a, P0[2] + u[2] * a], [P0[0] + u[0] * b, P0[1] + u[1] * b, P0[2] + u[2] * b]);
        if (pts.length) segs.push({ col: addCol(A, B), pts, wide: 1.4 });
        // three planes: the point, if it is inside the part and left by the others
        for (let k = j + 1; k < act.length; k++) {
          const C = act[k], dn = dot3(C.n, u);
          if (Math.abs(dn) < 1e-6) continue;
          const tc = (C.w - dot3(C.n, P0)) / dn;
          if (lineIn(P0, u, [A, B, C]).some(([a, b]) => tc >= a - 1e-9 && tc <= b + 1e-9)) segs.push({ col: addCol(A, B, C), dot: [P0[0] + u[0] * tc, P0[1] + u[1] * tc, P0[2] + u[2] * tc] });
        }
      }
      cutEdgeCache = { key, mesh: meshTris, segs };
      return segs;
    }
    function drawCutEdges() {
      const planes = cutPlanes();
      if (!meshTris || !camBasis || !planes.some(p => p.on)) return;
      const segs = cutSegments(planes), px = Math.max(1e-9, pxPerMm()), hw = 1.2 / px, lift = 0.6 / px, z = camBasis.z, v = [];
      for (const { col, pts, dot, wide } of segs) {
        if (dot) {
          // a point: a small square facing the viewer, raised a little so it sits on the faces
          const r = 3.2 / px, x = camBasis.x, y = camBasis.y, c = [dot[0] + z[0] * lift * 2, dot[1] + z[1] * lift * 2, dot[2] + z[2] * lift * 2];
          const at = (a, b) => [c[0] + (x[0] * a + y[0] * b) * r, c[1] + (x[1] * a + y[1] * b) * r, c[2] + (x[2] * a + y[2] * b) * r];
          for (const p of [at(-1, -1), at(1, -1), at(1, 1), at(-1, -1), at(1, 1), at(-1, 1)]) v.push(p[0], p[1], p[2], col[0], col[1], col[2], col[3]);
          continue;
        }
        for (let i = 0; i + 1 < pts.length; i += 2) {
        const P = pts[i], Q = pts[i + 1], d = [Q[0] - P[0], Q[1] - P[1], Q[2] - P[2]];
        let s = [d[1] * z[2] - d[2] * z[1], d[2] * z[0] - d[0] * z[2], d[0] * z[1] - d[1] * z[0]];
        const L = Math.hypot(s[0], s[1], s[2]); if (L < 1e-12) continue;
        s = [s[0] / L * hw * (wide || 1), s[1] / L * hw * (wide || 1), s[2] / L * hw * (wide || 1)];
        const at = (p, k) => [p[0] + s[0] * k + z[0] * lift, p[1] + s[1] * k + z[1] * lift, p[2] + s[2] * k + z[2] * lift];
        for (const p of [at(P, -1), at(P, 1), at(Q, 1), at(P, -1), at(Q, 1), at(Q, -1)]) v.push(p[0], p[1], p[2], col[0], col[1], col[2], col[3]);
        }
      }
      if (!v.length) return;
      if (!cutEdgeBuf) cutEdgeBuf = gl.createBuffer();
      gl.useProgram(texProg);
      gl.uniformMatrix4fv(gl.getUniformLocation(texProg, 'mvp'), false, new Float32Array(lastM));
      gl.bindBuffer(gl.ARRAY_BUFFER, cutEdgeBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.DYNAMIC_DRAW);
      const aP = gl.getAttribLocation(texProg, 'pos'), aC = gl.getAttribLocation(texProg, 'col');
      gl.enableVertexAttribArray(aP); gl.enableVertexAttribArray(aC);
      gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 28, 0); gl.vertexAttribPointer(aC, 4, gl.FLOAT, false, 28, 12);
      gl.depthFunc(gl.LEQUAL); gl.depthMask(false);
      gl.drawArrays(gl.TRIANGLES, 0, v.length / 7);
      gl.depthMask(true); gl.depthFunc(gl.LESS);
      gl.disableVertexAttribArray(aC);
    }
    // The scales' numbers, upright and facing the viewer: distances at the major steps along the ground axis that
    // runs most nearly left–right on screen (with 9 minor ticks between), and the angles round the compass rim.
    // Both run on as far as the view reaches; only what is on screen is drawn.
    let axisLblBuf = null;
    function drawAxisLabels() {
      const f = cutFrame();
      if (!f || !camBasis || !lastM) return;
      const S = compassSpec(), px = Math.max(1e-9, S.px), up0 = camBasis.y;
      // the distances run along the grid spoke (a line through the centre) that is most nearly level on screen
      // among those that cross the view, so they stay readable and in sight
      const W0 = canvas.clientWidth, H0 = canvas.clientHeight, gz0 = bbox.mn[2], step = Math.max(S.aMajor, 10), reach0 = Math.min(S.Rv, S.half * 6 + Math.hypot(S.cx - (S.G ? S.G[0] : S.cx), S.cy - (S.G ? S.G[1] : S.cy)));
      let best = null;
      for (let deg = 0; deg < 180 - 1e-9; deg += step) {
        const t = deg * Math.PI / 180, d = [Math.cos(t), Math.sin(t), 0];
        let vis = 0, first = null, last = null, prev = null;
        for (let i = 0; i <= 120; i++) {
          const s = -reach0 + 2 * reach0 * i / 120, p = toScreen3([S.cx + d[0] * s, S.cy + d[1] * s, gz0]);
          const on = p && p[0] >= 0 && p[1] >= 0 && p[0] <= W0 && p[1] <= H0;
          if (on) { if (prev) vis += Math.hypot(p[0] - prev[0], p[1] - prev[1]); if (!first) first = p; last = p; prev = p; } else prev = null;
        }
        if (!first || first === last) continue;
        const dx = last[0] - first[0], dy = last[1] - first[1], hz = Math.abs(dx) / (Math.hypot(dx, dy) || 1);
        const score = hz * Math.min(1, vis / (0.3 * W0));
        if (!best || score > best.score) best = { score, d: dx < 0 ? d.map(c => -c) : d };
      }
      const rt = best ? best.d : f.dirs.x;
      // every number faces the screen: read along the camera's right, upright along its up
      const square = (r) => { const k = up0[0] * r[0] + up0[1] * r[1] + up0[2] * r[2]; const q = [up0[0] - r[0] * k, up0[1] - r[1] * k, up0[2] - r[2] * k], l = Math.hypot(...q) || 1; return q.map(c => c / l); };
      const right = camBasis.x, upA = square(right);
      const gz = bbox.mn[2], { cx, cy } = S, O = [cx, cy, gz];
      const lw = (p) => p / px, hgt = lw(9), sw = lw(1.1), W = canvas.clientWidth, H = canvas.clientHeight;
      const v = [], COL = [0.88, 0.9, 0.93, 0.95], DIM = [0.8, 0.83, 0.86, 0.55];
      const onScreen = (p, m) => { const s = toScreen3(p); return s && s[0] > -m && s[1] > -m && s[0] < W + m && s[1] < H + m; };
      const quad = (a, b, w, col) => {      // a line of width w, facing the viewer
        const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], z = camBasis.z;
        let s = [d[1] * z[2] - d[2] * z[1], d[2] * z[0] - d[0] * z[2], d[0] * z[1] - d[1] * z[0]]; const L = Math.hypot(...s); if (L < 1e-12) return;
        s = s.map(c => c / L * w / 2);
        for (const p of [[a, -1], [a, 1], [b, 1], [a, -1], [b, 1], [b, -1]]) v.push(p[0][0] + s[0] * p[1], p[0][1] + s[1] * p[1], p[0][2] + s[2] * p[1], ...col);
      };
      const adv = (ch) => (ch === '.' ? 0.12 : ch === '1' ? 0.42 : ch === '-' ? 0.45 : ch === '°' ? 0.25 : 0.55) + 0.18;
      const widthOf = (txt) => [...txt].reduce((s, ch) => s + adv(ch), -0.18) * hgt;
      const text = (txt, base, rgt, upv, col) => {
        const at = (x, y) => [base[0] + rgt[0] * x + upv[0] * y, base[1] + rgt[1] * x + upv[1] * y, base[2] + rgt[2] * x + upv[2] * y];
        let pen = -widthOf(txt) / 2;
        for (const ch of txt) {
          const g = ch === '-' ? [[[0.05, 0.5], [0.4, 0.5]]] : FONT[ch] || [];
          for (const line of g) for (let i = 0; i + 1 < line.length; i++) quad(at(pen + line[i][0] * hgt, line[i][1] * hgt), at(pen + line[i + 1][0] * hgt, line[i + 1][1] * hgt), sw, col);
          pen += adv(ch) * hgt;
        }
      };
      const num = (x) => String(+x.toFixed(6));
      // distances: along the axis both ways, as far as the grid reaches
      // along the axis: only the stretch the view can show (round the ground point under the view)
      const gnd = [-rt[1], rt[0], 0], { minor } = S, G = S.G || [cx, cy], mid = (G[0] - cx) * rt[0] + (G[1] - cy) * rt[1], reach = S.half * 3;
      const k0 = Math.ceil((mid - reach) / minor), k1 = Math.min(Math.floor((mid + reach) / minor), k0 + 600);
      for (let k = k0; k <= k1; k++) {
        if (!k) continue;
        const s = k * minor, mj = k % S.sub === 0, p = [O[0] + rt[0] * s, O[1] + rt[1] * s, gz];
        if (!onScreen(p, 20)) continue;
        // far along a low view the steps crowd together: drop the minor ticks (then the numbers) where they would merge
        const sp = toScreen3(p), sq = toScreen3([p[0] + rt[0] * minor, p[1] + rt[1] * minor, gz]), gap = sp && sq ? Math.hypot(sq[0] - sp[0], sq[1] - sp[1]) : 0;
        if (!mj && gap < 8) continue;
        if (mj && gap * 10 < 28) continue;
        const L = lw(mj ? 4 : 2);
        quad([p[0] - gnd[0] * L, p[1] - gnd[1] * L, gz], [p[0] + gnd[0] * L, p[1] + gnd[1] * L, gz], lw(mj ? 1.2 : 0.8), mj ? COL : DIM);
        if (mj) {
          // beside its tick: square to the axis as it runs on the screen, on the upper side (to the right of an axis
          // running straight up), clear of the tick whichever way the axis lies
          const txt = num(+(Math.abs(s) * UNIT_SCALE / MM).toFixed(6)), ax = (sq[0] - sp[0]) / gap, ay = -(sq[1] - sp[1]) / gap;
          let nx = -ay, ny = ax;
          if (ny < -1e-6 || (Math.abs(ny) <= 1e-6 && nx < 0)) { nx = -nx; ny = -ny; }
          const off = lw(7) + Math.abs(nx) * widthOf(txt) / 2 + Math.abs(ny) * hgt / 2, ox = nx * off, oy = ny * off - hgt / 2;
          text(txt, [p[0] + right[0] * ox + upA[0] * oy, p[1] + right[1] * ox + upA[1] * oy, p[2] + right[2] * ox + upA[2] * oy], right, upA, COL);
        }
      }
      // angles round the rim, each upright and read left to right on screen
      // round the rim: only the angles near the part of it in view
      const n = Math.round(360 / S.aMajor);
      const aG = S.G ? Math.atan2(S.G[1] - cy, S.G[0] - cx) : 0, span = Math.min(Math.PI, S.half * 3 / Math.max(S.Ra, 1e-9));
      const i0 = span >= Math.PI ? 0 : Math.floor((aG - span) * 180 / Math.PI / S.aMajor), i1 = span >= Math.PI ? n - 1 : Math.ceil((aG + span) * 180 / Math.PI / S.aMajor);
      for (let ii = i0; ii <= Math.min(i1, i0 + 720); ii++) {
        const i = ((ii % n) + n) % n;
        const d = i * S.aMajor, t = d * Math.PI / 180, rr = S.Ra - lw(11) - hgt * 0.6;
        const p = [cx + Math.cos(t) * rr, cy + Math.sin(t) * rr, gz];
        if (!onScreen(p, 20)) continue;
        const dv = state.flip ? (360 - d) % 360 : d;
        text(ANG_SCALE === 1 ? num(dv) + '°' : num(+(dv * ANG_SCALE).toFixed(3)), [p[0] - upA[0] * hgt * 0.5, p[1] - upA[1] * hgt * 0.5, p[2] - upA[2] * hgt * 0.5], right, upA, Math.abs(d % 90) < 1e-9 ? [0.97, 0.98, 1, 0.95] : COL);
      }
      if (!v.length) return;
      if (!axisLblBuf) axisLblBuf = gl.createBuffer();
      gl.useProgram(texProg);
      gl.uniformMatrix4fv(gl.getUniformLocation(texProg, 'mvp'), false, new Float32Array(lastM));
      gl.bindBuffer(gl.ARRAY_BUFFER, axisLblBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.DYNAMIC_DRAW);
      const aP = gl.getAttribLocation(texProg, 'pos'), aC = gl.getAttribLocation(texProg, 'col');
      gl.enableVertexAttribArray(aP); gl.enableVertexAttribArray(aC);
      gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 28, 0); gl.vertexAttribPointer(aC, 4, gl.FLOAT, false, 28, 12);
      gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES, 0, v.length / 7);
      gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST);
      gl.disableVertexAttribArray(aC);
    }
    // The compass on the ground plane, built from shapes (rings, ticks, stroke-font numbers, needle)
    // so it stays sharp at any zoom.
    // a thin stroke font for the compass numbers (x 0…0.55, y 0…1)
    const ell = (cx, cy, rx, ry, a0 = 0, a1 = 2 * Math.PI, n = 20) => Array.from({ length: n + 1 }, (_, k) => { const t = a0 + (a1 - a0) * k / n; return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)]; });
    const FONT = {
      '0': [ell(0.275, 0.5, 0.265, 0.5)],
      '1': [[[0.1, 0.78], [0.3, 1], [0.3, 0]]],
      '2': [[...ell(0.27, 0.73, 0.26, 0.27, Math.PI * 0.95, -Math.PI * 0.18, 12), [0, 0], [0.55, 0]]],
      '3': [ell(0.26, 0.76, 0.24, 0.24, Math.PI * 0.85, -Math.PI / 2, 12), ell(0.26, 0.26, 0.27, 0.26, Math.PI / 2, -Math.PI * 0.85, 12)],
      '4': [[[0.42, 0], [0.42, 1], [0, 0.3], [0.55, 0.3]]],
      '5': [[[0.5, 1], [0.08, 1], [0.04, 0.55], ...ell(0.26, 0.31, 0.28, 0.31, Math.PI * 0.72, -Math.PI * 0.85, 14)]],
      '6': [[...ell(0.28, 0.55, 0.27, 0.45, Math.PI * 0.28, Math.PI, 8).slice(0, -1), ...ell(0.275, 0.28, 0.265, 0.28, Math.PI, 3 * Math.PI, 16)]],
      '7': [[[0, 1], [0.55, 1], [0.18, 0]]],
      '8': [ell(0.275, 0.76, 0.22, 0.24), ell(0.275, 0.26, 0.265, 0.26)],
      '9': [[...ell(0.27, 0.45, 0.27, 0.45, -Math.PI * 0.72, 0, 8).slice(0, -1), ...ell(0.275, 0.72, 0.265, 0.28, 0, 2 * Math.PI, 16)]],
      '°': [ell(0.12, 0.86, 0.1, 0.12, 0, 2 * Math.PI, 10)], '.': [[[0.06, 0], [0.06, 0.07]]],
    };
    const niceStep = (x) => { const e = Math.pow(10, Math.floor(Math.log10(x))), m = x / e; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * e; };
    // The ground compass: a radial grid under the part that reaches as far as the view does (rings and spokes),
    // with an angle scale round a rim. Spacing follows the zoom in base 10: 9 minor steps between majors.
    // The angle scale sits round the part when the part fits the view; zoomed in, it moves to a round radius
    // that passes through the middle of the view, so its ticks and numbers stay on screen.
    const ANGLE_MAJORS = [90, 30, 10, 1, 0.1, 0.01];
    let lastCam = null;
    // where a point on the screen (-1…1 both ways) meets the ground plane z = gz
    function groundAt(nx, ny, gz) {
      const c = lastCam; if (!c) return null;
      const d = [0, 1, 2].map(i => -c.z[i] + nx * c.tanH * c.a * c.x[i] + ny * c.tanH * c.y[i]);
      if (Math.abs(d[2]) < 1e-12) return null;
      const t = (gz - c.eye[2]) / d[2];
      return t > 0 ? [c.eye[0] + d[0] * t, c.eye[1] + d[1] * t] : null;
    }
    function compassSpec() {
      const { mn, mx } = bbox, Rpart = Math.max(mx[0] - mn[0], mx[1] - mn[1]) / 2 * 1.04, px = Math.max(1e-6, pxPerMm());
      const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1, half = Math.hypot(w, h) / 2 / px;
      const cx = (mn[0] + mx[0]) / 2, cy = (mn[1] + mx[1]) / 2;
      // steps round in the shown unit; at low quality one minor step halves each major one instead of nine tenths
      const sub = lowQuality() ? 2 : 10, kU = MM / UNIT_SCALE, major = niceStep(10 / px / kU) * kU * 10, minor = major / sub;
      // the ground under the middle of the view, a little below centre
      const G = groundAt(0, -0.3, mn[2]), rG = G ? Math.hypot(G[0] - cx, G[1] - cy) : 0;
      // the angle scale goes on a major ring: the largest one that is (nearly) all in view, or, zoomed in,
      // the major ring through the middle of the view
      const H = canvas.clientHeight || 1, inView = (r) => {
        let n = 0;
        for (let i = 0; i < 48; i++) { const t = i / 48 * 2 * Math.PI, s = toScreen3([cx + Math.cos(t) * r, cy + Math.sin(t) * r, mn[2]]); if (s && s[0] >= 0 && s[1] >= 0 && s[0] <= w && s[1] <= H) n++; }
        return n / 48;
      };
      let Ra = 0;
      for (let k = 1; k <= 80; k++) { if (inView(k * major) >= 0.85) Ra = k * major; else if (Ra) break; }
      if (!Ra) Ra = Math.max(major, Math.round(rG / major) * major);
      const arc = (deg) => Ra * deg * Math.PI / 180 * px;
      const aMajor = ANGLE_MAJORS.slice().reverse().find(m => arc(m / 10) >= 5) || 90, aMinor = aMajor / sub;
      // how far the grid reaches: well past the view (low views look far along the ground)
      const Rv = Math.max(Rpart, Ra) * 1.5 + half * 6 + Math.hypot(pan[0], pan[1]);
      return { R: Rpart, Ra, Rv, px, minor, major, aMajor, aMinor, cx, cy, G, half, sub };
    }
    function drawCompass3d() {
      if (!gridProg) return;
      const S = compassSpec(), z = bbox.mn[2], { cx, cy } = S, E = S.Rv;
      if (!gridBuf) gridBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, gridBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([cx - E, cy - E, z, cx + E, cy - E, z, cx + E, cy + E, z, cx - E, cy - E, z, cx + E, cy + E, z, cx - E, cy + E, z]), gl.DYNAMIC_DRAW);
      gl.useProgram(gridProg);
      const U = (n) => gl.getUniformLocation(gridProg, n);
      gl.uniformMatrix4fv(U('mvp'), false, new Float32Array(lastM));
      gl.uniform2f(U('C'), cx, cy); gl.uniform1f(U('minor'), S.minor); gl.uniform1f(U('major'), S.major);
      gl.uniform1f(U('spoke'), Math.max(S.aMajor, 10)); gl.uniform1f(U('Ra'), S.Ra); gl.uniform1f(U('aMinor'), S.aMinor); gl.uniform1f(U('kU'), MM / UNIT_SCALE); gl.uniform1f(U('sub'), S.sub);
      const aP = gl.getAttribLocation(gridProg, 'pos');
      gl.enableVertexAttribArray(aP); gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 12, 0);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(2, 2);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.depthMask(true); gl.disable(gl.BLEND);
    }
    // redraws are gathered into one per screen refresh (a burst of wheel or pointer events draws once)
    let draw3dQueued = false;
    function draw3d() {
      syncSlice();
      if (draw3dQueued) return;
      draw3dQueued = true;
      requestAnimationFrame(() => { draw3dQueued = false; draw3dNow(); });
    }
    function draw3dNow() {
      if (!gl) return;
      const dpr = lowQuality() ? 1 : (window.devicePixelRatio || 1), w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
      const CW = canvas.width, CH = canvas.height;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, CW, CH);
      gl.clearColor(0.11, 0.12, 0.14, 1); gl.clearStencil(0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      if (!triCount) return;
      const target = [center[0] + pan[0], center[1] + pan[1], center[2] + pan[2]];
      // perspective ↔ orthographic: narrow the field of view while backing the camera off, so the plane through
      // the view's centre keeps its size on screen (a "dolly zoom"); fully orthographic is a near-zero angle from far away
      const tanH = Math.tan(0.35) * Math.pow(0.004, 1 - projT), D = dist * Math.tan(0.35) / tanH;
      const eye = [target[0] + D * Math.cos(pitchA) * Math.cos(yaw), target[1] + D * Math.cos(pitchA) * Math.sin(yaw), target[2] + D * Math.sin(pitchA)];
      // near/far follow the camera, so it can come right up to (and inside) the part
      const back = dist * 0.99 + (1 - projT) * (radius * 4 + dist * 0.01);    // orthographic: nothing in front of the view's centre is clipped
      const f = 1 / tanH, a = w / h, nr = Math.max(D - back, D * 1e-5, radius * 0.0002), fr = D + radius * 6;
      const P = [f / a, 0, 0, 0, 0, f, 0, 0, 0, 0, (fr + nr) / (nr - fr), -1, 0, 0, 2 * fr * nr / (nr - fr), 0];
      const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]], cr = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
      const nm = (p) => { const l = Math.hypot(p[0], p[1], p[2]); return [p[0] / l, p[1] / l, p[2] / l]; }, dt = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
      const z = nm(sub(eye, target)), x = nm(cr([0, 0, 1], z)), y = cr(z, x);
      camBasis = { x, y, z };
      lastCam = { eye, x, y, z, tanH, a };
      const Vm = [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dt(x, eye), -dt(y, eye), -dt(z, eye), 1];
      const M = new Array(16);
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += P[k * 4 + r] * Vm[c * 4 + k]; M[c * 4 + r] = s; }
      lastM = M;
      const wire = wireBox.checked && lineCount > 0, ssao = state.ssao && !lowQuality();
      const T = (ssao || wire) ? targets(CW, CH) : null;
      const planes = cutPlanes();
      // the part (+ the cut faces of each active plane) with a given program
      const drawPart = (pr, extra) => {
        gl.useProgram(pr);
        const U = (n) => gl.getUniformLocation(pr, n);
        gl.uniformMatrix4fv(U('mvp'), false, new Float32Array(M)); gl.uniformMatrix4fv(U('mv'), false, new Float32Array(Vm));
        gl.uniform3fv(U('eye'), eye); gl.uniform1f(U('far'), fr); gl.uniform1f(U('dn'), nr);
        gl.uniform4fv(U('clip'), new Float32Array(planes.flatMap(p => [p.n[0], p.n[1], p.n[2], p.w])));
        gl.uniform1fv(U('clipOn'), new Float32Array(planes.map(p => p.on ? 1 : 0))); gl.uniform1f(U('skip'), -1);
        if (extra) extra(U);
        const aP = gl.getAttribLocation(pr, 'pos'), aN = gl.getAttribLocation(pr, 'nrm');
        gl.enableVertexAttribArray(aP); gl.enableVertexAttribArray(aN);
        const bind = (buf) => { gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 24, 0); gl.vertexAttribPointer(aN, 3, gl.FLOAT, false, 24, 12); };
        gl.uniform1f(U('mode'), 0);
        bind(triBuf);
        if (wire) { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 1); }
        gl.drawArrays(gl.TRIANGLES, 0, triCount);
        gl.disable(gl.POLYGON_OFFSET_FILL);
        planes.forEach((p, j) => {
          if (!p.on) return;
          // cap of plane j: a point X of the plane is inside the solid when an odd number of the part's
          // surfaces lie beyond it along the view ray (on the far side of the plane from the eye)
          gl.clearStencil(0); gl.clear(gl.STENCIL_BUFFER_BIT);
          gl.enable(gl.STENCIL_TEST);
          gl.colorMask(false, false, false, false); gl.depthMask(false); gl.disable(gl.DEPTH_TEST);
          gl.stencilFunc(gl.ALWAYS, 0, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
          gl.uniform4f(U('capPlane'), p.n[0], p.n[1], p.n[2], p.w);
          gl.uniform1f(U('capSide'), Math.sign(p.n[0] * eye[0] + p.n[1] * eye[1] + p.n[2] * eye[2] - p.w) || 1);
          gl.uniform1f(U('mode'), 3); bind(triBuf);
          gl.drawArrays(gl.TRIANGLES, 0, triCount);
          gl.colorMask(true, true, true, true); gl.depthMask(true); gl.enable(gl.DEPTH_TEST);
          gl.stencilFunc(gl.NOTEQUAL, 0, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
          // the cap: a square on the plane around the part, cut by the other planes
          const c = p.n[0] * center[0] + p.n[1] * center[1] + p.n[2] * center[2] - p.w;
          const o = [center[0] - p.n[0] * c, center[1] - p.n[1] * c, center[2] - p.n[2] * c], R = radius * 1.8;
          const a = Math.abs(p.n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], u1 = norm3(cross3(p.n, a)), u2 = cross3(p.n, u1);
          const corner = (s, t) => [o[0] + (u1[0] * s + u2[0] * t) * R, o[1] + (u1[1] * s + u2[1] * t) * R, o[2] + (u1[2] * s + u2[2] * t) * R];
          const q = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, -1), corner(1, 1), corner(-1, 1)];
          gl.bindBuffer(gl.ARRAY_BUFFER, capBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(q.flatMap(v => [v[0], v[1], v[2], p.n[0], p.n[1], p.n[2]])), gl.DYNAMIC_DRAW);
          bind(capBuf);
          gl.uniform1f(U('mode'), 2); gl.uniform1f(U('skip'), j); gl.uniform3fv(U('capCol'), p.cap);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
          gl.uniform1f(U('skip'), -1);
          gl.disable(gl.STENCIL_TEST);
          bind(triBuf);
        });
        gl.disableVertexAttribArray(aN);
        return { U, aP, aN, bind };
      };
      const quad = (pr, setup) => {
        gl.useProgram(pr); setup((n) => gl.getUniformLocation(pr, n));
        const aQ = gl.getAttribLocation(pr, 'q');
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf); gl.enableVertexAttribArray(aQ); gl.vertexAttribPointer(aQ, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6); gl.disableVertexAttribArray(aQ);
      };
      if (T) {
        // 1. normals and depth
        gl.bindFramebuffer(gl.FRAMEBUFFER, T.gF); gl.viewport(0, 0, CW, CH);
        gl.clearColor(0.5, 0.5, 1, 1); gl.clearStencil(0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        const g = drawPart(gProg);
        // 2. wireframe against the same depth
        if (wire) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, T.lF); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
          gl.depthMask(false); gl.depthFunc(gl.LEQUAL);
          gl.uniform1f(g.U('mode'), 1); g.bind(lineBuf); gl.disableVertexAttribArray(g.aN); gl.vertexAttrib3f(g.aN, 0, 0, 1);
          gl.drawArrays(gl.LINES, 0, lineCount);
          gl.depthMask(true); gl.depthFunc(gl.LESS);
        }
        gl.disable(gl.DEPTH_TEST);
        // 3. ambient occlusion, then a small blur
        if (ssao) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, T.aF);
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, T.gT);
          quad(aoProg, (U) => { gl.uniform1i(U('g'), 0); gl.uniform2f(U('proj'), f / a, f); gl.uniform1f(U('far'), fr); gl.uniform1f(U('dn'), nr); gl.uniform1f(U('R'), Math.min(Math.max(0.04, Math.min(0.6, radius * 0.02)), 20 / Math.max(1e-9, pxPerMm()))); });   // mm
          gl.bindFramebuffer(gl.FRAMEBUFFER, T.bF);
          gl.bindTexture(gl.TEXTURE_2D, T.aT);
          quad(blurProg, (U) => { gl.uniform1i(U('t'), 0); gl.uniform2f(U('px'), 1 / CW, 1 / CH); });
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, CW, CH); gl.enable(gl.DEPTH_TEST);
      }
      // 4. the shaded part
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, T && ssao ? T.bT : null);
      drawPart(prog, (U) => { gl.uniform1i(U('aoTex'), 0); gl.uniform1f(U('aoOn'), T && ssao ? 1 : 0); gl.uniform2f(U('res'), CW, CH); });
      // the compass, lying on the ground plane under the part and turning with it; the cut axes; problem edges
      if (bbox && texProg) { drawCompass3d(); drawCutEdges(); drawGizmo(); drawAxisLabels(); }
      // 5. the wireframe: 1 device pixel, not smoothed
      if (wire) {
        if (T) {
          gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.bindTexture(gl.TEXTURE_2D, T.lT);
          quad(copyProg, (U) => gl.uniform1i(U('t'), 0));
          gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST);
        } else {
          gl.useProgram(gProg);
          const U = (n) => gl.getUniformLocation(gProg, n), aP = gl.getAttribLocation(gProg, 'pos'), aN = gl.getAttribLocation(gProg, 'nrm');
          gl.uniformMatrix4fv(U('mvp'), false, new Float32Array(M)); gl.uniform1f(U('mode'), 1);
          gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf); gl.enableVertexAttribArray(aP); gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 24, 0); gl.disableVertexAttribArray(aN);
          gl.depthFunc(gl.LEQUAL); gl.drawArrays(gl.LINES, 0, lineCount); gl.depthFunc(gl.LESS);
        }
      }
    }
    // orbit: left-drag (sideways movement has a dead zone of ~10 % of the view's width, so a mostly
    // vertical drag only tilts); pan: Ctrl+drag, middle- or right-drag; zoom: wheel; double-click recentres
    let orbit = null;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    function resetCamera() { pan = [0, 0, 0]; dist = radius * 2.2; pitchA = 0.5; draw3d(); }
    function handleAt(x, y) {
      if (!bbox || !lastM || !state.cutHandles) return null;
      let best = null;
      const spots = handleSpots();
      for (const k of HANDLE_KEYS) { const s = toScreen3(spots[k]); if (!s) continue; const d = Math.hypot(s[0] - x, s[1] - y); if (d < 14 && (!best || d < best.d)) best = { k, d }; }
      return best && best.k;
    }
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 1) e.preventDefault();
      const r0 = canvas.getBoundingClientRect(), hk = e.button === 0 ? handleAt(e.clientX - r0.left, e.clientY - r0.top) : null;
      if (hk) {
        // slide the cut along its axis
        cutDrag = { k: hk, x0: e.clientX, y0: e.clientY, v0: hk.length > 1 ? loOf(hk[0]) : hiOf(hk) };
        canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'move'; draw3d(); return;
      }
      orbit = { x: e.clientX, y: e.clientY, x0: e.clientX, yaw0: yaw, pitch: pitchA, panBtn: e.button !== 0 };
      canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing';
    });
    canvas.addEventListener('pointermove', (e) => {
      if (cutDrag) {
        const f = cutFrame(), key = cutDrag.k, k = key[0];
        if (!cutDrag.v) {
          // the axis as seen on the screen, measured once where the drag started
          const d = f.dirs[k], P = handlePos(key), ext = f.ext[k];
          const A = toScreen3(P), B = toScreen3([P[0] + d[0] * ext * 0.1, P[1] + d[1] * ext * 0.1, P[2] + d[2] * ext * 0.1]);
          if (!A || !B) return;
          cutDrag.v = [B[0] - A[0], B[1] - A[1]];
        }
        {
          // follow the pointer along the axis as it is seen on the screen. An axis seen nearly end-on is only a few
          // pixels long there: followed exactly, the slightest move would sweep the cut from one end to the other,
          // so it is never taken as shorter than MINPX pixels (and one seen exactly end-on goes by up and down).
          const MINPX = 140, len = Math.hypot(cutDrag.v[0], cutDrag.v[1]), pxPerUnit = len / 0.1;
          const ux = len > 0.3 ? cutDrag.v[0] / len : 0, uy = len > 0.3 ? cutDrag.v[1] / len : -1, scale = Math.max(pxPerUnit, MINPX);
          const raw = Math.max(f.lo[k], Math.min(1, cutDrag.v0 + ((e.clientX - cutDrag.x0) * ux + (e.clientY - cutDrag.y0) * uy) / scale));
          // within 10 px of travel from the origin (the middle of the base) it snaps there (Alt: freely)
          const v = Math.abs(raw) * scale < 10 && !e.altKey ? 0 : raw;
          // (the same cuts as the sliders: the lower one stays below the upper)
          if (key.length > 1) setCut(k, v, hiOf(k), 'lo'); else setCut(k, loOf(k), v, 'hi');
          cutDrag.snapped = v === 0 && raw !== 0;
        }
        draw3d(); return;
      }
      if (!orbit) {
        const r0 = canvas.getBoundingClientRect();
        canvas.style.cursor = handleAt(e.clientX - r0.left, e.clientY - r0.top) ? 'move' : 'grab';
        return;
      }
      const dx = e.clientX - orbit.x, dy = e.clientY - orbit.y;
      if (orbit.panBtn) {
        if (camBasis) {
          const k = dist * 2 * Math.tan(0.35) / Math.max(1, canvas.clientHeight), { x, y } = camBasis;
          for (let c = 0; c < 3; c++) pan[c] += (-dx * x[c] + dy * y[c]) * k;
        }
        orbit.x0 += dx; orbit.yaw0 = yaw;          // a pan does not count toward the orbit dead zone
      } else {
        const dead = canvas.clientWidth * 0.05, tx = e.clientX - orbit.x0;
        const ny = orbit.yaw0 - Math.sign(tx) * Math.max(0, Math.abs(tx) - dead) * 0.008;
        // Ctrl: the turn and the tilt in steps (the unsnapped tilt kept underneath)
        const snapO = e.ctrlKey || e.metaKey, st = orbitStep() * Math.PI / 180;
        orbit.pitch = Math.max(-1.5, Math.min(1.5, orbit.pitch + dy * 0.008));
        pitchA = snapO ? Math.max(-1.5, Math.min(1.5, Math.round(orbit.pitch / st) * st)) : orbit.pitch;
        const nd = snapO ? Math.round(degOf(ny) / orbitStep()) * orbitStep() : degOf(ny);
        if (Math.abs(nd - degOf(yaw)) > 1e-9) { setViewAngle(nd, true); orbit.x = e.clientX; orbit.y = e.clientY; return; }
      }
      orbit.x = e.clientX; orbit.y = e.clientY; draw3d();
    });
    const endOrbit = () => { if (cutDrag) { cutDrag = null; saveSettings(); draw3d(); } orbit = null; canvas.style.cursor = 'grab'; };
    canvas.addEventListener('pointerup', endOrbit); canvas.addEventListener('pointercancel', endOrbit);
    canvas.addEventListener('dblclick', (e) => {
      const r0 = canvas.getBoundingClientRect(), hk = handleAt(e.clientX - r0.left, e.clientY - r0.top);
      if (hk) { if (hk.length > 1) setCut(hk[0], LO_END[hk[0]], hiOf(hk[0]), 'lo'); else setCut(hk, loOf(hk), 1, 'hi'); saveSettings(); return; }      // remove that cut
      pan = [0, 0, 0]; draw3d();
    });
    cutHBox.addEventListener('change', () => { state.cutHandles = cutHBox.checked; saveSettings(); draw3d(); });
    cutModeSel.addEventListener('change', () => { state.cutMode = cutModeSel.value; saveSettings(); draw3d(); });
    cutReset.addEventListener('click', () => { state.cuts = { x: 1, y: 1, z: 0 }; state.cutsLo = { ...LO_END }; if (state.linkSlicers) { bandFrom3d(); drawSection(); } saveSettings(); draw3d(); });
    canvas.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      // zoom toward the point under the pointer: it stays put on the screen. The camera eases to the new place.
      const bd = zoom3 ? zoom3.dist : dist, bp = zoom3 ? zoom3.pan.slice() : pan.slice();
      const minD = radius * 0.03, want = Math.min(radius * 12, bd * Math.exp(e.deltaY * 0.0012)), nd = Math.max(minD, want), k = 1 - nd / bd;
      const r = canvas.getBoundingClientRect(), nx = (e.clientX - r.left) / r.width * 2 - 1, ny = 1 - (e.clientY - r.top) / r.height * 2;
      if (camBasis && r.width && r.height) {
        const th = Math.tan(0.35), ox = nx * th * (r.width / r.height) * bd, oy = ny * th * bd, { x, y, z } = camBasis;
        for (let c = 0; c < 3; c++) bp[c] += (ox * x[c] + oy * y[c]) * k;
        if (want < minD && e.deltaY < 0) {
          // past the point zooming would stop: keep going, moving toward the pointer (through the part if need be)
          const dir = [0, 1, 2].map(c => -z[c] + nx * th * (r.width / r.height) * x[c] + ny * th * y[c]), l = Math.hypot(...dir), step = radius * 0.04 * Math.min(4, -e.deltaY / 100);
          for (let c = 0; c < 3; c++) bp[c] += dir[c] / l * step;
        }
      }
      const fresh = !zoom3;
      zoom3 = { dist: nd, pan: bp };
      if (!fresh) return;
      const step = () => {
        const t = zoom3; if (!t) return;
        const kk = reduceMotion() ? 1 : 0.4, ld = Math.log(dist), lt = Math.log(t.dist);
        const done = Math.abs(lt - ld) < 0.002 && Math.hypot(t.pan[0] - pan[0], t.pan[1] - pan[1], t.pan[2] - pan[2]) < radius * 1e-4;
        dist = done ? t.dist : Math.exp(ld + (lt - ld) * kk);
        pan = done ? t.pan : pan.map((v, c) => v + (t.pan[c] - v) * kk);
        draw3dNow();
        if (done) zoom3 = null; else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }, { passive: false });
    let zoom3 = null;
    canvas.addEventListener('pointerdown', () => { zoom3 = null; }, true);      // grabbing the view stops a zoom in progress
    wireBox.addEventListener('change', () => { state.wire = wireBox.checked; saveSettings(); draw3d(); });
    ssaoBox.addEventListener('change', () => { state.ssao = ssaoBox.checked; saveSettings(); draw3d(); });
    orthoBox.addEventListener('change', () => {
      state.ortho = orthoBox.checked; saveSettings();
      const from = projT, to = state.ortho ? 0 : 1, ms = reduceMotion() ? 0 : 450, t0 = performance.now(), id = ++projAnim;
      const step = (now) => {
        if (id !== projAnim) return;
        const k = ms ? Math.min(1, (now - t0) / ms) : 1, e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        projT = from + (to - from) * e; draw3d();
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });

    // ---- the section angle, shared by the cross-section, the 3D view and both compasses ----
    function setViewAngle(deg, keepYaw) {
      // half-degree steps (a section angle measurements are pinned to is kept exactly)
      if (!pinnedAngles().some(a => Math.abs((((deg - a) % 360) + 540) % 360 - 180) < 1e-6)) deg = Math.round(deg * 2) / 2;
      state.viewAngle = ((deg % 360) + 360) % 360;
      const want = yawOf(state.viewAngle), before = yaw;
      // keep yaw continuous (no jump of 2π while orbiting)
      yaw = keepYaw ? yawOf(deg) : want + Math.round((yaw - want) / (2 * Math.PI)) * 2 * Math.PI;
      // turning is always about the part's axis: a panned view turns with it, so the axis stays put on screen
      const da = yaw - before, c = Math.cos(da), s = Math.sin(da);
      if (da) pan = [pan[0] * c - pan[1] * s, pan[0] * s + pan[1] * c, pan[2]];
      draw3d(); drawCompasses();
      if (!sectionQueued) { sectionQueued = true; requestAnimationFrame(() => { sectionQueued = false; if (root.isConnected && !drag) drawSection(); }); }
    }
    let sectionQueued = false;
    function drawCompasses() {
      const dpr = window.devicePixelRatio || 1, A = state.viewAngle;
      // 1-D: a scrolling heading tape
      {
        // (twice the old tape, as room allows; it fades out toward both ends)
        const W1 = Math.max(200, Math.min(600, Math.round((left.clientWidth || 700) - 100))), H1 = 26, c = compass1, x = c.getContext('2d');
        if (c.style.width !== W1 + 'px') c.style.width = W1 + 'px';
        if (c.width !== W1 * dpr || c.height !== H1 * dpr) { c.width = W1 * dpr; c.height = H1 * dpr; }
        x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, W1, H1);
        x.fillStyle = 'rgba(255,255,255,.94)'; x.fillRect(0, 0, W1, H1);
        x.strokeStyle = '#ced4da'; x.beginPath(); x.moveTo(0, 0.5); x.lineTo(W1, 0.5); x.moveTo(0, H1 - 0.5); x.lineTo(W1, H1 - 0.5); x.stroke();
        const PXD = 2.2, cx = W1 / 2;
        x.font = '10px sans-serif'; x.textAlign = 'center'; x.fillStyle = '#495057';
        for (let d = Math.floor((A - cx / PXD) / 5) * 5; d <= A + cx / PXD; d += 5) {
          const px = cx + (d - A) * PXD, major = ((d % 30) + 30) % 30 === 0;
          x.strokeStyle = major ? '#495057' : '#adb5bd'; x.beginPath(); x.moveTo(px + 0.5, H1); x.lineTo(px + 0.5, H1 - (major ? 9 : 5)); x.stroke();
          if (major) x.fillText(ANG_SCALE === 1 ? String(((d % 360) + 360) % 360) + '°' : num((((d % 360) + 360) % 360) * ANG_SCALE, 2), px, 11);
        }
        // section angles measurements are pinned to; those off the tape (or faded out) counted above its ends
        let nl = 0, nr = 0;
        for (const a of pinnedAngles()) {
          const dd = (((a - A) % 360) + 540) % 360 - 180, px = cx + dd * PXD;
          if (px < W1 * 0.15) { nl++; continue; }
          if (px > W1 * 0.85) { nr++; continue; }
          x.fillStyle = '#1864ab'; x.beginPath(); x.moveTo(px - 5, 0); x.lineTo(px + 5, 0); x.lineTo(px, 7); x.closePath(); x.fill();
        }
        pinHintL.style.display = nl ? '' : 'none'; pinHintL.textContent = '◂ ' + nl + ' measured';
        pinHintR.style.display = nr ? '' : 'none'; pinHintR.textContent = nr + ' measured ▸';
        pinHintL.style.left = 'calc(50% - ' + (W1 / 2) + 'px)'; pinHintR.style.left = 'calc(50% + ' + (W1 / 2) + 'px)';
        x.strokeStyle = '#e8590c'; x.lineWidth = 2; x.beginPath(); x.moveTo(cx, 0); x.lineTo(cx, H1); x.stroke(); x.lineWidth = 1;
        x.fillStyle = '#e8590c'; x.font = 'bold 10px sans-serif'; x.fillText(ANG_SCALE === 1 ? A.toFixed(1) + '°' : (A * ANG_SCALE).toFixed(3), cx + 22, H1 - 4);
      }
    }
    {
      // (the angle follows the pointer unsnapped underneath, so Ctrl steps without losing the drag)
      let d1 = null, raw = 0;
      compass1.addEventListener('pointerdown', (e) => { d1 = e.clientX; raw = state.viewAngle; compass1.setPointerCapture(e.pointerId); e.stopPropagation(); });
      compass1.addEventListener('pointermove', (e) => {
        if (d1 == null) return;
        raw -= (e.clientX - d1) / 2.2; d1 = e.clientX;
        setViewAngle(e.ctrlKey || e.metaKey ? Math.round(raw / orbitStep()) * orbitStep() : pinMagnet(raw));
      });
      compass1.addEventListener('pointerup', () => { d1 = null; });
      compass1.addEventListener('dblclick', (e) => { e.stopPropagation(); setViewAngle(Math.round(state.viewAngle / orbitStep()) * orbitStep()); });
    }
    drawCompasses();
    flipBox.addEventListener('change', () => setFlip(flipBox.checked));

    const ro = new ResizeObserver(() => { if (root.isConnected) { measure(); if (state.scene && !view) fit(); drawSection(); draw3d(); drawCompasses(); } });
    ro.observe(left); ro.observe(view3d);
    // property columns fold to one when the side bar gets narrow
    const roSide = new ResizeObserver(() => { const c = rightBar.clientWidth && rightBar.clientWidth < 560 ? 1 : 2; if (c !== pgridMaxCols && root.isConnected) renderSide(); else fitHeads(); });
    roSide.observe(rightBar);

    function render() {
      if (!root.isConnected) return;
      loading.style.display = state.scene ? 'none' : 'flex';
      if (state.scene) pruneSelection();
      if (state.preview) setMesh(state.preview);
      else if (triCount) { triCount = 0; lineCount = 0; shown = null; bbox = null; meshTris = null; draw3d(); }
      if (!drag) drawSection();
      if (!drag || !drag.moved) renderSide(); else headStatus(statusText());
      busyTag.textContent = state.busy ? 'Updating…' : '';
      if (seenHeights !== state.heightFrom) { seenHeights = state.heightFrom; syncSlice(); }     // the 3D height slider's label
    }
    let seenHeights = state.heightFrom;
    function destroy() { ro.disconnect(); roSide.disconnect(); window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', onKeyUp, true); root.remove(); }
    const flipped = () => {
      if (view) view.cz = -view.cz;
      for (const o of Object.values(ownViews)) if (o) o.cz = -o.cz;
      flipBox.checked = !!state.flip;
      yaw = yawOf(state.viewAngle);                       // the same section stays toward the viewer
      if (state.linkSlicers) cutsFromBand();              // the band keeps its heights; the 3D slicer counts from the other end
      drawSection(); draw3d();
    };
    const slicersLinked = () => { linkSBox.checked = !!state.linkSlicers; if (state.linkSlicers) bandFrom3d(); drawSection(); draw3d(); };
    return { root, render, destroy, showSplash, flipped, slicersLinked, geoSpawned };
  }

  // ---- Boot: the editor fills the page; the last scene comes back, otherwise the start screen ----
  const boot = () => {
    document.title = 'Adapter Assembler';
    document.body.textContent = '';
    document.body.style.margin = '0';
    const host = el('div', { style: 'position:fixed;inset:0;background:#fff' });
    document.body.append(host);
    const last = lastScene(sceneKey());
    if (last) { state.scene = clone(last.scene); state.edited = true; if (isFinite(last.angle)) state.viewAngle = last.angle; markEdited(); }
    mountEditor(host);
    if (last) recalc(); else if (editor) editor.showSplash();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();

  // Small handle for troubleshooting from the console.
  Object.defineProperty(W, '__adapterAssembler', { value: { state, processMesh, evaluateScene, recalc, addObject, wrapSelection, libLoad, buildAdapter }, configurable: true });
})();
