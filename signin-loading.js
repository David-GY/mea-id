/* Account verification feedback; the local preview can also show a static sample. */
(() => {
  const screen = document.createElement('dialog');
  screen.className = 'signin-loading-screen';
  screen.setAttribute('aria-labelledby', 'signin-loading-title');
  screen.innerHTML = `<div class="signin-loading-content">
    <div class="signin-loading-brands"><img src="brand/mea-logo-lightgray.png" alt="MEA"><img src="brand/sus-logo-white.png" alt="SUS"></div>
    <div class="signin-loading-spinner" aria-hidden="true"></div>
    <div role="status" aria-live="polite"><h1 id="signin-loading-title">Signing you in…</h1>
    <p>Checking your school account and MEA access.</p></div>
    <p class="signin-loading-note">This may take a moment.</p>
    <button type="button" class="btn-secondary" hidden>Close sample</button>
  </div>`;
  document.body.appendChild(screen);
  let sample = false, pending = 0;
  screen.addEventListener('cancel', event => { if (!sample) event.preventDefault(); });
  const close = screen.querySelector('button');
  close.addEventListener('click', () => { sample = false; screen.close(); });
  window.meaSignInLoading = {
    show() { pending++; if (!screen.open) screen.showModal(); },
    hide() { pending = Math.max(0, pending - 1); if (!pending && !sample) screen.close(); },
    sample() { sample = true; close.hidden = false; if (!screen.open) screen.showModal(); }
  };
  screen.addEventListener('close', () => { sample = false; close.hidden = true; });
  if (['127.0.0.1','localhost'].includes(location.hostname)) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'btn-secondary';
    button.textContent = 'Preview sign-in loading';
    button.id = 'preview-signin-loading';
    button.style.margin = '16px auto';
    button.addEventListener('click', () => window.meaSignInLoading.sample());
    document.getElementById('view-help')?.appendChild(button);
  }
})();
