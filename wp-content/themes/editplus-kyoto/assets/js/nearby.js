/**
 * ホテル／いまいる場所から（/nearby/）
 * 出発点を選ぶ → ① あなたの京都、どう巡る？（quiz.js の epQuizMount に出発点を渡す）
 *              → ② 近くの行き先（REST editplus/v1/nearby が写真つきの行のHTMLを返す）
 *
 * 出発点は見開きのタブで選ぶ。
 *   現在地から … 「現在地から探す」→ 位置情報 → nearby に lat/lng
 *   ホテルから … 入力するそばから候補（REST editplus/v1/origins?q=）→ 選ぶ
 *               候補は3種類: 提携ホテル（先）・駅・提携していない宿（京都市の許可施設一覧）。2026-10-03
 *               ホテル・宿は nearby に hotel=<ID>、駅は station=<キー>
 * 選んだあとは同じ流れ（show()）。違うのは REST に渡す引数と、要約の名乗り方
 * （現在地は「◯◯のあたり」、ホテル・宿・駅は「◯◯から」）だけ。
 * **「ホテルから探す」と「現在地から探す」は同じ機能**（野口）。提携ホテルを選んでも専用ページへは移らない
 * （要約の横に「このホテルの専用ページ」を小さく出すだけ）。
 *
 * 並び（2026-10-03）: 出発点が決まったら、すぐ下に「あなたの京都、どう巡る？」（トップの診断と同じ見出し・見た目）、
 * その下に近くの行き先。選んだらコースの欄へスクロールする。
 *
 * URL: ホテル・宿は /nearby/?hotel=<ID>、駅は /nearby/?station=<キー>。直接開かれたらサーバーが選んだ状態で描いてくるので、
 * ここはそのまま流れを始める。現在地のときは /nearby/ のまま（座標をURLに出さない）。
 * どれも出発点を history.state に持たせ、同じページの中の「戻る」（popstate）で描き直す。
 *
 * 位置情報の許可は**ボタンを押したときに初めて**聞く。開いただけでダイアログを出すと、
 * 何に使うのか分からないまま断られ、ブラウザはその判断を覚えてしまう。
 * 京都の外・拒否・時間切れのときは、文をボタンのすぐ下に出して画面の中まで動かし、「ホテルや駅から探す」を出す。
 * 範囲の箱の中でも近くの行き先が0件（大阪駅など）なら京都の外と同じに扱い、コースの欄は出さない。
 *
 * 出発点が決まったら写真と紙を畳み（.nearby-fv--done）、帯に「京都駅から」を大きく、
 * 「JR・近鉄・地下鉄｜近くの行き先 20件 ・ 徒歩2〜18分」を小さく出す。**どこを出発点と受け取ったかを名乗る**ため。
 * → 60_デザイン/2026-09-17_現在地から探す画面のデザイン監査.md
 *
 * 結果の画面（2026-10-07 案A 地図と一覧 → 60_デザイン/2026-10-07_ホテル・いまいる場所からの案.md）:
 * 一覧は最初 PC 8件・スマホ 6件（「残り◯件を見る」で開く）。右（スマホは上）に地図。地図は国土地理院の淡色地図を
 * タイルのまま並べ、出発点を真ん中に、徒歩5・10・15分の輪と行き先の点を置く。行に触れると点が濃くなり、点を押すと行へ移る。
 * 地図のライブラリは使わない ―― 動かしたり拡大したりする地図ではなく、一覧の位置関係を1枚で見せる図なので、
 * 数十行で足り、約150KBのライブラリを読ませずに済む。
 */
(function () {
	'use strict';

	var T = window.epQuizI18n || {};
	var t = function (key, fallback) { return T[key] || fallback; };
	var byId = function (id) { return document.getElementById(id); };
	var ICONS = window.epIcons || {};

	var fv = byId('nearbyFv');
	var tabHere = byId('nearbyTabHere');
	var tabHotel = byId('nearbyTabHotel');
	var btn = byId('nearbyStart');
	var hereAlt = byId('nearbyHereAlt');
	var hotelForm = byId('nearbyHotelForm');
	var hotelQ = byId('nearbyHotelQ');
	var suggest = byId('nearbyHotelSuggest');
	var hotelMsg = byId('nearbyHotelMsg');
	var hereMsg = byId('nearbyHereMsg');
	var msg = byId('nearbyMsg');
	var again = byId('nearbyAgain');
	var toHotel = byId('nearbyToHotel');
	var otherHotel = byId('nearbyOtherHotel');
	var toHere = byId('nearbyToHere');
	var partner = byId('nearbyPartner');
	var cancel = byId('nearbyCancel');
	var filterMsg = byId('nearbyFilterMsg');
	var nearSec = byId('nearby');
	var grid = byId('nearbyGrid');
	var genres = byId('nearbyGenres');
	var courseSec = byId('course');
	var courseLead = byId('nearbyCourseLead');
	var quizEl = byId('epNearbyQuiz');
	var mainEl = document.querySelector('.nearby-main');
	var moreBtn = byId('nearbyMore');
	var mapCol = byId('nearbyMapCol');
	var mapEl = byId('nearbyMap');
	var mapToggle = byId('nearbyMapToggle');
	// 直接開いたときの「読み込み中」の構え（コースの欄を先に出し、「位置情報を使わないときは」を隠す → nearby.php）を解く
	var settle = function () { if (mainEl) { mainEl.classList.remove('nearby-main--pending'); } };
	if (!fv || !tabHere || !tabHotel || !btn || !hotelForm || !hotelQ || !suggest || !grid || !quizEl || !courseSec) return;

	// スポットを見て「戻る」で帰ってきたとき、もう一度ボタンを押させないために
	// 取れた座標をタブの中だけに残す（タブを閉じれば消える。サーバには保存しない）
	var ORIGIN_KEY = 'epNearbyOrigin';
	// このページの素のURL（言語つき・クエリなし）。候補のリンク（別タブで開かれたとき）の ?hotel= はサーバーが付けてくる
	var BASE = fv.getAttribute('data-base') || (location.origin + location.pathname);
	// 位置情報は https（と localhost）でしか取れない。押しても必ず失敗するものは出さない
	var GEO_OK = !!navigator.geolocation && window.isSecureContext !== false;

	// 外国語のページでも宿の名前は日本語で来る（一覧が日本語だけ）。文節で折る指定（:lang(ja)）と読み上げのため
	// lang="ja" を付ける。中国語のページでは、仮名を含まない漢字の名前は中国語として読めるので付けない
	var PAGE_JA = /^ja/i.test(document.documentElement.lang || '');
	var PAGE_ZH = /^zh/i.test(document.documentElement.lang || '');
	var isJa = function (text) {
		var s = String(text || '');
		if (PAGE_JA) { return false; }
		if (/[぀-ゟ゠-ヺヽ-ヿ]/.test(s)) { return true; }
		return !PAGE_ZH && /[㐀-鿿]/.test(s);
	};
	var jaEl = function (tag, text) {
		var el = document.createElement(tag);
		el.textContent = text;
		if (isJa(text)) el.lang = 'ja';
		return el;
	};

	// いま画面に出している結果の出発点。null＝まだ何も出していない
	//   { kind: 'geo', origin: { lat, lng } }
	//   { kind: 'hotel' | 'lodging' | 'station', id: ID・キー, name: 名前, reading: 読み, partner: 専用ページのURL }
	var current = null;
	// current を出したときの REST の応答と出発点。要約（#nearbyMsg）を描き直すために持っておく
	var shown = null;

	var say = function (text) { if (msg) msg.textContent = text || ''; };
	var sayFilter = function (text) { if (filterMsg) filterMsg.textContent = text || ''; };
	var sayHotel = function (text) { if (hotelMsg) hotelMsg.textContent = text || ''; };
	var sayHere = function (text) {
		if (hereMsg) hereMsg.textContent = text || '';
		if (!text && hereAlt) { hereAlt.hidden = true; }
	};
	// 結果を出したまま、畳んだ見開きの中でタブを開き直しているか（.nearby-fv--choosing）
	var choosing = function () { return !!current && fv.classList.contains('nearby-fv--choosing'); };
	var isPlace = function (o) { return !!o && (o.kind === 'hotel' || o.kind === 'lodging' || o.kind === 'station'); };

	// 取得のたびに増やす。応答が返ったとき自分が最新でなければ捨てる。
	// 「取り直す」を続けて押す・ホテルを続けて選ぶと、**古い出発点の応答が後から届いて最新の結果を上書きする**
	var seq = 0;
	// 位置情報の問い合わせの番号。seq と同じ考え方で、「やめる」を押したあとに返ってきた位置を捨てる
	var locateSeq = 0;
	var submitBtn = hotelForm.querySelector('[type=submit]');
	// 取得中は出発点を決めるボタンをどれも押せなくする
	var busy = function (on) {
		btn.disabled = on;
		if (again) again.disabled = on;
		if (submitBtn) submitBtn.disabled = on;
	};

	var validGeo = function (o) { return !!o && typeof o.lat === 'number' && typeof o.lng === 'number'; };
	var savedGeo = function () {
		var o = null;
		try { o = JSON.parse(sessionStorage.getItem(ORIGIN_KEY) || 'null'); } catch (e) { /* 壊れた値は無視 */ }
		return validGeo(o) ? o : null;
	};

	// 画面の中に見えていなければ、その要素が見えるところまで動かす（固定ヘッダーの下・画面の真ん中あたり）
	function bringIntoView(el) {
		if (!el) { return; }
		var r = el.getBoundingClientRect();
		var head = document.querySelector('.site-header');
		var top = head ? head.getBoundingClientRect().bottom : 0;
		if (r.top >= top + 8 && r.bottom <= window.innerHeight - 8) { return; }
		el.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}

	/* ---------- 1. タブ（/hotel/ の finder と同じ部品。矢印キーで移る） ---------- */

	var TABS = [tabHere, tabHotel];
	function selectTab(tab, focus) {
		TABS.forEach(function (b) {
			var on = (b === tab);
			b.classList.toggle('on', on);
			b.setAttribute('aria-selected', on ? 'true' : 'false');
			// タブキーで止まるのは選んでいるタブ1つだけ。ほかへは矢印で移る（WAI-ARIA の tabs の作法）
			b.tabIndex = on ? 0 : -1;
			var panel = byId(b.getAttribute('aria-controls'));
			if (panel) { panel.hidden = !on; }
		});
		closeSuggest();
		if (focus) { tab.focus(); }
	}
	TABS.forEach(function (b) {
		b.addEventListener('click', function () { selectTab(b, false); });
		b.addEventListener('keydown', function (e) {
			// 隠したタブ（位置情報の無い端末の「現在地から」）には移らない
			var list = TABS.filter(function (x) { return !x.hidden; });
			var i = list.indexOf(b);
			var next = null;
			if (e.key === 'ArrowRight') { next = list[(i + 1) % list.length]; }
			else if (e.key === 'ArrowLeft') { next = list[(i - 1 + list.length) % list.length]; }
			else if (e.key === 'Home') { next = list[0]; }
			else if (e.key === 'End') { next = list[list.length - 1]; }
			if (!next || next === b) { return; }
			e.preventDefault();
			selectTab(next, true);
		});
	});

	// 「現在地から探す」が使えなかったときの次の一手。「ホテルから」タブに移って入力欄にフォーカスする
	function goHotelTab() {
		if (current) { fv.classList.add('nearby-fv--choosing'); }
		selectTab(tabHotel, false);
		sayHere('');
		hotelQ.focus();
		bringIntoView(hotelForm);
	}
	if (hereAlt) { hereAlt.addEventListener('click', goHotelTab); }

	/* ---------- 2. 出発点の候補（提携ホテル・駅・提携していない宿） ---------- */
	// 候補を押してもページは離れず、その場所を出発点にする。候補の行の構造（.s-name / .s-area）は app.js の /hotel/ と同じ見た目。
	// 入力欄は combobox、候補は listbox。選んでいる候補は aria-activedescendant で伝える
	// （フォーカスは入力欄に置いたまま、矢印キーで候補を移る）

	var sugTimer = null;
	var lastQ = hotelQ.value.trim();
	var selIdx = -1;
	var found = [];

	function originsUrl(q) {
		// data-endpoint には表示言語が ?lang= で載っている（nearby.php）。'?' 決め打ちで足すと lang が消える
		var base = hotelQ.getAttribute('data-endpoint');
		return base + (base.indexOf('?') === -1 ? '?' : '&') + 'limit=8&q=' + encodeURIComponent(q);
	}
	// 候補のリンク（別タブで開かれたとき）の飛び先。サーバーが付けてきた url を使い、無ければ自分で組む
	function originPageUrl(o) {
		if (o.url && /^https?:\/\//i.test(o.url)) { return o.url; }
		return BASE + (o.kind === 'station' ? '?station=' : '?hotel=') + encodeURIComponent(o.id);
	}

	function closeSuggest() {
		suggest.hidden = true;
		suggest.innerHTML = '';
		hotelQ.setAttribute('aria-expanded', 'false');
		hotelQ.removeAttribute('aria-activedescendant');
		selIdx = -1;
		found = [];
	}
	function markSel() {
		var items = suggest.querySelectorAll('li[role="option"]');
		Array.prototype.forEach.call(items, function (li, i) {
			var on = (i === selIdx);
			li.classList.toggle('sel', on);
			li.setAttribute('aria-selected', on ? 'true' : 'false');
		});
		if (selIdx >= 0 && items[selIdx]) { hotelQ.setAttribute('aria-activedescendant', items[selIdx].id); }
		else { hotelQ.removeAttribute('aria-activedescendant'); }
	}
	/**
	 * 候補を出す。caption を渡すと、候補の頭に1行の案内（「8件の候補から選んでください。」）を置く。
	 * 案内は入力欄の下の文（#nearbyHotelMsg）に出していたが、開いた候補の一覧の下に隠れて見えなかった（2026-10-03 テスト）。
	 */
	function renderSuggest(list, caption) {
		closeSuggest();
		if (!list.length) { return; }
		found = list;
		if (caption) {
			var head = document.createElement('li');
			head.setAttribute('role', 'presentation');
			head.className = 's-caption';
			head.textContent = caption;
			suggest.appendChild(head);
		}
		list.forEach(function (o, i) {
			var li = document.createElement('li');
			li.id = 'nearbyHotelOpt' + i;
			li.setAttribute('role', 'option');
			li.setAttribute('aria-selected', 'false');
			if (o.kind === 'station') { li.className = 's-station'; }
			var a = document.createElement('a');
			a.href = originPageUrl(o);
			a.tabIndex = -1; // 候補へは矢印キーで移る。タブキーの順番に候補を挟まない
			var main = document.createElement('span');
			main.className = 's-main';
			// 駅には小さな電車の印（inc/icons.php の形。意味は駅名の「駅」が持つので読み上げない）
			if (o.kind === 'station' && ICONS.train) {
				var ic = document.createElement('span');
				ic.className = 's-icon';
				ic.setAttribute('aria-hidden', 'true');
				ic.innerHTML = ICONS.train; // サーバーの固定の SVG（inc/icons.php）
				main.appendChild(ic);
			}
			var name = jaEl('span', o.title);
			name.className = 's-name';
			main.appendChild(name);
			// 外国語のページでは、日本語のままの宿の名前に読み（ローマ字・確かめたものだけ）を添える
			if (o.reading) {
				var rd = document.createElement('span');
				rd.className = 's-reading';
				rd.textContent = o.reading;
				main.appendChild(rd);
			}
			a.appendChild(main);
			if (o.meta) {
				var meta = jaEl('span', o.meta);
				meta.className = 's-area';
				a.appendChild(meta);
			}
			a.addEventListener('click', function (e) {
				// Ctrl/⌘+クリック・中クリックは「別タブで開く」の意図なので邪魔しない
				if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) { return; }
				e.preventDefault();
				pick(o);
			});
			li.appendChild(a);
			suggest.appendChild(li);
		});
		suggest.hidden = false;
		hotelQ.setAttribute('aria-expanded', 'true');
		// 候補が画面の下にはみ出すなら、はみ出した分だけページを上げる（/hotel/ の app.js と同じ。2026-10-03 テスト）。
		// スマホでは入力欄が画面の下のほうにあり、8件のうち1件しか見えずページも動かなかった。
		// キーボードが出ているときはその上までしか見えないので、visualViewport（キーボードを除いた範囲）で測る。
		// 入力欄の上端が固定ヘッダーの下に隠れるところまでは上げない
		var vv = window.visualViewport;
		var seen = vv ? vv.offsetTop + vv.height : window.innerHeight;
		var over = suggest.getBoundingClientRect().bottom + 12 - seen;
		var head2 = document.querySelector('.site-header');
		var room = hotelQ.getBoundingClientRect().top - (head2 ? head2.getBoundingClientRect().bottom : 0) - 12;
		if (over > 0 && room > 0) { window.scrollBy(0, Math.min(over, room)); }
	}
	function fetchOrigins(q) {
		return fetch(originsUrl(q))
			.then(function (r) {
				if (!r.ok) { throw new Error('origins ' + r.status); }
				return r.json();
			})
			.then(function (d) { return (d && d.items) || []; });
	}

	hotelQ.addEventListener('input', function () {
		sayHotel(''); // 打ち直したら、前の空振り・失敗の文は消す
		clearTimeout(sugTimer);
		sugTimer = setTimeout(function () {
			var q = hotelQ.value.trim();
			if (q === lastQ) { return; }
			lastQ = q;
			if (!q) { closeSuggest(); return; }
			fetchOrigins(q)
				.then(function (list) {
					// 通信中に入力が進んでいたら、古い結果は捨てる
					if (hotelQ.value.trim() !== q) { return; }
					renderSuggest(list);
				})
				.catch(closeSuggest);
		}, 250); // 1文字ごとに叩かない（サーバー側も1分あたりの回数で止めている）
	});
	hotelQ.addEventListener('keydown', function (e) {
		var n = suggest.hidden ? 0 : found.length;
		if (e.key === 'Escape') {
			// 候補が開いていれば、まず候補だけ閉じる（2回目の Esc で、開き直したタブを閉じる）
			if (n) { e.preventDefault(); closeSuggest(); }
			return;
		}
		if (!n) { return; }
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			if (e.key === 'ArrowDown') { selIdx = (selIdx + 1) % n; }
			else { selIdx = selIdx <= 0 ? n - 1 : selIdx - 1; }
			markSel();
		} else if (e.key === 'Enter' && selIdx >= 0) {
			e.preventDefault();
			pick(found[selIdx]);
		}
	});
	document.addEventListener('click', function (e) {
		if (!hotelForm.contains(e.target)) { closeSuggest(); }
	});

	hotelForm.addEventListener('submit', function (e) {
		// JSが動いているときはページを離れない（JSが無ければ /hotel/?hotel_q= の検索結果へ送られる）
		e.preventDefault();
		var q = hotelQ.value.trim();
		if (!q) { hotelQ.focus(); return; }
		if (selIdx >= 0 && found[selIdx]) { pick(found[selIdx]); return; }
		clearTimeout(sugTimer);
		sayHotel(t('searching', '検索中…'));
		fetchOrigins(q)
			.then(function (list) {
				if (hotelQ.value.trim() !== q) { return; }
				lastQ = q;
				// 1つに決まるなら、候補を選ばせる手間をかけずにそのまま進む。
				// 先頭が入力とぴったり同じ駅（「Kyoto」「京都駅」）なら、宿の候補が続いていてもその駅で進む（2026-10-03 手直し。
				// 以前は「8件の候補から選んでください」で止まった）。同じ名前の駅が2つ（嵐山＝阪急・嵐電）なら選んでもらう
				var exact = list.filter(function (o) { return o.kind === 'station' && o.exact; });
				if (list.length === 1 || exact.length === 1) { pick(exact.length === 1 ? exact[0] : list[0]); return; }
				if (!list.length) {
					closeSuggest();
					// 原因と次の一手の2文
					var miss = t('originMiss', '「%s」に一致するホテル・駅はありませんでした。').replace('%s', q);
					sayHotel(miss + (/[。．！？]$/.test(miss) ? '' : ' ') + t('hotelMissHint', '名前の一部や、最寄り駅でもお試しください。'));
					return;
				}
				// 案内は候補の頭に置く（入力欄の下の文は、開いた一覧に隠れる）。読み上げの枠の文は消しておく
				sayHotel('');
				renderSuggest(list, t('hotelPick', '%d件の候補から選んでください。').replace('%d', list.length));
				hotelQ.focus();
			})
			.catch(function () {
				sayHotel(t('netFailed', '通信に失敗しました。時間をおいてお試しください。'));
			});
	});

	function pick(o) {
		closeSuggest();
		hotelQ.value = o.title;
		lastQ = o.title;
		show({ kind: o.kind, id: o.id, name: o.title, title: o.title, reading: o.reading || '' }, { scroll: true });
	}

	// 「駅から：」のリンクと、例の下の「京都駅から探す」（2026-10-07）。JSが効いていればページを離れずにその駅で始める。
	// 名前はリンクに持たせた見出しの形（入力欄に戻す名前）。文の中の形（スペイン語の冠詞つき）はサーバーの応答で揃う
	document.querySelectorAll('a[data-station]').forEach(function (a) {
		a.addEventListener('click', function (e) {
			if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) { return; }
			e.preventDefault();
			selectTab(tabHotel, false);
			pick({ kind: 'station', id: a.getAttribute('data-station'), title: a.getAttribute('data-title') || a.textContent });
		});
	});

	/* ---------- 3. 結果（どの出発点も同じ） ---------- */

	/**
	 * ジャンルの絞り込み（文字と件数＋下線のタブ。2026-10-07 に丸い札から変えた）。結果に実際にあった親ジャンルだけを出す
	 * （空のタブを押させない）。絞り込みは読み込み済みの行に対して行うので通信しない。地図の点も同じジャンルだけにする
	 */
	function buildGenres(list) {
		if (!genres) return;
		genres.innerHTML = '';
		// 1種類しか無いなら絞る意味が無い
		if (!list || list.length < 2) { genres.hidden = true; return; }

		var rows = grid.querySelectorAll('.nb-row');
		var all = [{ slug: '', name: t('genreAll', 'すべて'), count: rows.length }].concat(list);

		all.forEach(function (g, i) {
			var b = document.createElement('button');
			b.type = 'button';
			b.className = 'nb-genre' + (i === 0 ? ' on' : '');
			b.setAttribute('aria-pressed', i === 0 ? 'true' : 'false');
			b.dataset.genre = g.slug;
			b.appendChild(document.createTextNode(g.name));
			var c = document.createElement('span');
			c.className = 'nb-genre-c';
			c.textContent = String(g.count);
			b.appendChild(c);
			// 読み上げは「飲食（5）」の形で（数字だけが離れて読まれないように）
			b.setAttribute('aria-label', String(t('genreCount', '%1$s（%2$d）')).replace('%1$s', g.name).replace('%2$d', g.count));
			b.addEventListener('click', function () {
				genres.querySelectorAll('.nb-genre').forEach(function (o) {
					var on = (o === b);
					o.classList.toggle('on', on);
					o.setAttribute('aria-pressed', on ? 'true' : 'false');
				});
				genreSel = g.slug;
				var n = applyRows();
				pinsByGenre();
				// 要約（どこから・何件・徒歩何分・範囲を広げたか）は消さない。別の枠で件数だけ伝える
				sayFilter(t('genreFiltered', '%d件を表示しています').replace('%d', n));
			});
			genres.appendChild(b);
		});
		genres.hidden = false;
	}

	/* ---------- 3a. 一覧の件数（最初は PC 8件・スマホ 6件） ---------- */

	var genreSel = '';
	var expanded = false;
	var NARROW = window.matchMedia ? window.matchMedia('(max-width: 840px)') : null;
	var firstRows = function () { return (NARROW && NARROW.matches) ? 6 : 8; };

	/**
	 * ジャンルと「残り◯件」に合わせて行を出し隠しする。
	 * @return {number} ジャンルに当たった件数（隠した残りも含む）
	 */
	function applyRows() {
		var n = 0;
		var rest = 0;
		var cap = firstRows();
		grid.querySelectorAll('.nb-row').forEach(function (row) {
			if (genreSel && row.dataset.genre !== genreSel) { row.hidden = true; return; }
			n++;
			var over = !expanded && n > cap;
			row.hidden = over;
			if (over) { rest++; }
		});
		if (moreBtn) {
			moreBtn.hidden = !rest;
			if (rest) { moreBtn.textContent = String(moreBtn.getAttribute('data-label') || '%d').replace('%d', rest); }
		}
		// 地図の縮尺は出ている行に合わせるので、出し隠しが変わったら描き直す
		drawMap();
		return n;
	}
	if (moreBtn) {
		moreBtn.addEventListener('click', function () {
			var before = grid.querySelectorAll('.nb-row:not([hidden])').length;
			expanded = true;
			applyRows();
			// 開いた最初の行の名前へフォーカスを移す（ボタンが消えるので、フォーカスを body に落とさない）
			var next = grid.querySelectorAll('.nb-row:not([hidden])')[before];
			var a = next && next.querySelector('.nb-name a');
			if (a) { a.focus(); }
		});
	}
	if (NARROW && NARROW.addEventListener) { NARROW.addEventListener('change', function () { if (shown) { applyRows(); } }); }

	/* ---------- 3b. 地図（国土地理院の淡色地図。2026-10-07 結果の画面 案A） ---------- */

	var TILE = 'https://cyberjapandata.gsi.go.jp/xyz/pale/';
	// 徒歩分数の逆（plugins/editplus-spot/geo.php の editplus_walk_minutes: 分 = 距離 × 1.3 ÷ 80）
	var M_PER_MIN = 80 / 1.3;
	var RINGS = [5, 10, 15];
	var mapData = null; // { center: {lat,lng}, name: 出発点の名前, points: [{id,lat,lng,walk,genre,name}] }
	var activeId = '';

	// ウェブメルカトルの画素座標（ズーム z のとき、世界全体が 256×2^z の正方形）
	function project(lat, lng, z) {
		var size = 256 * Math.pow(2, z);
		var r = lat * Math.PI / 180;
		return { x: (lng + 180) / 360 * size, y: (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * size };
	}

	function setMap(map, origin) {
		var pts = (map && map.points) || [];
		var c = (map && map.origin) || (origin && typeof origin.lat === 'number' ? { lat: origin.lat, lng: origin.lng } : null);
		if (!mapCol || !mapEl || !c || !pts.length) { mapData = null; if (mapCol) { mapCol.hidden = true; } return; }
		mapData = { center: c, name: isPlace(origin) ? (origin.name || '') : t('hereLabel', '現在地'), points: pts };
		activeId = '';
		mapCol.hidden = false;
		drawMap();
	}

	/** 地図を描き直す（結果が変わった・幅が変わった・スマホで広げた）。 */
	function drawMap() {
		if (!mapData || !mapCol || mapCol.hidden) { return; }
		var W = mapEl.clientWidth;
		var H = mapEl.clientHeight;
		if (!W || !H) { return; }
		var c = mapData.center;
		var pad = 22;
		// 出発点を真ん中に置いたまま、**一覧に出ている行の点**がぜんぶ入るいちばん大きいズーム（16〜12）。
		// 17まで寄せると駅舎と通りの名前が画面を埋め、徒歩10分の輪も外に出た
		// 20件すべてに合わせると、遠い数件のために縮尺が下がって近い点が団子になった（2026-10-07 京都駅で確認）。
		// 隠れている行の点も地図には置く（端に出るか、外に切れる）
		var seen = {};
		grid.querySelectorAll('.nb-row:not([hidden])').forEach(function (row) { seen[row.dataset.id] = true; });
		var fitPts = mapData.points.filter(function (p) { return seen[String(p.id)]; });
		if (!fitPts.length) { fitPts = mapData.points; }
		var z = 16;
		for (; z > 12; z--) {
			var o0 = project(c.lat, c.lng, z);
			var fits = fitPts.every(function (p) {
				var q = project(p.lat, p.lng, z);
				return Math.abs(q.x - o0.x) <= W / 2 - pad && Math.abs(q.y - o0.y) <= H / 2 - pad;
			});
			if (fits) { break; }
		}
		var o = project(c.lat, c.lng, z);
		var left = o.x - W / 2;
		var top = o.y - H / 2;
		var frag = document.createDocumentFragment();
		var n = Math.pow(2, z);
		// タイルは2段細かいズームのものを4分の1の大きさ（64px）で並べる。地理院の淡色地図は細かいズームほど
		// 文字を大きく描くので、そのままの大きさ・1段細かい半分の大きさでは通りや駅の名前が点より大きく出て、
		// 点と輪が読めなかった（2026-10-07 京都駅で比べた）。高解像度の画面でも粗くならない。
		// 枚数はPCの地図で約100枚（1枚数KB）。地図の最大ズームを16にしているので、タイルは地理院の上限18に収まる
		var tz = z + 2;
		var tn = Math.pow(2, tz);
		var TS = 64;
		for (var tx = Math.floor(left / TS); tx <= Math.floor((left + W) / TS); tx++) {
			for (var ty = Math.floor(top / TS); ty <= Math.floor((top + H) / TS); ty++) {
				if (ty < 0 || ty >= tn) { continue; }
				var img = document.createElement('img');
				img.className = 'nb-tile';
				img.alt = '';
				img.decoding = 'async';
				img.src = TILE + tz + '/' + (((tx % tn) + tn) % tn) + '/' + ty + '.png';
				img.style.left = Math.round(tx * TS - left) + 'px';
				img.style.top = Math.round(ty * TS - top) + 'px';
				img.onerror = function () { this.remove(); };
				frag.appendChild(img);
			}
		}
		// 徒歩の輪。地図より大きい輪は出さない（端が切れた弧だけが残ると読めない）
		var mpp = 156543.03392 * Math.cos(c.lat * Math.PI / 180) / n;
		RINGS.forEach(function (min) {
			var r = min * M_PER_MIN / mpp;
			if (r > Math.max(W, H) * 0.75 || r < 18) { return; }
			var ring = document.createElement('span');
			ring.className = 'nb-ring';
			ring.style.width = ring.style.height = Math.round(r * 2) + 'px';
			ring.style.left = Math.round(W / 2 - r) + 'px';
			ring.style.top = Math.round(H / 2 - r) + 'px';
			var lb = document.createElement('span');
			lb.className = 'nb-ring-l';
			lb.textContent = t('walkOne', '徒歩約%d分').replace('約', '').replace('%d', min);
			ring.appendChild(lb);
			frag.appendChild(ring);
		});
		mapData.points.forEach(function (p) {
			var q = project(p.lat, p.lng, z);
			var pin = document.createElement('span');
			pin.className = 'nb-pin';
			pin.dataset.id = String(p.id);
			pin.dataset.genre = p.genre || '';
			pin.style.left = Math.round(q.x - left) + 'px';
			pin.style.top = Math.round(q.y - top) + 'px';
			pin.addEventListener('click', function () { setActive(p.id, true); });
			frag.appendChild(pin);
		});
		var me = document.createElement('span');
		me.className = 'nb-origin';
		me.style.left = Math.round(W / 2) + 'px';
		me.style.top = Math.round(H / 2) + 'px';
		var meL = jaEl('span', mapData.name);
		meL.className = 'nb-origin-l';
		me.appendChild(meL);
		frag.appendChild(me);
		var tip = document.createElement('span');
		tip.className = 'nb-tip';
		tip.hidden = true;
		frag.appendChild(tip);

		mapEl.innerHTML = '';
		mapEl.appendChild(frag);
		pinsByGenre();
		if (activeId) { setActive(activeId, false); }
	}

	function pinsByGenre() {
		if (!mapEl) { return; }
		mapEl.querySelectorAll('.nb-pin').forEach(function (pin) { pin.hidden = !!genreSel && pin.dataset.genre !== genreSel; });
	}

	/**
	 * 行と点を結ぶ。行に触れたとき（toRow=false）は点を濃くして名前を添えるだけ、
	 * 点を押したとき（toRow=true）は、その行を出して（「残り」に隠れていれば開いて）そこまで動かす
	 */
	function setActive(id, toRow) {
		if (!mapData || !mapEl) { return; }
		activeId = String(id);
		var p = null;
		mapData.points.forEach(function (x) { if (String(x.id) === activeId) { p = x; } });
		var pin = null;
		mapEl.querySelectorAll('.nb-pin').forEach(function (el) {
			var on = el.dataset.id === activeId;
			el.classList.toggle('is-on', on);
			if (on) { pin = el; }
		});
		var tip = mapEl.querySelector('.nb-tip');
		if (tip) {
			tip.hidden = !(p && pin && !pin.hidden);
			if (!tip.hidden) {
				tip.textContent = '';
				tip.appendChild(jaEl('span', p.name));
				var w = document.createElement('small');
				w.textContent = t('walkOne', '徒歩約%d分').replace('%d', p.walk);
				tip.appendChild(w);
				tip.style.left = pin.style.left;
				tip.style.top = pin.style.top;
				// 右端の点では吹き出しを左へ出す（地図の外にはみ出さない）
				tip.classList.toggle('nb-tip--left', parseInt(pin.style.left, 10) > mapEl.clientWidth * 0.6);
			}
		}
		grid.querySelectorAll('.nb-row').forEach(function (row) { row.classList.toggle('is-on', row.dataset.id === activeId); });
		if (toRow) {
			var row = grid.querySelector('.nb-row[data-id="' + activeId + '"]');
			if (row && row.hidden) { expanded = true; applyRows(); }
			if (row) { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
		}
	}
	// 行に触れた・タブキーで行に来たら、地図の点を濃くする
	['mouseover', 'focusin'].forEach(function (type) {
		grid.addEventListener(type, function (e) {
			var row = e.target.closest ? e.target.closest('.nb-row') : null;
			if (row && row.dataset.id && row.dataset.id !== activeId) { setActive(row.dataset.id, false); }
		});
	});
	if (mapToggle && mapCol) {
		mapToggle.addEventListener('click', function () {
			var big = !mapCol.classList.contains('nb-mapcol--big');
			mapCol.classList.toggle('nb-mapcol--big', big);
			mapToggle.setAttribute('aria-expanded', big ? 'true' : 'false');
			mapToggle.textContent = mapToggle.getAttribute(big ? 'data-close' : 'data-open') || '';
			drawMap();
		});
	}
	var mapTimer = null;
	window.addEventListener('resize', function () {
		clearTimeout(mapTimer);
		mapTimer = setTimeout(drawMap, 150);
	});

	// 「◯◯から」の名前の部分（外国語のページでは日本語の名前に lang="ja"、読みがあれば小さく添える）
	function nameFrag(o, tag) {
		var frag = document.createDocumentFragment();
		frag.appendChild(jaEl(tag, o.name || ''));
		if (o.reading) {
			frag.appendChild(document.createTextNode(' '));
			var rd = document.createElement('span');
			rd.className = 'nb-reading';
			rd.textContent = o.reading;
			frag.appendChild(rd);
		}
		return frag;
	}

	/**
	 * 要約を出す。「河原町・烏丸のあたり ・ 8件 ・ 徒歩2〜6分」、ホテル・宿・駅なら「◯◯から ・ 20件 ・ 徒歩2〜6分」。
	 * 範囲を広げたときは、広げたことも書く。出発点の名前があるときはエリア名を出さない（二度言うことになる）。
	 * 件数と徒歩分数は、それぞれ途中で折らない（.nearby-where .nw）。折ってよいのは「・」の所だけ
	 */
	function summarize(r, origin) {
		if (!msg) return;
		// 2段で組む（2026-10-07 結果の画面 案A）。大きな名乗り（.nw-head）と、路線・件数・徒歩の範囲の小さな1行（.nw-sub）
		var frag = document.createDocumentFragment();
		var head = document.createElement('span');
		head.className = 'nw-head';
		var sub = document.createElement('span');
		sub.className = 'nw-sub';
		var text = function (el, s) { el.appendChild(document.createTextNode(s)); };
		var keep = function (s) {
			var el = document.createElement('span');
			el.className = 'nw';
			el.textContent = s;
			sub.appendChild(el);
		};
		var place = isPlace(origin);
		if (place) {
			var fmt = String(t('legFrom', '%sから')).split('%s');
			text(head, fmt[0] || '');
			head.appendChild(nameFrag(origin, 'span'));
			text(head, fmt[1] || '');
		} else if (r.area && r.count) {
			// エリア名がもともと「周辺」「Area」で終わるなら「のあたり」を重ねない（「京都駅周辺 のあたり」「Around Kyoto Station Area」）
			text(head, /(周辺|周边|周邊|주변|\bArea)$|^Alrededores/i.test(r.area) ? r.area : t('nearArea', '%sのあたり').replace('%s', r.area));
		} else {
			text(head, t('hereLabel', '現在地'));
		}
		// 駅なら乗り入れている会社（「JR・近鉄・地下鉄」）を先に
		var lines = (r.origin && r.origin.lines) || '';
		if (lines) {
			text(sub, lines);
			var bar = document.createElement('span');
			bar.className = 'nw-bar';
			bar.setAttribute('aria-hidden', 'true');
			sub.appendChild(bar);
		}
		keep(t('nearPlaces', '近くの行き先') + ' ' + t('nearCount', '%d件').replace('%d', r.count));
		if (r.walk_min != null && r.walk_max != null) {
			text(sub, t('sep', ' ・ '));
			keep(r.walk_min === r.walk_max
				? t('walkOne', '徒歩約%d分').replace('%d', r.walk_min)
				: t('walkRange', '徒歩%1$d〜%2$d分').replace('%1$d', r.walk_min).replace('%2$d', r.walk_max));
		}
		if (r.widened) { text(sub, '　' + t('nearWidened', '近くに少なかったため、範囲を広げています。')); }
		frag.appendChild(head);
		frag.appendChild(sub);
		// 読み上げの枠なので、組み立ててから1回で差し替える（途中の断片を読ませない）
		msg.textContent = '';
		msg.appendChild(frag);
	}

	/** コース作成の欄の1行目。ホテル・宿・駅のときは名前を太字で（single-hotel.php と同じ文）。 */
	function setCourseLead(origin) {
		if (!courseLead) return;
		if (!isPlace(origin)) { courseLead.textContent = courseLead.getAttribute('data-here') || ''; return; }
		var fmt = String(courseLead.getAttribute('data-hotel') || '%s').split('%s');
		var frag = document.createDocumentFragment();
		frag.appendChild(document.createTextNode(fmt[0] || ''));
		frag.appendChild(nameFrag(origin, 'b'));
		frag.appendChild(document.createTextNode(fmt[1] || ''));
		courseLead.textContent = '';
		courseLead.appendChild(frag);
	}

	/**
	 * 結果を出したあとの「出発点を変える」ボタン。出発点の種類で出し分ける。
	 *   現在地         … 現在地を取り直す ／ ホテルや駅から探す
	 *   ホテル・宿・駅 … ほかのホテル・駅にする ／ 現在地から探す（位置情報が使える端末だけ）
	 * 提携ホテルのときだけ「このホテルの専用ページ」を添える
	 */
	function setActs(o) {
		var kind = o ? o.kind : null;
		var place = isPlace(o);
		if (again) again.hidden = (kind !== 'geo');
		if (toHotel) toHotel.hidden = (kind !== 'geo');
		if (otherHotel) otherHotel.hidden = !place;
		if (toHere) toHere.hidden = (!place || !GEO_OK);
		if (partner) {
			var url = (o && o.kind === 'hotel' && /^https?:\/\//i.test(o.partner || '')) ? o.partner : '';
			partner.hidden = !url;
			if (url) { partner.href = url; }
		}
	}

	/* ---------- 4. URL と履歴 ---------- */

	// URLが指している出発点（?hotel=<ID> か ?station=<キー>）。名前はサーバーが返す
	function originFromUrl() {
		var u;
		try { u = new URL(location.href); } catch (e) { return null; }
		var h = parseInt(u.searchParams.get('hotel') || '', 10);
		if (h > 0) { return { kind: 'hotel', id: h }; }
		var s = String(u.searchParams.get('station') || '');
		if (/^[a-z0-9-]{1,64}$/.test(s)) { return { kind: 'station', id: s }; }
		return null;
	}
	// 2つの出発点が同じ場所を指しているか（ホテルと宿はどちらも ?hotel=<ID>）
	function sameOrigin(a, b) {
		if (!a || !b) { return false; }
		var ka = a.kind === 'station' ? 'station' : 'hotel';
		var kb = b.kind === 'station' ? 'station' : 'hotel';
		return ka === kb && String(a.id) === String(b.id);
	}

	/**
	 * 履歴に書くURL。今のURLの ?hotel= / ?station= だけを差し替え（現在地なら外し）、ほかのクエリは残す。
	 * 広告の自動タグ（gclid）・SNS（fbclid）・QRの utm_source は、付いたまま来るのが普通。
	 * 素のURLに決め打ちで足すと、それらが消えて「今のURLと違う」ことになり、開いただけで履歴が1つ増えていた
	 */
	function pageUrl(o) {
		var u;
		try { u = new URL(location.href); } catch (e) { return o ? originPageUrl(o) : BASE; }
		u.hash = '';
		u.searchParams.delete('hotel');
		u.searchParams.delete('station');
		if (isPlace(o)) { u.searchParams.set(o.kind === 'station' ? 'station' : 'hotel', String(o.id)); }
		return u.toString();
	}

	// 言語の切り替えリンクにも出発点を引き継ぐ。サーバーは開いた時点の出発点しか知らないので、
	// 画面で選び直したらここで書き換える（言語を変えたら選び直し、にしない）
	function syncLangLinks(o) {
		document.querySelectorAll('#langMenu a[href], #langSheet a[href]').forEach(function (a) {
			var u;
			try { u = new URL(a.href); } catch (e) { return; }
			if (!/\/nearby\/?$/.test(u.pathname)) { return; }
			u.searchParams.delete('hotel');
			u.searchParams.delete('station');
			if (isPlace(o)) { u.searchParams.set(o.kind === 'station' ? 'station' : 'hotel', String(o.id)); }
			a.href = u.toString();
		});
	}

	/**
	 * URLと履歴を出発点に合わせる。URLが変わるときは履歴を積み（「戻る」で前の出発点に帰れる）、
	 * 変わらないとき（現在地の取り直し）・直接開いたURLで最初に始めるとき・「戻る/進む」で来たときは
	 * 今の履歴を書き換える。
	 */
	function setUrl(state, url, replace, o) {
		var here = location.href.split('#')[0];
		try {
			if (replace || here === url) {
				// 同じURLのまま書き換えるときは、ページ内の位置（#course など）を落とさない
				history.replaceState(state, '', url + (here === url ? location.hash : ''));
			} else {
				history.pushState(state, '', url);
			}
		} catch (e) { /* 履歴を触れなくても画面は描ける */ }
		syncLangLinks(o || null);
	}

	/* ---------- 5. 出発点が決まったあとの流れ ---------- */

	function restParams(o) {
		if (o.kind === 'station') { return 'station=' + encodeURIComponent(o.id); }
		if (isPlace(o)) { return 'hotel=' + encodeURIComponent(o.id); }
		return 'lat=' + encodeURIComponent(o.lat) + '&lng=' + encodeURIComponent(o.lng);
	}

	/**
	 * 出発点が決まったあとの表示。コース作成と近くの行き先を出す。
	 *
	 * @param {Object} origin { lat, lng }（現在地）か { kind: 'hotel'|'lodging'|'station', id, name, reading }
	 * @param {Object} how    history: 「戻る/進む」で来た（履歴を積まず、作ったコースも復元する）
	 *                        initial: サーバーが描いた出発点で最初に始める（履歴は積まず書き換えるだけ）
	 *                        scroll:  コースの欄までスクロールする（押して選んだときだけ。開いただけで画面を動かさない）
	 */
	function show(origin, how) {
		how = how || {};
		var mine = ++seq;
		var place = isPlace(origin);
		busy(true);
		if (place) {
			sayHotel(t('searching', '検索中…'));
			// 見開きを畳んだまま読み込む（直接開いた・戻ってきた）ときは、タブの中の文が見えない。要約の名前の後ろに出す
			if (fv.classList.contains('nearby-fv--done') && !choosing() && msg && !msg.querySelector('.nearby-loading')) {
				var ld = document.createElement('span');
				ld.className = 'nearby-loading';
				ld.textContent = t('sep', ' ・ ') + t('searching', '検索中…');
				(msg.querySelector('.nw-head') || msg).appendChild(ld);
			}
		}
		var url = grid.getAttribute('data-endpoint');
		url += (url.indexOf('?') === -1 ? '?' : '&') + restParams(origin);

		fetch(url)
			.then(function (res) { return res.json().then(function (json) { return { ok: res.ok, json: json }; }); })
			.then(function (r) {
				// もっと新しい取得が走っている。この応答は捨てる（座標も上書きしない）
				if (mine !== seq) { return; }
				if (!r.ok) {
					// WordPress 自身のエラー（致命的エラーの internal_server_error・rest_…）の文は、日本語でHTMLタグ付き。
					// 画面に出さず、その言語の「読み込みに失敗しました」にする（2026-10-04。/en/nearby/ に
					// 「<p>サイトに重大なエラーが発生しました。</p>」とタグごと出た。診断の側は quiz.js の errorText で同じ扱い）。
					// こちらのRESTが返す合図（hotel_not_found など）の文は、サーバーがページの言語で書いているのでそのまま出す
					var raw = String((r.json && r.json.message) || '');
					var wpError = !raw || raw.indexOf('<') !== -1 || /^(internal_server_error|rest_)/.test(String((r.json && r.json.code) || ''));
					var text = wpError ? t('loadFailed', '読み込みに失敗しました。') : raw;
					if (place) { failPlace(text, r.json && r.json.code); return; }
					// 京都の外は、近くの行き先もコースも出せない（サーバが同じ範囲で弾く）。ここで止めて次の一手を出す
					forgetGeo();
					fail(r.json && r.json.code === 'geo_out_of_region' ? t('geoOutside', '現在地が京都から離れているようです。京都に着いてから使えます。いまはホテルや駅を選んで試せます。') : text, true);
					return;
				}
				// 近くに1件も無い。現在地なら京都の外と同じ（範囲の箱の中でも、大阪駅などは近くが0件）。
				// ホテル・宿・駅なら選び直してもらう。どちらもコースの欄は出さない
				// （0件なのにコース作成だけ出ると、何が起きたのか分からない。2026-10-03 野口）
				if (!r.json.count) {
					if (place) { failPlace(t('originNone', 'この出発点の近くには、ご案内できる場所が見つかりませんでした。ほかのホテルや駅をお試しください。'), 'origin_none'); return; }
					forgetGeo();
					fail(t('geoOutside', '現在地が京都から離れているようです。京都に着いてから使えます。いまはホテルや駅を選んで試せます。'), true);
					return;
				}
				busy(false);
				settle();
				sayFilter('');
				sayHotel('');
				sayHere('');

				// 直接開いたURLの ?hotel= が正規形でない（訳の投稿のID・提携ホテルと同じ館の宿・utm つき）ときも、
				// 書き換えるだけにする。積むと、開いただけで履歴が1つ増えて「戻る」の1回目が空振りする
				var replace = !!(how.history || how.initial);
				if (place) {
					// サーバーは正規の出発点に揃えて返す（訳の投稿のID → 原文、提携ホテルと同じ館の宿 → 提携ホテル）
					var o = r.json.origin || {};
					origin = {
						kind: o.kind || origin.kind,
						id: (o.kind === 'station') ? String(o.id) : (parseInt(o.id, 10) || origin.id),
						name: o.name || origin.name || '',
						title: o.title || o.name || origin.title || origin.name || '',
						// 名乗りの読みは、サーバーが返す確かめた読みだけにする（2026-10-03 テストで手直し）。
						// 以前は候補で打った語が覆っていた読み（「hiiragiya」と打って選んだ「柊家旅館 hiiragiya ryokan」）を画面が持ち続けたので、
						// 同じ宿でも、選んだときは読みが出て、URLを開き直す・戻る・言語を変えると消えた。候補の一覧では打った語の読みを見せてよい
						// （自分の打った語で当たったことが分かる）が、選んだあとの名乗りはどの開き方でも同じにする
						reading: o.reading || '',
						partner: o.partner_url || ''
					};
					current = origin;
					hotelQ.value = origin.title;
					lastQ = origin.title;
					setUrl({ o: { kind: origin.kind, id: origin.id, name: origin.name, reading: origin.reading } }, pageUrl(origin), replace, origin);
				} else {
					current = { kind: 'geo', origin: origin };
					try { sessionStorage.setItem(ORIGIN_KEY, JSON.stringify(origin)); } catch (e) { /* 無視 */ }
					setUrl({ geo: origin }, pageUrl(null), replace, null);
				}
				shown = { r: r.json, origin: origin };

				// HTMLはサーバが templates/row-spot.php で描いてエスケープ済み
				grid.innerHTML = r.json.html;
				genreSel = '';
				expanded = false;
				buildGenres(r.json.genres);
				applyRows();

				// 見開きを畳み、空いた場所に「どこを出発点と受け取ったか」を出す。
				// 見出し（h1）は残す ―― 畳むのは写真・説明文・タブ・手順だけ（CSS の .nearby-fv--done）
				fv.classList.add('nearby-fv--done');
				fv.classList.remove('nearby-fv--choosing');
				// 取得前の main は「位置情報を使わないときは」1枚だけで、その上余白は「上に欄がある」前提の値。欄が出てから戻す
				document.body.classList.add('nearby-located');
				setActs(current);

				// ① コース作成（すぐ下）→ ② 近くの行き先
				courseSec.hidden = false;
				nearSec.hidden = false;

				// 地図は欄を出してから描く（hidden のあいだは幅が0で、タイルの枚数を決められない）
				setMap(r.json.map, origin);

				// 結果が出たことを読み上げ、同じ文を画面にも残す
				summarize(r.json, origin);
				setCourseLead(origin);

				// 診断は出発点ごとに作り直す（取り直し・選び直しで前の出発点の設問・結果を残さない）。
				// 「戻る/進む」で来たときだけ、その出発点で作ったコースを復元する
				quizEl.innerHTML = '';
				var opts = origin.kind === 'station' ? { station: origin.id }
					: (place ? { hotel: origin.id } : { origin: origin });
				opts.restore = !!how.history;
				window.epQuizMount(quizEl, opts);

				if (how.scroll) { courseSec.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
			})
			.catch(function () {
				if (mine !== seq) { return; }
				var text = t('netFailed', '通信に失敗しました。時間をおいてお試しください。');
				if (place) { failPlace(text, ''); } else { fail(text, false); }
			});
	}

	// 現在地の座標を捨てる（まだ何も出していないときだけ。前の結果を出し続けているなら、その座標は「戻る」で使い直す）
	function forgetGeo() {
		if (!current) {
			try { sessionStorage.removeItem(ORIGIN_KEY); } catch (e) { /* 無視 */ }
		}
	}

	// 要約を、いま出している結果（current）から描き直す
	function redrawSummary() {
		if (shown) { summarize(shown.r, shown.origin); }
	}

	/**
	 * 現在地が使えなかった（京都の外・拒否・時間切れ・通信の失敗）。
	 *
	 * 文は「現在地から」の面の、ボタンのすぐ下に出す（次に手を動かす場所の隣）。続けて「ホテルや駅から探す」を出し、
	 * 文が画面の外なら見えるところまで動かす。以前は最初の失敗を見開きの下の要約に出し、ページ最下部の
	 * 「位置情報を使わないときは」へ飛んでいたので、スマホでは文が画面の外（y=968）に出て、押しても何も起きないように見えた。
	 * 結果を出したあとの失敗でも、要約（いま出している結果の出発点の名乗り）は上書きしない。
	 *
	 * @param {string}  text 文。
	 * @param {boolean} alt  「ホテルや駅から探す」を出すか（時間をおけば直る通信の失敗では出さない）
	 */
	function fail(text, alt) {
		busy(false);
		settle();
		if (current) {
			redrawSummary();
			fv.classList.add('nearby-fv--choosing');
		} else {
			say('');
		}
		selectTab(tabHere, false);
		sayHere(text);
		if (hereAlt) { hereAlt.hidden = !(alt && tabHotel && !tabHotel.hidden); }
		// 取得中はボタンを押せなくしていたので、フォーカスが body に落ちている。ボタンへ戻す
		if (!document.activeElement || document.activeElement === document.body) { btn.focus({ preventScroll: true }); }
		bringIntoView(hereAlt && !hereAlt.hidden ? hereAlt : hereMsg);
	}

	// ホテル・宿・駅を出発点にできなかった（存在しない・座標が無い・範囲外・近くが0件・通信の失敗）。
	// 「ホテルから」タブに戻し、入力欄のすぐ下に原因と次の一手を出す
	function failPlace(text, code) {
		busy(false);
		settle();
		if (current) {
			// 前の出発点の結果は出したまま、畳んだ見開きの中でタブを開き直す
			fv.classList.add('nearby-fv--choosing');
		} else {
			// まだ何も出していない（直接開いたURLの宿が、開くまでのあいだに消えた等）。見開きを開いて選び直してもらう
			fv.classList.remove('nearby-fv--done');
			say('');
			// 直接開いたときに先に出しておいたコースの欄（読み込み中）を閉じる
			courseSec.hidden = true;
			quizEl.innerHTML = '';
		}
		selectTab(tabHotel, false);
		sayHotel(text);
		bringIntoView(hotelMsg);
		// 読めない出発点はURLに残さない（再読み込み・言語の切り替えで同じ失敗を繰り返さない）。
		// 通信の失敗のときは残す ―― 再読み込みで直るかもしれない
		if (code && !current && originFromUrl()) {
			setUrl({}, pageUrl(null), true, null);
		}
	}

	/* ---------- 6. 結果を出したあとに出発点を変える ---------- */

	// 畳んだ見開きの中でタブを開き直す（.nearby-fv--choosing）。写真の見開きまでは戻さない ――
	// 結果はすぐ下に出たままなので、選び直すのをやめてもそのまま読み続けられる
	function openChooser(tab) {
		fv.classList.add('nearby-fv--choosing');
		selectTab(tab, false);
		if (tab === tabHotel) {
			hotelQ.focus();
			hotelQ.select(); // いまの名前を選んでおき、打てばそのまま置き換わるようにする
		} else {
			btn.focus();
		}
	}
	function closeChooser() {
		if (!choosing()) { return; }
		// 取得の途中でやめたら、その取得は捨てる（やめたのに、少しあとで結果が別の出発点に入れ替わる、をしない）
		++locateSeq;
		++seq;
		busy(false);
		fv.classList.remove('nearby-fv--choosing');
		closeSuggest();
		sayHotel('');
		sayHere('');
		// 要約を、いま出している結果の出発点の名乗りに戻す
		redrawSummary();
		// フォーカスを、開くときに押したボタンの列へ返す
		var back = [again, toHotel, otherHotel, toHere].filter(function (b) { return b && !b.hidden; })[0];
		if (back) { back.focus(); }
	}
	if (otherHotel) { otherHotel.addEventListener('click', function () { openChooser(tabHotel); }); }
	if (toHotel) { toHotel.addEventListener('click', function () { openChooser(tabHotel); }); }
	if (toHere) { toHere.addEventListener('click', function () { openChooser(tabHere); }); }
	// 「やめる」。Esc はキーボードの人だけの手段で、スマホには閉じる手段が無かった
	if (cancel) { cancel.addEventListener('click', closeChooser); }
	fv.addEventListener('keydown', function (e) {
		if (e.key === 'Escape' && !e.defaultPrevented) { closeChooser(); }
	});

	/* ---------- 7. 現在地 ---------- */

	/**
	 * @param {boolean} fresh 測り直す（「現在地を取り直す」）。ブラウザが覚えている位置を使わない。
	 */
	function locate(fresh) {
		if (btn.disabled) { return; }
		busy(true);
		var ticket = ++locateSeq;
		var locating = t('geoLocating', '位置情報を取得しています…');
		// 「現在地を取り直す」（結果を出したまま、要約の隣のボタン）は要約の枠に、それ以外はボタンのすぐ下に出す
		if (current && !choosing()) { sayHere(''); say(locating); } else { sayHere(locating); }
		navigator.geolocation.getCurrentPosition(
			function (pos) {
				if (ticket !== locateSeq) { return; } // 待つあいだに「やめる」が押された
				show({ lat: pos.coords.latitude, lng: pos.coords.longitude }, { scroll: true });
			},
			function (err) {
				if (ticket !== locateSeq) { return; }
				++seq; // 走っている取得があれば、その応答も捨てる
				// 拒否・時間切れ・測位できない、で次の一手の言い方を変える（どれも「ホテルや駅を選んで試せます」で終わる）
				var code = err && err.code;
				var text = code === 1 ? t('geoDeniedHint', '位置情報の利用が許可されていません。ブラウザの設定で許可するか、ホテルや駅を選んで試せます。')
					: (code === 3 ? t('geoTimeout', '位置情報を取得できませんでした（時間切れ）。もう一度押すか、ホテルや駅を選んで試せます。')
						: t('geoUnavailable', '位置情報を取得できませんでした。もう一度押すか、ホテルや駅を選んで試せます。'));
				fail(text, true);
			},
			{ enableHighAccuracy: true, timeout: 15000, maximumAge: fresh === true ? 0 : 60000 }
		);
	}
	if (GEO_OK) {
		btn.addEventListener('click', function () { locate(false); });
		if (again) again.addEventListener('click', function () { locate(true); });
	} else {
		// 「現在地から」のタブごと出さず、「ホテルから」を選んだ状態にする（押しても必ず失敗するものを見せない）
		tabHere.hidden = true;
		if (toHere) toHere.hidden = true;
		selectTab(tabHotel, false);
	}

	/* ---------- 8. 「戻る」と、最初の状態 ---------- */

	// 出発点を選ぶ前の画面に戻す（同じページの中の「戻る」で、まだ何も選んでいなかった履歴に帰ったとき）
	function reset() {
		++seq;
		++locateSeq;
		busy(false);
		current = null;
		shown = null;
		sayHere('');
		fv.classList.remove('nearby-fv--done', 'nearby-fv--choosing');
		document.body.classList.remove('nearby-located');
		nearSec.hidden = true;
		courseSec.hidden = true;
		grid.innerHTML = '';
		if (genres) { genres.innerHTML = ''; genres.hidden = true; }
		if (moreBtn) { moreBtn.hidden = true; }
		mapData = null;
		if (mapCol) { mapCol.hidden = true; }
		if (mapEl) { mapEl.innerHTML = ''; }
		quizEl.innerHTML = '';
		setActs(null);
		say(GEO_OK ? '' : t('geoUnsupported', 'この端末・ブラウザでは位置情報を使えません。'));
		sayFilter('');
		syncLangLinks(null);
	}

	window.addEventListener('popstate', function (e) {
		var st = e.state || {};
		var o = originFromUrl();
		if (o) {
			// ページ内リンク（#nearby・#course）で積まれた履歴は state を持たない。出している出発点と同じなら描き直さない
			if (current && isPlace(current) && sameOrigin(current, o)) { return; }
			selectTab(tabHotel, false);
			o.name = (st.o && st.o.name) || '';
			o.reading = (st.o && st.o.reading) || '';
			show(o, { history: true });
			return;
		}
		var geo = validGeo(st.geo) ? st.geo : null;
		if (!geo && location.hash) {
			// ページ内リンクの履歴。その手前で出していた現在地の結果のまま（無ければタブに残した座標）として扱う
			geo = (current && current.kind === 'geo') ? current.origin : savedGeo();
		}
		if (geo) {
			if (current && current.kind === 'geo' && current.origin.lat === geo.lat && current.origin.lng === geo.lng) { return; }
			if (GEO_OK) { selectTab(tabHere, false); }
			show(geo, { history: true });
			return;
		}
		reset();
	});

	// 「戻る」で来たときだけ、前の出発点で開き直す（quiz.js も同じ条件で結果を復元する）
	var navType = '';
	try {
		var entries = performance.getEntriesByType('navigation');
		navType = (entries && entries[0]) ? entries[0].type : '';
	} catch (e) { /* 未対応ブラウザは通常扱い */ }
	var srvKind = fv.getAttribute('data-origin-kind') || '';

	if (fv.hasAttribute('data-origin-error')) {
		// 存在しない・座標の無い・範囲外の出発点。文はサーバーが「ホテルから」タブの入力欄の下に描いてある。
		// URLからは外す（再読み込みで同じ文を出さない・言語の切り替えに引き継がない）
		setUrl({}, pageUrl(null), true, null);
		// スマホでは文が最初の画面の外（375x667 で y=695）に出て、失敗したことが分からなかった。見えるところまで動かす（2026-10-03 手直し）
		window.requestAnimationFrame(function () { bringIntoView(hotelMsg); });
	} else if (srvKind) {
		// /nearby/?hotel=<ID> か ?station=<キー>。サーバーが選んだ状態（タブ・入力欄・要約の名前）で描いてあるので、そのまま続ける。
		// 履歴は必ず書き換え（initial）。コースを復元するのは「戻る」で開いたときだけ（history）
		var srvId = fv.getAttribute('data-origin-id') || '';
		show({
			kind: srvKind,
			id: srvKind === 'station' ? srvId : (parseInt(srvId, 10) || 0),
			name: fv.getAttribute('data-origin-name') || '',
			title: fv.getAttribute('data-origin-title') || '',
			reading: fv.getAttribute('data-origin-reading') || ''
		}, { history: navType === 'back_forward', initial: true });
	} else {
		var st0 = history.state || {};
		var saved = validGeo(st0.geo) ? st0.geo : savedGeo();
		if (navType === 'back_forward' && GEO_OK && saved) {
			show(saved, { history: true });
		} else {
			try { sessionStorage.removeItem(ORIGIN_KEY); } catch (e) { /* 無視 */ }
			if (!GEO_OK) { say(t('geoUnsupported', 'この端末・ブラウザでは位置情報を使えません。')); }
		}
	}
})();
