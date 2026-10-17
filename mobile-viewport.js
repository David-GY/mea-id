/* Keep a phone's layout width when returning from external sign-in. */
(() => {
  function restorePhoneViewport() {
    const {width, height, orientation} = window.screen;
    if (!width || !height || Math.min(width, height) >= 768 ||
        !window.matchMedia('(pointer: coarse)').matches) return;
    const landscape = orientation?.type
      ? orientation.type.startsWith('landscape')
      : Math.abs(window.orientation || 0) === 90;
    const phoneWidth = landscape ? Math.max(width, height) : Math.min(width, height);
    const viewport = document.querySelector('meta[name="viewport"]');
    const content = `width=${phoneWidth}, initial-scale=1.0, viewport-fit=cover`;
    if (viewport && viewport.content !== content) viewport.content = content;
  }
  restorePhoneViewport();
  window.addEventListener('pageshow', restorePhoneViewport);
  window.addEventListener('orientationchange', restorePhoneViewport);
  window.screen.orientation?.addEventListener('change', restorePhoneViewport);
  document.addEventListener('mea:viewchange', restorePhoneViewport);
})();
