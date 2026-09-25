/**
 * 誌面（デジタルブック）の閲覧。
 *
 * PC は見開き（表紙だけ1枚）、スマホは1ページずつ。どちらも横スクロール＋スナップで
 * 「めくる」動きを作る（ブラウザ任せなので、スワイプもトラックパッドもキーボードも同じ道を通る）。
 * 画像は今のページの前後2枚だけ読む（236ページを一度に読まない）。
 * URL の #p=12 でページを共有できる。ページを押すと原寸で拡大（小さな文字を読むため）。
 */
(function () {
	'use strict';
	var book = document.getElementById('book');
	if (!book) { return; }

	var pages = parseInt(book.getAttribute('data-pages'), 10) || 0;
	var base = book.getAttribute('data-base');
	var ratio = parseFloat(book.getAttribute('data-ratio')) || 1.4142;
	var rtl = book.getAttribute('data-rtl') === '1';
	var track = book.querySelector('.book-track');
	var stage = book.querySelector('.book-stage');
	var bar = book.querySelector('.book-bar');
	var range = book.querySelector('.book-range');
	var no = book.querySelector('.book-no');
	var tools = book.querySelector('.book-tools');
	var list = book.querySelector('.book-pages');
	var zoom = book.querySelector('.book-zoom');
	var mq = window.matchMedia('(min-width: 841px)');
	if (!pages || !track) { return; }

	function src(n) { return base + 'p' + String(n).padStart(4, '0') + '.jpg'; }

	// --- 台紙（sheet）の組み立て。PC: [1] [2,3] [4,5] …　スマホ: [1] [2] [3] … ---
	var sheets = [];   // 各台紙に載るページ番号の配列
	var current = 0;   // 今の台紙の添字
	var spread = false;

	function build() {
		spread = mq.matches;
		sheets = [];
		if (spread) {
			sheets.push([1]);
			for (var p = 2; p <= pages; p += 2) {
				sheets.push(p + 1 <= pages ? [p, p + 1] : [p]);
			}
		} else {
			for (var q = 1; q <= pages; q++) { sheets.push([q]); }
		}
		track.innerHTML = '';
		sheets.forEach(function (ps, i) {
			var sheet = document.createElement('div');
			sheet.className = 'book-sheet' + (ps.length === 1 ? ' is-single' : '');
			sheet.setAttribute('data-i', i);
			var order = (rtl && ps.length === 2) ? [ps[1], ps[0]] : ps;
			order.forEach(function (n) {
				var fig = document.createElement('div');
				fig.className = 'book-page' + (ps.length === 1 ? '' : (order.indexOf(n) === 0 ? ' is-left' : ' is-right'));
				fig.style.aspectRatio = '1 / ' + ratio;
				var img = document.createElement('img');
				img.alt = 'p.' + n;
				img.setAttribute('data-src', src(n));
				img.setAttribute('data-page', n);
				img.decoding = 'async';
				fig.appendChild(img);
				sheet.appendChild(fig);
			});
			track.appendChild(sheet);
		});
	}

	function sheetOf(page) {
		for (var i = 0; i < sheets.length; i++) {
			if (sheets[i].indexOf(page) !== -1) { return i; }
		}
		return 0;
	}

	// 今の台紙の前後2枚だけ画像を読む
	function load(i) {
		for (var k = Math.max(0, i - 2); k <= Math.min(sheets.length - 1, i + 2); k++) {
			var imgs = track.children[k].querySelectorAll('img[data-src]');
			for (var j = 0; j < imgs.length; j++) {
				imgs[j].src = imgs[j].getAttribute('data-src');
				imgs[j].removeAttribute('data-src');
			}
		}
	}

	function goto(i, smooth) {
		i = Math.max(0, Math.min(sheets.length - 1, i));
		var el = track.children[i];
		if (!el) { return; }
		load(i);
		track.scrollTo({ left: el.offsetLeft - (track.clientWidth - el.clientWidth) / 2, behavior: smooth ? 'smooth' : 'auto' });
		setCurrent(i);
	}

	function setCurrent(i) {
		current = i;
		var ps = sheets[i];
		var label = ps.length === 2 ? ps[0] + '–' + ps[1] : String(ps[0]);
		no.textContent = label + ' / ' + pages;
		range.value = ps[0];
		var h = '#p=' + ps[0];
		if (window.location.hash !== h) { history.replaceState(null, '', h); }
		book.classList.toggle('at-start', i === 0);
		book.classList.toggle('at-end', i === sheets.length - 1);
	}

	// スクロール（スワイプ）で止まった位置から今の台紙を求める
	var scrollTimer = null;
	track.addEventListener('scroll', function () {
		clearTimeout(scrollTimer);
		scrollTimer = setTimeout(function () {
			var mid = track.scrollLeft + track.clientWidth / 2;
			var best = 0, dist = Infinity;
			for (var k = 0; k < track.children.length; k++) {
				var c = track.children[k];
				var d = Math.abs(c.offsetLeft + c.clientWidth / 2 - mid);
				if (d < dist) { dist = d; best = k; }
			}
			if (best !== current) { setCurrent(best); }
			load(best);
		}, 80);
	}, { passive: true });

	book.querySelector('.book-prev').addEventListener('click', function () { goto(current - 1, true); });
	book.querySelector('.book-next').addEventListener('click', function () { goto(current + 1, true); });
	track.addEventListener('keydown', function (e) {
		if (e.key === 'ArrowRight') { goto(current + (rtl ? -1 : 1), true); e.preventDefault(); }
		if (e.key === 'ArrowLeft') { goto(current - (rtl ? -1 : 1), true); e.preventDefault(); }
	});
	document.addEventListener('keydown', function (e) {
		if (e.target !== document.body || zoom && !zoom.hidden) { return; }
		if (e.key === 'ArrowRight') { goto(current + (rtl ? -1 : 1), true); }
		if (e.key === 'ArrowLeft') { goto(current - (rtl ? -1 : 1), true); }
	});
	range.addEventListener('input', function () { goto(sheetOf(parseInt(range.value, 10) || 1), false); });

	// 目次・ページ一覧（開閉と、押したページへ）
	book.querySelectorAll('.book-tool').forEach(function (btn) {
		btn.addEventListener('click', function () {
			var name = btn.getAttribute('data-panel');
			book.querySelectorAll('.book-panel').forEach(function (p) {
				var open = p.getAttribute('data-panel') === name && p.hidden;
				p.hidden = !open;
			});
			book.querySelectorAll('.book-tool').forEach(function (b) { b.classList.toggle('is-on', b === btn && !book.querySelector('.book-panel[data-panel="' + name + '"]').hidden); });
		});
	});
	book.querySelectorAll('.book-panel a[data-page]').forEach(function (a) {
		a.addEventListener('click', function (e) {
			e.preventDefault();
			goto(sheetOf(parseInt(a.getAttribute('data-page'), 10)), false);
			book.querySelectorAll('.book-panel').forEach(function (p) { p.hidden = true; });
			book.querySelectorAll('.book-tool').forEach(function (b) { b.classList.remove('is-on'); });
			stage.scrollIntoView({ behavior: 'smooth', block: 'start' });
		});
	});

	// 拡大：ページを押すと原寸で、指やスクロールで読める
	if (zoom) {
		var zimg = zoom.querySelector('img');
		track.addEventListener('click', function (e) {
			var img = e.target.closest && e.target.closest('img[data-page]');
			if (!img || !img.src) { return; }
			zimg.src = img.src;
			zoom.hidden = false;
			document.body.classList.add('book-zoomed');
			zoom.querySelector('.book-zoom-inner').scrollTop = 0;
		});
		function closeZoom() { zoom.hidden = true; document.body.classList.remove('book-zoomed'); }
		zoom.querySelector('.book-zoom-close').addEventListener('click', closeZoom);
		zoom.addEventListener('click', function (e) { if (e.target === zoom || e.target === zimg) { closeZoom(); } });
		document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !zoom.hidden) { closeZoom(); } });
	}

	// 起動：JS無しの一覧を隠し、見開きを出す。#p=NN があればそのページから
	function start() {
		build();
		list.hidden = true;
		stage.hidden = false;
		bar.hidden = false;
		if (tools) { tools.hidden = false; }
		var m = /p=(\d+)/.exec(window.location.hash);
		goto(sheetOf(m ? Math.min(pages, Math.max(1, parseInt(m[1], 10))) : 1), false);
	}
	start();
	var resizeTimer = null;
	window.addEventListener('resize', function () {
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(function () {
			if (mq.matches !== spread) {
				var page = sheets[current][0];
				build();
				goto(sheetOf(page), false);
			} else {
				goto(current, false);
			}
		}, 150);
	});
	window.addEventListener('hashchange', function () {
		var m = /p=(\d+)/.exec(window.location.hash);
		if (m) { var i = sheetOf(parseInt(m[1], 10)); if (i !== current) { goto(i, true); } }
	});
})();
