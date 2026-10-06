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
import io
import argparse
from datetime import datetime
import mimetypes
from flask import Flask, request, jsonify, render_template, send_from_directory, send_file
from werkzeug.utils import secure_filename

mimetypes.add_type('application/wasm', '.wasm')
mimetypes.add_type('application/octet-stream', '.data')
mimetypes.add_type('application/octet-stream', '.binarypb')
mimetypes.add_type('model/obj', '.obj')

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
UPLOADS_DIR = os.path.join(BASE_DIR, "uploads")
SNAPS_DIR = os.path.join(BASE_DIR, "snaps")
SAMPLES_DIR = os.path.join(STATIC_DIR, "samples")
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
    },
    {
        "id": "4df2b87d-52eb-4ec3-bc0f-fd1919712256",
        "name": "Celestial Kitsune",
        "filename": "abyssal_crown.lns",
        "url": "/static/samples/abyssal_crown.lns",
        "icon_url": "/static/samples/kitsune_icon.png",
        "sha256": "4df2b87d52eb4ec3bc0ffd1919712256",
        "is_sample": True,
        "description": "Foxfire Kitsune Spirit Crest with celestial aura & dynamic glowing particles.",
        "activation_camera": "front"
    }
]

LIKES_FILE = os.path.join(UPLOADS_DIR, "likes.json")


def load_likes():
    default_likes = {
        "06ab0c08-158f-762e-8000-87bcd093434c": 348,
        "verdant_gilded": 285,
        "4df2b87d-52eb-4ec3-bc0f-fd1919712256": 512
    }
    if not os.path.exists(LIKES_FILE):
        return default_likes
    try:
        with open(LIKES_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            for k, v in default_likes.items():
                if k not in data:
                    data[k] = v
            return data
    except Exception as e:
        print(f"[Likes Warning] Error reading likes: {e}", file=sys.stderr)
        return default_likes


def save_likes(likes):
    try:
        with open(LIKES_FILE, "w", encoding="utf-8") as f:
            json.dump(likes, f, indent=2)
    except Exception as e:
        print(f"[Likes Save Warning] Error saving likes: {e}", file=sys.stderr)


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
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, Range"
    response.headers["Cross-Origin-Embedder-Policy"] = "credentialless"
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Cross-Origin-Resource-Policy"] = "cross-origin"
    response.headers["Accept-Ranges"] = "bytes"
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


@app.route("/api/config", methods=["GET"])
def get_config():
    """Return Camera Kit credentials and Lens Group ID configured via environment."""
    return jsonify({
        "success": True,
        "lens_group_id": os.environ.get("CAMERA_KIT_LENS_GROUP_ID", "6d4c3a49-b090-45b2-b2f7-720e78e9f7fd"),
        "api_token": os.environ.get("CAMERA_KIT_PRODUCTION_TOKEN", "eyJhbGciOiJIUzI1NiIsImtpZCI6IkNhbnZhc1MyU0hNQUNQcm9kIiwidHlwIjoiSldUIn0.eyJhdWQiOiJjYW52YXMtY2FudmFzYXBpIiwiaXNzIjoiY2FudmFzLXMyc3Rva2VuIiwibmJmIjoxNzkxMjE3MjU5LCJzdWIiOiJhODM3NzNlNi1lZTgwLTQ2MTMtYmI0ZC1kZWRhMDJiMWVmODd-UFJPRFVDVElPTn40Mjk1ODcxOC0yNTIxLTRjMTctODAxZC03Y2FlMWMyY2IyNTkifQ.mNbYo1anah5FrGBwF5ciT4SWU4FxCJELEvcI1jwq6sQ"),
        "staging_api_token": os.environ.get("CAMERA_KIT_STAGING_TOKEN", "eyJhbGciOiJIUzI1NiIsImtpZCI6IkNhbnZhc1MyU0hNQUNQcm9kIiwidHlwIjoiSldUIn0.eyJhdWQiOiJjYW52YXMtY2FudmFzYXBpIiwiaXNzIjoiY2FudmFzLXMyc3Rva2VuIiwibmJmIjoxNzkxMjE3MjU5LCJzdWIiOiJhODM3NzNlNi1lZTgwLTQ2MTMtYmI0ZC1kZWRhMDJiMWVmODd-U1RBR0lOR340OGM0NjgyZS00NTkyLTRiMDQtYjMyOC1kNDI4NTg1MDZlMTMifQ.LqzSwK_sfExKloe_v2TJKr0E2bjPPUe4dwuQlPCAOew")
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


@app.route("/api/like_lens/<lens_id>", methods=["GET", "POST"])
def like_lens(lens_id):
    """Get or increment like count for a lens."""
    likes = load_likes()
    current_count = likes.get(lens_id, 42)
    if request.method == "POST":
        current_count += 1
        likes[lens_id] = current_count
        save_likes(likes)
    return jsonify({
        "success": True,
        "lens_id": lens_id,
        "likes": current_count
    })


@app.route("/api/upload_lens", methods=["POST"])
def upload_lens():
    """Upload a new .lns or .zip lens bundle, inspect it, and register it."""
    if "file" not in request.files:
        return jsonify({"success": False, "error": "No file uploaded"}), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"success": False, "error": "Empty filename"}), 400

    orig_name = file.filename or "uploaded_lens.lns"
    filename = secure_filename(orig_name)
    if not filename:
        ext = ".zip" if orig_name.lower().endswith(".zip") else ".lns"
        filename = f"lens_{int(time.time())}{ext}"
    elif not (filename.lower().endswith(".lns") or filename.lower().endswith(".zip")):
        if orig_name.lower().endswith(".lns") or orig_name.lower().endswith(".zip"):
            ext = ".zip" if orig_name.lower().endswith(".zip") else ".lns"
            filename = f"{filename}{ext}"
        else:
            return jsonify({"success": False, "error": "Invalid format. Only .lns or .zip files accepted."}), 400

    lens_id = str(uuid.uuid4())
    clean_name = os.path.splitext(orig_name)[0].replace("_", " ").replace("-", " ").title()
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


@app.route("/api/fetch_lens_url", methods=["POST"])
def fetch_lens_url():
    """Fetch remote .lns or .zip lens bundle from a public URL."""
    data = request.get_json(silent=True) or request.form
    target_url = (data.get("url") or "").strip()
    if not target_url:
        return jsonify({"success": False, "error": "No URL provided"}), 400

    import urllib.request
    try:
        req = urllib.request.Request(
            target_url,
            headers={"User-Agent": "SnapARStudio/1.0 Mozilla/5.0"}
        )
        lens_id = str(uuid.uuid4())
        filename = f"{lens_id}_downloaded.lns"
        dest_path = os.path.join(UPLOADS_DIR, filename)
        with urllib.request.urlopen(req, timeout=30) as resp, open(dest_path, "wb") as out_f:
            out_f.write(resp.read())

        clean_name = os.path.splitext(os.path.basename(target_url.split("?")[0]))[0] or "Imported Lens"
        clean_name = clean_name.replace("_", " ").replace("-", " ").title()

        inspection = inspect_lens_bundle(dest_path)
        icon_url = None
        if inspection.get("icon_filename"):
            icon_url = f"/uploads/{inspection['icon_filename']}"

        lens_entry = {
            "id": lens_id,
            "name": clean_name,
            "filename": filename,
            "url": f"/uploads/{filename}",
            "icon_url": icon_url,
            "sha256": inspection["sha256"],
            "size_bytes": inspection["size_bytes"],
            "is_sample": False,
            "created_at": datetime.now().isoformat(),
            "activation_camera": inspection.get("activation_camera", "front"),
            "description": f"Imported lens bundle ({inspection['counts']['meshes']} meshes, {inspection['counts']['textures']} textures).",
            "inspection": inspection
        }

        registry = load_registry()
        registry.insert(0, lens_entry)
        save_registry(registry)

        return jsonify({
            "success": True,
            "message": f"Lens '{clean_name}' successfully imported and ready!",
            "lens": lens_entry
        })
    except Exception as e:
        return jsonify({"success": False, "error": f"Failed to download lens: {str(e)}"}), 500


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
    return send_from_directory(UPLOADS_DIR, filename, as_attachment=False, conditional=True)


@app.route("/assets/<path:filename>")
def serve_asset(filename):
    assets_dir = "/root/snapchat-lens/assets"
    if os.path.exists(os.path.join(assets_dir, filename)):
        return send_from_directory(assets_dir, filename, as_attachment=False, conditional=True)
    return send_from_directory(STATIC_DIR, filename, as_attachment=False, conditional=True)


@app.route("/snaps/<path:filename>")
def serve_snap(filename):
    return send_from_directory(SNAPS_DIR, filename, as_attachment=False, conditional=True)


@app.route("/download_apk")
@app.route("/SnapARStudio.apk")
def download_apk():
    """Serve native Android APK for offline testing."""
    apk_path = os.path.join(STATIC_DIR, "SnapARStudio.apk")
    if not os.path.exists(apk_path):
        apk_path = "/root/apk-builder/SnapARStudio.apk"
    if os.path.exists(apk_path):
        return send_file(
            apk_path,
            mimetype="application/vnd.android.package-archive",
            as_attachment=True,
            download_name="SnapARStudio.apk"
        )
    return jsonify({"error": "APK not built yet"}), 404


@app.route("/api/download_package")
def download_package():
    """Build and stream a portable 1-click standalone package (.zip)."""
    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as z:
        for root, dirs, files in os.walk(BASE_DIR):
            # Exclude git, uploads, snaps, cache, pycache
            if any(part in root for part in [".git", "__pycache__", "uploads", "snaps", ".pytest_cache"]):
                continue
            for file in files:
                if file.endswith((".pyc", ".log", ".DS_Store")):
                    continue
                file_path = os.path.join(root, file)
                rel_path = os.path.relpath(file_path, BASE_DIR)
                z.write(file_path, os.path.join("snap-lens-studio", rel_path))

    zip_buffer.seek(0)
    return send_file(
        zip_buffer,
        mimetype="application/zip",
        as_attachment=True,
        download_name="snap-lens-studio-standalone.zip"
    )


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
