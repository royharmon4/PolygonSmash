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
  const LAUNCHER_X = WIDTH / 2;
  const LAUNCHER_Y = WELL.bottom - 58;
  const FIXED_CEILING_Y = WELL.top;
  const DANGER_Y = HEIGHT - 180;

  const FIXED_STEP = 1 / 60;
  const GRAVITY = -640;
  const AIR_DRAG = 0.992;
  const WALL_BOUNCE = 0.11;
  const PAIR_BOUNCE = 0.05;
  const MATCH_BOUNCE = 0.01;
  const LAUNCH_SPEED = 700;
  const LAUNCH_COOLDOWN = 0.42;
  const BASE_RADIUS = 24;
  const EXPLOSION_RADIUS = BASE_RADIUS * 3.8;
  const DANGER_GRACE_SECONDS = 2;

  const MERGE_SNAP_SLOP = 16;
  const MERGE_MIN_CONTACT_TIME = 0.015;
  const MERGE_MAX_RELATIVE_SPEED = 520;
  const MERGE_MAX_SEPARATING_SPEED = 300;

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

  const SPAWN_WEIGHTS = [
    { tier: 1, weight: 0.68 },
    { tier: 2, weight: 0.24 },
    { tier: 3, weight: 0.08 },
  ];

  const MAX_TIER = TIERS.length;
  const BACKGROUND_STARS = Array.from({ length: 38 }, (_, i) => ({
    x: (i * 73) % WIDTH,
    y: (i * 127) % HEIGHT,
    r: 1 + (i % 3),
    a: 0.14 + (i % 5) * 0.08,
  }));

  let pieces = [];
  let effects = [];
  let queuedMerges = [];
  let mergeContactTimes = new Map();
  let nextId = 1;
  let score = 0;
  let best = safeGetBest();
  let nextTier = 1;
  let queueTiers = [1, 1];
  let aimAngle = -Math.PI / 2;
  let launchCooldown = 0;
  let paused = false;
  let gamePhase = 'playing';
  let gameOver = false;
  let lastTime = 0;
  let accumulator = 0;
  let shakeFramesRemaining = 0;
  let dangerTimer = 0;
  let dangerActive = false;
  let earnedBestTierThisRun = 0;
  let bestStreakThisRun = 0;
  let currentSafeStreak = 0;
  let resultsButtonRect = null;
  let finalRunStats = null;
  let bestTierBanner = null;
  let audioCtx = null;
  let audioMaster = null;
  let noiseBuffer = null;

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

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function tierData(tier) {
    return TIERS[tier - 1];
  }

  function radiusForTier(tier) {
    return BASE_RADIUS * tierData(tier).radius;
  }

  function randomSpawnTier() {
    const roll = Math.random();
    let running = 0;
    for (const entry of SPAWN_WEIGHTS) {
      running += entry.weight;
      if (roll < running) return entry.tier;
    }
    return SPAWN_WEIGHTS[SPAWN_WEIGHTS.length - 1].tier;
  }

  function polygonClipPath(sides) {
    const points = [];
    for (let i = 0; i < sides; i++) {
      const a = -Math.PI / 2 + i * ((Math.PI * 2) / sides);
      points.push(`${(50 + Math.cos(a) * 50).toFixed(2)}% ${(50 + Math.sin(a) * 50).toFixed(2)}%`);
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

  function ensureAudioContext() {
    if (!window.AudioContext && !window.webkitAudioContext) return null;
    if (!audioCtx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctor();
      audioMaster = audioCtx.createGain();
      audioMaster.gain.value = 0.28;
      audioMaster.connect(audioCtx.destination);
      noiseBuffer = audioCtx.createBuffer(1, Math.floor(audioCtx.sampleRate * 0.4), audioCtx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function playTone(freq, duration = 0.085, volume = 0.08, type = 'sine', delay = 0) {
    const ac = ensureAudioContext();
    if (!ac || !audioMaster) return;
    const start = ac.currentTime + delay;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain);
    gain.connect(audioMaster);
    osc.start(start);
    osc.stop(start + duration + 0.01);
  }

  function playLaunchSound() {
    playTone(180, 0.075, 0.075, 'sine');
  }

  function playMergeSound(tier, chainDepth = 1) {
    const t = clamp(tier, 1, MAX_TIER);
    const base = 300 + ((t - 1) / (MAX_TIER - 1)) * 900;
    playTone(base, 0.095, 0.11, 'sine');
    if (chainDepth > 1) playTone(base * 1.12, 0.095, 0.09, 'sine', 0.045);
  }

  function playCollisionThunk(intensity = 1) {
    const ac = ensureAudioContext();
    if (!ac || !audioMaster || !noiseBuffer) return;
    const loudness = clamp(intensity, 0.45, 1.35);
    const now = ac.currentTime;
    const noiseSource = ac.createBufferSource();
    const lowpass = ac.createBiquadFilter();
    const noiseGain = ac.createGain();
    noiseSource.buffer = noiseBuffer;
    lowpass.type = 'lowpass';
    lowpass.frequency.setValueAtTime(350, now);
    noiseGain.gain.setValueAtTime(0.0001, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.012 * loudness, now + 0.004);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.055);
    noiseSource.connect(lowpass);
    lowpass.connect(noiseGain);
    noiseGain.connect(audioMaster);
    noiseSource.start(now);
    noiseSource.stop(now + 0.065);
  }

  function playExplosionSound() {
    playCollisionThunk(1.35);
    playTone(110, 0.14, 0.11, 'sawtooth', 0.02);
  }

  function playGameOverSound() {
    playTone(440, 0.08, 0.1, 'sine');
    playTone(330, 0.08, 0.1, 'sine', 0.08);
    playTone(220, 0.1, 0.1, 'sine', 0.16);
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
      cooldown: 0.12,
      merged: false,
      settleTime: 0,
      settled: false,
      touchingSupport: false,
      mergeFlash: 0,
      mergeFlashMax: 0.15,
      impactSoundCooldown: 0,
    };
  }

  function resetGame() {
    pieces = [];
    effects = [];
    queuedMerges = [];
    mergeContactTimes = new Map();
    nextId = 1;
    score = 0;
    launchCooldown = 0;
    paused = false;
    gamePhase = 'playing';
    gameOver = false;
    shakeFramesRemaining = 0;
    dangerTimer = 0;
    dangerActive = false;
    earnedBestTierThisRun = 0;
    bestStreakThisRun = 0;
    currentSafeStreak = 0;
    finalRunStats = null;
    resultsButtonRect = null;
    bestTierBanner = null;
    aimAngle = -Math.PI / 2;
    nextTier = randomSpawnTier();
    queueTiers = [randomSpawnTier(), randomSpawnTier()];
    pauseBtn.textContent = 'Pause';
    updateHud();
  }

  function clientToCanvas(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * (WIDTH / rect.width),
      y: (clientY - rect.top) * (HEIGHT / rect.height),
    };
  }

  function aimAtCanvasPoint(cx, cy) {
    let angle = Math.atan2(cy - LAUNCHER_Y, cx - LAUNCHER_X);
    angle = clamp(angle, -Math.PI + 0.18, -0.18);
    aimAngle = angle;
  }

  function launch() {
    if (gamePhase !== 'playing' || paused || launchCooldown > 0) return;
    ensureAudioContext();
    const tier = nextTier;
    const r = radiusForTier(tier);
    const dx = Math.cos(aimAngle);
    const dy = Math.sin(aimAngle);
    const x = clamp(LAUNCHER_X + dx * 50, WELL.left + r, WELL.right - r);
    const y = clamp(LAUNCHER_Y + dy * 50, FIXED_CEILING_Y + r, WELL.bottom - r);
    pieces.push(createPiece(x, y, tier, dx * LAUNCH_SPEED, dy * LAUNCH_SPEED));
    addDirectionalBurst(x, y, 8, tierData(tier).color, -dx, -dy, 0.5, 80, 170);
    launchCooldown = LAUNCH_COOLDOWN;
    nextTier = queueTiers.shift();
    queueTiers.push(randomSpawnTier());
    playLaunchSound();
    updateHud();
  }

  function togglePause() {
    if (gamePhase !== 'playing') return;
    paused = !paused;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  }

  canvas.addEventListener('pointermove', (e) => {
    const p = clientToCanvas(e.clientX, e.clientY);
    aimAtCanvasPoint(p.x, p.y);
  });

  canvas.addEventListener('pointerdown', (e) => {
    ensureAudioContext();
    const p = clientToCanvas(e.clientX, e.clientY);
    if (gamePhase === 'results' && isInResultsButton(p.x, p.y)) {
      resetGame();
      return;
    }
    aimAtCanvasPoint(p.x, p.y);
    if (e.pointerType === 'mouse') launch();
  });

  canvas.addEventListener('pointerup', (e) => {
    ensureAudioContext();
    const p = clientToCanvas(e.clientX, e.clientY);
    if (gamePhase === 'results' && isInResultsButton(p.x, p.y)) {
      resetGame();
      return;
    }
    aimAtCanvasPoint(p.x, p.y);
    if (e.pointerType !== 'mouse') launch();
  });

  canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  canvas.addEventListener('touchend', (e) => e.preventDefault(), { passive: false });

  window.addEventListener('keydown', (e) => {
    ensureAudioContext();
    if (e.code === 'Space') {
      e.preventDefault();
      launch();
    } else if (e.code === 'KeyR') {
      resetGame();
    } else if (e.code === 'KeyP') {
      togglePause();
    }
  });

  restartBtn.addEventListener('click', resetGame);
  pauseBtn.addEventListener('click', togglePause);

  function queueMerge(a, b) {
    if (!a || !b || a.merged || b.merged) return;
    a.merged = true;
    b.merged = true;
    queuedMerges.push([a, b]);
  }

  function removePiece(piece) {
    const idx = pieces.indexOf(piece);
    if (idx >= 0) pieces.splice(idx, 1);
  }

  function recordEarnedTier(tier) {
    if (tier <= earnedBestTierThisRun) return;
    earnedBestTierThisRun = tier;
    const info = tierData(tier);
    bestTierBanner = {
      text: `EARNED TIER ${tier} — ${info.name}!`,
      life: 1.1,
      maxLife: 1.1,
    };
  }

  function processMerges() {
    let chainDepth = 0;
    while (queuedMerges.length > 0) {
      chainDepth++;
      const merges = queuedMerges;
      queuedMerges = [];
      const consumed = new Set();

      for (const [a, b] of merges) {
        if (!pieces.includes(a) || !pieces.includes(b) || consumed.has(a.id) || consumed.has(b.id)) continue;
        consumed.add(a.id);
        consumed.add(b.id);
        const mx = (a.x + b.x) * 0.5;
        const my = (a.y + b.y) * 0.5;
        const tier = a.tier;
        removePiece(a);
        removePiece(b);

        const capstone = tierData(tier).capstone;
        if (capstone) {
          explode(mx, my, capstone);
          continue;
        }

        const newTier = Math.min(tier + 1, MAX_TIER);
        const mergedPiece = createPiece(mx, my, newTier, (a.vx + b.vx) * 0.12, (a.vy + b.vy) * 0.12);
        mergedPiece.cooldown = 0.08;
        mergedPiece.mergeFlash = mergedPiece.mergeFlashMax;
        pieces.push(mergedPiece);
        score += tierData(newTier).score;
        recordEarnedTier(newTier);
        if (chainDepth > 1) addChainText(mx, my - mergedPiece.r - 16, chainDepth);
        addPulse(mx, my, mergedPiece.r + 12, tierData(newTier).color, 0.25);
        playMergeSound(newTier, chainDepth);
        if (newTier >= 5) shakeFramesRemaining = Math.max(shakeFramesRemaining, newTier >= 8 ? 5 : 3);
      }
    }
  }

  function explode(x, y, capstoneConfig) {
    const survivors = [];
    let cleared = 0;
    for (const piece of pieces) {
      const dx = piece.x - x;
      const dy = piece.y - y;
      const dist = Math.hypot(dx, dy);
      if (dist <= EXPLOSION_RADIUS) {
        cleared += piece.tier * capstoneConfig.clearedTierScore;
      } else {
        const force = Math.max(0, 1 - (dist - EXPLOSION_RADIUS) / 90);
        if (force > 0) {
          piece.vx += (dx / Math.max(1, dist)) * 180 * force;
          piece.vy += (dy / Math.max(1, dist)) * 180 * force;
        }
        survivors.push(piece);
      }
    }
    pieces = survivors;
    score += capstoneConfig.mergeScore + cleared;
    addPulse(x, y, EXPLOSION_RADIUS, '#ffd3a8', 0.55);
    addBurst(x, y, 26, '#ffd3a8');
    shakeFramesRemaining = Math.max(shakeFramesRemaining, 9);
    playExplosionSound();
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

  function addDirectionalBurst(x, y, count, color, dirX, dirY, spread, speedMin, speedMax) {
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

  function addChainText(x, y, chainDepth) {
    effects.push({ type: 'chainText', x, y, rise: 28, text: `CHAIN x${chainDepth}`, life: 0.6, maxLife: 0.6 });
  }

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
      } else if (fx.type === 'chainText') {
        fx.y -= (fx.rise / fx.maxLife) * dt;
      }
    }
    if (bestTierBanner) {
      bestTierBanner.life -= dt;
      if (bestTierBanner.life <= 0) bestTierBanner = null;
    }
  }

  function stepPhysics(dt) {
    launchCooldown = Math.max(0, launchCooldown - dt);

    for (const piece of pieces) {
      piece.touchingSupport = false;
      piece.age += dt;
      piece.cooldown = Math.max(0, piece.cooldown - dt);
      piece.mergeFlash = Math.max(0, piece.mergeFlash - dt);
      piece.impactSoundCooldown = Math.max(0, piece.impactSoundCooldown - dt);
      piece.vy += GRAVITY * dt;
      piece.vx *= AIR_DRAG;
      piece.vy *= AIR_DRAG;
      piece.x += piece.vx * dt;
      piece.y += piece.vy * dt;

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

    const nextMergeContactTimes = new Map();
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < pieces.length; i++) {
        for (let j = i + 1; j < pieces.length; j++) {
          const a = pieces[i];
          const b = pieces[j];
          if (a.merged || b.merged) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.hypot(dx, dy) || 0.0001;
          const minDist = a.r + b.r;
          const nx = dx / dist;
          const ny = dy / dist;
          const overlap = minDist - dist;
          const mergeZoneDist = minDist + MERGE_SNAP_SLOP;
          const rvx = b.vx - a.vx;
          const rvy = b.vy - a.vy;
          const speedAlongNormal = rvx * nx + rvy * ny;
          const relativeSpeed = Math.hypot(rvx, rvy);
          const separatingSpeed = Math.max(0, speedAlongNormal);
          const pairKey = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;

          if (a.tier === b.tier && dist <= mergeZoneDist && a.cooldown <= 0 && b.cooldown <= 0) {
            const prior = mergeContactTimes.get(pairKey) || 0;
            const stableEnough = separatingSpeed <= MERGE_MAX_SEPARATING_SPEED && relativeSpeed <= MERGE_MAX_RELATIVE_SPEED;
            const contactTime = stableEnough ? prior + dt : 0;
            if (contactTime > 0) nextMergeContactTimes.set(pairKey, Math.min(0.5, contactTime));
            if (overlap >= -MERGE_SNAP_SLOP || contactTime >= MERGE_MIN_CONTACT_TIME) {
              queueMerge(a, b);
              continue;
            }
          }

          if (dist < minDist) {
            a.touchingSupport = true;
            b.touchingSupport = true;
            const correction = overlap * 0.5;
            a.x -= nx * correction;
            a.y -= ny * correction;
            b.x += nx * correction;
            b.y += ny * correction;

            if (speedAlongNormal < 0) {
              const restitution = a.tier === b.tier ? MATCH_BOUNCE : PAIR_BOUNCE;
              const impulse = -(1 + restitution) * speedAlongNormal * 0.5;
              a.vx -= impulse * nx;
              a.vy -= impulse * ny;
              b.vx += impulse * nx;
              b.vy += impulse * ny;
              if (a.tier !== b.tier && -speedAlongNormal > 70 && a.impactSoundCooldown <= 0 && b.impactSoundCooldown <= 0) {
                playCollisionThunk(0.58 + Math.max(a.tier, b.tier) * 0.03);
                a.impactSoundCooldown = 0.08;
                b.impactSoundCooldown = 0.08;
              }
            }
          }
        }
      }
    }
    mergeContactTimes = nextMergeContactTimes;
    processMerges();

    for (const piece of pieces) {
      const speed = Math.hypot(piece.vx, piece.vy);
      if (speed < 55 && piece.touchingSupport) {
        piece.vx *= 0.992;
        piece.vy *= 0.992;
      }
      const canSettle = piece.age > 0.2 && piece.touchingSupport && speed < 65;
      piece.settleTime = canSettle ? Math.min(1, piece.settleTime + dt) : Math.max(0, piece.settleTime - dt * 2);
      piece.settled = piece.settleTime >= 0.18;
    }

    let maxPieceBottom = -Infinity;
    for (const piece of pieces) {
      if (piece.settled) maxPieceBottom = Math.max(maxPieceBottom, piece.y + piece.r);
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

    if (dangerTimer >= DANGER_GRACE_SECONDS && !gameOver) triggerGameOver();

    if (!gameOver && Math.floor(score) > best) {
      best = Math.floor(score);
      safeSetBest(best);
    }
  }

  function triggerGameOver() {
    gameOver = true;
    gamePhase = 'results';
    best = Math.max(best, Math.floor(score));
    safeSetBest(best);
    finalRunStats = {
      score: Math.floor(score),
      best,
      earnedTier: earnedBestTierThisRun,
      bestStreak: bestStreakThisRun,
    };
    addBurst(WIDTH / 2, DANGER_Y, 28, '#ff7777');
    playGameOverSound();
    updateHud();
  }

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

  function drawPiece(piece) {
    const data = tierData(piece.tier);
    ctx.save();
    ctx.translate(piece.x, piece.y);
    ctx.rotate(-Math.PI / 2 + piece.tier * 0.07);
    if (piece.mergeFlash > 0) {
      const t = 1 - piece.mergeFlash / piece.mergeFlashMax;
      const scale = t < 0.5 ? 1 + t * 0.4 : 1.2 - (t - 0.5) * 0.4;
      ctx.scale(scale, scale);
    }
    regularPolygon(0, 0, piece.r * 0.92, data.sides, 0);
    ctx.fillStyle = data.color;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.shadowColor = 'rgba(122,195,255,0.6)';
    ctx.shadowBlur = 9;
    ctx.stroke();
    ctx.shadowBlur = 0;
    regularPolygon(0, 0, piece.r * 0.52, data.sides, Math.PI / data.sides);
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.62)';
    ctx.font = `700 ${Math.max(12, piece.r * 0.6)}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(piece.tier), 0, 1);
    ctx.restore();
  }

  function drawAimLine() {
    const len = 145;
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
    ctx.beginPath();
    ctx.arc(ax, ay, 5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(180,220,255,0.94)';
    ctx.fill();
  }

  function drawLauncher() {
    const data = tierData(nextTier);
    const dx = Math.cos(aimAngle);
    const dy = Math.sin(aimAngle);
    const pieceR = radiusForTier(nextTier) * 0.76;
    const barrelStartX = LAUNCHER_X + dx * (pieceR + 9);
    const barrelStartY = LAUNCHER_Y + dy * (pieceR + 9);
    const barrelEndX = LAUNCHER_X + dx * 76;
    const barrelEndY = LAUNCHER_Y + dy * 76;
    const cooldownProgress = clamp(1 - launchCooldown / LAUNCH_COOLDOWN, 0, 1);

    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(141,192,255,0.88)';
    ctx.lineWidth = 15;
    ctx.beginPath();
    ctx.moveTo(barrelStartX, barrelStartY);
    ctx.lineTo(barrelEndX, barrelEndY);
    ctx.stroke();
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(255,255,255,0.72)';
    ctx.beginPath();
    ctx.moveTo(barrelStartX, barrelStartY);
    ctx.lineTo(barrelEndX, barrelEndY);
    ctx.stroke();
    ctx.lineCap = 'butt';

    ctx.save();
    ctx.translate(LAUNCHER_X, LAUNCHER_Y);
    ctx.beginPath();
    ctx.arc(0, 0, pieceR + 11, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(5,12,24,0.74)';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.stroke();
    ctx.strokeStyle = cooldownProgress >= 1 ? '#7fffd4' : '#8dc0ff';
    ctx.beginPath();
    ctx.arc(0, 0, pieceR + 11, -Math.PI / 2, -Math.PI / 2 + cooldownProgress * Math.PI * 2);
    ctx.stroke();

    regularPolygon(0, 0, pieceR, data.sides, -Math.PI / 2);
    ctx.fillStyle = data.color;
    ctx.shadowColor = data.color;
    ctx.shadowBlur = 15;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.96)';
    ctx.stroke();
    regularPolygon(0, 0, pieceR * 0.52, data.sides, Math.PI / data.sides);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.78)';
    ctx.font = `800 ${Math.max(12, pieceR * 0.72)}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(nextTier), 0, 1);
    ctx.restore();
  }

  function drawCeiling() {
    const pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(performance.now() * 0.0032));
    const shadow = ctx.createLinearGradient(0, FIXED_CEILING_Y, 0, FIXED_CEILING_Y + 72);
    shadow.addColorStop(0, `rgba(109,219,255,${0.24 * pulse})`);
    shadow.addColorStop(1, 'rgba(109,219,255,0)');
    ctx.fillStyle = shadow;
    ctx.fillRect(WELL.left + 8, FIXED_CEILING_Y, WELL.right - WELL.left - 16, 72);
    ctx.strokeStyle = `rgba(137,233,255,${0.76 + 0.2 * pulse})`;
    ctx.shadowColor = `rgba(86,208,255,${0.55 + 0.3 * pulse})`;
    ctx.shadowBlur = 18;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(WELL.left + 10, FIXED_CEILING_Y);
    ctx.lineTo(WELL.right - 10, FIXED_CEILING_Y);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function drawDangerLine() {
    const warningPulse = 0.5 + 0.5 * Math.sin(performance.now() * (dangerTimer > 1 ? 0.024 : 0.012));
    const isWarning = dangerActive && gamePhase === 'playing';
    const alpha = isWarning ? 0.72 + warningPulse * 0.28 : 0.45;
    ctx.strokeStyle = isWarning ? `rgba(255,96,96,${alpha})` : 'rgba(255,171,90,0.5)';
    ctx.shadowColor = isWarning ? `rgba(255,96,96,${alpha})` : 'rgba(255,171,90,0.42)';
    ctx.shadowBlur = isWarning ? 16 : 8;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(WELL.left + 10, DANGER_Y);
    ctx.lineTo(WELL.right - 10, DANGER_Y);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = isWarning ? 'rgba(255,205,205,0.95)' : 'rgba(255,225,178,0.88)';
    ctx.font = '700 14px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('DANGER LINE', WELL.left + 14, DANGER_Y - 8);
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

  function drawDangerWarning() {
    if (!dangerActive || gamePhase !== 'playing') return;
    const remaining = Math.max(0, DANGER_GRACE_SECONDS - dangerTimer);
    ctx.save();
    ctx.globalAlpha = clamp(0.45 + (dangerTimer / DANGER_GRACE_SECONDS) * 0.55, 0.45, 1);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '900 48px Inter, sans-serif';
    ctx.fillStyle = '#ffd6d6';
    ctx.shadowColor = 'rgba(255,80,80,0.95)';
    ctx.shadowBlur = 16;
    ctx.fillText(`RECOVER ${remaining.toFixed(1)}s`, WIDTH / 2, HEIGHT * 0.32);
    ctx.restore();
  }

  function drawBestTierBanner() {
    if (!bestTierBanner || gamePhase !== 'playing') return;
    const p = 1 - bestTierBanner.life / bestTierBanner.maxLife;
    const alpha = 1 - p;
    const w = WELL.right - WELL.left - 70;
    const h = 52;
    const x = WELL.left + (WELL.right - WELL.left - w) / 2;
    const y = WELL.top + 78;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(14,30,58,0.88)';
    ctx.strokeStyle = 'rgba(196,226,255,0.95)';
    ctx.lineWidth = 2;
    roundRect(x, y, w, h, 14, true, true);
    ctx.fillStyle = '#f2f8ff';
    ctx.font = '900 22px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(bestTierBanner.text, WIDTH / 2, y + h / 2 + 1);
    ctx.restore();
  }

  function isInResultsButton(x, y) {
    if (!resultsButtonRect) return false;
    return x >= resultsButtonRect.x && x <= resultsButtonRect.x + resultsButtonRect.w && y >= resultsButtonRect.y && y <= resultsButtonRect.y + resultsButtonRect.h;
  }

  function drawResultsOverlay() {
    const stats = finalRunStats || { score: Math.floor(score), best, earnedTier: earnedBestTierThisRun, bestStreak: bestStreakThisRun };
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

    const earnedText = stats.earnedTier > 0 ? `${stats.earnedTier} (${tierData(stats.earnedTier).name})` : 'None yet';
    const rows = [
      `Final Score: ${stats.score.toLocaleString()}`,
      `Best Score: ${stats.best.toLocaleString()}`,
      `Highest Earned: ${earnedText}`,
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

  function draw() {
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    ctx.save();
    if (shakeFramesRemaining > 0) ctx.translate((Math.random() * 2 - 1) * 3, (Math.random() * 2 - 1) * 3);

    const grad = ctx.createLinearGradient(0, WELL.top, 0, WELL.bottom);
    grad.addColorStop(0, '#0e1b35');
    grad.addColorStop(1, '#091120');
    ctx.fillStyle = grad;
    roundRect(WELL.left, WELL.top, WELL.right - WELL.left, WELL.bottom - WELL.top, 20, true, false);

    ctx.save();
    roundRect(WELL.left, WELL.top, WELL.right - WELL.left, WELL.bottom - WELL.top, 20, false, false);
    ctx.clip();

    for (const s of BACKGROUND_STARS) {
      ctx.globalAlpha = s.a;
      ctx.fillStyle = '#d7e6ff';
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    for (let y = WELL.top + 28; y < WELL.bottom; y += 42) {
      ctx.beginPath();
      ctx.moveTo(WELL.left + 10, y);
      ctx.lineTo(WELL.right - 10, y);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 2;
    roundRect(WELL.left, WELL.top, WELL.right - WELL.left, WELL.bottom - WELL.top, 20, false, true);

    drawCeiling();
    drawDangerLine();
    drawAimLine();
    drawLauncher();
    for (const piece of pieces) drawPiece(piece);

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
      } else if (fx.type === 'chainText') {
        const alpha = clamp(fx.life / fx.maxLife, 0, 1);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = 'rgba(9,20,40,0.9)';
        ctx.lineWidth = 4;
        ctx.font = '900 24px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.strokeText(fx.text, fx.x, fx.y);
        ctx.fillText(fx.text, fx.x, fx.y);
      }
    }
    ctx.globalAlpha = 1;

    if (paused && gamePhase === 'playing') overlayMessage('PAUSED', 'Press Pause again to resume');
    if (gamePhase === 'results') drawResultsOverlay();
    drawDangerWarning();
    drawBestTierBanner();

    ctx.restore();
    ctx.restore();
  }

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
