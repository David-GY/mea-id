/* Local UI trial: a mascot runner for a catalog with no loaded items. */
(() => {
  let dispose = () => {};
  const mascot = new Image();
  mascot.src = 'brand/catalog-runner.png';
  window.meaRenderEmptyCatalogGame = container => {
    dispose();
    const panel = document.createElement('section');
    panel.className = 'catalog-dino';
    panel.innerHTML = `<h2>Nothing loaded yet</h2>
      <p>Tap Refresh to check inventory. Play a little while you wait.</p>
      <canvas width="560" height="180" tabindex="0" role="img" aria-label="Mascot runner. Use the Jump button, Space, or Arrow Up to jump over cacti."></canvas>
      <output aria-label="Game score">Score: 0</output>
      <p class="dino-status" role="status">Ready when you are.</p>
      <button type="button" class="btn-secondary">Start game</button>
      <p>Tap the character or press Space to jump.</p>`;
    container.appendChild(panel);
    const canvas = panel.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const button = panel.querySelector('button');
    const status = panel.querySelector('.dino-status');
    const output = panel.querySelector('output');
    if (!ctx) { panel.remove(); return; }
    let running = false, frame = 0, previous = 0, score = 0, y = 0, velocity = 0;
    let cactus = 560, nextWidth = 18, distance = 0;
    const ground = 144;
    function draw() {
      ctx.clearRect(0, 0, 560, 180);
      ctx.fillStyle = '#e0f5f5';
      ctx.globalAlpha = .35;
      ctx.fillRect(0, ground, 560, 1);
      for (let x = -(distance % 70); x < 560; x += 70) ctx.fillRect(x, 153, 10, 2);
      ctx.globalAlpha = 1;
      if (mascot.complete && mascot.naturalWidth) {
        const bob = running && y === 0 ? Math.sin(distance / 12) * 1.5 : 0;
        ctx.drawImage(mascot, 46, ground - 54 - y + bob, 50, 54);
      }
      ctx.fillRect(cactus, ground-32, nextWidth, 32);
      ctx.fillRect(cactus-8, ground-26, 5, 14);
      ctx.fillRect(cactus-8, ground-16, 10, 5);
      ctx.fillRect(cactus+nextWidth+3, ground-30, 5, 13);
      ctx.fillRect(cactus+nextWidth-1, ground-22, 9, 5);
    }
    function pause() {
      if (!running) return;
      running = false;
      cancelAnimationFrame(frame);
      button.textContent = 'Play again';
      status.textContent = 'Paused. Start a new run whenever you like.';
    }
    function tick(time) {
      if (!panel.isConnected || document.hidden || !panel.closest('.view.active')) { pause(); return; }
      const dt = Math.min((time - previous) / 1000, .04);
      previous = time;
      velocity -= 1500 * dt;
      y = Math.max(0, y + velocity * dt);
      if (y === 0) velocity = 0;
      const step = (220 + Math.min(score * 2, 140)) * dt;
      cactus -= step; distance += step;
      score += dt * 10;
      if (cactus < -40) { cactus = 560 + Math.random()*180; nextWidth = 14 + Math.random()*10; }
      output.textContent = 'Score: ' + Math.floor(score);
      draw();
      if (cactus < 83 && cactus + nextWidth + 8 > 57 && y < 29) {
        running = false;
        status.textContent = 'Game over. Score ' + Math.floor(score) + '. Try again!';
        button.textContent = 'Play again';
        return;
      }
      frame = requestAnimationFrame(tick);
    }
    function jump() {
      if (!running) {
        running = true; score = 0; y = 0; velocity = 0; cactus = 560; distance = 0;
        previous = performance.now();
        status.textContent = 'Jump over the cacti!';
        button.textContent = 'Jump';
        frame = requestAnimationFrame(tick);
      } else if (y === 0) velocity = 570;
    }
    button.addEventListener('click', jump);
    canvas.addEventListener('click', jump);
    canvas.addEventListener('keydown', event => {
      if (['Space','ArrowUp'].includes(event.code)) { event.preventDefault(); if (!event.repeat) jump(); }
    });
    document.addEventListener('visibilitychange', pause);
    dispose = () => { running = false; cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', pause); };
    mascot.onload = () => { if (panel.isConnected) draw(); };
    draw();
  };
})();
