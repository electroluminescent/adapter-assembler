# Adapter Assembler

A browser tool for designing threaded adapters, rings and gears as solids of revolution, and exporting them for 3D printing.

**App:** https://electroluminescent.github.io/adapter-assembler/

## Capabilities

### Objects

- **Circular rings** with separate inner and outer radii at the top and bottom, linked or independent.
- **N-sided rings** with any number of sides, measured across faces or corners, at any rotation.
- **Cogs**: involute spur gears with external or internal teeth. Tooth count, module, pressure angle, addendum, dedendum, backlash, tooth width and rotation are adjustable; tips and roots take tangent fillets; the bore and rim have their own radii. A cog can keep its size while its tooth count changes.
- **Threads**: true helical threads, male or female, right- or left-hand, with an ISO 60° profile (flats) or a sharp V, standard or custom depth, lead-in tapers at either end, fit clearance for printing and a solid backing.
- **Thread presets**: ISO metric small screws, tripod UNC, eyepiece and filter threads, T2/M42, M48, M54, M68, M78×0.75, refractor focusers, SCT, Takahashi, Astro-Physics and Tele Vue threads, or any diameter × pitch (mm or TPI).
- **Free-form outlines**: every object's profile is a set of points that can be moved, added and removed.
- **Bevels** on any corner: convex, concave, or an outward flare tangent to either adjoining edge, with a radius and segment count.
- **Radial cloners**: copies around the axis by count, distance, start angle and spread, standing upright or lying on their side.
- **Groups and booleans** (union, difference, intersection), nested to any depth.
- **Adapter builder**: an editable adapter between two threads of either gender, from a total length, wall thickness and lead-in tapers, with optional steep walls instead of right angles.
- **Per-object circular precision**, overriding the export setting.

### Cross-section editor

- **Radius/height view**: both sides of the axis at an adjustable section angle, with the inside of the part shaded behind the section.
- **Overhead view**: the part from above on a radial grid, with handles for points, radii, thread radii, n-sided corners, cog teeth (size, width, rotation, fillets) and cloner copies.
- **Linked views**: switching between the two keeps the radius and zoom, and puts the overhead view's section line where its height band's top sat in the radius/height view. The views can also be unlinked, each keeping its own position and zoom.
- **Height band**: the overhead view shows only a chosen range of heights. The range is set by a slider in either view or by dragging its lines in the radius/height view, and its ends snap to point heights.
- **Monomorphic drawing**: everything not selected is drawn as one grey shape taken from the finished solid, so unions, subtractions and intersections appear as they are built. From above it shows the solid's outline within the height band and only the edges visible from above. It can switch on by itself at 50% zoom or less.
- **Snapping** to points, edge midpoints, edge directions, the grid, circles and the height band's lines, including objects drawn monomorphic.
- **Selection transforms**: translate, scale and rotate about the selection's centre or the axis, plus arrow-key nudging, box selection, duplication and deletion.
- **Number fields** accept units (mm, cm, m, µm, in, ft, degrees, turns and others) and equations such as `73.5in/2 + 5mm`, with `+ − × ÷ ^`, `pi`, `sqrt`, `abs`, `sin`, `cos`, `tan`, fractions and mixed numbers.
- **Rulers and readouts**: radius and diameter along the bottom, heights up the side, the part's extents in bold, the pointer's coordinates, and the length and angle of selected edges.
- **Heights** measured from the lowest point up or from the top down.
- **Invert y axis** turns the part over in the 2D views, the 3D view and the exported file together; handles, snapping, transforms and height zero follow the part as shown.
- **Objects list**: a tree with connector lines and foldable groups, drag-and-drop regrouping and copying, boolean A/B slots and in-place renaming.
- **Undo and redo** for every edit.

### 3D view

- **Live preview** in perspective or orthographic projection, with ambient occlusion, an optional wireframe and highlighted problem edges.
- **Ground grid** with distance rings, an angle scale and rulers.
- **Slicing** on all three axes from both ends: six cut planes set by sliders or by handles on the model, turning with the view or fixed to the part, each axis independent of the others, with handles snapping to the origin. Cut faces are capped solid in their axis's colour, and the lines and points where cuts meet are outlined.
- **Orbit, pan and zoom**; turning the 3D view turns the cross-section's angle with it.

### Output and storage

- **STL or OBJ** in millimetres, for the whole scene or a single object, with OBJ faces as n-gons, quads or triangles.
- **Mesh checks**: vertices are welded, T-junctions repaired, and open or non-manifold edges reported.
- **Scene files**: the whole scene, one saved model or the whole saved-model library can be exported and imported as JSON.
- **Saved models**: a library of reusable parts kept in the browser.
- **Units**: lengths in millimetres or inches and angles in degrees or radians, for everything shown and typed.
- **Remembered in the browser**: the last scene, layout, view options and settings. Nothing is uploaded.

## Technical notes

- The app is static files and runs entirely in the browser; geometry is built in a Web Worker.
- It needs an http(s) origin, such as GitHub Pages or any local web server. It does not run from `file://`.
- Boolean operations use [Manifold](https://github.com/elalish/manifold) (Apache-2.0), loaded from jsDelivr.
