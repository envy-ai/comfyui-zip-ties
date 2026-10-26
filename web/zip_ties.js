import { app } from "../../scripts/app.js";

// Zip ties: hold Z and drag across wires to bundle them into a ribbon.
// Drag a tie to move it, Shift-drag to rotate it, right-click it for colours.
// Z-drag across a tie, or double-click it, to cut it.

const EXTRA_KEY = "zipTies";
const DIR = { NONE: 0, UP: 1, DOWN: 2, LEFT: 3, RIGHT: 4, CENTER: 5 };
const MARKER_NONE = 0;
const CONTROL_FACTOR = 0.25;
const SAMPLES = 32;
const BAR_HALF_WIDTH = 2.5;
const BAR_PAD = 3;
const HEAD_HALF_WIDTH = 4;
const HEAD_LENGTH = 6;
const HIT_PAD_PX = 6;
const DOUBLE_CLICK_MS = 350;
const SNAP = Math.PI / 12; // 15°

const GREY = "#8c8c94";
const WIRES = "wires"; // tie.color value: take the colour of the wires it holds
const PALETTE = [
  ["Red", "#e5484d"],
  ["Orange", "#f76b15"],
  ["Yellow", "#ffc53d"],
  ["Green", "#46a758"],
  ["Teal", "#12a594"],
  ["Blue", "#3e63dd"],
  ["Purple", "#8e4ec6"],
  ["Pink", "#d6409f"],
  ["White", "#ededed"],
  ["Black", "#232326"],
];
const COLOR_SETTING = "ZipTies.NewTieColor";
const COLOR_MODE = { RANDOM: "Random", WIRES: "Match wires", GREY: "Grey" };

const state = {
  zHeld: false,
  pointerDown: false,
  hovered: null, // tie id
  drag: null, // { tie, dx, dy, pointerId, moved, rotate, offset }
  cut: null, // { start, end, pointerId }
  lastDown: { id: null, time: 0 },
  rendering: false,
  endpoints: new Map(), // link id -> { a, b, sd, ed } captured from the last frame
  linkColors: new Map(), // link id -> colour the wire was drawn in last frame
  index: new Map(), // link id -> ties[]
  sigs: new Map(), // tied link id -> "origin:slot>target:slot", to follow a wire that is reconnected
  nodePos: new Map(), // node id -> [x, y] last frame, for nodes on tied wires
  nodePosFor: null, // the ties array nodePos was recorded against
  overlay: null,
};

function setting(id, fallback) {
  try {
    return app.extensionManager?.setting?.get?.(id) ?? app.ui?.settings?.getSettingValue?.(id) ?? fallback;
  } catch {
    return fallback;
  }
}

// ---------- data ----------

function tiesOf(graph, create = false) {
  if (!graph) return [];
  graph.extra ??= {};
  let ties = graph.extra[EXTRA_KEY];
  if (!Array.isArray(ties)) {
    if (!create) return [];
    ties = graph.extra[EXTRA_KEY] = [];
  }
  return ties;
}

function getLink(graph, id) {
  return graph.getLink?.(id) ?? (graph.links instanceof Map ? graph.links.get(id) : graph.links?.[id]);
}

function allLinks(graph) {
  const links = graph.links;
  if (!links) return [];
  return links instanceof Map ? [...links.values()] : Object.values(links);
}

function linkSig(link) {
  return `${link.origin_id}:${link.origin_slot}>${link.target_id}:${link.target_slot}`;
}

function nextTieId(ties) {
  let id = 1;
  for (const t of ties) id = Math.max(id, t.id + 1);
  return id;
}

function newTieColor(ties) {
  const mode = setting(COLOR_SETTING, COLOR_MODE.RANDOM);
  if (mode === COLOR_MODE.WIRES) return WIRES;
  if (mode === COLOR_MODE.GREY) return undefined;
  const last = ties.at(-1)?.color;
  // Black disappears on the dark canvas, so random picks skip it; it stays in the tie menu.
  const pool = PALETTE.filter(([name, c]) => name !== "Black" && c !== last);
  return pool[Math.floor(Math.random() * pool.length)][1];
}

/**
 * Drops link ids that no longer exist or now pass through reroutes, removes empty ties, rebuilds the index.
 * A wire reconnected between the same two slots gets a new link id; it keeps its place in the ribbon.
 * While a pointer is down, missing wires are kept, since a wire being dragged may be on its way back.
 */
function syncTies(graph) {
  state.index.clear();
  const ties = tiesOf(graph);
  if (!ties.length) {
    state.sigs.clear();
    return;
  }
  let bySig = null;
  for (let i = ties.length - 1; i >= 0; i--) {
    const tie = ties[i];
    const kept = [];
    for (const id of tie.links) {
      const link = getLink(graph, id);
      if (link) {
        if (link.parentId == null) kept.push(id);
        continue;
      }
      const sig = state.sigs.get(id);
      if (sig) {
        bySig ??= new Map(allLinks(graph).map((l) => [linkSig(l), l]));
        const twin = bySig.get(sig);
        if (twin && twin.parentId == null && !tie.links.includes(twin.id) && !kept.includes(twin.id)) {
          kept.push(twin.id);
          continue;
        }
      }
      if (state.pointerDown) kept.push(id);
    }
    tie.links = kept;
    if (!kept.length) ties.splice(i, 1);
  }
  const sigs = new Map();
  for (const tie of ties) {
    for (const id of tie.links) {
      const link = getLink(graph, id);
      const sig = link ? linkSig(link) : state.sigs.get(id);
      if (sig) sigs.set(id, sig);
      if (!link) continue;
      let list = state.index.get(id);
      if (!list) state.index.set(id, (list = []));
      list.push(tie);
    }
  }
  state.sigs = sigs;
  if (!ties.length) delete graph.extra[EXTRA_KEY];
}

function endpointNode(graph, id) {
  return graph.getNodeById?.(id) ?? (id === -10 ? graph.inputNode : id === -20 ? graph.outputNode : null);
}

/** Moves a tie with its wires when every node on those wires moved by the same amount since the last frame. */
function followNodes(graph, ties) {
  if (state.nodePosFor !== ties) {
    // A loaded, undone or replaced tie list: positions from before are not comparable.
    state.nodePosFor = ties;
    state.nodePos.clear();
  }
  const current = new Map();
  const posOf = (id) => {
    if (!current.has(id)) {
      const pos = endpointNode(graph, id)?.pos;
      current.set(id, pos ? [pos[0], pos[1]] : null);
    }
    return current.get(id);
  };
  for (const tie of ties) {
    let delta = null;
    let follow = tie !== state.drag?.tie;
    for (const id of tie.links) {
      const link = getLink(graph, id);
      if (!link) continue;
      for (const nid of [link.origin_id, link.target_id]) {
        const now = posOf(nid);
        const before = state.nodePos.get(nid);
        if (!now || !before) {
          follow = false;
          continue;
        }
        const d = [now[0] - before[0], now[1] - before[1]];
        if (!delta) delta = d;
        else if (Math.abs(d[0] - delta[0]) > 0.01 || Math.abs(d[1] - delta[1]) > 0.01) follow = false;
      }
    }
    if (follow && delta && (delta[0] || delta[1])) tie.pos = [tie.pos[0] + delta[0], tie.pos[1] + delta[1]];
  }
  state.nodePos = current;
}

function commit(canvas) {
  canvas.setDirty(true, true);
  const ct = app.extensionManager?.workflow?.activeWorkflow?.changeTracker;
  const capture = ct?.captureCanvasState ?? ct?.checkState;
  if (capture) capture.call(ct);
  else window.dispatchEvent(new MouseEvent("mouseup"));
}

// ---------- geometry ----------

function spacing(canvas) {
  return (canvas.connections_width ?? 3) + 1.5;
}

function tieAxes(tie) {
  const c = Math.cos(tie.angle ?? 0);
  const s = Math.sin(tie.angle ?? 0);
  return { t: [c, s], n: [-s, c] };
}

function tieHalfLength(canvas, tie) {
  return ((tie.links.length - 1) * spacing(canvas)) / 2 + BAR_PAD;
}

function strandPoint(canvas, tie, linkId) {
  const i = tie.links.indexOf(linkId);
  const off = (i - (tie.links.length - 1) / 2) * spacing(canvas);
  const { n } = tieAxes(tie);
  return [tie.pos[0] + n[0] * off, tie.pos[1] + n[1] * off];
}

/** Ties on this link, ordered from output to input. */
function orderedTies(linkId, a, b) {
  const list = state.index.get(linkId);
  if (!list?.length) return [];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return list.toSorted(
    (p, q) => (p.pos[0] - a[0]) * dx + (p.pos[1] - a[1]) * dy - ((q.pos[0] - a[0]) * dx + (q.pos[1] - a[1]) * dy),
  );
}

/** Segments the link is drawn as, in renderLink terms. */
function route(canvas, linkId, a, b, sd, ed) {
  const ties = orderedTies(linkId, a, b);
  if (!ties.length) return [{ a, b, sd, ed }];
  const pts = ties.map((t) => ({ p: strandPoint(canvas, t, linkId), dir: tieAxes(t).t }));
  const segs = [];
  let prev = { p: a, dir: null };
  for (const cur of [...pts, { p: b, dir: null }]) {
    const dist = Math.hypot(cur.p[0] - prev.p[0], cur.p[1] - prev.p[1]) * CONTROL_FACTOR;
    const seg = { a: prev.p, b: cur.p, sd: prev.dir ? DIR.CENTER : sd, ed: cur.dir ? DIR.CENTER : ed };
    if (prev.dir) seg.startControl = [prev.dir[0] * dist, prev.dir[1] * dist];
    if (cur.dir) seg.endControl = [-cur.dir[0] * dist, -cur.dir[1] * dist];
    segs.push(seg);
    prev = cur;
  }
  return segs;
}

function offsetByDir(p, dir, d) {
  switch (dir) {
    case DIR.LEFT: return [p[0] - d, p[1]];
    case DIR.RIGHT: return [p[0] + d, p[1]];
    case DIR.UP: return [p[0], p[1] - d];
    case DIR.DOWN: return [p[0], p[1] + d];
    default: return [p[0], p[1]];
  }
}

/** Polyline of one segment, matching the spline the link adapter draws. */
function segmentPolyline(canvas, seg) {
  const { a, b } = seg;
  if (canvas.links_render_mode !== undefined && canvas.links_render_mode !== 2) {
    // LINEAR (1) and STRAIGHT (0) links: a polyline through the endpoints is close enough for hit tests.
    return [a, b];
  }
  const dist = Math.hypot(b[0] - a[0], b[1] - a[1]) * CONTROL_FACTOR;
  const c0 = seg.startControl ? [a[0] + seg.startControl[0], a[1] + seg.startControl[1]] : offsetByDir(a, seg.sd || DIR.RIGHT, dist);
  const c1 = seg.endControl ? [b[0] + seg.endControl[0], b[1] + seg.endControl[1]] : offsetByDir(b, seg.ed || DIR.LEFT, dist);
  const out = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const u = 1 - t;
    const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    out.push([w0 * a[0] + w1 * c0[0] + w2 * c1[0] + w3 * b[0], w0 * a[1] + w1 * c0[1] + w2 * c1[1] + w3 * b[1]]);
  }
  return out;
}

/** Intersection parameter (along p→q) of segments p→q and r→s, or null. */
function intersect(p, q, r, s) {
  const d1x = q[0] - p[0], d1y = q[1] - p[1];
  const d2x = s[0] - r[0], d2y = s[1] - r[1];
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return null;
  const ex = r[0] - p[0], ey = r[1] - p[1];
  const t = (ex * d2y - ey * d2x) / den;
  const u = (ex * d1y - ey * d1x) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

function tieBar(canvas, tie) {
  const h = tieHalfLength(canvas, tie);
  const { n } = tieAxes(tie);
  return [
    [tie.pos[0] - n[0] * h, tie.pos[1] - n[1] * h],
    [tie.pos[0] + n[0] * h, tie.pos[1] + n[1] * h],
  ];
}

function tieAt(canvas, graph, p) {
  const pad = HIT_PAD_PX / canvas.ds.scale;
  const ties = tiesOf(graph);
  for (let i = ties.length - 1; i >= 0; i--) {
    const tie = ties[i];
    const { t, n } = tieAxes(tie);
    const dx = p[0] - tie.pos[0], dy = p[1] - tie.pos[1];
    const along = dx * t[0] + dy * t[1];
    const across = dx * n[0] + dy * n[1];
    if (Math.abs(along) <= BAR_HALF_WIDTH + pad && Math.abs(across) <= tieHalfLength(canvas, tie) + pad) return tie;
  }
  return null;
}

// ---------- cutting ----------

function applyCut(canvas, graph, p, q) {
  if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 4 / canvas.ds.scale) return;
  const ties = tiesOf(graph);

  // Cutting across an existing tie removes it.
  const cutTies = ties.filter((tie) => {
    const [r, s] = tieBar(canvas, tie);
    return intersect(p, q, r, s) !== null;
  });
  if (cutTies.length) {
    graph.extra[EXTRA_KEY] = ties.filter((t) => !cutTies.includes(t));
    syncTies(graph);
    commit(canvas);
    return;
  }

  // Otherwise tie every visible wire the line crosses.
  const hits = [];
  for (const link of allLinks(graph)) {
    if (link.parentId != null) continue;
    const ep = state.endpoints.get(link.id);
    if (!ep) continue;
    let best = null;
    for (const seg of route(canvas, link.id, ep.a, ep.b, ep.sd, ep.ed)) {
      const poly = segmentPolyline(canvas, seg);
      for (let i = 1; i < poly.length; i++) {
        const t = intersect(p, q, poly[i - 1], poly[i]);
        if (t === null || (best && t >= best.t)) continue;
        const dx = poly[i][0] - poly[i - 1][0], dy = poly[i][1] - poly[i - 1][1];
        const len = Math.hypot(dx, dy) || 1;
        best = { t, link, tangent: [dx / len, dy / len] };
      }
    }
    if (best) hits.push(best);
  }
  if (!hits.length) return;

  const point = (h) => [p[0] + (q[0] - p[0]) * h.t, p[1] + (q[1] - p[1]) * h.t];
  let tx = 0, ty = 0, cx = 0, cy = 0;
  for (const h of hits) {
    tx += h.tangent[0];
    ty += h.tangent[1];
    const pt = point(h);
    cx += pt[0];
    cy += pt[1];
  }
  const angle = Math.hypot(tx, ty) > 1e-6 ? Math.atan2(ty, tx) : 0;
  const n = [-Math.sin(angle), Math.cos(angle)];
  const pos = [cx / hits.length, cy / hits.length];
  hits.sort((h1, h2) => {
    const a = point(h1), b = point(h2);
    return (a[0] - b[0]) * n[0] + (a[1] - b[1]) * n[1];
  });

  // Keep the ribbon straight between ties: if an existing tie holds every new wire,
  // reuse its strand order so the wires cross outside the bundle, not inside it.
  const ids = hits.map((h) => h.link.id);
  const twin = tiesOf(graph).find((t) => ids.every((id) => t.links.includes(id)));
  if (twin) hits.sort((h1, h2) => twin.links.indexOf(h1.link.id) - twin.links.indexOf(h2.link.id));

  const all = tiesOf(graph, true);
  const tie = { id: nextTieId(all), pos, angle, links: hits.map((h) => h.link.id) };
  const color = newTieColor(all);
  if (color) tie.color = color;
  all.push(tie);
  syncTies(graph);
  commit(canvas);
}

// ---------- tie menu ----------

function removeTie(canvas, graph, tie) {
  graph.extra[EXTRA_KEY] = tiesOf(graph).filter((t) => t !== tie);
  syncTies(graph);
  state.hovered = null;
  commit(canvas);
}

/** Litegraph's menu sanitises inline styles in item HTML, so swatches are added to the DOM after it opens. */
function addSwatches() {
  const colors = new Map([...PALETTE, ["Grey", GREY]]);
  for (const entry of document.querySelectorAll(".litecontextmenu .litemenu-entry")) {
    const color = colors.get(entry.textContent);
    if (!color || entry.dataset.zipTieSwatch) continue;
    entry.dataset.zipTieSwatch = "1";
    const dot = document.createElement("span");
    Object.assign(dot.style, {
      display: "inline-block",
      width: "10px",
      height: "10px",
      marginRight: "8px",
      borderRadius: "2px",
      verticalAlign: "-1px",
      background: color,
      boxShadow: "0 0 0 1px rgba(255,255,255,0.3)",
    });
    entry.prepend(dot);
  }
}

function showTieMenu(canvas, graph, tie, event) {
  const ContextMenu = window.LiteGraph?.ContextMenu;
  if (!ContextMenu) return;
  const recolor = (color) => () => {
    if (color) tie.color = color;
    else delete tie.color;
    commit(canvas);
  };
  const rotate = (by) => () => {
    tie.angle = (tie.angle ?? 0) + by;
    commit(canvas);
  };
  const colors = [
    ...PALETTE.map(([name, c]) => ({ content: name, callback: recolor(c) })),
    null,
    { content: "Match wires", callback: recolor(WIRES) },
    { content: "Grey", callback: recolor(undefined) },
  ];
  new ContextMenu(
    [
      { content: "Colour", has_submenu: true, submenu: { options: colors }, callback: () => void requestAnimationFrame(addSwatches) },
      { content: "Rotate 90°", callback: rotate(Math.PI / 2) },
      { content: "Rotate 45°", callback: rotate(Math.PI / 4) },
      null,
      { content: "Remove tie", callback: () => removeTie(canvas, graph, tie) },
    ],
    { event, title: "Zip tie" },
  );
}

// ---------- overlay for the cut line ----------

function overlay() {
  if (state.overlay) return state.overlay;
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999;display:none";
  const line = document.createElementNS(svgNS, "line");
  line.setAttribute("stroke", "#ff3b3b");
  line.setAttribute("stroke-width", "2");
  line.setAttribute("stroke-linecap", "round");
  svg.appendChild(line);
  document.body.appendChild(svg);
  state.overlay = { svg, line };
  return state.overlay;
}

function showCutLine(x1, y1, x2, y2) {
  const { svg, line } = overlay();
  line.setAttribute("x1", x1);
  line.setAttribute("y1", y1);
  line.setAttribute("x2", x2);
  line.setAttribute("y2", y2);
  svg.style.display = "block";
}

function hideCutLine() {
  if (state.overlay) state.overlay.svg.style.display = "none";
}

// ---------- input ----------

function graphPoint(canvas, e) {
  const rect = canvas.canvas.getBoundingClientRect();
  return canvas.ds.convertCanvasToOffset([e.clientX - rect.left, e.clientY - rect.top]);
}

function isTyping(e) {
  const el = e.target;
  return el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

function setHovered(canvas, id) {
  if (state.hovered === id) return;
  state.hovered = id;
  canvas.setDirty(true, true);
}

function pointerAngle(tie, p) {
  return Math.atan2(p[1] - tie.pos[1], p[0] - tie.pos[0]);
}

function installInput(canvas) {
  const el = canvas.canvas;

  window.addEventListener("keydown", (e) => {
    if (e.code === "KeyZ" && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e)) state.zHeld = true;
  }, true);
  window.addEventListener("keyup", (e) => {
    if (e.code === "KeyZ") state.zHeld = false;
  }, true);
  window.addEventListener("blur", () => {
    state.zHeld = false;
    state.pointerDown = false;
  });

  // Right-click on a tie opens its menu instead of the canvas menu.
  const tieUnder = (e) => e.target === el && canvas.graph && tieAt(canvas, canvas.graph, graphPoint(canvas, e));
  window.addEventListener("contextmenu", (e) => {
    if (!tieUnder(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  window.addEventListener("pointerdown", (e) => {
    state.pointerDown = true;
    if (e.target !== el || !canvas.graph) return;
    const graph = canvas.graph;
    const p = graphPoint(canvas, e);

    if (e.button === 2) {
      const tie = tieAt(canvas, graph, p);
      if (!tie) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      showTieMenu(canvas, graph, tie, e);
      return;
    }
    if (e.button !== 0) return;

    if (state.zHeld) {
      e.preventDefault();
      e.stopImmediatePropagation();
      state.cut = { start: p, client: [e.clientX, e.clientY], pointerId: e.pointerId };
      showCutLine(e.clientX, e.clientY, e.clientX, e.clientY);
      return;
    }

    const tie = tieAt(canvas, graph, p);
    if (!tie) return;
    e.preventDefault();
    e.stopImmediatePropagation();

    const now = performance.now();
    if (state.lastDown.id === tie.id && now - state.lastDown.time < DOUBLE_CLICK_MS) {
      state.lastDown = { id: null, time: 0 };
      removeTie(canvas, graph, tie);
      return;
    }
    state.lastDown = { id: tie.id, time: now };
    state.drag = {
      tie,
      dx: tie.pos[0] - p[0],
      dy: tie.pos[1] - p[1],
      pointerId: e.pointerId,
      moved: false,
      rotate: e.shiftKey,
      offset: (tie.angle ?? 0) - pointerAngle(tie, p),
    };
    el.style.cursor = "grabbing";
  }, true);

  window.addEventListener("pointermove", (e) => {
    if (state.cut && e.pointerId === state.cut.pointerId) {
      e.stopImmediatePropagation();
      showCutLine(state.cut.client[0], state.cut.client[1], e.clientX, e.clientY);
      return;
    }
    if (state.drag && e.pointerId === state.drag.pointerId) {
      e.stopImmediatePropagation();
      const { drag } = state;
      const p = graphPoint(canvas, e);
      if (drag.rotate) {
        // Shift-drag rotates about the tie centre, in 15° steps unless Alt is held too.
        let angle = pointerAngle(drag.tie, p) + drag.offset;
        if (!e.altKey) angle = Math.round(angle / SNAP) * SNAP;
        drag.tie.angle = angle;
      } else {
        drag.tie.pos = [p[0] + drag.dx, p[1] + drag.dy];
      }
      drag.moved = true;
      canvas.setDirty(true, true);
      return;
    }
    if (e.target !== el || !canvas.graph || e.buttons) return;
    const tie = tieAt(canvas, canvas.graph, graphPoint(canvas, e));
    setHovered(canvas, tie?.id ?? null);
    if (tie) {
      // Litegraph sets the cursor while handling the move; set ours afterwards.
      requestAnimationFrame(() => (el.style.cursor = "grab"));
    }
  }, true);

  const end = (e) => {
    state.pointerDown = false;
    if (state.cut && e.pointerId === state.cut.pointerId) {
      e.stopImmediatePropagation();
      const cut = state.cut;
      state.cut = null;
      hideCutLine();
      if (e.type === "pointerup" && canvas.graph) applyCut(canvas, canvas.graph, cut.start, graphPoint(canvas, e));
      return;
    }
    if (state.drag && e.pointerId === state.drag.pointerId) {
      e.stopImmediatePropagation();
      const moved = state.drag.moved;
      state.drag = null;
      el.style.cursor = "";
      if (moved) commit(canvas);
      else canvas.setDirty(true, true);
    }
  };
  window.addEventListener("pointerup", end, true);
  window.addEventListener("pointercancel", end, true);
}

// ---------- rendering ----------

function wireColor(tie) {
  const counts = new Map();
  let best = GREY;
  let max = 0;
  for (const id of tie.links) {
    const c = state.linkColors.get(id);
    if (!c) continue;
    const n = (counts.get(c) ?? 0) + 1;
    counts.set(c, n);
    if (n > max) {
      max = n;
      best = c;
    }
  }
  return best;
}

function tieColor(tie) {
  if (tie.color === WIRES) return wireColor(tie);
  return tie.color || GREY;
}

function drawTies(canvas, ctx, graph) {
  const ties = tiesOf(graph);
  if (!ties.length) return;
  ctx.save();
  for (const tie of ties) {
    const active = tie.id === state.hovered || state.drag?.tie === tie;
    const h = tieHalfLength(canvas, tie);
    ctx.save();
    ctx.translate(tie.pos[0], tie.pos[1]);
    ctx.rotate(tie.angle ?? 0);
    ctx.fillStyle = tieColor(tie);
    ctx.strokeStyle = active ? "#ffffff" : "rgba(0,0,0,0.6)";
    ctx.lineWidth = active ? 1.5 : 1;
    // Strap across the wires, with the locking head at one end.
    ctx.beginPath();
    ctx.roundRect(-BAR_HALF_WIDTH, -h, BAR_HALF_WIDTH * 2, h * 2, BAR_HALF_WIDTH);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.roundRect(-HEAD_HALF_WIDTH, -h - HEAD_LENGTH + 1, HEAD_HALF_WIDTH * 2, HEAD_LENGTH, 1.5);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

function installRendering(canvas) {
  const proto = Object.getPrototypeOf(canvas);
  const origRenderLink = proto.renderLink;
  const origDrawConnections = proto.drawConnections;

  proto.renderLink = function (ctx, a, b, link, skipBorder, flow, color, sd, ed, opts = {}) {
    if (state.rendering || !link || link.parentId != null || opts.reroute || opts.startControl || opts.endControl || this.graph !== canvas.graph) {
      return origRenderLink.apply(this, arguments);
    }
    state.endpoints.set(link.id, { a: [a[0], a[1]], b: [b[0], b[1]], sd, ed });
    const ties = state.index.get(link.id);
    if (!ties?.length) return origRenderLink.apply(this, arguments);
    state.linkColors.set(link.id, color || link.color || this.constructor.link_type_colors?.[link.type] || this.default_link_color);

    const active = ties.some((t) => t.id === state.hovered || state.drag?.tie === t);
    const segColor = color ?? (active ? "#ffffff" : null);
    const segs = route(this, link.id, a, b, sd, ed);
    const marker = this.linkMarkerShape;
    state.rendering = true;
    try {
      // Draw every segment after the first without a centre marker, then the first one
      // last so the link's hit path and centre marker belong to the output-side segment.
      this.linkMarkerShape = MARKER_NONE;
      for (let i = 1; i < segs.length; i++) {
        const s = segs[i];
        origRenderLink.call(this, ctx, s.a, s.b, link, skipBorder, flow, segColor, s.sd, s.ed, { ...opts, startControl: s.startControl, endControl: s.endControl });
      }
      this.linkMarkerShape = marker;
      const s = segs[0];
      origRenderLink.call(this, ctx, s.a, s.b, link, skipBorder, flow, segColor, s.sd, s.ed, { ...opts, startControl: s.startControl, endControl: s.endControl });
    } finally {
      this.linkMarkerShape = marker;
      state.rendering = false;
    }
  };

  proto.drawConnections = function (ctx, ...rest) {
    const graph = this.graph;
    if (this !== canvas || !graph) return origDrawConnections.call(this, ctx, ...rest);
    state.endpoints.clear();
    state.linkColors.clear();
    syncTies(graph);
    followNodes(graph, tiesOf(graph));
    const r = origDrawConnections.call(this, ctx, ...rest);
    drawTies(this, ctx, graph);
    return r;
  };
}

app.registerExtension({
  name: "safzan.ZipTies",
  settings: [
    {
      id: COLOR_SETTING,
      category: ["Zip Ties", "Ties", "New tie colour"],
      name: "Colour of new ties",
      tooltip: "Random picks a cable-tie colour for each new tie. Match wires takes the colour of the wires it holds. Right-click a tie to change its colour.",
      type: "combo",
      options: Object.values(COLOR_MODE),
      defaultValue: COLOR_MODE.RANDOM,
    },
  ],
  async setup() {
    const canvas = app.canvas;
    installRendering(canvas);
    installInput(canvas);
  },
});
