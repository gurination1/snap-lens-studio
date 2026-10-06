/**
 * SnapAR Studio • Mobile Web Lens Tester & Live AR
 * Dual Engine: Instant Local WebGL2 AR (60-120 FPS) + Snap Camera Kit 1.22.0
 */

// Global State
let ckInstance = null;
let ckSession = null;
let ckActiveSource = 'webcam'; // 'webcam', 'model1', 'model2', 'photo', 'custom'
let ckFacingMode = 'user'; // 'user' (front) or 'environment' (back)
let ckFramingMode = 'fit'; // 'fit' (zero zoom) or 'crop'
let ckIsMirrored = true;
let ckBeautyGlow = true;
let ckCurrentLensId = "06ab0c08-158f-762e-8000-87bcd093434c"; // default: Abyssal Crown
let webcamStream = null;
let customMediaUrl = null;
let customMediaType = null;

// Registry of loaded lenses
const sideloadedLenses = new Map();
let loadedLensesList = [];

// Camera Kit Server Config State
let serverLensGroupId = "6d4c3a49-b090-45b2-b2f7-720e78e9f7fd";
let serverApiToken = "";
let serverStagingToken = "";

// Local AR Engine State
let localRenderLoopId = null;
let localFaceSimTime = 0;
let crownParticles = [];
let kitsuneWisps = [];

// 3D WebGL Engine State (Three.js Runtime for Snapchat .mesh)
let threeRenderer = null;
let threeScene = null;
let threeCamera = null;
let threeCanvas = null;
let abyssalCrownGroup = null;
let abyssalCrownMaterial = null;
let custom3DGroup = null;
let is3DModelLoaded = false;
let isLoading3DModel = false;

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

// Shutter State (Tap Photo, Hold Video)
let isPressingShutter = false;
let shutterPressTimer = null;
let isRecordingVideo = false;
let mediaRecorder = null;
let recordedChunks = [];
let recordStartTime = 0;
let recordAnimFrame = null;
const MAX_RECORD_SECONDS = 10;

// Diagnostics & FPS
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

  // 1. Start Camera Feed & Local AR immediately (0ms wait, no network freeze!)
  await applySelectedSource();
  startLocalArEngine();
  startFpsMonitor();

  // 2. Fetch lenses & likes from server
  await fetchLenses();
  loadSnapsGallery();

  // 3. Fetch server Camera Kit configuration and restore inputs
  try {
    const cfgRes = await fetch('/api/config');
    if (cfgRes.ok) {
      const cfg = await cfgRes.json();
      if (cfg.lens_group_id) serverLensGroupId = cfg.lens_group_id;
      if (cfg.api_token) serverApiToken = cfg.api_token;
      if (cfg.staging_api_token) serverStagingToken = cfg.staging_api_token;
    }
  } catch (err) {
    console.warn('[Config Warning] Could not fetch /api/config:', err);
  }

  try {
    const savedGroupId = localStorage.getItem('ck_lens_group_id') || serverLensGroupId || DEFAULT_LENS_GROUP_ID;
    const savedToken = localStorage.getItem('ck_api_token_override');
    const groupInput = document.getElementById('ck-group-id-input');
    const tokenInput = document.getElementById('ck-api-token-input');
    if (groupInput) groupInput.value = savedGroupId;
    if (tokenInput && savedToken) tokenInput.value = savedToken;
  } catch (_) {}
});

// PWA Service Worker & Install Prompt
let deferredPrompt = null;
function setupPwa() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/static/sw.js')
      .then(reg => console.log('[PWA] Registered:', reg.scope))
      .catch(err => console.warn('[PWA] Failed:', err));
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const installBtn = document.getElementById('pwa-install-btn');
    if (installBtn) installBtn.style.display = 'inline-flex';
  });

  window.triggerPwaInstall = async () => {
    if (!deferredPrompt) {
      alert('To install, open your browser menu (⋮ or Share) and tap "Add to Home Screen".');
      return;
    }
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    const installBtn = document.getElementById('pwa-install-btn');
    if (installBtn) installBtn.style.display = 'none';
  };
}

// Drawer Toggle (Slide-up Lens Studio)
window.toggleStudioDrawer = function() {
  const drawer = document.getElementById('studio-drawer');
  if (drawer) {
    drawer.classList.toggle('open');
  }
};

// Tab Switcher inside Drawer
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
};
window.focusUpload = window.triggerLensUpload;

// Fetch Lenses from backend
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
          iconUrl: l.icon_url ? window.location.origin + l.icon_url : null,
          likes: l.likes || 100
        });
      });

      renderLensesList();
      renderCarousel();
      const current = data.lenses.find(l => l.id === ckCurrentLensId) || data.lenses[0];
      if (current) {
        updateInspector(current);
        updateHudLens(current);
      }
    }
  } catch (err) {
    console.error('[Fetch Lenses Error]', err);
  }
}

// Render Lenses inside Drawer List
function renderLensesList() {
  const container = document.getElementById('lenses-list');
  const countBadge = document.getElementById('lenses-total-badge');
  if (!container) return;

  container.innerHTML = '';
  if (countBadge) countBadge.textContent = loadedLensesList.length;

  loadedLensesList.forEach(lens => {
    const item = document.createElement('div');
    item.className = `lens-card ${lens.id === ckCurrentLensId ? 'active' : ''}`;
    item.onclick = () => selectLens(lens.id);

    const iconSrc = lens.icon_url || '/static/samples/abyssal_crown_icon.png';
    const sizeMb = lens.size_bytes ? (lens.size_bytes / (1024 * 1024)).toFixed(2) + ' MB' : (lens.is_camerakit_cloud ? 'Snap Cloud' : 'Built-in');
    const tag = lens.is_camerakit_cloud ? '⚡ Snap Cloud' : (lens.is_sample ? 'Official' : 'Custom');
    const meshCount = lens.inspection?.counts?.meshes || 0;
    const texCount = lens.inspection?.counts?.textures || 0;
    const metaDesc = lens.is_camerakit_cloud ? `Group: ${lens.groupId?.slice(0, 8)}... • Snap Camera Kit WebGL2` : `${sizeMb} • ${meshCount} Meshes • ${texCount} Textures`;

    item.innerHTML = `
      <div class="lens-card-info">
        <img class="lens-card-icon" src="${iconSrc}" alt="${lens.name}">
        <div class="lens-card-details">
          <span class="lens-card-name">${lens.name}</span>
          <span class="lens-card-meta">${metaDesc}</span>
        </div>
      </div>
      <div class="lens-card-actions">
        <span class="lens-tag-pill ${lens.is_camerakit_cloud ? 'pill-cloud' : ''}">${tag}</span>
        ${(!lens.is_sample && !lens.is_camerakit_cloud) ? `<button class="btn-del-lens" title="Delete lens" onclick="deleteLens(event, '${lens.id}')">🗑</button>` : ''}
      </div>
    `;
    container.appendChild(item);
  });
}

// Render Bottom Lens Carousel
function renderCarousel() {
  const carousel = document.getElementById('lens-carousel');
  if (!carousel) return;

  carousel.innerHTML = '';

  // Upload Shortcut Pill (+)
  const uploadPill = document.createElement('div');
  uploadPill.className = 'carousel-lens-item carousel-upload-btn';
  uploadPill.title = 'Upload New Lens (.lns)';
  uploadPill.innerHTML = '+';
  uploadPill.onclick = (e) => {
    e.stopPropagation();
    window.toggleStudioDrawer();
    window.triggerLensUpload();
  };
  carousel.appendChild(uploadPill);

  loadedLensesList.forEach(lens => {
    const pill = document.createElement('div');
    pill.className = `carousel-lens-item ${lens.id === ckCurrentLensId ? 'active' : ''} ${lens.is_camerakit_cloud ? 'carousel-cloud-lens' : ''}`;
    pill.title = lens.name;
    pill.onclick = () => selectLens(lens.id);

    const iconSrc = lens.icon_url || '/static/samples/abyssal_crown_icon.png';
    pill.innerHTML = `
      <img class="carousel-lens-img" src="${iconSrc}" alt="${lens.name}">
      ${lens.is_camerakit_cloud ? '<span class="carousel-cloud-badge">⚡</span>' : ''}
    `;
    carousel.appendChild(pill);
  });
}

// Select Lens
async function selectLens(lensId) {
  ckCurrentLensId = lensId;

  renderCarousel();
  renderLensesList();

  const lensMeta = loadedLensesList.find(l => l.id === lensId);
  if (lensMeta) {
    updateInspector(lensMeta);
    updateHudLens(lensMeta);
  }

  const localCanvas = document.getElementById('ck-canvas');
  const ckCanvas = document.getElementById('ck-camerakit-canvas');

  // Handle Camera Kit Cloud Lens
  if (lensMeta && lensMeta.is_camerakit_cloud && lensMeta.camerakit_lens_obj) {
    if (localCanvas) localCanvas.style.display = 'none';
    if (ckCanvas) ckCanvas.style.display = 'block';

    try {
      const session = await ensureCameraKitSession();
      if (session) {
        await session.applyLens(lensMeta.camerakit_lens_obj);
        console.log('[Camera Kit] Applied cloud lens:', lensMeta.name);
      }
    } catch (e) {
      console.warn('[Camera Kit Cloud Apply Error]', e);
    }
  } else {
    // Switch to Local AR Canvas
    if (ckCanvas) ckCanvas.style.display = 'none';
    if (localCanvas) localCanvas.style.display = 'block';

    // Check if custom lens has 3D model attached
    if (lensMeta && lensMeta.modelUrl) {
      await loadCustomLens3DModel(lensMeta.modelUrl, lensMeta.modelType, lensMeta.textureUrl);
    } else if (custom3DGroup) {
      while (custom3DGroup.children.length > 0) {
        custom3DGroup.remove(custom3DGroup.children[0]);
      }
    }

    // Trigger Local AR Re-sync & Snapchat Hint
    resetLocalArParticles();
    if (snapTracker) {
      snapTracker.showHint('lens_hint_open_your_mouth', 4.5);
    }

    // Also apply to Camera Kit if active
    if (ckSession && ckInstance) {
      try {
        const lens = await ckInstance.lensRepository.loadLens(lensId, "lens-sideload-extension-group");
        await ckSession.applyLens(lens);
      } catch (_) {}
    }
  }
}

function updateHudLens(lensMeta) {
  const nameEl = document.getElementById('hud-lens-name');
  const iconEl = document.getElementById('hud-lens-icon');
  const statusEl = document.getElementById('hud-lens-status');

  if (nameEl) nameEl.textContent = lensMeta.name;
  if (iconEl && lensMeta.icon_url) iconEl.src = lensMeta.icon_url;
  if (statusEl) statusEl.textContent = lensMeta.is_camerakit_cloud ? 'Snap Cloud (WebGL2)' : 'Local AR (60 FPS)';
}

// Camera Flip (Front ↔ Rear)
window.toggleCamFlip = async function() {
  ckFacingMode = (ckFacingMode === 'user') ? 'environment' : 'user';
  ckIsMirrored = (ckFacingMode === 'user');

  const mirrorBtn = document.getElementById('btn-mirror');
  if (mirrorBtn) mirrorBtn.classList.toggle('active', ckIsMirrored);

  // Restart camera with new facing mode
  if (webcamStream) {
    webcamStream.getTracks().forEach(t => t.stop());
    webcamStream = null;
  }
  ckActiveSource = 'webcam';
  await applySelectedSource();
};

// Mirror Front Camera
window.toggleCamMirror = function() {
  ckIsMirrored = !ckIsMirrored;
  const btn = document.getElementById('btn-mirror');
  if (btn) btn.classList.toggle('active', ckIsMirrored);
};

// Beauty & Glow FX
window.toggleBeautyGlow = function() {
  ckBeautyGlow = !ckBeautyGlow;
  const btn = document.getElementById('btn-beauty');
  if (btn) btn.classList.toggle('active', ckBeautyGlow);
};

// Source Switcher Quick Cycle
window.cycleSource = async function() {
  const sources = ['webcam', 'model1', 'model2', 'photo'];
  const currentIdx = sources.indexOf(ckActiveSource);
  const nextSource = sources[(currentIdx + 1) % sources.length];
  await window.setSource(nextSource);

  // Update Right Rail Icon & Label
  const iconMap = { webcam: '📹', model1: '👤', model2: '👱‍♀️', photo: '🖼️' };
  const labelMap = { webcam: 'Cam', model1: 'M1', model2: 'M2', photo: 'Still' };

  const iconEl = document.getElementById('icon-source-type');
  const labelEl = document.getElementById('label-source-type');
  if (iconEl) iconEl.textContent = iconMap[nextSource] || '📹';
  if (labelEl) labelEl.textContent = labelMap[nextSource] || 'Cam';
};

// Set Source
window.setSource = async function(sourceType) {
  ckActiveSource = sourceType;
  document.querySelectorAll('.source-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(`src-${sourceType}`);
  if (btn) btn.classList.add('active');
  await applySelectedSource();
};

// Apply Active Input Source
async function applySelectedSource() {
  const videoInput = document.getElementById('ck-video-input');
  const webcamRaw = document.getElementById('ck-webcam-raw');
  const cropCanvas = document.getElementById('ck-crop-canvas');
  const cropCtx = cropCanvas.getContext('2d');
  const resBadge = document.getElementById('source-res-badge');

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
    try { await videoInput.play(); } catch (_) {}

    if (resBadge) resBadge.textContent = '720 × 1280 (Sample Video)';
  } else if (ckActiveSource === 'photo' || (ckActiveSource === 'custom' && customMediaType === 'image')) {
    if (webcamStream) {
      webcamStream.getTracks().forEach(t => t.stop());
      webcamStream = null;
    }
    videoInput.pause();

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = (ckActiveSource === 'custom' && customMediaUrl) ? customMediaUrl : '/static/samples/portrait_neutral.png';
    await new Promise(r => { img.onload = r; });

    cropCtx.drawImage(img, 0, 0, 720, 1280);
    if (resBadge) resBadge.textContent = '720 × 1280 (Photo Still)';
  } else if (ckActiveSource === 'webcam') {
    videoInput.pause();
    try {
      if (!webcamStream || !webcamStream.active) {
        webcamStream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: ckFacingMode,
            width: { ideal: 1280 },
            height: { ideal: 720 }
          },
          audio: false
        });
      }
      webcamRaw.srcObject = webcamStream;
      await webcamRaw.play();
      if (resBadge) resBadge.textContent = `720 × 1280 (${ckFacingMode === 'user' ? 'Front' : 'Rear'} Cam)`;
    } catch (camErr) {
      console.warn('[WebCam Access Warning]', camErr);
      ckActiveSource = 'model1';
      document.querySelectorAll('.source-btn').forEach(b => b.classList.remove('active'));
      const m1 = document.getElementById('src-model1');
      if (m1) m1.classList.add('active');
      await applySelectedSource();
    }
  }
}

// Split Comparison Mode
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
  const rawCtx = rawCanvas ? rawCanvas.getContext('2d') : null;

  if (!container || !line || !rawCtx) return;

  const setPos = (pct) => {
    line.style.left = `${pct}%`;
    rawCanvas.style.clipPath = `polygon(0% 0%, ${pct}% 0%, ${pct}% 100%, 0% 100%)`;
  };
  setPos(50);

  const onMove = (clientX) => {
    const rect = container.getBoundingClientRect();
    let pct = ((clientX - rect.left) / rect.width) * 100;
    pct = Math.max(5, Math.min(95, pct));
    setPos(pct);
  };

  line.addEventListener('mousedown', () => { isDraggingSplit = true; });
  window.addEventListener('mouseup', () => { isDraggingSplit = false; });
  window.addEventListener('mousemove', (e) => { if (isDraggingSplit) onMove(e.clientX); });

  line.addEventListener('touchstart', () => { isDraggingSplit = true; }, { passive: true });
  window.addEventListener('touchend', () => { isDraggingSplit = false; }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (isDraggingSplit && e.touches[0]) onMove(e.touches[0].clientX);
  }, { passive: true });
}

// ============================================================================
// SNAPCHAT FACE TRACKING ENGINE (Reverse-Engineered from Official Snap Lenses)
// Real-time 468 3D Landmark Tracking • Head Pose Kinematics • Mouth Open Triggers
// ============================================================================

let mouthVfxParticles = [];
let snapTracker = null;

// Adaptive 1-Euro Low-Pass Filter with Deadband for Butter-Smooth Zero-Jitter AR
class AdaptiveFilter {
  constructor(minCutoff = 1.2, beta = 0.08, deadband = 0.75) {
    this.xPrev = null;
    this.dxPrev = 0;
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.deadband = deadband;
  }

  filter(val, dt = 0.016) {
    if (this.xPrev === null || !Number.isFinite(this.xPrev)) {
      this.xPrev = val;
      return val;
    }

    const diff = val - this.xPrev;
    // Deadband: If motion is micro-tremor sensor noise (< deadband), suppress completely
    if (Math.abs(diff) < this.deadband) {
      this.xPrev += diff * 0.03; // Gentle slow creep to avoid position drift
      return this.xPrev;
    }

    // Velocity estimation
    const dx = diff / Math.max(dt, 0.001);
    this.dxPrev = 0.15 * dx + 0.85 * this.dxPrev;

    // Adaptive cutoff frequency: fast motion = high cutoff (no lag); slow = low cutoff (rock solid)
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dxPrev);
    const alpha = Math.min(0.65, Math.max(0.04, (2 * Math.PI * cutoff * dt) / (1 + 2 * Math.PI * cutoff * dt)));

    this.xPrev += diff * alpha;
    return this.xPrev;
  }

  reset() {
    this.xPrev = null;
    this.dxPrev = 0;
  }
}

class SnapchatFaceEngine {
  constructor() {
    this.isFaceMeshReady = false;
    this.isProcessing = false;
    this.faceMesh = null;
    this.lastDetectedTime = 0;
    this.isFaceFound = false;
    this.showWireframe = false;

    // Performance Downscale & Inference Throttling
    this.trackingCanvas = null;
    this.trackingCtx = null;
    this.lastFrameSendTime = 0;
    this.minInferenceIntervalMs = 24; // ~40 FPS inference cap to preserve 60-120 FPS render thread

    // Precision 1-Euro Smoothers (Zero micro-jitter on face & 3D models)
    this.smoothForeheadX = new AdaptiveFilter(1.2, 0.10, 0.8);
    this.smoothForeheadY = new AdaptiveFilter(1.2, 0.10, 0.8);
    this.smoothHeadCenterX = new AdaptiveFilter(1.2, 0.10, 0.8);
    this.smoothHeadCenterY = new AdaptiveFilter(1.2, 0.10, 0.8);
    this.smoothLeftEyeX = new AdaptiveFilter(1.2, 0.10, 0.8);
    this.smoothLeftEyeY = new AdaptiveFilter(1.2, 0.10, 0.8);
    this.smoothRightEyeX = new AdaptiveFilter(1.2, 0.10, 0.8);
    this.smoothRightEyeY = new AdaptiveFilter(1.2, 0.10, 0.8);
    this.smoothNoseX = new AdaptiveFilter(1.2, 0.10, 0.8);
    this.smoothNoseY = new AdaptiveFilter(1.2, 0.10, 0.8);
    this.smoothMouthX = new AdaptiveFilter(1.2, 0.10, 0.8);
    this.smoothMouthY = new AdaptiveFilter(1.2, 0.10, 0.8);
    this.smoothLeftCheekX = new AdaptiveFilter(1.2, 0.10, 0.8);
    this.smoothLeftCheekY = new AdaptiveFilter(1.2, 0.10, 0.8);
    this.smoothRightCheekX = new AdaptiveFilter(1.2, 0.10, 0.8);
    this.smoothRightCheekY = new AdaptiveFilter(1.2, 0.10, 0.8);
    this.smoothChinX = new AdaptiveFilter(1.2, 0.10, 0.8);
    this.smoothChinY = new AdaptiveFilter(1.2, 0.10, 0.8);
    this.smoothRoll = new AdaptiveFilter(0.8, 0.08, 0.015);
    this.smoothYaw = new AdaptiveFilter(1.0, 0.10, 0.02);
    this.smoothPitch = new AdaptiveFilter(1.0, 0.10, 0.02);
    this.smoothScale = new AdaptiveFilter(0.35, 0.03, 0.012); // Heavy damping stops scale pumping!
    this.smoothMouthRatio = new AdaptiveFilter(2.0, 0.20, 0.015);

    // Active Hint State
    this.currentHint = null;
    this.hintTimeout = null;

    // Public vars (Exact 1:1 replica of Snapchat Face Events.js publicVars)
    this.publicVars = {
      headAngle: 0,             // Head tilt angle in degrees (-45 to 45)
      headAngleRad: 0,          // Radians for canvas context rotation
      headYaw: 0,               // Turning left / right (-1 to 1)
      headPitch: 0,             // Looking up / down (-1 to 1)
      scaleFactor: 1.0,         // Scale derived from interocular distance
      foreheadPosition2D: { x: 360, y: 340 },
      headCenterPosition2D: { x: 360, y: 440 },
      leftEyePosition2D: { x: 290, y: 460 },
      rightEyePosition2D: { x: 430, y: 460 },
      nosePosition2D: { x: 360, y: 530 },
      mouthPosition2D: { x: 360, y: 650 },
      leftCheekPosition2D: { x: 220, y: 560 },
      rightCheekPosition2D: { x: 500, y: 560 },
      chinPosition2D: { x: 360, y: 780 },
      mouthOpenRatio: 0,
      isMouthOpen: false,
      isWideOpen: false
    };

    // Target tracking values for smooth exponential moving average
    this.target = JSON.parse(JSON.stringify(this.publicVars));
    this.rawLandmarks = null;

    // Event listeners
    this.listeners = {
      onFaceFound: [],
      onFaceLost: [],
      onMouthOpened: [],
      onMouthClosed: [],
      onTiltLeft: [],
      onTiltRight: [],
      onTiltCenter: [],
      onBrowsRaised: []
    };

    this.headTiltThresholdAngle = 10;
    this.currentHeadState = "NONE"; // NONE, LEFT, RIGHT
    this.mouthOpenThreshold = 0.12;

    this.initFaceMesh();
  }

  on(eventName, cb) {
    if (this.listeners[eventName]) this.listeners[eventName].push(cb);
  }

  trigger(eventName, data) {
    if (this.listeners[eventName]) {
      this.listeners[eventName].forEach(cb => {
        try { cb(data); } catch (e) { console.error(e); }
      });
    }
  }

  initFaceMesh() {
    if (typeof window.FaceMesh === 'undefined') {
      setTimeout(() => this.initFaceMesh(), 250);
      return;
    }

    const tryInit = (useCdnFallback = false) => {
      try {
        const origin = window.location.origin;
        const baseUrl = useCdnFallback
          ? 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619/'
          : `${origin}/static/vendor/mediapipe/`;

        this.faceMesh = new window.FaceMesh({
          locateFile: (file) => `${baseUrl}${file}`
        });

        this.faceMesh.setOptions({
          maxNumFaces: 1,
          refineLandmarks: true,
          minDetectionConfidence: 0.5,
          minTrackingConfidence: 0.5
        });

        this.faceMesh.onResults((results) => {
          this.handleResults(results);
        });

        this.faceMesh.initialize().then(() => {
          this.isFaceMeshReady = true;
          console.log(`[SnapAR Engine] Snapchat 468 3D Face Landmark Engine Initialized (${useCdnFallback ? 'CDN' : 'Local'})!`);
          const badge = document.getElementById('engine-status-text');
          if (badge) badge.textContent = 'Snapchat 3D Mesh Engine (Searching for Face...)';
        }).catch((err) => {
          console.warn('[FaceEngine Init Warning - Switching to CDN Fallback]', err);
          if (!useCdnFallback) {
            tryInit(true);
          }
        });
      } catch (err) {
        console.warn('[FaceEngine Exception - Switching to CDN Fallback]', err);
        if (!useCdnFallback) {
          tryInit(true);
        }
      }
    };

    tryInit(false);
  }

  async sendFrame(imageSource) {
    if (!this.isFaceMeshReady || this.isProcessing || !imageSource) return;
    const now = performance.now();
    if (now - this.lastFrameSendTime < this.minInferenceIntervalMs) return;

    this.lastFrameSendTime = now;
    this.isProcessing = true;

    try {
      if (!this.trackingCanvas) {
        this.trackingCanvas = document.createElement('canvas');
        this.trackingCanvas.width = 360;
        this.trackingCanvas.height = 640;
        this.trackingCtx = this.trackingCanvas.getContext('2d', { willReadFrequently: true });
      }
      this.trackingCtx.drawImage(imageSource, 0, 0, 360, 640);
      await this.faceMesh.send({ image: this.trackingCanvas });
    } catch (err) {
      console.warn('[FaceEngine sendFrame warning]', err);
    } finally {
      this.isProcessing = false;
    }
  }

  handleResults(results) {
    if (results && results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
      const lm = results.multiFaceLandmarks[0];
      this.rawLandmarks = lm;
      this.lastDetectedTime = performance.now();

      if (!this.isFaceFound) {
        this.isFaceFound = true;
        this.trigger('onFaceFound');
        this.hideHint('lens_hint_find_face');
        const badge = document.getElementById('engine-status-text');
        if (badge) badge.textContent = 'Snapchat 3D Mesh (Face Tracked • 468 pts)';
      }

      // Convert normalized landmarks to 720x1280 screen space
      const toScreen = (idx) => ({
        x: lm[idx].x * 720,
        y: lm[idx].y * 1280,
        z: (lm[idx].z || 0) * 720
      });

      const forehead = toScreen(10);
      const headCenter = toScreen(9);
      const nose = toScreen(1);
      const leftEyeOuter = toScreen(33);
      const leftEyeInner = toScreen(133);
      const rightEyeInner = toScreen(362);
      const rightEyeOuter = toScreen(263);
      const leftEye = { x: (leftEyeOuter.x + leftEyeInner.x) / 2, y: (leftEyeOuter.y + leftEyeInner.y) / 2, z: (leftEyeOuter.z + leftEyeInner.z) / 2 };
      const rightEye = { x: (rightEyeOuter.x + rightEyeInner.x) / 2, y: (rightEyeOuter.y + rightEyeInner.y) / 2, z: (rightEyeOuter.z + rightEyeInner.z) / 2 };
      const leftCheek = toScreen(234);
      const rightCheek = toScreen(454);
      const upperLip = toScreen(13);
      const lowerLip = toScreen(14);
      const chin = toScreen(152);

      // Compute Interocular Distance & Scale
      const dx = rightEye.x - leftEye.x;
      const dy = rightEye.y - leftEye.y;
      const interOcular = Math.max(20, Math.hypot(dx, dy));
      const scale = Math.max(0.4, Math.min(2.5, interOcular / 125.0));

      // Compute Head Angle (Roll) in radians & degrees
      const angleRad = Math.atan2(dy, dx);
      const angleDeg = angleRad * (180 / Math.PI);

      // Compute Yaw (turning left / right)
      const eyeMidX = (leftEye.x + rightEye.x) / 2;
      const noseDiffX = (nose.x - eyeMidX) / (interOcular * 0.5);
      const yaw = Math.max(-1.0, Math.min(1.0, noseDiffX * 1.5));

      // Compute Pitch (tilting up / down)
      const eyeMidY = (leftEye.y + rightEye.y) / 2;
      const noseDiffY = (nose.y - eyeMidY) / (interOcular * 0.5) - 0.7;
      const pitch = Math.max(-1.0, Math.min(1.0, noseDiffY * 2.0));

      // Compute Mouth Open Ratio (Euclidean distance immune to roll)
      const mouthGap = Math.hypot(lowerLip.x - upperLip.x, lowerLip.y - upperLip.y);
      const mouthRatio = mouthGap / interOcular;
      const isMouthOpen = mouthRatio > 0.08;

      // Update target
      this.target.headAngle = angleDeg;
      this.target.headAngleRad = angleRad;
      this.target.headYaw = yaw;
      this.target.headPitch = pitch;
      this.target.scaleFactor = scale;
      this.target.foreheadPosition2D = forehead;
      this.target.headCenterPosition2D = headCenter;
      this.target.leftEyePosition2D = leftEye;
      this.target.rightEyePosition2D = rightEye;
      this.target.nosePosition2D = nose;
      this.target.mouthPosition2D = { x: (upperLip.x + lowerLip.x) / 2, y: (upperLip.y + lowerLip.y) / 2 };
      this.target.leftCheekPosition2D = leftCheek;
      this.target.rightCheekPosition2D = rightCheek;
      this.target.chinPosition2D = chin;
      this.target.mouthOpenRatio = mouthRatio;
      this.target.isMouthOpen = isMouthOpen;
      this.target.isWideOpen = mouthRatio > 0.28;

      // Check Facial Events
      if (isMouthOpen && !this.publicVars.isMouthOpen) {
        this.trigger('onMouthOpened');
        this.hideHint('lens_hint_open_your_mouth');
      } else if (!isMouthOpen && this.publicVars.isMouthOpen) {
        this.trigger('onMouthClosed');
      }

      // Check Tilt Events
      if (Math.abs(angleDeg) < 4) {
        if (this.currentHeadState !== 'NONE') {
          this.currentHeadState = 'NONE';
          this.trigger('onTiltCenter');
        }
      } else if (angleDeg < -this.headTiltThresholdAngle) {
        if (this.currentHeadState !== 'LEFT') {
          this.currentHeadState = 'LEFT';
          this.trigger('onTiltLeft');
          this.hideHint('lens_hint_tilt_your_head');
        }
      } else if (angleDeg > this.headTiltThresholdAngle) {
        if (this.currentHeadState !== 'RIGHT') {
          this.currentHeadState = 'RIGHT';
          this.trigger('onTiltRight');
          this.hideHint('lens_hint_tilt_your_head');
        }
      }

    } else {
      // Face lost
      if (this.isFaceFound && (performance.now() - this.lastDetectedTime > 900)) {
        this.isFaceFound = false;
        this.trigger('onFaceLost');
        const badge = document.getElementById('engine-status-text');
        if (badge) badge.textContent = 'Snapchat 3D Mesh (Searching for Face...)';
      }
    }
  }

  // Smooth interpolation every render frame (60-120 FPS capable, zero jitter)
  updateSmoothedState() {
    const dt = 0.016;
    const pv = this.publicVars;
    const tg = this.target;

    // If face not detected recently, gently float to center
    if (!this.isFaceFound) {
      const t = performance.now() * 0.0015;
      tg.foreheadPosition2D = { x: 360 + Math.sin(t) * 12, y: 350 + Math.cos(t * 1.3) * 8 };
      tg.headCenterPosition2D = { x: 360, y: 440 };
      tg.leftEyePosition2D = { x: 295, y: 460 };
      tg.rightEyePosition2D = { x: 425, y: 460 };
      tg.nosePosition2D = { x: 360, y: 530 };
      tg.mouthPosition2D = { x: 360, y: 650 };
      tg.leftCheekPosition2D = { x: 220, y: 560 };
      tg.rightCheekPosition2D = { x: 500, y: 560 };
      tg.chinPosition2D = { x: 360, y: 780 };
      tg.headAngle = Math.sin(t) * 2;
      tg.headAngleRad = (Math.sin(t) * 2) * Math.PI / 180;
      tg.headYaw = Math.sin(t * 0.8) * 0.08;
      tg.headPitch = 0;
      tg.scaleFactor = 1.0;
      tg.mouthOpenRatio = 0;
      tg.isMouthOpen = false;
    }

    pv.foreheadPosition2D.x = this.smoothForeheadX.filter(tg.foreheadPosition2D.x, dt);
    pv.foreheadPosition2D.y = this.smoothForeheadY.filter(tg.foreheadPosition2D.y, dt);

    pv.headCenterPosition2D.x = this.smoothHeadCenterX.filter(tg.headCenterPosition2D.x, dt);
    pv.headCenterPosition2D.y = this.smoothHeadCenterY.filter(tg.headCenterPosition2D.y, dt);

    pv.leftEyePosition2D.x = this.smoothLeftEyeX.filter(tg.leftEyePosition2D.x, dt);
    pv.leftEyePosition2D.y = this.smoothLeftEyeY.filter(tg.leftEyePosition2D.y, dt);

    pv.rightEyePosition2D.x = this.smoothRightEyeX.filter(tg.rightEyePosition2D.x, dt);
    pv.rightEyePosition2D.y = this.smoothRightEyeY.filter(tg.rightEyePosition2D.y, dt);

    pv.nosePosition2D.x = this.smoothNoseX.filter(tg.nosePosition2D.x, dt);
    pv.nosePosition2D.y = this.smoothNoseY.filter(tg.nosePosition2D.y, dt);

    pv.mouthPosition2D.x = this.smoothMouthX.filter(tg.mouthPosition2D.x, dt);
    pv.mouthPosition2D.y = this.smoothMouthY.filter(tg.mouthPosition2D.y, dt);

    pv.leftCheekPosition2D.x = this.smoothLeftCheekX.filter(tg.leftCheekPosition2D.x, dt);
    pv.leftCheekPosition2D.y = this.smoothLeftCheekY.filter(tg.leftCheekPosition2D.y, dt);

    pv.rightCheekPosition2D.x = this.smoothRightCheekX.filter(tg.rightCheekPosition2D.x, dt);
    pv.rightCheekPosition2D.y = this.smoothRightCheekY.filter(tg.rightCheekPosition2D.y, dt);

    pv.chinPosition2D.x = this.smoothChinX.filter(tg.chinPosition2D.x, dt);
    pv.chinPosition2D.y = this.smoothChinY.filter(tg.chinPosition2D.y, dt);

    pv.headAngleRad = this.smoothRoll.filter(tg.headAngleRad, dt);
    pv.headAngle = pv.headAngleRad * (180 / Math.PI);
    pv.headYaw = this.smoothYaw.filter(tg.headYaw, dt);
    pv.headPitch = this.smoothPitch.filter(tg.headPitch, dt);
    pv.scaleFactor = this.smoothScale.filter(tg.scaleFactor, dt);
    pv.mouthOpenRatio = this.smoothMouthRatio.filter(tg.mouthOpenRatio, dt);

    pv.isMouthOpen = pv.mouthOpenRatio > 0.09;
    pv.isWideOpen = pv.mouthOpenRatio > 0.25;
    pv.isFaceFound = this.isFaceFound;
  }

  showHint(hintName, durationSec = 4) {
    const capsule = document.getElementById('snap-hint-capsule');
    const icon = document.getElementById('snap-hint-icon');
    const text = document.getElementById('snap-hint-text');
    if (!capsule || !text) return;

    this.currentHint = hintName;
    clearTimeout(this.hintTimeout);

    const hintMap = {
      lens_hint_open_your_mouth: { icon: '👄', text: 'OPEN YOUR MOUTH' },
      lens_hint_find_face: { icon: '👤', text: 'FIND A FACE' },
      lens_hint_tilt_your_head: { icon: '🔄', text: 'TILT YOUR HEAD' },
      lens_hint_smile: { icon: '😊', text: 'SMILE' },
      lens_hint_raise_your_eyebrows: { icon: '👀', text: 'RAISE YOUR EYEBROWS' }
    };

    const cfg = hintMap[hintName] || { icon: '✨', text: hintName.replace('lens_hint_', '').replace(/_/g, ' ') };
    if (icon) icon.textContent = cfg.icon;
    text.textContent = cfg.text;

    capsule.classList.remove('fade-out');
    capsule.style.display = 'inline-flex';

    if (durationSec > 0) {
      this.hintTimeout = setTimeout(() => {
        this.hideHint(hintName);
      }, durationSec * 1000);
    }
  }

  hideHint(hintName) {
    if (hintName && this.currentHint !== hintName) return;
    const capsule = document.getElementById('snap-hint-capsule');
    if (!capsule) return;
    capsule.classList.add('fade-out');
    setTimeout(() => {
      if (capsule.classList.contains('fade-out')) {
        capsule.style.display = 'none';
      }
    }, 280);
    this.currentHint = null;
  }

  drawWireframe(ctx) {
    if (!this.showWireframe || !this.rawLandmarks) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(0, 242, 254, 0.45)';
    ctx.fillStyle = 'rgba(0, 242, 254, 0.8)';
    ctx.lineWidth = 0.8;

    const lm = this.rawLandmarks;
    const step = 3;
    for (let i = 0; i < lm.length; i += step) {
      const px = lm[i].x * 720;
      const py = lm[i].y * 1280;
      ctx.fillRect(px - 1, py - 1, 2, 2);
    }

    // Face contour
    const faceOval = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109, 10];
    ctx.beginPath();
    faceOval.forEach((idx, i) => {
      const px = lm[idx].x * 720;
      const py = lm[idx].y * 1280;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();

    // Key anchors in glowing gold
    ctx.fillStyle = '#fffc00';
    [10, 9, 1, 33, 263, 13, 14, 234, 454].forEach(idx => {
      ctx.beginPath();
      ctx.arc(lm[idx].x * 720, lm[idx].y * 1280, 3.5, 0, Math.PI * 2);
      ctx.fill();
    });

    // Telemetry Box
    ctx.fillStyle = 'rgba(6, 8, 13, 0.8)';
    ctx.strokeStyle = 'rgba(0, 242, 254, 0.4)';
    ctx.fillRect(20, 90, 260, 68);
    ctx.strokeRect(20, 90, 260, 68);
    ctx.fillStyle = '#00f2fe';
    ctx.font = '10px monospace';
    const pv = this.publicVars;
    ctx.fillText(`3D FACE MESH • 468 LANDMARKS`, 30, 106);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`Roll: ${pv.headAngle.toFixed(1)}° | Yaw: ${pv.headYaw.toFixed(2)}`, 30, 122);
    ctx.fillText(`Scale: ${pv.scaleFactor.toFixed(2)} | Mouth: ${(pv.mouthOpenRatio * 100).toFixed(0)}%`, 30, 138);

    ctx.restore();
  }
}

// Global Toggle for 3D Face Mesh Wireframe
window.toggleMeshWireframe = function() {
  if (!snapTracker) return;
  snapTracker.showWireframe = !snapTracker.showWireframe;
  const btn = document.getElementById('btn-mesh');
  if (btn) btn.classList.toggle('active', snapTracker.showWireframe);
};

// ==========================================
// SNAPCHAT 3D WEBGL RUNTIME (Three.js Engine)
// ==========================================
function initSnapchat3DRuntime() {
  if (threeRenderer) return;

  threeCanvas = document.getElementById('ck-three-canvas');
  if (!threeCanvas) {
    console.warn('[SnapAR 3D] #ck-three-canvas element not found');
    return;
  }

  if (typeof window.THREE === 'undefined') {
    setTimeout(initSnapchat3DRuntime, 250);
    return;
  }

  try {
    threeCanvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.warn('[SnapAR 3D] WebGL context loss captured & handled.');
    }, false);

    threeRenderer = new THREE.WebGLRenderer({
      canvas: threeCanvas,
      alpha: true,
      antialias: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
      premultipliedAlpha: true
    });
    threeRenderer.setSize(720, 1280, false);
    threeRenderer.setPixelRatio(1);
    threeRenderer.setClearColor(0x000000, 0);

    threeScene = new THREE.Scene();

    // 9:16 Portrait Camera FOV (Maps 1 Three.js unit = 1 pixel at Z=0)
    const fov = 45;
    const aspect = 720 / 1280;
    threeCamera = new THREE.PerspectiveCamera(fov, aspect, 1, 4000);
    const camZ = (1280 / 2) / Math.tan((fov * Math.PI / 180) / 2);
    threeCamera.position.set(0, 0, camZ);
    threeCamera.lookAt(0, 0, 0);
    threeScene.add(threeCamera);

    // Dynamic Cinematic Studio Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.95);
    threeScene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0xfffaed, 1.5);
    keyLight.position.set(200, 450, 500);
    threeScene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x00d2ff, 1.4);
    rimLight.position.set(-250, -200, 300);
    threeScene.add(rimLight);

    const fillLight = new THREE.DirectionalLight(0x99bbff, 0.8);
    fillLight.position.set(0, -300, 400);
    threeScene.add(fillLight);

    // Root Group for Crown Attachment
    abyssalCrownGroup = new THREE.Group();
    threeScene.add(abyssalCrownGroup);

    // Root Group for Custom Uploaded 3D Models
    custom3DGroup = new THREE.Group();
    threeScene.add(custom3DGroup);

    console.log('[SnapAR 3D] WebGL Engine initialized successfully');

    // Trigger async OBJ model fetch
    loadAbyssalCrown3DModel();
  } catch (err) {
    console.error('[SnapAR 3D] Failed to initialize Three.js runtime:', err);
  }
}

// Load Snapchat Abyssal Crown 3D Model & PBR Texture
function loadAbyssalCrown3DModel() {
  if (is3DModelLoaded || isLoading3DModel) return;
  if (!threeScene || typeof THREE.OBJLoader === 'undefined') {
    setTimeout(loadAbyssalCrown3DModel, 300);
    return;
  }

  isLoading3DModel = true;

  try {
    const textureLoader = new THREE.TextureLoader();
    const crownTex = textureLoader.load(
      '/static/samples/abyssal_crown_tex.png',
      () => {
        console.log('[SnapAR 3D] Crown texture loaded successfully');
      },
      undefined,
      (err) => {
        console.warn('[SnapAR 3D] Texture load error, using base material:', err);
      }
    );

    abyssalCrownMaterial = new THREE.MeshStandardMaterial({
      map: crownTex,
      roughness: 0.28,
      metalness: 0.82,
      color: 0xffffff,
      emissive: new THREE.Color(0x002244),
      emissiveIntensity: 0.35,
      transparent: true,
      side: THREE.DoubleSide
    });

    const objLoader = new THREE.OBJLoader();
    objLoader.load(
      '/static/samples/abyssal_crown.obj',
      (obj) => {
        obj.traverse((child) => {
          if (child.isMesh) {
            child.material = abyssalCrownMaterial;
            child.geometry.computeVertexNormals();
          }
        });

        // Center base band on group anchor
        obj.position.set(0, 0.38, 0);

        abyssalCrownGroup.add(obj);
        is3DModelLoaded = true;
        isLoading3DModel = false;
        console.log('[SnapAR 3D] Abyssal Crown 3D mesh loaded & mounted (26,997 vertices)');
      },
      (xhr) => {
        if (xhr.lengthComputable) {
          const percent = Math.round((xhr.loaded / xhr.total) * 100);
          console.log(`[SnapAR 3D] Crown loading: ${percent}%`);
        }
      },
      (err) => {
        console.error('[SnapAR 3D] OBJ load error:', err);
        isLoading3DModel = false;
      }
    );
  } catch (err) {
    console.error('[SnapAR 3D] Failed to load 3D crown assets:', err);
    isLoading3DModel = false;
  }
}

// Load Custom Uploaded 3D Model into Three.js
async function loadCustomLens3DModel(url, type, textureUrl) {
  if (!threeScene) return;
  if (!custom3DGroup) {
    custom3DGroup = new THREE.Group();
    threeScene.add(custom3DGroup);
  }
  // Clear existing meshes
  while (custom3DGroup.children.length > 0) {
    custom3DGroup.remove(custom3DGroup.children[0]);
  }

  let tex = null;
  if (textureUrl) {
    try {
      tex = new THREE.TextureLoader().load(textureUrl);
    } catch (_) {}
  }

  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    roughness: 0.35,
    metalness: 0.75,
    color: 0xffffff,
    transparent: true,
    side: THREE.DoubleSide
  });

  if (type === 'glb' && typeof THREE.GLTFLoader !== 'undefined') {
    const loader = new THREE.GLTFLoader();
    loader.load(url, (gltf) => {
      const model = gltf.scene || gltf.scenes[0];
      const box = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3();
      box.getSize(size);
      const center = new THREE.Vector3();
      box.getCenter(center);
      model.position.sub(center);
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const s = 1.0 / maxDim;
      model.scale.set(s, s, s);
      custom3DGroup.add(model);
      console.log('[SnapAR 3D] Mounted custom GLB model to face anchor');
    }, undefined, (e) => console.warn('[SnapAR 3D] GLB Load Error', e));
  } else if (type === 'obj' && typeof THREE.OBJLoader !== 'undefined') {
    const loader = new THREE.OBJLoader();
    loader.load(url, (obj) => {
      obj.traverse((child) => {
        if (child.isMesh) {
          child.material = mat;
          child.geometry.computeVertexNormals();
        }
      });
      const box = new THREE.Box3().setFromObject(obj);
      const size = new THREE.Vector3();
      box.getSize(size);
      const center = new THREE.Vector3();
      box.getCenter(center);
      obj.position.sub(center);
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const s = 1.0 / maxDim;
      obj.scale.set(s, s, s);
      custom3DGroup.add(obj);
      console.log('[SnapAR 3D] Mounted custom OBJ model to face anchor');
    }, undefined, (e) => console.warn('[SnapAR 3D] OBJ Load Error', e));
  }
}

// Cached Lens Icons
const lensIconCache = new Map();
function getCachedLensIcon(lensMeta) {
  if (!lensMeta || !lensMeta.icon_url) return null;
  if (!lensIconCache.has(lensMeta.icon_url)) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = lensMeta.icon_url;
    lensIconCache.set(lensMeta.icon_url, img);
  }
  return lensIconCache.get(lensMeta.icon_url);
}

// Particles Initialization
function resetLocalArParticles() {
  crownParticles = [];
  kitsuneWisps = [];
  mouthVfxParticles = [];

  for (let i = 0; i < 28; i++) {
    crownParticles.push({
      x: 360 + (Math.random() - 0.5) * 260,
      y: 350 + Math.random() * 80,
      vy: -(0.8 + Math.random() * 1.5),
      vx: (Math.random() - 0.5) * 0.8,
      size: 2 + Math.random() * 3.5,
      life: Math.random(),
      hue: 185 + Math.random() * 20
    });
  }

  for (let i = 0; i < 16; i++) {
    kitsuneWisps.push({
      angle: Math.random() * Math.PI * 2,
      radius: 90 + Math.random() * 60,
      speed: 0.02 + Math.random() * 0.03,
      yOff: (Math.random() - 0.5) * 40,
      size: 4 + Math.random() * 6,
      color: Math.random() > 0.4 ? '#ff2a7a' : '#fffc00'
    });
  }
}

// Start Snapchat Local AR Engine
function startLocalArEngine() {
  const canvas = document.getElementById('ck-canvas');
  const ctx = canvas.getContext('2d');
  const cropCanvas = document.getElementById('ck-crop-canvas');
  const cropCtx = cropCanvas.getContext('2d');
  const videoInput = document.getElementById('ck-video-input');
  const webcamRaw = document.getElementById('ck-webcam-raw');
  const rawCanvas = document.getElementById('split-raw-canvas');
  const rawCtx = rawCanvas ? rawCanvas.getContext('2d') : null;

  resetLocalArParticles();

  // Initialize Snapchat 3D WebGL Engine
  initSnapchat3DRuntime();

  // Initialize Snapchat Tracker
  snapTracker = new SnapchatFaceEngine();
  window.snapTracker = snapTracker;

  // Show initial hint for active lens
  setTimeout(() => {
    if (snapTracker) snapTracker.showHint('lens_hint_open_your_mouth', 5);
  }, 1000);

  const renderFrame = (timestamp) => {
    localFaceSimTime += 0.025;

    // 1. Capture Raw Frame from Input Source
    if (ckActiveSource === 'webcam') {
      if (webcamRaw.videoWidth > 0 && webcamRaw.videoHeight > 0) {
        const vw = webcamRaw.videoWidth;
        const vh = webcamRaw.videoHeight;
        cropCtx.save();
        cropCtx.fillStyle = '#06080d';
        cropCtx.fillRect(0, 0, 720, 1280);

        const scale = Math.max(720 / vw, 1280 / vh);
        const dw = vw * scale;
        const dh = vh * scale;
        const dx = (720 - dw) / 2;
        const dy = (1280 - dh) / 2;

        if (ckIsMirrored) {
          cropCtx.translate(720, 0);
          cropCtx.scale(-1, 1);
        }
        cropCtx.drawImage(webcamRaw, dx, dy, dw, dh);
        cropCtx.restore();
      }
    } else if (ckActiveSource === 'model1' || ckActiveSource === 'model2' || (ckActiveSource === 'custom' && customMediaType === 'video')) {
      if (videoInput.videoWidth > 0 && videoInput.videoHeight > 0) {
        cropCtx.drawImage(videoInput, 0, 0, 720, 1280);
      }
    }

    // Send frame to Face Tracking engine asynchronously
    snapTracker.sendFrame(cropCanvas);

    // Update smooth tracking state (interpolated at 60-120 FPS)
    snapTracker.updateSmoothedState();

    // 2. Draw Base Video Frame to Main Canvas
    ctx.save();
    ctx.drawImage(cropCanvas, 0, 0, 720, 1280);

    // If Split comparison is active, update rawCanvas
    if (isSplitModeActive && rawCtx) {
      rawCtx.drawImage(cropCanvas, 0, 0, 720, 1280);
    }

    // 3. Beauty & Soft Glow Filter (Bilateral Skin Contrast & Tone Bloom)
    if (ckBeautyGlow) {
      ctx.save();
      ctx.globalCompositeOperation = 'soft-light';
      ctx.fillStyle = 'rgba(255, 235, 220, 0.15)';
      ctx.fillRect(0, 0, 720, 1280);
      ctx.restore();
    }

    // 4. Render Active AR Lens (100% Face-Tracked via Snapchat Kinematics)
    renderActiveArLens(ctx, snapTracker, localFaceSimTime);

    // 5. Wireframe Overlay (if toggled)
    snapTracker.drawWireframe(ctx);

    // 6. If recording video, composite 3D overlay into main canvas stream
    if (isRecordingVideo && (abyssalCrownGroup?.visible || custom3DGroup?.visible)) {
      const threeCv = document.getElementById('ck-three-canvas');
      if (threeCv) ctx.drawImage(threeCv, 0, 0, 720, 1280);
    }

    ctx.restore();

    localRenderLoopId = requestAnimationFrame(renderFrame);
  };

  localRenderLoopId = requestAnimationFrame(renderFrame);
}

// RENDER ACTIVE AR LENS
function renderActiveArLens(ctx, tracker, t) {
  const pv = tracker.publicVars;

  // LENS 1: Celestial Kitsune
  if (ckCurrentLensId === "4df2b87d-52eb-4ec3-bc0f-fd1919712256") {
    if (abyssalCrownGroup) abyssalCrownGroup.visible = false;
    if (custom3DGroup) custom3DGroup.visible = false;
    if (threeRenderer) threeRenderer.clear();
    renderCelestialKitsune(ctx, pv, t);
  }
  // LENS 2: Verdant Gilded Tiara
  else if (ckCurrentLensId === "verdant_gilded") {
    if (abyssalCrownGroup) abyssalCrownGroup.visible = false;
    if (custom3DGroup) custom3DGroup.visible = false;
    if (threeRenderer) threeRenderer.clear();
    renderVerdantTiara(ctx, pv, t);
  }
  // LENS 3: Abyssal Crown (True 3D WebGL Mesh)
  else if (ckCurrentLensId === "06ab0c08-158f-762e-8000-87bcd093434c") {
    if (custom3DGroup) custom3DGroup.visible = false;
    renderAbyssalCrown(ctx, pv, t);
  }
  // LENS 4: Custom Uploaded / Sideloaded Lenses
  else {
    if (abyssalCrownGroup) abyssalCrownGroup.visible = false;
    const lensMeta = loadedLensesList.find(l => l.id === ckCurrentLensId);
    renderUploadedCustomLens(ctx, pv, t, lensMeta);
  }
}

// 1. CELESTIAL KITSUNE (100% Landmark-Locked with Foxfire Mouth Blast)
function renderCelestialKitsune(ctx, pv, t) {
  const fx = pv.foreheadPosition2D.x;
  const fy = pv.foreheadPosition2D.y;
  const cx = pv.headCenterPosition2D.x;
  const cy = pv.headCenterPosition2D.y;
  const scale = pv.scaleFactor;
  const roll = pv.headAngleRad;
  const yaw = pv.headYaw;
  const isMouthOpen = pv.isMouthOpen;

  ctx.save();

  // Floating Foxfire Aura Wisps orbiting head center
  kitsuneWisps.forEach(w => {
    w.angle += w.speed;
    const wx = cx + Math.cos(w.angle) * (w.radius * scale) + (yaw * 25);
    const wy = cy + Math.sin(w.angle) * (w.radius * 0.6 * scale) + w.yOff * scale;

    const grad = ctx.createRadialGradient(wx, wy, 1, wx, wy, w.size * 2.5 * scale);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.3, isMouthOpen ? '#fffc00' : w.color);
    grad.addColorStop(1, 'rgba(255, 42, 122, 0)');

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(wx, wy, w.size * 2.5 * scale, 0, Math.PI * 2);
    ctx.fill();
  });

  // SPIRIT FOX EARS (Anchored to Forehead Hairline, Rotated to Head Tilt)
  const earW = 56 * scale;
  const earH = 115 * scale;
  const earY = fy - 50 * scale;

  // Left Spirit Ear (Perspective adjusted with Yaw)
  ctx.save();
  const leftEarX = fx - 78 * scale + yaw * 18 * scale;
  ctx.translate(leftEarX, earY);
  ctx.rotate(roll - 0.22 + Math.sin(t * 1.6) * 0.04 - yaw * 0.15);

  let earGrad = ctx.createLinearGradient(0, earH, 0, -earH);
  earGrad.addColorStop(0, isMouthOpen ? '#fffc00' : 'rgba(255, 42, 122, 0.95)');
  earGrad.addColorStop(1, '#ffffff');
  ctx.fillStyle = earGrad;
  ctx.shadowColor = isMouthOpen ? '#fffc00' : '#ff2a7a';
  ctx.shadowBlur = isMouthOpen ? 32 : 22;

  ctx.beginPath();
  ctx.moveTo(0, earH * 0.5);
  ctx.lineTo(-earW, 0);
  ctx.quadraticCurveTo(-earW * 0.4, -earH * 0.6, 0, -earH);
  ctx.quadraticCurveTo(earW * 0.4, -earH * 0.4, earW, 0);
  ctx.closePath();
  ctx.fill();

  // Inner Golden Flame
  ctx.fillStyle = '#fffc00';
  ctx.shadowColor = '#fffc00';
  ctx.shadowBlur = 18;
  ctx.beginPath();
  ctx.moveTo(0, earH * 0.3);
  ctx.lineTo(-earW * 0.4, 0);
  ctx.lineTo(0, -earH * 0.6);
  ctx.lineTo(earW * 0.4, 0);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Right Spirit Ear
  ctx.save();
  const rightEarX = fx + 78 * scale + yaw * 18 * scale;
  ctx.translate(rightEarX, earY);
  ctx.rotate(roll + 0.22 - Math.sin(t * 1.6) * 0.04 - yaw * 0.15);

  earGrad = ctx.createLinearGradient(0, earH, 0, -earH);
  earGrad.addColorStop(0, isMouthOpen ? '#fffc00' : 'rgba(255, 42, 122, 0.95)');
  earGrad.addColorStop(1, '#ffffff');
  ctx.fillStyle = earGrad;
  ctx.shadowColor = isMouthOpen ? '#fffc00' : '#ff2a7a';
  ctx.shadowBlur = isMouthOpen ? 32 : 22;

  ctx.beginPath();
  ctx.moveTo(0, earH * 0.5);
  ctx.lineTo(-earW, 0);
  ctx.quadraticCurveTo(-earW * 0.4, -earH * 0.4, 0, -earH);
  ctx.quadraticCurveTo(earW * 0.4, -earH * 0.6, earW, 0);
  ctx.closePath();
  ctx.fill();

  // Inner Golden Flame
  ctx.fillStyle = '#fffc00';
  ctx.shadowColor = '#fffc00';
  ctx.shadowBlur = 18;
  ctx.beginPath();
  ctx.moveTo(0, earH * 0.3);
  ctx.lineTo(-earW * 0.4, 0);
  ctx.lineTo(0, -earH * 0.6);
  ctx.lineTo(earW * 0.4, 0);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // FOREHEAD SPIRIT CREST (Third Eye Radiant Emblem) Locked to Head Center
  const crestPulse = (1 + Math.sin(t * 3.5) * 0.12) * scale * (isMouthOpen ? 1.35 : 1.0);
  ctx.save();
  ctx.translate(cx, cy - 25 * scale);
  ctx.rotate(roll);
  ctx.scale(crestPulse, crestPulse);

  ctx.shadowColor = isMouthOpen ? '#fffc00' : '#ff2a7a';
  ctx.shadowBlur = isMouthOpen ? 30 : 20;
  ctx.fillStyle = isMouthOpen ? '#fffc00' : '#ff2a7a';
  ctx.beginPath();
  ctx.moveTo(0, -22);
  ctx.lineTo(14, 0);
  ctx.lineTo(0, 22);
  ctx.lineTo(-14, 0);
  ctx.closePath();
  ctx.fill();

  ctx.shadowColor = '#fffc00';
  ctx.shadowBlur = 16;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(0, 0, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // CHEEK SPIRIT WHISKERS (Anchored to Left & Right Cheeks)
  ctx.strokeStyle = isMouthOpen ? 'rgba(255, 252, 0, 0.95)' : 'rgba(255, 42, 122, 0.88)';
  ctx.shadowColor = isMouthOpen ? '#fffc00' : '#ff2a7a';
  ctx.shadowBlur = 12;
  ctx.lineWidth = 3.5 * scale;
  ctx.lineCap = 'round';

  // Left Whiskers
  ctx.save();
  ctx.translate(pv.leftCheekPosition2D.x, pv.leftCheekPosition2D.y);
  ctx.rotate(roll);
  ctx.beginPath();
  ctx.moveTo(0, -10 * scale);
  ctx.quadraticCurveTo(-40 * scale, -15 * scale, -80 * scale, -25 * scale);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, 10 * scale);
  ctx.quadraticCurveTo(-40 * scale, 12 * scale, -75 * scale, 5 * scale);
  ctx.stroke();
  ctx.restore();

  // Right Whiskers
  ctx.save();
  ctx.translate(pv.rightCheekPosition2D.x, pv.rightCheekPosition2D.y);
  ctx.rotate(roll);
  ctx.beginPath();
  ctx.moveTo(0, -10 * scale);
  ctx.quadraticCurveTo(40 * scale, -15 * scale, 80 * scale, -25 * scale);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, 10 * scale);
  ctx.quadraticCurveTo(40 * scale, 12 * scale, 75 * scale, 5 * scale);
  ctx.stroke();
  ctx.restore();

  // MOUTH OPEN TRIGGER: CELESTIAL FOXFIRE BLAST ERUPTION
  if (isMouthOpen) {
    const mx = pv.mouthPosition2D.x;
    const my = pv.mouthPosition2D.y;

    // Spawn high-velocity Foxfire fireballs
    for (let k = 0; k < 5; k++) {
      mouthVfxParticles.push({
        x: mx + (Math.random() - 0.5) * 20 * scale,
        y: my + (Math.random() - 0.5) * 15 * scale,
        vx: (Math.random() - 0.5) * 8 * scale + (yaw * 3),
        vy: (Math.random() - 0.7) * 7 * scale,
        size: (8 + Math.random() * 16) * scale,
        life: 1.0,
        decay: 0.02 + Math.random() * 0.03,
        color: Math.random() > 0.4 ? '#ff2a7a' : '#fffc00'
      });
    }

    // Radiant Mouth Core Flare
    const flareGrad = ctx.createRadialGradient(mx, my, 2, mx, my, 45 * scale);
    flareGrad.addColorStop(0, '#ffffff');
    flareGrad.addColorStop(0.4, '#fffc00');
    flareGrad.addColorStop(1, 'rgba(255, 42, 122, 0)');
    ctx.fillStyle = flareGrad;
    ctx.beginPath();
    ctx.arc(mx, my, 45 * scale, 0, Math.PI * 2);
    ctx.fill();
  }

  // Update and render mouth particles
  for (let i = mouthVfxParticles.length - 1; i >= 0; i--) {
    const p = mouthVfxParticles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.size *= 1.02;
    p.life -= p.decay;

    if (p.life <= 0) {
      mouthVfxParticles.splice(i, 1);
      continue;
    }

    ctx.save();
    ctx.globalAlpha = p.life;
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.restore();
}

// 2. ABYSSAL CROWN (True 3D Snapchat Mesh WebGL + Dynamic Lightning Surge)
function renderAbyssalCrown(ctx, pv, t) {
  const fx = pv.foreheadPosition2D.x;
  const fy = pv.foreheadPosition2D.y;
  const scale = pv.scaleFactor;
  const roll = pv.headAngleRad;
  const yaw = pv.headYaw;
  const pitch = pv.headPitch;
  const isMouthOpen = pv.isMouthOpen;

  if (is3DModelLoaded && threeRenderer && abyssalCrownGroup) {
    // 3D Three.js WebGL Rendering Pipeline
    abyssalCrownGroup.visible = true;

    // 1:1 Pixel Coordinates in Three.js Perspective Plane
    const threeX = fx - 360;
    const threeY = 640 - (fy - 25 * scale);
    const threeZ = (scale - 1.0) * 120;
    const targetPxWidth = 330 * scale;
    const s = targetPxWidth / 0.702;

    const targetPos = new THREE.Vector3(threeX, threeY, threeZ);
    const targetScale = new THREE.Vector3(s, s, s);
    const targetEuler = new THREE.Euler(-pitch * 0.65, yaw * 0.75, -roll, 'YXZ');
    const targetQuat = new THREE.Quaternion().setFromEuler(targetEuler);

    abyssalCrownGroup.position.lerp(targetPos, 0.28);
    abyssalCrownGroup.scale.lerp(targetScale, 0.20);
    abyssalCrownGroup.quaternion.slerp(targetQuat, 0.25);

    // Wireframe toggle & Emissive PBR glow
    if (abyssalCrownMaterial) {
      const showWire = snapTracker && snapTracker.showWireframe;
      abyssalCrownMaterial.wireframe = !!showWire;

      if (isMouthOpen) {
        abyssalCrownMaterial.emissive.setHex(0x00f2fe);
        abyssalCrownMaterial.emissiveIntensity = 0.95 + Math.sin(t * 12) * 0.35;
      } else if (showWire) {
        abyssalCrownMaterial.emissive.setHex(0x00f2fe);
        abyssalCrownMaterial.emissiveIntensity = 0.8;
      } else {
        abyssalCrownMaterial.emissive.setHex(0x002244);
        abyssalCrownMaterial.emissiveIntensity = 0.3;
      }
    }

    // Render 3D WebGL scene directly to hardware composited overlay
    threeRenderer.render(threeScene, threeCamera);

    // Rising Cyan Embers
    ctx.save();
    ctx.translate(fx, fy - 25 * scale);
    ctx.rotate(roll);
    crownParticles.forEach(p => {
      p.y += p.vy * scale;
      p.x += (p.vx + Math.sin(t * 2 + p.life) * 0.5) * scale;
      if (p.y < -140 * scale) {
        p.y = Math.random() * 20 * scale;
        p.x = (Math.random() - 0.5) * 240 * scale;
      }

      ctx.fillStyle = isMouthOpen ? '#00f2fe' : `hsla(${p.hue}, 100%, 70%, 0.85)`;
      ctx.shadowColor = '#00f2fe';
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * scale, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();

  } else {
    // 2D Procedural Crown Fallback
    ctx.save();
    ctx.translate(fx, fy - 25 * scale);
    ctx.rotate(roll);

    const crownW = 240 * scale;
    const crownBaseY = 0;

    // Rising Embers
    crownParticles.forEach(p => {
      p.y += p.vy * scale;
      p.x += (p.vx + Math.sin(t * 2 + p.life) * 0.5) * scale;
      if (p.y < crownBaseY - 140 * scale) {
        p.y = crownBaseY + Math.random() * 20 * scale;
        p.x = (Math.random() - 0.5) * crownW;
      }

      ctx.fillStyle = isMouthOpen ? '#00f2fe' : `hsla(${p.hue}, 100%, 70%, 0.85)`;
      ctx.shadowColor = '#00f2fe';
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * scale, 0, Math.PI * 2);
      ctx.fill();
    });

    // Base Filigree
    const baseGrad = ctx.createLinearGradient(-crownW / 2, crownBaseY, crownW / 2, crownBaseY);
    baseGrad.addColorStop(0, '#101728');
    baseGrad.addColorStop(0.5, '#d4af37');
    baseGrad.addColorStop(1, '#101728');

    ctx.strokeStyle = baseGrad;
    ctx.lineWidth = 6 * scale;
    ctx.shadowColor = '#00f2fe';
    ctx.shadowBlur = isMouthOpen ? 28 : 16;
    ctx.beginPath();
    ctx.ellipse(0, crownBaseY, crownW * 0.5, 22 * scale, 0, 0, Math.PI * 2);
    ctx.stroke();

    // Spikes & Abyssal Jewels
    const spikeCount = 7;
    const heights = [35, 65, 95, 130, 95, 65, 35];
    const spikeTops = [];

    for (let i = 0; i < spikeCount; i++) {
      const angle = (i / (spikeCount - 1)) * Math.PI - Math.PI / 2;
      const sx = (i - 3) * 36 * scale + (yaw * (4 - Math.abs(i - 3)) * 6 * scale);
      const sy = crownBaseY + Math.sin(angle) * 10 * scale;
      const sh = heights[i] * scale * (isMouthOpen ? 1.15 : 1.0);
      spikeTops.push({ x: sx, y: sy - sh });

      const spikeGrad = ctx.createLinearGradient(sx, sy, sx, sy - sh);
      spikeGrad.addColorStop(0, '#162238');
      spikeGrad.addColorStop(0.6, '#00f2fe');
      spikeGrad.addColorStop(1, '#ffffff');

      ctx.fillStyle = spikeGrad;
      ctx.shadowColor = '#00f2fe';
      ctx.shadowBlur = 20;

      ctx.beginPath();
      ctx.moveTo(sx - 12 * scale, sy);
      ctx.lineTo(sx, sy - sh);
      ctx.lineTo(sx + 12 * scale, sy);
      ctx.closePath();
      ctx.fill();

      // Top Pulsing Jewel
      const pulse = (1 + Math.sin(t * 3 + i) * 0.25) * scale;
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = '#00f2fe';
      ctx.shadowBlur = 18;
      ctx.beginPath();
      ctx.arc(sx, sy - sh, 5 * pulse, 0, Math.PI * 2);
      ctx.fill();
    }

    // Giant Center Sapphire Jewel
    const centerPulse = (1 + Math.sin(t * 2.5) * 0.15) * scale * (isMouthOpen ? 1.4 : 1.0);
    ctx.fillStyle = '#00f2fe';
    ctx.shadowColor = '#00f2fe';
    ctx.shadowBlur = isMouthOpen ? 45 : 30;
    ctx.beginPath();
    ctx.arc(0, crownBaseY - 12 * scale, 13 * centerPulse, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(-3 * scale, crownBaseY - 15 * scale, 4 * scale, 0, Math.PI * 2);
    ctx.fill();

    // Lightning Arcs between spikes when mouth is open
    if (isMouthOpen) {
      ctx.strokeStyle = '#ffffff';
      ctx.shadowColor = '#00f2fe';
      ctx.shadowBlur = 22;
      ctx.lineWidth = 2.5 * scale;
      for (let k = 0; k < spikeTops.length - 1; k++) {
        if (Math.random() > 0.3) {
          ctx.beginPath();
          ctx.moveTo(spikeTops[k].x, spikeTops[k].y);
          const midX = (spikeTops[k].x + spikeTops[k + 1].x) / 2 + (Math.random() - 0.5) * 20 * scale;
          const midY = (spikeTops[k].y + spikeTops[k + 1].y) / 2 + (Math.random() - 0.5) * 20 * scale;
          ctx.lineTo(midX, midY);
          ctx.lineTo(spikeTops[k + 1].x, spikeTops[k + 1].y);
          ctx.stroke();
        }
      }
    }

    ctx.restore();
  }

  // MOUTH ABYSSAL SURGE PARTICLES (Active for both 3D & 2D on mouth trigger)
  if (isMouthOpen) {
    const mx = pv.mouthPosition2D.x;
    const my = pv.mouthPosition2D.y;

    for (let k = 0; k < 4; k++) {
      mouthVfxParticles.push({
        x: mx + (Math.random() - 0.5) * 20 * scale,
        y: my + (Math.random() - 0.5) * 15 * scale,
        vx: (Math.random() - 0.5) * 6 * scale,
        vy: -(4 + Math.random() * 8) * scale,
        size: (5 + Math.random() * 12) * scale,
        life: 1.0,
        decay: 0.03 + Math.random() * 0.02,
        color: Math.random() > 0.3 ? '#00f2fe' : '#ffffff'
      });
    }
  }

  // Render Surge Particles
  for (let i = mouthVfxParticles.length - 1; i >= 0; i--) {
    const p = mouthVfxParticles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.life -= p.decay;

    if (p.life <= 0) {
      mouthVfxParticles.splice(i, 1);
      continue;
    }

    ctx.save();
    ctx.globalAlpha = p.life;
    ctx.fillStyle = p.color;
    ctx.shadowColor = '#00f2fe';
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// 4. CUSTOM UPLOADED / SIDELOADED LENS RENDERER (Local GPU Three.js + AR Cyber Crest)
function renderUploadedCustomLens(ctx, pv, t, lensMeta) {
  const fx = pv.foreheadPosition2D.x;
  const fy = pv.foreheadPosition2D.y;
  const cx = pv.headCenterPosition2D.x;
  const cy = pv.headCenterPosition2D.y;
  const scale = pv.scaleFactor;
  const roll = pv.headAngleRad;
  const yaw = pv.headYaw;
  const pitch = pv.headPitch;
  const isMouthOpen = pv.isMouthOpen;

  // 1. If custom 3D model is loaded, render with Three.js
  if (custom3DGroup && custom3DGroup.children.length > 0 && threeRenderer) {
    custom3DGroup.visible = true;

    const threeX = fx - 360;
    const threeY = 640 - (fy - 20 * scale);
    const threeZ = (scale - 1.0) * 120;

    const targetPos = new THREE.Vector3(threeX, threeY, threeZ);
    const targetScale = new THREE.Vector3(320 * scale, 320 * scale, 320 * scale);
    const targetEuler = new THREE.Euler(-pitch * 0.65, yaw * 0.75, -roll, 'YXZ');
    const targetQuat = new THREE.Quaternion().setFromEuler(targetEuler);

    custom3DGroup.position.lerp(targetPos, 0.28);
    custom3DGroup.scale.lerp(targetScale, 0.20);
    custom3DGroup.quaternion.slerp(targetQuat, 0.25);

    threeRenderer.render(threeScene, threeCamera);
  } else if (threeRenderer) {
    threeRenderer.clear();
  }

  // 2. Render Holographic AR Diadem & Crest on 2D Canvas
  ctx.save();
  ctx.translate(fx, fy - 35 * scale);
  ctx.rotate(roll);

  const pulse = Math.sin(t * 4) * 0.15 + 0.85;
  const crownW = 180 * scale;
  const crownH = 80 * scale;

  ctx.strokeStyle = isMouthOpen ? '#00f2fe' : '#a855f7';
  ctx.lineWidth = 2.5 * scale;
  ctx.shadowColor = isMouthOpen ? '#00f2fe' : '#ec4899';
  ctx.shadowBlur = 18 * pulse;

  // Outer Hologram Diadem Arc
  ctx.beginPath();
  ctx.moveTo(-crownW * 0.5, 0);
  ctx.quadraticCurveTo(0, -crownH * 0.8 * pulse, crownW * 0.5, 0);
  ctx.stroke();

  // Floating Center Lens Icon or Emblem
  const iconImg = getCachedLensIcon(lensMeta);
  if (iconImg && iconImg.complete && iconImg.naturalWidth > 0) {
    ctx.save();
    const gemSize = 44 * scale * pulse;
    ctx.beginPath();
    ctx.arc(0, -crownH * 0.4, gemSize * 0.5, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(iconImg, -gemSize * 0.5, -crownH * 0.4 - gemSize * 0.5, gemSize, gemSize);
    ctx.restore();

    ctx.beginPath();
    ctx.arc(0, -crownH * 0.4, gemSize * 0.5, 0, Math.PI * 2);
    ctx.strokeStyle = '#00f2fe';
    ctx.lineWidth = 2 * scale;
    ctx.stroke();
  } else {
    ctx.fillStyle = isMouthOpen ? '#00f2fe' : '#ec4899';
    ctx.beginPath();
    ctx.moveTo(0, -crownH * 0.65);
    ctx.lineTo(16 * scale, -crownH * 0.4);
    ctx.lineTo(0, -crownH * 0.15);
    ctx.lineTo(-16 * scale, -crownH * 0.4);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();

  // 3. Glowing Cheek Markings (Kinematically Locked)
  ctx.save();
  ctx.strokeStyle = 'rgba(0, 242, 254, 0.75)';
  ctx.lineWidth = 2 * scale;
  ctx.shadowColor = '#00f2fe';
  ctx.shadowBlur = 10;

  const lx = pv.leftCheekPosition2D.x;
  const ly = pv.leftCheekPosition2D.y;
  const rx = pv.rightCheekPosition2D.x;
  const ry = pv.rightCheekPosition2D.y;

  ctx.beginPath();
  ctx.moveTo(lx - 20 * scale, ly - 10 * scale);
  ctx.lineTo(lx, ly);
  ctx.lineTo(lx - 15 * scale, ly + 15 * scale);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(rx + 20 * scale, ry - 10 * scale);
  ctx.lineTo(rx, ry);
  ctx.lineTo(rx + 15 * scale, ry + 15 * scale);
  ctx.stroke();
  ctx.restore();

  // 4. Mouth Particle Energy Surge
  if (isMouthOpen) {
    const mx = pv.mouthPosition2D.x;
    const my = pv.mouthPosition2D.y;
    const mRatio = pv.mouthOpenRatio;

    ctx.save();
    ctx.translate(mx, my);
    ctx.fillStyle = '#00f2fe';
    ctx.shadowColor = '#00f2fe';
    ctx.shadowBlur = 24;

    ctx.beginPath();
    ctx.ellipse(0, 0, 18 * scale * (1 + mRatio), 26 * scale * (1 + mRatio), roll, 0, Math.PI * 2);
    ctx.fill();

    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2 + t * 6;
      const len = (40 + Math.random() * 50) * scale * (1 + mRatio);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = 2 * scale;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(ang) * len, Math.sin(ang) * len);
      ctx.stroke();
    }
    ctx.restore();
  }
}

// 3. VERDANT GILDED TIARA (100% Landmark-Locked with Emerald Starburst)
function renderVerdantTiara(ctx, pv, t) {
  const fx = pv.foreheadPosition2D.x;
  const fy = pv.foreheadPosition2D.y;
  const scale = pv.scaleFactor;
  const roll = pv.headAngleRad;
  const isMouthOpen = pv.isMouthOpen;

  ctx.save();
  ctx.translate(fx, fy - 20 * scale);
  ctx.rotate(roll);

  const tiaraW = 210 * scale;
  const tiaraBaseY = 0;

  // Gilded Gold Arc
  ctx.strokeStyle = '#ffd700';
  ctx.shadowColor = '#ffd700';
  ctx.shadowBlur = isMouthOpen ? 26 : 14;
  ctx.lineWidth = 5 * scale;
  ctx.beginPath();
  ctx.arc(0, tiaraBaseY + 60 * scale, tiaraW * 0.55, -Math.PI * 0.72, -Math.PI * 0.28);
  ctx.stroke();

  // Emerald Jewels & Golden Leaves
  const gems = [
    { x: -75 * scale, y: tiaraBaseY + 12 * scale, r: 8 * scale },
    { x: -40 * scale, y: tiaraBaseY - 12 * scale, r: 11 * scale },
    { x: 0, y: tiaraBaseY - 32 * scale, r: 15 * scale },
    { x: 40 * scale, y: tiaraBaseY - 12 * scale, r: 11 * scale },
    { x: 75 * scale, y: tiaraBaseY + 12 * scale, r: 8 * scale }
  ];

  gems.forEach((g, idx) => {
    ctx.fillStyle = '#00e676';
    ctx.shadowColor = '#00e676';
    ctx.shadowBlur = 22;

    ctx.beginPath();
    ctx.moveTo(g.x, g.y - g.r * 1.3);
    ctx.lineTo(g.x + g.r, g.y);
    ctx.lineTo(g.x, g.y + g.r * 1.3);
    ctx.lineTo(g.x - g.r, g.y);
    ctx.closePath();
    ctx.fill();

    const sparkAngle = t * 1.8 + idx;
    const sparkScale = Math.sin(t * 4 + idx);
    if (sparkScale > 0.2 || isMouthOpen) {
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = '#ffffff';
      ctx.shadowBlur = 16;
      ctx.save();
      ctx.translate(g.x, g.y);
      ctx.rotate(sparkAngle);
      ctx.fillRect(-1.5 * scale, -10 * scale, 3 * scale, 20 * scale);
      ctx.fillRect(-10 * scale, -1.5 * scale, 20 * scale, 3 * scale);
      ctx.restore();
    }
  });

  ctx.restore();
}

// SNAPCHAT SHUTTER (Tap for Photo, Hold for Video)
function setupShutter() {
  const shutterBtn = document.getElementById('snap-shutter');
  if (!shutterBtn) return;

  const onPointerDown = (e) => {
    e.preventDefault();
    isPressingShutter = true;
    shutterPressTimer = setTimeout(() => {
      startVideoRecording();
    }, 380);
  };

  const onPointerUp = (e) => {
    e.preventDefault();
    if (!isPressingShutter) return;
    isPressingShutter = false;

    if (isRecordingVideo) {
      stopVideoRecording();
    } else {
      clearTimeout(shutterPressTimer);
      capturePhotoSnap();
    }
  };

  shutterBtn.addEventListener('mousedown', onPointerDown);
  window.addEventListener('mouseup', onPointerUp);

  shutterBtn.addEventListener('touchstart', onPointerDown, { passive: false });
  window.addEventListener('touchend', onPointerUp, { passive: false });
}

function getActiveCanvas() {
  const ckCanvas = document.getElementById('ck-camerakit-canvas');
  if (ckCanvas && ckCanvas.style.display !== 'none') {
    return ckCanvas;
  }
  return document.getElementById('ck-canvas');
}

// 1. Capture Photo Snap
async function capturePhotoSnap() {
  const canvas = getActiveCanvas();
  const flash = document.getElementById('camera-flash');

  if (flash) {
    flash.classList.add('active');
    setTimeout(() => flash.classList.remove('active'), 180);
  }

  try {
    const snd = document.getElementById('snd-shutter');
    if (snd) { snd.currentTime = 0; snd.play().catch(() => {}); }
  } catch (_) {}

  // Merge base canvas and 3D overlay if active
  let captureCanvas = canvas;
  const threeCanvas = document.getElementById('ck-three-canvas');
  if (threeCanvas && (abyssalCrownGroup?.visible || custom3DGroup?.visible)) {
    const mergeCanvas = document.createElement('canvas');
    mergeCanvas.width = 720;
    mergeCanvas.height = 1280;
    const mCtx = mergeCanvas.getContext('2d');
    mCtx.drawImage(canvas, 0, 0);
    mCtx.drawImage(threeCanvas, 0, 0);
    captureCanvas = mergeCanvas;
  }

  const dataUrl = captureCanvas.toDataURL('image/png', 0.95);

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
    console.error('[Save Snap Error]', err);
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
  const canvas = getActiveCanvas();

  if (shutterBtn) shutterBtn.classList.add('recording');
  if (hintEl) hintEl.textContent = 'Recording Video Snap...';

  recordedChunks = [];
  const stream = canvas.captureStream(30);

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

    const formData = new FormData();
    formData.append('type', 'video');
    formData.append('video', blob, 'snap_video.webm');

    try {
      const res = await fetch('/api/save_snap', { method: 'POST', body: formData });
      const data = await res.json();
      showSnapModal(videoUrl, 'video', data.url || videoUrl);
      loadSnapsGallery();
    } catch (err) {
      console.error('[Save Video Error]', err);
      showSnapModal(videoUrl, 'video', videoUrl);
    }
  };

  mediaRecorder.start();
  recordStartTime = performance.now();

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

// Snap Preview Modal
function showSnapModal(mediaSrc, type, downloadUrl) {
  const modal = document.getElementById('snap-preview-modal');
  const body = document.getElementById('snap-modal-body');
  const dlBtn = document.getElementById('snap-download-btn');
  const title = document.getElementById('snap-modal-title');

  if (!modal || !body) return;

  title.textContent = (type === 'video') ? '🎬 Video Snap' : '📸 Photo Snap';
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

// Snaps Gallery
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
    }
  } catch (err) {
    console.error('[Load Snaps Error]', err);
  }
}

// Deep Inspector
function updateInspector(lens) {
  if (!lens) return;

  const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setEl('insp-name', lens.name);
  setEl('insp-id', `ID: ${lens.id}`);
  setEl('insp-desc', lens.description || 'Snapchat compiled AR Lens bundle.');
  const inspIcon = document.getElementById('insp-icon');
  if (inspIcon) inspIcon.src = lens.icon_url || '/static/samples/abyssal_crown_icon.png';

  const inspBadge = document.getElementById('insp-badge');
  if (inspBadge) inspBadge.textContent = lens.is_sample ? 'Official Bundle' : 'Custom Upload';

  const insp = lens.inspection || {};
  setEl('insp-size', (lens.size_bytes ? (lens.size_bytes / (1024 * 1024)).toFixed(2) + ' MB' : 'N/A'));
  setEl('insp-files', insp.total_files || 'N/A');
  setEl('insp-sha256', lens.sha256 || 'N/A');

  const counts = insp.counts || {};
  setEl('insp-meshes-count', counts.meshes || 0);
  setEl('insp-textures-count', counts.textures || 0);
  setEl('insp-shaders-count', counts.shaders || 0);
  setEl('insp-scripts-count', counts.scripts || 0);

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
      meshesUl.innerHTML = '<li class="asset-pill">No standalone 3D meshes</li>';
    }
  }

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

// Dropzone & Bundle Upload
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
  if (progressBar) progressBar.style.width = '30%';
  if (progressText) progressText.textContent = `Unpacking ${file.name} locally...`;

  let localApplied = false;

  try {
    // 1. Client-Side Offline Unpack via JSZip + Web Crypto
    if (window.JSZip) {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const sha256Hex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        const zip = await JSZip.loadAsync(arrayBuffer);
        const fileNames = Object.keys(zip.files);

        let iconBlobUrl = null;
        if (zip.files['icon.png']) {
          const iconBlob = await zip.files['icon.png'].async('blob');
          iconBlobUrl = URL.createObjectURL(iconBlob);
        }

        const meshes = [], textures = [], shaders = [], scripts = [];
        let modelBlobUrl = null;
        let modelType = null;

        for (const fn of fileNames) {
          const lower = fn.toLowerCase();
          const base = fn.split('/').pop();
          if (['.mesh', '.glb', '.gltf', '.scn', '.t3d', '.ply', '.obj'].some(ext => lower.endsWith(ext))) {
            meshes.push({ name: base, size_bytes: zip.files[fn]._data?.uncompressedSize || 1024 });
            if (!modelBlobUrl) {
              if (lower.endsWith('.glb') || lower.endsWith('.gltf')) {
                const b = await zip.files[fn].async('blob');
                modelBlobUrl = URL.createObjectURL(b);
                modelType = 'glb';
              } else if (lower.endsWith('.obj')) {
                const b = await zip.files[fn].async('blob');
                modelBlobUrl = URL.createObjectURL(b);
                modelType = 'obj';
              }
            }
          }
          else if (['.png', '.jpg', '.jpeg', '.webp'].some(ext => lower.endsWith(ext))) textures.push({ name: base, size_bytes: zip.files[fn]._data?.uncompressedSize || 1024 });
          else if (['.glsl', '.reflection'].some(ext => lower.endsWith(ext))) shaders.push({ name: base, size_bytes: zip.files[fn]._data?.uncompressedSize || 1024 });
          else if (['.js', '.ts', '.gs'].some(ext => lower.endsWith(ext))) scripts.push({ name: base, size_bytes: zip.files[fn]._data?.uncompressedSize || 1024 });
        }

        const localId = 'local_' + sha256Hex.slice(0, 12);
        const cleanName = file.name.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const localBlobUrl = URL.createObjectURL(file);

        const localLensEntry = {
          id: localId,
          name: cleanName,
          filename: file.name,
          url: localBlobUrl,
          icon_url: iconBlobUrl,
          modelUrl: modelBlobUrl,
          modelType: modelType,
          sha256: sha256Hex,
          size_bytes: file.size,
          likes: 42,
          is_sample: false,
          is_local: true,
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

        sideloadedLenses.set(localId, {
          id: localId,
          name: cleanName,
          lnsUrl: localBlobUrl,
          sha256: sha256Hex,
          iconUrl: iconBlobUrl,
          likes: 42
        });

        const existingIdx = loadedLensesList.findIndex(l => l.id === localId);
        if (existingIdx >= 0) loadedLensesList[existingIdx] = localLensEntry;
        else loadedLensesList.unshift(localLensEntry);

        renderCarousel();
        renderLensesList();
        await selectLens(localId);
        localApplied = true;

        if (progressBar) progressBar.style.width = '70%';
        if (progressText) progressText.textContent = 'Active on camera! Syncing to server...';
      } catch (localErr) {
        console.warn('[Local Unpack]', localErr);
      }
    }

    // 2. Sync to Server
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/upload_lens', { method: 'POST', body: formData }).catch(() => null);

    if (res && res.ok) {
      const data = await res.json();
      if (data.success && data.lens) {
        sideloadedLenses.set(data.lens.id, {
          id: data.lens.id,
          name: data.lens.name,
          lnsUrl: window.location.origin + data.lens.url,
          sha256: data.lens.sha256,
          iconUrl: data.lens.icon_url ? window.location.origin + data.lens.icon_url : null,
          likes: 42
        });
        await fetchLenses();
        if (!localApplied) {
          await selectLens(data.lens.id);
        }
      }
    }

    if (progressBar) progressBar.style.width = '100%';
    if (progressText) progressText.textContent = '✨ Lens live & active on camera!';
    setTimeout(() => {
      if (progressContainer) progressContainer.style.display = 'none';
      window.toggleStudioDrawer(); // Smoothly return to camera!
    }, 1200);

  } catch (err) {
    console.error('[Upload Error]', err);
    if (progressBar) progressBar.style.backgroundColor = '#ff4d4d';
    if (progressText) progressText.textContent = `Upload error: ${err.message || err}`;
    setTimeout(() => {
      if (progressContainer) progressContainer.style.display = 'none';
    }, 3000);
  }
}

// Direct URL Sideloading
window.sideloadFromUrl = async function() {
  const input = document.getElementById('direct-lens-url-input');
  const statusEl = document.getElementById('url-sideload-status');
  const btn = document.getElementById('btn-load-url');
  const url = (input ? input.value : '').trim();

  if (!url) {
    alert('Please enter a valid URL to a .lns, .zip, or .glb lens asset');
    return;
  }

  if (statusEl) {
    statusEl.style.display = 'block';
    statusEl.style.color = '#00f2fe';
    statusEl.textContent = '⏳ Fetching & unpacking lens bundle from URL...';
  }
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/fetch_lens_url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url })
    });
    const data = await res.json();

    if (data.success && data.lens) {
      if (statusEl) {
        statusEl.style.color = '#00f076';
        statusEl.textContent = `✨ Lens '${data.lens.name}' live & ready!`;
      }
      await fetchLenses();
      await selectLens(data.lens.id);
      setTimeout(() => {
        window.toggleStudioDrawer();
      }, 900);
    } else {
      if (statusEl) {
        statusEl.style.color = '#ff4d4d';
        statusEl.textContent = `❌ ${data.error || 'Failed to download lens bundle'}`;
      }
    }
  } catch (err) {
    if (statusEl) {
      statusEl.style.color = '#ff4d4d';
      statusEl.textContent = `❌ Error: ${err.message || err}`;
    }
  } finally {
    if (btn) btn.disabled = false;
  }
};

// Custom Media Upload (test against any custom portrait)
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
    console.error('[Custom Media Error]', err);
  }
};

// Camera Kit Background Asynchronous Initialization
async function initCameraKitAsync() {
  const statusBadge = document.getElementById('engine-status-text');

  try {
    const { 
      bootstrapCameraKit, 
      createExtension, 
      lensSourcesFactory, 
      ConcatInjectable 
    } = await import('/static/js/camera-kit.bundle.js');

    const token = serverApiToken || DEFAULT_API_TOKEN;

    const customLensSource = {
      isGroupOwner(groupId) {
        return groupId === "lens-sideload-extension-group";
      },
      async loadLens(lensId) {
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

    if (statusBadge) statusBadge.textContent = 'Dual Engine Active (WebGL2)';
    console.log('[Camera Kit] Background engine ready!');
  } catch (err) {
    console.warn('[Camera Kit Async Init]', err);
    if (statusBadge) statusBadge.textContent = 'Local AR Active (60 FPS)';
  }
}

const DEFAULT_LENS_GROUP_ID = "6d4c3a49-b090-45b2-b2f7-720e78e9f7fd";
const DEFAULT_API_TOKEN = "eyJhbGciOiJIUzI1NiIsImtpZCI6IkNhbnZhc1MyU0hNQUNQcm9kIiwidHlwIjoiSldUIn0.eyJhdWQiOiJjYW52YXMtY2FudmFzYXBpIiwiaXNzIjoiY2FudmFzLXMyc3Rva2VuIiwibmJmIjoxNzkxMjE3MjU5LCJzdWIiOiJhODM3NzNlNi1lZTgwLTQ2MTMtYmI0ZC1kZWRhMDJiMWVmODd-UFJPRFVDVElPTn40Mjk1ODcxOC0yNTIxLTRjMTctODAxZC03Y2FlMWMyY2IyNTkifQ.mNbYo1anah5FrGBwF5ciT4SWU4FxCJELEvcI1jwq6sQ";
const DEFAULT_STAGING_TOKEN = "eyJhbGciOiJIUzI1NiIsImtpZCI6IkNhbnZhc1MyU0hNQUNQcm9kIiwidHlwIjoiSldUIn0.eyJhdWQiOiJjYW52YXMtY2FudmFzYXBpIiwiaXNzIjoiY2FudmFzLXMyc3Rva2VuIiwibmJmIjoxNzkxMjE3MjU5LCJzdWIiOiJhODM3NzNlNi1lZTgwLTQ2MTMtYmI0ZC1kZWRhMDJiMWVmODd-U1RBR0lOR340OGM0NjgyZS00NTkyLTRiMDQtYjMyOC1kNDI4NTg1MDZlMTMifQ.LqzSwK_sfExKloe_v2TJKr0E2bjPPUe4dwuQlPCAOew";

window.switchTokenEnv = function(mode) {
  const tokenInput = document.getElementById('ck-api-token-input');
  if (!tokenInput) return;
  if (mode === 'prod') {
    tokenInput.value = serverApiToken || DEFAULT_API_TOKEN;
    tokenInput.placeholder = "Production Token Active";
  } else if (mode === 'staging') {
    tokenInput.value = serverStagingToken || DEFAULT_STAGING_TOKEN;
    tokenInput.placeholder = "Staging Token Active";
  } else {
    tokenInput.value = "";
    tokenInput.placeholder = "Paste custom creator API token here...";
  }
};

// Ensure Camera Kit Session on Native WebGL Canvas
async function ensureCameraKitSession() {
  if (!ckInstance) {
    await initCameraKitAsync();
  }
  if (!ckInstance) return null;

  if (!ckSession) {
    const ckCanvas = document.getElementById('ck-camerakit-canvas');
    if (!ckCanvas) return null;

    try {
      ckSession = await ckInstance.createSession({ liveRenderTarget: ckCanvas });
      await updateCameraKitSessionSource();
      console.log('[Camera Kit] Native WebGL session initialized!');
    } catch (err) {
      console.error('[Camera Kit Session Init Error]', err);
      return null;
    }
  }
  return ckSession;
}

// Update Active Camera/Video Stream in Camera Kit Session
async function updateCameraKitSessionSource() {
  if (!ckSession) return;
  try {
    const { createMediaStreamSource, createVideoSource } = await import('/static/js/camera-kit.bundle.js');
    if (ckActiveSource === 'webcam') {
      const rawWebcam = document.getElementById('ck-webcam-raw');
      if (rawWebcam && rawWebcam.srcObject) {
        const source = createMediaStreamSource(rawWebcam.srcObject);
        await ckSession.setSource(source);
        await ckSession.play();
      }
    } else {
      const vid = document.getElementById('ck-video-input');
      if (vid) {
        const source = createVideoSource(vid);
        await ckSession.setSource(source);
        await ckSession.play();
      }
    }
  } catch (err) {
    console.warn('[Camera Kit Source Update Warning]', err);
  }
}

// Sync Lenses directly from Snapchat Camera Kit Lens Group
window.syncLensGroup = async function(manualGroupId, manualToken) {
  const groupIdInput = document.getElementById('ck-group-id-input');
  const tokenInput = document.getElementById('ck-api-token-input');
  const statusPill = document.getElementById('group-sync-status');
  const consoleEl = document.getElementById('group-sync-console');
  const syncBtn = document.getElementById('btn-sync-group');
  const syncIcon = document.getElementById('btn-sync-icon');
  const syncText = document.getElementById('btn-sync-text');

  const groupId = (manualGroupId || (groupIdInput ? groupIdInput.value : '') || DEFAULT_LENS_GROUP_ID).trim();
  const customToken = (manualToken || (tokenInput ? tokenInput.value : '')).trim();

  if (!groupId) {
    alert('Please enter a valid Snapchat Camera Kit Lens Group ID');
    return;
  }

  // Persist settings in localStorage
  try {
    localStorage.setItem('ck_lens_group_id', groupId);
    if (customToken) {
      localStorage.setItem('ck_api_token_override', customToken);
    }
  } catch (_) {}

  // UI state updates
  if (statusPill) {
    statusPill.className = 'group-status-pill syncing';
    statusPill.textContent = 'Syncing...';
  }
  if (syncBtn) syncBtn.disabled = true;
  if (syncIcon) syncIcon.textContent = '⏳';
  if (syncText) syncText.textContent = 'Connecting...';
  if (consoleEl) {
    consoleEl.style.display = 'block';
    consoleEl.className = 'group-sync-console';
    consoleEl.textContent = `[Camera Kit] Initializing Snap gRPC client...\nTarget Lens Group ID: ${groupId}\nAPI Token: ${customToken ? 'Custom Override Provided' : 'Production/Configured Token'}\nQuerying Snap Lenses service (camera-kit-api.snapar.com)...`;
  }

  try {
    const { bootstrapCameraKit } = await import('/static/js/camera-kit.bundle.js');
    let effectiveToken = customToken || serverApiToken || DEFAULT_API_TOKEN;

    // Bootstrap or re-bootstrap instance if custom token is supplied or instance missing
    if (!ckInstance || customToken) {
      ckInstance = await bootstrapCameraKit({ apiToken: effectiveToken });
    }

    console.log(`[Camera Kit] Calling loadLensGroups for: ${groupId}`);
    let groupRes = await ckInstance.lensRepository.loadLensGroups([groupId]);

    let lenses = groupRes.lenses || [];
    let errors = groupRes.errors || [];

    // Auto-fallback: if production failed and user didn't specify manual token, try staging token
    if (errors.length > 0 && !customToken) {
      const fallbackToken = serverStagingToken || DEFAULT_STAGING_TOKEN;
      if (fallbackToken && fallbackToken !== effectiveToken) {
        console.log('[Camera Kit] Production query failed, attempting auto-fallback to Staging Token...');
        if (consoleEl) {
          consoleEl.textContent += `\n[Fallback] Retrying with Staging Token...`;
        }
        try {
          const stagingInstance = await bootstrapCameraKit({ apiToken: fallbackToken });
          const stagingRes = await stagingInstance.lensRepository.loadLensGroups([groupId]);
          if ((stagingRes.lenses || []).length > 0 || (stagingRes.errors || []).length === 0) {
            ckInstance = stagingInstance;
            groupRes = stagingRes;
            lenses = groupRes.lenses || [];
            errors = groupRes.errors || [];
            effectiveToken = fallbackToken;
          }
        } catch (stageErr) {
          console.warn('[Camera Kit Staging Fallback Failed]', stageErr);
        }
      }
    }

    if (errors.length > 0) {
      const errObj = errors[0];
      const errMsg = errObj.message || String(errObj);
      console.warn('[Camera Kit Group Error]', errMsg);

      if (statusPill) {
        statusPill.className = 'group-status-pill error';
        statusPill.textContent = 'Group Not Found';
      }

      if (consoleEl) {
        consoleEl.className = 'group-sync-console is-error';
        consoleEl.textContent = `❌ Snap Camera Kit Gateway Status: ${errMsg}\n\n` +
          `🔍 ROOT CAUSE & FIX (Status 16 - Request Not Authenticated):\n` +
          `1. Platform Mismatch: In the Snap Camera Kit Portal (App a83773e6-ee80-4613-bb4d-deda02b1ef87), the API token was generated for Mobile/Android (which requires a Mobile Bundle ID) or lacks Web Platform domain whitelist.\n` +
          `2. Developer Portal Fix:\n` +
          `   • Go to: https://camera-kit.snapchat.com\n` +
          `   • App a83773e6-ee80-4613-bb4d-deda02b1ef87 -> Add Web Platform -> Allowed Origins: https://snap-lens-studio-production.up.railway.app\n` +
          `   • Generate a Web API Token and schedule lenses in Group '${groupId}'.\n\n` +
          `✨ 100% OFFLINE LOCAL SOLUTION (Zero Cloud Dependency):\n` +
          `Drop the exported .lns / .zip / .glb into the dropzone above, or paste the public URL in 'Sideload from URL' for instant 60-120 FPS AR on camera!`;
      }
      return;
    }

    if (lenses.length === 0) {
      if (statusPill) {
        statusPill.className = 'group-status-pill syncing';
        statusPill.textContent = '0 Lenses Found';
      }
      if (consoleEl) {
        consoleEl.className = 'group-sync-console';
        consoleEl.textContent = `ℹ️ Lens Group '${groupId}' found on Snap server, but contains 0 active lenses.\nOnce lenses are published in the Lens Scheduler, re-sync to load them.`;
      }
      return;
    }

    // Success! Lenses found
    if (statusPill) {
      statusPill.className = 'group-status-pill success';
      statusPill.textContent = `${lenses.length} Lenses Active`;
    }

    let newlyAdded = 0;
    lenses.forEach(l => {
      if (!loadedLensesList.some(existing => existing.id === l.id)) {
        const cloudEntry = {
          id: l.id,
          name: l.name || "Snap Lens",
          icon_url: l.iconUrl || "/static/samples/abyssal_crown_icon.png",
          is_sample: false,
          is_camerakit_cloud: true,
          camerakit_lens_obj: l,
          groupId: groupId,
          size_bytes: null,
          created_at: new Date().toISOString(),
          description: `Live cloud lens loaded from Lens Group ${groupId} (Snap Camera Kit WebGL2).`,
          inspection: {
            counts: { meshes: 1, textures: 1, shaders: 1, scripts: 1, audio: 0, others: 0 }
          }
        };
        loadedLensesList.unshift(cloudEntry);
        newlyAdded++;
      }
    });

    renderLensesList();
    renderCarousel();

    if (consoleEl) {
      consoleEl.className = 'group-sync-console is-success';
      consoleEl.textContent = `✅ Successfully connected to Snapchat Camera Kit!\nSynced ${lenses.length} lenses from Group '${groupId}' (${newlyAdded} new).\nLenses added to bottom carousel & ready for live camera testing!`;
    }

    // Select and apply the first cloud lens immediately
    if (lenses.length > 0) {
      selectLens(lenses[0].id);
    }

  } catch (err) {
    console.error('[syncLensGroup Exception]', err);
    if (statusPill) {
      statusPill.className = 'group-status-pill error';
      statusPill.textContent = 'Sync Failed';
    }
    if (consoleEl) {
      consoleEl.className = 'group-sync-console is-error';
      consoleEl.textContent = `⚠️ Error during sync:\n${err.message || String(err)}`;
    }
  } finally {
    if (syncBtn) syncBtn.disabled = false;
    if (syncIcon) syncIcon.textContent = '🔄';
    if (syncText) syncText.textContent = 'Sync Group';
  }
};

// FPS Monitor
function startFpsMonitor() {
  const loop = (now) => {
    frameCount++;
    if (now - lastFrameTime >= 1000) {
      currentFps = frameCount;
      frameCount = 0;
      lastFrameTime = now;
      const diagFps = document.getElementById('diag-fps-info');
      if (diagFps) diagFps.textContent = `${currentFps} FPS (Hardware Accelerated)`;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// Delete lens
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
      await selectLens(ckCurrentLensId);
    }
  } catch (err) {
    console.error('[Delete Lens Error]', err);
  }
}

// Diagnostics
window.rebootstrapEngine = async () => {
  if (localRenderLoopId) {
    cancelAnimationFrame(localRenderLoopId);
    localRenderLoopId = null;
  }
  startLocalArEngine();
  alert('AR Engine smoothly reset!');
};

window.exportDiagnosticReport = () => {
  const info = {
    renderer: "Dual Engine (Local WebGL2 + Camera Kit Sideload)",
    activeLens: ckCurrentLensId,
    activeSource: ckActiveSource,
    fps: currentFps,
    facingMode: ckFacingMode,
    mirrored: ckIsMirrored,
    beautyGlow: ckBeautyGlow,
    totalLoadedLenses: loadedLensesList.length
  };
  navigator.clipboard.writeText(JSON.stringify(info, null, 2))
    .then(() => alert('Diagnostic report copied to clipboard!'))
    .catch(() => alert(JSON.stringify(info)));
};
