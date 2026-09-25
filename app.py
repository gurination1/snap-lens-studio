#!/usr/bin/env python3
"""
SnapAR Studio • Web Lens Tester & Inspector
Standalone Web Application for uploading, inspecting, and testing Snapchat .lns lenses live on camera.
Engine: Camera Kit WebGL2 (@snap/camera-kit@1.22.0) with Protobuf Sideload Extension
"""

import os
import sys
import json
import uuid
import time
import shutil
import hashlib
import zipfile
import argparse
from datetime import datetime
from flask import Flask, request, jsonify, render_template, send_from_directory, send_file
from werkzeug.utils import secure_filename

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
UPLOADS_DIR = os.path.join(BASE_DIR, "uploads")
SNAPS_DIR = os.path.join(BASE_DIR, "snaps")
SAMPLES_DIR = os.path.join(BASE_DIR, "static", "samples")
REGISTRY_FILE = os.path.join(UPLOADS_DIR, "registry.json")

os.makedirs(UPLOADS_DIR, exist_ok=True)
os.makedirs(SNAPS_DIR, exist_ok=True)
os.makedirs(SAMPLES_DIR, exist_ok=True)

app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["MAX_CONTENT_LENGTH"] = 120 * 1024 * 1024  # 120 MB max upload

# Built-in sample lenses
SAMPLE_LENSES = [
    {
        "id": "06ab0c08-158f-762e-8000-87bcd093434c",
        "name": "Abyssal Crown",
        "filename": "abyssal_crown.lns",
        "url": "/static/samples/abyssal_crown.lns",
        "icon_url": "/static/samples/abyssal_crown_icon.png",
        "sha256": "6ed4b8bd471563a78b9e3ca97e6139e7ff0fc6d08b1051c0c5b205ce2a0061cc",
        "is_sample": True,
        "description": "Snapchat Official 3D AR Crown with dynamic jewel lighting and face-tracking.",
        "activation_camera": "front"
    },
    {
        "id": "verdant_gilded",
        "name": "Verdant Gilded Tiara",
        "filename": "verdant_gilded.lns",
        "url": "/static/samples/verdant_gilded.lns",
        "icon_url": "/static/samples/verdant_gilded_icon.png",
        "sha256": "5e3073fef319837d20445c4040f7ec0c1bdea4bf0342bd11c532db8acdd736dc",
        "is_sample": True,
        "description": "High-poly emerald tiara with procedural sparkle shader and PBR materials.",
        "activation_camera": "front"
    }
]


def load_registry():
    if not os.path.exists(REGISTRY_FILE):
        return []
    try:
        with open(REGISTRY_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"[Registry Error] Failed to read registry: {e}", file=sys.stderr)
        return []


def save_registry(registry):
    with open(REGISTRY_FILE, "w", encoding="utf-8") as f:
        json.dump(registry, f, indent=2)


def inspect_lens_bundle(file_path):
    """Deep inspection of Snapchat .lns / .zip bundle."""
    with open(file_path, "rb") as f:
        sha256 = hashlib.sha256(f.read()).hexdigest()

    file_size = os.path.getsize(file_path)
    uncompressed_size = 0
    total_files = 0

    meshes = []
    textures = []
    shaders = []
    scripts = []
    audio = []
    other_files = []
    metainfo = {}
    manifest = []
    has_icon = False
    extracted_icon_filename = None

    try:
        with zipfile.ZipFile(file_path, "r") as z:
            namelist = z.namelist()
            total_files = len(namelist)

            # Check for icon.png or extract thumbnail
            if "icon.png" in namelist:
                has_icon = True
                icon_data = z.read("icon.png")
                icon_fn = f"icon_{sha256[:12]}.png"
                icon_dest = os.path.join(UPLOADS_DIR, icon_fn)
                with open(icon_dest, "wb") as icon_out:
                    icon_out.write(icon_data)
                extracted_icon_filename = icon_fn

            # Parse metainfo.json if present
            if "metainfo.json" in namelist:
                try:
                    metainfo = json.loads(z.read("metainfo.json").decode("utf-8", errors="ignore"))
                except Exception:
                    pass

            # Parse manifest.json if present
            if "manifest.json" in namelist:
                try:
                    manifest = json.loads(z.read("manifest.json").decode("utf-8", errors="ignore"))
                except Exception:
                    pass

            for info in z.infolist():
                uncompressed_size += info.file_size
                name = info.filename
                base = os.path.basename(name)
                if not base:
                    continue
                ext = os.path.splitext(name)[1].lower()

                item = {
                    "name": base,
                    "path": name,
                    "size_bytes": info.file_size,
                    "compressed_bytes": info.compress_size
                }

                if ext in [".mesh", ".glb", ".gltf", ".scn", ".t3d", ".ply"]:
                    meshes.append(item)
                elif ext in [".png", ".jpg", ".jpeg", ".webp", ".tga"]:
                    textures.append(item)
                elif ext in [".glsl", ".reflection", ".sceneshader"]:
                    shaders.append(item)
                elif ext in [".js", ".ts", ".gs"]:
                    scripts.append(item)
                elif ext in [".mp3", ".wav", ".ogg", ".aac"]:
                    audio.append(item)
                else:
                    other_files.append(item)

    except Exception as e:
        print(f"[Inspect Warning] Failed to inspect zip {file_path}: {e}", file=sys.stderr)

    return {
        "sha256": sha256,
        "size_bytes": file_size,
        "uncompressed_bytes": uncompressed_size,
        "compression_ratio": round((1 - (file_size / max(uncompressed_size, 1))) * 100, 1) if uncompressed_size > 0 else 0,
        "total_files": total_files,
        "has_icon": has_icon,
        "icon_filename": extracted_icon_filename,
        "activation_camera": metainfo.get("activation_camera", "front"),
        "hints": metainfo.get("additional_hint_ids", []),
        "manifest_assets": [m.get("id") for m in manifest if isinstance(m, dict) and "id" in m][:15],
        "counts": {
            "meshes": len(meshes),
            "textures": len(textures),
            "shaders": len(shaders),
            "scripts": len(scripts),
            "audio": len(audio),
            "others": len(other_files)
        },
        "sample_meshes": meshes[:20],
        "sample_textures": textures[:20],
        "sample_shaders": shaders[:20],
        "sample_scripts": scripts[:20]
    }


# Initialize sample lenses inspection data
for sample in SAMPLE_LENSES:
    sample_path = os.path.join(SAMPLES_DIR, sample["filename"])
    if os.path.exists(sample_path):
        sample["inspection"] = inspect_lens_bundle(sample_path)


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    response.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    return response


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/health")
def health():
    return jsonify({
        "status": "healthy",
        "engine": "Snapchat Camera Kit WebGL2 1.22.0",
        "service": "SnapAR Studio Web Lens Tester",
        "timestamp": time.time()
    })


@app.route("/api/lenses", methods=["GET"])
def get_lenses():
    """Return all available lenses (built-in samples + user uploads)."""
    user_lenses = load_registry()
    all_lenses = SAMPLE_LENSES + user_lenses
    return jsonify({
        "success": True,
        "lenses": all_lenses,
        "total": len(all_lenses)
    })


@app.route("/api/upload_lens", methods=["POST"])
def upload_lens():
    """Upload a new .lns or .zip lens bundle, inspect it, and register it."""
    if "file" not in request.files:
        return jsonify({"success": False, "error": "No file uploaded"}), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"success": False, "error": "Empty filename"}), 400

    filename = secure_filename(file.filename)
    if not (filename.lower().endswith(".lns") or filename.lower().endswith(".zip")):
        return jsonify({"success": False, "error": "Invalid format. Only .lns or .zip files accepted."}), 400

    lens_id = str(uuid.uuid4())
    clean_name = os.path.splitext(filename)[0].replace("_", " ").replace("-", " ").title()
    custom_name = request.form.get("name", "").strip()
    if custom_name:
        clean_name = custom_name

    saved_filename = f"{lens_id}_{filename}"
    file_path = os.path.join(UPLOADS_DIR, saved_filename)
    file.save(file_path)

    # Perform deep inspection
    inspection = inspect_lens_bundle(file_path)

    icon_url = None
    if inspection.get("icon_filename"):
        icon_url = f"/uploads/{inspection['icon_filename']}"

    lens_entry = {
        "id": lens_id,
        "name": clean_name,
        "filename": saved_filename,
        "url": f"/uploads/{saved_filename}",
        "icon_url": icon_url,
        "sha256": inspection["sha256"],
        "size_bytes": inspection["size_bytes"],
        "is_sample": False,
        "created_at": datetime.now().isoformat(),
        "activation_camera": inspection.get("activation_camera", "front"),
        "description": f"Custom uploaded lens bundle ({inspection['counts']['meshes']} meshes, {inspection['counts']['textures']} textures).",
        "inspection": inspection
    }

    # Save to registry
    registry = load_registry()
    registry.insert(0, lens_entry)
    save_registry(registry)

    return jsonify({
        "success": True,
        "message": f"Lens '{clean_name}' successfully parsed and ready for AR preview!",
        "lens": lens_entry
    })


@app.route("/api/lenses/<lens_id>", methods=["DELETE"])
def delete_lens(lens_id):
    """Delete an uploaded lens."""
    registry = load_registry()
    item_to_remove = None
    new_registry = []

    for item in registry:
        if item.get("id") == lens_id:
            item_to_remove = item
        else:
            new_registry.append(item)

    if not item_to_remove:
        return jsonify({"success": False, "error": "Lens not found or is a protected sample lens"}), 404

    # Remove file
    try:
        fn = item_to_remove.get("filename")
        if fn:
            p = os.path.join(UPLOADS_DIR, fn)
            if os.path.exists(p):
                os.remove(p)
        # Remove icon if present
        icon_fn = item_to_remove.get("inspection", {}).get("icon_filename")
        if icon_fn:
            ip = os.path.join(UPLOADS_DIR, icon_fn)
            if os.path.exists(ip):
                os.remove(ip)
    except Exception as e:
        print(f"[Delete Warning] Failed to delete file on disk: {e}", file=sys.stderr)

    save_registry(new_registry)
    return jsonify({"success": True, "message": "Lens deleted successfully"})


@app.route("/api/upload_media", methods=["POST"])
def upload_media():
    """Upload custom portrait video or image to test AR lens against."""
    if "media" not in request.files:
        return jsonify({"success": False, "error": "No media file provided"}), 400

    file = request.files["media"]
    filename = secure_filename(file.filename)
    ext = os.path.splitext(filename)[1].lower()
    if ext not in [".mp4", ".webm", ".mov", ".png", ".jpg", ".jpeg"]:
        return jsonify({"success": False, "error": "Unsupported media format"}), 400

    saved_fn = f"custom_media_{uuid.uuid4().hex[:8]}{ext}"
    dest = os.path.join(UPLOADS_DIR, saved_fn)
    file.save(dest)

    media_type = "video" if ext in [".mp4", ".webm", ".mov"] else "image"
    return jsonify({
        "success": True,
        "url": f"/uploads/{saved_fn}",
        "type": media_type,
        "name": filename
    })


@app.route("/api/save_snap", methods=["POST"])
def save_snap():
    """Save snap photo or recorded video snap."""
    snap_type = request.form.get("type", "photo")
    snap_id = uuid.uuid4().hex[:10]
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    if snap_type == "photo":
        image_data = request.form.get("image")
        if not image_data or not image_data.startswith("data:image/"):
            return jsonify({"success": False, "error": "Invalid image payload"}), 400

        header, encoded = image_data.split(",", 1)
        ext = ".png" if "png" in header else ".jpg"
        filename = f"snap_photo_{timestamp}_{snap_id}{ext}"
        dest = os.path.join(SNAPS_DIR, filename)

        import base64
        # Fix URL encoding issues (spaces to +) and padding
        clean_encoded = encoded.replace(" ", "+")
        missing_padding = len(clean_encoded) % 4
        if missing_padding:
            clean_encoded += "=" * (4 - missing_padding)

        with open(dest, "wb") as f:
            f.write(base64.b64decode(clean_encoded))

        return jsonify({
            "success": True,
            "filename": filename,
            "url": f"/snaps/{filename}",
            "type": "photo"
        })

    elif snap_type == "video":
        if "video" not in request.files:
            return jsonify({"success": False, "error": "No video file attached"}), 400
        vid_file = request.files["video"]
        filename = f"snap_video_{timestamp}_{snap_id}.webm"
        dest = os.path.join(SNAPS_DIR, filename)
        vid_file.save(dest)

        return jsonify({
            "success": True,
            "filename": filename,
            "url": f"/snaps/{filename}",
            "type": "video"
        })

    return jsonify({"success": False, "error": "Unknown snap type"}), 400


@app.route("/api/snaps", methods=["GET"])
def get_snaps():
    """Return all recorded snaps."""
    snaps = []
    if os.path.exists(SNAPS_DIR):
        for f in sorted(os.listdir(SNAPS_DIR), reverse=True):
            if f.startswith("snap_"):
                ext = os.path.splitext(f)[1].lower()
                snaps.append({
                    "filename": f,
                    "url": f"/snaps/{f}",
                    "type": "video" if ext in [".webm", ".mp4"] else "photo",
                    "timestamp": os.path.getmtime(os.path.join(SNAPS_DIR, f))
                })
    return jsonify({"success": True, "snaps": snaps})


@app.route("/uploads/<path:filename>")
def serve_upload(filename):
    return send_from_directory(UPLOADS_DIR, filename, as_attachment=False)


@app.route("/snaps/<path:filename>")
def serve_snap(filename):
    return send_from_directory(SNAPS_DIR, filename, as_attachment=False)


def main():
    default_port = int(os.environ.get("PORT", 8888))
    default_host = os.environ.get("HOST", "0.0.0.0")
    parser = argparse.ArgumentParser(description="SnapAR Studio Web Lens Tester")
    parser.add_argument("--port", type=int, default=default_port, help=f"Port to bind server (default: {default_port})")
    parser.add_argument("--host", type=str, default=default_host, help=f"Host interface (default: {default_host})")
    args = parser.parse_args()

    print("=" * 70)
    print("👻  SnapAR Studio • Web Lens Tester & Inspector")
    print(f"📡  Server listening on: http://{args.host}:{args.port}")
    print(f"📁  Uploads directory:   {UPLOADS_DIR}")
    print(f"🎬  Snaps directory:     {SNAPS_DIR}")
    print(f"✨  Camera Kit Web SDK:  @snap/camera-kit@1.22.0 (WebGL2 Sideloading)")
    print("=" * 70)

    app.run(host=args.host, port=args.port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
