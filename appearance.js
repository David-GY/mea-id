/* Apply the saved appearance before paint; storage may be unavailable. */
(() => {
  function apply(value) {
    const theme = ['dark', 'garden', 'coffee', 'plum'].includes(value) ? value : value === 'light' ? 'garden' : 'dark';
    document.documentElement.dataset.appearance = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', ({dark:'#0a3535',garden:'#557d5a',coffee:'#80634c',plum:'#352c40'})[theme]);
  }
  let saved = 'dark';
  try { saved = localStorage.getItem('mea_appearance') || 'dark'; } catch (_) {}
  apply(saved);
  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('appearance-select');
    select.value = document.documentElement.dataset.appearance;
    select.addEventListener('change', () => {
      apply(select.value);
      try { localStorage.setItem('mea_appearance', select.value); } catch (_) {}
    });
  });
})();
