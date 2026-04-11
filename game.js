(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const scoreEl = document.getElementById('score');
  const bestEl = document.getElementById('best');
  const levelEl = document.getElementById('level');
  const ceilingSpeedFillEl = document.getElementById('ceilingSpeedFill');
  const tierListEl = document.getElementById('tierList');
  const restartBtn = document.getElementById('restartBtn');
  const pauseBtn = document.getElementById('pauseBtn');

  const WIDTH = canvas.width;
  const HEIGHT = canvas.height;
  const MARGIN = 24;
  const WELL = { left: MARGIN, right: WIDTH - MARGIN, top: 10, bottom: HEIGHT - 34 };

  // Launcher sits at the BOTTOM — shoots UPWARD
  const LAUNCHER_Y = WELL.bottom - 30;
  const LAUNCHER_X = WIDTH / 2;

  const DANGER_Y = HEIGHT - 180; // danger line higher — less headroom
  const CEILING_START_Y = WELL.top;
  const CEILING_BASE_SPEED = 8;
  const CEILING_MAX_SPEED = 18;
  const CEILING_SPEED_RAMP = 0.035;
  const LEVEL_SCORE_STEP = 800;
  const CEILING_LEVEL_SPEED_MULT = 1.06;
  const POLARITY_LEVEL_FORCE_MULT = 1.05;
  const LEVEL_UP_FLASH_DURATION = 1;
  const LEVEL_UP_REWARD_PUSH = 30;
  const GRAVITY = -640;
  const AIR_DRAG = 0.999; // less drag — pieces stay bouncy/chaotic longer
  const WALL_BOUNCE = 0.22; // more wall bounce — messier stacking
  const PAIR_BOUNCE = 0.15; // pieces jostle each other more
  const MERGE_RELATIVE_SPEED = 320;
  const POLARITY_FORCE_BASE = 180;
  const POLARITY_FORCE_MAX = 60;
  const POLARITY_FORCE_RANGE_MULT = 2.2;
  const LAUNCH_COOLDOWN = 0.42; // slower fire rate — can't spam out of trouble
  const FIXED_STEP = 1 / 60;
  const MAX_TIER = 8;
  const BASE_RADIUS = 24; // slightly bigger pieces — board fills faster
  const EXPLOSION_RADIUS = BASE_RADIUS * 3.8; // smaller blast — decagon less OP
  const BACKGROUND_STARS = Array.from({ length: 36 }, (_, i) => ({
    x: (i * 73) % WIDTH,
    y: (i * 127) % HEIGHT,
    r: 1 + (i % 3),
    a: 0.15 + (i % 5) * 0.08,
  }));

  const TIERS = [
    { name: 'Triangle', sides: 3, radius: 1.0, score: 10, color: '#62b0ff' },
    { name: 'Square', sides: 4, radius: 1.12, score: 20, color: '#6ad4ff' },
    { name: 'Pentagon', sides: 5, radius: 1.26, score: 40, color: '#6bf3d2' },
    { name: 'Hexagon', sides: 6, radius: 1.42, score: 80, color: '#8af17f' },
    { name: 'Heptagon', sides: 7, radius: 1.6, score: 160, color: '#d7ec72' },
    { name: 'Octagon', sides: 8, radius: 1.82, score: 320, color: '#ffd166' },
    { name: 'Nonagon', sides: 9, radius: 2.08, score: 640, color: '#ff9f6e' },
    { name: 'Decagon', sides: 10, radius: 2.38, score: 1000, color: '#ff7196' },
  ];

  tierListEl.innerHTML = TIERS.map(
    (tier, i) => `
        <div class="tier-row">
          <div class="dot" style="background:${tier.color}"></div>
          <div>${i + 1}. ${tier.name}</div>
          <div class="pill">${tier.score} pts</div>
        </div>
      `,
  ).join('');

  // FIX 1 & 2: separate aim state from touch-fire state
  // aimAngle is updated continuously; firing only happens on pointerup / touchend
  let aimAngle = -Math.PI / 2; // default: straight up
  let pieces = [];
  let effects = [];
  let queuedMerges = [];
  let nextId = 1;
  let score = 0;
  let level = 1;
  let best = Number(localStorage.getItem('polygon-pop-best') || '0');
  let nextTier = 1; // what fires next (shown on barrel)
  let queueTier = 1; // what fires after that (shown in NEXT panel)
  let nextPolarity = 1;
  let queuePolarity = 1;
  let launchCooldown = 0;
  let ceilingY = CEILING_START_Y;
  let ceilingSpeed = CEILING_BASE_SPEED;
  let elapsedTime = 0;
  let lastTime = 0;
  let accumulator = 0;
  let shakeFramesRemaining = 0;
  let paused = false;
  let gameOver = false;
  let levelUpFlash = 0;
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
    level = 1;
    launchCooldown = 0;
    ceilingY = CEILING_START_Y;
    ceilingSpeed = CEILING_BASE_SPEED;
    elapsedTime = 0;
    shakeFramesRemaining = 0;
    gameOver = false;
    levelUpFlash = 0;
    paused = false;
    aimAngle = -Math.PI / 2;
    pauseBtn.textContent = 'Pause';
    nextTier = randomSpawnTier();
    queueTier = randomSpawnTier();
    nextPolarity = randomPolarity();
    queuePolarity = randomPolarity();
    updateHud();
  }

  function updateHud() {
    scoreEl.textContent = Math.floor(score).toLocaleString();
    bestEl.textContent = Math.floor(best).toLocaleString();
    levelEl.textContent = String(level);
    const speedPct = clamp((ceilingSpeed - CEILING_BASE_SPEED) / (CEILING_MAX_SPEED - CEILING_BASE_SPEED), 0, 1);
    ceilingSpeedFillEl.style.width = `${Math.round((0.15 + speedPct * 0.85) * 100)}%`;
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
    const t = clamp((level - 1) / 4, 0, 1);
    const tier1Weight = 0.7 + (0.45 - 0.7) * t;
    const tier2Weight = 0.25 + (0.35 - 0.25) * t;
    const roll = Math.random();
    if (roll < tier1Weight) return 1;
    if (roll < tier1Weight + tier2Weight) return 2;
    return 3;
  }

  function levelForScore(currentScore) {
    return Math.floor(Math.max(0, currentScore) / LEVEL_SCORE_STEP) + 1;
  }

  function syncDifficultyFromScore() {
    const targetLevel = levelForScore(score);
    if (targetLevel <= level) return;
    for (let gainedLevel = level + 1; gainedLevel <= targetLevel; gainedLevel++) {
      if (gainedLevel % 3 === 0) {
        levelUpFlash = LEVEL_UP_FLASH_DURATION;
        ceilingY = Math.max(CEILING_START_Y, ceilingY - LEVEL_UP_REWARD_PUSH);
      }
    }
    level = targetLevel;
  }

  function ceilingLevelMultiplier() {
    return Math.pow(CEILING_LEVEL_SPEED_MULT, Math.max(0, level - 1));
  }

  function polarityLevelMultiplier() {
    return Math.pow(POLARITY_LEVEL_FORCE_MULT, Math.max(0, level - 1));
  }

  function randomPolarity() {
    return Math.random() < 0.5 ? 1 : -1;
  }

  function polaritySymbol(polarity) {
    return polarity > 0 ? '+' : '−';
  }

  function polarityTint(polarity, alpha = 0.65) {
    return polarity > 0 ? `rgba(110, 190, 255, ${alpha})` : `rgba(255, 167, 84, ${alpha})`;
  }

  function mergedPolarity(aPolarity, bPolarity) {
    if (aPolarity > 0 && bPolarity > 0) return -1;
    return 1;
  }

  function tierData(tier) {
    return TIERS[tier - 1];
  }
  function radiusForTier(tier) {
    return BASE_RADIUS * tierData(tier).radius;
  }

  function createPiece(x, y, tier, vx = 0, vy = 0, polarity = 1) {
    return {
      id: nextId++,
      x,
      y,
      vx,
      vy,
      tier,
      r: radiusForTier(tier),
      age: 0,
      cooldown: 0.14,
      merged: false,
      mergeFlash: 0,
      mergeFlashMax: 0.15,
      polarity,
    };
  }

  function launch() {
    if (gameOver || paused || launchCooldown > 0) return;
    ensureAudioContext();
    const tier = nextTier;
    const r = radiusForTier(tier);
    const dx = Math.cos(aimAngle);
    const dy = Math.sin(aimAngle);
    // spawn just inside the bottom edge
    const x = clamp(LAUNCHER_X + dx * 28, WELL.left + r, WELL.right - r);
    const y = clamp(LAUNCHER_Y + dy * 10, ceilingY + r, WELL.bottom - r);
    pieces.push(createPiece(x, y, tier, dx * 760, dy * 760, nextPolarity));
    addDirectionalBurst(x, y, 7, tierData(tier).color, -dx, -dy, 0.5, 80, 170);
    launchCooldown = LAUNCH_COOLDOWN;
    playLaunchSound();
    nextTier = queueTier;
    nextPolarity = queuePolarity;
    queueTier = randomSpawnTier();
    queuePolarity = randomPolarity();
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
    aimAtCanvasPoint(p.x, p.y);
    launch();
  });

  // Also allow click to fire so mouse users get instant feedback on press
  canvas.addEventListener('pointerdown', (e) => {
    ensureAudioContext();
    const p = clientToCanvas(e.clientX, e.clientY);
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
      // Use changedTouches for the final position
      const t = e.changedTouches[0];
      const p = clientToCanvas(t.clientX, t.clientY);
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
      paused = !paused;
      pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    }
  });

  restartBtn.addEventListener('click', resetGame);
  pauseBtn.addEventListener('click', () => {
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
      const spawnedPieces = [];

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

        if (tier >= MAX_TIER) {
          pushCeilingUp(tier);
          explode(mx, my);
          continue;
        }

        const newTier = tier + 1;
        const piece = createPiece(
          mx,
          my,
          newTier,
          (a.vx + b.vx) * 0.18,
          (a.vy + b.vy) * 0.18,
          mergedPolarity(a.polarity, b.polarity),
        );
        piece.cooldown = 0.16;
        piece.mergeFlash = piece.mergeFlashMax;
        pieces.push(piece);
        spawnedPieces.push(piece);
        score += tierData(newTier).score;
        addPulse(mx, my, piece.r + 10, tierData(newTier).color, 0.25);
        if (mergeCount === 0) {
          playMergeSound(newTier);
        } else {
          playChainMergeSound(newTier);
        }
        mergeCount++;
        pushCeilingUp(tier);
      }

      // Chain merges: newly spawned pieces can immediately merge again when touching same-tier pieces.
      for (const piece of spawnedPieces) {
        if (!pieces.includes(piece) || chainConsumed.has(piece.id) || piece.merged) continue;

        for (const candidate of pieces) {
          if (
            candidate.id === piece.id ||
            candidate.tier !== piece.tier ||
            candidate.merged ||
            chainConsumed.has(candidate.id)
          ) {
            continue;
          }

          const dx = candidate.x - piece.x;
          const dy = candidate.y - piece.y;
          const minDist = candidate.r + piece.r;
          if (dx * dx + dy * dy > minDist * minDist) continue;
          queueMerge(piece, candidate);
          break;
        }
      }
    }
  }

  function mergeCeilingPush(tier) {
    const normalized = clamp(tier, 1, 7);
    const t = (normalized - 1) / 6;
    return 14 + t * (40 - 14);
  }

  function pushCeilingUp(mergeTier) {
    ceilingY = Math.max(CEILING_START_Y, ceilingY - mergeCeilingPush(mergeTier));
  }

  function explode(x, y) {
    playExplosionSound();
    const survivors = [];
    let cleared = 0;
    for (const piece of pieces) {
      const dx = piece.x - x;
      const dy = piece.y - y;
      if (Math.hypot(dx, dy) <= EXPLOSION_RADIUS) {
        cleared += piece.tier;
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
    score += 1000 + cleared * 50;
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
    levelUpFlash = Math.max(0, levelUpFlash - dt);
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
    elapsedTime += dt;
    const baseSpeed = Math.min(CEILING_MAX_SPEED, CEILING_BASE_SPEED + elapsedTime * CEILING_SPEED_RAMP);
    ceilingSpeed = baseSpeed * ceilingLevelMultiplier();
    ceilingY += ceilingSpeed * dt;

    for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        const a = pieces[i];
        const b = pieces[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distSq = dx * dx + dy * dy;
        if (distSq <= 0.0001) continue;
        const dist = Math.sqrt(distSq);
        const range = (a.r + b.r) * POLARITY_FORCE_RANGE_MULT;
        if (dist > range) continue;
        const polarityForceBase = POLARITY_FORCE_BASE * polarityLevelMultiplier();
        const polarityForceMax = POLARITY_FORCE_MAX * polarityLevelMultiplier();
        const forceMag = Math.min(polarityForceMax, polarityForceBase / distSq);
        const nx = dx / dist;
        const ny = dy / dist;
        const dir = a.polarity === b.polarity ? -1 : 1;
        const dvx = nx * forceMag * dt * dir;
        const dvy = ny * forceMag * dt * dir;
        a.vx -= dvx;
        a.vy -= dvy;
        b.vx += dvx;
        b.vy += dvy;
      }
    }

    for (const piece of pieces) {
      piece.age += dt;
      piece.cooldown = Math.max(0, piece.cooldown - dt);
      piece.mergeFlash = Math.max(0, piece.mergeFlash - dt);
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
      if (piece.y - piece.r < ceilingY) {
        piece.y = ceilingY + piece.r;
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

          const nx = dx / dist;
          const ny = dy / dist;
          const overlap = (minDist - dist) * 0.5;
          a.x -= nx * overlap;
          a.y -= ny * overlap;
          b.x += nx * overlap;
          b.y += ny * overlap;

          const rvx = b.vx - a.vx;
          const rvy = b.vy - a.vy;
          const speedAlongNormal = rvx * nx + rvy * ny;
          if (speedAlongNormal < 0) {
            const impulse = -(1 + PAIR_BOUNCE) * speedAlongNormal * 0.5;
            a.vx -= impulse * nx;
            a.vy -= impulse * ny;
            b.vx += impulse * nx;
            b.vy += impulse * ny;
          }

          // FIX 3: merge when same tier, cooled down, and relative speed below (raised) threshold
          if (
            a.tier === b.tier &&
            !a.merged &&
            !b.merged &&
            a.cooldown <= 0 &&
            b.cooldown <= 0 &&
            Math.abs(speedAlongNormal) <= MERGE_RELATIVE_SPEED
          ) {
            queueMerge(a, b);
          }
        }
      }
    }

    processMerges();
    syncDifficultyFromScore();

    if (ceilingY >= DANGER_Y && !gameOver) {
      gameOver = true;
      playGameOverSound();
      best = Math.max(best, Math.floor(score));
      localStorage.setItem('polygon-pop-best', String(best));
      updateHud();
      addBurst(WIDTH / 2, ceilingY, 28, '#ff7777');
    }

    if (!gameOver) {
      best = Math.max(best, Math.floor(score));
      localStorage.setItem('polygon-pop-best', String(best));
    }
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
    ctx.shadowColor = polarityTint(piece.polarity, 0.8);
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
    ctx.fillText(polaritySymbol(piece.polarity), 0, 1);
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
    const len = 100;
    const ax = LAUNCHER_X + Math.cos(aimAngle) * len;
    const ay = LAUNCHER_Y + Math.sin(aimAngle) * len;

    ctx.setLineDash([10, 10]);
    ctx.strokeStyle = 'rgba(133,184,255,0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(LAUNCHER_X, LAUNCHER_Y);
    ctx.lineTo(ax, ay);
    ctx.stroke();
    ctx.setLineDash([]);
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
    ctx.fillText(polaritySymbol(nextPolarity), tipX, tipY + 1);

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
    const lineY = ceilingY;
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

  function drawLevelUpFlash() {
    if (levelUpFlash <= 0 || level % 3 !== 0) return;
    const alpha = clamp(levelUpFlash / LEVEL_UP_FLASH_DURATION, 0, 1);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '900 60px Inter, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(125,255,179,0.95)';
    ctx.shadowBlur = 18;
    ctx.fillText('LEVEL UP', WIDTH / 2, HEIGHT / 2);
    ctx.restore();
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

    if (paused && !gameOver) overlayMessage('PAUSED', 'Press Pause again to resume');
    if (gameOver) overlayMessage('GAME OVER', 'Press Restart to play again');
    drawLevelUpFlash();

    ctx.restore();
    ctx.restore();
  }

  // ── Game loop ─────────────────────────────────────────────────────────
  function frame(ts) {
    if (!lastTime) lastTime = ts;
    const dt = Math.min(0.033, (ts - lastTime) / 1000);
    lastTime = ts;
    accumulator += dt;

    if (!paused && !gameOver) {
      while (accumulator >= FIXED_STEP) {
        stepPhysics(FIXED_STEP);
        stepEffects(FIXED_STEP);
        accumulator -= FIXED_STEP;
      }
      if (Math.floor(score) > best) {
        best = Math.floor(score);
        localStorage.setItem('polygon-pop-best', String(best));
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

  resetGame();
  requestAnimationFrame(frame);
})();
