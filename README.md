# Adapter Assembler

Design threaded adapters (telescope, camera and filter threads) in the browser and export them as STL or OBJ for 3D printing.

**Open the app:** https://electroluminescent.github.io/adapter-assembler/

## Features

- **Adapter assembler:** pick thread A and thread B (male or female, from presets or any diameter × pitch), a total length and wall thickness, and get an editable adapter with lead-in tapers.
- **Editor:** a cross-section view with circles, n-sided shapes, helical thread objects, radial cloners, groups and booleans (union, difference, intersection), bevels, snapping, undo/redo.
- **3D view:** a live preview with perspective or orthographic projection, ambient occlusion, a wireframe, X/Y/Z cut planes, a radial ground grid and highlighted problem edges.
- **Thread presets:** ISO metric small screws, tripod UNC, eyepiece and filter threads, T2/M42, M48, M54, M68, M78×0.75 and other focuser, SCT, Takahashi and TeleVue threads.
- **Units:** lengths in millimetres or inches and angles in degrees or radians, for everything shown and typed (files are always in millimetres).
- **Export:** STL or OBJ in millimetres, checked for watertightness. Scenes and saved models can be exported and imported as JSON.
- **Storage:** your last scene, settings and saved models stay in this browser's local storage. Nothing is uploaded.

## Running locally

The app is static files. Serve the folder with any web server, e.g. `python3 -m http.server`, and open `http://localhost:8000/`. Opening `index.html` straight from disk is not supported, because the geometry worker needs an http(s) origin.

## Credits

Boolean operations use [Manifold](https://github.com/elalish/manifold) (Apache-2.0), loaded from jsDelivr.
