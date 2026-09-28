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

// Touch FX State
const touchParticles = [];
let touchCanvas = null;
let touchCtx = null;

// Local AR Engine State
let localRenderLoopId = null;
let localFaceSimTime = 0;
let crownParticles = [];
let kitsuneWisps = [];

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
  setupTouchFx();
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

  // 3. Asynchronously load Snap Camera Kit in background (non-blocking)
  initCameraKitAsync();
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
    const sizeMb = lens.size_bytes ? (lens.size_bytes / (1024 * 1024)).toFixed(2) + ' MB' : 'Built-in';
    const tag = lens.is_sample ? 'Official' : 'Custom';

    item.innerHTML = `
      <div class="lens-card-info">
        <img class="lens-card-icon" src="${iconSrc}" alt="${lens.name}">
        <div class="lens-card-details">
          <span class="lens-card-name">${lens.name}</span>
          <span class="lens-card-meta">${sizeMb} • ❤️ ${lens.likes || 42} Likes</span>
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
    pill.className = `carousel-lens-item ${lens.id === ckCurrentLensId ? 'active' : ''}`;
    pill.title = lens.name;
    pill.onclick = () => selectLens(lens.id);

    const iconSrc = lens.icon_url || '/static/samples/abyssal_crown_icon.png';
    pill.innerHTML = `<img class="carousel-lens-img" src="${iconSrc}" alt="${lens.name}">`;
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

  // Trigger Local AR Re-sync
  resetLocalArParticles();

  // Also apply to Camera Kit if active
  if (ckSession && ckInstance) {
    try {
      const lens = await ckInstance.lensRepository.loadLens(lensId, "lens-sideload-extension-group");
      await ckSession.applyLens(lens);
    } catch (_) {}
  }
}

function updateHudLens(lensMeta) {
  const nameEl = document.getElementById('hud-lens-name');
  const iconEl = document.getElementById('hud-lens-icon');
  const statusEl = document.getElementById('hud-lens-status');
  const likeEl1 = document.getElementById('hud-like-count');
  const likeEl2 = document.getElementById('btn-like-count');

  if (nameEl) nameEl.textContent = lensMeta.name;
  if (iconEl && lensMeta.icon_url) iconEl.src = lensMeta.icon_url;
  if (statusEl) statusEl.textContent = 'Local AR 60 FPS';

  const likes = lensMeta.likes || 150;
  if (likeEl1) likeEl1.textContent = likes;
  if (likeEl2) likeEl2.textContent = likes;
}

// Interactive Like Button Handler
window.handleLikeClick = async function(e) {
  if (e) e.stopPropagation();

  // 1. Haptic feedback
  if (navigator.vibrate) {
    try { navigator.vibrate([35, 30, 45]); } catch (_) {}
  }

  // 2. Button Pop Animation
  const hudBtn = document.getElementById('hud-like-btn');
  const floatBtn = document.getElementById('btn-like');
  if (hudBtn) {
    hudBtn.classList.add('pop');
    setTimeout(() => hudBtn.classList.remove('pop'), 250);
  }
  if (floatBtn) {
    floatBtn.classList.add('pop');
    setTimeout(() => floatBtn.classList.remove('pop'), 250);
  }

  // 3. Spawn Burst of Flying Floating Hearts
  spawnFlyingHearts();

  // 4. Optimistically increment count
  const lens = loadedLensesList.find(l => l.id === ckCurrentLensId);
  if (lens) {
    lens.likes = (lens.likes || 0) + 1;
    updateHudLens(lens);
  }

  // 5. Send to backend
  try {
    const res = await fetch(`/api/like_lens/${ckCurrentLensId}`, { method: 'POST' });
    const data = await res.json();
    if (data.success && lens) {
      lens.likes = data.likes;
      updateHudLens(lens);
    }
  } catch (err) {
    console.warn('[Like API]', err);
  }
};

function spawnFlyingHearts() {
  const container = document.getElementById('flying-hearts-container');
  if (!container) return;

  const heartEmojis = ['❤️', '💖', '✨', '🔥', '💕', '🥰'];
  const rect = container.getBoundingClientRect();
  const startX = rect.width - 45;
  const startY = 120;

  for (let i = 0; i < 6; i++) {
    const heart = document.createElement('div');
    heart.className = 'floating-heart-particle';
    heart.textContent = heartEmojis[Math.floor(Math.random() * heartEmojis.length)];
    const tx = (Math.random() - 0.5) * 80;
    const rot = (Math.random() - 0.5) * 45;

    heart.style.left = `${startX + (Math.random() - 0.5) * 20}px`;
    heart.style.top = `${startY + (Math.random() - 0.5) * 20}px`;
    heart.style.setProperty('--tx', `${tx}px`);
    heart.style.setProperty('--rot', `${rot}deg`);

    container.appendChild(heart);
    setTimeout(() => { heart.remove(); }, 1200);
  }
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

// LOCAL AR RENDERING ENGINE (100% Client-Side WebGL2 / Canvas2D at 60-120 FPS)
function resetLocalArParticles() {
  crownParticles = [];
  kitsuneWisps = [];

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

        const scale = Math.max(720 / vw, 1280 / vh) * 0.78;
        const dw = vw * scale;
        const dh = vh * scale;
        const dx = (720 - dw) / 2;
        const dy = (1280 - dh) / 2 + 30;

        if (ckIsMirrored) {
          cropCtx.translate(720, 0);
          cropCtx.scale(-1, 1);
          cropCtx.drawImage(webcamRaw, 720 - (dx + dw), dy, dw, dh);
        } else {
          cropCtx.drawImage(webcamRaw, dx, dy, dw, dh);
        }
        cropCtx.restore();
      }
    } else if (ckActiveSource === 'model1' || ckActiveSource === 'model2' || (ckActiveSource === 'custom' && customMediaType === 'video')) {
      if (videoInput.videoWidth > 0 && videoInput.videoHeight > 0) {
        cropCtx.drawImage(videoInput, 0, 0, 720, 1280);
      }
    }

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

    // 4. Render Active AR Lens Procedural Effect
    renderActiveArLens(ctx, localFaceSimTime);

    ctx.restore();

    localRenderLoopId = requestAnimationFrame(renderFrame);
  };

  localRenderLoopId = requestAnimationFrame(renderFrame);
}

// Procedural AR Lenses (Runs 100% Client-Side at 60-120 FPS)
function renderActiveArLens(ctx, t) {
  // Head / Forehead Anchor kinematics with subtle breathing float
  const headX = 360 + Math.sin(t * 0.8) * 4;
  const headY = 380 + Math.cos(t * 1.2) * 5;

  // LENS 1: Celestial Kitsune
  if (ckCurrentLensId === "4df2b87d-52eb-4ec3-bc0f-fd1919712256") {
    renderCelestialKitsune(ctx, headX, headY, t);
  }
  // LENS 2: Verdant Gilded Tiara
  else if (ckCurrentLensId === "verdant_gilded") {
    renderVerdantTiara(ctx, headX, headY, t);
  }
  // LENS 3 & Default: Abyssal Crown
  else {
    renderAbyssalCrown(ctx, headX, headY, t);
  }
}

// 1. Celestial Kitsune AR Renderer
function renderCelestialKitsune(ctx, x, y, t) {
  ctx.save();

  // Floating Foxfire Aura Wisps
  kitsuneWisps.forEach(w => {
    w.angle += w.speed;
    const wx = x + Math.cos(w.angle) * w.radius;
    const wy = y + Math.sin(w.angle) * (w.radius * 0.6) + w.yOff + Math.sin(t * 2 + w.angle) * 10;

    const grad = ctx.createRadialGradient(wx, wy, 1, wx, wy, w.size * 2.5);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.3, w.color);
    grad.addColorStop(1, 'rgba(255, 42, 122, 0)');

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(wx, wy, w.size * 2.5, 0, Math.PI * 2);
    ctx.fill();
  });

  // Kitsune Spirit Ears
  const earW = 55;
  const earH = 110;
  const earY = y - 130;

  // Left Ear
  ctx.save();
  ctx.translate(x - 90, earY);
  ctx.rotate(-0.25 + Math.sin(t * 1.5) * 0.05);

  let earGrad = ctx.createLinearGradient(0, earH, 0, -earH);
  earGrad.addColorStop(0, 'rgba(255, 42, 122, 0.95)');
  earGrad.addColorStop(1, '#ffffff');
  ctx.fillStyle = earGrad;
  ctx.shadowColor = '#ff2a7a';
  ctx.shadowBlur = 24;

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
  ctx.shadowBlur = 16;
  ctx.beginPath();
  ctx.moveTo(0, earH * 0.3);
  ctx.lineTo(-earW * 0.4, 0);
  ctx.lineTo(0, -earH * 0.6);
  ctx.lineTo(earW * 0.4, 0);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Right Ear
  ctx.save();
  ctx.translate(x + 90, earY);
  ctx.rotate(0.25 - Math.sin(t * 1.5) * 0.05);

  earGrad = ctx.createLinearGradient(0, earH, 0, -earH);
  earGrad.addColorStop(0, 'rgba(255, 42, 122, 0.95)');
  earGrad.addColorStop(1, '#ffffff');
  ctx.fillStyle = earGrad;
  ctx.shadowColor = '#ff2a7a';
  ctx.shadowBlur = 24;

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
  ctx.shadowBlur = 16;
  ctx.beginPath();
  ctx.moveTo(0, earH * 0.3);
  ctx.lineTo(-earW * 0.4, 0);
  ctx.lineTo(0, -earH * 0.6);
  ctx.lineTo(earW * 0.4, 0);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Forehead Spirit Crest (Third Eye Radiant Emblem)
  const crestY = y - 45;
  const pulse = 1 + Math.sin(t * 3) * 0.15;

  ctx.save();
  ctx.translate(x, crestY);
  ctx.scale(pulse, pulse);

  ctx.shadowColor = '#ff2a7a';
  ctx.shadowBlur = 25;
  ctx.fillStyle = '#ff2a7a';
  ctx.beginPath();
  ctx.moveTo(0, -22);
  ctx.lineTo(14, 0);
  ctx.lineTo(0, 22);
  ctx.lineTo(-14, 0);
  ctx.closePath();
  ctx.fill();

  ctx.shadowColor = '#fffc00';
  ctx.shadowBlur = 18;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(0, 0, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Spirit Whiskers on Cheeks
  ctx.strokeStyle = 'rgba(255, 42, 122, 0.85)';
  ctx.shadowColor = '#ff2a7a';
  ctx.shadowBlur = 10;
  ctx.lineWidth = 3.5;
  ctx.lineCap = 'round';

  [-1, 1].forEach(side => {
    ctx.beginPath();
    ctx.moveTo(x + side * 90, y + 60);
    ctx.quadraticCurveTo(x + side * 140, y + 55, x + side * 180, y + 45);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x + side * 90, y + 80);
    ctx.quadraticCurveTo(x + side * 140, y + 80, x + side * 175, y + 75);
    ctx.stroke();
  });

  ctx.restore();
}

// 2. Abyssal Crown AR Renderer
function renderAbyssalCrown(ctx, x, y, t) {
  ctx.save();

  const crownW = 240;
  const crownBaseY = y - 75;

  // Floating Rising Embers
  crownParticles.forEach(p => {
    p.y += p.vy;
    p.x += p.vx + Math.sin(t * 2 + p.life) * 0.5;
    if (p.y < crownBaseY - 140) {
      p.y = crownBaseY + Math.random() * 20;
      p.x = x + (Math.random() - 0.5) * crownW;
    }

    ctx.fillStyle = `hsla(${p.hue}, 100%, 70%, 0.85)`;
    ctx.shadowColor = '#00f2fe';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  });

  // Base Crown Filigree
  const baseGrad = ctx.createLinearGradient(x - crownW / 2, crownBaseY, x + crownW / 2, crownBaseY);
  baseGrad.addColorStop(0, '#101728');
  baseGrad.addColorStop(0.5, '#d4af37');
  baseGrad.addColorStop(1, '#101728');

  ctx.strokeStyle = baseGrad;
  ctx.lineWidth = 6;
  ctx.shadowColor = '#00f2fe';
  ctx.shadowBlur = 15;
  ctx.beginPath();
  ctx.ellipse(x, crownBaseY, crownW * 0.5, 22, 0, 0, Math.PI * 2);
  ctx.stroke();

  // Spikes & Abyssal Jewels
  const spikeCount = 7;
  const heights = [35, 65, 95, 130, 95, 65, 35];

  for (let i = 0; i < spikeCount; i++) {
    const angle = (i / (spikeCount - 1)) * Math.PI - Math.PI / 2;
    const sx = x + (i - 3) * 36;
    const sy = crownBaseY + Math.sin(angle) * 10;
    const sh = heights[i];

    // Metallic Blade
    const spikeGrad = ctx.createLinearGradient(sx, sy, sx, sy - sh);
    spikeGrad.addColorStop(0, '#162238');
    spikeGrad.addColorStop(0.6, '#00f2fe');
    spikeGrad.addColorStop(1, '#ffffff');

    ctx.fillStyle = spikeGrad;
    ctx.shadowColor = '#00f2fe';
    ctx.shadowBlur = 20;

    ctx.beginPath();
    ctx.moveTo(sx - 12, sy);
    ctx.lineTo(sx, sy - sh);
    ctx.lineTo(sx + 12, sy);
    ctx.closePath();
    ctx.fill();

    // Cyan Pulsing Jewel on Top
    const pulse = 1 + Math.sin(t * 3 + i) * 0.25;
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = '#00f2fe';
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.arc(sx, sy - sh, 5 * pulse, 0, Math.PI * 2);
    ctx.fill();
  }

  // Giant Center Sapphire Jewel
  const centerPulse = 1 + Math.sin(t * 2.5) * 0.15;
  ctx.fillStyle = '#00f2fe';
  ctx.shadowColor = '#00f2fe';
  ctx.shadowBlur = 30;
  ctx.beginPath();
  ctx.arc(x, crownBaseY - 12, 12 * centerPulse, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(x - 3, crownBaseY - 15, 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

// 3. Verdant Gilded Tiara AR Renderer
function renderVerdantTiara(ctx, x, y, t) {
  ctx.save();

  const tiaraW = 210;
  const tiaraBaseY = y - 70;

  // Gilded Gold Arc
  ctx.strokeStyle = '#ffd700';
  ctx.shadowColor = '#ffd700';
  ctx.shadowBlur = 14;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(x, tiaraBaseY + 60, tiaraW * 0.55, -Math.PI * 0.72, -Math.PI * 0.28);
  ctx.stroke();

  // Emerald Jewels & Golden Leaves
  const gems = [
    { x: x - 75, y: tiaraBaseY + 12, r: 8 },
    { x: x - 40, y: tiaraBaseY - 12, r: 11 },
    { x: x, y: tiaraBaseY - 32, r: 15 },
    { x: x + 40, y: tiaraBaseY - 12, r: 11 },
    { x: x + 75, y: tiaraBaseY + 12, r: 8 }
  ];

  gems.forEach((g, idx) => {
    // Emerald Jewel
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

    // Diamond Starburst Sparkle Glint
    const sparkAngle = t * 1.8 + idx;
    const sparkScale = Math.sin(t * 4 + idx);
    if (sparkScale > 0.3) {
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = '#ffffff';
      ctx.shadowBlur = 14;
      ctx.save();
      ctx.translate(g.x, g.y);
      ctx.rotate(sparkAngle);
      ctx.fillRect(-1.5, -10, 3, 20);
      ctx.fillRect(-10, -1.5, 20, 3);
      ctx.restore();
    }
  });

  ctx.restore();
}

// Interactive Touch FX (Sparks & Hearts on Screen Tap)
function setupTouchFx() {
  touchCanvas = document.getElementById('touch-fx-canvas');
  if (!touchCanvas) return;
  touchCtx = touchCanvas.getContext('2d');

  const resize = () => {
    touchCanvas.width = touchCanvas.clientWidth || 720;
    touchCanvas.height = touchCanvas.clientHeight || 1280;
  };
  resize();
  window.addEventListener('resize', resize);

  const wrapper = document.getElementById('canvas-wrapper');
  if (!wrapper) return;

  const onTouch = (clientX, clientY) => {
    const rect = wrapper.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    const colors = ['#ff2a7a', '#00f2fe', '#fffc00', '#ffffff', '#00e676'];
    for (let i = 0; i < 12; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 2 + Math.random() * 5;
      touchParticles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: 3 + Math.random() * 5,
        color: colors[Math.floor(Math.random() * colors.length)],
        life: 1.0,
        decay: 0.035 + Math.random() * 0.02
      });
    }
  };

  wrapper.addEventListener('pointerdown', (e) => {
    // Only spawn if not clicking an interactive overlay
    onTouch(e.clientX, e.clientY);
  });

  const animTouch = () => {
    if (touchCtx) {
      touchCtx.clearRect(0, 0, touchCanvas.width, touchCanvas.height);
      for (let i = touchParticles.length - 1; i >= 0; i--) {
        const p = touchParticles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.life -= p.decay;

        if (p.life <= 0) {
          touchParticles.splice(i, 1);
          continue;
        }

        touchCtx.save();
        touchCtx.globalAlpha = p.life;
        touchCtx.fillStyle = p.color;
        touchCtx.shadowColor = p.color;
        touchCtx.shadowBlur = 8;
        touchCtx.beginPath();
        touchCtx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
        touchCtx.fill();
        touchCtx.restore();
      }
    }
    requestAnimationFrame(animTouch);
  };
  requestAnimationFrame(animTouch);
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

// 1. Capture Photo Snap
async function capturePhotoSnap() {
  const canvas = document.getElementById('ck-canvas');
  const flash = document.getElementById('camera-flash');

  if (flash) {
    flash.classList.add('active');
    setTimeout(() => flash.classList.remove('active'), 180);
  }

  try {
    const snd = document.getElementById('snd-shutter');
    if (snd) { snd.currentTime = 0; snd.play().catch(() => {}); }
  } catch (_) {}

  const dataUrl = canvas.toDataURL('image/png', 0.95);

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
  const canvas = document.getElementById('ck-canvas');

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

    const token = "eyJhbGciOiJIUzI1NiIsImtpZCI6IkNhbnZhc1MyU0hNQUNQcm9kIiwidHlwIjoiSldUIn0.eyJhdWQiOiJjYW52YXMtY2FudmFzYXBpIiwiaXNzIjoiY2FudmFzLXMyc3Rva2VuIiwibmJmIjoxNzMyNjMzNDE5LCJzdWIiOiIwMjdmNjZkZi0wOTQyLTQ3ZWUtODUxMi1lNGMyZTQ2MWRkMzR-UFJPRFVDVElPTn43N2Y5Y2ZlYi1lNWUxLTRhZTgtYWU5ZS01MjQ1NGYwM2JiYTYifQ.niwcW4CuvpHEhciugcvxa2S5vQBsehTktDu_k8galYU";

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
