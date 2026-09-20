/* ==========================================================
   ネットワークのしくみ体験 ― 情報Ⅰ「ネットワークと情報システム」
   index.html / style.css / script.js だけで動きます(外部ライブラリなし)

   第1部: 回線交換 と パケット交換 をくらべる
   第2部: パケット交換を体験する(分割 → ヘッダ → 送信 → 受信・復元)
   ========================================================== */
(function () {
  'use strict';

  /* ---------- 共通ヘルパー ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const fmt = (n) => Number(n).toLocaleString('ja-JP');
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const lerp = (a, b, f) => a + (b - a) * f;

  function svgEl(name, attrs, text) {
    const el = document.createElementNS(SVG_NS, name);
    if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (text != null) el.textContent = text;
    return el;
  }
  function clearEl(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  const pastel = (i) => `hsl(${Math.round((i * 137.5) % 360)}, 68%, 84%)`;

  /* ---------- 共通のデータ(第2部・第3部・第4部で使う) ---------- */
  const MSS = 1460;   // 1パケットに入るデータの最大(バイト)
  const HDR = 40;     // ヘッダの大きさ(IP 20 + TCP 20)
  const KINDS = {
    small:  { key: 'small',  label: '小', icon: '📝', name: 'テキスト(メール本文)',     bytes: 4000,  ratio: 0.4 },
    medium: { key: 'medium', label: '中', icon: '🖼️', name: '画像(圧縮していない写真)', bytes: 12000, ratio: 0.5 },
    large:  { key: 'large',  label: '大', icon: '🎞️', name: '動画(圧縮していない)',     bytes: 36000, ratio: 0.5 }
  };
  function makePlan(sizeKey, compress) {
    const k = KINDS[sizeKey];
    const sendBytes = compress ? Math.round(k.bytes * k.ratio) : k.bytes;
    const chunks = [];
    let rem = sendBytes;
    while (rem > 0) { const c = Math.min(MSS, rem); chunks.push(c); rem -= c; }
    return { kind: k, orig: k.bytes, sendBytes, chunks, count: chunks.length };
  }

  /* 区間(leg)のリストをたどって、時刻 t の位置を返す。
     leg = { from, to, t0, t1, frac }  frac: 途中で消えるパケット用(その区間の何割まで進むか) */
  function posAlong(legs, t, nodes) {
    const n = legs.length;
    if (!n || t < legs[0].t0) return null;
    for (let i = 0; i < n; i++) {
      const L = legs[i];
      if (t < L.t1) {
        const a = nodes[L.from];
        if (t >= L.t0) {
          const f = ((t - L.t0) / (L.t1 - L.t0)) * (L.frac == null ? 1 : L.frac);
          const b = nodes[L.to];
          return { x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), leg: i, waiting: false };
        }
        return { x: a.x, y: a.y, leg: i, waiting: true, node: L.from };
      }
    }
    return null;
  }

  /* 時計(再生・一時停止・シーク) */
  class Clock {
    constructor(onFrame) {
      this.t = 0; this.max = 1; this.rate = 1;
      this.playing = false; this.last = 0; this.raf = 0;
      this.onFrame = onFrame; this.onState = null;
      this._loop = this._loop.bind(this);
    }
    play() {
      if (this.playing) return;
      if (this.t >= this.max) this.t = 0;
      this.playing = true;
      this.last = performance.now();
      this.raf = requestAnimationFrame(this._loop);
      if (this.onState) this.onState();
    }
    pause() {
      if (!this.playing) return;
      this.playing = false;
      cancelAnimationFrame(this.raf);
      if (this.onState) this.onState();
    }
    seek(t) { this.t = clamp(t, 0, this.max); this.onFrame(this.t); if (this.onState) this.onState(); }
    reset() { this.pause(); this.seek(0); }
    _loop(now) {
      if (!this.playing) return;
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.t += dt * this.rate;
      if (this.t >= this.max) {
        this.t = this.max;
        this.playing = false;
        this.onFrame(this.t);
        if (this.onState) this.onState();
        return;
      }
      this.onFrame(this.t);
      this.raf = requestAnimationFrame(this._loop);
    }
  }

  /* ヒーローの図(パケットのイラスト) */
  (function heroArt() {
    const g = $('#hero-pkts');
    if (!g) return;
    for (let i = 0; i < 5; i++) {
      const x = 20 + i * 90;
      g.appendChild(svgEl('rect', { x: x, y: 100, width: 18, height: 44, rx: 3, class: 'pk-h' }));
      g.appendChild(svgEl('rect', { x: x + 18, y: 100, width: 62, height: 44, rx: 3, fill: '#5b7590' }));
      g.appendChild(svgEl('text', { x: x + 49, y: 128, 'text-anchor': 'middle' }, String(i + 1) + '/5'));
    }
  })();

  /* ---------- タブ ---------- */
  const tabs = $$('.tab');
  const stopAll = [];
  function activateTab(panelId) {
    tabs.forEach((tab) => {
      const on = tab.dataset.panel === panelId;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
    });
    $$('.tabpanel').forEach((p) => { p.hidden = p.id !== panelId; });
    stopAll.forEach((fn) => fn());
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => activateTab(tab.dataset.panel));
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      activateTab(next.dataset.panel);
    });
  });

  /* ==========================================================
     第1部: 回線交換 と パケット交換
     ========================================================== */
  const P1 = (function () {
    const W = 680, H = 320;
    const N = 6;            // 1人が送る量(パケット6個ぶん)
    const SETUP = 4;        // 回線をつなぐのにかかる時間
    const PAUSE_AFTER = 3;  // 3個送ったあと…
    const PAUSE_LEN = 6;    // …6コマ休む(チェックを入れたとき)
    const COLOR = { A: '#1d6fe0', C: '#ee6a1f' };

    const NODES = {
      A:  { x: 52,  y: 60,  kind: 'end', user: 'A', name: 'Aさん' },
      C:  { x: 52,  y: 240, kind: 'end', user: 'C', name: 'Cさん' },
      R1: { x: 205, y: 150, kind: 'sw' },
      R2: { x: 340, y: 150, kind: 'sw' },
      R3: { x: 475, y: 150, kind: 'sw' },
      B:  { x: 628, y: 60,  kind: 'end', user: 'A', name: 'Bさん' },
      D:  { x: 628, y: 240, kind: 'end', user: 'C', name: 'Dさん' }
    };
    const LINKS = [['A', 'R1'], ['C', 'R1'], ['R1', 'R2'], ['R2', 'R3'], ['R3', 'B'], ['R3', 'D']];
    const PATH = { A: ['A', 'R1', 'R2', 'R3', 'B'], C: ['C', 'R1', 'R2', 'R3', 'D'] };

    const legsFor = (path, t0) =>
      path.slice(0, -1).map((from, i) => ({ from, to: path[i + 1], t0: t0 + i, t1: t0 + i + 1 }));

    /* --- 回線交換のスケジュールを作る --- */
    function buildCircuit(pause) {
      const P = pause ? PAUSE_LEN : 0;
      const sendA = (i) => SETUP + i + (i >= PAUSE_AFTER ? P : 0);
      const endA = sendA(N - 1) + 4;
      const relA = endA;                       // Aが終わって回線を開放する時刻
      const startC = relA + SETUP;
      const sendC = (i) => startC + i;
      const endC = sendC(N - 1) + 4;
      const idleFrom = sendA(PAUSE_AFTER - 1) + 1;
      const idleTo = sendA(PAUSE_AFTER);

      const dots = [], resv = [], badges = [], gantt = [], events = [];
      const arrivals = { A: [], C: [] };

      // Aさん: 接続要求 → データ
      dots.push({ user: 'A', kind: 'req', legs: legsFor(PATH.A, 0) });
      for (let i = 0; i < N; i++) {
        dots.push({ user: 'A', kind: 'data', label: String(i + 1), legs: legsFor(PATH.A, sendA(i)) });
        arrivals.A.push(sendA(i) + 4);
      }
      for (let k = 0; k < 4; k++) resv.push({ link: PATH.A[k] + '-' + PATH.A[k + 1], user: 'A', from: k, to: endA });

      // Cさん: 話中 → 待つ → かけなおす → データ
      dots.push({ user: 'C', kind: 'req', busy: true, legs: [
        { from: 'C', to: 'R1', t0: 1, t1: 2 }, { from: 'R1', to: 'C', t0: 2, t1: 3 }] });
      dots.push({ user: 'C', kind: 'req', legs: legsFor(PATH.C, relA) });
      for (let i = 0; i < N; i++) {
        dots.push({ user: 'C', kind: 'data', label: String(i + 1), legs: legsFor(PATH.C, sendC(i)) });
        arrivals.C.push(sendC(i) + 4);
      }
      for (let k = 0; k < 4; k++) resv.push({ link: PATH.C[k] + '-' + PATH.C[k + 1], user: 'C', from: relA + k, to: endC });

      badges.push({ x: 150, y: 266, text: '話中…待つ', cls: 'bad', from: 2, to: relA });
      if (pause) badges.push({ x: 340, y: 100, text: '通信していないのに占有中!', cls: 'warn', from: idleFrom, to: idleTo });

      events.push({ t: 0, text: 'Aさん→Bさん:「つないでください」と要求。通る回線を予約していく' });
      events.push({ t: 1, text: 'Cさん→Dさん も、つなぐように要求する' });
      events.push({ t: 2, text: '幹線はAさんが予約ずみ → 「話中」。Cさんはつながらない', cls: 'bad' });
      events.push({ t: SETUP, text: 'Aさん専用の回線ができた。データを送りはじめる' });
      if (pause) {
        events.push({ t: idleFrom, text: 'Aさんは通信を休み中。でも回線は占有したまま。Cさんは使えない', cls: 'warn' });
        events.push({ t: idleTo, text: 'Aさんが通信を再開' });
      }
      events.push({ t: relA, text: 'Aさんの通信が終わり、回線を開放。Cさんがかけなおす', cls: 'good' });
      events.push({ t: startC, text: 'Cさん専用の回線ができた。データを送りはじめる' });
      events.push({ t: endC, text: 'Cさんの通信が終わった', cls: 'good' });

      gantt.push({ row: 'A', from: 0, to: SETUP, cls: 'g-setup', label: '接続' });
      gantt.push({ row: 'A', from: SETUP, to: endA, cls: 'g-A', label: '通信' });
      if (pause) gantt.push({ row: 'A', from: idleFrom, to: idleTo, cls: 'g-idle', label: '休み' });
      gantt.push({ row: 'C', from: 1, to: relA, cls: 'g-wait', label: '話中・待つ' });
      gantt.push({ row: 'C', from: relA, to: startC, cls: 'g-setup', label: '接続' });
      gantt.push({ row: 'C', from: startC, to: endC, cls: 'g-C', label: '通信' });

      events.sort((a, b) => a.t - b.t);
      return { dots, resv, badges, gantt, events, arrivals, endA, endC, firstC: sendC(0) + 4, end: endC };
    }

    /* --- パケット交換のスケジュールを作る --- */
    function buildPacket(pause) {
      const P = pause ? PAUSE_LEN : 0;
      const sendA = (i) => i + (i >= PAUSE_AFTER ? P : 0);
      const idleFrom = sendA(PAUSE_AFTER - 1) + 1;
      const idleTo = sendA(PAUSE_AFTER);

      const pk = [];
      for (let i = 0; i < N; i++) pk.push({ user: 'A', i, send: sendA(i) });
      for (let i = 0; i < N; i++) pk.push({ user: 'C', i, send: 1 + i });
      pk.forEach((p) => { p.arr = p.send + 1; });          // ルータR1に着く時刻

      // 幹線は1コマに1パケット。先に着いた順に送り出す(順番待ち)
      const rest = pk.slice().sort((a, b) =>
        a.arr - b.arr || (a.user === b.user ? 0 : a.user === 'A' ? -1 : 1) || a.i - b.i);
      let t = 0;
      while (rest.length) {
        let idx = rest.findIndex((p) => p.arr <= t);
        if (idx < 0) { t = rest[0].arr; idx = 0; }
        const p = rest.splice(idx, 1)[0];
        p.dep = t;
        t += 1;
      }

      const dots = [], badges = [], gantt = [], events = [];
      const arrivals = { A: [], C: [] };
      pk.forEach((p) => {
        const path = PATH[p.user];
        dots.push({
          user: p.user, kind: 'data', label: String(p.i + 1), dep: p.dep,
          legs: [
            { from: path[0], to: 'R1', t0: p.send, t1: p.send + 1 },
            { from: 'R1', to: 'R2', t0: p.dep, t1: p.dep + 1 },
            { from: 'R2', to: 'R3', t0: p.dep + 1, t1: p.dep + 2 },
            { from: 'R3', to: path[4], t0: p.dep + 2, t1: p.dep + 3 }
          ]
        });
        arrivals[p.user].push(p.dep + 3);
      });
      const endA = Math.max.apply(null, arrivals.A);
      const endC = Math.max.apply(null, arrivals.C);
      const firstC = Math.min.apply(null, arrivals.C);

      if (pause) badges.push({ x: 150, y: 30, text: '休み中 → 幹線があく', cls: 'warn', from: idleFrom, to: idleTo });

      const firstWait = pk.filter((p) => p.dep > p.arr).sort((a, b) => a.arr - b.arr)[0];

      events.push({ t: 0, text: 'Aさんはデータを6個のパケットに分けて、送りはじめる(接続の準備はいらない)' });
      events.push({ t: 1, text: 'Cさんも同時に送りはじめる。幹線はパケット1個ずつ、交代で使われる' });
      if (firstWait) events.push({ t: firstWait.arr, text: '幹線が使用中のパケットは、ルータで順番待ち(キュー)' });
      if (pause) {
        events.push({ t: idleFrom, text: 'Aさんが休み中 → 空いた幹線を、Cさんのパケットが使える', cls: 'good' });
        events.push({ t: idleTo, text: 'Aさんが通信を再開' });
      }
      events.push({ t: endA, text: 'Aさんの6個が、すべてBさんに届いた', cls: 'good' });
      events.push({ t: endC, text: 'Cさんの6個が、すべてDさんに届いた', cls: 'good' });

      gantt.push({ row: 'A', from: 0, to: endA, cls: 'g-A', label: '通信' });
      if (pause) gantt.push({ row: 'A', from: idleFrom, to: idleTo, cls: 'g-free', label: '休み' });
      gantt.push({ row: 'C', from: 1, to: endC, cls: 'g-C', label: '通信' });

      events.sort((a, b) => a.t - b.t);
      return { dots, resv: [], badges, gantt, events, arrivals, endA, endC, firstC, end: Math.max(endA, endC) };
    }

    /* --- 1つの図(パネル)を作る --- */
    function createPanel(mode) {
      const isCircuit = mode === 'circuit';
      const host = $('#net-' + mode);
      const logEl = $('#log-' + mode);
      const ganttEl = $('#gantt-' + mode);

      const svg = svgEl('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'net-svg', role: 'img',
        'aria-label': isCircuit ? '回線交換方式のネットワーク図' : 'パケット交換方式のネットワーク図'
      });
      host.appendChild(svg);
      const gLinks = svgEl('g'), gNodes = svgEl('g'), gRecv = svgEl('g'), gBadge = svgEl('g'), gDots = svgEl('g'), gTop = svgEl('g');
      [gLinks, gNodes, gRecv, gBadge, gDots, gTop].forEach((g) => svg.appendChild(g));

      const linkEls = {};
      LINKS.forEach((pair) => {
        const a = pair[0], b = pair[1];
        const trunk = (a === 'R1' && b === 'R2') || (a === 'R2' && b === 'R3');
        const ln = svgEl('line', { x1: NODES[a].x, y1: NODES[a].y, x2: NODES[b].x, y2: NODES[b].y });
        ln.dataset.base = 'link' + (trunk ? ' trunk' : '');
        ln.setAttribute('class', ln.dataset.base);
        gLinks.appendChild(ln);
        linkEls[a + '-' + b] = ln;
      });
      gLinks.appendChild(svgEl('text', { x: 340, y: 192, 'text-anchor': 'middle', class: 'trunk-label' }, '共用の回線(幹線)'));

      Object.keys(NODES).forEach((id) => {
        const n = NODES[id];
        const g = svgEl('g', { transform: 'translate(' + n.x + ',' + n.y + ')', class: 'node ' + n.kind });
        if (n.kind === 'end') {
          g.appendChild(svgEl('circle', { r: 22, fill: COLOR[n.user] }));
          g.appendChild(svgEl('text', { y: 8, 'text-anchor': 'middle', class: 'node-letter' }, id));
          g.appendChild(svgEl('text', { y: 42, 'text-anchor': 'middle', class: 'node-name' }, n.name));
        } else {
          g.appendChild(svgEl('rect', { x: -34, y: -17, width: 68, height: 34, rx: 8 }));
          g.appendChild(svgEl('text', { y: 5, 'text-anchor': 'middle', class: 'node-sw' }, isCircuit ? '交換機' : 'ルータ'));
        }
        gNodes.appendChild(g);
      });

      const recv = {};
      ['B', 'D'].forEach((id) => {
        const n = NODES[id];
        const rects = [];
        for (let i = 0; i < N; i++) {
          const r = svgEl('rect', { x: n.x - (N * 13) / 2 + i * 13, y: n.y + 52, width: 11, height: 11, rx: 2, class: 'sq' });
          gRecv.appendChild(r);
          rects.push(r);
        }
        const tx = svgEl('text', { x: n.x, y: n.y + 78, 'text-anchor': 'middle', class: 'recv-text' }, '受信 0/' + N);
        gRecv.appendChild(tx);
        recv[id] = { rects, tx, user: n.user };
      });

      const qLabel = svgEl('text', { x: NODES.R1.x + 18, y: 0, class: 'q-label' }, '順番待ち(キュー)');
      qLabel.style.display = 'none';
      gTop.appendChild(qLabel);

      let data = null, Tmax = 1, logCount = -1;
      const phEls = [];

      function makeBadge(b) {
        const g = svgEl('g', { class: 'badge ' + (b.cls || ''), transform: 'translate(' + b.x + ',' + b.y + ')' });
        const w = b.text.length * 13.5 + 24;
        g.appendChild(svgEl('rect', { x: -w / 2, y: -14, width: w, height: 28, rx: 14 }));
        g.appendChild(svgEl('text', { y: 5, 'text-anchor': 'middle' }, b.text));
        g.style.display = 'none';
        return g;
      }
      function makeDot(dot) {
        const g = svgEl('g', { class: 'dot ' + dot.kind });
        const col = COLOR[dot.user];
        if (dot.kind === 'data') {
          g.appendChild(svgEl('rect', { x: -11, y: -9, width: 22, height: 18, rx: 4, fill: col }));
          g.appendChild(svgEl('text', { y: 4, 'text-anchor': 'middle', class: 'dot-t' }, dot.label));
        } else if (dot.busy) {
          g.appendChild(svgEl('rect', { x: -21, y: -11, width: 42, height: 22, rx: 11, fill: '#d92d20' }));
          g.appendChild(svgEl('text', { y: 4, 'text-anchor': 'middle', class: 'dot-t' }, '話中'));
        } else {
          g.appendChild(svgEl('circle', { r: 11, fill: '#fff', stroke: col, 'stroke-width': 3, 'stroke-dasharray': '4 3' }));
          g.appendChild(svgEl('text', { y: 4, 'text-anchor': 'middle', class: 'dot-q', fill: col }, '☎'));
        }
        g.style.display = 'none';
        return g;
      }
      function buildGantt() {
        clearEl(ganttEl);
        phEls.length = 0;
        const cap = document.createElement('div');
        cap.className = 'g-cap';
        cap.textContent = '時間の使われ方(黒い線が今の時刻)';
        ganttEl.appendChild(cap);
        ['A', 'C'].forEach((row) => {
          const r = document.createElement('div');
          r.className = 'g-row';
          const lab = document.createElement('span');
          lab.className = 'g-label ' + row.toLowerCase();
          lab.textContent = row === 'A' ? 'A→B' : 'C→D';
          const track = document.createElement('div');
          track.className = 'g-track';
          data.gantt.filter((g) => g.row === row).forEach((g) => {
            const bar = document.createElement('div');
            bar.className = 'g-bar ' + g.cls;
            bar.style.left = (g.from / Tmax) * 100 + '%';
            bar.style.width = ((g.to - g.from) / Tmax) * 100 + '%';
            bar.textContent = g.label;
            track.appendChild(bar);
          });
          const ph = document.createElement('i');
          ph.className = 'ph';
          track.appendChild(ph);
          phEls.push(ph);
          r.appendChild(lab);
          r.appendChild(track);
          ganttEl.appendChild(r);
        });
      }

      function load(d, tmax) {
        data = d; Tmax = tmax; logCount = -1;
        clearEl(gBadge); clearEl(gDots); clearEl(logEl);
        d.badges.forEach((b) => { b.el = makeBadge(b); gBadge.appendChild(b.el); });
        d.dots.forEach((dot) => { dot.el = makeDot(dot); gDots.appendChild(dot.el); });
        buildGantt();
      }

      function render(t) {
        if (!data) return;
        // 回線の色
        Object.keys(linkEls).forEach((id) => linkEls[id].setAttribute('class', linkEls[id].dataset.base));
        data.resv.forEach((r) => {
          if (t >= r.from && t < r.to) linkEls[r.link].setAttribute('class', linkEls[r.link].dataset.base + ' resv-' + r.user);
        });
        // 点(要求・パケット)
        const waiting = [];
        data.dots.forEach((dot) => {
          const p = posAlong(dot.legs, t, NODES);
          if (!p) { dot.el.style.display = 'none'; return; }
          dot.el.style.display = '';
          if (p.waiting && p.node === 'R1' && dot.kind === 'data') { waiting.push(dot); return; }
          dot.el.setAttribute('transform', 'translate(' + p.x.toFixed(1) + ',' + p.y.toFixed(1) + ')');
          if (dot.kind === 'data' && !p.waiting) {
            const L = dot.legs[p.leg];
            const ln = linkEls[L.from + '-' + L.to];
            if (ln && !/resv-/.test(ln.getAttribute('class'))) ln.setAttribute('class', ln.dataset.base + ' use-' + dot.user);
          }
        });
        waiting.sort((a, b) => a.dep - b.dep).forEach((dot, rank) => {
          dot.el.setAttribute('transform', 'translate(' + NODES.R1.x + ',' + (NODES.R1.y - 34 - rank * 19) + ')');
        });
        if (waiting.length) {
          qLabel.style.display = '';
          qLabel.setAttribute('y', String(NODES.R1.y - 34 - (waiting.length - 1) * 19 + 4));
        } else {
          qLabel.style.display = 'none';
        }
        // ふきだし
        data.badges.forEach((b) => { b.el.style.display = t >= b.from && t < b.to ? '' : 'none'; });
        // 受信
        ['B', 'D'].forEach((id) => {
          const user = recv[id].user;
          const cnt = data.arrivals[user].filter((x) => x <= t).length;
          recv[id].rects.forEach((r, i) => r.setAttribute('class', 'sq' + (i < cnt ? ' on-' + user : '')));
          recv[id].tx.textContent = '受信 ' + cnt + '/' + N;
        });
        // ガントの現在線
        phEls.forEach((ph) => { ph.style.left = (t / Tmax) * 100 + '%'; });
        // ログ
        const shown = data.events.filter((e) => e.t <= t);
        if (shown.length !== logCount) {
          logCount = shown.length;
          logEl.innerHTML = shown.length
            ? shown.map((e) => '<li class="' + (e.cls || '') + '"><span class="t">時刻 ' + Math.floor(e.t) + '</span>' + e.text + '</li>').join('')
            : '<li class="empty">「スタート」をおすと、ここに動きの説明が出ます</li>';
          logEl.scrollTop = logEl.scrollHeight;
        }
      }
      return { load, render };
    }

    /* --- コントローラ --- */
    let circuit, packet, dataC, dataP, Tmax = 30, clock;

    function init() {
      circuit = createPanel('circuit');
      packet = createPanel('packet');
      clock = new Clock(onFrame);
      clock.rate = parseFloat($('#p1-speed').value);
      clock.onState = updatePlayLabel;

      $('#p1-play').addEventListener('click', () => { clock.playing ? clock.pause() : clock.play(); });
      $('#p1-step').addEventListener('click', () => { clock.pause(); clock.seek(Math.floor(clock.t + 1e-6) + 1); });
      $('#p1-reset').addEventListener('click', () => clock.reset());
      $('#p1-speed').addEventListener('change', (e) => { clock.rate = parseFloat(e.target.value); });
      $('#p1-pause').addEventListener('change', () => { rebuild(); });
      $('#p1-seek').addEventListener('input', (e) => { clock.pause(); clock.seek(parseFloat(e.target.value)); });
      stopAll.push(() => clock.pause());
      rebuild();
    }

    function rebuild() {
      const pause = $('#p1-pause').checked;
      dataC = buildCircuit(pause);
      dataP = buildPacket(pause);
      Tmax = Math.max(dataC.end, dataP.end) + 1;
      clock.max = Tmax;
      $('#p1-seek').max = String(Tmax);
      circuit.load(dataC, Tmax);
      packet.load(dataP, Tmax);
      clock.reset();
    }

    function updatePlayLabel() {
      const b = $('#p1-play');
      if (clock.playing) b.textContent = '⏸ 一時停止';
      else if (clock.t >= clock.max) b.textContent = '↻ もういちど';
      else if (clock.t > 0) b.textContent = '▶ つづける';
      else b.textContent = '▶ スタート';
    }

    function onFrame(t) {
      circuit.render(t);
      packet.render(t);
      $('#p1-seek').value = String(t);
      $('#p1-clock').textContent = String(Math.floor(t));
      const cell = (id, val) => { $('#' + id).textContent = t >= val ? String(val) : '…'; };
      cell('r-endA-c', dataC.endA); cell('r-endA-p', dataP.endA);
      cell('r-firstC-c', dataC.firstC); cell('r-firstC-p', dataP.firstC);
      cell('r-endC-c', dataC.endC); cell('r-endC-p', dataP.endC);
      const tk = $('#p1-takeaway');
      if (t >= Math.max(dataC.end, dataP.end)) {
        const early = dataC.endC - dataP.endC;
        const dA = dataP.endA - dataC.endA;
        let s = '回線交換では、Cさんは回線があくまで待たされて、時刻 ' + dataC.endC + ' に終わりました。パケット交換では時刻 ' + dataP.endC + ' に終わり、' + early + ' コマ早くなりました。';
        s += $('#p1-pause').checked
          ? ' Aさんが休んでいる間の空きを、パケット交換ではCさんが使えたからです。'
          : ' 幹線をパケット1個ずつ交代で使えるので、回線がむだなく使われます。';
        s += dA > 0 ? ' そのかわり、Aさんの終わりは ' + dA + ' コマおそくなりました。' : dA < 0 ? ' Aさんも ' + (-dA) + ' コマ早く終わりました。' : ' Aさんの終わる時刻は変わりません。';
        tk.textContent = s;
        tk.hidden = false;
      } else {
        tk.hidden = true;
      }
    }

    return { init };
  })();

  /* ==========================================================
     第2部: パケット交換を体験する
     ========================================================== */
  const P2 = (function () {
    const SRC = '198.51.100.24';
    const DST = '203.0.113.80';
    const DOMAIN = 'www.example.jp';

    const ROUTES = [
      { id: 'up',  name: '上の経路', via: ['R2', 'R5'], d: 0.85, color: '#1d6fe0' },
      { id: 'mid', name: '中の経路', via: ['R3', 'R6'], d: 0.55, color: '#0d8a7a' },
      { id: 'low', name: '下の経路', via: ['R4', 'R7'], d: 1.15, color: '#7b3fe4' }
    ];
    const NODES = {
      PC:  { x: 48,  y: 160 },
      R1:  { x: 150, y: 160 },
      R2:  { x: 290, y: 56 },  R5: { x: 430, y: 56 },
      R3:  { x: 290, y: 160 }, R6: { x: 430, y: 160 },
      R4:  { x: 290, y: 264 }, R7: { x: 430, y: 264 },
      R8:  { x: 570, y: 160 },
      SRV: { x: 668, y: 160 }
    };
    const LINKS2 = [
      ['PC', 'R1', ''], ['R1', 'R2', 'up'], ['R1', 'R3', 'mid'], ['R1', 'R4', 'low'],
      ['R2', 'R5', 'up'], ['R3', 'R6', 'mid'], ['R4', 'R7', 'low'],
      ['R5', 'R8', 'up'], ['R6', 'R8', 'mid'], ['R7', 'R8', 'low'], ['R8', 'SRV', '']
    ];

    const state = { size: 'small', compress: false, loss: false, step: 0, sim: null, simKey: '', selPkt: 1 };
    const ui = { clock: null, sim: null, nodeEls: {}, slots: [], chips: null, chipCount: -1, logEl: null, logCount: -1 };

    /* --- パケットの計画(分割) --- */
    function plan(sizeKey, compress) {
      const k = KINDS[sizeKey];
      const sendBytes = compress ? Math.round(k.bytes * k.ratio) : k.bytes;
      const chunks = [];
      let rem = sendBytes;
      while (rem > 0) { const c = Math.min(MSS, rem); chunks.push(c); rem -= c; }
      return {
        kind: k, orig: k.bytes, sendBytes, chunks, count: chunks.length,
        headerTotal: chunks.length * HDR, total: sendBytes + chunks.length * HDR
      };
    }
    const curPlan = () => plan(state.size, state.compress);

    /* --- ネットワークを通す様子のシミュレーション --- */
    function buildSim(pl, loss) {
      const N = pl.count;
      const gap = Math.min(0.45, 7 / N);
      const journeys = [], events = [];

      function makeJourney(no, depart, retrans, lost) {
        const r = ROUTES[Math.floor(Math.random() * ROUTES.length)];
        const path = ['PC', 'R1', r.via[0], r.via[1], 'R8', 'SRV'];
        const jit = () => r.d * (0.8 + Math.random() * 0.5);
        const durs = [0.5, jit(), jit(), jit(), 0.5];
        const legs = [];
        let t = depart;
        for (let i = 0; i < durs.length; i++) {
          legs.push({ from: path[i], to: path[i + 1], t0: t, t1: t + durs[i], frac: 1 });
          t += durs[i];
        }
        const j = { kind: 'data', no, retrans, route: r, legs, arr: t, lost: false, depart };
        if (lost) {
          const li = 1 + Math.floor(Math.random() * 3);
          const frac = 0.45 + Math.random() * 0.35;
          const L = legs[li];
          const tl = L.t0 + (L.t1 - L.t0) * frac;
          legs.length = li + 1;
          L.t1 = tl; L.frac = frac;
          const a = NODES[L.from], b = NODES[L.to];
          j.lost = true; j.arr = null;
          j.lostMarker = { t: tl, x: lerp(a.x, b.x, frac), y: lerp(a.y, b.y, frac) };
        }
        journeys.push(j);
        return j;
      }

      // 1回目の送信
      const lostSet = new Set();
      if (loss) {
        const want = Math.min(N >= 8 ? 2 : 1, N - 1);
        const nos = shuffle(Array.from({ length: N }, (_, i) => i + 1));
        for (let k = 0; k < want; k++) lostSet.add(nos[k]);
      }
      for (let i = 1; i <= N; i++) makeJourney(i, (i - 1) * gap, false, lostSet.has(i));

      const firstOk = journeys.filter((j) => !j.lost);
      const lastFirst = Math.max.apply(null, firstOk.map((j) => j.arr));
      events.push({ t: 0, text: 'PCがパケットを1つずつ送り出す。ルータはヘッダの宛先IPアドレスを見て、それぞれ次の行き先を決める' });

      // 消えたパケットの再送
      if (lostSet.size) {
        const missing = Array.from(lostSet).sort((a, b) => a - b);
        const tDetect = lastFirst + 0.7;
        const rp = ['SRV', 'R8', 'R6', 'R3', 'R1', 'PC'];
        const rl = [];
        let t = tDetect;
        for (let i = 0; i < rp.length - 1; i++) {
          rl.push({ from: rp[i], to: rp[i + 1], t0: t, t1: t + 0.5, frac: 1 });
          t += 0.5;
        }
        journeys.push({ kind: 'req', label: '再送要求', legs: rl, arr: t });
        journeys.filter((j) => j.lost).forEach((j) => {
          events.push({ t: j.lostMarker.t, cls: 'bad', text: '✕ パケット' + j.no + ' が途中で消えた(混雑や故障など)' });
        });
        events.push({ t: tDetect, cls: 'warn', text: '受信側「' + missing.join('番・') + '番が届いていない」→ 送信側に再送を要求' });
        events.push({ t: t, text: '送信側が要求を受け取り、' + missing.join('番・') + '番だけをもう一度送る' });
        missing.forEach((no, k) => makeJourney(no, t + k * gap, true, false));
      }

      // 到着リスト
      const arrivals = journeys
        .filter((j) => j.kind === 'data' && !j.lost)
        .map((j) => ({ no: j.no, t: j.arr, route: j.route, color: j.route.color, retrans: j.retrans }))
        .sort((a, b) => a.t - b.t);
      let maxNo = 0, ooo = 0;
      arrivals.forEach((a) => {
        a.ooo = !a.retrans && a.no < maxNo;
        if (a.ooo) ooo++;
        if (!a.retrans) maxNo = Math.max(maxNo, a.no);
        events.push({
          t: a.t,
          cls: a.retrans ? 'good' : a.ooo ? 'warn' : '',
          text: 'パケット' + a.no + ' が到着(' + a.route.name + (a.retrans ? '・再送' : '') + ')' + (a.ooo ? ' ← 追いこされて、順番が入れかわった' : '')
        });
      });
      const allDone = arrivals[arrivals.length - 1].t;
      events.push({ t: allDone, cls: 'good', text: 'すべて届いた。番号順にならべれば元のデータにもどせる' });
      events.sort((a, b) => a.t - b.t);
      return { journeys, events, arrivals, ooo, lost: Array.from(lostSet), T: allDone + 0.8 };
    }

    function ensureSim(force) {
      const key = [state.size, state.compress, state.loss].join('|');
      if (force || !state.sim || state.simKey !== key) {
        state.sim = buildSim(curPlan(), state.loss);
        state.simKey = key;
      }
      return state.sim;
    }

    /* --- ステップの定義 --- */
    const STEPS = [
      { id: 'dns',      short: '宛先を調べる' },
      { id: 'data',     short: '元のデータ' },
      { id: 'compress', short: '圧縮する' },
      { id: 'split',    short: '分割する' },
      { id: 'header',   short: 'ヘッダをつける' },
      { id: 'send',     short: 'ネットワークを通す' },
      { id: 'recv',     short: '受信・復元' }
    ];

    function pktCard(i, size, total, withHdr, idx, tag) {
      const w = Math.round(52 + (48 * size) / MSS);
      const t = tag || 'span';
      const extra = t === 'button' ? ' type="button" data-no="' + (i + 1) + '"' : '';
      return '<' + t + ' class="pkt" style="--pc:' + pastel(i) + ';--d:' + Math.min(idx * 0.05, 1.4).toFixed(2) + 's"' + extra + '>' +
        (withHdr ? '<span class="hdr">ヘッダ</span>' : '') +
        '<span class="pl" style="min-width:' + w + 'px"><b>' + (i + 1) + '/' + total + '</b><small>' + fmt(size) + 'B</small></span></' + t + '>';
    }

    function barRow(label, bytes, maxBytes, cls, extraCls) {
      return '<div class="bar-row ' + (extraCls || '') + '"><span class="lab">' + label + '</span>' +
        '<div class="bar-track"><div class="bar ' + cls + '" style="width:' + (bytes / maxBytes) * 100 + '%"></div></div>' +
        '<span class="val">' + fmt(bytes) + ' バイト</span></div>';
    }

    function renderStepContent(id) {
      const pl = curPlan();
      const k = pl.kind;
      switch (id) {
        case 'dns':
          return {
            title: '宛先を調べる',
            lead: 'パケットのヘッダに書く宛先は「IPアドレス」です。まず、ドメイン名からDNSでIPアドレスを調べます。',
            html:
              '<div class="dns-scene">' +
              '<div class="nodecard"><span class="ic">💻</span><b>自分のPC</b><br><code>' + SRC + '</code></div>' +
              '<div class="bubbles">' +
              '<div class="bubble q">① 「<b>' + DOMAIN + '</b> のIPアドレスを教えて」</div>' +
              '<div class="bubble a">② 「<b class="mono">' + DST + '</b> です」</div>' +
              '</div>' +
              '<div class="nodecard"><span class="ic">📖</span><b>DNSサーバ</b><small>ドメイン名 ⇔ IPアドレス</small></div>' +
              '</div>' +
              '<p class="dns-result">送り先(宛先IPアドレス)が分かった → <code>' + DST + '</code>　これから、全パケットのヘッダに書きます。</p>' +
              '<p class="fine" style="margin-top:8px;">※ IPアドレスは、学習用に予約されている番号です。</p>',
            point: 'ドメイン名 → IPアドレス の変換は、DNSの仕事。パケットの宛先は、IPアドレスで書きます。'
          };

        case 'data':
          return {
            title: '元のデータ',
            lead: k.icon + ' 「' + k.name + '」を送ります。大きさは ' + fmt(pl.orig) + ' バイトです。',
            html:
              '<div class="kindcard"><span class="ic">' + k.icon + '</span><div><b>' + k.name + '</b><br><span class="fine">大きさ:' + k.label + '(' + fmt(pl.orig) + ' バイト)</span></div></div>' +
              Object.keys(KINDS).map((key) => {
                const kk = KINDS[key];
                return barRow(kk.icon + ' ' + kk.label, kk.bytes, KINDS.large.bytes, key === state.size ? 'sel' : 'orig', key === state.size ? '' : 'dim');
              }).join(''),
            point: '送るデータが大きいほど、あとで必要になるパケットの数が増えます。'
          };

        case 'compress': {
          const on = state.compress;
          const comp = plan(state.size, true);
          return {
            title: '圧縮する',
            lead: on
              ? 'データを圧縮して、バイト数を減らしてから送ります。受け取った側で「展開」すると、元にもどります(ZIPなど)。'
              : '今は「圧縮しない」設定です。そのまま送ります。',
            html:
              barRow('元のデータ', pl.orig, pl.orig, 'orig') +
              (on
                ? '<div class="bar-row"><span class="lab">圧縮後</span><div class="bar-track"><div class="bar comp" id="comp-bar" style="width:100%"></div></div><span class="val">' + fmt(comp.sendBytes) + ' バイト</span></div>' +
                  '<p class="equation">' + fmt(pl.orig) + ' → <code>' + fmt(comp.sendBytes) + '</code> バイト(元の ' + Math.round(k.ratio * 100) + '%)</p>' +
                  '<p class="equation">パケットの数: ' + plan(state.size, false).count + ' 個 → <code>' + comp.count + ' 個</code></p>'
                : '<p class="fine" style="margin:10px 0;">圧縮すると、この ' + fmt(pl.orig) + ' バイトが ' + fmt(comp.sendBytes) + ' バイトになります。</p>' +
                  '<button class="btn" type="button" id="btn-comp-on">圧縮をONにして見る</button>'),
            point: on
              ? '圧縮すると、送るバイト数が減り、パケットの数も減ります。JPEG や MP3 など、すでに圧縮されたデータは、あまり小さくなりません。'
              : '圧縮は必須ではありません。データが大きいときや、回線が遅いときに役立ちます。',
            after: () => {
              const bar = $('#comp-bar');
              if (bar) requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = (comp.sendBytes / pl.orig) * 100 + '%'; }));
              const btn = $('#btn-comp-on');
              if (btn) btn.addEventListener('click', () => { $('#p2-compress').checked = true; settingsChanged(); });
            }
          };
        }

        case 'split':
          return {
            title: '分割する',
            lead: '1つのパケットに入るデータの大きさには上限があります(ここでは ' + fmt(MSS) + ' バイト)。上限をこえるデータは、分割して送ります。',
            html:
              '<p class="equation">' + fmt(pl.sendBytes) + ' バイト ÷ ' + fmt(MSS) + ' バイト → <code>' + pl.count + ' 個</code>のパケット' + (state.compress ? '(圧縮ずみ)' : '') + '</p>' +
              '<div class="pkts">' + pl.chunks.map((c, i) => pktCard(i, c, pl.count, false, i)).join('') + '</div>' +
              '<p class="fine">数字は「何番目 / 全部で何個」。最後のパケットは、あまりのぶんだけ小さくなります。</p>',
            point: '大きなデータは、小さなパケットに分けて送ります。分けたものに番号をつけるのは、次のステップです。'
          };

        case 'header':
          return {
            title: 'ヘッダをつける',
            lead: '分けたデータの前に「ヘッダ」をつけます。ヘッダには、届けるために必要な情報が書かれます。パケットをクリックして、中を見てみよう。',
            html:
              '<div class="pkts" id="hdr-pkts">' + pl.chunks.map((c, i) => pktCard(i, c, pl.count, true, i, 'button')).join('') + '</div>' +
              '<div class="inspector" id="inspector"></div>' +
              '<p class="equation" style="margin-top:12px;">ヘッダの大きさ <code>' + HDR + ' バイト</code> × ' + pl.count + ' 個 = ' + fmt(pl.headerTotal) + ' バイト増える → ネットワークに流れる合計 <code>' + fmt(pl.total) + ' バイト</code></p>',
            point: 'ヘッダのおかげで、パケットは1つずつ独立して届けられ、受信側で元の順に組み立てられます。かわりに、ヘッダの分だけデータが増えます。',
            after: () => {
              const paint = () => {
                $$('#hdr-pkts .pkt').forEach((b) => b.classList.toggle('sel', Number(b.dataset.no) === state.selPkt));
                $('#inspector').innerHTML = inspectorHtml(state.selPkt, pl);
              };
              state.selPkt = Math.min(state.selPkt, pl.count);
              $$('#hdr-pkts .pkt').forEach((b) => b.addEventListener('click', () => { state.selPkt = Number(b.dataset.no); paint(); }));
              paint();
            }
          };

        case 'send': {
          const sim = ensureSim();
          return {
            title: 'ネットワークを通す',
            lead: 'パケットを1つずつ送り出します。ルータはヘッダの宛先IPアドレスを見て、次にどこへ送るかを決めます(ルーティング)。',
            html:
              '<div class="send-tools">' +
              '<button class="btn primary" type="button" id="p2-play">⏸ 一時停止</button>' +
              '<button class="btn" type="button" id="p2-replay">↺ もういちど送る</button>' +
              '<label class="field">速さ <select id="p2-speed"><option value="0.5">ゆっくり</option><option value="1" selected>ふつう</option><option value="2">はやい</option></select></label>' +
              '</div>' +
              '<div class="seekbar"><span>時間</span><input type="range" id="p2-seek" min="0" max="' + sim.T.toFixed(2) + '" step="0.02" value="0" aria-label="時間を動かす"></div>' +
              '<div class="net2" id="net2"></div>' +
              '<p class="legend"><span class="dotkey up"></span>上の経路 <span class="dotkey mid"></span>中の経路 <span class="dotkey low"></span>下の経路 / 点の数字は「パケット番号」/ <b>もういちど</b>を押すと、通る経路が変わります</p>' +
              '<div class="recv">' +
              '<div><h4>届いた順(先に着いたものが左)</h4><div class="chips" id="chips"></div></div>' +
              '<div><h4>受信側の入れもの(パケット番号のところに入る)</h4><div class="slots" id="slots"></div></div>' +
              '</div>' +
              '<div class="done-msg" id="p2-done" hidden>✔ すべてのパケットがそろいました。「次へ」で受信側の復元を見よう。</div>' +
              '<ul class="log" id="log2"></ul>',
            point: state.loss
              ? '同じデータのパケットでも、通る経路はバラバラで、届く順番も入れかわります。消えたパケットは、受信側が番号で気づいて、そのパケットだけ再送してもらいます。'
              : '同じデータのパケットでも、通る経路はバラバラで、届く順番も入れかわることがあります。それでも、番号があるので元にもどせます。',
            after: () => setupSend()
          };
        }

        case 'recv': {
          const sim = ensureSim();
          const comp = state.compress;
          const chips = sim.arrivals.map((a) => '<span class="chip' + (a.retrans ? ' re' : '') + '" style="background:' + a.color + '">' + a.no + '</span>').join('');
          const sorted = pl.chunks.map((c, i) => pktCard(i, c, pl.count, false, 0).replace('class="pkt"', 'class="pkt small"')).join('');
          return {
            title: '受信して、元にもどす',
            lead: '宛先のコンピュータが、届いたパケットから元のデータを組み立てます。',
            html:
              '<div class="flow">' +
              '<div class="step" style="animation-delay:0s"><h4>① 届いた順(バラバラ)</h4><div class="chips">' + chips + '</div>' +
              '<p class="fine" style="margin-top:4px;">' + (sim.ooo > 0 ? '先に着いたパケットに追いこされて、順番が入れかわったものが ' + sim.ooo + ' 個ありました。' : '今回は、たまたま順番どおりに届きました。') +
              (sim.lost.length ? ' 消えた ' + sim.lost.join('番・') + '番は、再送してもらいました(点線の枠)。' : '') + '</p></div>' +
              '<div class="arrow" style="animation-delay:.7s">▼ ヘッダの「パケット番号」を見て、番号順にならべる</div>' +
              '<div class="step" style="animation-delay:1.2s"><h4>② 番号順</h4><div class="pkts">' + sorted + '</div></div>' +
              '<div class="arrow" style="animation-delay:1.9s">▼ ヘッダをはずして、データ部分だけをつなぐ' + (comp ? ' → 圧縮を展開する' : '') + '</div>' +
              '<div class="final" style="animation-delay:2.5s">' + pl.kind.icon + ' 元のデータにもどった! ' + fmt(pl.orig) + ' バイト' +
              (comp ? '(' + fmt(pl.sendBytes) + ' → ' + fmt(pl.orig) + ' バイトに展開)' : '') + '</div>' +
              '</div>',
            point: '番号のおかげで、順番がバラバラでも元通り。もう一度ためすなら、上の設定を変えて、最初のステップから見なおしてみよう。'
          };
        }
      }
      return { title: '', lead: '', html: '', point: '' };
    }

    function inspectorHtml(no, pl) {
      const size = pl.chunks[no - 1];
      return '<h4>パケット ' + no + ' のヘッダ(ヘッダ全体で ' + HDR + ' バイト)</h4>' +
        '<table>' +
        '<tr><th>宛先IPアドレス</th><td class="v">' + DST + '</td><td class="h">荷物の「あて先」。ルータはこれを見て、転送先を決める</td></tr>' +
        '<tr><th>送信元IPアドレス</th><td class="v">' + SRC + '</td><td class="h">再送の要求や返事を返すときに使う</td></tr>' +
        '<tr><th>パケット番号</th><td class="v">' + no + ' / ' + pl.count + '</td><td class="h">受信側が、正しい順にならべるための番号</td></tr>' +
        '<tr><th>TTL(生存時間)</th><td class="v">64</td><td class="h">ルータを通るたびに1減り、0になると捨てられる(迷子で回り続けるのを防ぐ)</td></tr>' +
        '<tr><th>データの長さ</th><td class="v">' + fmt(size) + ' バイト</td><td class="h">このパケットに入っているデータの量</td></tr>' +
        '</table>' +
        '<p class="fine" style="margin-top:6px;">※ 実際のヘッダは、IPヘッダ(約20バイト)とTCPヘッダ(約20バイト)などに分かれています。</p>';
    }

    /* --- 「ネットワークを通す」ステップの画面 --- */
    function setupSend() {
      const sim = ensureSim();
      ui.sim = sim;
      ui.slots = []; ui.chipCount = -1; ui.logCount = -1;
      ui.logEl = $('#log2');
      ui.chips = $('#chips');
      const pl = curPlan();

      // 受信の入れもの
      const slotsEl = $('#slots');
      for (let i = 1; i <= pl.count; i++) {
        const s = document.createElement('span');
        s.className = 'slot';
        s.textContent = String(i);
        slotsEl.appendChild(s);
        ui.slots.push(s);
      }

      // ネットワーク図
      const host = $('#net2');
      const svg = svgEl('svg', { viewBox: '0 0 720 320', role: 'img', 'aria-label': 'パケットが3つの経路に分かれて届く様子' });
      host.appendChild(svg);
      const gL = svgEl('g'), gN = svgEl('g'), gD = svgEl('g');
      [gL, gN, gD].forEach((g) => svg.appendChild(g));
      LINKS2.forEach((l) => {
        gL.appendChild(svgEl('line', { x1: NODES[l[0]].x, y1: NODES[l[0]].y, x2: NODES[l[1]].x, y2: NODES[l[1]].y, class: 'link2 ' + l[2] }));
      });
      ui.nodeEls = {};
      Object.keys(NODES).forEach((id) => {
        const n = NODES[id];
        const g = svgEl('g', { transform: 'translate(' + n.x + ',' + n.y + ')', class: 'nd' });
        if (id === 'PC' || id === 'SRV') {
          g.appendChild(svgEl('text', { y: 8, 'text-anchor': 'middle', class: 'em' }, id === 'PC' ? '💻' : '🖥️'));
          g.appendChild(svgEl('text', { y: 40, 'text-anchor': 'middle', class: 'cap' }, id === 'PC' ? '送信元のPC' : '宛先のサーバ'));
          g.appendChild(svgEl('text', { y: 55, 'text-anchor': 'middle', class: 'ip' }, id === 'PC' ? SRC : DST));
        } else {
          g.appendChild(svgEl('rect', { x: -21, y: -14, width: 42, height: 28, rx: 7 }));
          g.appendChild(svgEl('text', { y: 5, 'text-anchor': 'middle', class: 'r' }, id));
        }
        gN.appendChild(g);
        ui.nodeEls[id] = g;
      });
      sim.journeys.forEach((j) => {
        const g = svgEl('g');
        if (j.kind === 'data') {
          g.appendChild(svgEl('rect', {
            x: -13, y: -10, width: 26, height: 20, rx: 5, fill: j.route.color,
            stroke: j.retrans ? '#f59e0b' : '#fff', 'stroke-width': j.retrans ? 3 : 1.5,
            'stroke-dasharray': j.retrans ? '4 2' : ''
          }));
          g.appendChild(svgEl('text', { y: 4, 'text-anchor': 'middle', class: 'dot-t' }, String(j.no)));
        } else {
          g.appendChild(svgEl('rect', { x: -34, y: -11, width: 68, height: 22, rx: 11, fill: '#ffd84d', stroke: '#12263a', 'stroke-width': 2 }));
          g.appendChild(svgEl('text', { y: 4, 'text-anchor': 'middle', class: 'req-t' }, '再送要求'));
        }
        g.style.display = 'none';
        gD.appendChild(g);
        j.el = g;
        if (j.lostMarker) {
          const m = svgEl('g', { transform: 'translate(' + j.lostMarker.x.toFixed(1) + ',' + j.lostMarker.y.toFixed(1) + ')' });
          m.appendChild(svgEl('text', { y: 9, 'text-anchor': 'middle', class: 'lostx' }, '✕'));
          m.appendChild(svgEl('text', { x: -16, y: 4, 'text-anchor': 'end', class: 'lostt' }, '消えた!' + j.no));
          m.style.display = 'none';
          gD.appendChild(m);
          j.lostMarker.el = m;
        }
      });

      // 時計
      const clock = ui.clock;
      clock.max = sim.T;
      clock.rate = parseFloat($('#p2-speed').value);
      clock.onState = () => {
        const b = $('#p2-play');
        if (!b) return;
        b.textContent = clock.playing ? '⏸ 一時停止' : clock.t >= clock.max ? '↻ もういちど' : '▶ つづける';
      };
      $('#p2-play').addEventListener('click', () => { clock.playing ? clock.pause() : clock.play(); });
      $('#p2-replay').addEventListener('click', () => {
        clock.pause();
        ensureSim(true);
        goStep(state.step);   // 同じステップを作りなおす(経路が変わる)
      });
      $('#p2-speed').addEventListener('change', (e) => { clock.rate = parseFloat(e.target.value); });
      $('#p2-seek').addEventListener('input', (e) => { clock.pause(); clock.seek(parseFloat(e.target.value)); });
      clock.t = 0;
      renderSend(0);
      clock.play();
    }

    function renderSend(t) {
      const sim = ui.sim;
      if (!sim || !ui.logEl || !$('#net2')) return;
      const active = new Set();
      sim.journeys.forEach((j) => {
        const p = posAlong(j.legs, t, NODES);
        if (!p) {
          j.el.style.display = 'none';
        } else {
          j.el.style.display = '';
          j.el.setAttribute('transform', 'translate(' + p.x.toFixed(1) + ',' + p.y.toFixed(1) + ')');
          if (p.leg >= 1 && !p.waiting && t - j.legs[p.leg].t0 < 0.22) active.add(j.legs[p.leg].from);
        }
        if (j.lostMarker) j.lostMarker.el.style.display = t >= j.lostMarker.t && t < j.lostMarker.t + 1.8 ? '' : 'none';
      });
      Object.keys(ui.nodeEls).forEach((id) => {
        if (id !== 'PC' && id !== 'SRV') ui.nodeEls[id].setAttribute('class', 'nd' + (active.has(id) ? ' active' : ''));
      });

      const got = sim.arrivals.filter((a) => a.t <= t);
      // 受信の入れもの
      const byNo = {};
      got.forEach((a) => { byNo[a.no] = a; });
      ui.slots.forEach((s, i) => {
        const a = byNo[i + 1];
        const on = !!a;
        if (on && !s.classList.contains('on')) { s.classList.add('on'); s.style.background = a.color; }
        if (!on && s.classList.contains('on')) { s.classList.remove('on'); s.style.background = ''; }
      });
      // 届いた順
      if (got.length !== ui.chipCount) {
        ui.chipCount = got.length;
        ui.chips.innerHTML = got.length
          ? got.map((a) => '<span class="chip' + (a.retrans ? ' re' : '') + '" style="background:' + a.color + '">' + a.no + '</span>').join('')
          : '<span class="empty-note">まだ何も届いていません</span>';
      }
      // ログ
      const shown = sim.events.filter((e) => e.t <= t);
      if (shown.length !== ui.logCount) {
        ui.logCount = shown.length;
        ui.logEl.innerHTML = shown.map((e) => '<li class="' + (e.cls || '') + '">' + e.text + '</li>').join('');
        ui.logEl.scrollTop = ui.logEl.scrollHeight;
      }
      const seek = $('#p2-seek');
      if (seek) seek.value = String(t);
      const done = $('#p2-done');
      if (done) done.hidden = t < sim.T - 0.8;
    }

    /* --- 画面の切りかえ --- */
    function goStep(n) {
      ui.clock.pause();
      ui.clock.onState = null;
      ui.sim = null;
      state.step = clamp(n, 0, STEPS.length - 1);
      const id = STEPS[state.step].id;
      const c = renderStepContent(id);
      $('#p2-no').textContent = String(state.step + 1);
      $('#p2-title').textContent = c.title;
      $('#p2-lead').textContent = c.lead;
      $('#p2-body').innerHTML = c.html;
      $('#p2-point').textContent = c.point;
      $('#p2-prev').disabled = state.step === 0;
      $('#p2-next').textContent = state.step === STEPS.length - 1 ? '↺ 最初から' : '次へ ▶';
      renderStepper();
      if (c.after) c.after();
    }

    function renderStepper() {
      const ol = $('#p2-stepper');
      ol.innerHTML = STEPS.map((s, i) =>
        '<li><button type="button" data-i="' + i + '" class="' + (i === state.step ? 'now' : i < state.step ? 'done' : '') + '"' +
        (i === state.step ? ' aria-current="step"' : '') + '><span class="n">' + (i + 1) + '</span>' + s.short + '</button></li>'
      ).join('');
      $$('button', ol).forEach((b) => b.addEventListener('click', () => goStep(Number(b.dataset.i))));
    }

    function renderSummary() {
      const a = plan(state.size, false), b = plan(state.size, true);
      const cs = state.compress ? 'sel' : '', ns = state.compress ? '' : 'sel';
      const row = (label, x, y, unit) =>
        '<tr><th>' + label + '</th><td class="num ' + ns + '">' + fmt(x) + ' ' + unit + '</td><td class="num ' + cs + '">' + fmt(y) + ' ' + unit + '</td></tr>';
      const cut = Math.round((1 - b.total / a.total) * 100);
      $('#p2-summary').innerHTML =
        '<thead><tr><th>' + a.kind.icon + ' ' + a.kind.name + '</th><th class="' + ns + '">圧縮しない</th><th class="' + cs + '">圧縮する</th></tr></thead><tbody>' +
        row('元のデータの大きさ', a.orig, b.orig, 'バイト') +
        row('送るデータの大きさ', a.sendBytes, b.sendBytes, 'バイト') +
        row('パケットの数', a.count, b.count, '個') +
        row('ヘッダの合計(' + HDR + 'バイト×個数)', a.headerTotal, b.headerTotal, 'バイト') +
        row('ネットワークに流れる合計', a.total, b.total, 'バイト') +
        '<tr><th>圧縮したときの変化</th><td colspan="2">流れるデータが約 <b>' + cut + '%</b> 減る(' + fmt(a.total) + ' → ' + fmt(b.total) + ' バイト)</td></tr></tbody>';
    }

    function settingsChanged() {
      state.size = ($('input[name="p2size"]:checked') || { value: 'small' }).value;
      state.compress = $('#p2-compress').checked;
      state.loss = $('#p2-loss').checked;
      state.sim = null;
      renderSummary();
      goStep(state.step);
    }

    function init() {
      ui.clock = new Clock(renderSend);
      stopAll.push(() => ui.clock.pause());
      $$('input[name="p2size"]').forEach((r) => r.addEventListener('change', settingsChanged));
      $('#p2-compress').addEventListener('change', settingsChanged);
      $('#p2-loss').addEventListener('change', settingsChanged);
      $('#p2-prev').addEventListener('click', () => goStep(state.step - 1));
      $('#p2-next').addEventListener('click', () => goStep(state.step === STEPS.length - 1 ? 0 : state.step + 1));
      renderSummary();
      goStep(0);
    }

    return { init };
  })();


  /* ==========================================================
     第3部: 3つの送信元 → 3つの宛先(圧縮しない / する をくらべる)
     ========================================================== */
  const P3 = (function () {
    const W = 640, H = 330;
    const COL = ['#1d6fe0', '#ee6a1f', '#c2255c'];
    const NODES = {
      S1: { x: 44,  y: 60 },  S2: { x: 44,  y: 165 }, S3: { x: 44,  y: 270 },
      R1: { x: 175, y: 165 },
      M1: { x: 325, y: 60 },  M2: { x: 325, y: 165 }, M3: { x: 325, y: 270 },
      R2: { x: 470, y: 165 },
      D1: { x: 585, y: 60 },  D2: { x: 585, y: 165 }, D3: { x: 585, y: 270 }
    };
    const LINKS = [
      ['S1', 'R1'], ['S2', 'R1'], ['S3', 'R1'],
      ['R1', 'M1'], ['R1', 'M2'], ['R1', 'M3'],
      ['M1', 'R2'], ['M2', 'R2'], ['M3', 'R2'],
      ['R2', 'D1'], ['R2', 'D2'], ['R2', 'D3']
    ];
    // 回線の速さ(バイト/秒)と、電気信号が届くまでの時間(秒)。わかりやすくするための設定
    const ACC = 9000;                  // 送信元・宛先まわりの回線
    const MID = 2200;                  // ルータのあいだ(3本の経路。ここが混みやすい)
    const PACC = 0.12;
    const PROUTE = [0.30, 0.12, 0.45]; // 上・中・下の経路の長さのちがい

    /* --- 通信のシミュレーション(パケット単位) --- */
    function simulate(sizeKeys, compress) {
      const plans = sizeKeys.map((k) => makePlan(k, compress));
      const packets = [];
      plans.forEach((pl, s) => pl.chunks.forEach((c, i) => {
        packets.push({ s: s, i: i, no: i + 1, total: pl.count, wire: c + HDR });
      }));

      // ① 送信元 → ルータR1(送信元ごとに1本の回線。1つずつ順番に送り出す)
      const up = [0, 0, 0];
      packets.forEach((p) => {
        p.t1s = up[p.s];
        const tx = p.wire / ACC;
        up[p.s] = p.t1s + tx;
        p.arrR1 = p.t1s + tx + PACC;
      });

      // ② R1で、すいている経路を選んで送り出す(先に着いたパケットから)
      const order = packets.slice().sort((a, b) => a.arrR1 - b.arrR1 || a.s - b.s || a.i - b.i);
      const f1 = [0, 0, 0], f2 = [0, 0, 0];
      let busy = 0;
      order.forEach((p) => {
        let best = null;
        for (let k = 0; k < 3; k++) {
          const s1 = Math.max(p.arrR1, f1[k]);
          const tx = p.wire / MID;
          const arrM = s1 + tx + PROUTE[k];
          const s2 = Math.max(arrM, f2[k]);
          const arr2 = s2 + tx + PROUTE[k];
          if (!best || arr2 < best.arr2 - 1e-9) best = { k: k, s1: s1, arrM: arrM, s2: s2, arr2: arr2, tx: tx };
        }
        f1[best.k] = best.s1 + best.tx;
        f2[best.k] = best.s2 + best.tx;
        busy += best.tx;
        p.route = best.k; p.s1 = best.s1; p.arrM = best.arrM; p.s2 = best.s2; p.arrR2 = best.arr2;
      });

      // ③ R2 → 宛先(宛先ごとに1本の回線)
      const dfree = [0, 0, 0];
      packets.slice().sort((a, b) => a.arrR2 - b.arrR2 || a.s - b.s || a.i - b.i).forEach((p) => {
        p.s3 = Math.max(p.arrR2, dfree[p.s]);
        const tx = p.wire / ACC;
        dfree[p.s] = p.s3 + tx;
        p.arrD = p.s3 + tx + PACC;
      });

      packets.forEach((p) => {
        const S = 'S' + (p.s + 1), M = 'M' + (p.route + 1), D = 'D' + (p.s + 1);
        p.legs = [
          { from: S,    to: 'R1', t0: p.t1s, t1: p.arrR1 },
          { from: 'R1', to: M,    t0: p.s1,  t1: p.arrM },
          { from: M,    to: 'R2', t0: p.s2,  t1: p.arrR2 },
          { from: 'R2', to: D,    t0: p.s3,  t1: p.arrD }
        ];
      });

      const endS = [0, 1, 2].map((s) => Math.max.apply(null, packets.filter((p) => p.s === s).map((p) => p.arrD)));
      const end = Math.max.apply(null, endS);
      const wireBytes = packets.reduce((a, p) => a + p.wire, 0);

      // 順番待ちの最大数・順番が入れかわったパケット数
      const marks = [];
      packets.forEach((p) => { if (p.s1 > p.arrR1 + 1e-6) { marks.push([p.arrR1, 1]); marks.push([p.s1, -1]); } });
      marks.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
      let q = 0, maxQ = 0;
      marks.forEach((m) => { q += m[1]; if (q > maxQ) maxQ = q; });
      let ooo = 0;
      [0, 1, 2].forEach((s) => {
        let mx = 0;
        packets.filter((p) => p.s === s).sort((a, b) => a.arrD - b.arrD).forEach((p) => {
          if (p.no < mx) ooo++;
          mx = Math.max(mx, p.no);
        });
      });

      const events = [{ t: 0, text: '3つの送信元が、同時にパケットを送りはじめる' }];
      const firstWait = packets.filter((p) => p.s1 > p.arrR1 + 1e-6).sort((a, b) => a.arrR1 - b.arrR1)[0];
      if (firstWait) events.push({ t: firstWait.arrR1, cls: 'warn', text: 'ルータR1で、経路があくのを待つパケットが出てきた(順番待ち)' });
      endS.forEach((te, s) => events.push({ t: te, cls: 'good', text: '送信元' + (s + 1) + 'のデータが、すべて宛先' + (s + 1) + 'に届いた' }));
      if (ooo > 0) events.push({ t: end, text: '別々の経路を通ったので、順番が入れかわったパケットが ' + ooo + ' 個。ヘッダの番号で、元の順にならべ直す' });
      events.sort((a, b) => a.t - b.t);

      return {
        packets, plans, endS, end, wireBytes, maxQ, ooo, events,
        count: packets.length,
        busyPct: Math.round((busy / (3 * end)) * 100)
      };
    }

    /* --- 図(パネル) --- */
    function createPanel(tag) {
      const host = $('#net3-' + tag), logEl = $('#log3-' + tag), stEl = $('#status3-' + tag);
      const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'net-svg net3', role: 'img',
        'aria-label': '3つの送信元から3つの宛先へ、パケットが3本の経路を通って届く図' });
      host.appendChild(svg);
      const gL = svgEl('g'), gN = svgEl('g'), gT = svgEl('g'), gD = svgEl('g');
      [gL, gN, gT, gD].forEach((g) => svg.appendChild(g));

      const linkEls = {};
      LINKS.forEach((l) => {
        const ln = svgEl('line', { x1: NODES[l[0]].x, y1: NODES[l[0]].y, x2: NODES[l[1]].x, y2: NODES[l[1]].y, class: 'link3' });
        gL.appendChild(ln);
        linkEls[l[0] + '-' + l[1]] = ln;
      });

      const sendTxt = [], recvTxt = [], barFg = [];
      [0, 1, 2].forEach((s) => {
        const n = NODES['S' + (s + 1)];
        const g = svgEl('g', { transform: 'translate(' + n.x + ',' + n.y + ')', class: 'node-n' });
        g.appendChild(svgEl('circle', { r: 20, fill: COL[s] }));
        g.appendChild(svgEl('text', { y: 7, 'text-anchor': 'middle' }, String(s + 1)));
        gN.appendChild(g);
        const t = svgEl('text', { x: n.x, y: n.y - 30, 'text-anchor': 'middle', class: 'cnt' }, '');
        gT.appendChild(t);
        sendTxt.push(t);
        gT.appendChild(svgEl('text', { x: n.x, y: n.y + 38, 'text-anchor': 'middle', class: 'cap' }, '送信元'));

        const d = NODES['D' + (s + 1)];
        const gd = svgEl('g', { transform: 'translate(' + d.x + ',' + d.y + ')', class: 'node-n' });
        gd.appendChild(svgEl('rect', { x: -20, y: -20, width: 40, height: 40, rx: 9, fill: COL[s] }));
        gd.appendChild(svgEl('text', { y: 7, 'text-anchor': 'middle' }, String(s + 1)));
        gN.appendChild(gd);
        const rt = svgEl('text', { x: d.x, y: d.y - 28, 'text-anchor': 'middle', class: 'cnt' }, '');
        gT.appendChild(rt);
        recvTxt.push(rt);
        gT.appendChild(svgEl('rect', { x: d.x - 30, y: d.y + 27, width: 60, height: 8, rx: 3, class: 'bar-bg' }));
        const fg = svgEl('rect', { x: d.x - 30, y: d.y + 27, width: 0, height: 8, rx: 3, fill: COL[s], class: 'bar-fg' });
        gT.appendChild(fg);
        barFg.push(fg);
        gT.appendChild(svgEl('text', { x: d.x, y: d.y + 50, 'text-anchor': 'middle', class: 'cap' }, '宛先'));
      });
      ['R1', 'R2', 'M1', 'M2', 'M3'].forEach((id) => {
        const n = NODES[id];
        const g = svgEl('g', { transform: 'translate(' + n.x + ',' + n.y + ')', class: 'node-r' });
        g.appendChild(svgEl('rect', { x: -30, y: -15, width: 60, height: 30, rx: 8 }));
        g.appendChild(svgEl('text', { y: 5, 'text-anchor': 'middle' }, 'ルータ'));
        gN.appendChild(g);
      });
      const qTxt = {};
      ['R1', 'R2'].forEach((id) => {
        const t = svgEl('text', { x: NODES[id].x, y: NODES[id].y + 36, 'text-anchor': 'middle', class: 'cnt q' }, '');
        gT.appendChild(t);
        qTxt[id] = t;
      });
      gT.appendChild(svgEl('text', { x: 325, y: 22, 'text-anchor': 'middle', class: 'cap' }, '3つの経路(すいている経路を選ぶ)'));

      let data = null, logCount = -1;

      function load(d) {
        data = d; logCount = -1;
        clearEl(gD); clearEl(logEl);
        d.packets.forEach((p) => {
          const g = svgEl('g');
          g.appendChild(svgEl('rect', { x: -10, y: -8, width: 20, height: 16, rx: 3, fill: COL[p.s], stroke: '#fff', 'stroke-width': 1 }));
          g.appendChild(svgEl('text', { y: 4, 'text-anchor': 'middle', class: 'dot3-t' }, String(p.no)));
          g.style.display = 'none';
          gD.appendChild(g);
          p.el = g;
        });
      }

      function render(t) {
        if (!data) return;
        Object.keys(linkEls).forEach((id) => linkEls[id].setAttribute('class', 'link3'));
        const wait = { R1: [], R2: [] };
        const rem = [0, 0, 0], got = [0, 0, 0];
        data.packets.forEach((p) => {
          if (t < p.t1s) rem[p.s]++;
          if (t >= p.arrD) got[p.s]++;
          const pos = posAlong(p.legs, t, NODES);
          if (!pos) { p.el.style.display = 'none'; return; }
          p.el.style.display = '';
          if (pos.waiting && wait[pos.node]) { wait[pos.node].push(p); return; }
          p.el.setAttribute('transform', 'translate(' + pos.x.toFixed(1) + ',' + pos.y.toFixed(1) + ')');
          if (!pos.waiting) {
            const L = p.legs[pos.leg];
            const ln = linkEls[L.from + '-' + L.to];
            if (ln) ln.setAttribute('class', 'link3 use-' + (p.s + 1));
          }
        });
        ['R1', 'R2'].forEach((id) => {
          const key = id === 'R1' ? 1 : 3;
          const list = wait[id].sort((a, b) => a.legs[key].t0 - b.legs[key].t0);
          list.forEach((p, rank) => {
            if (rank < 7) p.el.setAttribute('transform', 'translate(' + NODES[id].x + ',' + (NODES[id].y - 34 - rank * 15) + ')');
            else p.el.style.display = 'none';
          });
          qTxt[id].textContent = list.length ? '順番待ち ' + list.length + '個' : '';
        });
        [0, 1, 2].forEach((s) => {
          const total = data.plans[s].count;
          sendTxt[s].textContent = rem[s] > 0 ? '送信待ち ' + rem[s] + '個' : '送信ずみ';
          recvTxt[s].textContent = '受信 ' + got[s] + '/' + total;
          barFg[s].setAttribute('width', String((60 * got[s]) / total));
        });
        stEl.textContent = t >= data.end ? '✔ すべて届いた(' + data.end.toFixed(1) + ' 秒)' : '通信中…';
        const shown = data.events.filter((e) => e.t <= t);
        if (shown.length !== logCount) {
          logCount = shown.length;
          logEl.innerHTML = shown.length
            ? shown.map((e) => '<li class="' + (e.cls || '') + '"><span class="t">' + e.t.toFixed(1) + '秒</span>' + e.text + '</li>').join('')
            : '<li class="empty">「スタート」をおすと、ここに動きの説明が出ます</li>';
          logEl.scrollTop = logEl.scrollHeight;
        }
      }
      return { load, render };
    }

    /* --- コントローラ --- */
    let off, on, dOff, dOn, Tmax = 10, clock, sizes = ['small', 'medium', 'large'];
    const sec = (v) => v.toFixed(1) + ' 秒';

    function init() {
      off = createPanel('off');
      on = createPanel('on');
      clock = new Clock(onFrame);
      clock.rate = parseFloat($('#p3-speed').value);
      clock.onState = updatePlayLabel;
      $('#p3-play').addEventListener('click', () => { clock.playing ? clock.pause() : clock.play(); });
      $('#p3-step').addEventListener('click', () => { clock.pause(); clock.seek(clock.t + 0.5); });
      $('#p3-reset').addEventListener('click', () => clock.reset());
      $('#p3-speed').addEventListener('change', (e) => { clock.rate = parseFloat(e.target.value); });
      $('#p3-seek').addEventListener('input', (e) => { clock.pause(); clock.seek(parseFloat(e.target.value)); });
      [1, 2, 3].forEach((i) => $('#p3-size' + i).addEventListener('change', rebuild));
      stopAll.push(() => clock.pause());
      rebuild();
    }

    function rebuild() {
      sizes = [1, 2, 3].map((i) => $('#p3-size' + i).value);
      dOff = simulate(sizes, false);
      dOn = simulate(sizes, true);
      Tmax = Math.max(dOff.end, dOn.end) + 0.8;
      clock.max = Tmax;
      $('#p3-seek').max = Tmax.toFixed(2);
      off.load(dOff);
      on.load(dOn);
      $('#p3-plan').textContent = [0, 1, 2].map((s) =>
        '送信元' + (s + 1) + ':' + KINDS[sizes[s]].icon + ' ' + fmt(KINDS[sizes[s]].bytes) + 'バイト → ' + dOff.plans[s].count + '個のパケット(圧縮すると ' + dOn.plans[s].count + '個)'
      ).join(' ／ ');
      buildResult();
      clock.reset();
    }

    function buildResult() {
      const row = (label, idA, idB, idC) =>
        '<tr><th>' + label + '</th><td class="num" id="' + idA + '">…</td><td class="num" id="' + idB + '">…</td><td class="num" id="' + idC + '">…</td></tr>';
      let h = '<thead><tr><th></th><th class="c-circuit">圧縮しない</th><th class="c-packet">圧縮する</th><th>変化</th></tr></thead><tbody>';
      [0, 1, 2].forEach((s) => { h += row('送信元' + (s + 1) + 'が全部届いた時刻', 'p3-e' + s + '-a', 'p3-e' + s + '-b', 'p3-e' + s + '-c'); });
      h += row('3つとも届いた時刻', 'p3-end-a', 'p3-end-b', 'p3-end-c');
      h += row('パケットの総数', 'p3-cnt-a', 'p3-cnt-b', 'p3-cnt-c');
      h += row('ネットワークに流れた量', 'p3-byte-a', 'p3-byte-b', 'p3-byte-c');
      h += row('ルータの順番待ちの最大', 'p3-q-a', 'p3-q-b', 'p3-q-c');
      h += row('中央の回線の混みぐあい', 'p3-busy-a', 'p3-busy-b', 'p3-busy-c');
      $('#p3-result').innerHTML = h + '</tbody>';
    }

    function updatePlayLabel() {
      const b = $('#p3-play');
      if (clock.playing) b.textContent = '⏸ 一時停止';
      else if (clock.t >= clock.max) b.textContent = '↻ もういちど';
      else if (clock.t > 0) b.textContent = '▶ つづける';
      else b.textContent = '▶ スタート';
    }

    function onFrame(t) {
      off.render(t);
      on.render(t);
      $('#p3-seek').value = String(t);
      $('#p3-clock').textContent = sec(t);
      const set = (id, v) => { $('#' + id).textContent = v; };
      const timeCell = (idBase, a, b) => {
        set(idBase + '-a', t >= a ? sec(a) : '…');
        set(idBase + '-b', t >= b ? sec(b) : '…');
        set(idBase + '-c', t >= a && t >= b ? (b < a ? '−' + (a - b).toFixed(1) + ' 秒' : '±0') : '…');
      };
      [0, 1, 2].forEach((s) => timeCell('p3-e' + s, dOff.endS[s], dOn.endS[s]));
      timeCell('p3-end', dOff.end, dOn.end);
      const pctOf = (a, b) => (b < a ? '−' + Math.round((1 - b / a) * 100) + '%' : '±0');
      set('p3-cnt-a', fmt(dOff.count) + ' 個'); set('p3-cnt-b', fmt(dOn.count) + ' 個'); set('p3-cnt-c', pctOf(dOff.count, dOn.count));
      set('p3-byte-a', fmt(dOff.wireBytes) + ' B'); set('p3-byte-b', fmt(dOn.wireBytes) + ' B'); set('p3-byte-c', pctOf(dOff.wireBytes, dOn.wireBytes));
      set('p3-q-a', dOff.maxQ + ' 個'); set('p3-q-b', dOn.maxQ + ' 個'); set('p3-q-c', dOn.maxQ < dOff.maxQ ? '−' + (dOff.maxQ - dOn.maxQ) + ' 個' : '±0');
      set('p3-busy-a', dOff.busyPct + ' %'); set('p3-busy-b', dOn.busyPct + ' %'); set('p3-busy-c', dOn.busyPct < dOff.busyPct ? '−' + (dOff.busyPct - dOn.busyPct) + ' pt' : '±0');
      const tk = $('#p3-takeaway');
      if (t >= Math.max(dOff.end, dOn.end)) {
        const pct = Math.round((1 - dOn.end / dOff.end) * 100);
        tk.textContent = '圧縮すると、パケットの数は ' + dOff.count + ' 個から ' + dOn.count + ' 個に減り、3つとも届くまでの時間は ' + sec(dOff.end) + ' から ' + sec(dOn.end) +
          ' になりました(約 ' + pct + '% 短い)。ネットワークに流れる量が減ったので、ルータの順番待ちも短くなっています。';
        tk.hidden = false;
      } else {
        tk.hidden = true;
      }
    }

    return { init };
  })();

  /* ==========================================================
     第4部: 通信品質(有線LAN と 無線LAN / 圧縮 / 目的にあわせた選択)
     ========================================================== */
  const P4 = (function () {
    // 通信路のモデル(学習用の目安の数値)
    const WIRED = { key: 'wired', name: '有線LAN', icon: '🔌', mbps: 100, lat: 2, jit: 1, loss: 0.0001 };
    const WIFI = {
      good:   { name: '良好',   mbps: 50, lat: 6,  jit: 4,  loss: 0.005 },
      normal: { name: 'ふつう', mbps: 25, lat: 12, jit: 12, loss: 0.02 },
      bad:    { name: '悪い',   mbps: 6,  lat: 30, jit: 40, loss: 0.08 }
    };
    const MODE_NAME = { none: '圧縮しない', lossless: '可逆圧縮', lossy: '強く圧縮' };
    const CRIT = { E: '早さ(所要時間)', Ld: '回線への負担の小ささ', C: '手軽さ(ケーブル不要)', L: '遅れの小ささ', S: '安定(途切れにくさ)', Q: '画質・正確さ' };
    const CRIT_SHORT = { E: '早さ', Ld: '回線への負担の小ささ', C: '手軽さ', L: '遅れの小ささ', S: '安定', Q: '画質・正確さ' };

    // 目的ごとの設定。size=元のデータの大きさ(MB) / w=何を大事にするか(合計1)
    const SCEN = [
      { key: 'photo', icon: '📷', title: '友だちに写真を送る', who: '相手:友だち', goal: '思い出の写真を、すぐに見てもらいたい',
        size: 24, stream: false, lossless: 0.5, lossy: 0.08, lossyQ: 78,
        w: { E: 0.25, Ld: 0.10, C: 0.15, L: 0.05, S: 0.10, Q: 0.35 }, good: 2, max: 60, latGood: 100, latMax: 1000,
        note: '写真は、少し画質が下がっても気にならないことが多い一方、大切な写真はきれいに残したいものです。電波がよければ、無線LANで可逆圧縮でも十分早く届きます。電波が悪いときは、有線につなぐか、強く圧縮して軽くするのが効きます。' },
      { key: 'report', icon: '📄', title: '先生にレポートを提出する', who: '相手:先生', goal: '1文字もまちがえず、確実に届けたい',
        size: 8, stream: false, lossless: 0.45, lossy: 0, lossyQ: 0,
        w: { E: 0.15, Ld: 0.10, C: 0.05, L: 0, S: 0.20, Q: 0.50 }, good: 2, max: 30, latGood: 100, latMax: 1000,
        note: '文書は1文字でも変わると困るので、元にもどせない「強い圧縮」は使えません。可逆圧縮で軽くして、安定した回線で確実に送るのが安心です。方法による点数の差が小さいときは、手軽さで選んでもかまいません。' },
      { key: 'call', icon: '🎥', title: 'ビデオ通話で話す', who: '相手:会議の相手', goal: 'とぎれず、遅れずに顔を見て話したい',
        size: 240, stream: true, dur: 60, lossless: 0.6, lossy: 0.03, lossyQ: 65,
        w: { E: 0.25, Ld: 0.10, C: 0.05, L: 0.25, S: 0.20, Q: 0.15 }, good: 30, max: 60, latGood: 40, latMax: 200,
        note: '通話は「1分ぶんの映像を1分以内に送れるか」が大事です。圧縮しないと回線に入りきらず、とぎれることがあります。回線がせまいほど強い圧縮が役に立ちますが、そのぶん画質は下がります。回線の状態にあわせて選びます。' },
      { key: 'game', icon: '🎮', title: 'オンライン対戦ゲームをする', who: '相手:ゲーム仲間', goal: '一瞬の遅れもなく、操作を伝えたい',
        size: 6, stream: true, dur: 60, lossless: 0.85, lossy: 0, lossyQ: 0,
        w: { E: 0.05, Ld: 0.05, C: 0.05, L: 0.45, S: 0.30, Q: 0.10 }, good: 30, max: 60, latGood: 5, latMax: 100,
        note: 'ゲームのデータは小さいので、圧縮してもほとんど小さくなりません。むしろ圧縮の処理で遅れが増えます。遅れとゆらぎが小さい有線LANが有利で、無線LANは電波がよい間だけ張りあえます。' }
    ];

    const state = { scen: 'photo', size: 24, env: 'normal', media: 'wifi', mode: 'none', reveal: false };
    const curScen = () => SCEN.filter((s) => s.key === state.scen)[0];
    const RACE_DUR = 10;
    let list = [], best = null, bestBy = {}, maxT = 1, laneEls = [], clock = null;

    /* --- 数値の表示 --- */
    function fmtSec(s) {
      if (s < 10) return s.toFixed(2) + ' 秒';
      if (s < 60) return s.toFixed(1) + ' 秒';
      let m = Math.floor(s / 60), r = Math.round(s - m * 60);
      if (r === 60) { m += 1; r = 0; }
      if (m >= 60) return Math.floor(m / 60) + '時間' + (m % 60) + '分';
      return m + '分' + String(r).padStart(2, '0') + '秒';
    }
    function fmtMB(bytes) {
      const mb = bytes / 1e6;
      const s = mb >= 100 ? String(Math.round(mb)) : mb >= 10 ? mb.toFixed(1) : mb >= 1 ? mb.toFixed(2) : mb.toFixed(3);
      return Number(s).toLocaleString('ja-JP') + ' MB';
    }
    const sizeFromSlider = (v) => {
      const mb = Math.pow(10, (v / 100) * 2.7);
      return mb < 10 ? Math.round(mb * 10) / 10 : mb < 100 ? Math.round(mb) : Math.round(mb / 10) * 10;
    };
    const sliderFromSize = (mb) => Math.round((Math.log(mb) / Math.LN10 / 2.7) * 100);

    /* --- 1つの組み合わせを評価する --- */
    function evaluate(sc, mediaKey, mode, sizeMB) {
      const M = mediaKey === 'wired' ? WIRED : WIFI[state.env];
      const raw = sizeMB * 1e6;
      const ratio = mode === 'none' ? 1 : mode === 'lossless' ? sc.lossless : sc.lossy;
      const sendBytes = Math.round(raw * ratio);
      const packets = Math.max(1, Math.ceil(sendBytes / MSS));
      const header = packets * HDR;
      const wire = sendBytes + header;
      const factor = 1 / (1 - M.loss);
      const retrans = wire * (factor - 1);
      const total = wire + retrans;
      const retransPackets = Math.round(packets * (factor - 1));
      const tTransfer = (total * 8) / (M.mbps * 1e6);
      const cpu = mode === 'none' || sc.stream ? 0 : sizeMB * (mode === 'lossless' ? 0.03 : 0.08);
      const T = tTransfer + cpu;
      const procDelay = !sc.stream ? 0 : mode === 'none' ? 0 : mode === 'lossless' ? 8 : 25;
      const lat = M.lat + M.jit + procDelay;
      const stall = sc.stream ? Math.max(0, 1 - sc.dur / tTransfer) : 0;

      const E = clamp(100 * (1 - (T - sc.good) / (sc.max - sc.good)), 0, 100);
      const Ld = clamp(100 * (1 - total / raw), 0, 100);
      const L = clamp(100 * (1 - (lat - sc.latGood) / (sc.latMax - sc.latGood)), 0, 100);
      const S = clamp(100 - M.jit - M.loss * 100 * 5, 0, 100);
      const Q = (mode === 'lossy' ? sc.lossyQ : 100) * (1 - stall);
      const C = mediaKey === 'wired' ? 30 : 100;   // 有線はケーブルが必要、無線はどこでも使える
      const w = sc.w;
      const X = (w.E * E + w.Ld * Ld + w.C * C) / (w.E + w.Ld + w.C);
      const Y = (w.L * L + w.S * S + w.Q * Q) / (w.L + w.S + w.Q);
      const score = w.E * E + w.Ld * Ld + w.C * C + w.L * L + w.S * S + w.Q * Q;
      return { M, raw, sendBytes, packets, header, retrans, total, retransPackets, tTransfer, T, lat, stall, E, Ld, C, L, S, Q, X, Y, score };
    }

    function comboName(c) {
      return (c.media === 'wired' ? '有線LAN' : '無線LAN(' + WIFI[state.env].name + ')') + '・' + MODE_NAME[c.mode];
    }

    function compute() {
      const sc = curScen();
      list = [];
      ['wired', 'wifi'].forEach((m) => ['none', 'lossless', 'lossy'].forEach((mode) => {
        if (mode === 'lossy' && !sc.lossy) return;
        list.push(Object.assign({ id: m + '-' + mode, media: m, mode: mode }, evaluate(sc, m, mode, state.size)));
      }));
      list.forEach((c, i) => { c.letter = 'ABCDEF'[i]; });
      best = list.slice().sort((a, b) => b.score - a.score)[0];
      bestBy = {};
      ['wired', 'wifi'].forEach((m) => { bestBy[m] = list.filter((c) => c.media === m).sort((a, b) => b.score - a.score)[0]; });
      maxT = Math.max.apply(null, list.map((c) => c.T));
    }
    const selected = () => list.filter((c) => c.media === state.media && c.mode === state.mode)[0] || list[0];

    /* --- 画面のつくり --- */
    function renderScen() {
      $('#p4-scen').innerHTML = SCEN.map((s) =>
        '<button type="button" class="scen" data-k="' + s.key + '" aria-pressed="' + (s.key === state.scen) + '">' +
        '<span class="ic">' + s.icon + '</span><b>' + s.title + '</b><small>' + s.who + '</small><small>' + s.goal + '</small></button>').join('');
      $$('#p4-scen .scen').forEach((b) => b.addEventListener('click', () => {
        state.scen = b.dataset.k;
        const sc = curScen();
        state.size = sc.size;
        if (state.mode === 'lossy' && !sc.lossy) state.mode = 'lossless';
        state.reveal = false;
        syncInputs();
        renderScen();
        recompute();
      }));
      const sc = curScen();
      const stars = (w) => (w >= 0.4 ? '★★★' : w >= 0.2 ? '★★' : '★');
      $('#p4-prio').innerHTML = 'この目的で大事なこと: ' + ['E', 'Ld', 'C', 'L', 'S', 'Q']
        .filter((k) => sc.w[k] >= 0.1).sort((a, b) => sc.w[b] - sc.w[a])
        .map((k) => '<span class="tag">' + CRIT_SHORT[k] + '<span class="st">' + stars(sc.w[k]) + '</span></span>').join('');
    }

    function syncInputs() {
      const sc = curScen();
      $('#p4-size').value = String(sliderFromSize(state.size));
      $('#p4-size-out').textContent = fmtMB(state.size * 1e6);
      $('#p4-size-note').textContent = sc.stream
        ? '「' + sc.title + '」の、1分間ぶんのデータの量です(1分以内に送りきれないと、とぎれます)。'
        : '「' + sc.title + '」で送るファイルの大きさです。';
      $$('input[name="p4env"]').forEach((r) => { r.checked = r.value === state.env; });
      $$('input[name="p4media"]').forEach((r) => { r.checked = r.value === state.media; });
      const lossy = $('#p4-lossy');
      lossy.disabled = !sc.lossy;
      $$('input[name="p4mode"]').forEach((r) => { r.checked = r.value === state.mode; });
      $('#p4-lossy-note').textContent = sc.lossy ? '' : '※ この目的では、元にもどせない「強い圧縮」は使えません(内容が変わってしまうため)。';
    }

    function renderLanes() {
      const wrap = $('#p4-race');
      const sc = curScen();
      wrap.innerHTML = (sc.stream ? '<p class="legend" style="margin:0 4px;"><span class="dotkey" style="background:var(--bad)"></span>赤い点線 = 1分。ここまでに全部届かないと、映像や音がとぎれます</p>' : '') + list.map((c) =>
        '<div class="lane ' + c.media + '" data-id="' + c.id + '">' +
        '<div class="ll"><span class="chip-l">' + c.letter + '</span>' + (c.media === 'wired' ? '🔌' : '📶') + ' ' + comboName(c) + '</div>' +
        '<div class="lane-track"><div class="lane-fill"></div>' +
        (sc.stream ? '<i class="lane-mark" style="left:' + Math.min(100, (sc.dur / maxT) * 100) + '%"></i>' : '') + '</div>' +
        '<div class="lane-info"><b>0.00 秒</b><small></small></div></div>').join('');
      laneEls = $$('.lane', wrap);
      renderRace(clock ? clock.t : 0);
    }

    function renderRace(t) {
      const tSim = (t / RACE_DUR) * maxT;
      const sc = curScen();
      laneEls.forEach((el, i) => {
        const c = list[i];
        const p = clamp(tSim / c.T, 0, 1);
        $('.lane-fill', el).style.width = p * 100 + '%';
        const done = p >= 1;
        let info = '<b>' + (done ? '✔ ' + fmtSec(c.T) : fmtSec(tSim)) + '</b>';
        if (done && sc.stream && c.tTransfer > sc.dur) info += ' <span class="warn">⚠ とぎれる</span>';
        $('.lane-info', el).innerHTML = info + '<small>' + fmt(Math.round(c.packets * p)) + '/' + fmt(c.packets) + ' 個・再送 ' + fmt(Math.round(c.retransPackets * p)) + '</small>';
      });
    }

    function renderLoad() {
      const scale = 1.15;
      $('#p4-load').innerHTML = list.map((c) => {
        const d = (c.sendBytes / c.raw / scale) * 100, h = (c.header / c.raw / scale) * 100, r = (c.retrans / c.raw / scale) * 100;
        return '<div class="load-row" data-id="' + c.id + '"><div class="ll"><span class="chip-l">' + c.letter + '</span>' + comboName(c) + '</div>' +
          '<div class="load-track"><i class="d" style="width:' + d + '%"></i><i class="h" style="width:' + Math.max(h, 0.4) + '%"></i><i class="r" style="width:' + r + '%"></i>' +
          '<span class="ref" style="left:' + 100 / scale + '%"></span></div><span class="val">' + fmtMB(c.total) + '</span></div>';
      }).join('') + '<p class="fine" style="margin-top:2px;">点線 = 元のファイルの大きさ(' + fmtMB(state.size * 1e6) + ')。これより短いほど、回線への負担が小さい。</p>';
    }

    function renderLoadSum() {
      const c = selected();
      $('#p4-load-sum').innerHTML = 'あなたの選択(' + comboName(c) + '): 元 ' + fmtMB(c.raw) + ' → 送るデータ ' + fmtMB(c.sendBytes) +
        ' + ヘッダ ' + fmtMB(c.header) + '(' + fmt(c.packets) + '個×' + HDR + 'バイト)+ 再送 ' + fmtMB(c.retrans) + ' = 回線に流れる量 <b>' + fmtMB(c.total) +
        '</b>(元の ' + Math.round((c.total / c.raw) * 100) + '%)';
    }

    function renderTable() {
      const sc = curScen();
      const sel = selected();
      let h = '<thead><tr><th>組み合わせ</th><th>パケット数</th><th>流れる量</th><th>所要時間</th><th>遅れ</th><th>画質・正確さ</th><th>効率</th><th>品質</th><th>総合</th></tr></thead><tbody>';
      list.forEach((c) => {
        const cls = (c.id === sel.id ? 'mine ' : '') + (state.reveal && c.id === best.id ? 'best' : '');
        const timeTxt = fmtSec(c.T) + (sc.stream && c.tTransfer > sc.dur ? ' ⚠' : '');
        h += '<tr class="' + cls + '"><th><span class="chip-l">' + c.letter + '</span> ' + comboName(c) + (state.reveal && c.id === best.id ? ' ★' : '') + '</th>' +
          '<td class="r">' + fmt(c.packets) + '</td><td class="r">' + fmtMB(c.total) + '</td><td class="r">' + timeTxt + '</td>' +
          '<td class="r">' + Math.round(c.lat) + ' ms</td><td class="r">' + Math.round(c.Q) + '</td>' +
          '<td class="r">' + Math.round(c.X) + '</td><td class="r">' + Math.round(c.Y) + '</td><td class="r sc">' + Math.round(c.score) + '</td></tr>';
      });
      $('#p4-table').innerHTML = h + '</tbody>';
    }

    function renderChart() {
      const sel = selected();
      const x0 = 56, y0 = 300, w = 360, hgt = 280;
      const px = (v) => x0 + (v / 100) * w, py = (v) => y0 - (v / 100) * hgt;
      let s = '';
      [0, 25, 50, 75, 100].forEach((v) => {
        s += '<line class="gr" x1="' + px(v) + '" y1="' + y0 + '" x2="' + px(v) + '" y2="' + py(100) + '"/>' +
          '<line class="gr" x1="' + x0 + '" y1="' + py(v) + '" x2="' + px(100) + '" y2="' + py(v) + '"/>' +
          '<text class="tk" x="' + px(v) + '" y="' + (y0 + 16) + '" text-anchor="middle">' + v + '</text>' +
          '<text class="tk" x="' + (x0 - 8) + '" y="' + (py(v) + 4) + '" text-anchor="end">' + v + '</text>';
      });
      s += '<rect class="zone" x="' + px(75) + '" y="' + py(100) + '" width="' + (px(100) - px(75)) + '" height="' + (py(75) - py(100)) + '"/>' +
        '<text class="zt" x="' + (px(100) - 6) + '" y="' + (py(100) + 16) + '" text-anchor="end">理想</text>';
      s += '<line class="ax" x1="' + x0 + '" y1="' + y0 + '" x2="' + px(100) + '" y2="' + y0 + '"/><line class="ax" x1="' + x0 + '" y1="' + y0 + '" x2="' + x0 + '" y2="' + py(100) + '"/>';
      s += '<text class="al" x="' + (x0 + w / 2) + '" y="' + (y0 + 38) + '" text-anchor="middle">効率(早く・軽く・手軽に) →</text>';
      s += '<text class="al" transform="translate(14,' + (y0 - hgt / 2) + ') rotate(-90)" text-anchor="middle">品質(画質・正確さ・安定) →</text>';
      list.forEach((c) => {
        const cx = px(c.X), cy = py(c.Y);
        const fill = c.media === 'wired' ? '#12263a' : '#0d8a7a';
        if (c.id === sel.id) s += '<circle cx="' + cx + '" cy="' + cy + '" r="20" fill="#ffd84d" stroke="#12263a" stroke-width="3"/>';
        s += '<circle cx="' + cx + '" cy="' + cy + '" r="13" fill="' + fill + '"/><text class="pt-l" x="' + cx + '" y="' + (cy + 5) + '" text-anchor="middle">' + c.letter + '</text>';
        if (state.reveal && c.id === best.id) s += '<text x="' + cx + '" y="' + (cy - 20) + '" text-anchor="middle" font-size="22" fill="#d99a00" stroke="#12263a" stroke-width=".8">★</text>';
      });
      s += '<circle cx="' + (x0 + 8) + '" cy="' + (y0 - hgt - 2) + '" r="0"/>';
      $('#p4-chart').innerHTML = s +
        '<g transform="translate(' + (x0 + 6) + ',12)"><circle cx="6" cy="0" r="6" fill="#12263a"/><text x="16" y="4" font-size="12" fill="#12263a">有線LAN</text>' +
        '<circle cx="86" cy="0" r="6" fill="#0d8a7a"/><text x="96" y="4" font-size="12" fill="#12263a">無線LAN</text></g>';
    }

    function renderVerdict() {
      const sc = curScen(), c = selected(), w = sc.w;
      const stars = (v) => (v >= 0.4 ? '★★★' : v >= 0.2 ? '★★' : v >= 0.1 ? '★' : v > 0 ? '☆' : '−');
      let h = '<div class="score-head"><div class="big">' + Math.round(c.score) + '<small>点</small></div><div><b>' + comboName(c) + '</b><br><span class="fine">「' + sc.title + '」への合格度(100点満点)</span></div></div>';
      ['E', 'Ld', 'C', 'L', 'S', 'Q'].forEach((k) => {
        const v = c[k];
        const cls = v < 40 ? 'low' : v < 70 ? 'mid' : '';
        h += '<div class="crit"><span class="cn">' + CRIT[k] + ' <span class="st">' + stars(w[k]) + '</span></span><span class="cb"><i class="' + cls + '" style="width:' + v + '%"></i></span><span class="cv">' + Math.round(v) + '</span></div>';
      });
      h += '<p class="fine">★は、この目的での大事さです。大事なところの点が高い組み合わせがよい選択です。</p>';
      const rem = [];
      if (c.stall > 0) rem.push('⚠ 回線が追いつかず、途切れます(1分ぶんを送るのに ' + fmtSec(c.tTransfer) + 'かかる)');
      else if (c.E < 60 && w.E >= 0.1) rem.push('所要時間が長めです(' + fmtSec(c.T) + ')');
      if (w.L >= 0.2 && c.L < 70) rem.push('遅れが大きく、リアルタイムの通信には向きません(遅れ 約' + Math.round(c.lat) + 'ミリ秒)');
      if (w.S >= 0.2 && c.S < 70) rem.push('電波が不安定で、ゆらぎや再送が増えます');
      if (c.mode === 'lossy' && w.Q >= 0.2) rem.push('画質が下がります(元にもどせない圧縮です)');
      if (c.Ld < 30 && w.Ld >= 0.1) rem.push('回線に流れる量が多く、ほかの人の通信のじゃまになります');
      if (c.score >= 92) rem.push('✔ この目的に、とてもよく合っています');
      if (rem.length) h += '<ul class="remarks">' + rem.slice(0, 4).map((r) => '<li>' + r + '</li>').join('') + '</ul>';
      if (state.reveal) {
        const diff = Math.round(best.score - c.score);
        h += '<div class="answer"><b class="star">★ いちばんバランスのよい組み合わせ:</b> <b>' + comboName(best) + '(' + Math.round(best.score) + '点)</b><br>' +
          (best.id === c.id ? 'あなたの選択が、ぴったりでした!' : 'あなたの選択との差: ' + diff + '点') +
          '<br><span class="fine">回線を有線にする場合のベスト: ' + MODE_NAME[bestBy.wired.mode] + '(' + Math.round(bestBy.wired.score) + '点) / 無線にする場合のベスト: ' + MODE_NAME[bestBy.wifi.mode] + '(' + Math.round(bestBy.wifi.score) + '点)</span><br>' + sc.note +
          '<br><span class="fine">電波の状態や、データの大きさを変えると、答えが変わることがあります。ためしてみよう。</span></div>';
      }
      $('#p4-verdict').innerHTML = h;
      $('#p4-reveal').textContent = state.reveal ? '答えをかくす' : '答え合わせ:いちばんバランスのよい組み合わせは?';
    }

    function markSelection() {
      const sel = selected();
      laneEls.forEach((el, i) => { el.classList.toggle('mine', list[i].id === sel.id); });
      $$('#p4-load .load-row').forEach((el, i) => { el.classList.toggle('mine', list[i].id === sel.id); });
    }
    function renderSelection() {
      markSelection();
      renderLoadSum();
      renderTable();
      renderChart();
      renderVerdict();
    }
    function recompute() {
      clock.reset();
      compute();
      renderLanes();
      renderLoad();
      renderSelection();
    }

    function init() {
      clock = new Clock(renderRace);
      clock.max = RACE_DUR;
      clock.onState = () => {
        $('#p4-run').textContent = clock.playing ? '⏸ 一時停止' : clock.t >= clock.max ? '↻ もういちど' : clock.t > 0 ? '▶ つづける' : '▶ スタート';
      };
      stopAll.push(() => clock.pause());
      $('#p4-run').addEventListener('click', () => { clock.playing ? clock.pause() : clock.play(); });
      $('#p4-reset').addEventListener('click', () => clock.reset());
      $('#p4-size').addEventListener('input', (e) => {
        state.size = sizeFromSlider(parseFloat(e.target.value));
        $('#p4-size-out').textContent = fmtMB(state.size * 1e6);
        recompute();
      });
      $$('input[name="p4env"]').forEach((r) => r.addEventListener('change', () => { state.env = r.value; recompute(); }));
      $$('input[name="p4media"]').forEach((r) => r.addEventListener('change', () => { state.media = r.value; renderSelection(); }));
      $$('input[name="p4mode"]').forEach((r) => r.addEventListener('change', () => { state.mode = r.value; renderSelection(); }));
      $('#p4-reveal').addEventListener('click', () => { state.reveal = !state.reveal; renderSelection(); });
      syncInputs();
      renderScen();
      recompute();
    }

    return { init };
  })();

  P1.init();
  P2.init();
  P3.init();
  P4.init();
})();
