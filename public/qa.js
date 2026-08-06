/* quirio-analytics — cookieless page analytics
 * 正本: ~/dev/quirio-analytics/src/snippet.js
 * 各サイトへは `npm run sync` が下のプレースホルダを埋めて配布する。
 * このファイルを配布先で直接編集しないこと（次の sync で上書きされる）。
 * ⚠️ プレースホルダの文字列をコメントや説明文に書かないこと。
 *    置換が本体より先にコメント側へ当たり、値が埋まらないまま配信された（2026-08-04 実測）。
 *
 * 端末に保存するのは、代表自身のアクセスを除外するための opt-out フラグ1つだけ。
 * 訪問者の識別子はサーバ側で日次ローテーションのハッシュとして作られ、端末には残らない。
 *
 * ⚠️ このコードは公開7サイトの全ページで走る。守るべき不変条件は3つ。
 *    (1) 例外を投げない（計測の失敗でページを壊さない）
 *    (2) 既定の動作を妨げない（preventDefault も stopPropagation もしない）
 *    (3) 送るのは「サイト側が宣言した名前」と「規約で決まった短い語」だけ。
 *        href の全体・textContent・入力値は読まない（src/sites.js の凡例を参照）
 */
(function () {
  'use strict';
  var ENDPOINT = 'https://quirio-analytics.wataru-okada.workers.dev/e';
  var SITE = 'drone-exam-sim';
  // このサイトで「#」がページの識別子か（src/sites.js の hashRoutes）。
  // false のサイトでハッシュを数えると、目次リンクを押しただけでPVが増える。
  var HASH_IS_ROUTE = false;
  // 何を数えるかの宣言（src/sites.js の events）。null なら購読自体を張らない。
  var EV = null;
  // スニペット版数。正本は src/sites.js の SNIPPET_VERSION（ここへは配布時に埋まる）。
  // サーバはこれを pageviews.sv に保存し、自分が知っている版数と比べて
  // 「配布したのに旧版が配られ続けている」を検知する
  // （aero-gakka は PWA の precache が旧 qa.js を抱え込む）。
  var SNIPPET_VERSION = 3;

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

  function params() {
    try { return new URLSearchParams(location.search); } catch (e) { return null; }
  }

  function utm() {
    var p = params();
    if (!p) return {};
    return {
      s: p.get('utm_source') || '', m: p.get('utm_medium') || '',
      c: p.get('utm_campaign') || '', t: p.get('utm_content') || '',
      k: p.get('utm_term') || '',
    };
  }

  /**
   * 広告クリックIDの「有無」だけを見る。値は絶対に送らない。
   * 値を持つと広告クリック単位の突合ができてしまい、
   * 「日をまたいで同一の利用者を追跡できない」という公表と緊張する。
   */
  function paidClick() {
    var p = params();
    if (!p) return 0;
    return (p.has('gclid') || p.has('fbclid') || p.has('msclkid') || p.has('yclid')) ? 1 : 0;
  }

  /**
   * このページが「存在しないURL」だったか。
   * Cloudflare Pages の 404.html は URL を保ったまま返るのでパスでは判別できない。
   * 各サイトの 404.html 側がタグに印を付けて申告する。
   * ⚠️ defer 付きスクリプトでは document.currentScript が null になるので使えない。
   */
  function isNotFound() {
    try {
      var s = document.querySelector('script[src$="/qa.js"]');
      return s && s.hasAttribute('data-qa-404') ? 404 : 200;
    } catch (e) { return 200; }
  }

  // --- 状態 ---------------------------------------------------------------
  var view = null;      // { id, path }
  var scroll = 0;       // 最大スクロール到達率(%)
  var dwell = 0;        // 可視だった時間の累計(ms)
  var since = 0;        // 現在の可視区間の開始時刻
  var sent = false;     // このビューの離脱ビーコンを送ったか
  var seenChange = {};  // 同じ入力欄を触るたびに数えないための重複除け

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

  function here() {
    return HASH_IS_ROUTE ? location.pathname + location.hash : location.pathname;
  }

  function start(ref) {
    view = { id: uid(), path: here() };
    scroll = 0; dwell = 0; sent = false; seenChange = {};
    // ⚠️ 読み込み時に裏だったら滞在を数え始めない。
    //    中クリックで裏タブに開かれたページ・プリレンダは、誰も見ていないまま
    //    qa.js が走る。ここで無条件に始点を打つと、可視になることが一度も無いので
    //    visibilitychange も発火せず、閉じた瞬間に待ち行列の時間が丸ごと滞在になる
    //    （実測：裏で20分置いて閉じると d=1,200,000ms）。
    //    since=0 は既存コードの「いま数えていない」印。可視になった時点で
    //    下の visibilitychange 分岐がそのまま始点を武装する。
    since = 0;
    try { if (document.visibilityState !== 'hidden') since = nowMs(); } catch (e) { since = nowMs(); }
    measureScroll();
    send({
      t: 'pv', v: SNIPPET_VERSION, s: SITE, id: view.id,
      p: view.path,
      r: ref || '',
      u: utm(),
      pc: paidClick(),
      st: isNotFound(),
      sw: window.screen ? window.screen.width : 0,
      l: (navigator.language || '').slice(0, 12),
    });
    urlGoals();
  }

  // --- イベント ------------------------------------------------------------
  /** 1件送る。name も detail もサイト側が宣言した語だけが渡ってくる前提。 */
  function event(name, detail) {
    if (!view) return;
    send({
      t: 'ev', v: SNIPPET_VERSION, s: SITE, id: uid(),
      vid: view.id,          // 発生元のページビュー。これを送ることで
      p: view.path,          // サーバは書き込み前に SELECT を1回もしない
      n: name, dt: detail || '',
    });
  }

  /** ホスト名だけを取り出す（www. は落とす）。パスもクエリも読まない。 */
  function hostOf(a) {
    var host = (a.hostname || '').toLowerCase();
    return host.indexOf('www.') === 0 ? host.slice(4) : host;
  }

  /** 拡張子だけを取り出す。ファイル名は読まない。 */
  function extOf(a) {
    var m = /\.([a-z0-9]{1,8})$/i.exec(a.pathname || '');
    return m ? m[1].toLowerCase() : '';
  }

  function closestIn(el, selector) {
    try { return el && el.closest ? el.closest(selector) : null; } catch (e) { return null; }
  }

  function onClick(e) {
    if (!EV) return;
    try {
      var t = e.target;
      if (t && t.nodeType === 3) t = t.parentElement; // テキストノード
      if (!t || !t.closest) return;

      // (1) サイトが名前を付けて宣言したクリック。1クリック＝1イベント。
      var rules = EV.clicks || [];
      for (var i = 0; i < rules.length; i++) {
        var el = closestIn(t, rules[i].selector);
        if (!el) continue;
        var detail = '';
        if (rules[i].attr) {
          // サイト側が自分で書いた固定語だけを読む（href も表示テキストも読まない）
          detail = (el.getAttribute(rules[i].attr) || '').slice(0, 60);
        } else if (el.tagName === 'A' && el.hostname && el.hostname !== location.hostname) {
          // 同一ページ内アンカー（#contact 等）は自ホストになるので detail を付けない
          detail = hostOf(el);
        }
        event(rules[i].name, detail);
        return;
      }

      // (2) 自動計測（Plausible の outbound-links / file-downloads 相当）
      var a = closestIn(t, 'a[href]');
      if (!a) return;
      var proto = (a.protocol || '').toLowerCase();

      if (EV.contactLinks && (proto === 'mailto:' || proto === 'tel:')) {
        // 宛先は読まない。どちらの手段かだけ。
        event('contact_link', proto.slice(0, -1));
        return;
      }
      if (proto !== 'http:' && proto !== 'https:') return;

      var ext = extOf(a);
      if (EV.downloads && EV.downloads.length && EV.downloads.indexOf(ext) > -1) {
        event('download', ext);
        return;
      }
      if (EV.outbound && a.hostname && a.hostname !== location.hostname) {
        event('outbound', hostOf(a));
      }
    } catch (err) { /* 計測の失敗で遷移を妨げない */ }
  }

  function onChange(e) {
    if (!EV || !EV.changes) return;
    try {
      var t = e.target;
      if (!t || !t.closest) return;
      for (var i = 0; i < EV.changes.length; i++) {
        var el = closestIn(t, EV.changes[i].selector);
        if (!el) continue;
        // ⚠️ 送るのは要素の id だけ。入力された値は読まない。
        var id = (el.id || '').slice(0, 40);
        var key = EV.changes[i].name + '|' + id;
        if (seenChange[key]) return;   // 同じ欄を何度触っても1回
        seenChange[key] = 1;
        event(EV.changes[i].name, id);
        return;
      }
    } catch (err) { /* 同上 */ }
  }

  /**
   * URL条件ゴール。クエリ文字列そのものは送らず、ここで名前に解決してから送る。
   * RoomBright の /mypage は決済成功とログイン後の通常再訪が同じURLなので、
   * これが無いと7サイトで唯一の実売上イベントが1件も記録されない。
   */
  function urlGoals() {
    if (!EV || !EV.urls) return;
    try {
      var p = params();
      if (!p) return;
      var now = location.pathname.replace(/\/$/, '') || '/';
      for (var i = 0; i < EV.urls.length; i++) {
        var g = EV.urls[i];
        if (now !== g.path && now !== g.path + '.html') continue;
        var eq = g.query.indexOf('=');
        if (eq < 0) continue;
        // key=value の完全一致のみ。部分一致も正規表現も許さない
        // （将来メールアドレス等を拾う余地を残さないため）。
        if (p.get(g.query.slice(0, eq)) !== g.query.slice(eq + 1)) continue;
        event(g.name, '');
      }
    } catch (e) { /* 同上 */ }
  }

  // --- ライフサイクル ------------------------------------------------------
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      if (since) { dwell += nowMs() - since; since = 0; }
      flush();
    } else if (!since) {
      since = nowMs();
      // ⚠️ ここで sent を戻さないと、タブを離れて戻ってさらに読んだ分が
      //    二度と送られない。タブを切り替える人ほど滞在も読了率も0に近く
      //    記録されていた（構造的な過小評価）。
      //    離脱ビーコンが複数回届いても handleExit は MAX() の UPDATE なので
      //    重複は無害（view_id は PRIMARY KEY・行は増えない）。
      sent = false;
    }
  });
  window.addEventListener('pagehide', flush);
  window.addEventListener('scroll', measureScroll, { passive: true });

  if (EV) {
    // capture フェーズで拾う。サイト側が stopPropagation していても届く。
    // passive:true ＝ preventDefault しない宣言（遷移を妨げない）。
    document.addEventListener('click', onClick, { capture: true, passive: true });
    if (EV.changes) document.addEventListener('change', onChange, { capture: true, passive: true });
  }

  // SPA のルート変更を新しいページビューとして数える。
  // これをやらないと、SPA のサイトは全部の流入が "/" に潰れて離脱率が意味を失う。
  // 逆に、ハッシュがただのアンカーであるサイトで数えると水増しになるので、
  // hashchange を聞くかどうかはサイトごとに切り替える。
  function navigated() {
    var path = here();
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
  if (HASH_IS_ROUTE) {
    window.addEventListener('hashchange', function () { setTimeout(navigated, 0); });
  }

  start(document.referrer || '');
})();
