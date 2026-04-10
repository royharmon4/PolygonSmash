(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const scoreEl = document.getElementById('score');
  const bestEl = document.getElementById('best');
  const nextLabelEl = document.getElementById('nextLabel');
  const nextCanvas = document.getElementById('nextCanvas');
  const nextCtx = nextCanvas.getContext('2d');
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
  const GRAVITY = -640;
  const AIR_DRAG = 0.999; // less drag — pieces stay bouncy/chaotic longer
  const WALL_BOUNCE = 0.22; // more wall bounce — messier stacking
  const PAIR_BOUNCE = 0.15; // pieces jostle each other more
  const MERGE_RELATIVE_SPEED = 320;
  const LAUNCH_COOLDOWN = 0.42; // slower fire rate — can't spam out of trouble
  const FAIL_TIME = 1.1; // less grace time below the danger line
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
  let best = Number(localStorage.getItem('polygon-pop-best') || '0');
  let nextTier = 1; // what fires next (shown on barrel)
  let queueTier = 1; // what fires after that (shown in NEXT panel)
  let launchCooldown = 0;
  let failTimer = 0;
  let lastTime = 0;
  let accumulator = 0;
  let paused = false;
  let gameOver = false;

  function resetGame() {
    pieces = [];
    effects = [];
    queuedMerges = [];
    nextId = 1;
    score = 0;
    failTimer = 0;
    launchCooldown = 0;
    gameOver = false;
    paused = false;
    aimAngle = -Math.PI / 2;
    pauseBtn.textContent = 'Pause';
    nextTier = randomSpawnTier();
    queueTier = randomSpawnTier();
    updateHud();
  }

  function updateHud() {
    scoreEl.textContent = Math.floor(score).toLocaleString();
    bestEl.textContent = Math.floor(best).toLocaleString();
    const tier = tierData(queueTier);
    nextLabelEl.textContent = tier.name;
    // draw mini polygon on the small canvas
    nextCtx.clearRect(0, 0, 22, 22);
    regularPolygonCtx(nextCtx, 11, 11, 9, tier.sides, -Math.PI / 2);
    nextCtx.fillStyle = tier.color;
    nextCtx.fill();
    nextCtx.lineWidth = 1.5;
    nextCtx.strokeStyle = 'rgba(255,255,255,0.8)';
    nextCtx.stroke();
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
    if (roll < 0.7) return 1;
    if (roll < 0.95) return 2;
    return 3;
  }

  function tierData(tier) {
    return TIERS[tier - 1];
  }
  function radiusForTier(tier) {
    return BASE_RADIUS * tierData(tier).radius;
  }

  function createPiece(x, y, tier, vx = 0, vy = 0) {
    return { id: nextId++, x, y, vx, vy, tier, r: radiusForTier(tier), age: 0, cooldown: 0.14, merged: false };
  }

  function launch() {
    if (gameOver || paused || launchCooldown > 0) return;
    const tier = nextTier;
    const r = radiusForTier(tier);
    const dx = Math.cos(aimAngle);
    const dy = Math.sin(aimAngle);
    // spawn just inside the bottom edge
    const x = clamp(LAUNCHER_X + dx * 28, WELL.left + r, WELL.right - r);
    const y = clamp(LAUNCHER_Y + dy * 10, WELL.top + r, WELL.bottom - r);
    pieces.push(createPiece(x, y, tier, dx * 760, dy * 760));
    launchCooldown = LAUNCH_COOLDOWN;
    nextTier = queueTier;
    queueTier = randomSpawnTier();
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
    const p = clientToCanvas(e.clientX, e.clientY);
    aimAtCanvasPoint(p.x, p.y);
    launch();
  });

  // Also allow click to fire so mouse users get instant feedback on press
  canvas.addEventListener('pointerdown', (e) => {
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
    for (const [a, b] of queuedMerges) {
      if (!pieces.includes(a) || !pieces.includes(b)) continue;
      const mx = (a.x + b.x) * 0.5;
      const my = (a.y + b.y) * 0.5;
      const tier = a.tier;
      removePiece(a);
      removePiece(b);
      if (tier >= MAX_TIER) {
        explode(mx, my);
        continue;
      }
      const newTier = tier + 1;
      const piece = createPiece(mx, my, newTier, (a.vx + b.vx) * 0.18, (a.vy + b.vy) * 0.18);
      piece.cooldown = 0.16;
      pieces.push(piece);
      score += tierData(newTier).score;
      addPulse(mx, my, piece.r + 10, tierData(newTier).color, 0.25);
    }
    queuedMerges = [];
  }

  function explode(x, y) {
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
      piece.age += dt;
      piece.cooldown = Math.max(0, piece.cooldown - dt);
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
      if (piece.y - piece.r < WELL.top) {
        piece.y = WELL.top + piece.r;
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

    // Fail timer
    const danger = pieces.some((p) => p.y + p.r > DANGER_Y);
    failTimer = danger ? failTimer + dt : Math.max(0, failTimer - dt * 2.5);

    if (failTimer >= FAIL_TIME && !gameOver) {
      gameOver = true;
      best = Math.max(best, Math.floor(score));
      localStorage.setItem('polygon-pop-best', String(best));
      updateHud();
      addBurst(WIDTH / 2, DANGER_Y, 28, '#ff7777');
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
    regularPolygon(0, 0, piece.r * 0.92, tier.sides, 0);
    ctx.fillStyle = tier.color;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke();
    regularPolygon(0, 0, piece.r * 0.52, tier.sides, Math.PI / tier.sides);
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fill();
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

    ctx.restore();

    // base circle
    ctx.beginPath();
    ctx.arc(LAUNCHER_X, LAUNCHER_Y, 18, 0, Math.PI * 2);
    ctx.fillStyle = '#5d94f2';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke();
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

  // ── Main draw ─────────────────────────────────────────────────────────
  function draw() {
    ctx.clearRect(0, 0, WIDTH, HEIGHT);

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

    // Danger zone
    const dangerAlpha = 0.35 + Math.min(0.65, failTimer / FAIL_TIME);
    ctx.strokeStyle = `rgba(255,96,96,${dangerAlpha})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(WELL.left + 10, DANGER_Y);
    ctx.lineTo(WELL.right - 10, DANGER_Y);
    ctx.stroke();
    ctx.fillStyle = `rgba(255,96,96,${0.08 + dangerAlpha * 0.08})`;
    ctx.fillRect(WELL.left + 4, DANGER_Y, WELL.right - WELL.left - 8, WELL.bottom - DANGER_Y);

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
    updateHud();
    requestAnimationFrame(frame);
  }

  resetGame();
  requestAnimationFrame(frame);
})();
