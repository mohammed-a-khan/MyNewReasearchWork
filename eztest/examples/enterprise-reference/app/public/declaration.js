/* The claim declaration, shown in an iframe of the claim form; tells the parent page when it is confirmed. */
(() => {
  const box = document.getElementById('declare');
  const btn = document.getElementById('confirm-declaration');
  const state = document.getElementById('declaration-state');
  box.addEventListener('change', () => {
    btn.disabled = !box.checked;
  });
  btn.addEventListener('click', () => {
    parent.postMessage({ type: 'larkspur-declaration', accepted: true }, location.origin);
    state.textContent = 'Declaration confirmed.';
    btn.disabled = true;
    box.disabled = true;
  });
})();
