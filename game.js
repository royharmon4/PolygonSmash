(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const scoreEl = document.getElementById('score');
  const bestEl = document.getElementById('best');
  const queueSlot1El = document.getElementById('queueSlot1');
  const queueSlot2El = document.getElementById('queueSlot2');
  const restartBtn = document.getElementById('restartBtn');
  const pauseBtn = document.getElementById('pauseBtn');

  const WIDTH = canvas.width;
  const HEIGHT = canvas.height;
  const MARGIN = 24;
  const WELL = { left: MARGIN, right: WIDTH - MARGIN, top: 10, bottom: HEIGHT - 34 };

  // Launcher sits at the BOTTOM — shoots UPWARD
  const LAUNCHER_Y = WELL.bottom - 30;
  const LAUNCHER_X = WIDTH / 2;

  const FIXED_CEILING_Y = WELL.top;
  const DANGER_Y = HEIGHT - 180;
  const DANGER_GRACE_SECONDS = 2;
  const GRAVITY = -640;
  const AIR_DRAG = 0.992; // stronger drag for more deliberate placements
  const WALL_BOUNCE = 0.12; // less wall correction after misses
  const PAIR_BOUNCE = 0.08; // less chaotic pinball collisions
  const MERGE_RELATIVE_SPEED = 95;
  const MERGE_MAX_SPEED = 120;
  const MERGE_CONTACT_TIME = 0.12;
  const MERGE_MAX_OVERLAP_RATIO = 0.18;
  const MERGE_MAX_STRESS = 0.7;
  const LAUNCH_COOLDOWN = 0.42; // slower fire rate — can't spam out of trouble
  const FIXED_STEP = 1 / 60;
  const BASE_RADIUS = 24; // slightly bigger pieces — board fills faster
  const EXPLOSION_RADIUS = BASE_RADIUS * 3.8; // smaller blast — decagon less OP
  const BACKGROUND_STARS = Array.from({ length: 36 }, (_, i) => ({
    x: (i * 73) % WIDTH,
    y: (i * 127) % HEIGHT,
    r: 1 + (i % 3),
    a: 0.15 + (i % 5) * 0.08,
  }));

  const TIERS = [
    { name: 'Triangle', sides: 3, radius: 1.0, score: 10, color: '#62b0ff', capstone: null },
    { name: 'Square', sides: 4, radius: 1.12, score: 30, color: '#6ad4ff', capstone: null },
    { name: 'Pentagon', sides: 5, radius: 1.26, score: 75, color: '#6bf3d2', capstone: null },
    { name: 'Hexagon', sides: 6, radius: 1.42, score: 180, color: '#8af17f', capstone: null },
    { name: 'Heptagon', sides: 7, radius: 1.6, score: 420, color: '#d7ec72', capstone: null },
    { name: 'Octagon', sides: 8, radius: 1.82, score: 950, color: '#ffd166', capstone: null },
    { name: 'Nonagon', sides: 9, radius: 2.06, score: 2100, color: '#ff9f6e', capstone: null },
    { name: 'Decagon', sides: 10, radius: 2.26, score: 4800, color: '#ff7196', capstone: null },
    { name: 'Hendecagon', sides: 11, radius: 2.42, score: 11000, color: '#f784ff', capstone: null },
    {
      name: 'Dodecagon',
      sides: 12,
      radius: 2.58,
      score: 25000,
      color: '#ff5f7f',
      capstone: { behavior: 'explode_on_match', mergeScore: 25000, clearedTierScore: 120 },
    },
  ];
  const NATURAL_SPAWN_WEIGHTS = [
    { tier: 1, weight: 0.68 },
    { tier: 2, weight: 0.24 },
    { tier: 3, weight: 0.08 },
  ];
  const MAX_TIER = TIERS.length;

  // FIX 1 & 2: separate aim state from touch-fire state
  // aimAngle is updated continuously; firing only happens on pointerup / touchend
  let aimAngle = -Math.PI / 2; // default: straight up
  let pieces = [];
  let effects = [];
  let queuedMerges = [];
  let nextId = 1;
  function safeGetBest() {
    try {
      return Number(window.localStorage?.getItem('polygon-smash-best') || '0');
    } catch {
      return 0;
    }
  }

  function safeSetBest(value) {
    try {
      window.localStorage?.setItem('polygon-smash-best', String(value));
    } catch {}
  }

  let score = 0;
  let best = safeGetBest();
  let nextTier = 1; // what fires next (shown on barrel)
  let queueTiers = [1, 1]; // two-piece preview queue
  let launchCooldown = 0;
  let lastTime = 0;
  let accumulator = 0;
  let shakeFramesRemaining = 0;
  let paused = false;
  let gameOver = false;
  let gamePhase = 'playing'; // playing | results
  let resultsButtonRect = null;
  let bestTierThisRun = 1;
  let bestStreakThisRun = 0;
  let currentSafeStreak = 0;
  let dangerTimer = 0;
  let dangerActive = false;
  let finalRunStats = null;
  let audioCtx = null;
  let audioMaster = null;
  let noiseBuffer = null;

  function ensureAudioContext() {
    if (!window.AudioContext && !window.webkitAudioContext) return null;
    if (!audioCtx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctor();
      audioMaster = audioCtx.createGain();
      audioMaster.gain.value = 0.3;
      audioMaster.connect(audioCtx.destination);

      noiseBuffer = audioCtx.createBuffer(1, Math.floor(audioCtx.sampleRate * 0.4), audioCtx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function playLaunchSound() {
    const ac = ensureAudioContext();
    if (!ac || !audioMaster) return;
    const now = ac.currentTime;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(110, now + 0.08);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
    osc.connect(gain);
    gain.connect(audioMaster);
    osc.start(now);
    osc.stop(now + 0.085);
  }

  function mergeFrequencyForTier(tier) {
    const clamped = clamp(tier, 1, MAX_TIER);
    return 300 + ((clamped - 1) / (MAX_TIER - 1)) * (1200 - 300);
  }

  function playMergePop(tier, delay = 0, freqScale = 1) {
    const ac = ensureAudioContext();
    if (!ac || !audioMaster) return;
    const start = ac.currentTime + delay;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(mergeFrequencyForTier(tier) * freqScale, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.12, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.1);
    osc.connect(gain);
    gain.connect(audioMaster);
    osc.start(start);
    osc.stop(start + 0.105);
  }

  function playMergeSound(tier) {
    playMergePop(tier);
  }

  function playChainMergeSound(tier) {
    playMergePop(tier);
    playMergePop(tier, 0.05, 1.08);
  }

  function playExplosionSound() {
    const ac = ensureAudioContext();
    if (!ac || !audioMaster || !noiseBuffer) return;
    const now = ac.currentTime;
    const source = ac.createBufferSource();
    const bandpass = ac.createBiquadFilter();
    const gain = ac.createGain();
    source.buffer = noiseBuffer;
    bandpass.type = 'bandpass';
    bandpass.frequency.setValueAtTime(150, now);
    bandpass.Q.setValueAtTime(0.8, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
    source.connect(bandpass);
    bandpass.connect(gain);
    gain.connect(audioMaster);
    source.start(now);
    source.stop(now + 0.31);
  }

  function playGameOverSound() {
    const ac = ensureAudioContext();
    if (!ac || !audioMaster) return;
    const notes = [440, 330, 220];
    const now = ac.currentTime;
    for (let i = 0; i < notes.length; i++) {
      const start = now + i * 0.08;
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(notes[i], start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.11, start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.08);
      osc.connect(gain);
      gain.connect(audioMaster);
      osc.start(start);
      osc.stop(start + 0.085);
    }
  }

  function resetGame() {
    pieces = [];
    effects = [];
    queuedMerges = [];
    nextId = 1;
    score = 0;
    launchCooldown = 0;
    shakeFramesRemaining = 0;
    gameOver = false;
    gamePhase = 'playing';
    resultsButtonRect = null;
    bestTierThisRun = 1;
    bestStreakThisRun = 0;
    currentSafeStreak = 0;
    dangerTimer = 0;
    dangerActive = false;
    finalRunStats = null;
    paused = false;
    aimAngle = -Math.PI / 2;
    pauseBtn.textContent = 'Pause';
    nextTier = randomSpawnTier();
    queueTiers = [randomSpawnTier(), randomSpawnTier()];
    updateHud();
  }

  function polygonClipPath(sides) {
    if (sides <= 2) return 'none';
    const points = [];
    for (let i = 0; i < sides; i++) {
      const a = -Math.PI / 2 + i * ((Math.PI * 2) / sides);
      const x = 50 + Math.cos(a) * 50;
      const y = 50 + Math.sin(a) * 50;
      points.push(`${x.toFixed(2)}% ${y.toFixed(2)}%`);
    }
    return `polygon(${points.join(',')})`;
  }

  function renderQueueSlot(slotEl, tier) {
    if (!slotEl) return;
    const data = tierData(tier);
    const shape = document.createElement('div');
    shape.className = 'queue-shape';
    shape.style.background = data.color;
    shape.style.clipPath = polygonClipPath(data.sides);
    shape.textContent = String(tier);
    shape.setAttribute('aria-label', `${data.name}, tier ${tier}`);
    slotEl.replaceChildren(shape);
  }

  function updateHud() {
    scoreEl.textContent = Math.floor(score).toLocaleString();
    bestEl.textContent = Math.floor(best).toLocaleString();
    renderQueueSlot(queueSlot1El, queueTiers[0]);
    renderQueueSlot(queueSlot2El, queueTiers[1]);
  }

  function regularPolygonCtx(c, cx, cy, r, sides, rotation) {
    c.beginPath();
    for (let i = 0; i < sides; i++) {
      const a = rotation + i * ((Math.PI * 2) / sides);
      const px = cx + Math.cos(a) * r;
      const py = cy + Math.sin(a) * r;
      i === 0 ? c.moveTo(px, py) : c.lineTo(px, py);
    }
    c.closePath();
  }

  function randomSpawnTier() {
    const roll = Math.random();
    let runningWeight = 0;
    for (const entry of NATURAL_SPAWN_WEIGHTS) {
      runningWeight += entry.weight;
      if (roll < runningWeight) return entry.tier;
    }
    return NATURAL_SPAWN_WEIGHTS[NATURAL_SPAWN_WEIGHTS.length - 1].tier;
  }

  function validateSpawnWeights() {
    const total = NATURAL_SPAWN_WEIGHTS.reduce((sum, entry) => sum + entry.weight, 0);
    if (Math.abs(total - 1) > 0.001) {
      throw new Error(`Spawn weights must sum to 1.0. Current total: ${total}`);
    }
  }

  function tierData(tier) {
    return TIERS[tier - 1];
  }
  function radiusForTier(tier) {
    return BASE_RADIUS * tierData(tier).radius;
  }

  function createPiece(x, y, tier, vx = 0, vy = 0) {
    return {
      id: nextId++,
      x,
      y,
      vx,
      vy,
      tier,
      r: radiusForTier(tier),
      age: 0,
      cooldown: 0.2,
      merged: false,
      mergeFlash: 0,
      mergeFlashMax: 0.15,
      settleTime: 0,
      settled: false,
      touchingSupport: false,
      calmTime: 0,
      impactStress: 0,
      contactId: null,
      contactTime: 0,
      contactSeen: false,
    };
  }

  function launch() {
    if (gamePhase !== 'playing' || paused || launchCooldown > 0) return;
    ensureAudioContext();
    const tier = nextTier;
    const r = radiusForTier(tier);
    const dx = Math.cos(aimAngle);
    const dy = Math.sin(aimAngle);
    // spawn just inside the bottom edge
    const x = clamp(LAUNCHER_X + dx * 28, WELL.left + r, WELL.right - r);
    const y = clamp(LAUNCHER_Y + dy * 10, FIXED_CEILING_Y + r, WELL.bottom - r);
    pieces.push(createPiece(x, y, tier, dx * 700, dy * 700));
    bestTierThisRun = Math.max(bestTierThisRun, tier);
    addDirectionalBurst(x, y, 7, tierData(tier).color, -dx, -dy, 0.5, 80, 170);
    launchCooldown = LAUNCH_COOLDOWN;
    playLaunchSound();
    nextTier = queueTiers.shift();
    queueTiers.push(randomSpawnTier());
    updateHud();
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  // FIX 1: correct aim — compute angle from launcher position to canvas point
  // constrain to the upper hemisphere so you can only shoot upward
  function aimAtCanvasPoint(cx, cy) {
    const dx = cx - LAUNCHER_X;
    const dy = cy - LAUNCHER_Y;
    // only update if the pointer is above the launcher (or close)
    let angle = Math.atan2(dy, dx);
    // keep angle in the upper half: between ~-170° and ~-10° (pointing upward)
    const MIN_ANGLE = -Math.PI + 0.18;
    const MAX_ANGLE = -0.18;
    angle = clamp(angle, MIN_ANGLE, MAX_ANGLE);
    aimAngle = angle;
  }

  // Convert a pointer/touch client position to canvas-space coordinates
  function clientToCanvas(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * (WIDTH / rect.width),
      y: (clientY - rect.top) * (HEIGHT / rect.height),
    };
  }

  // ── Pointer events (mouse + stylus) ──────────────────────────────────
  // Move → update aim only
  canvas.addEventListener('pointermove', (e) => {
    const p = clientToCanvas(e.clientX, e.clientY);
    aimAtCanvasPoint(p.x, p.y);
  });

  // Click (pointerup on canvas) → aim + fire
  canvas.addEventListener('pointerup', (e) => {
    ensureAudioContext();
    const p = clientToCanvas(e.clientX, e.clientY);
    if (gamePhase === 'results' && isInResultsButton(p.x, p.y)) {
      resetGame();
      return;
    }
    aimAtCanvasPoint(p.x, p.y);
    // Mouse launches on pointerdown for snappy controls; touch/pen launch on release.
    if (e.pointerType !== 'mouse') launch();
  });

  // Also allow click to fire so mouse users get instant feedback on press
  canvas.addEventListener('pointerdown', (e) => {
    ensureAudioContext();
    const p = clientToCanvas(e.clientX, e.clientY);
    if (gamePhase === 'results' && isInResultsButton(p.x, p.y)) {
      resetGame();
      return;
    }
    aimAtCanvasPoint(p.x, p.y);
    // Only fire on mouse (not touch — touch fires on touchend below)
    if (e.pointerType === 'mouse') launch();
  });

  // ── Touch events (mobile) ─────────────────────────────────────────────
  // FIX 2: touchmove = aim only, touchend = fire
  canvas.addEventListener(
    'touchmove',
    (e) => {
      e.preventDefault();
      const t = e.touches[0];
      const p = clientToCanvas(t.clientX, t.clientY);
      aimAtCanvasPoint(p.x, p.y);
    },
    { passive: false },
  );

  canvas.addEventListener(
    'touchend',
    (e) => {
      e.preventDefault();
      // Browsers with Pointer Events already fire via pointer handlers above.
      if ('PointerEvent' in window) return;
      // Use changedTouches for the final position
      const t = e.changedTouches[0];
      const p = clientToCanvas(t.clientX, t.clientY);
      if (gamePhase === 'results' && isInResultsButton(p.x, p.y)) {
        resetGame();
        return;
      }
      aimAtCanvasPoint(p.x, p.y);
      launch();
    },
    { passive: false },
  );

  // ── Keyboard ──────────────────────────────────────────────────────────
  window.addEventListener('keydown', (e) => {
    ensureAudioContext();
    if (e.code === 'Space') {
      e.preventDefault();
      launch();
    }
    if (e.code === 'KeyR') resetGame();
    if (e.code === 'KeyP') {
      if (gamePhase !== 'playing') return;
      paused = !paused;
      pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    }
  });

  restartBtn.addEventListener('click', resetGame);
  pauseBtn.addEventListener('click', () => {
    if (gamePhase !== 'playing') return;
    paused = !paused;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  });

  // ── Merge helpers ─────────────────────────────────────────────────────
  function queueMerge(a, b) {
    if (!a || !b || a.merged || b.merged) return;
    a.merged = true;
    b.merged = true;
    queuedMerges.push([a, b]);
  }

  function processMerges() {
    const chainConsumed = new Set();
    let mergeCount = 0;
    while (queuedMerges.length > 0) {
      const mergesThisPass = queuedMerges;
      queuedMerges = [];

      for (const [a, b] of mergesThisPass) {
        if (
          !pieces.includes(a) ||
          !pieces.includes(b) ||
          chainConsumed.has(a.id) ||
          chainConsumed.has(b.id)
        ) {
          continue;
        }

        const mx = (a.x + b.x) * 0.5;
        const my = (a.y + b.y) * 0.5;
        const tier = a.tier;
        removePiece(a);
        removePiece(b);
        chainConsumed.add(a.id);
        chainConsumed.add(b.id);

        const capstone = tierData(tier).capstone;
        if (capstone) {
          explode(mx, my, capstone);
          continue;
        }

        const newTier = tier + 1;
        bestTierThisRun = Math.max(bestTierThisRun, newTier);
        const piece = createPiece(
          mx,
          my,
          newTier,
          (a.vx + b.vx) * 0.18,
          (a.vy + b.vy) * 0.18,
        );
        piece.cooldown = 0.22;
        piece.mergeFlash = piece.mergeFlashMax;
        pieces.push(piece);
        score += tierData(newTier).score;
        addPulse(mx, my, piece.r + 10, tierData(newTier).color, 0.25);
        if (mergeCount === 0) {
          playMergeSound(newTier);
        } else {
          playChainMergeSound(newTier);
        }
        mergeCount++;
      }

    }
  }

  function explode(x, y, capstoneConfig = null) {
    playExplosionSound();
    const survivors = [];
    let cleared = 0;
    for (const piece of pieces) {
      const dx = piece.x - x;
      const dy = piece.y - y;
      if (Math.hypot(dx, dy) <= EXPLOSION_RADIUS) {
        cleared += capstoneConfig ? piece.tier * capstoneConfig.clearedTierScore : piece.tier;
      } else {
        const dist = Math.max(1, Math.hypot(dx, dy));
        const force = Math.max(0, 1 - (dist - EXPLOSION_RADIUS) / 90);
        if (force > 0) {
          piece.vx += (dx / dist) * 180 * force;
          piece.vy += (dy / dist) * 180 * force;
        }
        survivors.push(piece);
      }
    }
    pieces = survivors;
    const capstoneMergeScore = capstoneConfig ? capstoneConfig.mergeScore : 1000;
    score += capstoneMergeScore + cleared;
    addPulse(x, y, EXPLOSION_RADIUS, '#ffd3a8', 0.55);
    addBurst(x, y, 24, '#ffd3a8');
    shakeFramesRemaining = Math.max(shakeFramesRemaining, 3 + Math.floor(Math.random() * 2));
  }

  function removePiece(piece) {
    const i = pieces.indexOf(piece);
    if (i >= 0) pieces.splice(i, 1);
  }

  function addPulse(x, y, radius, color, strength) {
    effects.push({ type: 'pulse', x, y, radius, color, life: 0.35 + strength, maxLife: 0.35 + strength });
  }

  function addBurst(x, y, count, color) {
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.35;
      const speed = 90 + Math.random() * 160;
      effects.push({
        type: 'spark',
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.5 + Math.random() * 0.3,
        maxLife: 0.8,
        color,
        size: 2 + Math.random() * 4,
      });
    }
  }

  function addDirectionalBurst(x, y, count, color, dirX, dirY, spread = 0.45, speedMin = 90, speedMax = 180) {
    const baseAngle = Math.atan2(dirY, dirX);
    for (let i = 0; i < count; i++) {
      const angle = baseAngle + (Math.random() * 2 - 1) * spread;
      const speed = speedMin + Math.random() * (speedMax - speedMin);
      effects.push({
        type: 'spark',
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.2 + Math.random() * 0.15,
        maxLife: 0.35,
        color,
        size: 1.5 + Math.random() * 2,
      });
    }
  }

  // ── Physics step ──────────────────────────────────────────────────────
  function stepEffects(dt) {
    for (let i = effects.length - 1; i >= 0; i--) {
      const fx = effects[i];
      fx.life -= dt;
      if (fx.life <= 0) {
        effects.splice(i, 1);
        continue;
      }
      if (fx.type === 'spark') {
        fx.vx *= 0.98;
        fx.vy *= 0.98;
        fx.x += fx.vx * dt;
        fx.y += fx.vy * dt;
      }
    }
  }

  function stepPhysics(dt) {
    launchCooldown = Math.max(0, launchCooldown - dt);

    for (const piece of pieces) {
      piece.touchingSupport = false;
      piece.contactSeen = false;
    }

    for (const piece of pieces) {
      piece.age += dt;
      piece.cooldown = Math.max(0, piece.cooldown - dt);
      piece.mergeFlash = Math.max(0, piece.mergeFlash - dt);
      piece.impactStress = Math.max(0, piece.impactStress - dt * 1.35);
      piece.vy += GRAVITY * dt;
      piece.vx *= AIR_DRAG;
      piece.vy *= AIR_DRAG;
      piece.x += piece.vx * dt;
      piece.y += piece.vy * dt;

      // Wall collisions
      if (piece.x - piece.r < WELL.left) {
        piece.x = WELL.left + piece.r;
        if (piece.vx < 0) piece.vx *= -WALL_BOUNCE;
      }
      if (piece.x + piece.r > WELL.right) {
        piece.x = WELL.right - piece.r;
        if (piece.vx > 0) piece.vx *= -WALL_BOUNCE;
      }
      if (piece.y - piece.r < FIXED_CEILING_Y) {
        piece.y = FIXED_CEILING_Y + piece.r;
        piece.touchingSupport = true;
        if (piece.vy < 0) piece.vy *= -WALL_BOUNCE;
      }
      if (piece.y + piece.r > WELL.bottom) {
        piece.y = WELL.bottom - piece.r;
        if (piece.vy > 0) piece.vy *= -WALL_BOUNCE;
      }
    }

    // Piece-to-piece collisions & merge detection
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < pieces.length; i++) {
        for (let j = i + 1; j < pieces.length; j++) {
          const a = pieces[i];
          const b = pieces[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.hypot(dx, dy) || 0.0001;
          const minDist = a.r + b.r;
          if (dist >= minDist) continue;
          a.touchingSupport = true;
          b.touchingSupport = true;

          const nx = dx / dist;
          const ny = dy / dist;
          const overlap = (minDist - dist) * 0.5;
          const overlapRatio = (minDist - dist) / minDist;
          a.x -= nx * overlap;
          a.y -= ny * overlap;
          b.x += nx * overlap;
          b.y += ny * overlap;

          const rvx = b.vx - a.vx;
          const rvy = b.vy - a.vy;
          const speedAlongNormal = rvx * nx + rvy * ny;
          const impact = Math.abs(speedAlongNormal) + overlapRatio * 180;
          a.impactStress = Math.min(1.5, a.impactStress + impact * 0.0035);
          b.impactStress = Math.min(1.5, b.impactStress + impact * 0.0035);
          if (speedAlongNormal < 0) {
            const impulse = -(1 + PAIR_BOUNCE) * speedAlongNormal * 0.5;
            a.vx -= impulse * nx;
            a.vy -= impulse * ny;
            b.vx += impulse * nx;
            b.vy += impulse * ny;
          }
          if (a.contactId === b.id) a.contactTime += dt;
          else {
            a.contactId = b.id;
            a.contactTime = dt;
          }
          a.contactSeen = true;
          if (b.contactId === a.id) b.contactTime += dt;
          else {
            b.contactId = a.id;
            b.contactTime = dt;
          }
          b.contactSeen = true;
          const aSpeed = Math.hypot(a.vx, a.vy);
          const bSpeed = Math.hypot(b.vx, b.vy);
          if (
            a.tier === b.tier &&
            !a.merged &&
            !b.merged &&
            a.cooldown <= 0 &&
            b.cooldown <= 0 &&
            a.contactId === b.id &&
            b.contactId === a.id &&
            a.contactTime >= MERGE_CONTACT_TIME &&
            b.contactTime >= MERGE_CONTACT_TIME &&
            a.calmTime >= MERGE_CONTACT_TIME &&
            b.calmTime >= MERGE_CONTACT_TIME &&
            Math.abs(speedAlongNormal) <= MERGE_RELATIVE_SPEED &&
            aSpeed <= MERGE_MAX_SPEED &&
            bSpeed <= MERGE_MAX_SPEED &&
            overlapRatio <= MERGE_MAX_OVERLAP_RATIO &&
            a.impactStress <= MERGE_MAX_STRESS &&
            b.impactStress <= MERGE_MAX_STRESS
          ) {
            queueMerge(a, b);
          }
        }
      }
    }

    processMerges();

    for (const piece of pieces) {
      const speed = Math.hypot(piece.vx, piece.vy);
      if (!piece.contactSeen && piece.contactTime > 0) {
        piece.contactTime = Math.max(0, piece.contactTime - dt * 3);
        if (piece.contactTime <= 0) piece.contactId = null;
      }
      const calmCap = Math.max(0, 1 - piece.impactStress * 0.9);
      if (speed < 55 && piece.touchingSupport) {
        piece.calmTime = Math.min(1, piece.calmTime + dt * calmCap);
      } else {
        piece.calmTime = Math.max(0, piece.calmTime - dt * 2.4);
      }
      const canSettle = piece.age > 0.2 && piece.touchingSupport && speed < 65;

      if (canSettle) {
        piece.settleTime = Math.min(1, piece.settleTime + dt);
      } else {
        piece.settleTime = Math.max(0, piece.settleTime - dt * 2);
      }

      piece.settled = piece.settleTime >= 0.18;
    }

    let maxPieceBottom = -Infinity;
    for (const piece of pieces) {
      if (!piece.settled) continue;
      maxPieceBottom = Math.max(maxPieceBottom, piece.y + piece.r);
    }

    dangerActive = maxPieceBottom !== -Infinity && maxPieceBottom > DANGER_Y;
    if (dangerActive) {
      dangerTimer += dt;
      currentSafeStreak = 0;
    } else {
      dangerTimer = 0;
      currentSafeStreak += dt;
      bestStreakThisRun = Math.max(bestStreakThisRun, currentSafeStreak);
    }

    if (dangerTimer >= DANGER_GRACE_SECONDS && !gameOver) {
      triggerGameOver();
    }

    if (!gameOver) {
      best = Math.max(best, Math.floor(score));
      safeSetBest(best);
    }
  }

  function triggerGameOver() {
    gameOver = true;
    gamePhase = 'results';
    playGameOverSound();
    best = Math.max(best, Math.floor(score));
    safeSetBest(best);
    updateHud();
    addBurst(WIDTH / 2, DANGER_Y, 28, '#ff7777');
    finalRunStats = {
      score: Math.floor(score),
      best,
      bestTier: bestTierThisRun,
      bestStreak: bestStreakThisRun,
    };
  }

  // ── Drawing helpers ───────────────────────────────────────────────────
  function regularPolygon(cx, cy, r, sides, rotation) {
    ctx.beginPath();
    for (let i = 0; i < sides; i++) {
      const a = rotation + i * ((Math.PI * 2) / sides);
      const px = cx + Math.cos(a) * r;
      const py = cy + Math.sin(a) * r;
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  function drawPiece(piece) {
    const tier = tierData(piece.tier);
    const baseRot = -Math.PI / 2 + piece.tier * 0.07;
    ctx.save();
    ctx.translate(piece.x, piece.y);
    ctx.rotate(baseRot);
    let flashMix = 0;
    if (piece.mergeFlash > 0) {
      const t = 1 - piece.mergeFlash / piece.mergeFlashMax;
      const scale = t < 0.5 ? 1 + t * 0.4 : 1.2 - (t - 0.5) * 0.4;
      ctx.scale(scale, scale);
      flashMix = 1 - t;
    }
    regularPolygon(0, 0, piece.r * 0.92, tier.sides, 0);
    ctx.fillStyle = flashMix > 0 ? `rgba(255,255,255,${flashMix})` : tier.color;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.shadowColor = 'rgba(122, 195, 255, 0.6)';
    ctx.shadowBlur = 9;
    ctx.stroke();
    ctx.shadowBlur = 0;
    regularPolygon(0, 0, piece.r * 0.52, tier.sides, Math.PI / tier.sides);
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = `700 ${Math.max(12, piece.r * 0.6)}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(piece.tier), 0, 1);
    ctx.restore();
  }

  function roundRect(x, y, w, h, r, fill, stroke) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    if (fill) ctx.fill();
    if (stroke) ctx.stroke();
  }

  function drawAimLine() {
    const len = 130;
    const ax = LAUNCHER_X + Math.cos(aimAngle) * len;
    const ay = LAUNCHER_Y + Math.sin(aimAngle) * len;
    const glow = ctx.createLinearGradient(LAUNCHER_X, LAUNCHER_Y, ax, ay);
    glow.addColorStop(0, 'rgba(133,184,255,0.24)');
    glow.addColorStop(1, 'rgba(133,184,255,0.95)');

    ctx.setLineDash([14, 8]);
    ctx.strokeStyle = glow;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(LAUNCHER_X, LAUNCHER_Y);
    ctx.lineTo(ax, ay);
    ctx.stroke();
    ctx.setLineDash([]);

    const closeLen = 66;
    const closeX = LAUNCHER_X + Math.cos(aimAngle) * closeLen;
    const closeY = LAUNCHER_Y + Math.sin(aimAngle) * closeLen;
    ctx.strokeStyle = 'rgba(220,238,255,0.45)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(LAUNCHER_X, LAUNCHER_Y);
    ctx.lineTo(closeX, closeY);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(ax, ay, 5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(180,220,255,0.94)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(230,245,255,0.92)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  function drawLauncher() {
    const tier = tierData(nextTier);
    const barrelLen = 44;
    const cooldownProgress = clamp(1 - launchCooldown / LAUNCH_COOLDOWN, 0, 1);

    // barrel (rotates with aim)
    ctx.save();
    ctx.translate(LAUNCHER_X, LAUNCHER_Y);
    ctx.rotate(aimAngle);
    ctx.fillStyle = '#8dc0ff';
    roundRect(-8, -barrelLen, 16, barrelLen, 8, true, false);

    // current piece floating at barrel tip
    const pieceR = radiusForTier(nextTier) * 0.72;
    const tipX = 0;
    const tipY = -(barrelLen + pieceR + 4);
    regularPolygon(tipX, tipY, pieceR * 0.92, tier.sides, -Math.PI / 2);
    ctx.fillStyle = tier.color;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke();
    // inner highlight
    regularPolygon(tipX, tipY, pieceR * 0.52, tier.sides, Math.PI / tier.sides);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.62)';
    ctx.font = `700 ${Math.max(10, pieceR * 0.9)}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(nextTier), tipX, tipY + 1);

    ctx.restore();

    // base circle
    ctx.beginPath();
    ctx.arc(LAUNCHER_X, LAUNCHER_Y, 18, 0, Math.PI * 2);
    ctx.fillStyle = '#5d94f2';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke();

    // power indicator ring around launcher base
    const start = -Math.PI / 2;
    const end = start + cooldownProgress * Math.PI * 2;
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.arc(LAUNCHER_X, LAUNCHER_Y, 24, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = cooldownProgress >= 1 ? '#7fffd4' : '#8dc0ff';
    ctx.beginPath();
    ctx.arc(LAUNCHER_X, LAUNCHER_Y, 24, start, end);
    ctx.stroke();
  }

  function drawCeiling() {
    const pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(performance.now() * 0.0032));
    const lineY = FIXED_CEILING_Y;
    const shadowHeight = 72;

    const shadow = ctx.createLinearGradient(0, lineY, 0, lineY + shadowHeight);
    shadow.addColorStop(0, `rgba(109, 219, 255, ${0.24 * pulse})`);
    shadow.addColorStop(0.5, `rgba(109, 219, 255, ${0.1 * pulse})`);
    shadow.addColorStop(1, 'rgba(109, 219, 255, 0)');
    ctx.fillStyle = shadow;
    ctx.fillRect(WELL.left + 8, lineY, WELL.right - WELL.left - 16, shadowHeight);

    ctx.strokeStyle = `rgba(137, 233, 255, ${0.76 + 0.2 * pulse})`;
    ctx.shadowColor = `rgba(86, 208, 255, ${0.55 + 0.3 * pulse})`;
    ctx.shadowBlur = 18;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(WELL.left + 10, lineY);
    ctx.lineTo(WELL.right - 10, lineY);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function overlayMessage(title, subtitle) {
    ctx.fillStyle = 'rgba(4,8,18,0.72)';
    ctx.fillRect(WELL.left, WELL.top, WELL.right - WELL.left, WELL.bottom - WELL.top);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#eef4ff';
    ctx.font = '800 34px Inter, sans-serif';
    ctx.fillText(title, WIDTH / 2, HEIGHT / 2 - 10);
    ctx.font = '500 16px Inter, sans-serif';
    ctx.fillStyle = '#b8c9ea';
    ctx.fillText(subtitle, WIDTH / 2, HEIGHT / 2 + 24);
  }

  function drawDangerLine() {
    const warningPulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.012);
    const isWarning = dangerActive && gamePhase === 'playing';
    const alpha = isWarning ? 0.72 + warningPulse * 0.28 : 0.45;
    ctx.strokeStyle = isWarning ? `rgba(255, 96, 96, ${alpha})` : 'rgba(255, 171, 90, 0.5)';
    ctx.lineWidth = 4;
    ctx.shadowColor = isWarning ? `rgba(255, 96, 96, ${alpha})` : 'rgba(255, 171, 90, 0.42)';
    ctx.shadowBlur = isWarning ? 16 : 8;
    ctx.beginPath();
    ctx.moveTo(WELL.left + 10, DANGER_Y);
    ctx.lineTo(WELL.right - 10, DANGER_Y);
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.fillStyle = isWarning ? 'rgba(255, 205, 205, 0.95)' : 'rgba(255, 225, 178, 0.88)';
    ctx.font = '700 14px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('DANGER LINE', WELL.left + 14, DANGER_Y - 8);
  }

  function drawDangerWarning() {
    if (!dangerActive || gamePhase !== 'playing') return;
    const remaining = Math.max(0, DANGER_GRACE_SECONDS - dangerTimer);
    const alpha = clamp(0.45 + (dangerTimer / DANGER_GRACE_SECONDS) * 0.55, 0.45, 1);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '900 48px Inter, sans-serif';
    ctx.fillStyle = '#ffd6d6';
    ctx.shadowColor = 'rgba(255,80,80,0.95)';
    ctx.shadowBlur = 16;
    ctx.fillText(`RECOVER ${remaining.toFixed(1)}s`, WIDTH / 2, HEIGHT * 0.32);
    ctx.restore();
  }

  function isInResultsButton(x, y) {
    if (!resultsButtonRect) return false;
    return (
      x >= resultsButtonRect.x &&
      x <= resultsButtonRect.x + resultsButtonRect.w &&
      y >= resultsButtonRect.y &&
      y <= resultsButtonRect.y + resultsButtonRect.h
    );
  }

  function drawResultsOverlay() {
    const stats = finalRunStats || {
      score: Math.floor(score),
      best,
      bestTier: bestTierThisRun,
      bestStreak: bestStreakThisRun,
    };
    const panelW = WELL.right - WELL.left - 36;
    const panelH = 384;
    const panelX = WELL.left + (WELL.right - WELL.left - panelW) / 2;
    const panelY = WELL.top + 70;
    ctx.fillStyle = 'rgba(3,7,16,0.8)';
    ctx.fillRect(WELL.left, WELL.top, WELL.right - WELL.left, WELL.bottom - WELL.top);
    ctx.fillStyle = 'rgba(15,25,46,0.96)';
    ctx.strokeStyle = 'rgba(166,209,255,0.55)';
    ctx.lineWidth = 2;
    roundRect(panelX, panelY, panelW, panelH, 20, true, true);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f1f7ff';
    ctx.font = '900 34px Inter, sans-serif';
    ctx.fillText('RUN OVER', WIDTH / 2, panelY + 42);

    const tierInfo = tierData(stats.bestTier);
    const rows = [
      `Final Score: ${stats.score.toLocaleString()}`,
      `Best Score: ${stats.best.toLocaleString()}`,
      `Highest Tier: ${stats.bestTier} (${tierInfo.name})`,
      `Tier Ladder: ${MAX_TIER} fixed tiers`,
      `Best Streak: ${stats.bestStreak.toFixed(1)}s`,
    ];
    ctx.font = '600 20px Inter, sans-serif';
    ctx.fillStyle = '#bed6ff';
    rows.forEach((line, idx) => ctx.fillText(line, WIDTH / 2, panelY + 94 + idx * 36));

    const btnW = panelW - 80;
    const btnH = 58;
    const btnX = panelX + (panelW - btnW) / 2;
    const btnY = panelY + panelH - btnH - 20;
    resultsButtonRect = { x: btnX, y: btnY, w: btnW, h: btnH };
    ctx.fillStyle = '#65d89e';
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2.5;
    roundRect(btnX, btnY, btnW, btnH, 14, true, true);
    ctx.fillStyle = '#08291a';
    ctx.font = '900 30px Inter, sans-serif';
    ctx.fillText('PLAY AGAIN', WIDTH / 2, btnY + btnH / 2 + 1);
  }

  // ── Main draw ─────────────────────────────────────────────────────────
  function draw() {
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    ctx.save();
    if (shakeFramesRemaining > 0) {
      const shakeX = (Math.random() * 2 - 1) * 3;
      const shakeY = (Math.random() * 2 - 1) * 3;
      ctx.translate(shakeX, shakeY);
    }

    // Well background
    const grad = ctx.createLinearGradient(0, WELL.top, 0, WELL.bottom);
    grad.addColorStop(0, '#0e1b35');
    grad.addColorStop(1, '#091120');
    ctx.fillStyle = grad;
    roundRect(WELL.left, WELL.top, WELL.right - WELL.left, WELL.bottom - WELL.top, 20, true, false);

    ctx.save();
    ctx.beginPath();
    roundRect(WELL.left, WELL.top, WELL.right - WELL.left, WELL.bottom - WELL.top, 20, false, false);
    ctx.clip();

    // Stars
    for (const s of BACKGROUND_STARS) {
      ctx.globalAlpha = s.a;
      ctx.fillStyle = '#d7e6ff';
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    for (let y = WELL.top + 28; y < WELL.bottom; y += 42) {
      ctx.beginPath();
      ctx.moveTo(WELL.left + 10, y);
      ctx.lineTo(WELL.right - 10, y);
      ctx.stroke();
    }

    // Well border
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 2;
    roundRect(WELL.left, WELL.top, WELL.right - WELL.left, WELL.bottom - WELL.top, 20, false, true);

    drawCeiling();
    drawDangerLine();

    // Aim line & launcher
    drawAimLine();
    drawLauncher();

    // Pieces
    for (const piece of pieces) drawPiece(piece);

    // Effects
    for (const fx of effects) {
      if (fx.type === 'pulse') {
        const p = 1 - fx.life / fx.maxLife;
        ctx.globalAlpha = (1 - p) * 0.6;
        ctx.strokeStyle = fx.color;
        ctx.lineWidth = 5 * (1 - p) + 1;
        ctx.beginPath();
        ctx.arc(fx.x, fx.y, fx.radius * (0.45 + p * 0.75), 0, Math.PI * 2);
        ctx.stroke();
      } else if (fx.type === 'spark') {
        ctx.globalAlpha = Math.max(0, fx.life / fx.maxLife);
        ctx.fillStyle = fx.color;
        ctx.beginPath();
        ctx.arc(fx.x, fx.y, fx.size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    if (paused && gamePhase === 'playing') overlayMessage('PAUSED', 'Press Pause again to resume');
    if (gamePhase === 'results') drawResultsOverlay();
    drawDangerWarning();

    ctx.restore();
    ctx.restore();
  }

  // ── Game loop ─────────────────────────────────────────────────────────
  function frame(ts) {
    if (!lastTime) lastTime = ts;
    const dt = Math.min(0.033, (ts - lastTime) / 1000);
    lastTime = ts;
    accumulator += dt;

    if (!paused && gamePhase === 'playing') {
      while (accumulator >= FIXED_STEP) {
        stepPhysics(FIXED_STEP);
        stepEffects(FIXED_STEP);
        accumulator -= FIXED_STEP;
      }
      if (Math.floor(score) > best) {
        best = Math.floor(score);
        safeSetBest(best);
        updateHud();
      }
    } else {
      accumulator = 0;
      stepEffects(dt);
    }

    draw();
    if (shakeFramesRemaining > 0) shakeFramesRemaining--;
    updateHud();
    requestAnimationFrame(frame);
  }

  validateSpawnWeights();
  resetGame();
  requestAnimationFrame(frame);
})();
