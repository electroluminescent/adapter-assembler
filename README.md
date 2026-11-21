# Adapter Assembler

A browser tool for designing threaded adapters, rings and gears, and exporting them for 3D printing.

**App:** https://electroluminescent.github.io/adapter-assembler/

## Objects

- #### **Radial rings**

  * Round rings with separate inner and outer radii at the top and bottom.

- #### **N-sided rings**

  * Rings with any number of sides.

- #### **Cogs**

  * Gears with external or internal teeth.

- #### **Threads**

  * Helical threads, male or female, right- or left-hand.
  * Each sized to take a standard thread of the other kind.
  * Presets for camera, telescope and screw threads, or any diameter × pitch.

- #### **Geometric objects**

  * Any flat shape seen from above, stood up between two heights.
  * Corners, edges and the whole shape dragged; corners added on edges, bevelled and deleted.
  * Placed by its centre, which stays the centroid of its shape.
  * In the radius/height view: its outline dashed, its section where the plane cuts it solid.
    * Its corners and edges can be picked there too: corners dragged, points added on edges.
    * A corner's top or bottom dragged across makes it lean (askew); up or down raises or lowers just that corner's end, making new faces.
    * Corners and edges lying over each other there move together (Alt: just the one); a double click on an edge adds a corner on each edge it covers, so both sides stay alike.
  * Turned about any of the three axes, with snapping.
  * Ctrl snaps its centre and corners to points, the grid, the axis and the slicer lines and heights.
    * In the radius/height view a corner also lines up level or upright with any other corner, its own included.

- #### **Outlines**

  * Every profile is editable point by point.
  * Corners bevel convex, concave or flared outward.

- #### **Symmetries**

  * Copies around the axis, upright or on their side.
  * Copies can turn with their place or keep their orientation.

- #### **Groups and booleans**

  * Union, difference and intersection, nested to any depth.

- #### **Adapter builder**

  * An editable adapter between two threads.

## Cross-section editor

- #### **Radius/height view**

  * The cross-section on both sides of the axis, at any section angle.

- #### **Overhead view**

  * The part from above, with handles for radii, corners, teeth and copies.

- #### **Linked views**

  * Switching views keeps the radius, zoom and looking height.

- #### **Height band**

  * Limits the overhead view to a range of heights.

- #### **Linked slicers**

  * The 2D height band and the 3D height slicer act as one.
  * The cross-section is cut where the blue slicer is, on or off the axis.
    * Monomorphic on: the part's section there, grey, to look at; geometric objects stay editable.
    * Monomorphic off: the objects stay editable, with that section dashed under them.
    * Geometric objects are cut where the blue slicer is.
    * The blue slicer keeps its place when the part changes size.

- #### **Monomorphic drawing**

  * Everything not selected as one grey shape, taken from the finished solid.

- #### **Measurement view**
  * The Measure button: rulers only; the part is drawn monomorphic, without the inner shading.
  * Drag to draw a ruler; Ctrl snaps its ends to the part's points (and lines them up level or upright).
  * Rulers show their length, and their angle unless it is square to the view; where two meet, the angle between them unless it is 90° or 180°.
  * Scroll while placing to switch between a ruler, an angle and a radius:
    * Angle: about the part's point nearest the start (from the view's level when started on one).
    * Radius: drag across an arc (a bevel, a cog's rounding) from one end to the other; its radius, with the centre marked.
  * Points show their place, (radius, height) or (radius, angle) from above; points, rulers, angles and radii each have their own colour, with a key at the top left.
  * Perfect: the part is rebuilt as fine as it goes (circles, threads, cogs) with round bevels as true arcs, and drawn from that (straight-sided shapes stay as they are; downloads are still built as set).
  * Nothing is repeated: a point put on another becomes that point, and a second ruler or angle between the same points is not added.
  * Shift-drag from a point starts a ruler there (a plain drag moves the point).
  * Labels keep clear of each other and of the rulers; where there is no room they become callouts, set off the part.
  * Rulers lying over each other are set apart, with extension lines.
  * Right-click: connect a point to another to chain rulers, label as a callout (drag the box), turn each datapoint on or off, delete, clear.
  * Pin a measurement (right-click it, right-click anywhere for all shown, or the Pin button):
    * From above: to the heights shown, marked beside the height slider (which snaps to them; click a mark to show them).
    * Radius/height: to the section angle; it shows only there, is marked on the compass (which snaps to it), and is counted above the compass's ends when out of its range (click to turn to it).
  * Points and callouts can be dragged; Delete removes the selected one; undoable.
  * Kept with the scene (saved, exported and reopened with it), each in its own view.
  * Export the drawing as PNG or PDF.
  * The axes stay readable over the drawing.

- #### **Move readout**

  * Distance and angle, or a radial or orthogonal vector, by the pointer while dragging.

- #### **Snapping**

  * To points, edges, the grid, circles and slicer lines.

- #### **Selection**

  * Translate, scale, rotate, nudge, duplicate and delete.

- #### **Number fields**

  * Units and equations, such as `73.5in/2 + 5mm`.

- #### **Rulers and readouts**

  * Radius, diameter, height, extents and pointer coordinates.

- #### **Heights**

  * Measured from the bottom up or the top down.
  * Invert y axis turns the part over in every view and in the export.

- #### **Objects list**

  * A foldable tree with drag-and-drop regrouping.
  * Switches on each row: shown in 2D, shown in 3D, can be picked; inherited by what a group holds.
    * Exports always include objects hidden in 3D.

- #### **Undo and redo**

  * For every edit.

## 3D view

- #### **Preview**

  * Perspective or orthographic, with ambient occlusion and wireframe.

- #### **Ground grid**

  * Distance rings, an angle scale and rulers.

- #### **Slicing**

  * Six cut planes, set by sliders or handles on the model.
  * Cut faces capped in their axis's colour.

- #### **Navigation**

  * Orbit, pan and zoom; the section angle turns with the view.
  * Ctrl while orbiting (3D view, compass, section knob) snaps to a step set in the project settings (15° by default).
  * The section compass fades out toward its ends.
  * Fit buttons for each view, and Frame all for both.

## Output and storage

- #### **Export**

  * STL, OBJ or STEP in millimetres, for the scene or one object.
    * STEP: a B-rep solid, each flat region one planar face (open parts as a surface model).

- #### **Mesh checks**

  * Welded, repaired and checked for open or non-manifold edges.
    * Objects are snapped to a 24 nm grid before they are combined, so faces meant to meet meet exactly (no slits or slivers).
    * Manifold collapses slivers itself; points are then set to the file's own precision and only float noise is welded (0.1 µin), so the file reads back closed.
    * OBJ n-gons are written only when convex with no straight corners (any program triangulates them the same way); STEP writes each separate body as its own solid.

- #### **Scene files**

  * Scenes and saved models as JSON.

- #### **Units**

  * Millimetres or inches; degrees or radians.

- #### **Storage**

  * Scene, layout and settings stay in the browser; nothing is uploaded.

## Technical notes

- #### **Runtime**

  * Static files, running entirely in the browser.
  * Needs an http(s) origin; it does not run from `file://`.

- #### **Credits**

  * Boolean operations use [Manifold](https://github.com/elalish/manifold) (Apache-2.0), loaded from jsDelivr.
