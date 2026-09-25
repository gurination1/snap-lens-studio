# SnapAR Studio • Web Lens Tester & Inspector

A standalone, production-grade Snapchat Web AR Lens Testing Suite built with **Snapchat Camera Kit WebGL2 (`@snap/camera-kit@1.22.0`)**.

Upload any Snapchat `.lns` (or `.zip`) lens bundle, inspect its 3D assets, textures, and shaders, and test it live on your webcam or model video feed just like the Snapchat app!

---

## Key Features

1. **True WebGL2 Camera Kit Sideloading**:
   - Direct binary Protobuf sideloading extension (`lens-sideload-extension-group`).
   - Dynamic SHA256 checksum computation and wire-type varint encoding.
   - Sideloads and executes any compiled `.lns` bundle in real-time.

2. **Drag & Drop Lens Upload**:
   - Drop any `.lns` or `.zip` file onto the dropzone.
   - Automatically unpacks manifest, calculates SHA-256 hash, extracts embedded `icon.png`, and registers into the live session.
   - Instant hot-swap: newly uploaded lens is immediately applied onto the live camera stream.

3. **Snapchat-Style Shutter & Capture**:
   - **Photo Snap**: Single tap on white shutter button triggers flash effect, shutter sound, high-res PNG export, and instant preview/download.
   - **Video Snap**: Press & hold shutter button to record up to 10 seconds of WebM/MP4 video with animated Snapchat circular yellow progress ring and audio.
   - **Snaps Gallery**: Browse and download all captured photo and video snaps.

4. **Multi-Source Camera Engine**:
   - **Live WebCam** with Anti-Zoom Smart Fit (zero 3.16x crop distortion) and horizontal mirror toggle.
   - **Stock Model Video 1** (Canonical portrait video @ 720x1280 30fps).
   - **Stock Model Video 2** (Cyber blonde portrait video).
   - **Frame 0 Portrait Photo** (Static studio portrait for still AR testing).
   - **Custom Media Upload** (Upload your own video or photo to test against).

5. **Deep Lens Inspector**:
   - Uncompressed vs compressed size stats & compression ratio.
   - 3D Meshes breakdown (`.mesh`, `.glb`, `.gltf`, `.scn`, `.t3d`).
   - Textures & materials breakdown (`.png`, `.jpg`, `.jpeg`).
   - Shaders & GLSL code count (`.glsl`, `.reflection`).
   - JavaScript bytecode & manifest capabilities (`Face Mesh V3`, `Segmentation Binary Body`).
   - SHA-256 integrity hash verification.

6. **Interactive Split Slider**:
   - Compare raw camera input vs active AR lens effect with a draggable split handle.

---

## Quick Start

### 1. Launch Server
```bash
cd /root/snap-lens-tester
./run.sh 8888
# or: python3 app.py --port 8888
```

### 2. Open in Browser
Open `http://localhost:8888` in your browser.

---

## Directory Structure
```
/root/snap-lens-tester/
├── app.py                      # Flask REST API backend & bundle inspector
├── run.sh                       # Start script (defaults to port 8888)
├── static/
│   ├── js/
│   │   ├── camera-kit.bundle.js # Official Camera Kit 1.22.0 bundle
│   │   └── studio.js            # Frontend logic & Camera Kit sideload provider
│   ├── css/
│   │   └── studio.css           # Dark luxury AR studio theme
│   └── samples/                 # Sample lenses & test portrait videos
│       ├── abyssal_crown.lns
│       ├── verdant_gilded.lns
│       ├── test_portrait.mp4
│       └── portrait_neutral.png
├── templates/
│   └── index.html               # Snapchat Web AR Studio interface
├── uploads/                     # Uploaded user lenses & extracted icons
├── snaps/                       # Captured photos and video recordings
└── README.md
```
