/* StarNet homepage motion — starfield, heading decode, scroll-driven monitor + statement,
   capability console. Homepage-only (site.js stays the shared script for index + pricing).
   Network-free by construction: this file makes no requests. Everything degrades to a still,
   complete page without JS or under prefers-reduced-motion. */
(function(){
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var clamp = function(v, a, b){ return v < a ? a : v > b ? b : v; };
  var easeOut = function(t){ return 1 - Math.pow(1 - t, 3); };

  /* ---------- hero starfield (warp in, then cruise; pointer parallax) ---------- */
  (function starfield(){
    var canvas = document.querySelector('.starfield');
    if(!canvas || !canvas.getContext) return;
    var hero = canvas.parentElement, ctx = canvas.getContext('2d');
    var W = 0, H = 0, dpr = 1, stars = [], running = false, visible = true, last = 0, t0 = 0;
    var px = 0, py = 0, tx = 0, ty = 0;
    var COLORS = ['255,196,107', '255,157,47', '255,226,176', '255,140,40'];
    function spawn(s, far){
      s.x = (Math.random() * 2 - 1) * 1.6; s.y = (Math.random() * 2 - 1) * 1.1;
      s.z = far ? 1 : Math.random() * .95 + .05; s.pz = s.z;
      s.c = COLORS[(Math.random() * COLORS.length) | 0]; s.s = Math.random() * 1.1 + .4;
      return s;
    }
    function resize(){
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      W = hero.clientWidth; H = hero.clientHeight;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var n = clamp(Math.round(W * H / 3200), 120, 460);
      while(stars.length < n) stars.push(spawn({}, false));
      stars.length = n;
    }
    function frame(now){
      if(!running) return;
      var dt = Math.min(.05, (now - (last || now)) / 1000); last = now;
      var age = (now - t0) / 1000;
      var speed = .045 + 1.5 * Math.max(0, 1 - age / 1.6) * Math.max(0, 1 - age / 1.6);
      px += (tx - px) * .05; py += (ty - py) * .05;
      var cx = W / 2 + px * 40, cy = H * .44 + py * 24, f = Math.max(W, H) * .5;
      ctx.clearRect(0, 0, W, H);
      ctx.lineCap = 'round';
      for(var i = 0; i < stars.length; i++){
        var s = stars[i];
        s.pz = s.z; s.z -= speed * dt;
        if(s.z <= .03){ spawn(s, true); continue; }
        var sx = cx + s.x / s.z * f, sy = cy + s.y / s.z * f;
        if(sx < -40 || sx > W + 40 || sy < -40 || sy > H + 40){ spawn(s, true); continue; }
        var ox = cx + s.x / s.pz * f, oy = cy + s.y / s.pz * f;
        var a = clamp((1 - s.z) * 1.25, 0, 1), r = s.s * (1.4 - s.z);
        ctx.strokeStyle = 'rgba(' + s.c + ',' + a.toFixed(3) + ')';
        ctx.lineWidth = Math.max(.6, r);
        ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(sx + .01, sy + .01); ctx.stroke();
      }
      requestAnimationFrame(frame);
    }
    function start(){ if(running || reduce || !visible || document.hidden) return; running = true; last = 0; requestAnimationFrame(frame); }
    function stop(){ running = false; }
    resize();
    if(reduce){                                   // one still frame
      ctx.fillStyle = 'rgba(255,196,107,.7)';
      stars.forEach(function(s){ var sx = W / 2 + s.x / s.z * W * .5, sy = H * .44 + s.y / s.z * W * .5; ctx.fillRect(sx, sy, 1.2, 1.2); });
      return;
    }
    t0 = performance.now();
    window.addEventListener('resize', resize);
    if(window.matchMedia('(hover:hover)').matches){
      window.addEventListener('pointermove', function(e){ tx = e.clientX / window.innerWidth * 2 - 1; ty = e.clientY / window.innerHeight * 2 - 1; }, { passive:true });
    }
    if('IntersectionObserver' in window){
      new IntersectionObserver(function(en){ visible = en[0].isIntersecting; visible ? start() : stop(); }).observe(hero);
    }
    document.addEventListener('visibilitychange', function(){ document.hidden ? stop() : start(); });
    start();
  })();

  /* ---------- section headings decode like a terminal readout ---------- */
  (function scramble(){
    var heads = Array.prototype.slice.call(document.querySelectorAll('[data-scramble]'));
    if(reduce || !heads.length || !('IntersectionObserver' in window)) return;
    var GLYPHS = '#%&*+=<>/\\[]{}?01ABCDEF';
    function run(el){
      var full = el.textContent, n = full.length, start = performance.now(), dur = 650 + n * 22;
      el.setAttribute('aria-label', full);
      (function tick(now){
        var p = clamp((now - start) / dur, 0, 1), settled = Math.floor(easeOut(p) * n), out = '';
        for(var i = 0; i < n; i++){
          var ch = full[i];
          if(i < settled || ch === ' ') out += ch.replace(/&/g, '&amp;');
          else out += '<span class="scr-dim">' + GLYPHS[(Math.random() * GLYPHS.length) | 0].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span>';
        }
        el.innerHTML = out;
        if(p < 1) requestAnimationFrame(tick); else el.textContent = full;
      })(start);
    }
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(en){ if(en.isIntersecting){ io.unobserve(en.target); run(en.target); } });
    }, { rootMargin:'0px 0px -12% 0px' });
    heads.forEach(function(h){ io.observe(h); });
  })();

  /* ---------- manifesto: split into words once ---------- */
  var scrub = document.querySelector('[data-scrub]'), words = [];
  if(scrub){
    var parts = scrub.textContent.split(/(\s+)/);
    scrub.setAttribute('aria-label', scrub.textContent);
    scrub.textContent = '';
    parts.forEach(function(w){   // built as nodes: the words are text, never markup
      if(/^\s+$/.test(w)){ scrub.appendChild(document.createTextNode(w)); return; }
      var s = document.createElement('span'); s.className = 'w'; s.setAttribute('aria-hidden', 'true'); s.textContent = w; scrub.appendChild(s);
    });
    words = Array.prototype.slice.call(scrub.querySelectorAll('.w'));
  }

  /* ---------- scroll-driven: progress bar, monitor straightening, statement lighting ---------- */
  var prog = document.querySelector('.scroll-prog span');
  var stage = document.querySelector('.monitor-stage'), monitor = document.querySelector('.monitor');
  var ticking = false, lastY = window.scrollY;
  var topbar = document.getElementById('topbar');
  var phone = window.matchMedia ? window.matchMedia('(max-width:760px)') : { matches:false };
  function onScroll(){
    ticking = false;
    var vh = window.innerHeight, de = document.documentElement;
    var y = window.scrollY, dy = y - lastY;
    if(topbar){
      if(!phone.matches || y < 140) topbar.classList.remove('tuck');
      else if(dy > 6) topbar.classList.add('tuck');
      else if(dy < -6) topbar.classList.remove('tuck');
    }
    if(Math.abs(dy) > 6 || y < 140) lastY = y;
    if(prog){ var max = de.scrollHeight - vh; prog.style.setProperty('--sp', max > 0 ? (window.scrollY / max).toFixed(4) : '0'); }
    if(stage && monitor && !reduce){
      var r = stage.getBoundingClientRect();
      if(r.bottom > 0 && r.top < vh){
        var e = easeOut(clamp((vh - r.top) / (vh * .85), 0, 1));
        monitor.style.setProperty('--tilt', (26 * (1 - e)).toFixed(2) + 'deg');
        monitor.style.setProperty('--mscale', (.86 + .14 * e).toFixed(4));
        monitor.style.setProperty('--mlift', (60 * (1 - e)).toFixed(1) + 'px');
      }
    }
    if(words.length){
      var rr = scrub.getBoundingClientRect();
      if(reduce){ words.forEach(function(w){ w.classList.add('lit'); }); }
      else if(rr.bottom > 0 && rr.top < vh){
        var p = clamp((vh * .88 - rr.top) / (vh * .5), 0, 1), lit = Math.round(p * words.length);
        words.forEach(function(w, i){
          w.classList.toggle('lit', i < lit);
          w.classList.toggle('hot', i < lit && p >= 1 && i >= words.length - 2);
        });
      }
    }
  }
  function queue(){ if(!ticking){ ticking = true; requestAnimationFrame(onScroll); } }
  window.addEventListener('scroll', queue, { passive:true });
  window.addEventListener('resize', queue);
  onScroll();
})();
