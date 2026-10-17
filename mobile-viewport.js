/* Keep a phone's layout width when returning from external sign-in. */
(() => {
  const storageKey = 'mea_phone_viewport_v1';
  let phoneSize;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (Array.isArray(saved) && saved.length === 2 && saved.every(Number.isFinite) &&
        saved[0] > 0 && saved[0] < 768 && saved[1] >= saved[0] && saved[1] <= 10000) phoneSize = saved;
  } catch (_) {}
  function restorePhoneViewport() {
    const {width, height, orientation} = window.screen;
    const touch = window.navigator.maxTouchPoints > 0 || window.matchMedia('(any-pointer: coarse)').matches;
    if (!touch || !width || !height) return;
    const shortEdge = Math.min(width, height), longEdge = Math.max(width, height);
    if (shortEdge < 768 && (phoneSize?.[0] !== shortEdge || phoneSize?.[1] !== longEdge)) {
      phoneSize = [shortEdge, longEdge];
      try { localStorage.setItem(storageKey, JSON.stringify(phoneSize)); } catch (_) {}
    }
    if (!phoneSize) return;
    const landscape = orientation?.type
      ? orientation.type.startsWith('landscape')
      : Math.abs(window.orientation || 0) === 90;
    const phoneWidth = phoneSize[landscape ? 1 : 0];
    const viewport = document.querySelector('meta[name="viewport"]');
    const content = `width=${phoneWidth}, initial-scale=1.0, viewport-fit=cover`;
    if (viewport && viewport.content !== content) viewport.content = content;
  }
  restorePhoneViewport();
  window.addEventListener('pageshow', restorePhoneViewport);
  window.addEventListener('orientationchange', restorePhoneViewport);
  window.screen.orientation?.addEventListener('change', restorePhoneViewport);
  document.addEventListener('mea:viewchange', restorePhoneViewport);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) restorePhoneViewport(); });
})();
