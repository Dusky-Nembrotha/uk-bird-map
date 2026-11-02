/* Registers the service worker and offers the install prompt.

   Loaded by all three pages. Everything it adds to the document is created
   here rather than in the stylesheets, so the three views - which have quite
   different CSS - do not each need a copy.

   The button appears only when the browser says the app is installable, and
   takes itself away once it is installed or after a few seconds of being
   ignored. Chrome on Android otherwise buries "Install app" in a menu, which
   on a phone is where features go to die. */
(() => {
  if (!('serviceWorker' in navigator)) return;

  const base = new URL('.', document.baseURI);

  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register(new URL('sw.js', base), { scope: base.pathname });
      /* The site is force-pushed on every deploy, so a tab left open overnight
         can be holding a shell that no longer exists. Take the new worker as
         soon as it is ready, and reload once - guarded, because a reload loop
         here would be unbreakable without clearing site data. */
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            sw.postMessage('skip-waiting');
          }
        });
      });
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return;
        reloaded = true;
        location.reload();
      });
    } catch (err) {
      console.warn('Service worker did not register:', err);
    }
  });

  let deferred = null;
  let btn = null;

  function dismiss() {
    if (!btn) return;
    btn.remove();
    btn = null;
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    // Keep the event: the prompt can only be shown from a user gesture.
    e.preventDefault();
    deferred = e;
    if (btn || sessionStorage.getItem('install-dismissed')) return;

    btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Install UK Bird Map as an app');
    btn.addEventListener('click', async () => {
      const p = deferred;
      dismiss();
      if (!p) return;
      p.prompt();
      try { await p.userChoice; } catch (err) { /* dismissed */ }
      deferred = null;
    });

    /* Mounted into the page's own controls where it has somewhere to live,
       and only floated over the map where it has not.

       It used to float on every page, which put a lime pill in the top right
       corner of all three - over the migration view's header, and over
       whatever each layout keeps in that corner. A button that covers a
       control is worse than one that is slightly harder to find. */
    const slot = document.getElementById('install-slot');
    if (slot) {
      btn.textContent = slot.dataset.installLabel || 'Install';
      if (slot.dataset.installClass) btn.className = slot.dataset.installClass;
      btn.title = 'Install as an app';
      slot.appendChild(btn);
      // Left in place: sitting in the controls, it is covering nothing, so
      // there is nothing to time out.
      return;
    }

    btn.textContent = 'Install';
    Object.assign(btn.style, {
      position: 'fixed',
      right: 'calc(12px + env(safe-area-inset-right))',
      bottom: 'calc(12px + env(safe-area-inset-bottom))',
      zIndex: '2147483000',
      font: '600 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif',
      color: '#07090c',
      background: '#a9e34b',
      border: '0',
      borderRadius: '999px',
      padding: '9px 14px',
      boxShadow: '0 2px 14px rgba(0, 0, 0, .45)',
      cursor: 'pointer',
    });
    document.body.appendChild(btn);
    // Floating, it is over the map, so it takes itself away.
    setTimeout(() => {
      if (!btn) return;
      sessionStorage.setItem('install-dismissed', '1');
      dismiss();
    }, 12000);
  });

  window.addEventListener('appinstalled', () => { deferred = null; dismiss(); });
})();
