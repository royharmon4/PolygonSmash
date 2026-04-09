(() => {
      const CONFIG = {
        baseWidth: 480,
        baseHeight: 760,
        margin: 24,
        wellTop: 76,
        wellBottomInset: 34,
        launcherBottomInset: 30,
        launcherOffset: 28,
        launcherTipOffset: 10,
        launchSpeed: 760,
        gravity: -640,
        airDrag: 0.995,
        wallBounce: 0.16,
        pairBounce: 0.1,
        mergeRelativeSpeed: 320,
        launchCooldown: 0.28,
        failTime: 1.75,
        fixedStep: 1 / 60,
        maxTier: 8,
        baseRadius: 21,
        explosionRadiusMultiplier: 5.5,
        dangerOffset: 126,
        comboWindow: 1.1,
        maxShake: 8,
        pointerAimStep: 0.08,
        minAimAngle: -Math.PI + 0.18,
        maxAimAngle: -0.18,
        recoilDuration: 0.08,
      };

      const TIERS = [
        { name: 'Triangle',  sides: 3,  radius: 1.00, score: 10,   color: '#62b0ff' },
        { name: 'Square',    sides: 4,  radius: 1.14, score: 20,   color: '#6ad4ff' },
        { name: 'Pentagon',  sides: 5,  radius: 1.30, score: 40,   color: '#6bf3d2' },
        { name: 'Hexagon',   sides: 6,  radius: 1.48, score: 80,   color: '#8af17f' },
        { name: 'Heptagon',  sides: 7,  radius: 1.68, score: 160,  color: '#d7ec72' },
        { name: 'Octagon',   sides: 8,  radius: 1.92, score: 320,  color: '#ffd166' },
        { name: 'Nonagon',   sides: 9,  radius: 2.20, score: 640,  color: '#ff9f6e' },
        { name: 'Decagon',   sides: 10, radius: 2.52, score: 1000, color: '#ff7196' },
      ];

      const GameState = {
        READY: 'ready',
        PLAYING: 'playing',
        PAUSED: 'paused',
        GAME_OVER: 'game_over',
      };

      const canvas = document.getElementById('game');
      const ctx = canvas.getContext('2d');
      const scoreEl = document.getElementById('score');
      const bestEl = document.getElementById('best');
      const currentLabelEl = document.getElementById('currentLabel');
      const nextLabelEl = document.getElementById('nextLabel');
      const tierListEl = document.getElementById('tierList');
      const restartBtn = document.getElementById('restartBtn');
      const pauseBtn = document.getElementById('pauseBtn');
      const srStatus = document.getElementById('srStatus');

      tierListEl.innerHTML = TIERS.map((tier, i) => `
        <div class="tier-row">
          <div class="dot" style="background:${tier.color}"></div>
          <div>${i + 1}. ${tier.name}</div>
          <div class="pill">${tier.score} pts</div>
        </div>
      `).join('');

      function loadBestScore() {
        try {
          return Number(window.localStorage.getItem('polygon-pop-best') || '0');
        } catch {
          return 0;
        }
      }

      function persistBestScore(value) {
        try {
          window.localStorage.setItem('polygon-pop-best', String(value));
        } catch {
          // Ignore storage failures in sandboxed previews or private contexts.
        }
      }

      const state = {
        pieces: [],
        effects: [],
        queuedMerges: [],
        nextId: 1,
        score: 0,
        best: loadBestScore(),
        currentTier: 1,
        nextTier: 1,
        launchCooldown: 0,
        failTimer: 0,
        comboTimer: 0,
        comboCount: 0,
        lastAnnouncedCombo: 0,
        gameState: GameState.READY,
        lastTime: 0,
        accumulator: 0,
        recoil: 0,
        shake: 0,
        dangerFlash: 0,
      };

      const input = {
        aimAngle: -Math.PI / 2,
        isAiming: false,
        activePointerId: null,
      };

      const scene = {
        width: CONFIG.baseWidth,
        height: CONFIG.baseHeight,
        dpr: 1,
        well: { left: 0, right: 0, top: 0, bottom: 0 },
        launcher: { x: 0, y: 0 },
        dangerY: 0,
      };

      const BACKGROUND_STARS = Array.from({ length: 36 }, (_, i) => ({
        x: (i * 73) % CONFIG.baseWidth,
        y: (i * 127) % CONFIG.baseHeight,
        r: 1 + (i % 3),
        a: 0.15 + (i % 5) * 0.08,
      }));

      function clamp(v, lo, hi) {
        return Math.max(lo, Math.min(hi, v));
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
        return CONFIG.baseRadius * tierData(tier).radius;
      }

      function setScore(newScore) {
        const rounded = Math.floor(newScore);
        if (rounded === Math.floor(state.score)) {
          state.score = newScore;
          return;
        }
        state.score = newScore;
        scoreEl.textContent = String(rounded);
        setBest(rounded);
      }

      function setBest(newBest) {
        if (newBest <= state.best) return;
        state.best = newBest;
        bestEl.textContent = String(newBest);
        persistBestScore(newBest);
      }

      function setQueue(currentTier, nextTier) {
        state.currentTier = currentTier;
        state.nextTier = nextTier;
        currentLabelEl.textContent = tierData(currentTier).name;
        nextLabelEl.textContent = tierData(nextTier).name;
      }

      function setGameState(nextState) {
        state.gameState = nextState;
        pauseBtn.textContent = nextState === GameState.PAUSED ? 'Resume' : 'Pause';
      }

      function announce(message) {
        srStatus.textContent = message;
      }

      function addShake(amount) {
        state.shake = Math.min(CONFIG.maxShake, state.shake + amount);
      }

      function addPulse(x, y, radius, color, strength) {
        state.effects.push({
          type: 'pulse', x, y, radius, color,
          life: 0.35 + strength,
          maxLife: 0.35 + strength,
        });
      }

      function addBurst(x, y, count, color) {
        for (let i = 0; i < count; i++) {
          const angle = (Math.PI * 2 * i) / count + Math.random() * 0.35;
          const speed = 90 + Math.random() * 160;
          state.effects.push({
            type: 'spark',
            x, y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            life: 0.5 + Math.random() * 0.3,
            maxLife: 0.8,
            color,
            size: 2 + Math.random() * 4,
          });
        }
      }

      function addFloatingText(x, y, text, color) {
        state.effects.push({
          type: 'text', x, y, text, color,
          vy: -32,
          life: 0.75,
          maxLife: 0.75,
        });
      }

      function createPiece(x, y, tier, vx = 0, vy = 0) {
        return {
          id: state.nextId++,
          x, y, vx, vy,
          tier,
          r: radiusForTier(tier),
          age: 0,
          cooldown: 0.14,
          merged: false,
          spin: (Math.random() - 0.5) * 1.8,
          angle: Math.random() * Math.PI * 2,
        };
      }

      function resizeCanvas() {
        const rect = canvas.getBoundingClientRect();
        const cssWidth = Math.max(280, Math.floor(rect.width || 480));
        const cssHeight = Math.floor(cssWidth * (CONFIG.baseHeight / CONFIG.baseWidth));
        const dpr = window.devicePixelRatio || 1;

        canvas.style.height = `${cssHeight}px`;
        canvas.width = Math.floor(cssWidth * dpr);
        canvas.height = Math.floor(cssHeight * dpr);

        scene.width = cssWidth;
        scene.height = cssHeight;
        scene.dpr = dpr;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        scene.well.left = CONFIG.margin;
        scene.well.right = scene.width - CONFIG.margin;
        scene.well.top = CONFIG.wellTop;
        scene.well.bottom = scene.height - CONFIG.wellBottomInset;
        scene.launcher.x = scene.width / 2;
        scene.launcher.y = scene.well.bottom - CONFIG.launcherBottomInset;
        scene.dangerY = scene.height - CONFIG.dangerOffset;
      }

      function regularPolygon(cx, cy, r, sides, rotation) {
        ctx.beginPath();
        for (let i = 0; i < sides; i++) {
          const a = rotation + i * (Math.PI * 2 / sides);
          const px = cx + Math.cos(a) * r;
          const py = cy + Math.sin(a) * r;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
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

      function clientToCanvas(clientX, clientY) {
        const rect = canvas.getBoundingClientRect();
        return {
          x: ((clientX - rect.left) / rect.width) * scene.width,
          y: ((clientY - rect.top) / rect.height) * scene.height,
        };
      }

      function aimAtCanvasPoint(x, y) {
        const dx = x - scene.launcher.x;
        const dy = y - scene.launcher.y;
        let angle = Math.atan2(dy, dx);
        angle = clamp(angle, CONFIG.minAimAngle, CONFIG.maxAimAngle);
        input.aimAngle = angle;
      }

      function isSpawnBlocked(tier) {
        const r = radiusForTier(tier);
        const spawnX = clamp(scene.launcher.x + Math.cos(input.aimAngle) * CONFIG.launcherOffset, scene.well.left + r, scene.well.right - r);
        const spawnY = clamp(scene.launcher.y + Math.sin(input.aimAngle) * CONFIG.launcherTipOffset, scene.well.top + r, scene.well.bottom - r);

        for (const piece of state.pieces) {
          const dist = Math.hypot(piece.x - spawnX, piece.y - spawnY);
          if (dist < piece.r + r + 6) return true;
        }
        return false;
      }

      function queueMerge(a, b) {
        if (!a || !b || a.merged || b.merged) return;
        a.merged = true;
        b.merged = true;
        state.queuedMerges.push([a, b]);
      }

      function removePiece(piece) {
        const i = state.pieces.indexOf(piece);
        if (i >= 0) state.pieces.splice(i, 1);
      }

      function explode(x, y) {
        const survivors = [];
        let cleared = 0;
        const radius = CONFIG.baseRadius * CONFIG.explosionRadiusMultiplier;

        for (const piece of state.pieces) {
          const dx = piece.x - x;
          const dy = piece.y - y;
          const dist = Math.hypot(dx, dy);
          if (dist <= radius) {
            cleared += piece.tier;
          } else {
            const safeDist = Math.max(1, dist);
            const force = Math.max(0, 1 - (safeDist - radius) / 90);
            if (force > 0) {
              piece.vx += (dx / safeDist) * 180 * force;
              piece.vy += (dy / safeDist) * 180 * force;
            }
            survivors.push(piece);
          }
        }

        state.pieces = survivors;
        const bonus = 1000 + cleared * 50;
        setScore(state.score + bonus);
        addPulse(x, y, radius, '#ffd3a8', 0.55);
        addBurst(x, y, 24, '#ffd3a8');
        addFloatingText(x, y, `BLAST +${bonus}`, '#ffe1b9');
        addShake(5.5);
      }

      function processMerges() {
        for (const [a, b] of state.queuedMerges) {
          if (!state.pieces.includes(a) || !state.pieces.includes(b)) continue;
          const mx = (a.x + b.x) * 0.5;
          const my = (a.y + b.y) * 0.5;
          const tier = a.tier;
          removePiece(a);
          removePiece(b);

          if (tier >= CONFIG.maxTier) {
            explode(mx, my);
            continue;
          }

          const newTier = tier + 1;
          const piece = createPiece(mx, my, newTier, (a.vx + b.vx) * 0.18, (a.vy + b.vy) * 0.18);
          piece.cooldown = 0.16;
          state.pieces.push(piece);

          state.comboCount = state.comboTimer > 0 ? state.comboCount + 1 : 1;
          state.comboTimer = CONFIG.comboWindow;
          const comboMultiplier = 1 + Math.min(4, state.comboCount - 1) * 0.25;
          const points = Math.round(tierData(newTier).score * comboMultiplier);
          setScore(state.score + points);
          addPulse(mx, my, piece.r + 10, tierData(newTier).color, 0.25);
          addBurst(mx, my, 8 + newTier, tierData(newTier).color);
          addFloatingText(mx, my, `+${points}`, '#ffffff');
          addShake(1.2 + newTier * 0.2);

          if (state.comboCount >= 2 && state.comboCount !== state.lastAnnouncedCombo) {
            state.lastAnnouncedCombo = state.comboCount;
            announce(`${state.comboCount} chain combo.`);
          }
        }
        state.queuedMerges = [];
      }

      function launch() {
        if (state.gameState === GameState.GAME_OVER || state.gameState === GameState.PAUSED) return;
        if (state.launchCooldown > 0) return;
        if (isSpawnBlocked(state.currentTier)) {
          addShake(1.5);
          announce('Shot blocked. Clear space near the launcher.');
          return;
        }

        const tier = state.currentTier;
        const r = radiusForTier(tier);
        const dx = Math.cos(input.aimAngle);
        const dy = Math.sin(input.aimAngle);
        const x = clamp(scene.launcher.x + dx * CONFIG.launcherOffset, scene.well.left + r, scene.well.right - r);
        const y = clamp(scene.launcher.y + dy * CONFIG.launcherTipOffset, scene.well.top + r, scene.well.bottom - r);
        state.pieces.push(createPiece(x, y, tier, dx * CONFIG.launchSpeed, dy * CONFIG.launchSpeed));
        state.launchCooldown = CONFIG.launchCooldown;
        state.recoil = CONFIG.recoilDuration;
        setQueue(state.nextTier, randomSpawnTier());
        if (state.gameState === GameState.READY) setGameState(GameState.PLAYING);
      }

      function resetGame() {
        state.pieces = [];
        state.effects = [];
        state.queuedMerges = [];
        state.nextId = 1;
        state.score = 0;
        state.failTimer = 0;
        state.comboTimer = 0;
        state.comboCount = 0;
        state.lastAnnouncedCombo = 0;
        state.launchCooldown = 0;
        state.accumulator = 0;
        state.lastTime = 0;
        state.recoil = 0;
        state.shake = 0;
        state.dangerFlash = 0;
        scoreEl.textContent = '0';
        bestEl.textContent = String(state.best);
        input.aimAngle = -Math.PI / 2;
        input.isAiming = false;
        input.activePointerId = null;
        setQueue(randomSpawnTier(), randomSpawnTier());
        setGameState(GameState.READY);
        announce('Game reset.');
      }

      function togglePause() {
        if (state.gameState === GameState.GAME_OVER) return;
        if (state.gameState === GameState.PAUSED) {
          setGameState(GameState.PLAYING);
          announce('Game resumed.');
        } else {
          setGameState(GameState.PAUSED);
          announce('Game paused.');
        }
      }

      function stepEffects(dt) {
        state.shake = Math.max(0, state.shake - dt * 18);
        state.recoil = Math.max(0, state.recoil - dt);
        state.dangerFlash = Math.max(0, state.dangerFlash - dt * 2.6);

        for (let i = state.effects.length - 1; i >= 0; i--) {
          const fx = state.effects[i];
          fx.life -= dt;
          if (fx.life <= 0) {
            state.effects.splice(i, 1);
            continue;
          }
          if (fx.type === 'spark') {
            fx.vx *= 0.98;
            fx.vy *= 0.98;
            fx.x += fx.vx * dt;
            fx.y += fx.vy * dt;
          } else if (fx.type === 'text') {
            fx.y += fx.vy * dt;
          }
        }
      }

      function stepPhysics(dt) {
        state.launchCooldown = Math.max(0, state.launchCooldown - dt);
        state.comboTimer = Math.max(0, state.comboTimer - dt);
        if (state.comboTimer <= 0) {
          state.comboCount = 0;
          state.lastAnnouncedCombo = 0;
        }

        for (const piece of state.pieces) {
          piece.age += dt;
          piece.cooldown = Math.max(0, piece.cooldown - dt);
          piece.vy += CONFIG.gravity * dt;
          piece.vx *= CONFIG.airDrag;
          piece.vy *= CONFIG.airDrag;
          piece.x += piece.vx * dt;
          piece.y += piece.vy * dt;
          piece.angle += piece.spin * dt;

          if (piece.x - piece.r < scene.well.left) {
            piece.x = scene.well.left + piece.r;
            if (piece.vx < 0) piece.vx *= -CONFIG.wallBounce;
          }
          if (piece.x + piece.r > scene.well.right) {
            piece.x = scene.well.right - piece.r;
            if (piece.vx > 0) piece.vx *= -CONFIG.wallBounce;
          }
          if (piece.y - piece.r < scene.well.top) {
            piece.y = scene.well.top + piece.r;
            if (piece.vy < 0) piece.vy *= -CONFIG.wallBounce;
          }
          if (piece.y + piece.r > scene.well.bottom) {
            piece.y = scene.well.bottom - piece.r;
            if (piece.vy > 0) piece.vy *= -CONFIG.wallBounce;
          }
        }

        for (let pass = 0; pass < 2; pass++) {
          for (let i = 0; i < state.pieces.length; i++) {
            for (let j = i + 1; j < state.pieces.length; j++) {
              const a = state.pieces[i];
              const b = state.pieces[j];
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
                const impulse = -(1 + CONFIG.pairBounce) * speedAlongNormal * 0.5;
                a.vx -= impulse * nx;
                a.vy -= impulse * ny;
                b.vx += impulse * nx;
                b.vy += impulse * ny;
              }

              if (
                a.tier === b.tier &&
                !a.merged && !b.merged &&
                a.cooldown <= 0 && b.cooldown <= 0 &&
                Math.abs(speedAlongNormal) <= CONFIG.mergeRelativeSpeed
              ) {
                queueMerge(a, b);
              }
            }
          }
        }

        processMerges();

        const inDanger = state.pieces.some((p) => p.y + p.r > scene.dangerY);
        if (inDanger) {
          state.failTimer += dt;
          state.dangerFlash = Math.min(1, state.dangerFlash + dt * 2.5);
        } else {
          state.failTimer = Math.max(0, state.failTimer - dt * 2.5);
        }

        if (state.failTimer >= CONFIG.failTime && state.gameState !== GameState.GAME_OVER) {
          setGameState(GameState.GAME_OVER);
          setBest(Math.floor(state.score));
          addBurst(scene.width / 2, scene.dangerY, 28, '#ff7777');
          addShake(6.5);
          announce(`Game over. Final score ${Math.floor(state.score)}.`);
        }
      }

      function drawPiece(piece) {
        const tier = tierData(piece.tier);
        ctx.save();
        ctx.translate(piece.x, piece.y);
        ctx.rotate(piece.angle - Math.PI / 2 + piece.tier * 0.04);
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

      function drawAimLine() {
        const len = 112;
        const ax = scene.launcher.x + Math.cos(input.aimAngle) * len;
        const ay = scene.launcher.y + Math.sin(input.aimAngle) * len;

        ctx.setLineDash([10, 8]);
        ctx.strokeStyle = 'rgba(133,184,255,0.95)';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(scene.launcher.x, scene.launcher.y);
        ctx.lineTo(ax, ay);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      function drawLauncher() {
        const tier = tierData(state.currentTier);
        const barrelLen = 44;
        const recoilOffset = state.recoil > 0 ? (state.recoil / CONFIG.recoilDuration) * 8 : 0;

        ctx.save();
        ctx.translate(scene.launcher.x, scene.launcher.y);
        ctx.rotate(input.aimAngle);
        ctx.fillStyle = '#8dc0ff';
        roundRect(-8, -barrelLen + recoilOffset, 16, barrelLen, 8, true, false);

        const pieceR = radiusForTier(state.currentTier) * 0.72;
        const tipX = 0;
        const tipY = -(barrelLen + pieceR + 4) + recoilOffset;
        regularPolygon(tipX, tipY, pieceR * 0.92, tier.sides, -Math.PI / 2);
        ctx.fillStyle = tier.color;
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.stroke();
        regularPolygon(tipX, tipY, pieceR * 0.52, tier.sides, Math.PI / tier.sides);
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fill();
        ctx.restore();

        ctx.beginPath();
        ctx.arc(scene.launcher.x, scene.launcher.y, 18, 0, Math.PI * 2);
        ctx.fillStyle = '#5d94f2';
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.stroke();
      }

      function drawPreview() {
        const tier = tierData(state.nextTier);
        const px = scene.width - 64;
        const py = 44;
        ctx.save();
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        roundRect(px - 42, py - 26, 84, 52, 16, true, false);
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = '12px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('NEXT', px, py - 8);
        regularPolygon(px, py + 10, 16, tier.sides, -Math.PI / 2);
        ctx.fillStyle = tier.color;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.stroke();
        ctx.restore();
      }

      function drawEffects() {
        for (const fx of state.effects) {
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
          } else if (fx.type === 'text') {
            ctx.globalAlpha = Math.max(0, fx.life / fx.maxLife);
            ctx.fillStyle = fx.color;
            ctx.font = '700 18px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(fx.text, fx.x, fx.y);
          }
        }
        ctx.globalAlpha = 1;
      }

      function overlayMessage(title, subtitle) {
        ctx.fillStyle = 'rgba(4,8,18,0.72)';
        ctx.fillRect(scene.well.left, scene.well.top, scene.well.right - scene.well.left, scene.well.bottom - scene.well.top);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#eef4ff';
        ctx.font = '800 34px Inter, sans-serif';
        ctx.fillText(title, scene.width / 2, scene.height / 2 - 10);
        ctx.font = '500 16px Inter, sans-serif';
        ctx.fillStyle = '#b8c9ea';
        ctx.fillText(subtitle, scene.width / 2, scene.height / 2 + 24);
      }

      function drawCombo() {
        if (state.comboCount < 2 || state.comboTimer <= 0) return;
        const alpha = Math.min(1, state.comboTimer / CONFIG.comboWindow + 0.2);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#fff2a3';
        ctx.textAlign = 'left';
        ctx.font = '800 20px Inter, sans-serif';
        ctx.fillText(`${state.comboCount}x CHAIN`, scene.well.left + 14, 50);
        ctx.globalAlpha = 1;
      }

      function draw() {
        ctx.clearRect(0, 0, scene.width, scene.height);

        const shakeX = state.shake > 0 ? (Math.random() - 0.5) * state.shake : 0;
        const shakeY = state.shake > 0 ? (Math.random() - 0.5) * state.shake : 0;

        ctx.save();
        ctx.translate(shakeX, shakeY);

        const grad = ctx.createLinearGradient(0, scene.well.top, 0, scene.well.bottom);
        grad.addColorStop(0, '#0e1b35');
        grad.addColorStop(1, '#091120');
        ctx.fillStyle = grad;
        roundRect(scene.well.left, scene.well.top, scene.well.right - scene.well.left, scene.well.bottom - scene.well.top, 20, true, false);

        ctx.save();
        ctx.beginPath();
        roundRect(scene.well.left, scene.well.top, scene.well.right - scene.well.left, scene.well.bottom - scene.well.top, 20, false, false);
        ctx.clip();

        for (const s of BACKGROUND_STARS) {
          ctx.globalAlpha = s.a;
          ctx.fillStyle = '#d7e6ff';
          ctx.beginPath();
          ctx.arc((s.x / CONFIG.baseWidth) * scene.width, (s.y / CONFIG.baseHeight) * scene.height, s.r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;

        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.lineWidth = 1;
        for (let y = scene.well.top + 28; y < scene.well.bottom; y += 42) {
          ctx.beginPath();
          ctx.moveTo(scene.well.left + 10, y);
          ctx.lineTo(scene.well.right - 10, y);
          ctx.stroke();
        }

        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 2;
        roundRect(scene.well.left, scene.well.top, scene.well.right - scene.well.left, scene.well.bottom - scene.well.top, 20, false, true);

        const dangerAlpha = 0.35 + Math.min(0.65, state.failTimer / CONFIG.failTime) + state.dangerFlash * 0.18;
        ctx.strokeStyle = `rgba(255,96,96,${dangerAlpha})`;
        ctx.lineWidth = 3 + state.dangerFlash * 2;
        ctx.beginPath();
        ctx.moveTo(scene.well.left + 10, scene.dangerY);
        ctx.lineTo(scene.well.right - 10, scene.dangerY);
        ctx.stroke();
        ctx.fillStyle = `rgba(255,96,96,${0.08 + dangerAlpha * 0.09})`;
        ctx.fillRect(scene.well.left + 4, scene.dangerY, scene.well.right - scene.well.left - 8, scene.well.bottom - scene.dangerY);

        drawAimLine();
        drawLauncher();

        for (const piece of state.pieces) drawPiece(piece);
        drawEffects();
        drawPreview();

        if (state.gameState === GameState.PAUSED) {
          overlayMessage('PAUSED', 'Press Pause again to resume');
        } else if (state.gameState === GameState.GAME_OVER) {
          overlayMessage('GAME OVER', 'Press Restart to play again');
        } else if (state.gameState === GameState.READY) {
          overlayMessage('READY', 'Aim and release to fire');
        }

        ctx.restore();
        drawCombo();
        ctx.restore();
      }

      function frame(ts) {
        if (!state.lastTime) state.lastTime = ts;
        const dt = Math.min(0.033, (ts - state.lastTime) / 1000);
        state.lastTime = ts;
        state.accumulator += dt;

        if (state.gameState !== GameState.PAUSED && state.gameState !== GameState.GAME_OVER) {
          while (state.accumulator >= CONFIG.fixedStep) {
            stepPhysics(CONFIG.fixedStep);
            stepEffects(CONFIG.fixedStep);
            state.accumulator -= CONFIG.fixedStep;
          }
        } else {
          state.accumulator = 0;
          stepEffects(dt);
        }

        draw();
        requestAnimationFrame(frame);
      }

      canvas.addEventListener('pointerdown', (e) => {
        input.activePointerId = e.pointerId;
        input.isAiming = true;
        canvas.setPointerCapture(e.pointerId);
        const p = clientToCanvas(e.clientX, e.clientY);
        aimAtCanvasPoint(p.x, p.y);
        canvas.focus();
      });

      canvas.addEventListener('pointermove', (e) => {
        if (!input.isAiming || e.pointerId !== input.activePointerId) return;
        const p = clientToCanvas(e.clientX, e.clientY);
        aimAtCanvasPoint(p.x, p.y);
      });

      canvas.addEventListener('pointerup', (e) => {
        if (e.pointerId !== input.activePointerId) return;
        const p = clientToCanvas(e.clientX, e.clientY);
        aimAtCanvasPoint(p.x, p.y);
        launch();
        input.isAiming = false;
        input.activePointerId = null;
      });

      canvas.addEventListener('pointercancel', () => {
        input.isAiming = false;
        input.activePointerId = null;
      });

      window.addEventListener('keydown', (e) => {
        if (e.code === 'Space') {
          e.preventDefault();
          launch();
        } else if (e.code === 'KeyR') {
          resetGame();
        } else if (e.code === 'KeyP') {
          togglePause();
        } else if (e.code === 'ArrowLeft') {
          input.aimAngle = clamp(input.aimAngle - CONFIG.pointerAimStep, CONFIG.minAimAngle, CONFIG.maxAimAngle);
        } else if (e.code === 'ArrowRight') {
          input.aimAngle = clamp(input.aimAngle + CONFIG.pointerAimStep, CONFIG.minAimAngle, CONFIG.maxAimAngle);
        }
      });

      restartBtn.addEventListener('click', resetGame);
      pauseBtn.addEventListener('click', togglePause);
      window.addEventListener('resize', resizeCanvas);

      resizeCanvas();
      bestEl.textContent = String(state.best);
      resetGame();
      requestAnimationFrame(frame);
    })();
