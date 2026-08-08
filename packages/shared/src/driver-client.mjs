// Page-side driver toolkit (runs in the browser page, installed on
// `globalThis.__x`): the shadow-piercing composed-DOM walk, arm/until/settle
// measurement primitives, and the FCP probe.
//
// Lineage: vue-lynx `packages/benchmark` cross-framework harness → octane PR
// `benchmarks/lynx-table/web/driver-client.mjs`. Every framework entry is
// measured by this byte-identical instrument; do not fork the predicates for
// one framework — that breaks the comparison. This repo is now the canonical
// home of the driver.

export const DRIVER_CLIENT_JS = `(() => {
  const x = (globalThis.__x = {});

  // -- composed-tree walk (pierces shadow roots) -----------------------------
  const classOf = (el) => (el.getAttribute && el.getAttribute('class')) || '';
  const hasClass = (el, cls) => classOf(el).split(/\\s+/).includes(cls);

  const findByClass = (cls) => {
    const out = [];
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 1) {
        if (hasClass(node, cls)) out.push(node);
        if (node.shadowRoot) walk(node.shadowRoot);
      }
      for (const child of node.childNodes || []) walk(child);
    };
    walk(document.body);
    return out;
  };
  x.findByClass = findByClass;

  x.findText = (needle) => {
    const walk = (node) => {
      if (!node) return false;
      if (node.nodeType === 3 && node.textContent.includes(needle)) return true;
      if (node.shadowRoot && walk(node.shadowRoot)) return true;
      for (const child of node.childNodes || []) if (walk(child)) return true;
      return false;
    };
    return walk(document.body);
  };

  // -- lynx-view attach ------------------------------------------------------
  x.createView = (bundleUrl, w = 800, h = 640) => {
    const view = document.createElement('lynx-view');
    view.setAttribute('url', bundleUrl);
    view.style.cssText = 'display:block;width:' + w + 'px;height:' + h + 'px;';
    x.viewAttachTime = performance.now();
    document.body.appendChild(view);
    return true;
  };

  // -- content count: workload-agnostic FCP signal ---------------------------
  const CONTENT_CLASSES = ['row', 'card', 'card-title', 'feed-title', 'col-label'];
  x.contentCount = () => {
    let n = 0;
    for (const cls of CONTENT_CLASSES) n += findByClass(cls).length;
    return n;
  };

  // -- table predicates ------------------------------------------------------
  let rowsEl = null;
  const rows = () => {
    if (!rowsEl || !rowsEl.isConnected) rowsEl = findByClass('rows')[0] ?? null;
    return rowsEl;
  };
  const rowEls = () => {
    const container = rows();
    if (!container) return [];
    const out = [];
    // Element Templates mount keyed content into layout-transparent <wrapper>
    // placeholders — rows are then grandchildren of the container. Descend
    // through wrapper tags only, so per-frame polling stays a shallow walk.
    const walk = (parent) => {
      for (const child of parent.children) {
        if (hasClass(child, 'row')) out.push(child);
        else if (/wrapper/i.test(child.tagName || '')) walk(child);
      }
    };
    walk(container);
    return out;
  };
  x.rowCount = () => (rows() ? rowEls().length : -1);
  const cellOf = (rowEl, cls) => {
    for (const child of rowEl.children) if (hasClass(child, cls)) return child;
    return null;
  };
  x.labelAt = (i) => {
    const r = rowEls()[i];
    return r ? cellOf(r, 'col-label')?.textContent ?? null : null;
  };
  x.idAt = (i) => {
    const r = rowEls()[i];
    return r ? cellOf(r, 'col-id')?.textContent ?? null : null;
  };
  x.dangerAt = (i) => {
    const r = rowEls()[i];
    return r ? hasClass(r, 'danger') : false;
  };

  // -- click geometry --------------------------------------------------------
  x.buttonRect = (label) => {
    for (const el of findByClass('btn-text')) {
      if (el.textContent === label) {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
    }
    return null;
  };
  x.cellRect = (rowIndex, cls) => {
    const r = rowEls()[rowIndex];
    const cell = r && cellOf(r, cls);
    if (!cell) return null;
    const rect = cell.getBoundingClientRect();
    return { x: rect.x + Math.min(20, rect.width / 2), y: rect.y + rect.height / 2 };
  };

  // -- predicates ------------------------------------------------------------
  const checkPredicate = (spec) => {
    switch (spec.type) {
      case 'rowCount': return x.rowCount() === spec.value;
      case 'labelAt': return x.labelAt(spec.index) === spec.equals;
      case 'idAt': return x.idAt(spec.index) === spec.equals;
      case 'labelAtStartsWith': return (x.labelAt(spec.index) ?? '').startsWith(spec.prefix);
      case 'dangerAt': return x.dangerAt(spec.index);
      case 'contentAtLeast': return x.contentCount() >= spec.value;
      default: throw new Error('unknown predicate ' + spec.type);
    }
  };

  // -- measurement primitives ------------------------------------------------
  x.arm = (spec, timeoutMs) =>
    new Promise((resolve, reject) => {
      let t0 = null;
      const onDown = () => { t0 = performance.now(); };
      window.addEventListener('pointerdown', onDown, { capture: true, once: true });
      const deadline = performance.now() + (timeoutMs ?? 120000);
      const tick = () => {
        if (t0 != null && checkPredicate(spec)) { resolve({ ms: performance.now() - t0 }); return; }
        if (performance.now() > deadline) {
          window.removeEventListener('pointerdown', onDown, { capture: true });
          reject(new Error('predicate timeout: ' + JSON.stringify(spec) + ' rowCount=' + x.rowCount()));
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

  x.until = (spec, timeoutMs = 120000) =>
    new Promise((resolve, reject) => {
      const deadline = performance.now() + timeoutMs;
      const tick = () => {
        if (checkPredicate(spec)) return resolve(true);
        if (performance.now() > deadline) return reject(new Error('until timeout: ' + JSON.stringify(spec)));
        requestAnimationFrame(tick);
      };
      tick();
    });

  x.settle = (extraMs = 30) =>
    new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, extraMs))));

  // -- FCP + settled ---------------------------------------------------------
  // From viewAttachTime, poll the composed tree per animation frame. FCP =
  // first frame with contentCount >= minContent; settled = content count then
  // stable for idleMs. Hard timeout aborts as DNF.
  x.fcp = (opts = {}) => {
    const minContent = opts.minContent ?? 5;
    const readyText = opts.readyText ?? null; // when set, FCP = first frame with this text (for zero-content boots)
    const idleMs = opts.idleMs ?? 400;
    const timeoutMs = opts.timeoutMs ?? 120000;
    return new Promise((resolve) => {
      const t0 = x.viewAttachTime ?? performance.now();
      const deadline = performance.now() + timeoutMs;
      let fcp = null;
      let lastCount = -1;
      let lastChange = performance.now();
      const tick = () => {
        const now = performance.now();
        const c = x.contentCount();
        if (fcp == null && (readyText ? x.findText(readyText) : c >= minContent)) { fcp = now - t0; }
        if (c !== lastCount) { lastCount = c; lastChange = now; }
        if (fcp != null && now - lastChange >= idleMs) {
          resolve({ fcp, settled: Math.max(fcp, lastChange - t0), finalCount: c, dnf: false });
          return;
        }
        if (now > deadline) {
          resolve({ fcp, settled: null, finalCount: c, dnf: true });
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  };
})()`;
