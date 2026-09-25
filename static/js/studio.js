/**
 * SnapAR Studio • Web Lens Tester & Live Inspector
 * Engine: Snapchat Camera Kit WebGL2 1.22.0
 */

// Global State
let ckInstance = null;
let ckSession = null;
let ckActiveSource = 'webcam'; // 'webcam', 'model1', 'model2', 'photo', 'custom'
let ckFramingMode = 'fit'; // 'fit' (zero zoom) or 'crop' (fill zoom)
let ckIsMirrored = true;
let ckCurrentLensId = "06ab0c08-158f-762e-8000-87bcd093434c";
let webcamStream = null;
let cropAnimFrameId = null;
let customMediaUrl = null;
let customMediaType = null;

// Registry of sideloaded lenses
const sideloadedLenses = new Map();
let loadedLensesList = [];

// Protobuf Encoder for Sideloading .lns Bundles
function encodeVarint(val) {
  const bytes = [];
  while (val > 127) {
    bytes.push((val & 127) | 128);
    val >>>= 7;
  }
  bytes.push(val);
  return bytes;
}

function encodeField(fieldNum, wireType, dataBytes) {
  const tag = (fieldNum << 3) | wireType;
  return [...encodeVarint(tag), ...dataBytes];
}

function encodeStringField(fieldNum, str) {
  const strBytes = Array.from(new TextEncoder().encode(str));
  return encodeField(fieldNum, 2, [...encodeVarint(strBytes.length), ...strBytes]);
}

function encodeMessageField(fieldNum, msgBytes) {
  return encodeField(fieldNum, 2, [...encodeVarint(msgBytes.length), ...msgBytes]);
}

function createLensProto({ id, name, lnsUrl, sha256, iconUrl }) {
  const content = [
    ...encodeStringField(1, lnsUrl),
    ...encodeStringField(2, sha256 || ""),
    ...encodeStringField(3, iconUrl || ""),
    ...encodeStringField(8, lnsUrl),
    ...encodeStringField(9, iconUrl || "")
  ];
  const lens = [
    ...encodeStringField(1, id),
    ...encodeStringField(2, name),
    ...encodeMessageField(4, content)
  ];
  return new Uint8Array(encodeMessageField(1, lens));
}

// Shutter Interaction State (Tap for Photo, Hold for Video)
let isPressingShutter = false;
let shutterPressTimer = null;
let isRecordingVideo = false;
let mediaRecorder = null;
let recordedChunks = [];
let recordStartTime = 0;
let recordAnimFrame = null;
const MAX_RECORD_SECONDS = 10;

// FPS & Diagnostics
let lastFrameTime = performance.now();
let frameCount = 0;
let currentFps = 60;

// Initialize on DOM Ready
document.addEventListener('DOMContentLoaded', async () => {
  setupTabs();
  setupDropzone();
  setupShutter();
  setupSplitSlider();
  setupPwa();
  await fetchLenses();
  await initCameraKit();
  startFpsMonitor();
  loadSnapsGallery();
});

// PWA Service Worker & Install Prompt
let deferredPrompt = null;
function setupPwa() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/static/sw.js')
      .then(reg => console.log('[PWA] Service Worker registered:', reg.scope))
      .catch(err => console.warn('[PWA] Service Worker registration failed:', err));
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const installBtn = document.getElementById('pwa-install-btn');
    if (installBtn) installBtn.style.display = 'inline-flex';
  });

  window.triggerPwaInstall = async () => {
    if (!deferredPrompt) {
      alert('To install as an app on your phone, open browser menu (⋮ or Share) and tap "Add to Home Screen" or "Install App". It runs offline with 100% local GPU power!');
      return;
    }
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    console.log('[PWA] User response:', outcome);
    deferredPrompt = null;
    const installBtn = document.getElementById('pwa-install-btn');
    if (installBtn) installBtn.style.display = 'none';
  };
}

// Tab Switcher
function setupTabs() {
  window.switchTab = (tabName) => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    const activeBtn = document.getElementById(`tab-btn-${tabName}`);
    const activeContent = document.getElementById(`tab-${tabName}`);
    if (activeBtn) activeBtn.classList.add('active');
    if (activeContent) activeContent.classList.add('active');
  };
}

window.triggerLensUpload = function() {
  if (typeof window.switchTab === 'function') {
    window.switchTab('upload');
  }
  const input = document.getElementById('lens-file-input');
  if (input) {
    try { input.value = ''; } catch (_) {}
    input.click();
  }
  const dz = document.getElementById('lens-dropzone');
  if (dz) {
    dz.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
};
window.focusUpload = window.triggerLensUpload;

// Fetch lenses from backend
async function fetchLenses() {
  try {
    const res = await fetch('/api/lenses');
    const data = await res.json();
    if (data.success && data.lenses) {
      loadedLensesList = data.lenses;

      data.lenses.forEach(l => {
        sideloadedLenses.set(l.id, {
          id: l.id,
          name: l.name,
          lnsUrl: window.location.origin + l.url,
          sha256: l.sha256,
          iconUrl: l.icon_url ? window.location.origin + l.icon_url : null
        });
      });

      renderLensesList();
      renderCarousel();
      updateInspector(data.lenses.find(l => l.id === ckCurrentLensId) || data.lenses[0]);
    }
  } catch (err) {
    console.error('[Fetch Lenses Error]', err);
  }
}

// Render Lenses in Right Panel
function renderLensesList() {
  const container = document.getElementById('lenses-list');
  const countBadge = document.getElementById('lenses-total-badge');
  if (!container) return;

  container.innerHTML = '';
  countBadge.textContent = `${loadedLensesList.length} Lenses`;

  loadedLensesList.forEach(lens => {
    const item = document.createElement('div');
    item.className = `lens-card ${lens.id === ckCurrentLensId ? 'active' : ''}`;
    item.onclick = () => selectLens(lens.id);

    const iconSrc = lens.icon_url || '/static/samples/abyssal_crown_icon.png';
    const sizeMb = lens.size_bytes ? (lens.size_bytes / (1024 * 1024)).toFixed(2) + ' MB' : 'Built-in';
    const tag = lens.is_sample ? 'Sample' : 'Uploaded';

    item.innerHTML = `
      <div class="lens-card-info">
        <img class="lens-card-icon" src="${iconSrc}" alt="${lens.name}">
        <div class="lens-card-details">
          <span class="lens-card-name">${lens.name}</span>
          <span class="lens-card-meta">${sizeMb} • ${lens.inspection?.counts?.meshes || 0} Meshes • ${lens.inspection?.counts?.textures || 0} Textures</span>
        </div>
      </div>
      <div class="lens-card-actions">
        <span class="lens-tag-pill">${tag}</span>
        ${!lens.is_sample ? `<button class="btn-del-lens" title="Delete lens" onclick="deleteLens(event, '${lens.id}')">🗑</button>` : ''}
      </div>
    `;
    container.appendChild(item);
  });
}

// Render Snapchat Bottom Lens Carousel
function renderCarousel() {
  const carousel = document.getElementById('lens-carousel');
  if (!carousel) return;

  carousel.innerHTML = '';

  // Add Upload Shortcut Pill
  const uploadPill = document.createElement('div');
  uploadPill.className = 'carousel-lens-item carousel-upload-btn';
  uploadPill.title = 'Upload New Lens';
  uploadPill.innerHTML = '+';
  uploadPill.onclick = (e) => {
    e.stopPropagation();
    window.triggerLensUpload();
  };
  carousel.appendChild(uploadPill);

  loadedLensesList.forEach(lens => {
    const pill = document.createElement('div');
    pill.className = `carousel-lens-item ${lens.id === ckCurrentLensId ? 'active' : ''}`;
    pill.title = lens.name;
    pill.onclick = () => selectLens(lens.id);

    const iconSrc = lens.icon_url || '/static/samples/abyssal_crown_icon.png';
    pill.innerHTML = `<img class="carousel-lens-img" src="${iconSrc}" alt="${lens.name}">`;
    carousel.appendChild(pill);
  });
}

// Select and apply a lens
async function selectLens(lensId) {
  ckCurrentLensId = lensId;

  // Update carousel active state
  renderCarousel();
  renderLensesList();

  const lensMeta = loadedLensesList.find(l => l.id === lensId);
  if (lensMeta) {
    updateInspector(lensMeta);
    updateHudLens(lensMeta);
  }

  await applyCurrentLens();
}

function updateHudLens(lensMeta) {
  const nameEl = document.getElementById('hud-lens-name');
  const iconEl = document.getElementById('hud-lens-icon');
  const statusEl = document.getElementById('hud-lens-status');

  if (nameEl) nameEl.textContent = lensMeta.name;
  if (iconEl && lensMeta.icon_url) iconEl.src = lensMeta.icon_url;
  if (statusEl) statusEl.textContent = '3D AR Active';
}

// Delete custom uploaded lens
async function deleteLens(e, lensId) {
  e.stopPropagation();
  if (!confirm('Are you sure you want to delete this custom lens?')) return;

  try {
    const res = await fetch(`/api/lenses/${lensId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      if (ckCurrentLensId === lensId) {
        ckCurrentLensId = "06ab0c08-158f-762e-8000-87bcd093434c";
      }
      await fetchLenses();
      await applyCurrentLens();
    }
  } catch (err) {
    console.error('[Delete Lens Error]', err);
  }
}

// Deep Inspector Update
function updateInspector(lens) {
  if (!lens) return;

  const inspName = document.getElementById('insp-name');
  const inspId = document.getElementById('insp-id');
  const inspDesc = document.getElementById('insp-desc');
  const inspIcon = document.getElementById('insp-icon');
  const inspBadge = document.getElementById('insp-badge');
  const inspSize = document.getElementById('insp-size');
  const inspFiles = document.getElementById('insp-files');
  const inspSha256 = document.getElementById('insp-sha256');

  if (inspName) inspName.textContent = lens.name;
  if (inspId) inspId.textContent = `ID: ${lens.id}`;
  if (inspDesc) inspDesc.textContent = lens.description || 'Snapchat compiled AR Lens bundle.';
  if (inspIcon) inspIcon.src = lens.icon_url || '/static/samples/abyssal_crown_icon.png';
  if (inspBadge) inspBadge.textContent = lens.is_sample ? 'Official Bundle' : 'Custom Upload';
  if (inspSha256) inspSha256.textContent = lens.sha256 || 'N/A';

  const insp = lens.inspection || {};
  if (inspSize) inspSize.textContent = (lens.size_bytes ? (lens.size_bytes / (1024 * 1024)).toFixed(2) + ' MB' : 'N/A');
  if (inspFiles) inspFiles.textContent = insp.total_files || 'N/A';

  // Counts
  const counts = insp.counts || {};
  const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setEl('insp-meshes-count', counts.meshes || 0);
  setEl('insp-textures-count', counts.textures || 0);
  setEl('insp-shaders-count', counts.shaders || 0);
  setEl('insp-scripts-count', counts.scripts || 0);

  // Mesh list
  const meshesUl = document.getElementById('insp-meshes-list');
  if (meshesUl) {
    meshesUl.innerHTML = '';
    const sampleMeshes = insp.sample_meshes || [];
    if (sampleMeshes.length > 0) {
      sampleMeshes.forEach(m => {
        const li = document.createElement('li');
        li.className = 'asset-pill';
        li.textContent = `${m.name} (${(m.size_bytes / 1024).toFixed(0)} KB)`;
        meshesUl.appendChild(li);
      });
    } else {
      meshesUl.innerHTML = '<li class="asset-pill">No standalone 3D meshes detected</li>';
    }
  }

  // Textures list
  const texturesUl = document.getElementById('insp-textures-list');
  if (texturesUl) {
    texturesUl.innerHTML = '';
    const sampleTextures = insp.sample_textures || [];
    if (sampleTextures.length > 0) {
      sampleTextures.forEach(t => {
        const li = document.createElement('li');
        li.className = 'asset-pill';
        li.textContent = `${t.name} (${(t.size_bytes / 1024).toFixed(0)} KB)`;
        texturesUl.appendChild(li);
      });
    } else {
      texturesUl.innerHTML = '<li class="asset-pill">No standalone textures</li>';
    }
  }

  // Capabilities & hints
  const capContainer = document.getElementById('insp-capabilities-list');
  if (capContainer) {
    capContainer.innerHTML = '';
    const caps = insp.manifest_assets || ['LENSCORE_FACETRACKING_FACE_MESH_V3', 'LENSCORE_SEGMENTATION_BINARY_BODY_V2'];
    caps.slice(0, 6).forEach(c => {
      const span = document.createElement('span');
      span.className = 'cap-tag';
      span.textContent = c.replace('LENSCORE_', '').replace('FACETRACKING_', '');
      capContainer.appendChild(span);
    });
  }
}

// Bootstrap Camera Kit SDK with Sideload Extension
async function initCameraKit() {
  const canvas = document.getElementById('ck-canvas');
  const statusBadge = document.getElementById('engine-status-text');

  if (ckSession) return;

  try {
    statusBadge.textContent = 'Bootstrapping Camera Kit...';
    const { 
      bootstrapCameraKit, 
      createExtension, 
      lensSourcesFactory, 
      ConcatInjectable, 
      createMediaStreamSource, 
      Transform2D 
    } = await import('/static/js/camera-kit.bundle.js');

    // Camera Kit API Token
    const token = "eyJhbGciOiJIUzI1NiIsImtpZCI6IkNhbnZhc1MyU0hNQUNQcm9kIiwidHlwIjoiSldUIn0.eyJhdWQiOiJjYW52YXMtY2FudmFzYXBpIiwiaXNzIjoiY2FudmFzLXMyc3Rva2VuIiwibmJmIjoxNzMyNjMzNDE5LCJzdWIiOiIwMjdmNjZkZi0wOTQyLTQ3ZWUtODUxMi1lNGMyZTQ2MWRkMzR-UFJPRFVDVElPTn43N2Y5Y2ZlYi1lNWUxLTRhZTgtYWU5ZS01MjQ1NGYwM2JiYTYifQ.niwcW4CuvpHEhciugcvxa2S5vQBsehTktDu_k8galYU";

    const customLensSource = {
      isGroupOwner(groupId) {
        return groupId === "lens-sideload-extension-group";
      },
      async loadLens(lensId, groupId) {
        console.log("[CameraKit] Sideloading lens:", lensId);
        const l = sideloadedLenses.get(lensId) || {
          id: lensId,
          name: "Sideload Lens",
          lnsUrl: window.location.origin + "/static/samples/abyssal_crown.lns",
          sha256: ""
        };
        return createLensProto(l);
      },
      async loadLensGroup() {
        throw new Error("loadLensGroup not supported");
      }
    };

    const sideloadExtension = createExtension().provides(
      ConcatInjectable(lensSourcesFactory.token, () => customLensSource)
    );

    ckInstance = await bootstrapCameraKit({
      apiToken: token
    }, container => container.provides(sideloadExtension));

    ckSession = await ckInstance.createSession({ liveRenderTarget: canvas });
    statusBadge.textContent = 'Camera Kit WebGL2 Active';
    const pill = document.getElementById('sdk-version-pill');
    if (pill) pill.classList.remove('error-pill');

    await applySelectedSource();
    await applyCurrentLens();

  } catch (err) {
    console.error("[Camera Kit Init Error]", err);
    statusBadge.textContent = 'Engine: ' + err.message;
    const pill = document.getElementById('sdk-version-pill');
    if (pill) pill.classList.add('error-pill');
  }
}

// Apply Active Input Source
async function applySelectedSource() {
  if (!ckSession) return;

  const { createMediaStreamSource, Transform2D } = await import('/static/js/camera-kit.bundle.js');
  const videoInput = document.getElementById('ck-video-input');
  const webcamRaw = document.getElementById('ck-webcam-raw');
  const cropCanvas = document.getElementById('ck-crop-canvas');
  const cropCtx = cropCanvas.getContext('2d');
  const resBadge = document.getElementById('source-res-badge');

  if (cropAnimFrameId) {
    cancelAnimationFrame(cropAnimFrameId);
    cropAnimFrameId = null;
  }

  // Case 1 & 2: Video playback (model1, model2, custom video)
  if (ckActiveSource === 'model1' || ckActiveSource === 'model2' || (ckActiveSource === 'custom' && customMediaType === 'video')) {
    if (webcamStream) {
      webcamStream.getTracks().forEach(t => t.stop());
      webcamStream = null;
    }

    let targetSrc = '/static/samples/test_portrait.mp4';
    if (ckActiveSource === 'model2') targetSrc = '/static/samples/test_portrait_blonde.mp4';
    if (ckActiveSource === 'custom' && customMediaUrl) targetSrc = customMediaUrl;

    videoInput.pause();
    videoInput.src = targetSrc;
    videoInput.currentTime = 0;
    await videoInput.play();

    const renderLoop = () => {
      if (videoInput.videoWidth > 0 && videoInput.videoHeight > 0) {
        cropCtx.drawImage(videoInput, 0, 0, 720, 1280);
      }
      cropAnimFrameId = requestAnimationFrame(renderLoop);
    };
    renderLoop();

    const stream = cropCanvas.captureStream(30);
    const source = createMediaStreamSource(stream, { transform: Transform2D.Identity });
    await ckSession.setSource(source);
    await source.setRenderSize(720, 1280);
    await ckSession.play();

    if (resBadge) resBadge.textContent = '720 × 1280 (Model Video)';
  }

  // Case 3: Still Portrait Photo
  else if (ckActiveSource === 'photo' || (ckActiveSource === 'custom' && customMediaType === 'image')) {
    if (webcamStream) {
      webcamStream.getTracks().forEach(t => t.stop());
      webcamStream = null;
    }
    videoInput.pause();

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = (ckActiveSource === 'custom' && customMediaUrl) ? customMediaUrl : '/static/samples/portrait_neutral.png';
    await new Promise(r => { img.onload = r; });

    const renderStill = () => {
      cropCtx.drawImage(img, 0, 0, 720, 1280);
      cropAnimFrameId = requestAnimationFrame(renderStill);
    };
    renderStill();

    const stream = cropCanvas.captureStream(30);
    const source = createMediaStreamSource(stream, { transform: Transform2D.Identity });
    await ckSession.setSource(source);
    await source.setRenderSize(720, 1280);
    await ckSession.play();

    if (resBadge) resBadge.textContent = '720 × 1280 (Frame 0 Photo)';
  }

  // Case 4: Live WebCam
  else if (ckActiveSource === 'webcam') {
    videoInput.pause();
    try {
      if (!webcamStream || !webcamStream.active) {
        webcamStream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'user',
            width: { ideal: 1280 },
            height: { ideal: 720 }
          },
          audio: false
        });
      }
      webcamRaw.srcObject = webcamStream;
      await webcamRaw.play();

      if (ckFramingMode === 'fit') {
        // Smart Anti-Zoom Framing: natural scale to eliminate 3.16x crop
        const renderCamLoop = () => {
          if (webcamRaw.videoWidth > 0 && webcamRaw.videoHeight > 0) {
            const vw = webcamRaw.videoWidth;
            const vh = webcamRaw.videoHeight;
            cropCtx.save();
            cropCtx.fillStyle = '#06080d';
            cropCtx.fillRect(0, 0, 720, 1280);

            const scale = Math.max(720 / vw, 1280 / vh) * 0.75;
            const dw = vw * scale;
            const dh = vh * scale;
            const dx = (720 - dw) / 2;
            const dy = (1280 - dh) / 2 + 50;

            if (ckIsMirrored) {
              cropCtx.translate(720, 0);
              cropCtx.scale(-1, 1);
              cropCtx.drawImage(webcamRaw, 720 - (dx + dw), dy, dw, dh);
            } else {
              cropCtx.drawImage(webcamRaw, dx, dy, dw, dh);
            }
            cropCtx.restore();
          }
          cropAnimFrameId = requestAnimationFrame(renderCamLoop);
        };
        renderCamLoop();

        const stream = cropCanvas.captureStream(30);
        const source = createMediaStreamSource(stream, { transform: Transform2D.Identity });
        await ckSession.setSource(source);
        await source.setRenderSize(720, 1280);
        await ckSession.play();

        if (resBadge) resBadge.textContent = '720 × 1280 (Smart Zero-Zoom)';
      } else {
        // Standard Fill Crop
        const transform = ckIsMirrored ? Transform2D.Mirror : Transform2D.Identity;
        const source = createMediaStreamSource(webcamStream, { transform });
        await ckSession.setSource(source);
        await source.setRenderSize(720, 1280);
        await ckSession.play();

        if (resBadge) resBadge.textContent = '720 × 1280 (Standard Fill)';
      }
    } catch (camErr) {
      console.warn('[WebCam Access Warning]', camErr);
      // Fallback to stock model video if webcam unavailable (e.g. headless or permissions denied)
      ckActiveSource = 'model1';
      document.querySelectorAll('.source-btn').forEach(b => b.classList.remove('active'));
      document.getElementById('src-model1').classList.add('active');
      await applySelectedSource();
    }
  }
}

// Apply Active Lens to Camera Kit
async function applyCurrentLens() {
  if (!ckSession || !ckInstance) return;

  const hudStatus = document.getElementById('hud-lens-status');
  try {
    const lensMeta = sideloadedLenses.get(ckCurrentLensId) || { name: ckCurrentLensId };
    if (hudStatus) hudStatus.textContent = 'Applying 3D Lens...';

    const lens = await ckInstance.lensRepository.loadLens(ckCurrentLensId, "lens-sideload-extension-group");
    await ckSession.applyLens(lens);

    if (hudStatus) hudStatus.textContent = 'WebGL2 AR Active';
    console.log('[CameraKit] Lens applied successfully:', lens.name);
  } catch (err) {
    console.error('[CameraKit applyLens Error]', err);
    if (hudStatus) hudStatus.textContent = 'Lens Error: ' + err.message;
  }
}

// Source Switcher UI Handler
window.setSource = async (sourceType) => {
  ckActiveSource = sourceType;
  document.querySelectorAll('.source-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(`src-${sourceType}`);
  if (btn) btn.classList.add('active');
  await applySelectedSource();
};

// Mirror Toggle
window.toggleCamMirror = async () => {
  ckIsMirrored = !ckIsMirrored;
  const btn = document.getElementById('btn-mirror');
  if (btn) btn.classList.toggle('active', ckIsMirrored);
  await applySelectedSource();
};

// Framing Mode Toggle
window.toggleCamFraming = async () => {
  ckFramingMode = (ckFramingMode === 'fit') ? 'crop' : 'fit';
  const label = document.getElementById('label-framing-mode');
  const icon = document.getElementById('icon-framing-mode');
  if (label) label.textContent = (ckFramingMode === 'fit') ? 'Zero Zoom' : 'Standard Crop';
  if (icon) icon.textContent = (ckFramingMode === 'fit') ? '🎯' : '🔍';
  await applySelectedSource();
};

// Restart Source Video
window.restartSource = () => {
  const vid = document.getElementById('ck-video-input');
  if (vid) {
    vid.currentTime = 0;
    vid.play();
  }
};

// Custom Media Upload (test against any custom video/photo)
window.openCustomMediaModal = () => {
  document.getElementById('custom-media-input').click();
};

window.handleCustomMediaUpload = async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('media', file);

  try {
    const res = await fetch('/api/upload_media', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.success) {
      customMediaUrl = data.url;
      customMediaType = data.type;
      await setSource('custom');
    }
  } catch (err) {
    console.error('[Custom Media Upload Error]', err);
  }
};

// Split Before / After Slider Toggle & Handler
let isSplitModeActive = false;
let isDraggingSplit = false;

window.toggleSplitMode = () => {
  isSplitModeActive = !isSplitModeActive;
  const container = document.getElementById('split-overlay-container');
  const btn = document.getElementById('btn-split');
  if (container) container.style.display = isSplitModeActive ? 'block' : 'none';
  if (btn) btn.classList.toggle('active', isSplitModeActive);
};

function setupSplitSlider() {
  const container = document.getElementById('split-overlay-container');
  const line = document.getElementById('split-slider-line');
  const rawCanvas = document.getElementById('split-raw-canvas');
  const cropCanvas = document.getElementById('ck-crop-canvas');
  const rawCtx = rawCanvas.getContext('2d');

  if (!container || !line) return;

  // Mirror the crop canvas to raw split canvas
  const renderRawLoop = () => {
    if (isSplitModeActive) {
      rawCtx.drawImage(cropCanvas, 0, 0, 720, 1280);
    }
    requestAnimationFrame(renderRawLoop);
  };
  renderRawLoop();

  const setPos = (pct) => {
    line.style.left = `${pct}%`;
    rawCanvas.style.clipPath = `polygon(0% 0%, ${pct}% 0%, ${pct}% 100%, 0% 100%)`;
  };
  setPos(50);

  line.addEventListener('mousedown', () => { isDraggingSplit = true; });
  window.addEventListener('mouseup', () => { isDraggingSplit = false; });
  window.addEventListener('mousemove', (e) => {
    if (!isDraggingSplit) return;
    const rect = container.getBoundingClientRect();
    let pct = ((e.clientX - rect.left) / rect.width) * 100;
    pct = Math.max(5, Math.min(95, pct));
    setPos(pct);
  });

  // Touch support
  line.addEventListener('touchstart', () => { isDraggingSplit = true; });
  window.addEventListener('touchend', () => { isDraggingSplit = false; });
  window.addEventListener('touchmove', (e) => {
    if (!isDraggingSplit || !e.touches[0]) return;
    const rect = container.getBoundingClientRect();
    let pct = ((e.touches[0].clientX - rect.left) / rect.width) * 100;
    pct = Math.max(5, Math.min(95, pct));
    setPos(pct);
  });
}

// Dropzone & File Input Handler
function setupDropzone() {
  const dropzone = document.getElementById('lens-dropzone');
  if (!dropzone) return;

  ['dragenter', 'dragover'].forEach(name => {
    dropzone.addEventListener(name, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(name => {
    dropzone.addEventListener(name, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('dragover');
    });
  });

  dropzone.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      uploadLensBundle(files[0]);
    }
  });
}

window.handleLensFileInput = (e) => {
  const files = e.target.files;
  if (files && files.length > 0) {
    uploadLensBundle(files[0]);
  }
  try { e.target.value = ''; } catch (_) {}
};

async function uploadLensBundle(file) {
  if (!file) return;

  const progressContainer = document.getElementById('upload-progress-container');
  const progressBar = document.getElementById('upload-progress-bar');
  const progressText = document.getElementById('upload-progress-text');

  if (progressContainer) progressContainer.style.display = 'flex';
  if (progressBar) {
    progressBar.style.width = '25%';
    progressBar.style.backgroundColor = 'var(--snap-yellow)';
  }
  if (progressText) {
    progressText.style.color = '#ffffff';
    progressText.textContent = `Processing ${file.name}...`;
  }

  let localApplied = false;

  try {
    // 1. Client-Side Local Power Processing (Works 100% Offline via JSZip + Web Crypto)
    if (window.JSZip) {
      try {
        const arrayBuffer = await file.arrayBuffer();
        
        // Compute SHA-256 locally using hardware Web Crypto API
        const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const sha256Hex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        // Unpack zip in memory
        const zip = await JSZip.loadAsync(arrayBuffer);
        const fileNames = Object.keys(zip.files);

        // Check for icon.png
        let iconBlobUrl = null;
        if (zip.files['icon.png']) {
          const iconBlob = await zip.files['icon.png'].async('blob');
          iconBlobUrl = URL.createObjectURL(iconBlob);
        }

        // Parse manifests if present
        let metainfo = {};
        if (zip.files['metainfo.json']) {
          try {
            const metaStr = await zip.files['metainfo.json'].async('text');
            metainfo = JSON.parse(metaStr);
          } catch (_) {}
        }

        const meshes = [], textures = [], shaders = [], scripts = [];
        fileNames.forEach(fn => {
          const lower = fn.toLowerCase();
          const base = fn.split('/').pop();
          if (['.mesh', '.glb', '.scn', '.t3d', '.ply'].some(ext => lower.endsWith(ext))) meshes.push({ name: base, size_bytes: zip.files[fn]._data?.uncompressedSize || 1024 });
          else if (['.png', '.jpg', '.jpeg', '.webp'].some(ext => lower.endsWith(ext))) textures.push({ name: base, size_bytes: zip.files[fn]._data?.uncompressedSize || 1024 });
          else if (['.glsl', '.reflection'].some(ext => lower.endsWith(ext))) shaders.push({ name: base, size_bytes: zip.files[fn]._data?.uncompressedSize || 1024 });
          else if (['.js', '.ts', '.gs'].some(ext => lower.endsWith(ext))) scripts.push({ name: base, size_bytes: zip.files[fn]._data?.uncompressedSize || 1024 });
        });

        const localId = 'local_' + sha256Hex.slice(0, 12);
        const cleanName = file.name.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const localBlobUrl = URL.createObjectURL(file);

        const localLensEntry = {
          id: localId,
          name: cleanName,
          filename: file.name,
          url: localBlobUrl,
          icon_url: iconBlobUrl,
          sha256: sha256Hex,
          size_bytes: file.size,
          is_sample: false,
          is_local: true,
          activation_camera: metainfo.activation_camera || 'front',
          description: `Locally processed offline lens bundle (${meshes.length} meshes, ${textures.length} textures).`,
          inspection: {
            sha256: sha256Hex,
            size_bytes: file.size,
            total_files: fileNames.length,
            counts: { meshes: meshes.length, textures: textures.length, shaders: shaders.length, scripts: scripts.length },
            sample_meshes: meshes.slice(0, 20),
            sample_textures: textures.slice(0, 20)
          }
        };

        // Register immediately into memory & UI
        sideloadedLenses.set(localId, {
          id: localId,
          name: cleanName,
          lnsUrl: localBlobUrl,
          sha256: sha256Hex,
          iconUrl: iconBlobUrl
        });

        // Add to active list
        const existingIdx = loadedLensesList.findIndex(l => l.id === localId);
        if (existingIdx >= 0) loadedLensesList[existingIdx] = localLensEntry;
        else loadedLensesList.unshift(localLensEntry);

        renderCarousel();
        renderLensesList();
        await selectLens(localId);
        switchTab('inspector');
        localApplied = true;

        if (progressBar) progressBar.style.width = '70%';
        if (progressText) progressText.textContent = 'Active on camera! Syncing to server...';
      } catch (localErr) {
        console.warn('[Local Unpack Fallback]', localErr);
      }
    }

    // 2. Server upload & sync
    if (progressBar) progressBar.style.width = localApplied ? '85%' : '50%';
    if (progressText) progressText.textContent = localApplied ? 'Syncing with cloud...' : `Uploading ${file.name}...`;

    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/upload_lens', { method: 'POST', body: formData }).catch(e => {
      console.warn('[Upload Network Warning]', e);
      return null;
    });

    if (res && res.ok) {
      const data = await res.json();
      if (data.success && data.lens) {
        sideloadedLenses.set(data.lens.id, {
          id: data.lens.id,
          name: data.lens.name,
          lnsUrl: window.location.origin + data.lens.url,
          sha256: data.lens.sha256,
          iconUrl: data.lens.icon_url ? window.location.origin + data.lens.icon_url : null
        });
        await fetchLenses();
        if (!localApplied) {
          await selectLens(data.lens.id);
          switchTab('inspector');
        }
      }
    }

    if (progressBar) progressBar.style.width = '100%';
    if (progressText) {
      progressText.textContent = '✨ Lens active & ready on camera!';
      progressText.style.color = '#00ff88';
    }
    setTimeout(() => {
      if (progressContainer) progressContainer.style.display = 'none';
      if (progressText) progressText.style.color = '';
    }, 1800);

  } catch (err) {
    console.error('[Upload Handler Error]', err);
    if (progressBar) {
      progressBar.style.width = '100%';
      progressBar.style.backgroundColor = '#ff4d4d';
    }
    if (progressText) {
      progressText.textContent = `Upload error: ${err.message || err}`;
      progressText.style.color = '#ff4d4d';
    }
    setTimeout(() => {
      if (progressContainer) progressContainer.style.display = 'none';
      if (progressBar) progressBar.style.backgroundColor = '';
      if (progressText) progressText.style.color = '';
    }, 4000);
  }
}

// Snapchat Shutter: Tap for Photo Snap • Hold for Video Snap
function setupShutter() {
  const shutterBtn = document.getElementById('snap-shutter');
  const hintEl = document.getElementById('shutter-hint');
  if (!shutterBtn) return;

  const onPointerDown = (e) => {
    e.preventDefault();
    isPressingShutter = true;
    shutterPressTimer = setTimeout(() => {
      // Long press detected -> Start Video Snap Recording!
      startVideoRecording();
    }, 380);
  };

  const onPointerUp = (e) => {
    e.preventDefault();
    if (!isPressingShutter) return;
    isPressingShutter = false;

    if (isRecordingVideo) {
      // Stop video recording
      stopVideoRecording();
    } else {
      // Short tap detected -> Capture Photo Snap!
      clearTimeout(shutterPressTimer);
      capturePhotoSnap();
    }
  };

  shutterBtn.addEventListener('mousedown', onPointerDown);
  window.addEventListener('mouseup', onPointerUp);

  shutterBtn.addEventListener('touchstart', onPointerDown, { passive: false });
  window.addEventListener('touchend', onPointerUp, { passive: false });
}

// 1. Capture Photo Snap
async function capturePhotoSnap() {
  const canvas = document.getElementById('ck-canvas');
  const flash = document.getElementById('camera-flash');

  // Camera flash animation
  if (flash) {
    flash.classList.add('active');
    setTimeout(() => flash.classList.remove('active'), 150);
  }

  // Play shutter sound
  try {
    const snd = document.getElementById('snd-shutter');
    if (snd) { snd.currentTime = 0; snd.play().catch(() => {}); }
  } catch (_) {}

  // Export high-res PNG data
  const dataUrl = canvas.toDataURL('image/png', 0.95);

  // Send to backend
  const formData = new FormData();
  formData.append('type', 'photo');
  formData.append('image', dataUrl);

  try {
    const res = await fetch('/api/save_snap', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.success) {
      showSnapModal(dataUrl, 'photo', data.url);
      loadSnapsGallery();
    }
  } catch (err) {
    console.error('[Save Snap Photo Error]', err);
    showSnapModal(dataUrl, 'photo', null);
  }
}

// 2. Record Video Snap (Hold Shutter)
async function startVideoRecording() {
  if (isRecordingVideo) return;
  isRecordingVideo = true;

  const shutterBtn = document.getElementById('snap-shutter');
  const svgBar = document.getElementById('record-svg-bar');
  const hintEl = document.getElementById('shutter-hint');
  const canvas = document.getElementById('ck-canvas');

  if (shutterBtn) shutterBtn.classList.add('recording');
  if (hintEl) hintEl.textContent = 'Recording Video Snap...';

  recordedChunks = [];
  const stream = canvas.captureStream(30);

  // Optional: add audio track if microphone available
  try {
    const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micStream.getAudioTracks().forEach(t => stream.addTrack(t));
  } catch (_) {}

  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
  mediaRecorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4000000 });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    const videoUrl = URL.createObjectURL(blob);

    // Send video to backend
    const formData = new FormData();
    formData.append('type', 'video');
    formData.append('video', blob, 'snap_video.webm');

    try {
      const res = await fetch('/api/save_snap', { method: 'POST', body: formData });
      const data = await res.json();
      showSnapModal(videoUrl, 'video', data.url || videoUrl);
      loadSnapsGallery();
    } catch (err) {
      console.error('[Save Snap Video Error]', err);
      showSnapModal(videoUrl, 'video', videoUrl);
    }
  };

  mediaRecorder.start();
  recordStartTime = performance.now();

  // Progress Bar Animation
  const totalCircumference = 276.46;
  const updateProgress = () => {
    if (!isRecordingVideo) return;
    const elapsed = (performance.now() - recordStartTime) / 1000;
    const pct = Math.min(elapsed / MAX_RECORD_SECONDS, 1);
    const offset = totalCircumference - (totalCircumference * pct);

    if (svgBar) svgBar.style.strokeDashoffset = offset;

    if (pct >= 1) {
      stopVideoRecording();
      return;
    }
    recordAnimFrame = requestAnimationFrame(updateProgress);
  };
  recordAnimFrame = requestAnimationFrame(updateProgress);
}

function stopVideoRecording() {
  if (!isRecordingVideo) return;
  isRecordingVideo = false;

  const shutterBtn = document.getElementById('snap-shutter');
  const svgBar = document.getElementById('record-svg-bar');
  const hintEl = document.getElementById('shutter-hint');

  if (shutterBtn) shutterBtn.classList.remove('recording');
  if (svgBar) svgBar.style.strokeDashoffset = 276.46;
  if (hintEl) hintEl.textContent = 'Tap for Photo • Hold for Video';
  if (recordAnimFrame) cancelAnimationFrame(recordAnimFrame);

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

// Snap Modal Display
function showSnapModal(mediaSrc, type, downloadUrl) {
  const modal = document.getElementById('snap-preview-modal');
  const body = document.getElementById('snap-modal-body');
  const dlBtn = document.getElementById('snap-download-btn');
  const title = document.getElementById('snap-modal-title');

  if (!modal || !body) return;

  title.textContent = (type === 'video') ? '🎬 Video Snap Recorded' : '📸 Photo Snap Captured';
  body.innerHTML = '';

  if (type === 'video') {
    const vid = document.createElement('video');
    vid.src = mediaSrc;
    vid.controls = true;
    vid.autoplay = true;
    vid.loop = true;
    body.appendChild(vid);
    if (dlBtn) {
      dlBtn.href = downloadUrl || mediaSrc;
      dlBtn.download = `snap_${Date.now()}.webm`;
    }
  } else {
    const img = document.createElement('img');
    img.src = mediaSrc;
    body.appendChild(img);
    if (dlBtn) {
      dlBtn.href = downloadUrl || mediaSrc;
      dlBtn.download = `snap_${Date.now()}.png`;
    }
  }

  modal.style.display = 'flex';
}

window.closeSnapModal = (e) => {
  if (e && e.target !== document.getElementById('snap-preview-modal') && !e.target.classList.contains('modal-close-btn') && e.target.textContent !== 'Close') return;
  const modal = document.getElementById('snap-preview-modal');
  const body = document.getElementById('snap-modal-body');
  if (body) body.innerHTML = '';
  if (modal) modal.style.display = 'none';
};

// Snaps Gallery Loader
async function loadSnapsGallery() {
  const grid = document.getElementById('snaps-grid');
  const badge = document.getElementById('snaps-count-badge');
  if (!grid) return;

  try {
    const res = await fetch('/api/snaps');
    const data = await res.json();
    if (data.success && data.snaps && data.snaps.length > 0) {
      if (badge) badge.textContent = data.snaps.length;
      grid.innerHTML = '';

      data.snaps.forEach(snap => {
        const card = document.createElement('div');
        card.className = 'snap-card';
        card.onclick = () => showSnapModal(snap.url, snap.type, snap.url);

        if (snap.type === 'video') {
          card.innerHTML = `
            <video class="snap-media" src="${snap.url}" muted playsinline></video>
            <span class="snap-badge-type">VIDEO</span>
          `;
        } else {
          card.innerHTML = `
            <img class="snap-media" src="${snap.url}" alt="Snap">
            <span class="snap-badge-type">PHOTO</span>
          `;
        }
        grid.appendChild(card);
      });
    } else {
      if (badge) badge.textContent = '0';
    }
  } catch (err) {
    console.error('[Load Snaps Error]', err);
  }
}

// FPS Monitor Loop
function startFpsMonitor() {
  const fpsEl = document.getElementById('fps-counter');
  const loop = (now) => {
    frameCount++;
    if (now - lastFrameTime >= 1000) {
      currentFps = frameCount;
      frameCount = 0;
      lastFrameTime = now;
      if (fpsEl) fpsEl.textContent = `${currentFps} FPS`;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// Diagnostics Helpers
window.rebootstrapEngine = async () => {
  if (ckSession) {
    try { await ckSession.pause(); } catch (_) {}
    ckSession = null;
    ckInstance = null;
  }
  await initCameraKit();
};

window.exportDiagnosticReport = () => {
  const info = {
    sdk: "@snap/camera-kit@1.22.0",
    activeLens: ckCurrentLensId,
    activeSource: ckActiveSource,
    fps: currentFps,
    framing: ckFramingMode,
    mirrored: ckIsMirrored,
    totalLoadedLenses: loadedLensesList.length
  };
  navigator.clipboard.writeText(JSON.stringify(info, null, 2))
    .then(() => alert('Diagnostic report copied to clipboard!'))
    .catch(() => alert(JSON.stringify(info)));
};
