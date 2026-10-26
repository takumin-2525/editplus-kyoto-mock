/**
 * イベント・催事（inc/events.php）の画面の動き
 *
 * 1. トップの「今日・明日・明後日」の切り替え
 * 2. 一覧（/events/）の月のカレンダー・「開催中／今後」の切り替え・日を押したときの一覧
 * 3. 1件のページの状態（開催中／まもなく／終了しました）
 *
 * どれも「今日」を**見ている人のブラウザで、サイトの時間帯（日本時間）の今日**として決める。
 * 検証サーバーのトップは nginx のページキャッシュが効き、モック（GitHub Pages の静的な写し）は作った日の HTML のまま止まるので、
 * サーバーが書いた「今日」は古いことがある。サーバーは先の日付ぶんの行を <template data-ev-pool> に埋め込んでおき、
 * ここで今日を決め直して、その中から選んで並べる（行の HTML はサーバーの editplus_event_row が正。ここでは組み立てない）。
 * 日付の書き方（「10月26日（月）」「Mon, Oct 26」）の部品は wp_localize_script の epEvents（inc/events.php の editplus_event_js_data）。
 */
(function () {
	'use strict';

	var D = window.epEvents;
	if (!D) { return; }
	var each = function (list, fn) { Array.prototype.forEach.call(list, fn); };
	// wp_localize_script は数をすべて文字列にして渡す（"7" のまま足すと、日付の計算が文字の連結になる）
	var SOON = parseInt(D.soon, 10) || 7, AHEAD = parseInt(D.ahead, 10) || 12, OFF = parseInt(D.off, 10) || 0;

	/* ---------- 日付 ---------- */
	function pad(n) { return (n < 10 ? '0' : '') + n; }
	function parse(ymd) { var p = ymd.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
	function ymdOf(d) { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
	function addDays(ymd, n) { var d = parse(ymd); d.setUTCDate(d.getUTCDate() + n); return ymdOf(d); }

	// サイトの時間帯での今日。Intl が時間帯を知らない古いブラウザでは、時差（分）で数える（日本は夏時間が無いので同じ答えになる）
	function today() {
		if (D.tz && window.Intl && Intl.DateTimeFormat) {
			try {
				var o = {};
				each(new Intl.DateTimeFormat('en-CA', { timeZone: D.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()), function (x) { o[x.type] = x.value; });
				if (o.year && o.month && o.day) { return o.year + '-' + o.month + '-' + o.day; }
			} catch (e) { /* 下の時差で数える */ }
		}
		return ymdOf(new Date(Date.now() + OFF * 60000));
	}

	// 書き方の型（{y}{m}{d}{w}{M}{F}）に日付を流し込む。PHP の editplus_event_fmt と同じ
	function fmt(ymd, tpl) {
		var p = ymd.split('-'), y = +p[0], m = +p[1], d = +p[2];
		return String(D.tpl[tpl] || D.tpl.md)
			.replace(/\{y\}/g, y).replace(/\{m\}/g, m).replace(/\{d\}/g, d)
			.replace(/\{w\}/g, D.wd[parse(ymd).getUTCDay()]).replace(/\{M\}/g, D.ms[m - 1]).replace(/\{F\}/g, D.mf[m - 1]);
	}
	function fmtYm(y, m) { return fmt(y + '-' + pad(m) + '-01', 'ym'); }
	function sp(s, v) { return String(s).replace(/%[sd]/, v); }
	function dayUrl(day) { return D.events + (D.events.indexOf('?') === -1 ? '?' : '&') + 'date=' + day; }

	function status(start, end, t) {
		if (end < t) { return 'ended'; }
		if (start <= t) { return 'ongoing'; }
		return start <= addDays(t, SOON) ? 'soon' : 'later';
	}

	/* ---------- 行（サーバーが書いた行を選んで複製する） ---------- */
	function poolRows(root) {
		var tpl = root.querySelector('template[data-ev-pool]');
		if (!tpl || !tpl.content) { return null; }
		return Array.prototype.slice.call(tpl.content.querySelectorAll('li.ev-row'));
	}
	function isOn(li, day) { return li.getAttribute('data-start') <= day && day <= li.getAttribute('data-end'); }
	function onDay(rows, day) { return rows.filter(function (li) { return isOn(li, day); }); }
	// 並べた行を描き直す。「最終日」の札は、見ている日が会期の最終日のときだけ（1日だけの催しには付けない）
	function fill(ul, rows, ref) {
		ul.innerHTML = '';
		rows.forEach(function (li) {
			var c = li.cloneNode(true), s = c.getAttribute('data-start'), e = c.getAttribute('data-end');
			var last = c.querySelector('.ev-last');
			if (last) { last.hidden = !(ref && s !== e && ref === e); }
			ul.appendChild(c);
		});
	}

	var T = today();

	/* ---------- 1. トップの「今日・明日・明後日」 ---------- */
	each(document.querySelectorAll('[data-ev-top]'), function (sec) {
		var rows = poolRows(sec);
		var wrap = sec.querySelector('[data-ev-days]'), panel = sec.querySelector('[data-ev-panel]');
		if (!rows || !wrap || !panel) { return; }
		var count = parseInt(sec.getAttribute('data-count'), 10) || 4;
		var ul = panel.querySelector('.ev-list'), empty = panel.querySelector('.ev-empty'), more = panel.querySelector('.ev-more');
		var tabs = wrap.querySelectorAll('.ev-days__tab');
		wrap.setAttribute('role', 'tablist');
		panel.setAttribute('role', 'tabpanel');

		function show(i, focus) {
			var day = addDays(T, i), on = onDay(rows, day);
			each(tabs, function (a, j) {
				a.setAttribute('aria-selected', i === j ? 'true' : 'false');
				a.setAttribute('tabindex', i === j ? '0' : '-1');
				a.classList.toggle('is-on', i === j);
			});
			panel.setAttribute('aria-labelledby', tabs[i].id);
			fill(ul, on.slice(0, count), day);
			empty.hidden = on.length > 0;
			more.hidden = on.length <= count;
			if (on.length > count) {
				var a = more.querySelector('a');
				a.href = dayUrl(day);
				a.textContent = sp(D.t.more, on.length - count);
			}
			if (focus) { tabs[i].focus(); }
		}
		// 切り替えの日付は、見ている人の今日で書き直す（サーバーが書いた日付はキャッシュで古いことがある）
		each(tabs, function (a, i) {
			var day = addDays(T, i);
			a.id = 'evTopDay' + i;
			a.setAttribute('role', 'tab');
			a.setAttribute('aria-controls', panel.id);
			a.removeAttribute('aria-current');
			a.href = dayUrl(day);
			a.querySelector('.ev-days__date').textContent = fmt(day, 'md');
			a.addEventListener('click', function (e) { e.preventDefault(); show(i, false); });
			a.addEventListener('keydown', function (e) {
				var dir = e.key === 'ArrowRight' ? 1 : (e.key === 'ArrowLeft' ? -1 : 0);
				if (dir) { e.preventDefault(); show((i + dir + tabs.length) % tabs.length, true); }
			});
		});
		show(0, false);
	});

	/* ---------- 2. 一覧（/events/） ---------- */
	each(document.querySelectorAll('[data-ev-archive]'), function (main) {
		var rows = poolRows(main);
		var cal = main.querySelector('[data-ev-cal]'), tabsWrap = main.querySelector('[data-ev-tabs]');
		if (!rows || !cal || !tabsWrap) { return; }
		var secs = {
			day: main.querySelector('[data-sec="day"]'),
			now: main.querySelector('[data-sec="now"]'),
			next: main.querySelector('[data-sec="next"]')
		};
		var tabs = tabsWrap.querySelectorAll('[data-tab]');
		var clearBtn = main.querySelector('[data-ev-clear]');
		var narrow = window.matchMedia ? window.matchMedia('(max-width: 1023px)') : { matches: false };

		// 開催中は終わりの早い順（埋め込んだ並びのまま）、今後は始まりの早い順
		var now = onDay(rows, T);
		var next = rows.filter(function (li) { return li.getAttribute('data-start') > T; }).sort(function (a, b) {
			return (a.getAttribute('data-start') + a.getAttribute('data-end')).localeCompare(b.getAttribute('data-start') + b.getAttribute('data-end'))
				|| (+a.getAttribute('data-i')) - (+b.getAttribute('data-i'));
		});
		fill(secs.now.querySelector('.ev-list'), now, T);
		secs.now.querySelector('.ev-empty').hidden = now.length > 0;
		fill(secs.next.querySelector('.ev-list'), next, '');
		secs.next.querySelector('.ev-empty').hidden = next.length > 0;
		tabs[0].querySelector('.ev-tabs__n').textContent = now.length;
		tabs[1].querySelector('.ev-tabs__n').textContent = next.length;

		// 日ごとの件数（カレンダーの印と、読み上げの「イベント3件」）
		var perDay = {};
		rows.forEach(function (li) {
			var d = li.getAttribute('data-start'), e = li.getAttribute('data-end'), guard = 0;
			while (d <= e && guard++ < 400) { perDay[d] = (perDay[d] || 0) + 1; d = addDays(d, 1); }
		});

		var state = { tab: 'now', day: '' };
		var t0 = parse(T);
		var minYm = t0.getUTCFullYear() * 12 + t0.getUTCMonth() - 1;     // 前の月まで戻れる
		var maxYm = t0.getUTCFullYear() * 12 + t0.getUTCMonth() + AHEAD;
		var view = t0.getUTCFullYear() * 12 + t0.getUTCMonth();

		function render(focusDay) {
			var showDay = state.day !== '';
			secs.day.hidden = !showDay;
			secs.now.hidden = showDay || state.tab !== 'now';
			secs.next.hidden = showDay || state.tab !== 'next';
			clearBtn.hidden = !showDay;
			each(tabs, function (b) {
				var on = !showDay && b.getAttribute('data-tab') === state.tab;
				b.setAttribute('aria-selected', on ? 'true' : 'false');
				b.setAttribute('tabindex', (on || (showDay && b.getAttribute('data-tab') === state.tab)) ? '0' : '-1');
			});
			if (showDay) {
				var list = onDay(rows, state.day);
				secs.day.querySelector('.ev-sec__ttl').textContent = sp(D.t.dayTitle, fmt(state.day, 'md'));
				fill(secs.day.querySelector('.ev-list'), list, state.day);
				secs.day.querySelector('.ev-empty').hidden = list.length > 0;
			}
			renderCal(focusDay);
		}

		function renderCal(focusDay) {
			var y = Math.floor(view / 12), m = view % 12 + 1;
			var first = new Date(Date.UTC(y, m - 1, 1)), days = new Date(Date.UTC(y, m, 0)).getUTCDate(), lead = first.getUTCDay();
			var h = '<div class="ev-cal__head">'
				+ '<button type="button" class="ev-cal__nav" data-move="-1" aria-label="' + esc(D.t.prev) + '"' + (view <= minYm ? ' disabled' : '') + '><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true" focusable="false"><path d="M15.5 4 7.5 12l8 8"/></svg></button>'
				+ '<h2 class="ev-cal__ttl" aria-live="polite">' + esc(fmtYm(y, m)) + '</h2>'
				+ '<button type="button" class="ev-cal__nav" data-move="1" aria-label="' + esc(D.t.next) + '"' + (view >= maxYm ? ' disabled' : '') + '><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true" focusable="false"><path d="M8.5 4l8 8-8 8"/></svg></button>'
				+ '</div><table class="ev-cal__grid"><thead><tr>';
			for (var w = 0; w < 7; w++) { h += '<th scope="col" class="ev-cal__wd' + (w === 0 ? ' is-sun' : (w === 6 ? ' is-sat' : '')) + '">' + esc(D.wd[w]) + '</th>'; }
			h += '</tr></thead><tbody><tr>';
			for (var i = 0; i < lead; i++) { h += '<td></td>'; }
			for (var d = 1; d <= days; d++) {
				var ymd = y + '-' + pad(m) + '-' + pad(d), n = perDay[ymd] || 0, col = (lead + d - 1) % 7;
				var cls = 'ev-cal__day' + (ymd === T ? ' is-today' : '') + (ymd < T ? ' is-past' : '') + (col === 0 ? ' is-sun' : (col === 6 ? ' is-sat' : ''));
				if (col === 0 && d > 1) { h += '</tr><tr>'; }
				if (n) {
					var label = fmt(ymd, 'md') + ' ' + (n === 1 ? D.t.count1 : sp(D.t.countN, n));
					h += '<td><button type="button" class="' + cls + ' has-ev' + (ymd === state.day ? ' is-on' : '') + '" data-day="' + ymd + '" aria-pressed="' + (ymd === state.day ? 'true' : 'false') + '" aria-label="' + esc(label) + '"' + (ymd === T ? ' aria-current="date"' : '') + '><span>' + d + '</span><i class="ev-cal__dot" aria-hidden="true"></i></button></td>';
				} else {
					h += '<td><span class="' + cls + '"' + (ymd === T ? ' aria-current="date"' : '') + '><span>' + d + '</span></span></td>';
				}
			}
			for (var k = (lead + days) % 7; k && k < 7; k++) { h += '<td></td>'; }
			h += '</tr></tbody></table>';
			cal.innerHTML = h;
			if (focusDay) {
				var b = cal.querySelector('[data-day="' + focusDay + '"]') || cal.querySelector('.ev-cal__nav:not([disabled])');
				if (b) { b.focus(); }
			}
		}
		function esc(s) { var x = document.createElement('div'); x.textContent = s == null ? '' : String(s); return x.innerHTML; }

		// 選んだ日を URL にも残す（そのまま送れば同じ日が開く。再読み込みしても同じ日）
		function remember() {
			if (!window.history || !history.replaceState) { return; }
			var u = new URL(location.href);
			if (state.day) { u.searchParams.set('date', state.day); } else { u.searchParams.delete('date'); }
			history.replaceState(null, '', u.toString());
		}

		cal.addEventListener('click', function (e) {
			var nav = e.target.closest('.ev-cal__nav');
			if (nav && !nav.disabled) {
				view = Math.max(minYm, Math.min(maxYm, view + parseInt(nav.getAttribute('data-move'), 10)));
				renderCal();
				var again = cal.querySelector('.ev-cal__nav[data-move="' + nav.getAttribute('data-move') + '"]:not([disabled])') || cal.querySelector('.ev-cal__nav:not([disabled])');
				if (again) { again.focus(); }
				return;
			}
			var btn = e.target.closest('.ev-cal__day[data-day]');
			if (!btn) { return; }
			var day = btn.getAttribute('data-day');
			state.day = state.day === day ? '' : day; // 選んでいる日をもう一度押すと外れる
			render(day);
			remember();
			// スマホではカレンダーの下に一覧があるので、選んだ日の一覧が画面の外なら見える所まで送る
			if (state.day && narrow.matches) {
				var r = secs.day.getBoundingClientRect();
				if (r.top > window.innerHeight - 120) { secs.day.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
			}
		});
		clearBtn.addEventListener('click', function () {
			state.day = '';
			render();
			remember();
			var cur = tabsWrap.querySelector('[data-tab="' + state.tab + '"]');
			if (cur) { cur.focus(); }
		});
		each(tabs, function (b, i) {
			b.addEventListener('click', function () { state.tab = b.getAttribute('data-tab'); state.day = ''; render(); remember(); });
			b.addEventListener('keydown', function (e) {
				var dir = e.key === 'ArrowRight' ? 1 : (e.key === 'ArrowLeft' ? -1 : 0);
				if (!dir) { return; }
				e.preventDefault();
				var to = tabs[(i + dir + tabs.length) % tabs.length];
				state.tab = to.getAttribute('data-tab'); state.day = '';
				render(); remember(); to.focus();
			});
		});

		// ?date= で開いたら、その日を選んだ状態で始める（モックの静的な写しでも効くよう、URL からも読む）
		var asked = main.getAttribute('data-day') || '';
		try { asked = new URL(location.href).searchParams.get('date') || asked; } catch (e) { /* 古いブラウザは data-day だけ */ }
		if (/^\d{4}-\d{2}-\d{2}$/.test(asked)) {
			var a = parse(asked), ym = a.getUTCFullYear() * 12 + a.getUTCMonth();
			if (ym >= minYm && ym <= maxYm) { state.day = asked; view = ym; }
		}
		secs.now.setAttribute('role', 'tabpanel'); secs.now.setAttribute('aria-labelledby', 'evTabNow');
		secs.next.setAttribute('role', 'tabpanel'); secs.next.setAttribute('aria-labelledby', 'evTabNext');
		main.classList.add('is-js');
		tabsWrap.hidden = false;
		cal.hidden = false;
		render();
	});

	/* ---------- 3. 1件のページの状態 ---------- */
	each(document.querySelectorAll('[data-ev-status]'), function (el) {
		var st = status(el.getAttribute('data-start'), el.getAttribute('data-end'), T);
		var label = { ongoing: D.t.ongoing, soon: D.t.soon, ended: D.t.ended }[st] || '';
		el.textContent = label;
		el.hidden = !label;
		el.className = 'ev-status ev-status--' + st;
	});
})();
