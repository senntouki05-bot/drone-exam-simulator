/* quirio-analytics — cookieless page analytics
 * 正本: ~/dev/quirio-analytics/src/snippet.js
 * 各サイトへは `npm run sync` が下のプレースホルダを埋めて配布する。
 * このファイルを配布先で直接編集しないこと（次の sync で上書きされる）。
 * ⚠️ プレースホルダの文字列をコメントや説明文に書かないこと。
 *    置換が本体より先にコメント側へ当たり、値が埋まらないまま配信された（2026-08-04 実測）。
 *
 * 端末に保存するのは、代表自身のアクセスを除外するための opt-out フラグ1つだけ。
 * 訪問者の識別子はサーバ側で日次ローテーションのハッシュとして作られ、端末には残らない。
 */
(function () {
  'use strict';
  var ENDPOINT = 'https://quirio-analytics.wataru-okada.workers.dev/e';
  var SITE = 'drone-exam-sim';

  // --- 除外判定 -----------------------------------------------------------
  try {
    var q = location.search;
    if (q.indexOf('__qa_optout=1') > -1) localStorage.setItem('qa_optout', '1');
    if (q.indexOf('__qa_optout=0') > -1) localStorage.removeItem('qa_optout');
    if (localStorage.getItem('qa_optout') === '1') return;
  } catch (e) { /* localStorage が使えない環境でも計測は続ける */ }

  if (navigator.globalPrivacyControl === true) return;      // GPC を尊重
  var h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '' || h.indexOf('.local') > -1) return;

  // --- 送信 ---------------------------------------------------------------
  function send(payload) {
    var body = JSON.stringify(payload);
    try {
      if (navigator.sendBeacon &&
          navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain;charset=UTF-8' }))) return;
    } catch (e) { /* fall through */ }
    try {
      fetch(ENDPOINT, {
        method: 'POST', body: body, keepalive: true, mode: 'cors',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      }).catch(function () {});
    } catch (e) { /* 計測の失敗でページを壊さない */ }
  }

  function uid() {
    try {
      if (crypto && crypto.randomUUID) return crypto.randomUUID();
      var a = new Uint8Array(16); crypto.getRandomValues(a);
      return Array.prototype.map.call(a, function (b) { return (b + 256).toString(16).slice(1); }).join('');
    } catch (e) {
      return String(Date.now()) + '-' + Math.random().toString(36).slice(2, 10);
    }
  }

  function utm() {
    var p = new URLSearchParams(location.search);
    return { s: p.get('utm_source') || '', m: p.get('utm_medium') || '', c: p.get('utm_campaign') || '', t: p.get('utm_content') || '' };
  }

  // --- 状態 ---------------------------------------------------------------
  var view = null;      // { id, path, ref }
  var scroll = 0;       // 最大スクロール到達率(%)
  var dwell = 0;        // 可視だった時間の累計(ms)
  var since = 0;        // 現在の可視区間の開始時刻
  var sent = false;     // このビューの離脱ビーコンを送ったか

  function nowMs() { return (performance && performance.now) ? performance.now() : Date.now(); }

  function measureScroll() {
    var d = document.documentElement, b = document.body;
    var height = Math.max(d.scrollHeight, b ? b.scrollHeight : 0);
    if (height <= 0) return;
    var seen = (window.scrollY || d.scrollTop || 0) + window.innerHeight;
    var p = Math.round((seen / height) * 100);
    if (p > scroll) scroll = p > 100 ? 100 : p;
  }

  function flush() {
    if (!view || sent) return;
    sent = true;
    if (since) { dwell += nowMs() - since; since = 0; }
    measureScroll();
    send({ t: 'ex', id: view.id, d: Math.round(dwell), sc: scroll });
  }

  function start(ref) {
    view = { id: uid(), path: location.pathname + location.hash };
    scroll = 0; dwell = 0; since = nowMs(); sent = false;
    measureScroll();
    send({
      t: 'pv', v: 1, s: SITE, id: view.id,
      p: view.path,
      r: ref,
      u: utm(),
      sw: window.screen ? window.screen.width : 0,
      l: (navigator.language || '').slice(0, 12),
    });
  }

  // --- ライフサイクル ------------------------------------------------------
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      if (since) { dwell += nowMs() - since; since = 0; }
      flush();
    } else if (!since) {
      since = nowMs();
    }
  });
  window.addEventListener('pagehide', flush);
  window.addEventListener('scroll', measureScroll, { passive: true });

  // SPA のルート変更を新しいページビューとして数える。
  // これをやらないと、SPA のサイトは全部の流入が "/" に潰れて離脱率が意味を失う。
  function navigated() {
    var path = location.pathname + location.hash;
    if (view && path === view.path) return;
    var from = location.origin + (view ? view.path : '');
    flush();
    start(from);
  }
  ['pushState', 'replaceState'].forEach(function (m) {
    var orig = history[m];
    if (typeof orig !== 'function') return;
    history[m] = function () {
      var r = orig.apply(this, arguments);
      setTimeout(navigated, 0);
      return r;
    };
  });
  window.addEventListener('popstate', function () { setTimeout(navigated, 0); });
  window.addEventListener('hashchange', function () { setTimeout(navigated, 0); });

  start(document.referrer || '');
})();
