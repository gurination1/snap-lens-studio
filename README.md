# SnapAR Studio • Web Lens Tester & Inspector

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/new)
[![Live Demo](https://img.shields.io/badge/Live%20Demo-Online-00e676?style=flat&logo=snapchat)](https://snap-lens-studio-production.up.railway.app)
[![Camera Kit](https://img.shields.io/badge/Camera%20Kit-v1.22.0%20WebGL2-fffc00?style=flat)](https://camera-kit.snap.com/)

A standalone, production-grade Snapchat Web AR Lens Testing Suite built with **Snapchat Camera Kit WebGL2 (`@snap/camera-kit@1.22.0`)**.

Upload any Snapchat `.lns` (or `.zip`) lens bundle, inspect its 3D assets, textures, and shaders, and test it live on your webcam or model video feed just like the Snapchat app!

---

## 🌐 Instant Cloud Access (Zero Install)

- **Production Web App (Permanent 24/7)**:
  👉 [https://snap-lens-studio-production.up.railway.app](https://snap-lens-studio-production.up.railway.app)
- **Direct Package Download (1-Click Run)**:
  👉 [Download `snap-lens-studio-standalone.zip`](https://snap-lens-studio-production.up.railway.app/api/download_package)

*(HTTPS required by mobile Safari & Chrome for camera / microphone permissions).*

---

## 🚀 1-Click Local Execution (Download & Double-Click)

### 🪟 Windows Users:
1. Download or clone this repository / extract zip.
2. Double-click `start.bat`.
   - Automatically installs requirements if missing.
   - Automatically opens your default web browser on `http://localhost:8888`.
   - Starts testing immediately!

### 🍎 Mac & 🐧 Linux Users:
1. Download or clone this repository / extract zip.
2. Open terminal in folder and run:
   ```bash
   chmod +x start.sh && ./start.sh
   ```
   - Automatically checks dependencies and launches browser.

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

## Directory Structure
```
snap-lens-studio/
├── start.bat                   # 🪟 Windows 1-click double-click launcher
├── start.sh                    # 🍎 Mac / 🐧 Linux 1-click launcher
├── app.py                      # Flask REST API backend & bundle inspector
├── Procfile                    # Cloud deploy manifest (Railway / Heroku)
├── requirements.txt            # Python dependencies (Flask, gunicorn)
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
