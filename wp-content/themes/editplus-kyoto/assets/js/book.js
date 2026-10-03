/**
 * 誌面（デジタルブック）の閲覧。本のように1枚ずつめくる。PCは見開き、スマホは1ページ。
 *
 * めくりはライブラリを使わず CSS の3D（rotateY）で描く。紙が波打つ本物の「めくれ」ではなく、
 * 背（のど）を軸に1枚の紙が回る見え方。ライブラリ（StPageFlip 等）は更新が止まっていて、
 * 拡大・全画面・画像を少しずつ読む仕組みを作り直すことになるので使わない（2026-09-30）。
 *
 * - 左右1/3を押す・スワイプ・矢印キー・横スクロール … めくる（右開きの号は向きが逆）。指には追従する
 * - 真ん中を2回押す・つまむ・Ctrl+ホイール         … 拡大。拡大中はドラッグで動かし、めくらない
 * - 真ん中を1回押す（全画面のとき）                   … 操作バーを出す・隠す
 * - 全画面はボタンで入る（開いた時点ではページの中。サイトのヘッダーやリンクが見えるほうが迷わない）
 *
 * 描くのは「今の見開き」だけ（236ページぶんの要素は作らない）。前後2見開きの画像は先に読んでおく。
 * URL の #p=12 でページを共有できる。
 */
(function () {
	'use strict';
	var book = document.getElementById('book');
	if (!book) { return; }

	var pages = parseInt(book.getAttribute('data-pages'), 10) || 0;
	var base = book.getAttribute('data-base');
	var ratio = parseFloat(book.getAttribute('data-ratio')) || 1.4142;
	var rtl = book.getAttribute('data-rtl') === '1';
	var stage = book.querySelector('.book-stage');
	var view = book.querySelector('.book-view');
	var box = book.querySelector('.book-box');
	var bar = book.querySelector('.book-bar');
	var range = book.querySelector('.book-range');
	var no = book.querySelector('.book-no');
	var tools = book.querySelector('.book-tools');
	var list = book.querySelector('.book-pages');
	var btnLeft = book.querySelector('.book-prev');
	var btnRight = book.querySelector('.book-next');
	var btnFull = book.querySelector('.book-full');
	var mq = window.matchMedia('(min-width: 841px)');
	var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
	if (!pages || !box || !view) { return; }

	function src(n) { return base + 'p' + String(n).padStart(4, '0') + '.jpg'; }

	// 台紙 = 画面上の左右に載るページ番号（空は 0）。1ページのときは page だけ
	var sheets = [];
	var current = 0;
	var spread = false;
	var W = 0, H = 0, pw = 0, ph = 0;
	var full = false;
	var flip = null;   // めくりの途中

	// --- 台紙の組み立て ---
	// 見開き（左開き）: [ _ ,1] [2,3] [4,5] … 表紙は右だけ。右開きは左右を入れ替える
	function build() {
		sheets = [];
		if (spread) {
			sheets.push(pair(0, 1));
			for (var p = 2; p <= pages; p += 2) {
				sheets.push(pair(p, p + 1 <= pages ? p + 1 : 0));
			}
		} else {
			for (var q = 1; q <= pages; q++) { sheets.push({ page: q }); }
		}
	}
	// 読む順の前・後を、画面上の左・右に置き換える
	function pair(a, b) { return rtl ? { left: b, right: a } : { left: a, right: b }; }
	function pagesOf(s) { return spread ? [s.left, s.right].filter(Boolean).sort(function (a, b) { return a - b; }) : [s.page]; }

	// 画面の左／右にある台紙の添字（右開きの号は次の台紙が左）
	function sideIndex(side, i) { return i + ((side === 'right') === !rtl ? 1 : -1); }
	function exists(i) { return i >= 0 && i < sheets.length; }

	function hashPage() {
		var m = /p=(\d+)/.exec(window.location.hash);
		return m ? Math.min(pages, Math.max(1, parseInt(m[1], 10))) : 1;
	}
	function sheetOf(page) {
		for (var i = 0; i < sheets.length; i++) {
			if (pagesOf(sheets[i]).indexOf(page) !== -1) { return i; }
		}
		return 0;
	}

	// --- 画像 ---
	// めくる前に画像のデコードを済ませておく。済んでいない画像を3Dの面に載せると、
	// 回っている間だけ白い紙に見える
	var cache = {};
	function preload(n) {
		if (!n || cache[n]) { return cache[n] || null; }
		var img = new Image();
		img.decoding = 'async';
		img.src = src(n);
		cache[n] = img;
		img.ready = img.decode ? img.decode().catch(function () {}) : Promise.resolve();
		return img;
	}
	function preloadAround(i) {
		for (var k = Math.max(0, i - 2); k <= Math.min(sheets.length - 1, i + 2); k++) {
			pagesOf(sheets[k]).forEach(preload);
		}
		// 遠くなった画像は手放す（236ページを読み進めてもメモリが増え続けないように）
		Object.keys(cache).forEach(function (n) {
			var i2 = sheetOf(parseInt(n, 10));
			if (Math.abs(i2 - i) > 4) { delete cache[n]; }
		});
	}
	// 待つのは長くても0.8秒。回線が遅いときやタブが裏にあるときは decode() が終わらないことがあり、
	// 押してもめくれないより、白い紙のままでもめくれるほうがよい
	function ready(list2) {
		var all = Promise.all(list2.filter(Boolean).map(function (n) { return preload(n).ready; }));
		return Promise.race([all, new Promise(function (r) { setTimeout(r, 800); })]);
	}

	// ページ1枚ぶんの要素。n が 0 なら何も載っていない紙の外側（空）
	function pageEl(n, cls) {
		var d = document.createElement('div');
		d.className = 'book-page ' + (cls || '') + (n ? '' : ' is-empty');
		if (n) {
			var img = document.createElement('img');
			img.alt = 'p.' + n;
			img.draggable = false;
			// 先読みでデコード済みの画像なので、差し替えた瞬間に白く抜けないよう同期で描かせる
			img.decoding = 'sync';
			img.src = src(n);
			d.appendChild(img);
		}
		return d;
	}

	// --- 大きさ ---
	function layout() {
		var wide = full ? (view.clientWidth / Math.max(1, view.clientHeight) >= 1.2) : mq.matches;
		var page = sheets.length ? pagesOf(sheets[current])[0] : hashPage();
		if (wide !== spread || !sheets.length) {
			spread = wide;
			build();
			current = sheetOf(page);
		}
		W = view.clientWidth;
		if (full) {
			view.style.height = '';
			H = view.clientHeight;
		} else {
			// ページの中で読むときは、画面の高さに収まる大きさにする（スクロールせずに1枚が見える）
			H = spread ? Math.min(window.innerHeight * 0.78, 900) : Math.min(W * 0.92 * ratio, window.innerHeight * 0.8);
			H = Math.round(H);
			view.style.height = H + 'px';
		}
		var c = spread ? 2 : 1;
		pw = Math.floor(Math.min((H * (full ? 0.97 : 0.94)) / ratio, (W * (full ? 0.98 : 0.94)) / c));
		ph = Math.floor(pw * ratio);
		book.style.setProperty('--pw', pw + 'px');
		book.style.setProperty('--ph', ph + 'px');
		cancelPending();
		finishFlip();
		resetZoom(false);
		render();
	}

	// 片側だけの台紙（表紙・裏表紙）は、残ったページが真ん中に来るように本をずらす
	function offsetOf(i) {
		if (!spread) { return 0; }
		var s = sheets[i];
		if (!s.left && s.right) { return -pw / 2; }
		if (s.left && !s.right) { return pw / 2; }
		return 0;
	}

	// 本（見開き or 1ページ）の入れ物。3D の奥行き（perspective）はここに付ける。
	// 拡大は外側の .book-box に掛け、奥行きと拡大を同じ要素に混ぜない（混ぜると回転中の面の大きさが狂う）
	function spreadEl(offset) {
		var el = document.createElement('div');
		el.className = 'book-spread' + (spread ? ' is-spread' : ' is-single');
		el.style.transform = 'translate3d(' + offset + 'px,0,0)';
		return el;
	}

	function render() {
		var s = sheets[current];
		box.innerHTML = '';
		var el = spreadEl(offsetOf(current));
		if (spread) {
			el.appendChild(pageEl(s.left, 'is-left'));
			el.appendChild(pageEl(s.right, 'is-right'));
		} else {
			el.appendChild(pageEl(s.page, ''));
		}
		box.appendChild(el);
		preloadAround(current);
		setCurrent();
	}

	function setCurrent() {
		var ps = pagesOf(sheets[current]);
		var label = ps.length === 2 ? ps[0] + '–' + ps[1] : String(ps[0]);
		no.textContent = label + ' / ' + pages;
		range.value = ps[0];
		var h = '#p=' + ps[0];
		if (window.location.hash !== h) { history.replaceState(null, '', h); }
		// 言語の切り替え先にも、いま読んでいるページを付ける。切り替え先のURLはサーバーが作るので #p= を知らず、
		// 英語に変えると1ページ目に戻っていた（BUGS #37。nearby.js が ?hotel= を書き換えるのと同じ手）
		Array.prototype.forEach.call(document.querySelectorAll('#langMenu a[href], #langSheet a[href]'), function (a) {
			a.setAttribute('href', a.getAttribute('href').split('#')[0] + h);
		});
		book.classList.toggle('no-left', !exists(sideIndex('left', current)));
		book.classList.toggle('no-right', !exists(sideIndex('right', current)));
	}

	// めくらずに移る（目次・スライダー・#p=NN）
	function jump(i) {
		i = Math.max(0, Math.min(sheets.length - 1, i));
		cancelPending();
		finishFlip();
		if (i === current) { return; }
		resetZoom(false);
		current = i;
		render();
	}

	// --- めくり ---
	// side … 画面のどちら側の紙がめくれるか。'right' なら右の紙が背を軸に左へ倒れる
	//
	// 見開き（side='right'）: 土台の左 = 今の左 / 土台の右 = 次の右 / めくれる紙 = 表が今の右・裏が次の左
	// 1ページ: 背は左端（右開きは右端）。進むときは今のページが倒れて次が下から現れ、
	//          戻るときは前のページが倒れた位置から起き上がって今のページを覆う
	function startFlip(side) {
		var to = sideIndex(side, current);
		if (!exists(to)) { return null; }
		var from = current;
		var a = sheets[from], b = sheets[to];
		var el = spreadEl(offsetOf(from));
		var leaf = document.createElement('div');
		var front, back, sign, incoming = false;

		if (spread) {
			if (side === 'right') {
				el.appendChild(pageEl(a.left, 'is-left'));
				el.appendChild(pageEl(b.right, 'is-right'));
				front = a.right; back = b.left; sign = -1;
			} else {
				el.appendChild(pageEl(b.left, 'is-left'));
				el.appendChild(pageEl(a.right, 'is-right'));
				front = a.left; back = b.right; sign = 1;
			}
			leaf.className = 'book-leaf on-' + side;
		} else {
			// 読み進める向きか（左開きなら右を押したとき）
			var forward = (side === 'right') === !rtl;
			var spine = rtl ? 'right' : 'left';
			sign = spine === 'left' ? -1 : 1;
			incoming = !forward;
			// 土台：進むなら次のページ、戻るなら今のページ（起き上がってくる前のページに覆われる）
			el.appendChild(pageEl(forward ? b.page : a.page, ''));
			front = forward ? a.page : b.page;
			back = -1;  // 1ページのときの裏は白い紙
			leaf.className = 'book-leaf is-single spine-' + spine;
		}

		var faceF = pageEl(front, 'book-face is-front' + (spread ? (side === 'right' ? ' is-right' : ' is-left') : ''));
		var faceB = back === -1 ? pageEl(0, 'book-face is-back is-paper') : pageEl(back, 'book-face is-back' + (spread ? (side === 'right' ? ' is-left' : ' is-right') : ''));
		var shadeF = document.createElement('div'); shadeF.className = 'book-shade';
		var shadeB = document.createElement('div'); shadeB.className = 'book-shade';
		faceF.appendChild(shadeF);
		faceB.appendChild(shadeB);
		leaf.appendChild(faceF);
		leaf.appendChild(faceB);
		el.appendChild(leaf);
		// めくりの間だけの複製なので、読み上げには確定したページだけを渡す
		el.setAttribute('aria-hidden', 'true');
		// めくれる紙が土台に落とす影
		var cast = document.createElement('div');
		cast.className = 'book-cast on-' + (spread ? (side === 'right' ? 'right' : 'left') : 'single');
		el.appendChild(cast);

		box.innerHTML = '';
		box.appendChild(el);
		book.classList.add('is-flipping');

		flip = {
			from: from, to: to, side: side, sign: sign, incoming: incoming,
			el: el, leaf: leaf, shadeF: shadeF, shadeB: shadeB, cast: cast,
			o0: offsetOf(from), o1: offsetOf(to), p: 0, raf: 0
		};
		setProgress(0);
		return flip;
	}

	// p … 0（めくる前）〜 1（めくり終わり）
	function setProgress(p) {
		var f = flip;
		if (!f) { return; }
		f.p = p;
		// 1ページで戻るときは、倒れた位置（-180°）から起き上がる
		var deg = f.incoming ? f.sign * 180 * (1 - p) : f.sign * 180 * p;
		f.leaf.style.transform = 'rotateY(' + deg + 'deg)';
		// 紙が立つほど（90°に近いほど）表も裏も暗く、土台への影は濃くなる
		var tilt = Math.abs(Math.sin(deg * Math.PI / 180));
		var past = Math.abs(deg) > 90;
		f.shadeF.style.opacity = past ? 0 : tilt * 0.45;
		f.shadeB.style.opacity = past ? tilt * 0.45 : 0;
		f.cast.style.opacity = tilt * 0.6;
		f.el.style.transform = 'translate3d(' + (f.o0 + (f.o1 - f.o0) * p) + 'px,0,0)';
	}

	function ease(t) { return 1 - Math.pow(1 - t, 3); }

	// 今の進みから target（0 か 1）まで動かす
	function animateTo(target, done) {
		var f = flip;
		if (!f) { return; }
		cancelAnimationFrame(f.raf);
		clearTimeout(f.guard);
		f.target = target;
		var p0 = f.p, dist = Math.abs(target - p0);
		var dur = reduced.matches ? 0 : 520 * Math.max(0.35, dist);
		var t0 = performance.now();
		function finish() {
			if (flip !== f) { return; }
			settle(target === 1);
			if (done) { done(); }
		}
		function step(now) {
			if (flip !== f) { return; }
			var t = dur ? Math.min(1, (now - t0) / dur) : 1;
			setProgress(p0 + (target - p0) * ease(t));
			if (t < 1) { f.raf = requestAnimationFrame(step); return; }
			finish();
		}
		f.raf = requestAnimationFrame(step);
		// 裏に回ったタブなどで描画の番が来ないと、めくりが途中で止まったままになる。時間が来たら終わらせる
		f.guard = setTimeout(finish, dur + 200);
	}

	// めくりを終えて、静止の描き方に戻す
	function settle(turned) {
		var f = flip;
		if (!f) { return; }
		cancelAnimationFrame(f.raf);
		clearTimeout(f.guard);
		flip = null;
		book.classList.remove('is-flipping');
		current = turned ? f.to : f.from;
		render();
	}
	// 途中のめくりを、向かっていた側で即座に終わらせる（連打・大きさの変更・目次へのジャンプ・次のドラッグ）。
	// 戻りかけのめくりを「めくり切った」ことにすると、押していないページへ進んでしまう
	function finishFlip() {
		if (!flip) { return; }
		settle(flip.target === undefined ? flip.p >= 0.5 : flip.target === 1);
	}

	// 画像を待っている間に押された分は数えておき、めくり終えたら続けてめくる。
	// まとめて1回にすると、3回押したのに1枚しか進まない
	var ticket = 0, preparing = false, queued = 0, queuedSide = '';
	function goSide(side) {
		if (zoom.s > 1) { return; }
		if (preparing) {
			queued = side === queuedSide ? queued + 1 : 0;
			return;
		}
		// 前のめくりの途中なら、先に終わらせてから次をめくる（連打で置いていかれない）
		finishFlip();
		var to = sideIndex(side, current);
		if (!exists(to)) { queued = 0; return; }
		var my = ++ticket;
		preparing = true;
		queuedSide = side;
		var s = sheets[to];
		ready(spread ? [s.left, s.right] : [s.page]).then(function () {
			if (my !== ticket) { return; }
			preparing = false;
			if (flip || !startFlip(side)) { queued = 0; return; }
			animateTo(1, function () {
				if (queued > 0) { queued--; goSide(side); }
			});
		});
	}
	// めくりを待たずに別の場所へ移るときは、待っている分を捨てる
	function cancelPending() { ticket++; preparing = false; queued = 0; }

	// --- 拡大（.book-box に掛ける。めくったら元に戻す） ---
	var zoom = { s: 1, x: 0, y: 0 };
	function applyZoom(animate) {
		zoom.x = Math.min(0, Math.max(W - W * zoom.s, zoom.x));
		zoom.y = Math.min(0, Math.max(H - H * zoom.s, zoom.y));
		box.classList.toggle('is-zoom-anim', !!animate && !reduced.matches);
		box.style.transform = zoom.s > 1 ? 'translate(' + zoom.x + 'px,' + zoom.y + 'px) scale(' + zoom.s + ')' : '';
		view.classList.toggle('is-zoomed', zoom.s > 1);
	}
	// (px,py) … 枠の中の点。その点が動かないように倍率を変える
	function zoomAt(s, px, py, animate) {
		if (flip) { return; }
		s = Math.max(1, Math.min(4, s));
		zoom.x = px - (px - zoom.x) * (s / zoom.s);
		zoom.y = py - (py - zoom.y) * (s / zoom.s);
		zoom.s = s;
		if (s === 1) { zoom.x = 0; zoom.y = 0; }
		applyZoom(animate);
	}
	function resetZoom(animate) {
		if (zoom.s === 1 && !box.style.transform) { return; }
		zoom.s = 1; zoom.x = 0; zoom.y = 0;
		applyZoom(animate);
	}

	// --- 指・マウス ---
	var pts = {};          // 押している指（pointerId → 位置）
	var drag = null;       // 1本指の操作
	var pinch = null;      // 2本指の操作
	var lastTap = null;    // 2回押しの判定
	var tapTimer = null;

	function local(e) {
		var r = view.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	}
	function count() { return Object.keys(pts).length; }
	function pinchState() {
		var ids = Object.keys(pts), a = pts[ids[0]], b = pts[ids[1]];
		return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
	}

	view.addEventListener('pointerdown', function (e) {
		if (e.pointerType === 'mouse' && e.button !== 0) { return; }
		// マウスは1本しかない。枠の外で離されて pointerup が来なかった分が残ると、
		// 次のクリックが「2本目の指」と見なされて拡大の操作になってしまう
		if (e.pointerType === 'mouse') { pts = {}; pinch = null; }
		// 離した位置が枠の外でも pointerup がここに来るように捕まえておく
		try { view.setPointerCapture(e.pointerId); } catch (err) { /* 捕まえられなくても動く */ }
		var p = local(e);
		pts[e.pointerId] = p;
		if (count() === 2) {
			// 2本目が来たら、めくりは取りやめて拡大に切り替える
			if (drag && drag.flipping && flip) { animateTo(0); }
			drag = null;
			var st = pinchState();
			// 2本の指の真ん中にある誌面の点を覚えておき、その点が指の真ん中に居続けるように動かす
			pinch = { d: st.d, s: zoom.s, cx: (st.x - zoom.x) / zoom.s, cy: (st.y - zoom.y) / zoom.s };
			return;
		}
		drag = { x: p.x, y: p.y, t: e.timeStamp, id: e.pointerId, moving: false, panning: false, flipping: false, zx: zoom.x, zy: zoom.y, hist: [{ x: p.x, t: e.timeStamp }] };
	});

	view.addEventListener('pointermove', function (e) {
		if (e.pointerType === 'mouse' && !pts[e.pointerId]) {
			// 押していないマウス：どこを押すと何が起きるかをカーソルで知らせる
			var q = local(e);
			view.setAttribute('data-zone', zoneOf(q.x));
			return;
		}
		if (!pts[e.pointerId]) { return; }
		var p = local(e);
		pts[e.pointerId] = p;

		if (pinch && count() >= 2) {
			if (flip) { return; }
			var st = pinchState();
			zoom.s = Math.max(1, Math.min(4, pinch.s * st.d / pinch.d));
			zoom.x = st.x - pinch.cx * zoom.s;
			zoom.y = st.y - pinch.cy * zoom.s;
			applyZoom(false);
			e.preventDefault();
			return;
		}
		if (!drag || drag.id !== e.pointerId) { return; }
		var dx = p.x - drag.x, dy = p.y - drag.y;

		if (zoom.s > 1) {
			// 拡大中はめくらずに、見ている範囲を動かす
			if (!drag.panning && Math.hypot(dx, dy) > 6) { drag.panning = true; }
			if (drag.panning) {
				zoom.x = drag.zx + dx; zoom.y = drag.zy + dy;
				applyZoom(false);
				e.preventDefault();
			}
			return;
		}
		if (!drag.moving) {
			// 縦に動かしたときはページのスクロールに任せる（ページの中で読むとき）
			if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { drag = null; delete pts[e.pointerId]; return; }
			if (Math.abs(dx) < 8) { return; }
			drag.moving = true;
			// 指で紙をつかむ。左へ動かせば右の紙、右へ動かせば左の紙がめくれる
			var side = dx < 0 ? 'right' : 'left';
			drag.side = side;
			finishFlip();
			// 動きを減らす設定の人には、指に合わせて紙を回さない（離したときに切り替えるだけ）
			drag.flipping = reduced.matches ? false : !!startFlip(side);
		}
		e.preventDefault();
		// 離す直前の速さを測るため、直近の位置だけ残す
		drag.hist.push({ x: p.x, t: e.timeStamp });
		while (drag.hist.length > 2 && e.timeStamp - drag.hist[0].t > 120) { drag.hist.shift(); }
		if (!drag.flipping) { return; }
		// 指の動きを進みに写す。1.2ページぶん動かせばめくり切る
		// （2ページぶんにすると、スマホでは半ページ以上動かさないとめくれず、指に吸い付かない）
		var sgn = drag.side === 'right' ? -1 : 1;
		setProgress(Math.max(0, Math.min(1, (dx * sgn) / (pw * 1.2))));
	});

	function endPointer(e, cancelled) {
		if (!pts[e.pointerId]) { return; }
		var p = local(e);
		delete pts[e.pointerId];

		if (pinch) {
			if (count() < 2) {
				pinch = null;
				if (zoom.s < 1.05) { resetZoom(true); }
			}
			drag = null;
			return;
		}
		if (!drag || drag.id !== e.pointerId) { return; }
		var d = drag;
		drag = null;

		var dx = p.x - d.x, dy = p.y - d.y;
		if (d.moving) {
			// 離す直前の、めくる向きの速さ（px/ms）。戻す向きにはじいたら負になる
			var h0 = d.hist[0];
			var sgn = d.side === 'right' ? -1 : 1;
			var v = h0 ? ((p.x - h0.x) * sgn) / Math.max(1, e.timeStamp - h0.t) : 0;
			if (!d.flipping || !flip) {
				// 紙を回していない（動きを減らす設定）ときは、はっきり動かしたらめくる
				if (!cancelled && Math.abs(dx) > 40) { goSide(d.side); }
				return;
			}
			if (cancelled) { animateTo(0); return; }
			// 4分の1を越えたか、めくる向きに速くはじいたらめくり切る。戻す向きにはじいたら戻す
			var go = v < -0.35 ? false : (flip.p > 0.25 || v > 0.35);
			animateTo(go ? 1 : 0);
			return;
		}
		if (d.panning || cancelled) { return; }
		if (Math.hypot(dx, dy) < 10) { tap(p, e.timeStamp); }
	}
	view.addEventListener('pointerup', function (e) { endPointer(e, false); });
	view.addEventListener('pointercancel', function (e) { endPointer(e, true); });
	// 捕まえていた指を失ったとき（別の要素に奪われた等）も、めくりかけの紙を戻す
	view.addEventListener('lostpointercapture', function (e) { endPointer(e, true); });

	function zoneOf(x) {
		if (zoom.s > 1) { return 'zoomed'; }
		return x < W / 3 ? 'left' : (x > W * 2 / 3 ? 'right' : 'middle');
	}

	function tap(p, t) {
		var zone = zoneOf(p.x);
		var dbl = lastTap && t - lastTap.t < 300 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 40;
		if (dbl) {
			clearTimeout(tapTimer);
			lastTap = null;
			if (zoom.s > 1) { resetZoom(true); } else { zoomAt(2.5, p.x, p.y, true); }
			return;
		}
		// 左右はすぐめくる（2回押しを待つと、めくりが毎回もたつく）
		if (zone === 'left' || zone === 'right') {
			lastTap = null;
			goSide(zone);
			return;
		}
		// 真ん中（と拡大中）は、2回押しかどうかを少し待ってから決める
		lastTap = { x: p.x, y: p.y, t: t };
		clearTimeout(tapTimer);
		tapTimer = setTimeout(function () {
			lastTap = null;
			if (full && zoom.s === 1) { book.classList.toggle('ui-off'); }
		}, 300);
	}

	// トラックパッドの横スクロールで1枚ずつ。慣性で何枚も飛ばないよう、止まるまで次を受けない
	var wheelAcc = 0, wheelLock = false, wheelTimer = null;
	view.addEventListener('wheel', function (e) {
		if (e.ctrlKey) {
			// トラックパッドのピンチはブラウザには Ctrl+ホイールとして来る
			var p = local(e);
			zoomAt(zoom.s * Math.exp(-e.deltaY * 0.01), p.x, p.y, false);
			e.preventDefault();
			return;
		}
		if (zoom.s > 1) {
			zoom.x -= e.deltaX; zoom.y -= e.deltaY;
			applyZoom(false);
			e.preventDefault();
			return;
		}
		if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) { return; }
		e.preventDefault();
		clearTimeout(wheelTimer);
		wheelTimer = setTimeout(function () { wheelAcc = 0; wheelLock = false; }, 220);
		if (wheelLock) { return; }
		wheelAcc += e.deltaX;
		if (Math.abs(wheelAcc) > 40) {
			wheelLock = true;
			goSide(wheelAcc > 0 ? 'right' : 'left');
		}
	}, { passive: false });

	// --- ボタン・キー ---
	// 矢印は画面上の左右。右開きの号では左の矢印が「次のページ」になるので、読み上げの名前も入れ替える
	if (rtl) {
		var l = btnLeft.getAttribute('aria-label');
		btnLeft.setAttribute('aria-label', btnRight.getAttribute('aria-label'));
		btnRight.setAttribute('aria-label', l);
	}
	btnLeft.addEventListener('click', function () { goSide('left'); });
	btnRight.addEventListener('click', function () { goSide('right'); });

	function onKey(e) {
		if (e.key === 'ArrowRight') { goSide('right'); e.preventDefault(); }
		else if (e.key === 'ArrowLeft') { goSide('left'); e.preventDefault(); }
		else if (e.key === 'Escape') {
			if (zoom.s > 1) { resetZoom(true); } else if (full) { setFull(false); }
		}
	}
	view.addEventListener('keydown', onKey);
	document.addEventListener('keydown', function (e) {
		if (e.target === view) { return; }
		if (e.target === document.body || full) { onKey(e); }
	});
	range.addEventListener('input', function () { jump(sheetOf(parseInt(range.value, 10) || 1)); });

	// --- 全画面 ---
	// iPhone の Safari は要素の全画面（Fullscreen API）に対応していないので、
	// 画面いっぱいに広げるのは CSS（.is-full）で行い、使えるブラウザでは API も併せて呼ぶ
	function setFull(on) {
		if (on === full) { return; }
		full = on;
		book.classList.toggle('is-full', on);
		book.classList.remove('ui-off');
		document.body.classList.toggle('is-book-full', on);
		if (btnFull) {
			btnFull.setAttribute('aria-pressed', on ? 'true' : 'false');
			btnFull.querySelector('.label').textContent = btnFull.getAttribute(on ? 'data-off' : 'data-on');
		}
		if (on && book.requestFullscreen && !document.fullscreenElement) {
			book.requestFullscreen().catch(function () {});
		} else if (!on && document.fullscreenElement && document.exitFullscreen) {
			document.exitFullscreen().catch(function () {});
		}
		layout();
		view.focus({ preventScroll: true });
	}
	if (btnFull) {
		btnFull.hidden = false;
		btnFull.addEventListener('click', function () { setFull(!full); });
	}
	// ブラウザ側（Esc キー・戻る操作）で全画面が解けたときも、こちらの表示を戻す
	document.addEventListener('fullscreenchange', function () {
		if (!document.fullscreenElement && full) { setFull(false); }
	});

	// 目次・ページ一覧（開閉と、押したページへ）
	book.querySelectorAll('.book-tool').forEach(function (btn) {
		btn.addEventListener('click', function () {
			var name = btn.getAttribute('data-panel');
			book.querySelectorAll('.book-panel').forEach(function (p) {
				var open = p.getAttribute('data-panel') === name && p.hidden;
				p.hidden = !open;
			});
			book.querySelectorAll('.book-tool').forEach(function (b) { b.classList.toggle('is-on', b === btn && !book.querySelector('.book-panel[data-panel="' + name + '"]').hidden); });
			// 開いた面は見開きの下にあり、ボタンを押しても画面が変わらないので何も起きないように見えた（2026-10-03 テスト。
			// スマホでは目次の頭が y=837、PC でも y=1033 で画面の外）。開いたら面の頭まで送る
			var shown = book.querySelector('.book-panel[data-panel="' + name + '"]');
			if (shown && !shown.hidden) {
				shown.scrollIntoView({ behavior: reduced.matches ? 'auto' : 'smooth', block: 'start' });
			}
		});
	});
	book.querySelectorAll('.book-panel a[data-page]').forEach(function (a) {
		a.addEventListener('click', function (e) {
			e.preventDefault();
			jump(sheetOf(parseInt(a.getAttribute('data-page'), 10)));
			book.querySelectorAll('.book-panel').forEach(function (p) { p.hidden = true; });
			book.querySelectorAll('.book-tool').forEach(function (b) { b.classList.remove('is-on'); });
			stage.scrollIntoView({ behavior: reduced.matches ? 'auto' : 'smooth', block: 'start' });
		});
	});

	// 起動：JS無しの一覧を隠し、めくる画面を出す。#p=NN があればそのページから
	function start() {
		list.hidden = true;
		stage.hidden = false;
		bar.hidden = false;
		if (tools) { tools.hidden = false; }
		layout();
	}
	start();
	var resizeTimer = null;
	window.addEventListener('resize', function () {
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(layout, 150);
	});
	window.addEventListener('hashchange', function () {
		var m = /p=(\d+)/.exec(window.location.hash);
		if (m) { jump(sheetOf(parseInt(m[1], 10))); }
	});
})();
