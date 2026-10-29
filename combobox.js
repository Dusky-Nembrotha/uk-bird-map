/* A small type-ahead picker, shared by the map and the studio.

   Both pages had the same problem from opposite ends: the studio used a
   native <select> holding every species, which on a phone is a 400-row wheel,
   and the map's search filtered a list you still had to reach for with the
   mouse. This gives both a single behaviour - type to narrow, arrow keys to
   move, Enter to choose - without pulling in a library.

   Matching is deliberately forgiving: it scores a word-start hit above a
   mid-word one, so typing "red" offers Redwing and Redshank before
   Red-breasted Merganser, and a scientific name works as well as an English
   one. */

'use strict';

function makeCombobox(cfg) {
  const { input, listEl, getItems, onSelect } = cfg;
  const clearBtn = cfg.clearBtn || null;
  /* What the ✕ can clear may not be in the box at all: a multi-select keeps
     its picks in chips, and a caller may own a wider filter (the studio's
     group dropdown) that the ✕ should reset too. Without this the button
     hid itself precisely when the box looked empty but a filter was still
     in force - which is the one time you most need it. */
  const hasExtra = cfg.hasExtra || (() => false);
  const maxShown = cfg.maxShown || 60;
  const emptyLabel = cfg.emptyLabel || 'No species match that.';

  const multi = !!cfg.multi;
  const chipsEl = cfg.chipsEl || null;
  const photoUrl = cfg.photoUrl || ((u) => u);
  let selected = [];          // multi-select only
  let filtered = [];
  let active = -1;
  let open = false;

  const norm = (s) => (s || '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '');

  function score(item, q) {
    const label = norm(item.label);
    const sub = norm(item.sub);
    if (!q) return 1;
    if (label === q) return 1000;
    if (label.startsWith(q)) return 500 - label.length;
    // A hit at the start of any word beats one buried inside a word.
    const wordStart = new RegExp(`(^|[\\s\\-'])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    if (wordStart.test(label)) return 300 - label.length;
    if (label.includes(q)) return 150 - label.length;
    if (sub.startsWith(q)) return 120;
    if (sub.includes(q)) return 80;
    return 0;
  }

  function render() {
    const q = norm(input.value.trim());
    const items = getItems() || [];
    filtered = items
      .map((it) => ({ it, s: score(it, q) }))
      .filter((r) => r.s > 0)
      /* Match quality first - typing "red" must still put Redwing at the top -
         then how much the bird is on the move, then sheer volume. With an
         empty box every score is equal, so the list opens on whatever is
         actually moving rather than on whatever is merely numerous. */
      .sort((a, b) => b.s - a.s
        || (b.it.move || 0) - (a.it.move || 0)
        || (b.it.count || 0) - (a.it.count || 0))
      .slice(0, maxShown)
      .map((r) => r.it);

    listEl.innerHTML = '';
    if (!filtered.length) {
      const li = document.createElement('li');
      li.className = 'combo-empty';
      li.textContent = emptyLabel;
      listEl.appendChild(li);
    }
    filtered.forEach((it, i) => {
      const li = document.createElement('li');
      const chosen = multi && selected.some((sel) => sel.value === it.value);
      li.className = 'combo-item' + (i === active ? ' active' : '')
        + (chosen ? ' chosen' : '');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === active));
      li.innerHTML =
        (it.thumb ? `<img class="combo-thumb" src="${it.thumb}" alt="" loading="lazy">`
                  : '<span class="combo-thumb empty"></span>')
        + '<span class="combo-text">'
        + `<span class="combo-label">${escapeHtml(it.label)}</span>`
        + '<span class="combo-meta">'
        + (it.sub ? `<span class="combo-sub">${escapeHtml(it.sub)}</span>` : '')
        + (it.moveLabel
            ? `<span class="combo-move ${it.moveDir}">${it.moveLabel}</span>` : '')
        + '</span></span>'
        + (it.count != null ? `<span class="combo-count">${it.count.toLocaleString('en-GB')}</span>` : '');
      li.addEventListener('mousedown', (e) => {   // before blur
        e.preventDefault();
        choose(i);
      });
      listEl.appendChild(li);
    });
    syncClear();
  }

  function syncClear() {
    if (!clearBtn) return;
    clearBtn.hidden = !(input.value || selected.length || hasExtra());
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function setOpen(v) {
    open = v;
    listEl.hidden = !v;
    input.setAttribute('aria-expanded', String(v));
    if (!v) active = -1;
  }

  function choose(i) {
    const it = filtered[i];
    if (!it) return;
    if (multi) {
      // Picking something already chosen removes it, so the list doubles as
      // the way to deselect.
      const at = selected.findIndex((s) => s.value === it.value);
      if (at >= 0) selected.splice(at, 1); else selected.push(it);
      input.value = '';
      renderChips();
      setOpen(false);
      onSelect(selected.slice());
      return;
    }
    input.value = it.label;
    setOpen(false);
    syncClear();
    onSelect(it);
  }

  function renderChips() {
    if (!chipsEl) return;
    chipsEl.innerHTML = '';
    chipsEl.hidden = !selected.length;
    for (const it of selected) {
      const chip = document.createElement('span');
      chip.className = 'sp-chip';
      chip.innerHTML =
        (it.thumb ? `<img src="${photoUrl(it.thumb)}" alt="">`
                  : '<span class="sp-chip-dot"></span>')
        + `<span>${escapeHtml(it.label)}</span>`
        + '<button type="button" aria-label="Remove">✕</button>';
      chip.querySelector('button').addEventListener('click', () => {
        selected = selected.filter((s) => s.value !== it.value);
        renderChips();
        onSelect(selected.slice());
      });
      chipsEl.appendChild(chip);
    }
    input.placeholder = selected.length
      ? 'Add another species…' : (cfg.placeholder || input.placeholder);
    syncClear();
  }

  function scrollActiveIntoView() {
    const el = listEl.children[active];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  input.addEventListener('input', () => { active = -1; render(); setOpen(true); });
  input.addEventListener('focus', () => { render(); setOpen(true); });
  input.addEventListener('blur', () => setTimeout(() => setOpen(false), 120));

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { render(); setOpen(true); }
      if (!filtered.length) return;
      active += e.key === 'ArrowDown' ? 1 : -1;
      if (active < 0) active = filtered.length - 1;
      if (active >= filtered.length) active = 0;
      render();
      scrollActiveIntoView();
    } else if (e.key === 'Enter') {
      if (open && filtered.length) {
        e.preventDefault();
        choose(active >= 0 ? active : 0);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      input.blur();
    }
  });

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      input.value = '';
      // A multi-select's picks live in `selected`, so clearing only the text
      // left every chip standing - and handed onSelect a null that the
      // list-expecting callers could not read.
      selected = [];
      renderChips();
      setOpen(false);
      if (cfg.onClear) cfg.onClear();
      else onSelect(multi ? [] : null);
      syncClear();
    });
  }

  // If the field already has focus when the component is built - autofocus,
  // or a rebuild while the user is mid-type - show the list straight away.
  if (document.activeElement === input) { render(); setOpen(true); }

  return {
    refresh: render,
    setValue(label) {
      input.value = label || '';
      syncClear();
    },
    getSelection: () => selected.slice(),
    setSelection(values) {
      const want = new Set(values || []);
      selected = (getItems() || []).filter((it) => want.has(it.value));
      input.value = '';
      renderChips();
    },
    close: () => setOpen(false),
  };
}
