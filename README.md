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
  * Turned about any of the three axes, with snapping.
  * Ctrl snaps its centre and corners to points, the grid, the axis and the slicer lines and heights.

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

  * STL or OBJ in millimetres, for the scene or one object.

- #### **Mesh checks**

  * Welded, repaired and checked for open or non-manifold edges.

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
