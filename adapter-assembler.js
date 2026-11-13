// Adapter Assembler — design threaded adapters in the browser and export STL / OBJ.
// https://github.com/electroluminescent/adapter-assembler
// Version 3.2.0. Booleans use the Manifold library (Apache-2.0), loaded from jsDelivr.
(function () {
  'use strict';

  // Model files are in inches; most slicers read STL as millimetres.
  const UNIT_SCALE = 25.4;          // set to 1 to keep inches
  const UNIT_LABEL = UNIT_SCALE === 1 ? 'in' : 'mm';
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
    format: 'stl',         // 'stl' | 'obj'
    cut: true,             // 3D view: cut away half
    wire: false,           // 3D view: wireframe
    ssao: true,            // 3D view: ambient occlusion
    ortho: false,          // 3D view: orthographic (true) or perspective projection
    flip: false,           // turn the part upside down (export and 3D view)
    paneLeft: 40,          // editor layout: cross-section width (% of the editor)
    paneSide: 55,          // editor layout: side bar height (% of the right column, under the 3D view)
    minLeft: false, min3d: false, minSide: false,   // editor panes minimized
    selBoxCollapsed: false,
    cutMode: 'relative',   // 3D cut planes: 'relative' (turn with the view) or 'absolute' (fixed to the part)
    cuts: { x: 1, y: 1, z: 0 },   // 3D cut planes: slider positions (1 = no cut)
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
  const SETTINGS_KEY = 'adapterAssembler.settings', SAVED_SETTINGS = ['helical', 'optimize', 'precision', 'faces', 'format', 'cut', 'wire', 'ssao', 'ortho', 'flip', 'paneLeft', 'paneSide', 'minLeft', 'min3d', 'minSide', 'selBoxCollapsed', 'sidePanels', 'cutMode', 'cuts'];
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    for (const k of SAVED_SETTINGS) if (k in saved && typeof saved[k] === typeof state[k]) state[k] = saved[k];
  } catch (_) { /* storage unavailable */ }
  // always on: true helical threads, and welding / T-junction repair of the exported mesh
  state.helical = true; state.optimize = true;
  if (!['ngons', 'quads', 'tris'].includes(state.faces)) state.faces = 'ngons';
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
    if (opts.format === 'obj') {
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
      preview: { tris: pv, lines, bad: new Float32Array(badEdges) },
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
  //     out = bulging outward / rounded, otherwise a cove).
  // ---------------------------------------------------------------------------
  // Tangent distance a bevel wants at corner P (how far it eats into each edge).
  function bevelReach(A, P, B, bv) {
    if (!bv || P.y < 1e-9) return 0;
    const ax = A.y - P.y, az = A.z - P.z, bx = B.y - P.y, bz = B.z - P.z, la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la < 1e-9 || lb < 1e-9) return 0;
    if (bv.trim) return bv.trim;
    if (!(bv.r > 0)) return 0;
    const ang = Math.acos(Math.max(-1, Math.min(1, (ax * bx + az * bz) / (la * lb))));
    if (ang < 1e-3 || Math.PI - ang < 1e-3) return 0;
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
    const half = ang / 2;
    const t = tFix != null ? tFix : Math.min(bv.r / Math.tan(half), la * 0.45, lb * 0.45), r = t * Math.tan(half);
    const T1 = [P.y + u1[0] * t, P.z + u1[1] * t], T2 = [P.y + u2[0] * t, P.z + u2[1] * t];
    const segs = Math.max(1, Math.min(64, bv.segs | 0 || 1));
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
            dir: Math.sign(r.zLast - r.zFirst) || 1, zMin: Math.min(r.zFirst, r.zLast), zMax: Math.max(r.zFirst, r.zLast) } });
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
    const bv = p.bevel > 0 ? { r: p.bevel, segs: p.bevelSegs, out: p.bevelOut } : null;
    return [{ y: rib, z: z0 }, { y: rob, z: z0 }, { y: rot, z: z1 }, { y: rit, z: z1 }]
      .map(q => ({ y: Math.max(0, q.y), z: q.z, bevel: bv && q.y > 1e-9 ? { ...bv } : null }));
  }

  // Revolve a loop of items into an indexed, outward-facing, closed mesh.
  //   segments: columns around the axis; scale: radius factor at the columns
  //   (n-sided objects sized about their face centres); phase: start angle;
  //   helical: thread bands climb (hand ±1) or stay rings (false).
  function revolve(items, opts) {
    const N = Math.max(3, opts.segments | 0), TAU = Math.PI * 2, scale = opts.scale || 1, phase = opts.phase || 0;
    const V = [], axisCache = new Map();
    function vert(r, z, phi) {
      r *= scale;
      if (r < 1e-12) {
        const k = String(z); let id = axisCache.get(k);
        if (id === undefined) { id = V.length / 3; V.push(0, 0, z); axisCache.set(k, id); }
        return id;
      }
      V.push(r * Math.cos(phi + phase), r * Math.sin(phi + phase), z);
      return V.length / 3 - 1;
    }
    const pats = new Map();
    const patOf = (b) => { let p = pats.get(b); if (!p) { p = toothPattern(b); pats.set(b, p); } return p; };
    const hand = (b) => opts.helical ? (b.hand || 0) : 0;
    function column(j) {
      const phi = TAU * j / N, col = [];
      items.forEach((it, pi) => {
        if (!it.band) { col.push({ id: vert(it.y, it.z, phi), key: [pi, 0] }); return; }
        const b = it.band, shift = hand(b) * b.pitch * phi / TAU, d = b.dir, P = b.pitch, pat = patOf(b);
        const zs = d > 0 ? b.zMin : b.zMax, ze = d > 0 ? b.zMax : b.zMin;
        col.push({ id: vert(toothAt(b, pat, zs - b.zFirst - shift), zs, phi), key: [pi, -Infinity] });
        // tooth corners lie on helices: z = zFirst + (m·pitch + corner phase) + shift
        const mLo = Math.floor((b.zMin - b.zFirst - shift) / P) - 1, mHi = Math.ceil((b.zMax - b.zFirst - shift) / P) + 1;
        const vs = [];
        for (let m = mLo; m <= mHi; m++) for (const e of pat) {
          const uu = m * P + e.u, z = b.zFirst + uu + shift;
          if (z - b.zMin > 1e-7 && b.zMax - z > 1e-7) vs.push({ uu, z, r: e.r });
        }
        vs.sort((x, y) => d * (x.z - y.z));
        for (const v of vs) col.push({ id: vert(v.r, v.z, phi), key: [pi, d * (b.zFirst + v.uu)] });
        col.push({ id: vert(toothAt(b, pat, ze - b.zFirst - shift), ze, phi), key: [pi, Infinity] });
      });
      return col;
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

  // Lead-in taper of a thread object: the solid that is kept, a cone at the flank angle of the teeth
  // at the tapered end(s), so the thread starts at its root instead of half a tooth.
  function taperMesh(node, settings) {
    const q = node.params, t = threadProfile(q), r = t.runs[0];
    const z0 = Math.min(r.zFirst, r.zLast), z1 = Math.max(r.zFirst, r.zLast);
    const rRoot = q.kind === 'internal' ? Math.max(r.rFirst, r.rOther) : Math.min(r.rFirst, r.rOther);
    const rCrest = q.kind === 'internal' ? Math.min(r.rFirst, r.rOther) : Math.max(r.rFirst, r.rOther);
    const flank = Math.max(1e-6, (1 - (r.flatA || 0) - (r.flatB || 0)) / 2 * r.pitch), depth = Math.max(1e-6, Math.abs(rCrest - rRoot));
    const k = flank / depth;                    // axial change per radial change, as on a tooth flank
    const e = Math.max(1e-4, (z1 - z0) * 0.01), big = depth * 2 + 1e-3;
    // the cone runs from the backing wall at the end face to the crest, so the whole thread (backing too) is tapered
    const ys = t.pts.map(p => p.y);
    let pts;
    if (q.kind === 'internal') {
      // keep everything outside a cone that opens to the backing's outer wall at the tapered ends
      const rWall = Math.max(...ys), rIn = Math.max(0, rCrest - big), dz = (rWall - rIn) * k, rOut = rWall + 1;
      pts = [{ y: rOut, z: z0 - e }, { y: rOut, z: z1 + e }];
      if (q.taperTop) pts.push({ y: rWall, z: z1 + e }, { y: rWall, z: z1 }, { y: rIn, z: z1 - dz }); else pts.push({ y: rIn, z: z1 + e });
      if (q.taperBottom) pts.push({ y: rIn, z: z0 + dz }, { y: rWall, z: z0 }, { y: rWall, z: z0 - e }); else pts.push({ y: rIn, z: z0 - e });
    } else {
      // keep everything inside a cone that closes to the backing's inner wall at the tapered ends
      const rWall = Math.min(...ys), rOut = rCrest + big, dz = (rOut - rWall) * k;
      pts = [{ y: 0, z: z0 - e }];
      if (q.taperBottom) pts.push({ y: rWall, z: z0 - e }, { y: rWall, z: z0 }, { y: rOut, z: z0 + dz }); else pts.push({ y: rOut, z: z0 - e });
      if (q.taperTop) pts.push({ y: rOut, z: z1 - dz }, { y: rWall, z: z1 }, { y: rWall, z: z1 + e }); else pts.push({ y: rOut, z: z1 + e });
      pts.push({ y: 0, z: z1 + e });
    }
    return revolve(expandProfile(pts.map(p => ({ y: p.y, z: p.z, bevel: null })), []), { segments: node.precision > 2 ? node.precision : settings.precision });
  }

  // Outline of a thread object: a ring with an ISO-style (or plain V) thread on its outside
  // (external) or inside (internal) surface. All lengths in inches.
  function threadProfile(q) {
    const P = q.pitch, L = Math.max(P, q.turns * P), z0 = q.z, z1 = q.z + L, c = q.clearance || 0, iso = q.profile !== 'v';
    // solid material behind the teeth (inside a male thread, outside a female one): a multiple of the depth
    q = { ...q, wall: q.backing != null ? q.backing * q.depth : q.wall };
    if (q.kind === 'internal') {
      const rRoot = q.d / 2 + c, rCrest = Math.max(0, rRoot - q.depth), rOut = rRoot + Math.max(0.001, q.wall);
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

  // Mesh for one leaf node of the scene.
  function nodeMesh(node, settings) {
    if (node.type === 'source' || node.type === 'thread') {
      return revolve(expandProfile(node.pts, node.runs), { segments: node.precision > 2 ? node.precision : settings.precision, helical: settings.helical });
    }
    const items = expandProfile(node.pts, []);
    if (node.type === 'ngon') {
      const n = Math.max(3, node.params.sides | 0);
      return revolve(items, { segments: n, scale: node.params.about === 'faces' ? 1 / Math.cos(Math.PI / n) : 1, phase: (node.params.rotation || 0) * Math.PI / 180 });
    }
    return revolve(items, { segments: node.precision > 2 ? node.precision : settings.precision });
  }

  // Evaluate the scene (worker). Booleans, holes and several objects need the
  // Manifold library; a single object without holes does not.
  async function evaluateScene(scene, holes, settings) {
    const nodes = scene.nodes;
    const holesOf = (n) => n.type === 'source' ? (n.holes || (n.id === 'src' ? holes || [] : [])) : [];
    if (!scene.root.length) throw new Error('the scene is empty');
    const only = scene.root.length === 1 ? nodes[scene.root[0]] : null;
    const tapered = (n) => n.type === 'thread' && n.params && (n.params.taperTop || n.params.taperBottom);
    if (only && only.type !== 'boolean' && only.type !== 'group' && only.type !== 'cloner' && only.type !== 'holes' && !tapered(only) && !holesOf(only).length) return { mesh: nodeMesh(only, settings), engine: 'direct' };
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
        const q = node.params, n = Math.max(1, q.count | 0), R = q.radius * 1, spread = q.spread == null ? 360 : q.spread;
        const step = spread >= 360 - 1e-9 ? 360 / n : (n > 1 ? spread / (n - 1) : 0);
        let total = null;
        for (let k = 0; k < n; k++) {
          const a = (q.angle || 0) + k * step;
          const c = q.orient === 'radial' ? keep(keep(keep(base.rotate([0, 90, 0])).translate([R, 0, q.height || 0])).rotate([0, 0, a]))
            : keep(keep(base.translate([R, 0, 0])).rotate([0, 0, a]));
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
      if (tapered(node)) m = keep(m.intersect(toM(taperMesh(node, settings), 'the thread taper')));
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
    let mesh = data.mesh, engine = 'direct';
    if (data.scene) {
      const r = await evaluateScene(data.scene, data.holes, data.settings);
      mesh = soup(r.mesh); engine = r.engine;
    }
    if (data.opts && data.opts.flip) {
      // upside down: mirror Z and swap two corners of every triangle to keep the faces outward
      mesh = mesh.slice();
      for (let o = 0; o < mesh.length; o += 7) mesh[o + 2] = -mesh[o + 2];
      for (let t = 0; t < mesh.length; t += 21) for (let c = 0; c < 7; c++) { const x = mesh[t + 7 + c]; mesh[t + 7 + c] = mesh[t + 14 + c]; mesh[t + 14 + c] = x; }
    }
    const res = processMesh(mesh, data.opts);
    res.report.engine = engine;
    return res;
  }

  const exportJobs = new Map();   // job id → callback, for one-off exports
  let worker = null, workerFailed = false;
  function getWorker() {
    if (worker || workerFailed) return worker;
    try {
      const src = [processMesh, ngonFaces, bevelReach, cornerPoints, toothPattern, toothAt, threadProfile, taperMesh, expandProfile, runVertices, revolve, holeMesh, nodeMesh, evaluateScene, soup, runJob]
        .map(f => f.toString()).join('\n') +
        '\nself.onmessage = async function (e) {' +
        '  try { const r = await runJob(e.data); self.postMessage({ job: e.data.job, result: r }, [r.buffer, r.preview.tris.buffer, r.preview.lines.buffer, r.preview.bad.buffer]); }' +
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
    else setTimeout(() => runJob(data).then(r => dispatch(data.job, r), err => dispatch(data.job, null, String(err && err.message || err))), 0);
  }
  function dispatch(job, result, error) {
    const cb = exportJobs.get(job);
    if (cb) { exportJobs.delete(job); cb(result, error); return; }
    finish(job, result, error);
  }

  function haveInput() { return !!(state.scene && state.scene.root.length); }
  function jobOpts(fast) {
    return { flip: state.flip, optimize: fast ? false : state.optimize, unitScale: UNIT_SCALE, unitLabel: UNIT_LABEL, tolerance: WELD_TOLERANCE_IN * UNIT_SCALE, format: state.format, faces: state.faces };
  }
  function jobSettings() { return { precision: state.precision, helical: state.helical, manifoldUrl: W.__aaManifoldUrl || MANIFOLD_URL }; }

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
    if (state.scene) { data.scene = { nodes: state.scene.nodes, root: state.scene.root }; data.holes = state.holes; data.settings = jobSettings(); }
    state.jobFast = fast;
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
    post({ job, opts: jobOpts(false), scene, holes: state.holes, settings: jobSettings() });
  }
  function saveFile(buffer, ext, name) {
    const blob = new Blob([buffer], { type: ext === 'json' ? 'application/json' : ext === 'obj' ? 'text/plain' : 'model/stl' });
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
    const U = 1 / UNIT_SCALE, notes = [], H = spec.length, wall = Math.max(0.4, spec.wall || 2.5);
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
  function zBase(sc = state.scene) {
    let lo = Infinity;
    if (!sc) return 0;
    for (const id of leafOrder(sc)) {
      const n = sc.nodes[id], xf = xfOf(sc, id), o = outlineOf(n.pts, n.runs);
      for (const p of o) { if (xf.id) { if (p.z < lo) lo = p.z; continue; } const a = xf.fwd(p), b = xf.mir(p); lo = Math.min(lo, a.z, b.z); }
    }
    return isFinite(lo) ? lo : 0;
  }
  const hDisp = (z, base) => (z - base) * UNIT_SCALE;
  function newId(prefix) { state.scene.seq = (state.scene.seq || 1) + 1; return prefix + state.scene.seq; }
  const PREFIX = { circle: 'c', ngon: 'n', boolean: 'b', group: 'g', source: 's', thread: 't', cloner: 'k', holes: 'h' };

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
  function viewOutline(sc, id) { const n = sc.nodes[id], xf = xfOf(sc, id), o = outlineOf(n.pts, n.runs); return xf.id ? o : o.map(xf.fwd); }
  // Move points given a move in view coordinates (each object converts it into its own frame).
  function moveKeysView(sc, keys, dY, dZ) {
    const by = {};
    for (const k of keys) { const id = parseKey(k).node; (by[id] = by[id] || []).push(k); }
    for (const id in by) { const d = xfOf(sc, id).inv(dY, dZ); moveKeys(sc, by[id], d.y, d.z); }
  }
  function moveNodeView(sc, id, dY, dZ) { const d = xfOf(sc, id).inv(dY, dZ); moveNode(sc.nodes[id], d.y, d.z); }
  const singleSel = () => state.selNodes.size === 1 ? state.scene.nodes[[...state.selNodes][0]] : null;

  function defaultParams(view) {
    const cy = view ? view.cy : 1, cz = view ? view.cz : 0, w = 3 / UNIT_SCALE;
    return { z: cz - 2.5 / UNIT_SCALE, h: 5 / UNIT_SCALE, rib: Math.max(0, cy - w), rit: Math.max(0, cy - w), rob: cy + w, rot: cy + w,
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
    const pr = THREAD_PRESETS.find(p => p[0] === 'M48x0.75'), P = pr[3] / UNIT_SCALE;
    return { preset: pr[0], kind: 'external', profile: 'iso', d: pr[2] / UNIT_SCALE, pitch: P, depth: ISO_DEPTH * P, turns: 8, backing: 1,
      z: view ? view.cz : 0, hand: 1, clearance: 0, taperTop: true, taperBottom: true };
  }
  // ---- Parametric objects (circle, n-sided, thread) ----
  // Generated points carry their index (g), so a parameter change can be applied on top of hand edits,
  // and an outline edited in the cross-section is read back into the parameters when it still fits them.
  const tagPts = (pts) => { pts.forEach((p, i) => { p.g = i; }); return pts; };
  function genOf(n, q) {
    if (n.type === 'thread') { const t = threadProfile(q); return { pts: t.pts, runs: t.runs }; }
    return { pts: paramProfile(q), runs: [] };
  }
  function regenThread(n) { const t = threadProfile(n.params); n.pts = tagPts(t.pts); n.runs = t.runs.map(r => ({ ...r, label: n.name || 'Thread' })); n.custom = false; }
  function regenNode(n) { if (n.type === 'thread') regenThread(n); else { n.pts = tagPts(paramProfile(n.params)); n.custom = false; } }
  const bevelKey = (b) => b && (b.r > 0 || b.trim > 0) ? [b.r || 0, b.trim || 0, b.segs || 0, !!b.out].join('|') : '';
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
        f.z = r.zLast; f.turns = (r.zFirst - r.zLast) / r.pitch; f.depth = r.rOther - r.rFirst; f.d = 2 * (r.rOther - c);
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
      if (pr && !(near(pr[2] / UNIT_SCALE, f.d) && near(pr[3] / UNIT_SCALE, f.pitch))) f.preset = '';
      return f;
    }
    if (P.length !== 4 || !near(P[0].z, P[1].z) || !near(P[2].z, P[3].z) || P[2].z - P[0].z <= 1e-9) return null;
    const f = { ...q, z: P[0].z, h: P[2].z - P[0].z, rib: P[0].y, rob: P[1].y, rot: P[2].y, rit: P[3].y };
    if (f.linkIn && !near(f.rib, f.rit)) f.linkIn = false;
    if (f.linkOut && !near(f.rob, f.rot)) f.linkOut = false;
    if (P.some(p => p.y <= 1e-9 && bevelKey(p.bevel))) return null;
    const kinds = [...new Set(P.filter(p => p.y > 1e-9).map(p => bevelKey(p.bevel)))];
    if (kinds.length > 1) return null;
    if (kinds[0]) { const b = P.find(p => p.y > 1e-9).bevel; if (b.trim) return null; f.bevel = b.r; f.bevelSegs = b.segs || f.bevelSegs; f.bevelOut = !!b.out; }
    else f.bevel = 0;
    const g = paramProfile(f);
    return g.every((p, i) => near(p.y, P[i].y) && near(p.z, P[i].z)) ? f : null;
  }
  function rationalize(n) {
    if (!n || !n.params || !(n.type === 'thread' || n.type === 'circle' || n.type === 'ngon')) return;
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
  function addObject(type, view) {
    pushUndo();
    const sc = state.scene, id = newId(PREFIX[type]);
    if (type === 'thread') {
      sc.nodes[id] = { id, type, name: 'Thread ' + id.slice(1), params: threadDefaults(view) };
      regenThread(sc.nodes[id]);
      place(sc, id, insertTarget());
      state.selNodes = new Set([id]); state.sel = new Set();
      markEdited(); recalc(); return;
    }
    const params = defaultParams(view);
    sc.nodes[id] = { id, type, name: (type === 'ngon' ? 'N-sided ' : 'Circle ') + id.slice(1), params, pts: tagPts(paramProfile(params)), custom: false };
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
      : type === 'cloner' ? { id, type: 'cloner', name: 'Radial cloner ' + id.slice(1), children: [],
        params: { count: 6, radius: 0, angle: 0, spread: 360, orient: 'axial', height: zBase() } }
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
    const pat = toothPattern(b), P = b.pitch, d = b.dir, shift = (helical ? (b.hand || 0) : 0) * P * phi / (2 * Math.PI);
    const zs = d > 0 ? b.zMin : b.zMax, ze = d > 0 ? b.zMax : b.zMin, out = [{ y: toothAt(b, pat, zs - b.zFirst - shift), z: zs }], vs = [];
    const mLo = Math.floor((b.zMin - b.zFirst - shift) / P) - 1, mHi = Math.ceil((b.zMax - b.zFirst - shift) / P) + 1;
    for (let m = mLo; m <= mHi; m++) for (const e of pat) { const z = b.zFirst + m * P + e.u + shift; if (z - b.zMin > 1e-7 && b.zMax - z > 1e-7) vs.push({ y: e.r, z }); }
    vs.sort((x, y) => d * (x.z - y.z));
    return out.concat(vs, [{ y: toothAt(b, pat, ze - b.zFirst - shift), z: ze }]);
  }
  function ngonScaleAt(q, theta) {
    const n = Math.max(3, q.sides | 0), seg = 2 * Math.PI / n, scale = q.about === 'faces' ? 1 / Math.cos(Math.PI / n) : 1;
    const a = (((theta - (q.rotation || 0) * Math.PI / 180) % seg) + seg) % seg;
    return scale * Math.cos(Math.PI / n) / Math.cos(a - Math.PI / n);
  }
  function sectionOutline(n, theta) {
    if (n.type === 'ngon') { const s = ngonScaleAt(n.params, theta); return outlineOf(n.pts, []).map(p => ({ y: p.y * s, z: p.z })); }
    if (!(n.runs || []).length) return outlineOf(n.pts, n.runs);
    const out = [];
    for (const it of expandProfile(n.pts, n.runs)) { if (it.band) out.push(...bandSection(it.band, theta, state.helical)); else out.push({ y: it.y, z: it.z }); }
    return taperClip(n, out);
  }
  // Cut a polygon to one side of a line: keep the points where f(p) >= 0.
  function clipHalf(poly, f) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], fa = f(a), fb = f(b);
      if (fa >= 0) out.push(a);
      if ((fa >= 0) !== (fb >= 0)) { const t = fa / (fa - fb); out.push({ y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }); }
    }
    return out;
  }
  // A thread's outline as its lead-in tapers leave it (the cut the 3D model makes, seen in the section).
  function taperGeom(n) {
    const q = n.params, r = (n.runs || [])[0];
    if (n.type !== 'thread' || !q || !(q.taperTop || q.taperBottom) || !r || !n.pts.length) return null;
    const z0 = Math.min(r.zFirst, r.zLast), z1 = Math.max(r.zFirst, r.zLast), internal = q.kind === 'internal';
    const rRoot = internal ? Math.max(r.rFirst, r.rOther) : Math.min(r.rFirst, r.rOther), rCrest = internal ? Math.min(r.rFirst, r.rOther) : Math.max(r.rFirst, r.rOther);
    const k = Math.max(1e-6, (1 - (r.flatA || 0) - (r.flatB || 0)) / 2 * r.pitch) / Math.max(1e-6, Math.abs(rCrest - rRoot));
    const ys = n.pts.map(p => p.y), rWall = internal ? Math.max(...ys) : Math.min(...ys);
    return { q, z0, z1, internal, rCrest, rWall, k };
  }
  function taperClip(n, poly) {
    const t = taperGeom(n);
    if (!t) return poly;
    const depthIn = (p) => (t.internal ? t.rWall - p.y : p.y - t.rWall) * t.k;    // how far the cone is from the end face at p
    if (t.q.taperBottom) poly = clipHalf(poly, p => (p.z - t.z0) - depthIn(p));
    if (t.q.taperTop) poly = clipHalf(poly, p => (t.z1 - p.z) - depthIn(p));
    return poly;
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
  const NODE_TYPES = new Set(['source', 'circle', 'ngon', 'thread', 'group', 'boolean', 'cloner', 'holes']);
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
    }
    return sc.root.every(id => sc.nodes[id]);
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
        state.sel = new Set(); state.selNodes = new Set(); state.edited = true;
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
        state.edited = true; markEdited(); recalc();
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
      if (!node) continue;
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
    for (const key of pointKeys(keys)) { const h = parseKey(key); if (h.kind === 'p') (byNode[h.node] = byNode[h.node] || []).push(h.i); }
    let refused = false;
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
  const reduceMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; } };
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
  function numInput(value, set, o = {}) {
    const get = typeof value === 'function' ? value : () => value, dg = o.digits != null ? o.digits : 4;
    const show = () => { const v = get(); return v == null || v === '' || !isFinite(v) ? '' : num(v, dg); };
    const inp = el('input', { type: 'number', step: o.step || '0.01', value: show(), style: 'width:' + (o.width || 80) + 'px;box-sizing:border-box', placeholder: o.placeholder || null, title: o.title || null });
    if (o.min != null) inp.min = String(o.min);
    if (o.max != null) inp.max = String(o.max);
    inp.disabled = !!o.disabled;
    if (typeof value === 'function') inp.__get = show;
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
    const set = (k, v) => { state[k] = v; saveSettings(); recalc(); };
    return el('div', null,
      checkRow('Flip upside down', () => state.flip, v => set('flip', v)),
      el('div', null,
        numRow('Circle precision (edges)', state.precision, v => set('precision', Math.max(8, Math.min(2000, Math.round(v)))), { step: '1', min: 8, max: 2000, digits: 0, width: 64, noLive: true }),
        selectRow('Faces', state.faces, [['ngons', 'N-gons'], ['quads', 'Quads'], ['tris', 'Triangles']], v => set('faces', v)),
        selectRow('Format', state.format, [['stl', 'STL'], ['obj', 'OBJ']], v => set('format', v))),
      state.faces !== 'tris' && state.format === 'stl' ? el('div', { style: 'color:#666;font-size:11px' }, 'STL files only hold triangles; ' + (state.faces === 'ngons' ? 'n-gons' : 'quads') + ' apply to OBJ export and the wireframe.') : null);
  }

  function statusText() {
    const r = state.result;
    if (state.scene && !state.scene.root.length) return { text: 'The scene is empty — add objects with the buttons below, or use New / open….', color: '#444', ready: false };
    if (!haveInput()) return { text: 'Start a project with New / open….', color: '#444', ready: false };
    if (state.busy || !r) return { text: 'Updating…', color: '#444', ready: false };
    if (r.error) return { text: 'Error: ' + r.error.split('\n')[0], color: '#b42318', ready: false };
    const rep = r.report;
    const dims = rep.size[0].toFixed(1) + ' × ' + rep.size[1].toFixed(1) + ' ' + UNIT_LABEL;
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

  function createEditor(container) {
    const root = el('div', { class: 'aa-editor', style: 'position:absolute;inset:0;z-index:10;display:flex;flex-direction:column;background:#fff;color:#222;font:13px/1.35 sans-serif;text-align:left' });
    const bar = el('div', { style: 'padding:3px 8px;border-bottom:1px solid #ddd;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-right:36px' },
      el('b', { style: 'font-size:14px' }, 'Adapter Assembler'),
      el('button', { type: 'button', style: BTN2, onclick: () => showSplash(), title: 'Blank project, open a project file, or build an adapter between two threads' }, 'New / open…'),
      el('span', { style: 'color:#666;font-size:12px' }, 'Click points, edges or objects (Shift/Ctrl adds); drag a box to select points. Drag to move — hold Ctrl to snap (points, midpoints, grid), Shift to lock a direction. Drag a bevel (yellow) to resize it. Right-click for more. Middle/right-drag pans, scroll zooms, double-click fits.'));

    // left: cross-section
    const svg = sv('svg', { style: 'width:100%;height:100%;display:block;touch-action:none;background:#fbfbfc;user-select:none;-webkit-user-select:none' });
    const left = el('div', { style: 'flex:0 0 ' + state.paneLeft + '%;position:relative;min-width:0' }, svg);
    const coord = el('div', { style: 'position:absolute;right:30px;top:6px;font-size:11px;color:#555;background:rgba(255,255,255,.9);padding:2px 6px;border-radius:3px;pointer-events:none' });
    const legend = el('div', { style: 'position:absolute;left:70px;top:6px;font-size:11px;color:#555;background:rgba(255,255,255,.9);padding:3px 6px;border-radius:3px;pointer-events:none;line-height:1.5' });
    legend.innerHTML = 'Cross-section: x = radius / diameter →, y = height (offset from the lowest point) ↑, in ' + UNIT_LABEL + '<br>' +
      '<span style="color:#2f9e44">■ circle</span> <span style="color:#7048e8">■ n-sided</span> <span style="color:#d9480f">● thread</span> <span style="color:#e03131">▨ subtracted</span><br>' +
      'n-sided: <span style="color:#0c8599">— face-centre radius (min)</span> <span style="color:#c2255c">- - edge radius (max)</span>';
    const loading = el('div', { style: 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#666;background:#fbfbfc' }, 'Start a project with New / open…');
    const overlay = el('div', { style: 'position:absolute;inset:0;pointer-events:none;overflow:hidden' });
    // 1-D compass under the cross-section: the angle of the section around the axis (drag to turn)
    const compass1 = el('canvas', { style: 'position:absolute;left:50%;transform:translateX(-50%);bottom:' + (44 + 4) + 'px;width:300px;height:26px;cursor:ew-resize;touch-action:none;z-index:2;border-radius:4px;box-shadow:0 1px 4px rgba(0,0,0,.18)', title: 'Section angle: drag to turn the part (the 3D view turns with it)' });
    left.append(overlay, coord, legend, loading, compass1);

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
    const toggles3d = el('div', { style: 'position:absolute;left:8px;top:6px;font-size:11px;color:#ddd;display:flex;gap:10px;flex-wrap:wrap;right:90px' },
      el('label', { title: 'Cut planes: drag the round handles on the coloured axes (double-click a handle to remove its cut)' }, 'cuts ', cutModeSel), cutReset,
      el('label', { style: 'cursor:pointer' }, wireBox, ' wireframe'),
      el('label', { style: 'cursor:pointer', title: 'Ambient occlusion: darkens creases and corners' }, ssaoBox, ' SSAO'),
      el('label', { style: 'cursor:pointer', title: 'Orthographic view (no perspective): parallel lines stay parallel' }, orthoBox, ' orthographic'),
      el('label', { style: 'cursor:pointer', title: 'Turn the part upside down (also in the exported file)' }, flipBox, ' flip upside down'));
    const hint3d = el('div', { style: 'position:absolute;left:8px;bottom:5px;font-size:10px;color:#9aa;pointer-events:none' }, 'drag: turn the part · drag a handle: cut (X red, Y green up, Z blue; snaps to the origin, Alt: no snap) · Ctrl/right-drag: pan · wheel: zoom · middle-click: reset');
    const view3d = el('div', { style: 'flex:1;position:relative;min-height:0;min-width:0' }, canvas, busyTag, toggles3d, hint3d);
    // minimizing panes: a pane shrinks to a bar; click the bar to bring it back
    root.append(el('style', null, '.aa-min>:not(.aa-minbar){display:none!important}.aa-minbar{display:none}.aa-min>.aa-minbar{display:flex!important}'));
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
      const head = el('div', { style: 'flex:0 0 auto;display:flex;align-items:center;gap:5px;height:24px;box-sizing:border-box;padding:0 ' + (i ? 4 : 28) + 'px 0 6px;background:#f1f3f5;border-bottom:1px solid #dee2e6;font:700 12px sans-serif;color:#343a40;cursor:pointer;user-select:none', title: 'Fold / unfold' }, arrow, el('span', { style: 'flex:0 0 auto' }, title), extra, tools);
      const body = el('div', { style: 'flex:1 1 auto;overflow:auto;padding:4px 6px;min-height:0' });
      const wrap = el('div', { style: 'display:flex;flex-direction:column;min-height:0;overflow:hidden;border-bottom:1px solid #dee2e6' }, head, body);
      head.addEventListener('click', () => { sp[k].min = !sp[k].min; saveSettings(); applyPanels(true); });
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
    // footer: saved models (a list that opens upward) and saving
    const footer = el('div', { style: 'flex:0 0 auto;display:flex;align-items:center;gap:3px;height:26px;box-sizing:border-box;padding:0 6px;border-top:1px solid #dee2e6;background:#f1f3f5;font-size:11px;min-width:0' });
    const libPop = el('div', { style: 'position:absolute;left:4px;right:4px;bottom:28px;z-index:7;display:none;max-height:60%;overflow:auto;background:#fff;border:1px solid #ced4da;border-radius:5px;box-shadow:0 -2px 12px rgba(0,0,0,.15);padding:4px 6px;font-size:12px' });
    let libOpen = false;
    const toggleLib = (v) => { libOpen = v == null ? !libOpen : v; renderSide(); };
    document.addEventListener('pointerdown', (e) => { if (libOpen && !libPop.contains(e.target) && !footer.contains(e.target)) toggleLib(false); }, true);
    rightBar.append(footer, libPop);
    rightBar.append(minBtn('minSide'), minBar('minSide', 'Side bar', false));
    rightBar.append(el('style', null, '.aa-icononly .aa-hl{display:none}'));
    // header labels hide (icons stay) when a header has no room for them
    function fitHead(h, keep) {
      h.classList.remove('aa-icononly');
      const kids = [...h.children].filter(c => c.tagName !== 'STYLE');
      const need = kids.reduce((s, c) => s + (c === keep ? Math.min(c.scrollWidth, 70) : c.scrollWidth), 0) + 5 * kids.length;
      const cs = getComputedStyle(h), room = h.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      if (need > room) h.classList.add('aa-icononly');
    }
    function fitHeads() { for (const k in panels) fitHead(panels[k].head, panels[k].extra); fitHead(footer, footer.querySelector('.aa-libmsg')); }
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
      view = null; hideSplash(); markEdited(); recalc();
    }
    function threadPicker(title, init) {
      // gender, standard (or custom diameter and pitch), thread length
      const g = selectInput(init.male ? 'male' : 'female', [['male', 'male (external)'], ['female', 'female (internal)']], () => {});
      const std = el('select', { style: 'font-size:12px;max-width:260px' }, el('option', { value: '' }, 'custom'),
        ...THREAD_GROUPS.map(([gr, list]) => el('optgroup', { label: gr }, ...list.map(([k, label]) => el('option', { value: k }, label)))));
      const dIn = el('input', { type: 'number', step: '0.1', min: '0.5', value: String(init.d), style: 'width:80px' });
      const pIn = el('input', { type: 'number', step: '0.05', min: '0.1', value: String(init.pitch), style: 'width:80px' });
      const lIn = el('input', { type: 'number', step: '0.5', min: '0', placeholder: 'auto', style: 'width:80px' });
      const pr0 = THREAD_PRESETS.find(p => Math.abs(p[2] - init.d) < 1e-6 && Math.abs(p[3] - init.pitch) < 1e-6); std.value = pr0 ? pr0[0] : '';
      std.addEventListener('change', () => { const p = THREAD_PRESETS.find(x => x[0] === std.value); if (p) { dIn.value = +p[2].toFixed(4); pIn.value = +p[3].toFixed(4); } });
      const custom = () => { std.value = THREAD_PRESETS.find(p => Math.abs(p[2] - +dIn.value) < 1e-3 && Math.abs(p[3] - +pIn.value) < 1e-4) ? THREAD_PRESETS.find(p => Math.abs(p[2] - +dIn.value) < 1e-3 && Math.abs(p[3] - +pIn.value) < 1e-4)[0] : ''; };
      dIn.addEventListener('input', custom); pIn.addEventListener('input', custom);
      return { el: el('div', null, el('div', { style: 'font-weight:700;margin:4px 0' }, title),
          pgrid(1, ['Gender', g], ['Standard', std], ['Major Ø (mm)', dIn], ['Pitch (mm)', pIn], ['Thread length (mm)', lIn])),
        get: () => ({ male: g.value === 'male', d: +dIn.value, pitch: +pIn.value, len: +lIn.value || 0 }) };
    }
    function showSplash() {
      splash.textContent = '';
      const card = (title, ...kids) => el('div', { style: 'background:#fff;border:1px solid #dee2e6;border-radius:6px;padding:10px 12px;box-shadow:0 1px 4px rgba(0,0,0,.08);min-width:240px;flex:1 1 260px;max-width:640px' },
        el('div', { style: 'font-weight:700;font-size:15px;margin-bottom:4px' }, title), ...kids);
      const lib = libLoad();
      // adapter assembler
      const A = threadPicker('Thread A (bottom)', { male: true, d: 48, pitch: 0.75 }), B = threadPicker('Thread B (top)', { male: false, d: 42, pitch: 0.75 });
      const lenIn = el('input', { type: 'number', step: '0.5', min: '2', value: '20', style: 'width:80px' });
      const wallIn = el('input', { type: 'number', step: '0.1', min: '0.4', value: '2.5', style: 'width:80px' });
      const clrIn = el('input', { type: 'number', step: '0.05', value: '0', style: 'width:80px' });
      const steepBox = el('input', { type: 'checkbox' }); steepBox.checked = true;
      const angIn = el('input', { type: 'number', step: '5', min: '20', max: '85', value: '60', style: 'width:60px' });
      const out = el('div', { style: 'color:#9a6700;margin-top:6px' });
      const build = () => {
        const a = A.get(), b = B.get(), H = +lenIn.value;
        if (!(a.d > 0 && a.pitch > 0 && b.d > 0 && b.pitch > 0 && H > 0)) { out.textContent = 'Enter a diameter and pitch for both threads, and a total length.'; return; }
        const r = buildAdapter({ a, b, length: H, wall: +wallIn.value || 2.5, clearance: +clrIn.value || 0, steep: steepBox.checked, angle: +angIn.value || 60 });
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
          card('Blank project', el('div', { style: 'color:#666;margin-bottom:8px' }, 'An empty scene: add circles, n-sided objects, threads, cloners and booleans.'),
            el('button', { type: 'button', style: BTN, onclick: () => openScene({ nodes: {}, root: [], seq: 1 }) }, 'Start blank')),
          card('Open a project', el('div', { style: 'color:#666;margin-bottom:8px' }, 'A scene or saved models exported as JSON from this tool.'),
            el('button', { type: 'button', style: BTN, onclick: () => { W.__aaOnProjectLoaded = () => { view = null; hideSplash(); }; pickJsonFile(); } }, 'Open JSON file…'),
            lib.length ? el('div', { style: 'margin-top:10px' }, el('div', { style: 'font-weight:700;margin-bottom:4px' }, 'My saved models'),
              ...lib.map(entry => el('div', { style: 'display:flex;gap:6px;align-items:center;margin:2px 0' },
                el('button', { type: 'button', style: BTN2, onclick: () => {
                  const sc = { nodes: {}, root: [], seq: 1 }, sub = remapSubtree(entry.model, (n) => n.type.charAt(0) + (++sc.seq));
                  Object.assign(sc.nodes, sub.nodes); sc.root.push(sub.rootId); openScene(sc, 'Opened "' + entry.name + '".');
                } }, 'Open'), el('span', null, entry.name)))) : null),
          card('Adapter assembler',
            el('div', { style: 'color:#666;margin-bottom:6px' }, 'Builds an adapter from thread A (bottom) to thread B (top), as editable rings and threads with lead-in tapers at the ends.'),
            el('div', { style: 'display:flex;gap:18px;flex-wrap:wrap' }, A.el, B.el),
            pgrid(2, ['Total length (mm)', lenIn], ['Wall (mm)', wallIn], ['Fit clearance (mm)', clrIn], GBR,
              ['Avoid right angles', el('label', { style: 'display:inline-flex;gap:4px;align-items:center' }, steepBox, 'steep walls, at least'), angIn, '° from horizontal']),
            el('button', { type: 'button', style: BTN + ';margin-top:6px', onclick: build }, 'Create adapter'), out)));
      splash.style.display = 'block';
    }
    const menu = el('div', { style: 'position:fixed;z-index:2147483647;display:none;transform-origin:top left;background:#fff;border:1px solid #bbb;border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,.25);padding:6px;font:12px/1.4 sans-serif;color:#222;min-width:230px;max-width:320px' });
    root.append(menu);
    container.append(root);

    let view = null, drag = null, hoverEdge = null, previewMarks = [];

    // ---- keyboard ----
    const onKey = (e) => {
      if (!root.isConnected) return;
      const ae = document.activeElement || {}, typing = /SELECT|TEXTAREA/.test(ae.tagName || '') || (ae.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|range|color)$/.test(ae.type));
      if (typing) { e.stopPropagation(); return; }
      if (e.key === 'Escape') {
        if (splash.style.display !== 'none' && state.scene) { hideSplash(); e.stopPropagation(); e.preventDefault(); return; }
        if (menu.style.display !== 'none') { hideMenu(); e.stopPropagation(); e.preventDefault(); return; }
        if (state.sel.size || state.selNodes.size) { state.sel = new Set(); state.selNodes = new Set(); renderAll(); e.stopPropagation(); e.preventDefault(); }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { redo(); e.preventDefault(); e.stopPropagation(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { undo(); e.preventDefault(); e.stopPropagation(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && state.selNodes.size) { duplicateNodes(topSelected(state.scene)); e.preventDefault(); e.stopPropagation(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (state.sel.size) { pushUndo(); deletePoints([...state.sel]); state.sel = new Set(); markEdited(); recalc(); }
        else if (state.selNodes.size) deleteNodes(topSelected(state.scene));
        e.preventDefault(); e.stopPropagation(); return;
      }
      const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
      if (arrows[e.key] && (state.sel.size || state.selNodes.size)) {
        const step = (e.shiftKey ? 1 : 0.1) / UNIT_SCALE, [ay, az] = arrows[e.key];
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
    const size = () => { const r = svg.getBoundingClientRect(); return { w: r.width || 800, h: r.height || 600 }; };
    function fit() {
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
      view = { cy: (y0 + y1) / 2, cz: (z0 + z1) / 2, s: Math.min(w / ((y1 - y0) * 1.2 || 1), h / ((z1 - z0) * 1.2 || 1)) };
    }
    const toScreen = (y, z) => { const { w, h } = size(); return [w / 2 + (y - view.cy) * view.s, h / 2 - (z - view.cz) * view.s]; };
    const toWorld = (sx, sy) => { const { w, h } = size(); return [view.cy + (sx - w / 2) / view.s, view.cz - (sy - h / 2) / view.s]; };
    const local = (e) => { const r = svg.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const pathOf = (poly) => poly.map((p, i) => (i ? 'L' : 'M') + toScreen(p.y, p.z).map(v => v.toFixed(1)).join(' ')).join(' ') + 'Z';

    function handlesOf(id, sc = state.scene) {
      const n = sc.nodes[id], out = [], xf = xfOf(sc, id);
      n.pts.forEach((p, i) => { if (!inRunIndex(n, i)) { const q = xf.fwd(p); out.push({ key: id + '|p|' + i, y: q.y, z: q.z, run: false, bevel: !!(p.bevel && (p.bevel.r > 0 || p.bevel.trim > 0)) }); } });
      (n.runs || []).forEach((r, ri) => {
        // helical teeth move along the axis as the view turns: their handles follow the section at the view angle
        const s = xf.id ? runShift(r) : 0, zMin = Math.min(r.zFirst, r.zLast), zMax = Math.max(r.zFirst, r.zLast);
        runVertices(r).forEach((v, k) => {
          let p = v;
          if (s && v.role === 'mid') { p = { y: v.y, z: v.z + s }; if (!(p.z - zMin > 1e-7 && zMax - p.z > 1e-7)) return; }
          const q = xf.fwd(p); out.push({ key: id + '|r|' + ri + '|' + k, y: q.y, z: q.z, run: true });
        });
      });
      return out;
    }
    // how far the teeth of a helical run sit from their drawn place in the section at the view angle (within ± half a pitch)
    function runShift(r) {
      if (!state.helical || !r.hand || !(r.pitch > 0)) return 0;
      const P = r.pitch, s = r.hand * P * (state.viewAngle * Math.PI / 180) / (2 * Math.PI);
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
      for (const id of order) for (const e of edgesOf(id)) {
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
    function frontOrder() {
      const all = leafOrder(state.scene), sel = all.filter(id => selectedAncestorOf(id) || [...state.sel].some(k => parseKey(k).node === id));
      return all.filter(id => !sel.includes(id)).concat(sel);
    }
    function nodeAt(y, z) {
      const sc = state.scene, order = frontOrder(), th = viewTheta();
      for (let i = order.length - 1; i >= 0; i--) {
        const id = order[i], n = sc.nodes[id], xf = xfOf(sc, id);
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
      if (!isFinite(z0)) { z0 = zBase(); z1 = z0 + 10 / UNIT_SCALE; }
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
    function grid(g, base) {
      const { w, h } = size();
      const [ya, za] = toWorld(0, h), [yb, zb] = toWorld(w, 0);
      const st = gridStep();
      const lab = (x, y, text, o = {}) => { const t = sv('text', { x, y, 'font-size': 10, fill: o.fill || '#868e96', 'text-anchor': o.anchor || 'start' }); t.textContent = text; g.append(t); };
      for (let y = Math.ceil(ya / st) * st; y <= yb; y += st) {
        const [x] = toScreen(y, 0);
        g.append(sv('line', { x1: x, y1: 0, x2: x, y2: h - AX_B, stroke: Math.abs(y) < st / 2 ? '#adb5bd' : '#e9ecef' }));
      }
      for (let zr = Math.ceil((za - base) / st) * st; zr <= zb - base; zr += st) {
        const [, y] = toScreen(0, base + zr);
        g.append(sv('line', { x1: AX_L, y1: y, x2: w, y2: y, stroke: Math.abs(zr) < st / 2 ? '#adb5bd' : '#e9ecef' }));
      }
      // axis strips
      g.append(sv('rect', { x: 0, y: h - AX_B, width: w, height: AX_B, fill: 'rgba(248,249,250,.95)', stroke: '#dee2e6' }));
      g.append(sv('rect', { x: 0, y: 0, width: AX_L, height: h - AX_B, fill: 'rgba(248,249,250,.95)', stroke: '#dee2e6' }));
      for (let y = Math.ceil(ya / st) * st; y <= yb; y += st) {
        const [x] = toScreen(y, 0);
        if (x < AX_L) continue;
        g.append(sv('line', { x1: x, y1: h - AX_B, x2: x, y2: h - AX_B + 4, stroke: '#adb5bd' }));
        lab(x, h - 4, num(mm(y), 2) + ' ' + UNIT_LABEL, { anchor: 'middle' });                 // radius
        lab(x, h - 17, 'Ø' + num(mm(2 * y), 2) + ' ' + UNIT_LABEL, { anchor: 'middle', fill: '#adb5bd' });  // diameter
      }
      for (let zr = Math.ceil((za - base) / st) * st; zr <= zb - base; zr += st) {
        const [, y] = toScreen(0, base + zr);
        if (y > h - AX_B) continue;
        g.append(sv('line', { x1: AX_L - 4, y1: y, x2: AX_L, y2: y, stroke: '#adb5bd' }));
        lab(AX_L - 6, y + 3, num(zr * UNIT_SCALE, 2) + ' ' + UNIT_LABEL, { anchor: 'end' });
      }
      const t1 = sv('text', { x: AX_L + 4, y: h - AX_B - 4, 'font-size': 10, fill: '#adb5bd' }); t1.textContent = 'x: radius / Ø →'; g.append(t1);
      const t2 = sv('text', { x: 4, y: 12, 'font-size': 10, fill: '#adb5bd' }); t2.textContent = 'y: height ↑'; g.append(t2);
    }
    // Ticks on both axes for the mouse position, or for the point being dragged.
    let cursorW = null;
    function drawCursor() {
      const old = svg.querySelector('#aa-cursor'); if (old) old.remove();
      if (!state.scene || !view) return;
      const P = drag && drag.cur ? drag.cur : cursorW;
      if (!P) return;
      const { w, h } = size(), base = drag && drag.base != null ? drag.base : sceneBase, [x, y] = toScreen(P.y, P.z);
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
    const COLORS = { source: '#1f6feb', circle: '#2f9e44', ngon: '#7048e8', thread: '#e8590c', group: '#495057', boolean: '#495057', cloner: '#495057', holes: '#c92a2a' };
    const viewTheta = () => state.viewAngle * Math.PI / 180;
    function drawSection() {
      svg.textContent = '';
      if (!state.scene) return;
      if (!view) fit();
      const defs = sv('defs');
      const pat = sv('pattern', { id: 'aa-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
      pat.append(sv('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: 'rgba(224,49,49,.45)', 'stroke-width': 2 }));
      defs.append(pat); svg.append(defs);
      const g = sv('g'); svg.append(g);
      sceneBase = drag && drag.base != null ? drag.base : zBase();
      grid(g, sceneBase);
      // selected objects are drawn last (on top), so their points and edges can be picked over others
      const order = frontOrder();
      for (const id of order) {
        // the section at the view angle (copies in radial cloners are shown as their first copy)
        const n = state.scene.nodes[id], xf = xfOf(state.scene, id), local = outlineOf(n.pts, n.runs), poly = xf.id ? sectionOutline(n, viewTheta()) : taperClip(n, local).map(xf.fwd), role = roleOf(state.scene, id);
        // a cloned object: show the other half of its section faintly
        if (!xf.id) g.append(sv('path', { d: pathOf(local.map(xf.mir)), fill: 'none', stroke: COLORS[n.type] || '#1f6feb', 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0.6 }));
        const col = COLORS[n.type] || '#1f6feb', crossing = polygonSelfIntersects(local), selected = selectedAncestorOf(id);
        const fill = role === 'negative' ? 'url(#aa-hatch)' : crossing ? 'rgba(220,38,38,.18)' : col + (role === 'intersect' ? '18' : '26');
        g.append(sv('path', { d: pathOf(poly), fill, stroke: crossing || role === 'negative' ? '#e03131' : col, 'stroke-width': selected ? 2.8 : 1.4,
          'stroke-dasharray': role === 'negative' ? '6 3' : 'none', 'stroke-linejoin': 'round' }));
        if (n.type === 'ngon') {
          // the range the section moves through as the view turns: face-centre radius (min) and edge radius (max)
          const k = Math.cos(Math.PI / Math.max(3, n.params.sides | 0)), faces = n.params.about === 'faces';
          const minK = faces ? 1 : k, maxK = faces ? 1 / k : 1;
          g.append(sv('path', { d: pathOf(local.map(p => xf.fwd({ y: p.y * minK, z: p.z }))), fill: 'none', stroke: '#0c8599', 'stroke-width': 1.2, 'pointer-events': 'none' }));
          g.append(sv('path', { d: pathOf(local.map(p => xf.fwd({ y: p.y * maxK, z: p.z }))), fill: 'none', stroke: '#c2255c', 'stroke-width': 1.2, 'stroke-dasharray': '6 4', 'pointer-events': 'none' }));
        }
      }
      // bevels: grab one to make it bigger or smaller
      for (const id of order) {
        const n = state.scene.nodes[id], arcs = new Map(), xf = xfOf(state.scene, id);
        for (const it of expandProfile(n.pts, n.runs)) if (!it.band && it.corner != null) { if (!arcs.has(it.corner)) arcs.set(it.corner, []); arcs.get(it.corner).push(xf.fwd(it)); }
        for (const [i, arc] of arcs) {
          if (arc.length < 2) continue;
          const d = arc.map((p, k) => (k ? 'L' : 'M') + toScreen(p.y, p.z).map(v => v.toFixed(1)).join(' ')).join(' ');
          const hot = drag && drag.type === 'bevel' && drag.node === id && drag.i === i;
          g.append(sv('path', { d, fill: 'none', stroke: hot ? '#f08c00' : 'rgba(250,176,5,.55)', 'stroke-width': hot ? 3 : 2, 'stroke-linecap': 'round', 'pointer-events': 'none' }));
          const hit = sv('path', { d, fill: 'none', stroke: 'transparent', 'stroke-width': 12, style: 'cursor:nwse-resize' });
          hit.__bevel = { node: id, i };
          const tip = sv('title'); tip.textContent = 'Drag to change this bevel'; hit.append(tip);
          g.append(hit);
        }
      }
      // radial cloners in the selection: the copies' axis, with a handle for its distance from the main axis
      for (const id of Object.keys(state.scene.nodes)) {
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
      // thread lead-in tapers: the cone that trims the teeth at the ends
      for (const id of order) {
        const n = state.scene.nodes[id], t = taperGeom(n);
        if (!t) continue;
        const xf = xfOf(state.scene, id), dz = Math.abs(t.rCrest - t.rWall) * t.k, segs = [];
        if (t.q.taperBottom) segs.push([{ y: t.rWall, z: t.z0 }, { y: t.rCrest, z: t.z0 + dz }]);
        if (t.q.taperTop) segs.push([{ y: t.rWall, z: t.z1 }, { y: t.rCrest, z: t.z1 - dz }]);
        for (const [a, b] of segs) {
          const A = xf.fwd(a), B = xf.fwd(b), [x1, y1] = toScreen(A.y, A.z), [x2, y2] = toScreen(B.y, B.z);
          g.append(sv('line', { x1, y1, x2, y2, stroke: '#c92a2a', 'stroke-width': 1.6, 'stroke-dasharray': '4 2', 'pointer-events': 'none' }));
        }
      }
      // selected / hovered edges
      for (const id of order) for (const e of edgesOf(id)) {
        const on = state.sel.has(e.key), hov = hoverEdge === e.key;
        if (!on && !hov) continue;
        const [x1, y1] = toScreen(e.a.y, e.a.z), [x2, y2] = toScreen(e.b.y, e.b.z);
        g.append(sv('line', { x1, y1, x2, y2, stroke: on ? '#e03131' : 'rgba(224,49,49,.45)', 'stroke-width': on ? 3.5 : 3, 'stroke-linecap': 'round' }));
      }
      // handles that would cover each other are fanned out around their common point (with a thin leader), so each can be grabbed
      const hds = [];
      for (const id of order) for (const hd of handlesOf(id)) { const [x, y] = toScreen(hd.y, hd.z); hds.push({ id, hd, x, y, dx: 0, dy: 0 }); }
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
          c.__key = hd.key;
          const tip = sv('title'); tip.textContent = (n.name || id) + ': r ' + fmt(hd.y, 3) + ', z ' + fmt(hd.z, 3) + ' ' + UNIT_LABEL + (hd.bevel ? ' (bevelled)' : ''); c.append(tip);
          svg.append(c);
        }
      }
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
        const ang = Math.atan2(b.z - a.z, b.y - a.y) * 180 / Math.PI;
        const [x, y] = toScreen((a.y + b.y) / 2, (a.z + b.z) / 2);
        label(svg, x + 8, y + 14, ['length ' + num(mm(L), 3) + ' ' + UNIT_LABEL + ' · angle ' + num(((ang % 180) + 180) % 180, 2) + '°', 'Δx (radius) ' + num(mm(b.y - a.y), 3) + ' · Δy (height) ' + num(mm(b.z - a.z), 3) + ' ' + UNIT_LABEL], { border: '#ffa8a8' });
      }
      // sample positions of points that would be inserted (menu hover)
      for (const p of previewMarks) {
        const [x, y] = toScreen(p.y, p.z);
        svg.append(sv('circle', { cx: x, cy: y, r: 5, fill: 'rgba(250,176,5,.35)', stroke: '#f08c00', 'stroke-width': 1.5, 'stroke-dasharray': '2 2', 'pointer-events': 'none' }));
      }
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
      if (drag && drag.type === 'box') {
        const x0 = Math.min(drag.sx, drag.cx), y0 = Math.min(drag.sy, drag.cy);
        svg.append(sv('rect', { x: x0, y: y0, width: Math.abs(drag.cx - drag.sx), height: Math.abs(drag.cy - drag.sy), fill: 'rgba(31,111,235,.08)', stroke: '#1f6feb', 'stroke-dasharray': '4 3' }));
      }
      if (drag && drag.type === 'bevel' && drag.label) label(svg, drag.labelAt[0] + 12, drag.labelAt[1] - 10, [drag.label], { border: '#ffc078', bg: 'rgba(255,249,219,.95)' });
      drawCursor();
      syncThreadBoxes();
      renderSelBox();
    }

    // ---- thread data boxes with editable values (live) ----
    const threadBoxes = new Map();
    const INP = 'width:66px;font-size:11px;padding:1px 3px';
    function runOf(nodeId, ri) { const n = state.scene && state.scene.nodes[nodeId]; return n && n.runs && n.runs[ri] ? { n, r: n.runs[ri] } : null; }
    function threadValues(r, base) {
      const rMin = Math.min(r.rFirst, r.rOther), rMax = Math.max(r.rFirst, r.rOther), depth = rMax - rMin, len = Math.abs(r.zLast - r.zFirst);
      const flank = Math.max(0, (1 - (r.flatA || 0) - (r.flatB || 0)) / 2) * r.pitch;
      return { pitch: mm(r.pitch), turns: len / r.pitch, depth: mm(depth), angle: 2 * Math.atan2(flank, depth) * 180 / Math.PI,
        dmin: mm(2 * rMin), dmax: mm(2 * rMax), len: mm(len), from: hDisp(Math.min(r.zFirst, r.zLast), base), to: hDisp(Math.max(r.zFirst, r.zLast), base) };
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
        case 'from': { const z = base + inch; if (r[highKey] - z >= r.pitch) r[lowKey] = z; break; }
        case 'to': { const z = base + inch; if (z - r[lowKey] >= r.pitch) r[highKey] = z; break; }
      }
    }
    function makeThreadBox(nodeId, ri) {
      const box = el('div', { style: 'position:absolute;pointer-events:auto;background:rgba(255,249,219,.96);border:1px solid #ffc078;border-radius:5px;padding:4px 6px;font:11px/1.35 sans-serif;color:#343a40;box-shadow:0 1px 4px rgba(0,0,0,.12)' });
      const title = el('div', { style: 'font-weight:700;cursor:pointer;user-select:none;display:flex;gap:6px;align-items:center' });
      const body = el('div', { style: 'display:grid;grid-template-columns:auto auto auto auto;gap:2px 6px;align-items:center;margin-top:3px' });
      const hand = el('select', { style: 'font-size:11px' }, el('option', { value: '1' }, 'right-hand'), el('option', { value: '-1' }, 'left-hand'));
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
      const fields = [['pitch', 'pitch', UNIT_LABEL], ['turns', 'turns', ''], ['depth', 'thread depth (x)', UNIT_LABEL], ['angle', 'V angle', '°'],
        ['dmin', 'minor Ø', UNIT_LABEL], ['dmax', 'major Ø', UNIT_LABEL], ['len', 'length (y)', UNIT_LABEL], ['from', 'starts at y', UNIT_LABEL], ['to', 'ends at y', UNIT_LABEL]];
      for (const [f, lab, unit] of fields) {
        const inp = el('input', { type: 'number', step: f === 'turns' ? '0.25' : f === 'angle' ? '0.5' : '0.01', style: INP });
        inp.addEventListener('focus', () => { inp.__fresh = true; });
        const apply = (live) => {
          const v = parseFloat(inp.value), o = runOf(nodeId, ri);
          if (!isFinite(v) || !o) return;
          if (inp.__fresh !== false) pushUndo();
          inp.__fresh = false;
          setThreadValue(o.r, o.r.kind, f, v, zBase());
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
          inp.value = num(vals[f], f === 'turns' ? 3 : f === 'angle' ? 2 : 4);
        }
      };
      return tb;
    }
    function syncThreadBoxes() {
      const seen = new Set(), { w, h } = size();
      if (state.scene && state.threadCallouts) for (const id of leafOrder(state.scene)) {
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
    const selBox = el('div', { style: 'position:absolute;right:8px;top:30px;z-index:3;pointer-events:auto;background:rgba(255,255,255,.97);border:1px solid #ced4da;border-radius:6px;padding:6px 8px;font:11px/1.4 sans-serif;color:#343a40;box-shadow:0 1px 6px rgba(0,0,0,.15);width:max-content;max-width:calc(100% - 90px);box-sizing:border-box;display:none' });
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
      if (!t.pts.length && !t.runs.length) return;
      pushUndo();
      if (kind === 'translate') {
        const dy = tf.dx / UNIT_SCALE, dz = tf.dy / UNIT_SCALE;
        if (state.sel.size) moveKeysView(state.scene, [...state.sel], dy, dz); else t.nodes.forEach(n => moveNodeView(state.scene, n.id, dy, dz));
      } else {
        const P = pivotOf(t), a = tf.angle * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
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
      if (!state.scene || (!state.sel.size && !state.selNodes.size)) {
        if (selBox.style.display !== 'none' && selBox.animate && !reduceMotion()) {
          const a = selBox.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-6px)' }], { duration: 120, easing: 'ease-in' });
          a.onfinish = () => { if (!state.sel.size && !state.selNodes.size) selBox.style.display = 'none'; };
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
      const objs = topSelected(state.scene);
      const what = keys.length ? pk.length + ' point' + (pk.length === 1 ? '' : 's') + (keys.some(k => parseKey(k).kind === 'e') ? ' (with edges)' : '')
        : objs.length + ' object' + (objs.length === 1 ? '' : 's');
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
      const collapsed = !!state.selBoxCollapsed;
      const toggle = el('button', { type: 'button', title: collapsed ? 'Expand' : 'Collapse', style: 'border:0;background:none;cursor:pointer;font-size:12px;padding:0 2px;color:#495057' }, collapsed ? '▸' : '▾');
      toggle.addEventListener('click', () => {
        state.selBoxCollapsed = !state.selBoxCollapsed; saveSettings();
        const w0 = selBox.offsetWidth, h0 = selBox.offsetHeight;
        buildSelBox();
        const w1 = selBox.offsetWidth, h1 = selBox.offsetHeight;
        if (selBox.animate && !reduceMotion()) selBox.animate([{ width: w0 + 'px', height: h0 + 'px', overflow: 'hidden' }, { width: w1 + 'px', height: h1 + 'px', overflow: 'hidden' }],
          { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' });
      });
      selBox.textContent = '';
      selBox.append(el('div', { style: 'font-weight:700;display:flex;align-items:center;gap:4px;cursor:default' + (collapsed ? '' : ';margin-bottom:5px') }, toggle, 'Selection — ' + what));
      if (collapsed) return;
      if (pk.length === 1 && parseKey(pk[0]).kind === 'p') {
        const h = parseKey(pk[0]), p = xfOf(state.scene, h.node).fwd(state.scene.nodes[h.node].pts[h.i]);
        const live = (val, set) => { const i = el('input', { type: 'number', step: '0.01', value: num(val, 4), style: 'width:64px;font-size:11px;box-sizing:border-box' });
          i.addEventListener('focus', () => { i.__fresh = true; });
          const go = (liveInput) => { const v = parseFloat(i.value); if (!isFinite(v)) return; if (i.__fresh !== false) pushUndo(); i.__fresh = false; set(v); markEdited(); state.liveInput = liveInput; try { recalc(); } finally { state.liveInput = false; } };
          i.addEventListener('input', () => go(true)); i.addEventListener('change', () => { go(false); i.__fresh = false; }); return i; };
        const cur = () => xfOf(state.scene, h.node).fwd(state.scene.nodes[h.node].pts[h.i]);
        add('Point', ['x r', live(mm(p.y), v => moveKeysView(state.scene, pk, v / UNIT_SCALE - cur().y, 0)), 'Ø', live(mm(2 * p.y), v => moveKeysView(state.scene, pk, v / 2 / UNIT_SCALE - cur().y, 0)), UNIT_LABEL], null);
        add('', ['y', live(hDisp(p.z, base), v => moveKeysView(state.scene, pk, 0, v / UNIT_SCALE + base - cur().z)), null, null, UNIT_LABEL], null);
      }
      const inp = (key, o = {}) => {
        const i = el('input', { type: 'number', step: o.step || '0.1', value: num(tf[key], 4), style: 'width:64px;font-size:11px;box-sizing:border-box', title: o.title || null });
        i.addEventListener('change', () => { const v = parseFloat(i.value); if (isFinite(v)) tf[key] = v; else i.value = num(tf[key], 4); });
        return i;
      };
      add('Translate', ['Δx', inp('dx', { title: 'radius change (' + UNIT_LABEL + ')' }), 'Δy', inp('dy', { title: 'height change (' + UNIT_LABEL + ')' }), UNIT_LABEL], 'translate');
      const link = el('input', { type: 'checkbox' }); link.checked = tf.linkScale;
      link.addEventListener('change', () => { tf.linkScale = link.checked; buildSelBox(); });
      const uni = el('label', { style: 'cursor:pointer;display:inline-flex;gap:3px;align-items:center;white-space:nowrap' }, link, 'uniform');
      add('Scale', tf.linkScale ? ['×', inp('sx', { step: '0.05' }), null, null, uni] : ['× x', inp('sx', { step: '0.05' }), '× y', inp('sy', { step: '0.05' }), uni], 'scale');
      add('Rotate', ['°', inp('angle', { step: '1', title: 'degrees, counter-clockwise' }), null, null, 'counter-clockwise'], 'rotate');
      const piv = el('select', { style: 'font-size:11px;max-width:100%' }, el('option', { value: 'centre' }, 'selection centre'), el('option', { value: 'origin' }, 'axis at the lowest point'));
      piv.value = tf.pivot; piv.addEventListener('change', () => { tf.pivot = piv.value; });
      add('About', { span: [piv] }, null);
      selBox.append(grid, el('div', { style: 'color:#888;margin-top:5px;width:0;min-width:100%' }, 'x = radius / diameter, y = height. Threads move with their centre but keep their shape. Arrow keys nudge 0.1 ' + UNIT_LABEL + ' (Shift: 1).'));
    }

    // ---- pointer interaction ----
    svg.addEventListener('contextmenu', (e) => e.preventDefault());
    svg.addEventListener('pointerdown', (e) => {
      if (!state.scene) return;
      hideMenu();
      const [sx, sy] = local(e), [wy, wz] = toWorld(sx, sy);
      const key = e.target.__key || (!e.target.__key ? edgeAt(sx, sy) : null);
      const add = e.shiftKey || e.ctrlKey || e.metaKey;
      if (e.button === 2) {
        if (key) { if (!state.sel.has(key)) state.sel = new Set([key]); drawSection(); showPointMenu(e.clientX, e.clientY); return; }
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
        const k = bv.trim ? ch : (bv.segs | 0) <= 1 ? ch * ch / sh : bv.out ? 1 / sh - 1 : Math.cos(2 * half) / sh + 1;
        if (bl > 1e-9 && k > 1e-9) {
          drag = { type: 'bevel', node: id, i, P: { y: P.y, z: P.z }, bis: [(u1[0] + u2[0]) / bl, (u1[1] + u2[1]) / bl], k, snap: clone(state.scene), moved: false };
          state.sel = new Set([id + '|p|' + i]); state.selNodes = new Set([id]);
          drawSection(); return;
        }
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
      } else {
        const hit = nodeAt(wy, wz);
        if (hit && selectedAncestorOf(hit)) {
          // drag every selected object (and everything inside selected groups/booleans)
          const snapScene = clone(state.scene), leaves = leavesUnder(snapScene, topSelected(snapScene));
          let prim = null, pd = Infinity;
          for (const hd of handlesOf(hit, snapScene)) { const d = Math.hypot(hd.y - wy, hd.z - wz); if (d < pd) { pd = d; prim = hd.key; } }
          drag = { type: 'nodes', leaves: [...leaves], hit, add, from: [wy, wz], snap: snapScene, moved: false,
            info: prepareSnap(snapScene, prim, k => leaves.has(parseKey(k).node)) };
        } else drag = { type: 'box', sx, sy, cx: sx, cy: sy, hit, add, moved: false };
      }
      drawSection();
    });
    svg.addEventListener('pointermove', (e) => {
      if (!state.scene) return;
      const [sx, sy] = local(e), [wy, wz] = toWorld(sx, sy);
      cursorW = { y: wy, z: wz };
      coord.textContent = 'x: radius ' + fmt(wy, 3) + ' / Ø ' + fmt(2 * wy, 3) + ' · y: height ' + num(hDisp(wz, sceneBase), 3) + ' ' + UNIT_LABEL;
      if (!drag) {
        drawCursor();
        const he = e.target.__key ? null : edgeAt(sx, sy);
        if (he !== hoverEdge) { hoverEdge = he; svg.style.cursor = he ? 'pointer' : ''; drawSection(); }
        return;
      }
      if (drag.type === 'pan') { view.cy = drag.cy - (sx - drag.sx) / view.s; view.cz = drag.cz + (sy - drag.sy) / view.s; drawSection(); return; }
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
      }
      if (P0) drag.cur = { y: P0.y + dy, z: P0.z + dz };
      state.scene = clone(drag.snap);
      if (drag.type === 'points') moveKeysView(state.scene, [...state.sel], dy, dz);
      else for (const id of drag.leaves) moveNodeView(state.scene, id, dy, dz);
      markEdited();
      drawSection(); recalc({ fast: true });
    });
    const endDrag = () => {
      if (!drag) return;
      const d = drag; drag = null;
      if (d.type === 'pan') return;
      if (d.type === 'box') {
        if (d.moved) {
          const [y0, z1] = toWorld(Math.min(d.sx, d.cx), Math.min(d.sy, d.cy)), [y1, z0] = toWorld(Math.max(d.sx, d.cx), Math.max(d.sy, d.cy));
          if (!d.add) state.sel = new Set();
          for (const id of leafOrder(state.scene)) for (const hd of handlesOf(id)) if (hd.y >= y0 && hd.y <= y1 && hd.z >= z0 && hd.z <= z1) state.sel.add(hd.key);
        } else if (d.hit) {
          // click on an object: select it (Shift/Ctrl toggles it in the selection)
          state.sel = d.add ? state.sel : new Set();
          if (d.add) { if (state.selNodes.has(d.hit)) state.selNodes.delete(d.hit); else state.selNodes.add(d.hit); }
          else state.selNodes = new Set([d.hit]);
        } else if (!d.add) { state.sel = new Set(); state.selNodes = new Set(); }
        renderAll(); return;
      }
      if (d.type === 'cloner' && !d.moved) { state.selNodes = new Set([d.id]); state.sel = new Set(); renderAll(); return; }
      if (d.type === 'points' && !d.moved) {
        if (d.toggleOff) state.sel.delete(d.key);
        state.selNodes = new Set([parseKey(d.key).node]);
      }
      if (d.type === 'nodes' && !d.moved && d.add) state.selNodes.delete(d.hit);
      if (d.moved) recalc(); else renderAll();
    };
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', endDrag);
    svg.addEventListener('pointerleave', () => { cursorW = null; if (hoverEdge && !drag) { hoverEdge = null; drawSection(); } else drawCursor(); });
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!view) return;
      const [sx, sy] = local(e), [wy, wz] = toWorld(sx, sy);
      view.s *= Math.exp(-e.deltaY * 0.0015);
      const [ny, nz] = toWorld(sx, sy);
      view.cy += wy - ny; view.cz += wz - nz;
      drawSection();
    }, { passive: false });
    svg.addEventListener('dblclick', (e) => { if (!e.target.__key) { fit(); drawSection(); } });

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
      const keys = [...state.sel], pts = pointKeys(keys).filter(k => parseKey(k).kind === 'p');
      const edges = keys.filter(k => parseKey(k).kind === 'e'), runs = keys.filter(k => parseKey(k).kind === 'r');
      const firstBevel = pts.map(k => { const h = parseKey(k); return state.scene.nodes[h.node].pts[h.i].bevel; }).find(b => b && b.r > 0);
      const bv = { r: firstBevel ? firstBevel.r : 0, segs: firstBevel ? firstBevel.segs : 4, out: firstBevel ? firstBevel.out : true };
      menu.textContent = '';
      const what = [pts.length ? pts.length + ' point' + (pts.length === 1 ? '' : 's') : null, edges.length ? edges.length + ' edge' + (edges.length === 1 ? '' : 's') : null, runs.length ? runs.length + ' thread point' + (runs.length === 1 ? '' : 's') : null].filter(Boolean).join(', ');
      menu.append(el('div', { style: 'font-weight:700;margin-bottom:4px' }, what + ' selected'));
      if (runs.length) menu.append(el('div', { style: 'color:#666;margin-bottom:4px' }, 'Thread points are skipped for bevels, inserting and deleting.'));
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
        const rIn = el('input', { type: 'number', step: '0.05', min: '0', value: num(mm(bv.r), 3), style: 'width:60px' });
        const sIn = el('input', { type: 'number', step: '1', min: '1', max: '64', value: String(bv.segs), style: 'width:46px' });
        const oIn = selectInput(bv.out ? 'convex' : 'concave', [['convex', 'convex (rounded)'], ['concave', 'concave (cove)']], () => {});
        menu.append(
          el('div', { style: 'margin:2px 0' }, 'Bevel radius (' + UNIT_LABEL + ', 0 = none) ', rIn),
          el('div', { style: 'margin:2px 0' }, 'edges ', sIn, ' shape ', oIn),
          el('div', { style: 'color:#666;font-size:11px' }, 'Changes apply as you type. A bevel may reach past the middle of an edge; the neighbouring bevel shrinks to make room.'));
        // live: every change re-applies the bevel (one undo step for this menu)
        let bevelUndo = false;
        const applyBevel = (live) => {
          const r = Math.max(0, parseFloat(rIn.value) || 0) / UNIT_SCALE, s = Math.max(1, Math.min(64, parseInt(sIn.value, 10) || 1));
          if (!bevelUndo) { pushUndo(); bevelUndo = true; }
          setBevel(pts, r > 0 ? { r, segs: s, out: oIn.value === 'convex', pri: Date.now() } : null); markEdited();
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
        if (opts.id) {
          r.addEventListener('dragstart', (e) => { dragNodeId = opts.id; e.dataTransfer.setData('text/plain', opts.id); e.dataTransfer.effectAllowed = 'copyMove'; });
          r.addEventListener('dragend', () => { dragNodeId = null; });
          r.addEventListener('click', (e) => {
            if (e.shiftKey || e.ctrlKey || e.metaKey) { if (state.selNodes.has(opts.id)) state.selNodes.delete(opts.id); else state.selNodes.add(opts.id); }
            else { state.selNodes = new Set([opts.id]); state.sel = new Set(); }
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
      const nodeRow = (id, depth, label, drop) => {
        const n = sc.nodes[id], selected = state.selNodes.has(id);
        // dropping onto a group adds to it; onto a boolean fills its first empty slot; onto anything else inserts before it
        let target = drop;
        if (n.type === 'group' || n.type === 'cloner') target = { parent: id, slot: null };
        else if (n.type === 'boolean') { const s = n.children.indexOf(null); target = s >= 0 ? { parent: id, slot: s } : drop; }
        mkRow({ id, drop: target, title: 'Drag onto a group, a boolean slot or the scene to move it',
          style: 'padding:1px 4px;margin-left:' + depth * 14 + 'px;border-radius:4px;cursor:pointer;user-select:none;transition:background-color .15s,outline-color .15s;' + (selected ? 'background:#ddf4ff;outline:1px solid #54aeff' : ''),
          kids: [el('span', { style: 'display:inline-flex;vertical-align:-2px;margin-right:4px;color:' + (COLORS[n.type] || '#555') }, icon(nodeIcon(n), 14)), (label ? label + ' ' : '') + (n.name || id),
            n.type === 'boolean' ? el('span', { style: 'color:#888' }, ' (' + (n.op === 'difference' ? 'A − B' : n.op) + ')') : n.type === 'group' ? el('span', { style: 'color:#888' }, ' (group, ' + n.children.length + ')')
              : n.type === 'cloner' ? el('span', { style: 'color:#888' }, ' (×' + n.params.count + ', ' + n.params.orient + ')') : null] });
        if (n.type === 'boolean') n.children.forEach((c, s) => {
          if (c != null) nodeRow(c, depth + 1, s ? 'B:' : 'A:', { parent: id, slot: s });
          else mkRow({ drop: { parent: id, slot: s }, style: 'padding:1px 4px;margin-left:' + (depth + 1) * 14 + 'px;color:#999;font-style:italic;border-radius:4px',
            kids: [(s ? 'B' : 'A') + ': empty — drop an object here'] });
        });
        if (n.type === 'group' || n.type === 'cloner') {
          n.children.forEach((c, i) => nodeRow(c, depth + 1, null, { parent: id, slot: i }));
          if (!n.children.length) mkRow({ drop: { parent: id, slot: null }, style: 'padding:1px 4px;margin-left:' + (depth + 1) * 14 + 'px;color:#999;font-style:italic;border-radius:4px', kids: ['empty — drop objects here'] });
        }
      };
      mkRow({ drop: { parent: null, slot: null }, style: 'color:#666;padding:1px 4px;border-radius:4px', kids: ['Scene (union of everything below) — drop here to move to the top level (hold Ctrl to copy)'] });
      sc.root.forEach((id, i) => nodeRow(id, 1, null, { parent: null, slot: i }));
      return el('div', { style: BOX },
        el('div', { style: H }, 'Objects'),
        rows,
        el('div', { style: 'color:#666;font-size:11px;margin-top:3px' }, 'Shift/Ctrl-click to select several. Drag rows into groups, boolean slots or the scene; hold Ctrl while dropping to place a copy instead. Right-click a row for more (Duplicate: Ctrl+D).'));
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
      if (ids.length > 1) return el('div', { style: BOX }, el('div', { style: H }, ids.length + ' objects selected'), el('div', { style: 'color:#666' }, ids.length + ' objects selected: use the buttons in the header, or right-click for more.'));
      const n = sc.nodes[ids[0]], U = ' (' + UNIT_LABEL + ')', UX = ', ' + UNIT_LABEL + ')';
      const box = el('div', { style: BOX }, el('div', { style: H }, 'Properties — ' + (n.name || n.id)));
      const nameIn = el('input', { type: 'text', value: n.name || '', style: 'width:160px;box-sizing:border-box' });
      nameIn.addEventListener('change', () => { pushUndo(); n.name = nameIn.value; if (n.type === 'thread') for (const r of n.runs) r.label = n.name || 'Thread'; renderAll(); });
      const pc = parentChoices(n.id);
      box.append(pgrid(2, ['Name', nameIn], ['Parent', selectInput(pc.value, pc.out, v => {
          const snap = clone(sc);
          const t = v === 'root' ? { parent: null, slot: null } : v.endsWith(':g') ? { parent: v.slice(0, -2), slot: null } : { parent: v.split(':')[0], slot: +v.split(':')[1] };
          if (moveNodeTo(sc, n.id, t)) { pushSnap(snap); markEdited(); recalc(); }
        }, 'max-width:180px')]));
      const note = (t) => ({ wide: el('div', { style: 'color:#666;font-size:11px' }, t) });
      // circle precision for this object (blank = the export setting)
      const precisionField = () => ['Circle precision (edges)', numInput(() => n.precision || '', v => {
        pushUndo(); n.precision = v == null ? null : Math.max(3, Math.min(2000, Math.round(v))); markEdited(); recalc();
      }, { step: '1', min: 3, max: 2000, digits: 0, width: 96, allowEmpty: true, noLive: true, placeholder: 'default ' + state.precision, title: 'Edges around a full circle for this object; leave blank to use the export setting' })];
      const handNote = () => n.custom ? { wide: el('div', { style: 'color:#9a6700;margin-top:2px' }, 'Outline edited by hand — parameter changes are applied on top of your edits. ',
        el('button', { type: 'button', style: BTN2, onclick: () => { pushUndo(); regenNode(n); markEdited(); recalc(); } }, 'Regenerate from parameters')) } : null;

      if (n.type === 'boolean') {
        box.append(pgrid(1, ['Operation', selectInput(n.op, [['union', 'Union (A ∪ B)'], ['difference', 'Difference (A − B)'], ['intersection', 'Intersection (A ∩ B)']], v => { pushUndo(); n.op = v; markEdited(); recalc(); }),
          el('button', { type: 'button', style: BTN2, onclick: () => { pushUndo(); n.children.reverse(); markEdited(); recalc(); } }, 'Swap A ↔ B')]));
        return box;
      }
      if (n.type === 'group') { box.append(el('div', { style: 'color:#666' }, 'A group combines its objects (union). Drag objects in or out in the list.')); return box; }
      if (n.type === 'cloner') {
        const q = n.params;
        const setC = (k, v) => { pushUndo(); q[k] = v; markEdited(); recalc(); };
        box.append(pgrid(2,
          ['Copies', numInput(() => q.count, v => setC('count', Math.max(1, Math.min(360, Math.round(v)))), { step: '1', min: 1, max: 360, digits: 0, width: 80 })],
          ['Orientation', selectInput(q.orient, [['axial', 'axial (parallel to the axis)'], ['radial', 'radial (pointing outward)']], v => setC('orient', v))],
          ['Distance from axis (x' + UX, numInput(() => mm(q.radius), v => setC('radius', Math.max(0, v / UNIT_SCALE)), { min: 0 })],
          q.orient === 'radial' ? ['Copies\' axis height (y' + UX, numInput(() => hDisp(q.height, zBase()), v => setC('height', v / UNIT_SCALE + zBase()))] : GBR,
          ['Angle offset (°)', numInput(() => q.angle, v => setC('angle', v), { step: '1', digits: 3, width: 80 })],
          ['Spread (°)', numInput(() => q.spread, v => setC('spread', Math.max(0, Math.min(360, v))), { step: '5', min: 0, max: 360, digits: 3, width: 80 })],
          note('Children are built around their own axis and copied around the main axis: 360° spreads the copies evenly, less spreads them from the first angle to the last. ' +
            'Drag the orange diamond in the cross-section to set the distance from the axis' + (q.orient === 'radial' ? ' and the height' : '') + '. The cross-section shows the first copy (dashed: its other half). ' +
            'For bolt holes, put a solid circle (inner radius 0) in an axial cloner and subtract the cloner in a boolean.')));
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
          setT(t => { const std = isStd(t), L = t.turns * t.pitch; t.preset = p[0]; t.d = p[2] / UNIT_SCALE; t.pitch = p[3] / UNIT_SCALE; t.turns = Math.max(1, L / t.pitch); if (std) t.depth = stdOf(t.pitch, t.profile); });
        });
        const backing = () => q.backing != null ? q.backing : q.wall / q.depth;
        const diam = () => (q.kind === 'internal' ? 'Minor Ø ' + num(mm(q.d - 2 * q.depth + 2 * (q.clearance || 0)), 3) + ', major Ø ' + num(mm(q.d + 2 * (q.clearance || 0)), 3)
          : 'Major Ø ' + num(mm(q.d - 2 * (q.clearance || 0)), 3) + ', minor Ø ' + num(mm(q.d - 2 * q.depth - 2 * (q.clearance || 0)), 3)) + ' ' + UNIT_LABEL + ' (basic sizes).';
        box.append(pgrid(2,
          ['Standard', presetSel], GBR,
          ['Gender', selectInput(q.kind, [['external', 'male (external)'], ['internal', 'female (internal)']], v => setT(t => { t.kind = v; }))],
          ['Hand', selectInput(String(q.hand), [['1', 'right-hand'], ['-1', 'left-hand']], v => setT(t => { t.hand = +v; }))],
          ['Nominal Ø' + U, numInput(() => mm(q.d), v => setT(t => { t.d = Math.max(0.1 / UNIT_SCALE, v / UNIT_SCALE); t.preset = ''; }), { min: 0.1 })],
          ['Pitch' + U, numInput(() => mm(q.pitch), v => setT(t => {
            const P = Math.max(0.05 / UNIT_SCALE, v / UNIT_SCALE), std = isStd(t), L = t.turns * t.pitch;
            t.pitch = P; t.turns = Math.max(1, L / P); t.preset = ''; if (std) t.depth = stdOf(P, t.profile);
          }), { step: '0.05', min: 0.05 }), dyn(() => '= ' + num(25.4 / mm(q.pitch), 2) + ' TPI')],
          ['Profile', selectInput(q.profile, [['iso', 'ISO 60° (flats)'], ['v', 'sharp 60° V']], v => setT(t => { const std = isStd(t); t.profile = v; if (std) t.depth = stdOf(t.pitch, v); }))],
          ['Depth (x' + UX, numInput(() => mm(q.depth), v => setT(t => { t.depth = Math.max(0.01 / UNIT_SCALE, v / UNIT_SCALE); }), { step: '0.01', min: 0.01 }),
            el('button', { type: 'button', style: BTN2 + ';padding:2px 6px', onclick: () => setT(t => { t.depth = stdOf(t.pitch, t.profile); }), title: 'ISO basic depth 5H/8 = 0.541 × pitch, or H = 0.866 × pitch for a sharp V' }, 'standard')],
          ['Turns', numInput(() => q.turns, v => setT(t => { t.turns = Math.max(1, v); }), { step: '0.5', min: 1, digits: 3 })],
          ['Length (y' + UX, numInput(() => mm(q.turns * q.pitch), v => setT(t => { t.turns = Math.max(1, v / UNIT_SCALE / t.pitch); }), { step: '0.5' })],
          ['Solid backing (× depth)', numInput(backing, v => setT(t => { t.backing = Math.max(0.05, v); }), { step: '0.25', min: 0.05, digits: 3 })],
          ['Backing (x' + UX, numInput(() => mm(backing() * q.depth), v => setT(t => { t.backing = Math.max(0.05, v / UNIT_SCALE / t.depth); }), { step: '0.1' })],
          ['Bottom y offset' + U, numInput(() => hDisp(q.z, zBase()), v => setT(t => { t.z = v / UNIT_SCALE + zBase(); }))],
          ['Lead-in taper', checkInput(() => q.taperBottom, v => setT(t => { t.taperBottom = v; }), 'bottom'), checkInput(() => q.taperTop, v => setT(t => { t.taperTop = v; }), 'top')],
          ['Clearance (x' + UX, numInput(() => mm(q.clearance || 0), v => setT(t => { t.clearance = v / UNIT_SCALE; }), { step: '0.05', title: 'Shrinks a male thread / enlarges a female one, for printed fits' })],
          precisionField(),
          { wide: dyn(diam, 'color:#666;font-size:11px') },
          note('Lead-in taper cuts the end of the thread, backing included, at the flank angle of the teeth, so it does not end in a sharp half tooth and starts easily. ' +
            'Backing is the solid material ' + (q.kind === 'internal' ? 'outside' : 'inside') + ' the teeth. Dragging the thread, its backing wall or its ends in the cross-section updates these values.'),
          handNote()));
        return box;
      }
      if (n.type === 'holes') {
        box.append(el('div', { style: 'color:#666' }, (n.holes || []).length + ' hole(s) from an imported project, as one solid. Put it in the B slot of a difference boolean to cut them out. They are not drawn in the cross-section.'));
        return box;
      }
      if (n.type === 'source') {
        box.append(pgrid(2, precisionField()), el('div', { style: 'color:#666;margin-top:4px' }, 'A profile from an imported project file: edit its points and edges in the cross-section.'));
        if ((n.holes || []).length) box.append(el('div', { style: 'color:#666' }, n.holes.length + ' hole(s) are cut out.'));
        return box;
      }
      const q = n.params, setP = (mut) => setParams(n, mut);
      const len = (k, o) => numInput(() => mm(q[k]), v => setP(t => {
        t[k] = Math.max(k === 'h' ? 0.01 / UNIT_SCALE : 0, v / UNIT_SCALE);
        if (k === 'rib' && t.linkIn) t.rit = t.rib;
        if (k === 'rob' && t.linkOut) t.rot = t.rob;
      }), o);
      const ng = n.type === 'ngon';
      box.append(pgrid(2,
        ng ? ['Sides', numInput(() => q.sides, v => setP(t => { t.sides = Math.max(3, Math.min(256, Math.round(v))); }), { step: '1', min: 3, max: 256, digits: 0 })] : null,
        ng ? ['Radius about', selectInput(q.about, [['faces', 'face centres'], ['edges', 'edges']], v => setP(t => { t.about = v; }))] : null,
        ng ? ['Rotation (°)', numInput(() => q.rotation || 0, v => setP(t => { t.rotation = v; }), { step: '1', digits: 2 })] : null,
        ng ? GBR : null,
        ['Bottom y offset' + U, numInput(() => hDisp(q.z, zBase()), v => setP(t => { t.z = v / UNIT_SCALE + zBase(); }))],
        ['Height' + U, len('h', { min: 0.01 })],
        ['Inner bottom (x' + UX, len('rib', { min: 0 })],
        ['Inner top (x' + UX, len('rit', { min: 0, disabled: q.linkIn })],
        ['Outer bottom (x' + UX, len('rob', { min: 0 })],
        ['Outer top (x' + UX, len('rot', { min: 0, disabled: q.linkOut })],
        ['Linked inner', checkInput(() => q.linkIn, v => setP(t => { t.linkIn = v; t.rit = t.rib; }), 'top = bottom')],
        ['Linked outer', checkInput(() => q.linkOut, v => setP(t => { t.linkOut = v; t.rot = t.rob; }), 'top = bottom')],
        ['Bevel radius' + U, len('bevel', { min: 0 })],
        ['Bevel edges', numInput(() => q.bevelSegs, v => setP(t => { t.bevelSegs = Math.max(1, Math.min(64, Math.round(v))); }), { step: '1', min: 1, max: 64, digits: 0 })],
        ['Bevel shape', selectInput(q.bevelOut ? 'convex' : 'concave', [['convex', 'convex (rounded)'], ['concave', 'concave (cove)']], v => setP(t => { t.bevelOut = v === 'convex'; }))],
        ng ? null : precisionField(),
        note('Radii in ' + UNIT_LABEL + (ng ? ', measured ' + (q.about === 'faces' ? 'to the face centres' : 'to the edges') : '') + '. Editing the outline in the cross-section updates these values while it still matches them.'),
        handNote()));
      return box;
    }

    function libraryBlock() {
      const list = libLoad();
      const box = el('div', null, el('div', { style: H }, 'Saved models (this browser)'));
      if (!list.length) box.append(el('div', { style: 'color:#666' }, 'Nothing saved yet. Select objects and use Save (Properties header or right-click), or Save scene below.'));
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
      box.append(el('div', { style: 'color:#666;font-size:11px;margin-top:3px' }, 'Each saved model keeps its own outlines, threads and bevels. Export them as JSON to keep a copy or move them to another browser.'));
      return box;
    }

    const dlBtn = el('button', { type: 'button', style: BTN, onclick: download });
    let sideStatus = null, sideSig = null;
    // A block from the old single panel, shown bare inside its own view (its own title row dropped).
    function bare(b, keepHead) {
      if (!b) return null;
      Object.assign(b.style, { border: '0', padding: '0', margin: '0', background: 'none', boxShadow: 'none' });
      if (!keepHead && b.firstChild && b.firstChild.nodeType === 1) b.firstChild.remove();
      return b;
    }
    function renderSide() {
      const fe = document.activeElement;
      const s = statusText();
      dlBtn.disabled = !s.ready; dlBtn.style.opacity = s.ready ? '1' : '0.5'; dlBtn.style.cursor = s.ready ? 'pointer' : 'not-allowed';
      dlBtn.textContent = downloadLabel(s);
      if (side.contains(fe) && (fe.tagName === 'SELECT' || (fe.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|range|color)$/.test(fe.type)))) {
        // keep the other fields up to date while one is being edited
        for (const i of side.querySelectorAll('input')) if (i !== document.activeElement && i.__get) i.value = i.__get();
        for (const t of side.querySelectorAll('span')) if (t.__text) t.textContent = t.__text();
        if (sideStatus) { sideStatus.textContent = s.text; sideStatus.style.color = s.color; }
        return;
      }
      const tops = {};
      pgridMaxCols = rightBar.clientWidth && rightBar.clientWidth < 560 ? 1 : 2;
      for (const k in panels) { tops[k] = panels[k].body.scrollTop; panels[k].body.textContent = ''; }
      sideStatus = el('div', { role: 'status', style: 'color:' + s.color + ';margin-bottom:6px' }, s.text);
      for (const k in panels) panels[k].tools.textContent = '';
      appendKids(panels.project.tools,
        hbtn('undo', 'Undo', undo, { title: 'Undo (Ctrl+Z)', disabled: !state.undo.length }),
        hbtn('redo', 'Redo', redo, { title: 'Redo (Ctrl+Y or Ctrl+Shift+Z)', disabled: !state.redo.length }),
        hbtn('download', 'Export', exportSceneJson, { title: 'Export the whole scene as a JSON file that Import can rebuild it from', disabled: !state.scene }),
        hbtn('upload', 'Import', pickJsonFile, { title: 'Import a scene or saved models from a JSON file' }),
        hbtn('fit', 'Fit', () => { fit(); drawSection(); }, { title: 'Fit the cross-section view' }));
      sideStatus.style.marginBottom = '4px';
      appendKids(panels.project.body, sideStatus, dlBtn,
        el('div', { style: 'margin-top:5px;padding-top:4px;border-top:1px solid #e9ecef' }, settingsBlock()));
      panels.project.extra.textContent = s.ready ? (s.text.startsWith('✔') ? '✔ solid' : '✘ not solid') : s.text.startsWith('Error') ? 'error' : state.busy ? 'updating…' : '';
      panels.project.extra.style.color = s.color;
      if (state.scene) {
        panels.objects.body.append(bare(treeBlock()));
        const nSel = state.selNodes.size;
        appendKids(panels.objects.tools,
          hbtn('circle', 'Circle', () => addObject('circle', view), { title: 'Add a circle (ring)', color: COLORS.circle }),
          hbtn('ngon', 'N-sided', () => addObject('ngon', view), { title: 'Add an n-sided ring', color: COLORS.ngon }),
          hbtn('thread', 'Thread', () => addObject('thread', view), { title: 'Add a threaded ring, with standard sizes', color: COLORS.thread }),
          hbtn('cloner', 'Cloner', () => wrapSelection('cloner'), { title: nSel ? 'Put the selected objects in a radial cloner' : 'Add an empty radial cloner' }),
          hbtn('group', 'Group', () => wrapSelection('group'), { title: nSel ? 'Group the selected objects' : 'Add an empty group' }),
          hbtn('boolean', 'Boolean', () => wrapSelection('boolean'), { title: 'Add a boolean: with one object selected it becomes A; with two, A and B' }));
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
      // footer: saved models and saving
      const lib = libLoad(), selIds = state.scene ? topSelected(state.scene) : [];
      const msg = state.exportError || (state.exporting ? 'Exporting ' + state.exporting + '…' : state.libMessage) || '';
      footer.textContent = '';
      const listBtn = hbtn('list', 'Saved models' + (lib.length ? ' (' + lib.length + ')' : ''), () => toggleLib(), { title: 'Show the saved models' });
      if (libOpen) { listBtn.style.background = '#ddf4ff'; listBtn.style.borderColor = '#54aeff'; }
      appendKids(footer, listBtn,
        selIds.length ? hbtn('save', 'Save selection', () => saveToLibrary(selIds), { title: 'Save the selected objects to Saved models' }) : null,
        hbtn('save', 'Save scene', saveScene, { title: 'Save everything in the scene to Saved models', disabled: !(state.scene && state.scene.root.length) }),
        lib.length ? hbtn('json', 'Export all', () => exportModelsJson(lib, 'saved-models'), { title: 'All saved models in one JSON file' }) : null,
        el('span', { class: 'aa-libmsg', title: msg, style: 'flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:4px;color:' + (state.exportError ? '#b42318' : '#1a7f37') }, msg));
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
    let prog = null, gProg = null, aoProg = null, blurProg = null, copyProg = null, texProg = null, quadBuf = null, fb = null, compassBuf = null, compassDirty = true, bbox = null;
    let triBuf = null, lineBuf = null, capBuf = null, triCount = 0, lineCount = 0, center = [0, 0, 0], radius = 1, yaw = (state.viewAngle - 90) * Math.PI / 180, pitchA = 0.5, dist = 3, shown = null, pan = [0, 0, 0];
    if (gl) {
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn('[adapter-assembler] shader', gl.getShaderInfoLog(s)); return s; };
      const program = (vs, fs) => { const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); return p; };
      const VS = 'attribute vec3 pos; attribute vec3 nrm; uniform mat4 mvp; uniform mat4 mv; varying vec3 vN; varying vec3 vP; varying vec3 vVN; varying float vD;' +
        'void main(){ vN = nrm; vP = pos; vVN = (mv * vec4(nrm, 0.0)).xyz; vD = -(mv * vec4(pos, 1.0)).z; gl_Position = mvp * vec4(pos, 1.0); }';
      // up to three cut planes: clip[i] = (normal, offset); a point p is cut away when dot(n, p) > offset.
      // mode 0 surfaces, 1 wireframe, 2 cap of plane capPlane (coloured capCol), 3 stencil pass for that cap.
      const CUT = 'uniform vec4 clip[3]; uniform vec3 clipOn; uniform float skip; uniform vec4 capPlane; uniform float capSide; uniform vec3 capCol; uniform float mode;' +
        'bool cutAway(vec3 p){ for (int i = 0; i < 3; i++) { if (clipOn[i] > 0.5 && abs(float(i) - skip) > 0.5 && dot(clip[i].xyz, p) - clip[i].w > 0.0) return true; } return false; }';
      prog = program(VS, [
        'precision highp float; varying vec3 vN; varying vec3 vP; varying vec3 vVN; varying float vD; uniform vec3 eye; ' + CUT,
        'uniform sampler2D aoTex; uniform float aoOn; uniform vec2 res;',
        'void main(){',
        '  float ao = aoOn > 0.5 ? texture2D(aoTex, gl_FragCoord.xy / res).r : 1.0;',
        '  float aoK = 0.3 + 0.7 * ao;',
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
      compassBuf = gl.createBuffer();
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
      const t = result.preview.tris, l = result.preview.lines;
      meshTris = t; cutEdgeCache = null;
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
      compassDirty = true;
      center = [0, 1, 2].map(c => (mn[c] + mx[c]) / 2); radius = nr; bbox = { mn, mx };
      draw3d();
    }
    // pixels per mm on the plane through the view's centre (the same for perspective and orthographic)
    function pxPerMm() { return canvas.clientHeight / Math.max(1e-9, 2 * dist * Math.tan(0.35)); }
    let projT = state.ortho ? 0 : 1, projAnim = 0;   // 1 = perspective, 0 = orthographic (animated in between)
    let camBasis = null, lastM = null, lastEye = null, badBuf = null, badCount = 0, gizmoBuf = null, cutDrag = null;
    const cross3 = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
    const norm3 = (p) => { const l = Math.hypot(p[0], p[1], p[2]) || 1; return [p[0] / l, p[1] / l, p[2] / l]; };
    // The three cut axes through the middle of the part's base: X across (red), Y up (green), Z depth (blue).
    // Relative: X and Z turn with the view (Z points toward you); absolute: fixed to the part.
    const CUT_AXES = [['x', [1, 0.42, 0.42], [1, 0.72, 0.72]], ['y', [0.42, 0.85, 0.45], [0.7, 0.92, 0.72]], ['z', [0.45, 0.6, 1], [0.7, 0.78, 1]]];
    function cutFrame() {
      if (!bbox) return null;
      const { mn, mx } = bbox, O = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, mn[2]];
      const rel = state.cutMode !== 'absolute';
      const X = rel ? [-Math.sin(yaw), Math.cos(yaw), 0] : [1, 0, 0], Z = rel ? [Math.cos(yaw), Math.sin(yaw), 0] : [0, 1, 0], Y = [0, 0, 1];
      const half = Math.max(mx[0] - mn[0], mx[1] - mn[1]) / 2 * 1.15, H = (mx[2] - mn[2]) * 1.12;
      return { O, dirs: { x: X, y: Y, z: Z }, ext: { x: half, y: H, z: half }, lo: { x: -1, y: -0.05, z: -1 } };
    }
    function cutPlanes() {
      const f = cutFrame(), cuts = state.cuts || {};
      return CUT_AXES.map(([k, axisCol, cap]) => {
        if (!f) return { on: false, n: [0, 0, 1], w: 0, cap };
        const n = f.dirs[k], v = cuts[k] == null ? 1 : cuts[k], s = v * f.ext[k];
        return { on: v < 0.999, n, w: n[0] * f.O[0] + n[1] * f.O[1] + n[2] * f.O[2] + s, cap, key: k, axisCol };
      });
    }
    // where each cut handle is drawn: at its place on its axis, or moved aside in the view when handles would cover each other
    function handleSpots() {
      const out = {}, scr = {};
      for (const [k] of CUT_AXES) { out[k] = handlePos(k); scr[k] = toScreen3(out[k]); }
      if (!camBasis || !radius) return out;
      const keys = CUT_AXES.map(a => a[0]).filter(k => scr[k]), done = new Set();
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
    function handlePos(k) {
      const f = cutFrame(), v = (state.cuts || {})[k] == null ? 1 : state.cuts[k], d = f.dirs[k], s = v * f.ext[k];
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
      const f = cutFrame(); if (!f || !camBasis) return;
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
      const W = G * 0.007, planes = cutPlanes();
      const lines = [], handles = [], sheets = [], spots = handleSpots();
      CUT_AXES.forEach(([k, col], i) => {
        const d = f.dirs[k], lo = f.lo[k] * f.ext[k], hi = f.ext[k];
        lines.push([[f.O[0] + d[0] * lo, f.O[1] + d[1] * lo, f.O[2] + d[2] * lo], [f.O[0] + d[0] * hi, f.O[1] + d[1] * hi, f.O[2] + d[2] * hi], col]);
        handles.push([spots[k], col, cutDrag && cutDrag.k === k]);
        const p = planes[i];
        if (p.on) {
          // the plane, just as big as the part: a rectangle for the upright planes, a square for the level one
          const c = handlePos(k), half = f.ext.x / 1.15, zLo = bbox.mn[2], zHi = bbox.mx[2];
          let cr;
          if (k === 'y') { const ax = [1, 0, 0], ay = [0, 1, 0]; cr = (s, t) => [c[0] + (ax[0] * s + ay[0] * t) * half, c[1] + (ax[1] * s + ay[1] * t) * half, c[2]]; }
          else { const u1 = norm3(cross3([0, 0, 1], d)); cr = (s, t) => [c[0] + u1[0] * s * half, c[1] + u1[1] * s * half, t < 0 ? zLo : zHi]; }
          sheets.push([cr(-1, -1), cr(1, -1), cr(1, 1), cr(-1, 1), col]);
        }
      });
      // faint planes (depth-tested), axes (depth-tested, plus a faint see-through copy), handles on top
      for (const [a, b, c, e, col] of sheets) { const cc = [col[0], col[1], col[2], 0.08]; tri(a, b, c, cc); tri(a, c, e, cc); }
      const nSheet = v.length / 7;
      for (const [p, q, col] of lines) seg(p, q, W, [col[0], col[1], col[2], 0.95]);
      const nLines = v.length / 7;
      for (const [p, q, col] of lines) seg(p, q, W, [col[0], col[1], col[2], 0.25]);
      const nGhost = v.length / 7;
      for (const [p, col] of handles) if (p.moved) seg(p.moved, p, W * 0.6, [col[0], col[1], col[2], 0.9]);
      for (const [p, col, hot] of handles) {
        // a snapped handle gets a white ring
        disc(p, G * (hot ? 0.05 : 0.04), hot && cutDrag.snapped ? [1, 1, 1, 0.95] : [0.1, 0.11, 0.13, 0.9]);
        disc(p, G * (hot ? 0.042 : 0.032), [col[0], col[1], col[2], 1]);
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
    let meshTris = null, cutEdgeCache = null, cutEdgeBuf = null;
    const EDGE_COL = { x: [1, 0.28, 0.28, 1], y: [0.3, 1, 0.38, 1], z: [0.32, 0.62, 1, 1] };
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
      cutEdgeCache = { key, mesh: meshTris, segs };
      return segs;
    }
    function drawCutEdges() {
      const planes = cutPlanes();
      if (!meshTris || !camBasis || !planes.some(p => p.on)) return;
      const segs = cutSegments(planes), px = Math.max(1e-9, pxPerMm()), hw = 1.2 / px, lift = 0.6 / px, z = camBasis.z, v = [];
      for (const { col, pts } of segs) for (let i = 0; i + 1 < pts.length; i += 2) {
        const P = pts[i], Q = pts[i + 1], d = [Q[0] - P[0], Q[1] - P[1], Q[2] - P[2]];
        let s = [d[1] * z[2] - d[2] * z[1], d[2] * z[0] - d[0] * z[2], d[0] * z[1] - d[1] * z[0]];
        const L = Math.hypot(s[0], s[1], s[2]); if (L < 1e-12) continue;
        s = [s[0] / L * hw, s[1] / L * hw, s[2] / L * hw];
        const at = (p, k) => [p[0] + s[0] * k + z[0] * lift, p[1] + s[1] * k + z[1] * lift, p[2] + s[2] * k + z[2] * lift];
        for (const p of [at(P, -1), at(P, 1), at(Q, 1), at(P, -1), at(Q, 1), at(Q, -1)]) v.push(p[0], p[1], p[2], col[0], col[1], col[2], col[3]);
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
    // Measurements at the major grid steps along the ground axis that runs most nearly left–right on screen:
    // a small tick on the axis and the distance from the centre (mm), upright and facing the viewer.
    let axisLblBuf = null;
    function drawAxisLabels() {
      const f = cutFrame();
      if (!f || !camBasis || !lastM) return;
      const S = compassSpec(), px = Math.max(1e-9, S.px), cs = camBasis.x, up0 = camBasis.y;
      // the ground axis closest to the screen's horizontal, pointing to the right
      const dir = [f.dirs.x, f.dirs.z].map(d => ({ d, h: d[0] * cs[0] + d[1] * cs[1] + d[2] * cs[2] })).sort((a, b) => Math.abs(b.h) - Math.abs(a.h))[0];
      const rt = dir.h < 0 ? dir.d.map(c => -c) : dir.d;
      // text 'up': the camera's up, made square to the axis
      const k = up0[0] * rt[0] + up0[1] * rt[1] + up0[2] * rt[2];
      let up = [up0[0] - rt[0] * k, up0[1] - rt[1] * k, up0[2] - rt[2] * k]; const ul = Math.hypot(...up) || 1; up = up.map(c => c / ul);
      const gz = bbox.mn[2] - radius * 0.004, O = [f.O[0], f.O[1], gz], lw = (p) => p / px, hgt = lw(9), sw = lw(1.1);
      const v = [], COL = [0.88, 0.9, 0.93, 0.95];
      const quad = (a, b, w) => {      // a line of width w, facing the viewer
        const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], z = camBasis.z;
        let s = [d[1] * z[2] - d[2] * z[1], d[2] * z[0] - d[0] * z[2], d[0] * z[1] - d[1] * z[0]]; const L = Math.hypot(...s); if (L < 1e-12) return;
        s = s.map(c => c / L * w / 2);
        for (const p of [[a, -1], [a, 1], [b, 1], [a, -1], [b, 1], [b, -1]]) v.push(p[0][0] + s[0] * p[1], p[0][1] + s[1] * p[1], p[0][2] + s[2] * p[1], ...COL);
      };
      const at = (base, x, y) => [base[0] + rt[0] * x + up[0] * y, base[1] + rt[1] * x + up[1] * y, base[2] + rt[2] * x + up[2] * y];
      const text = (txt, base) => {
        const adv = (ch) => (ch === '.' ? 0.12 : ch === '1' ? 0.42 : ch === '-' ? 0.45 : 0.55) + 0.18;
        let pen = -([...txt].reduce((s, ch) => s + adv(ch), -0.18) * hgt) / 2;
        for (const ch of txt) {
          const g = ch === '-' ? [[[0.05, 0.5], [0.4, 0.5]]] : FONT[ch] || [];
          for (const line of g) for (let i = 0; i + 1 < line.length; i++) quad(at(base, pen + line[i][0] * hgt, line[i][1] * hgt), at(base, pen + line[i + 1][0] * hgt, line[i + 1][1] * hgt), sw);
          pen += adv(ch) * hgt;
        }
      };
      const lim = f.ext.x, step = S.major, fmt1 = (r) => String(+r.toFixed(3));
      // a ground tick across the axis at each step, the number just above it
      const gnd = [-rt[1], rt[0], 0];
      for (let s = -Math.floor(lim / step) * step; s <= lim + 1e-9; s += step) {
        if (Math.abs(s) < step * 1e-6) continue;
        const p = [O[0] + rt[0] * s, O[1] + rt[1] * s, gz];
        quad([p[0] - gnd[0] * lw(4), p[1] - gnd[1] * lw(4), gz], [p[0] + gnd[0] * lw(4), p[1] + gnd[1] * lw(4), gz], lw(1.2));
        text(fmt1(Math.abs(s)), at(p, 0, lw(5)));
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
    function drawBadEdges() {
      if (!badCount) return;
      gl.useProgram(texProg);
      gl.uniformMatrix4fv(gl.getUniformLocation(texProg, 'mvp'), false, new Float32Array(lastM));
      gl.bindBuffer(gl.ARRAY_BUFFER, badBuf);
      const aP = gl.getAttribLocation(texProg, 'pos'), aC = gl.getAttribLocation(texProg, 'col');
      gl.enableVertexAttribArray(aP); gl.disableVertexAttribArray(aC); gl.vertexAttrib4f(aC, 1, 0.1, 0.85, 1);
      gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 12, 0);
      gl.disable(gl.DEPTH_TEST);
      gl.drawArrays(gl.LINES, 0, badCount);
      gl.enable(gl.DEPTH_TEST);
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
    let compassKey = '';
    const niceStep = (x) => { const e = Math.pow(10, Math.floor(Math.log10(x))), m = x / e; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * e; };
    // The ground compass: a radial grid under the part (rings and spokes, minor and major), whose spacing follows the zoom,
    // with degree ticks and numbers round its rim.
    function compassSpec() {
      const { mn, mx } = bbox, R = Math.max(mx[0] - mn[0], mx[1] - mn[1]) / 2 * 1.04, px = Math.max(1e-6, pxPerMm());
      let minor = niceStep(14 / px);
      while (R / minor > 160) minor = niceStep(minor * 1.5);
      const mant = Math.round(minor / Math.pow(10, Math.floor(Math.log10(minor) + 1e-9))), major = minor * (mant === 5 ? 2 : 5);   // 1 → 5, 2 → 10, 5 → 10
      const arc = (deg) => R * deg * Math.PI / 180 * px;                    // screen length of an arc of the rim
      const tick = [1, 2, 5, 10].find(d => arc(d) >= 6) || 10, spoke = [5, 10, 15, 30].find(d => arc(d) >= 26) || 30;
      return { R, px, minor, major, tick, spoke };
    }
    function buildCompass(S) {
      const { mn, mx } = bbox, cx = (mn[0] + mx[0]) / 2, cy = (mn[1] + mx[1]) / 2, z = mn[2] - radius * 0.004;
      const { R, px, minor, major, tick, spoke } = S;
      const v = [], lw = (p) => p / px;                                     // a line width of p screen pixels
      const tri = (a, b, c, col) => { for (const p of [a, b, c]) v.push(p[0], p[1], z, col[0], col[1], col[2], col[3]); };
      const seg = (p, q, w, col) => {
        const dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy) || 1, ux = dx / L * w / 2, uy = dy / L * w / 2, nx = -uy, ny = ux;
        const a = [p[0] - ux + nx, p[1] - uy + ny], b = [p[0] - ux - nx, p[1] - uy - ny], c = [q[0] + ux - nx, q[1] + uy - ny], d = [q[0] + ux + nx, q[1] + uy + ny];
        tri(a, b, c, col); tri(a, c, d, col);
      };
      const ring = (r, w, col) => {
        const N = Math.max(64, Math.min(720, Math.ceil(2 * Math.PI * r * px / 8)));
        for (let i = 0; i < N; i++) {
          const t0 = 2 * Math.PI * i / N, t1 = 2 * Math.PI * (i + 1) / N;
          const p = (rr, t) => [cx + Math.cos(t) * rr, cy + Math.sin(t) * rr];
          tri(p(r - w / 2, t0), p(r + w / 2, t0), p(r + w / 2, t1), col); tri(p(r - w / 2, t0), p(r + w / 2, t1), p(r - w / 2, t1), col);
        }
      };
      const MINOR = [0.72, 0.75, 0.8, 0.22], MAJOR = [0.8, 0.83, 0.86, 0.5], GREY = [0.81, 0.83, 0.85, 0.8], WHITE = [0.97, 0.98, 1, 0.95];
      // rings: minor and major radii
      const ringMajor = (r) => Math.abs(r / major - Math.round(r / major)) < 1e-6;
      for (let k = 1; k * minor < R * 0.985; k++) { const r = k * minor, mj = ringMajor(r); ring(r, lw(mj ? 1.3 : 0.8), mj ? MAJOR : MINOR); }
      // spokes: minor from the first ring out, major (and the four quarters) from the centre
      for (let d = 0; d < 360; d += spoke) {
        const t = d * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), q = d % 90 === 0, mj = d % (spoke * 3) === 0 || q;
        const r0 = q ? 0 : mj ? minor : Math.max(minor, R * 0.25);
        seg([cx + c * r0, cy + s * r0], [cx + c * R * 0.985, cy + s * R * 0.985], lw(q ? 1.3 : mj ? 1 : 0.7), q ? MAJOR : mj ? [MAJOR[0], MAJOR[1], MAJOR[2], 0.38] : MINOR);
      }
      // the rim, with minor / major degree ticks
      ring(R, lw(1.2), GREY);
      const tMajor = tick < 5 ? 10 : tick < 10 ? 30 : 30;
      for (let d = 0; d < 360; d += tick) {
        const t = d * Math.PI / 180, mj = d % tMajor === 0, mid = !mj && d % (tick * 5) === 0 && tick < 5, c = Math.cos(t), s = Math.sin(t);
        const len = mj ? 8 : mid ? 6 : 4;
        seg([cx + c * (R - lw(len)), cy + s * (R - lw(len))], [cx + c * R, cy + s * R], lw(d % 90 === 0 ? 1.3 : mj ? 1 : 0.8), d % 90 === 0 ? WHITE : mj ? GREY : MAJOR);
      }
      // numbers: degrees round the rim, radii along the 0° spoke
      const text = (txt, ox, oy, up, rt, hgt, col) => {
        const adv = (ch) => (ch === '°' ? 0.25 : ch === '.' ? 0.12 : ch === '1' ? 0.42 : 0.55) + 0.18, sw = Math.min(hgt * 0.1, lw(1.1));
        const width = [...txt].reduce((s, ch) => s + adv(ch), -0.18) * hgt;
        let pen = -width / 2;
        for (const ch of txt) {
          for (const line of FONT[ch] || []) for (let i = 0; i + 1 < line.length; i++) {
            const P = (q) => { const lx = pen + q[0] * hgt, ly = (q[1] - 0.5) * hgt; return [ox + rt[0] * lx + up[0] * ly, oy + rt[1] * lx + up[1] * ly]; };
            seg(P(line[i]), P(line[i + 1]), sw, col);
          }
          pen += adv(ch) * hgt;
        }
      };
      const hgt = Math.min(R * 0.05, lw(9)), lblStep = arc10 => arc10 >= 60 ? 10 : 30;   // angle and radius numbers: the same small size
      const every = lblStep(R * 10 * Math.PI / 180 * px);
      for (let d = 0; d < 360; d += every) {
        const t = d * Math.PI / 180, rr = R - lw(11) - hgt * 0.6;
        text(d + '°', cx + Math.cos(t) * rr, cy + Math.sin(t) * rr, [-Math.cos(t), -Math.sin(t)], [-Math.sin(t), Math.cos(t)], hgt, d % 90 === 0 ? WHITE : GREY);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, compassBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
      return v.length / 7;
    }
    let compassCount = 0;
    function drawCompass3d() {
      // rebuilt when the part or the grid's spacing changes, or the zoom has moved the line widths on noticeably
      const S = compassSpec(), key = bbox.mn.join(',') + '|' + bbox.mx.join(',') + '|' + S.minor + '|' + S.tick + '|' + S.spoke + '|' + Math.round(Math.log2(S.px) * 6);
      if (compassDirty || key !== compassKey) { compassCount = buildCompass(S); compassKey = key; compassDirty = false; }
      gl.useProgram(texProg);
      gl.uniformMatrix4fv(gl.getUniformLocation(texProg, 'mvp'), false, new Float32Array(lastM));
      gl.bindBuffer(gl.ARRAY_BUFFER, compassBuf);
      const aP = gl.getAttribLocation(texProg, 'pos'), aC = gl.getAttribLocation(texProg, 'col');
      gl.enableVertexAttribArray(aP); gl.enableVertexAttribArray(aC);
      gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 28, 0); gl.vertexAttribPointer(aC, 4, gl.FLOAT, false, 28, 12);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
      gl.drawArrays(gl.TRIANGLES, 0, compassCount);
      gl.depthMask(true); gl.disable(gl.BLEND);
      gl.disableVertexAttribArray(aC);
    }
    function draw3d() {
      if (!gl) return;
      const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
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
      const Vm = [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dt(x, eye), -dt(y, eye), -dt(z, eye), 1];
      const M = new Array(16);
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += P[k * 4 + r] * Vm[c * 4 + k]; M[c * 4 + r] = s; }
      lastM = M;
      const wire = wireBox.checked && lineCount > 0, ssao = state.ssao;
      const T = (ssao || wire) ? targets(CW, CH) : null;
      const planes = cutPlanes();
      lastEye = eye;
      // the part (+ the cut faces of each active plane) with a given program
      const drawPart = (pr, extra) => {
        gl.useProgram(pr);
        const U = (n) => gl.getUniformLocation(pr, n);
        gl.uniformMatrix4fv(U('mvp'), false, new Float32Array(M)); gl.uniformMatrix4fv(U('mv'), false, new Float32Array(Vm));
        gl.uniform3fv(U('eye'), eye); gl.uniform1f(U('far'), fr); gl.uniform1f(U('dn'), nr);
        gl.uniform4fv(U('clip'), new Float32Array(planes.flatMap(p => [p.n[0], p.n[1], p.n[2], p.w])));
        gl.uniform3fv(U('clipOn'), planes.map(p => p.on ? 1 : 0)); gl.uniform1f(U('skip'), -1);
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
          quad(aoProg, (U) => { gl.uniform1i(U('g'), 0); gl.uniform2f(U('proj'), f / a, f); gl.uniform1f(U('far'), fr); gl.uniform1f(U('dn'), nr); gl.uniform1f(U('R'), Math.max(0.04, Math.min(0.6, radius * 0.02))); });   // mm
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
      if (bbox && texProg) { drawCompass3d(); drawCutEdges(); drawGizmo(); drawAxisLabels(); drawBadEdges(); }
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
      if (!bbox || !lastM) return null;
      let best = null;
      const spots = handleSpots();
      for (const [k] of CUT_AXES) { const s = toScreen3(spots[k]); if (!s) continue; const d = Math.hypot(s[0] - x, s[1] - y); if (d < 14 && (!best || d < best.d)) best = { k, d }; }
      return best && best.k;
    }
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 1) { e.preventDefault(); resetCamera(); return; }
      const r0 = canvas.getBoundingClientRect(), hk = e.button === 0 ? handleAt(e.clientX - r0.left, e.clientY - r0.top) : null;
      if (hk) {
        // slide the cut along its axis
        cutDrag = { k: hk, x0: e.clientX, y0: e.clientY, v0: state.cuts[hk] == null ? 1 : state.cuts[hk] };
        canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'move'; draw3d(); return;
      }
      orbit = { x: e.clientX, y: e.clientY, x0: e.clientX, yaw0: yaw, panBtn: e.button !== 0 };
      canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing';
    });
    canvas.addEventListener('pointermove', (e) => {
      if (cutDrag) {
        const f = cutFrame(), k = cutDrag.k;
        if (!cutDrag.v) {
          // the axis as seen on the screen, measured once where the drag started
          const d = f.dirs[k], P = handlePos(k), ext = f.ext[k];
          const A = toScreen3(P), B = toScreen3([P[0] + d[0] * ext * 0.1, P[1] + d[1] * ext * 0.1, P[2] + d[2] * ext * 0.1]);
          if (!A || !B) return;
          cutDrag.v = [B[0] - A[0], B[1] - A[1]];
        }
        const [vx, vy] = cutDrag.v, L2 = vx * vx + vy * vy;
        if (L2 > 1) {
          // follow the pointer along the axis; within 10 px of the origin (the middle of the base) it snaps there
          const raw = Math.max(f.lo[k], Math.min(1, cutDrag.v0 + ((e.clientX - cutDrag.x0) * vx + (e.clientY - cutDrag.y0) * vy) / L2 * 0.1));
          const pxPerUnit = Math.sqrt(L2) / 0.1;
          const v = Math.abs(raw) * pxPerUnit < 10 && !e.altKey ? 0 : raw;
          state.cuts = { ...state.cuts, [k]: v };
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
      if (orbit.panBtn || e.ctrlKey || e.metaKey) {
        if (camBasis) {
          const k = dist * 2 * Math.tan(0.35) / Math.max(1, canvas.clientHeight), { x, y } = camBasis;
          for (let c = 0; c < 3; c++) pan[c] += (-dx * x[c] + dy * y[c]) * k;
        }
        orbit.x0 += dx; orbit.yaw0 = yaw;          // a pan does not count toward the orbit dead zone
      } else {
        const dead = canvas.clientWidth * 0.05, tx = e.clientX - orbit.x0;
        const ny = orbit.yaw0 - Math.sign(tx) * Math.max(0, Math.abs(tx) - dead) * 0.008;
        pitchA = Math.max(-1.5, Math.min(1.5, pitchA + dy * 0.008));
        if (ny !== yaw) { setViewAngle(ny * 180 / Math.PI + 90, true); orbit.x = e.clientX; orbit.y = e.clientY; return; }
      }
      orbit.x = e.clientX; orbit.y = e.clientY; draw3d();
    });
    const endOrbit = () => { if (cutDrag) { cutDrag = null; saveSettings(); draw3d(); } orbit = null; canvas.style.cursor = 'grab'; };
    canvas.addEventListener('pointerup', endOrbit); canvas.addEventListener('pointercancel', endOrbit);
    canvas.addEventListener('dblclick', (e) => {
      const r0 = canvas.getBoundingClientRect(), hk = handleAt(e.clientX - r0.left, e.clientY - r0.top);
      if (hk) { state.cuts = { ...state.cuts, [hk]: 1 }; saveSettings(); draw3d(); return; }      // remove that cut
      pan = [0, 0, 0]; draw3d();
    });
    cutModeSel.addEventListener('change', () => { state.cutMode = cutModeSel.value; saveSettings(); draw3d(); });
    cutReset.addEventListener('click', () => { state.cuts = { x: 1, y: 1, z: 0 }; saveSettings(); draw3d(); });
    canvas.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      // zoom toward the point under the pointer: it stays put on the screen
      const minD = radius * 0.03, want = Math.min(radius * 12, dist * Math.exp(e.deltaY * 0.0012)), nd = Math.max(minD, want), k = 1 - nd / dist;
      const r = canvas.getBoundingClientRect(), nx = (e.clientX - r.left) / r.width * 2 - 1, ny = 1 - (e.clientY - r.top) / r.height * 2;
      if (camBasis && r.width && r.height) {
        const th = Math.tan(0.35), ox = nx * th * (r.width / r.height) * dist, oy = ny * th * dist, { x, y, z } = camBasis;
        for (let c = 0; c < 3; c++) pan[c] += (ox * x[c] + oy * y[c]) * k;
        if (want < minD && e.deltaY < 0) {
          // past the point zooming would stop: keep going, moving toward the pointer (through the part if need be)
          const dir = [0, 1, 2].map(c => -z[c] + nx * th * (r.width / r.height) * x[c] + ny * th * y[c]), l = Math.hypot(...dir), step = radius * 0.04 * Math.min(4, -e.deltaY / 100);
          for (let c = 0; c < 3; c++) pan[c] += dir[c] / l * step;
        }
      }
      dist = nd; draw3d();
    }, { passive: false });
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
      deg = Math.round(deg * 2) / 2;                 // half-degree steps
      state.viewAngle = ((deg % 360) + 360) % 360;
      const want = (state.viewAngle - 90) * Math.PI / 180, before = yaw;
      // keep yaw continuous (no jump of 2π while orbiting)
      yaw = keepYaw ? (deg - 90) * Math.PI / 180 : want + Math.round((yaw - want) / (2 * Math.PI)) * 2 * Math.PI;
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
        const W1 = 300, H1 = 26, c = compass1, x = c.getContext('2d');
        if (c.width !== W1 * dpr || c.height !== H1 * dpr) { c.width = W1 * dpr; c.height = H1 * dpr; }
        x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, W1, H1);
        x.fillStyle = 'rgba(255,255,255,.94)'; x.fillRect(0, 0, W1, H1);
        x.strokeStyle = '#ced4da'; x.strokeRect(0.5, 0.5, W1 - 1, H1 - 1);
        const PXD = 2.2, cx = W1 / 2;
        x.font = '10px sans-serif'; x.textAlign = 'center'; x.fillStyle = '#495057';
        for (let d = Math.floor((A - cx / PXD) / 5) * 5; d <= A + cx / PXD; d += 5) {
          const px = cx + (d - A) * PXD, major = ((d % 30) + 30) % 30 === 0;
          x.strokeStyle = major ? '#495057' : '#adb5bd'; x.beginPath(); x.moveTo(px + 0.5, H1); x.lineTo(px + 0.5, H1 - (major ? 9 : 5)); x.stroke();
          if (major) x.fillText(String(((d % 360) + 360) % 360) + '°', px, 11);
        }
        x.strokeStyle = '#e8590c'; x.lineWidth = 2; x.beginPath(); x.moveTo(cx, 0); x.lineTo(cx, H1); x.stroke(); x.lineWidth = 1;
        x.fillStyle = '#e8590c'; x.font = 'bold 10px sans-serif'; x.fillText(A.toFixed(1) + '°', cx + 22, H1 - 4);
      }
      compassDirty = true;
    }
    {
      let d1 = null;
      compass1.addEventListener('pointerdown', (e) => { d1 = e.clientX; compass1.setPointerCapture(e.pointerId); e.stopPropagation(); });
      compass1.addEventListener('pointermove', (e) => { if (d1 == null) return; setViewAngle(state.viewAngle - (e.clientX - d1) / 2.2); d1 = e.clientX; });
      compass1.addEventListener('pointerup', () => { d1 = null; });
      compass1.addEventListener('dblclick', (e) => { e.stopPropagation(); setViewAngle(Math.round(state.viewAngle / 15) * 15); });
    }
    drawCompasses();
    flipBox.addEventListener('change', () => { state.flip = flipBox.checked; saveSettings(); recalc(); });

    const ro = new ResizeObserver(() => { if (root.isConnected) { if (state.scene && !view) fit(); drawSection(); draw3d(); } });
    ro.observe(left); ro.observe(view3d);
    // property columns fold to one when the side bar gets narrow
    const roSide = new ResizeObserver(() => { const c = rightBar.clientWidth && rightBar.clientWidth < 560 ? 1 : 2; if (c !== pgridMaxCols && root.isConnected) renderSide(); else fitHeads(); });
    roSide.observe(rightBar);

    function render() {
      if (!root.isConnected) return;
      loading.style.display = state.scene ? 'none' : 'flex';
      if (state.scene) pruneSelection();
      if (!drag) drawSection();
      if (!drag || !drag.moved) renderSide(); else if (sideStatus) { const s = statusText(); sideStatus.textContent = s.text; sideStatus.style.color = s.color; }
      busyTag.textContent = state.busy ? 'Updating…' : '';
      if (state.preview) setMesh(state.preview);
      else if (triCount) { triCount = 0; lineCount = 0; shown = null; bbox = null; draw3d(); }
    }
    function destroy() { ro.disconnect(); roSide.disconnect(); window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', onKeyUp, true); root.remove(); }
    return { root, render, destroy, showSplash };
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
