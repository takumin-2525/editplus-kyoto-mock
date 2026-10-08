/**
 * EditPlus Kyoto Concierge テーマ共通JS
 * 1. トップ: スクロールでヘッダーを透明→solidに切り替え
 * 2. 全ページ: ナビが1行に入らないときの切り替え・ハンバーガーメニューの開閉
 */
(function () {
	'use strict';

	// --- 1. ヘッダーのスクロール切り替え（トップのみ＝.hero がある時） ---
	var header = document.getElementById('siteHeader');
	if (header && document.querySelector('.hero')) {
		var onScroll = function () {
			header.classList.toggle('solid', window.scrollY > 40);
		};
		window.addEventListener('scroll', onScroll, { passive: true });
		onScroll();
	}

	// --- ヘッダーのナビ：トップの各セクションへのリンクが1行に入らなければ、≡（引き出し）に任せる ---
	// 入るかどうかは言語と、トップに出ている枠の数で変わるので、CSSの幅決め打ちではなく実測する。
	// 測るときは一度リンクを出した状態に戻す（隠したままだと、広げても戻らない）
	var mainNav = header ? header.querySelector('nav.main') : null;
	if (mainNav && mainNav.querySelector('.nav-sec')) {
		var fitNav = function () {
			header.classList.remove('nav-compact');
			if (mainNav.scrollWidth > mainNav.clientWidth + 1) {
				header.classList.add('nav-compact');
			}
		};
		var fitQueued = false;
		window.addEventListener('resize', function () {
			if (fitQueued) { return; }
			fitQueued = true;
			window.requestAnimationFrame(function () { fitQueued = false; fitNav(); });
		});
		fitNav();
		// Webフォントが後から効くと文字幅が変わる
		if (document.fonts && document.fonts.ready) {
			document.fonts.ready.then(fitNav);
		}
	}

	// --- ヘッダーの開閉パネル（言語）: 外側クリックとEscで閉じる ---
	// 開閉自体は <details> がやる。ここは「開きっぱなしで居座る」のを防ぐだけなので、
	// JSが読めない環境でも切り替えは成立する
	['langMenu'].forEach(function (id) {
		var menu = document.getElementById(id);
		if (!menu) { return; }
		document.addEventListener('click', function (e) {
			if (menu.open && !menu.contains(e.target)) {
				menu.open = false;
			}
		});
		document.addEventListener('keydown', function (e) {
			if (e.key === 'Escape' && menu.open) {
				menu.open = false;
				var summary = menu.querySelector('summary');
				if (summary) { summary.focus(); }
			}
		});
		// Tab で候補の外へ出たら閉じる（2026-10-03。BUGS #26）。閉じるのがクリックと Esc だけだったので、
		// フォーカスがパンくずや本文へ移っても候補の箱が本文の上に残っていた
		menu.addEventListener('focusout', function (e) {
			if (menu.open && e.relatedTarget && !menu.contains(e.relatedTarget)) {
				menu.open = false;
			}
		});
		// 選んだら閉じる。開いたまま次のページへ行くと、ブラウザの「戻る」がその状態のページを戻してくる（#12）
		menu.addEventListener('click', function (e) {
			if (e.target.closest('a')) { menu.open = false; }
		});
		window.addEventListener('pageshow', function (e) {
			if (e.persisted) { menu.open = false; }
		});
	});

	/*
	 * 引き出し（≡）と言語シートを開いているあいだの約束（2026-10-03）
	 * 1. 後ろのページを動かさない（BUGS #7）。以前は body の overflow を hidden にしていたが、style.css の html,body{overflow-x:clip} で
	 *    html の overflow が visible でなくなるため body の指定がビューポートに伝わらず、暗い所や引き出しをなぞると後ろが動き、
	 *    閉じると別の位置にいた。html を止め、iPhone（overflow だけでは止まらない版がある）のために body を今の位置で固定し、閉じたら戻す
	 * 2. Tab を中に閉じ込める（#25）。aria-modal なのに、Tab で後ろのパンくずへ出て後ろのページがスクロールした。後ろを inert にする
	 * 3. 閉じたら開いたボタンへフォーカスを返す（#25）。以前は Esc のときだけで、× や暗い所で閉じるとフォーカスが body に落ちた
	 */
	var lockY = 0;
	function lockPage(dialog) {
		var b = document.body;
		if (b.style.position === 'fixed') { return; }
		lockY = window.pageYOffset;
		document.documentElement.style.overflow = 'hidden';
		b.style.position = 'fixed';
		b.style.top = -lockY + 'px';
		b.style.left = '0';
		b.style.right = '0';
		Array.prototype.forEach.call(b.children, function (n) {
			if (n !== dialog && n.tagName !== 'SCRIPT' && !n.inert) {
				n.inert = true;
				n.setAttribute('data-ep-inert', '');
			}
		});
	}
	function unlockPage() {
		var b = document.body;
		if (b.style.position !== 'fixed') { return; }
		document.documentElement.style.overflow = '';
		b.style.position = '';
		b.style.top = '';
		b.style.left = '';
		b.style.right = '';
		Array.prototype.forEach.call(document.querySelectorAll('[data-ep-inert]'), function (n) {
			n.inert = false;
			n.removeAttribute('data-ep-inert');
		});
		window.scrollTo(0, lockY);
	}

	// --- /hotel/ 探すカード（finder）：タブ・入力候補・現在地順 ---
	// 文字列での絞り込みとページ送りはサーバー側（?hotel_q= / ?hotel_page=）でやっている。
	// JSが無くても探せる状態を壊さないため、ここで足すのは
	//   1. タブの切り替え（「現在地から探す」は位置情報が要るので、使える時だけタブを出す）
	//   2. 入力中の候補（REST /hotels を叩いて、そのままホテルのページへ飛べるようにする）
	//   3. 現在地順（S2）
	// の3つ。S2は #hotelResults の中身をまるごと描き直す。件数行も自分で描く。
	// サーバーが描いた「N件中1〜20件」「1 / 141ページ」を残すと、並べ替えた後の画面で嘘になる。
	// ページ送りは付けない。近い20件に無いなら、名前で探し直したほうが早い。
	// 一覧の行の構造は archive-hotel.php の $ep_hotel_row と同じにする（変えるときは両方）。
	var finder = document.getElementById('hotelFinder');
	if (finder) {
		var TG = window.epI18n || {};
		var tg = function (key, fallback) { return TG[key] || fallback; };
		var escG = function (str) {
			var d = document.createElement('div');
			d.textContent = String(str == null ? '' : str);
			return d.innerHTML;
		};
		var hero = document.getElementById('hotelHero');
		var resultsSec = document.getElementById('results');
		var results = document.getElementById('hotelResults');
		var resultsTitle = document.getElementById('resultsTitle');
		var qField = document.getElementById('hotelQ');

		// data-endpoint には表示言語が ?lang= で載っている（archive-hotel.php）。
		// '?' 決め打ちで足すと lang が消え、英語ページの候補が日本語で返る
		var endpoint = function (el, params) {
			var base = el.getAttribute('data-endpoint');
			return base + (base.indexOf('?') === -1 ? '?' : '&') + params;
		};

		// 一覧の1行。右端（side）は区名か距離
		var rowHtml = function (h, side) {
			return '<li><a href="' + escG(h.url) + '">'
				+ '<span class="hl-name">' + escG(h.title) + '</span>'
				// 訳の無い住所は日本語のまま。lang を付ける（読み上げと、韓国語の「語の途中で折らない」が掛からないように）
				+ (h.address ? '<span class="hl-sub"' + (h.address_lang ? ' lang="' + escG(h.address_lang) + '"' : '') + '>' + escG(h.address) + '</span>' : '')
				+ '<span class="hl-side">' + escG(side || '') + '<span class="hl-arrow" aria-hidden="true">→</span></span>'
				+ '</a></li>';
		};

		// --- 1. タブ ---
		var tabs = Array.prototype.slice.call(finder.querySelectorAll('[role=tab]'));
		var selectTab = function (tab) {
			tabs.forEach(function (t) {
				var on = (t === tab);
				t.classList.toggle('on', on);
				t.setAttribute('aria-selected', on ? 'true' : 'false');
				var panel = document.getElementById(t.getAttribute('aria-controls'));
				if (panel) { panel.hidden = !on; }
			});
		};
		tabs.forEach(function (t) {
			t.addEventListener('click', function () { selectTab(t); });
		});
		var nearTab = document.getElementById('tabNearMe');
		if (nearTab && navigator.geolocation) {
			nearTab.hidden = false; // 位置情報が使える時だけ見せる（PHPは hidden で出している）
		}

		// --- 2. 入力候補 ---
		// 800軒あっても「グ」と打てば自分の宿が出る、を狙う。候補を押せば一覧を経ずにホテルのページへ
		var suggest = document.getElementById('hotelSuggest');
		if (qField && suggest && window.fetch) {
			var timer = null;
			var lastQ = '';
			var selIdx = -1;
			var closeSuggest = function () {
				suggest.hidden = true;
				suggest.innerHTML = '';
				qField.setAttribute('aria-expanded', 'false');
				selIdx = -1;
			};
			var renderSuggest = function (hotels) {
				if (!hotels.length) { closeSuggest(); return; }
				suggest.innerHTML = hotels.map(function (h) {
					return '<li role="option"><a href="' + escG(h.url) + '">'
						+ '<span class="s-name">' + escG(h.title) + '</span>'
						+ (h.area ? '<span class="s-area">' + escG(h.area) + '</span>' : '')
						+ '</a></li>';
				}).join('');
				suggest.hidden = false;
				qField.setAttribute('aria-expanded', 'true');
				selIdx = -1;
				// 候補が画面の下にはみ出すなら、はみ出した分だけページを上げる（2026-10-03。BUGS #34）。
				// スマホでは入力欄が画面の下のほうにあり、1件目から下が切れていた。キーボードが出ているときは
				// その上までしか見えないので、visualViewport（キーボードを除いた見える範囲）で測る
				var vv = window.visualViewport;
				var seen = vv ? vv.offsetTop + vv.height : window.innerHeight;
				var over = suggest.getBoundingClientRect().bottom + 12 - seen;
				var room = qField.getBoundingClientRect().top - (header ? header.getBoundingClientRect().bottom : 0) - 12;
				if (over > 0 && room > 0) { window.scrollBy(0, Math.min(over, room)); }
			};
			var fetchSuggest = function () {
				var q = qField.value.trim();
				if (q === lastQ) { return; }
				lastQ = q;
				if (!q) { closeSuggest(); return; }
				var url = endpoint(qField, 'per_page=6&q=' + encodeURIComponent(q));
				fetch(url)
					.then(function (r) { return r.json(); })
					.then(function (d) {
						// 通信中に入力が進んでいたら、古い結果は捨てる
						if (qField.value.trim() !== q) { return; }
						renderSuggest(d.hotels || []);
					})
					.catch(closeSuggest);
			};
			qField.addEventListener('input', function () {
				clearTimeout(timer);
				timer = setTimeout(fetchSuggest, 220); // 1文字ごとに叩かない
			});
			qField.addEventListener('keydown', function (e) {
				var items = suggest.hidden ? [] : suggest.querySelectorAll('li');
				if (e.key === 'Escape') { closeSuggest(); return; }
				if (!items.length) { return; }
				if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
					e.preventDefault();
					selIdx = (selIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
					items.forEach(function (li, i) { li.classList.toggle('sel', i === selIdx); });
				} else if (e.key === 'Enter' && selIdx >= 0) {
					e.preventDefault();
					window.location.href = items[selIdx].querySelector('a').href;
				}
			});
			document.addEventListener('click', function (e) {
				if (!finder.contains(e.target)) { closeSuggest(); }
			});
		}

		// --- 3. 現在地順（S2） ---
		var nearBtn = document.getElementById('hotelNearMe');
		if (nearBtn && navigator.geolocation && results) {
			var geoMsg = document.getElementById('hotelGeoMsg');
			var say = function (message) { if (geoMsg) { geoMsg.textContent = message; } };

			// 「300m」「1.2km」。1km未満は10m単位に丸める（GPSの精度以上に細かく出さない）
			var distanceLabel = function (meters) {
				if (meters == null) { return ''; }
				// 50m未満は数字で出さない（「約0m」と出ていた。GPSの誤差より細かい数字は意味が無い）
				if (meters < 50) { return tg('distNear', '現在地のすぐ近く'); }
				if (meters < 1000) {
					return String(tg('distM', '現在地から約%dm')).replace('%d', Math.round(meters / 10) * 10);
				}
				return String(tg('distKm', '現在地から約%skm')).replace('%s', (meters / 1000).toFixed(1));
			};

			// 取得中は、押したボタンの文字を「位置情報を取得しています…」に替える（2026-10-03。BUGS #18）。
			// 文はボタンの下（#hotelGeoMsg）にも出しているが、スマホではボタンが画面の下端にあり、文は画面の外だった。
			// 反応が見えないので押し直すと、結果が描かれて写真が消えた瞬間の一覧のホテルを誤って押していた。
			// disabled にはしない（フォーカスが body に落ちる。#32）。二度押しは locating で止める
			var nearLabel = nearBtn.innerHTML;
			var locating = false;
			var nearBusy = function (on) {
				locating = on;
				nearBtn.setAttribute('aria-disabled', on ? 'true' : 'false');
				nearBtn.innerHTML = on ? escG(tg('geoLocating', '位置情報を取得しています…')) : nearLabel;
			};
			nearBtn.addEventListener('click', function () {
				if (locating) { return; }
				nearBusy(true);
				say(tg('geoLocating', '位置情報を取得しています…'));

				navigator.geolocation.getCurrentPosition(
					function (pos) {
						var url = endpoint(nearBtn, 'lat=' + encodeURIComponent(pos.coords.latitude)
							+ '&lng=' + encodeURIComponent(pos.coords.longitude));
						fetch(url)
							.then(function (r) { return r.json(); })
							.then(function (d) {
								nearBusy(false);
								if (!d.hotels || !d.hotels.length) {
									say(tg('geoNone', '近くに提携ホテルが見つかりませんでした。'));
									return;
								}
								// 飛び先はRESTが返すパーマリンク。表示言語の版に差し替え済みのものが来る
								var items = d.hotels.map(function (h) {
									return rowHtml(h, distanceLabel(h.distance));
								}).join('');
								// 1件のときは単数の文（英語・スペイン語で「Nearest 1 hotels」にしない）
								var count = d.hotels.length === 1
									? String(tg('geoTop1', '現在地からいちばん近いホテル'))
									: String(tg('geoTop', '現在地から近い順・上位%s件')).replace('%s', d.hotels.length);
								results.innerHTML = '<p class="hotel-count">' + escG(count) + '</p>'
									+ '<ul class="hlist" id="hotelList">' + items + '</ul>';
								if (resultsTitle) { resultsTitle.textContent = tg('nearTitle', '現在地から近いホテル'); }
								if (resultsSec) { resultsSec.hidden = false; }
								// 見出しを詰めて（S1と同じ見え方）、結果の位置まで送る。
								// ボタンはヒーローの中、結果はその下なので、描いただけだと画面外で気付けない
								if (hero) { hero.classList.add('hotel-fv--compact'); }
								say(tg('geoSorted', '現在地から近い順に並べました。'));
								(resultsSec || results).scrollIntoView({ behavior: 'smooth', block: 'start' });
								// フォーカスは結果の見出しへ（押したボタンは畳んだ見開きの中。読み上げに結果が出たことを伝える。#32）
								if (resultsTitle) {
									resultsTitle.setAttribute('tabindex', '-1');
									resultsTitle.focus({ preventScroll: true });
								}
							})
							.catch(function () {
								nearBusy(false);
								say(tg('loadFailed', '読み込みに失敗しました。'));
							});
					},
					function () {
						// 拒否・タイムアウトのどちらも、次の一手（名前で探す）を添えて出す。
						// 文はボタンのすぐ下。スマホでは画面の外になりうるので、見えるところまで送る（#18）
						nearBusy(false);
						say(tg('geoDenied', '位置情報を使えませんでした。ホテル名で探してください。'));
						if (geoMsg) { geoMsg.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
					},
					{ enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
				);
			});
		}
	}

	// 診断の起動は quiz.js 側で行う（app.js より後に読み込まれるため、ここからは呼べない）

	// --- Browse: 段階式チップ（親エリア/ジャンル → 子チップを展開） ---
	// パネルは開くタイミングで親チップの直後にDOM移動する。flex-basis:100%なので
	// 親チップがいる行のすぐ下に全幅で割り込む形になる
	var closeSubPanel = function (panel) {
		panel.classList.remove('open');
		var unmount = function () {
			// 閉じアニメーション完了後にdisplay:noneへ。閉じた直後に再度開かれていたら何もしない
			if (!panel.classList.contains('open')) {
				panel.classList.remove('mounted');
			}
			panel.removeEventListener('transitionend', onEnd);
		};
		var onEnd = function (e) {
			if (e.target === panel) {
				unmount();
			}
		};
		panel.addEventListener('transitionend', onEnd);
		setTimeout(unmount, 400); // reduced-motion等でtransitionendが発火しない場合の保険
	};
	// 押したチップより上で開いているパネルは、動きを付けずにその場で閉じる（2026-10-03。BUGS #9）。
	// 閉じる動き（0.35秒）のあいだに上の高さが縮み、押したチップも開いた子チップも指の位置から158px上へ逃げていた。
	// その場で閉じれば縮んだ量がすぐ測れるので、同じだけページを戻して、押したチップを指の下に留める
	var closeSubPanelNow = function (panel) {
		panel.style.transition = 'none';
		panel.classList.remove('open', 'mounted');
		void panel.offsetHeight;
		panel.style.transition = '';
	};
	document.querySelectorAll('.chip-toggle').forEach(function (btn) {
		btn.addEventListener('click', function (e) {
			var panel = document.getElementById(btn.getAttribute('aria-controls'));
			if (!panel) {
				return; // パネルが無ければ素のリンクとして親アーカイブへ飛ばす
			}
			// 親チップは a なので、JSが動いている間は遷移させず開閉に使う。
			// Ctrl/⌘+クリックや中クリックは「別タブで親アーカイブ」を期待されるので邪魔しない
			if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) {
				return;
			}
			e.preventDefault();
			var wasOpen = panel.classList.contains('open');
			var before = btn.getBoundingClientRect().top;
			// 同じ軸（エリア/ジャンル）内で開けるのは一つだけ
			var axis = btn.closest('.axis') || document;
			axis.querySelectorAll('.chips-subwrap.open').forEach(function (p) {
				if (p !== panel && p.getBoundingClientRect().top < before) { closeSubPanelNow(p); } else { closeSubPanel(p); }
			});
			axis.querySelectorAll('.chip-toggle.open').forEach(function (b) {
				b.setAttribute('aria-expanded', 'false');
				b.classList.remove('open');
			});
			if (!wasOpen) {
				btn.insertAdjacentElement('afterend', panel);
				panel.classList.add('mounted');
				void panel.offsetHeight; // 差し込み直後に一度レイアウトさせ、0fr→1frの遷移を効かせる
				panel.classList.add('open');
				btn.setAttribute('aria-expanded', 'true');
				btn.classList.add('open');
			}
			var moved = btn.getBoundingClientRect().top - before;
			if (Math.abs(moved) >= 1) { window.scrollBy(0, moved); }
		});
		// 親チップはリンク（JS が無いときは親の一覧へ飛べる）なので、スペースキーは既定でページを1画面送ってしまう（BUGS #30）。
		// role="button"（functions.php）と名乗る以上、ボタンと同じくスペースでも開閉する
		btn.addEventListener('keydown', function (e) {
			if (e.key === ' ' || e.key === 'Spacebar') {
				e.preventDefault();
				btn.click();
			}
		});
	});

	// --- 言語シート（スマホ）: ヘッダーの地球ボタンで下から上げる ---
	// 見た目の出入りはCSSの .open。ここは状態と閉じる手段（暗幕タップ・Esc・選択）を揃えるだけ
	var langBtn = document.getElementById('langBtn');
	var langSheet = document.getElementById('langSheet');
	if (langBtn && langSheet) {
		var openSheet = function () {
			langSheet.classList.add('open');
			langSheet.setAttribute('aria-hidden', 'false');
			langBtn.setAttribute('aria-expanded', 'true');
			lockPage(langSheet);
			var first = langSheet.querySelector('a');
			if (first) { first.focus(); }
		};
		/** @param {boolean} [stay] フォーカスを地球ボタンへ返さない（言語を選んで次のページへ行くとき） */
		var closeSheet = function (stay) {
			if (!langSheet.classList.contains('open')) { return; }
			langSheet.classList.remove('open');
			langSheet.setAttribute('aria-hidden', 'true');
			langBtn.setAttribute('aria-expanded', 'false');
			unlockPage();
			if (stay !== true) { langBtn.focus(); }
		};
		langBtn.addEventListener('click', function () {
			if (langSheet.classList.contains('open')) { closeSheet(); } else { openSheet(); }
		});
		var sheetScrim = document.getElementById('langSheetScrim');
		if (sheetScrim) { sheetScrim.addEventListener('click', function () { closeSheet(); }); }
		document.addEventListener('keydown', function (e) {
			if (e.key === 'Escape' && langSheet.classList.contains('open')) {
				closeSheet();
			}
		});
		// 選んだら閉じる。閉じずに次のページへ行くと、ブラウザの「戻る」が開いた状態のページ（後ろのスクロールも止まったまま）を
		// そのまま戻してきた（BUGS #12）。戻る用のキャッシュから出てきたときも念のため閉じる
		langSheet.addEventListener('click', function (e) {
			if (e.target.closest('a')) { closeSheet(true); }
		});
		window.addEventListener('pageshow', function (e) {
			if (e.persisted) { closeSheet(true); }
		});
	}

	// --- 2. モバイルメニューの開閉 ---
	// 開閉の見た目（引き出しの滑り・暗幕・項目の順次表示）はCSSの .open がやる。
	// ここは状態の付け外しと、閉じる手段（×・暗幕タップ・Esc）を揃えるだけ
	var menuBtn = document.getElementById('menuBtn');
	var mnav = document.getElementById('mnav');
	var mclose = document.getElementById('mnavClose');
	var mscrim = document.getElementById('mnavScrim');
	if (menuBtn && mnav) {
		var openMenu = function () {
			// スクロールバーが消える分の幅を測って余白で相殺（開閉時のガタつき防止）
			var sw = window.innerWidth - document.documentElement.clientWidth;
			mnav.classList.add('open');
			mnav.setAttribute('aria-hidden', 'false');
			menuBtn.setAttribute('aria-expanded', 'true');
			lockPage(mnav); // 背景のスクロールを止め、Tab を引き出しの中に閉じ込める
			if (sw > 0) {
				document.body.style.paddingRight = sw + 'px';
				if (header) {
					header.style.paddingRight = sw + 'px';
				}
			}
			if (mclose) { mclose.focus(); }
		};
		/** @param {boolean} [stay] フォーカスを ≡ へ返さない（引き出しのリンクで移動するとき） */
		var closeMenu = function (stay) {
			if (!mnav.classList.contains('open')) { return; }
			mnav.classList.remove('open');
			mnav.setAttribute('aria-hidden', 'true');
			menuBtn.setAttribute('aria-expanded', 'false');
			unlockPage();
			document.body.style.paddingRight = '';
			if (header) {
				header.style.paddingRight = '';
			}
			if (stay !== true) { menuBtn.focus(); }
		};
		menuBtn.addEventListener('click', openMenu);
		if (mclose) {
			mclose.addEventListener('click', function () { closeMenu(); });
		}
		if (mscrim) {
			mscrim.addEventListener('click', function () { closeMenu(); }); // 暗幕（ページ側）を押しても閉じる
		}
		document.addEventListener('keydown', function (e) {
			if (e.key === 'Escape' && mnav.classList.contains('open')) {
				closeMenu();
			}
		});
		// メニュー内リンクを押したら閉じる（同一ページ内アンカー対策）。
		// 閉じる処理（ページの固定を外して元の位置へ戻す）はリンクの既定の動き（アンカーへの移動）より先に走るので、着地は崩れない
		mnav.addEventListener('click', function (e) {
			if (e.target.closest('a')) {
				closeMenu(true);
			}
		});
		window.addEventListener('pageshow', function (e) {
			if (e.persisted) { closeMenu(true); }
		});
	}
})();

/**
 * トップのバナー：横一列に入りきらないときだけ矢印を出す（スライド式）。
 * 入るかどうかは枚数ではなく実際の幅で決まる（画面幅・枚数で変わる）ので、描いたあとに測る。
 */
(function () {
	'use strict';
	document.querySelectorAll('.ep-slider').forEach(function (slider) {
		var list = slider.querySelector('.ep-slider__list');
		var prev = slider.querySelector('.ep-slider__btn--prev');
		var next = slider.querySelector('.ep-slider__btn--next');
		if (!list || !prev || !next) {
			return;
		}
		var count = slider.querySelector('.ep-slider__count');
		var now = slider.querySelector('.ep-slider__now');
		// 点（スポット記事の写真スライド）。バナーの欄には無いので、あるときだけ動かす
		var dots = Array.prototype.slice.call(slider.querySelectorAll('.ep-slider__dot'));

		function itemStep() {
			var item = list.querySelector('.ep-slider__item');
			var gap = parseFloat(getComputedStyle(list).columnGap) || 0;
			return item ? item.getBoundingClientRect().width + gap : list.clientWidth;
		}
		// 端のボタンは disabled にしない（2026-10-03。BUGS #32）。フォーカスのあるボタンを disabled にすると、
		// フォーカスが body に落ちて枠が消え、次の Tab で1枚目の点へ飛んでいた。押せないことは aria-disabled と見た目で伝え、
		// 押されても何もしない（下の step）
		function setEdge(btn, off) {
			btn.setAttribute('aria-disabled', off ? 'true' : 'false');
		}
		function update() {
			var overflow = list.scrollWidth > list.clientWidth + 1;
			prev.hidden = !overflow;
			next.hidden = !overflow;
			setEdge(prev, list.scrollLeft <= 1);
			setEdge(next, list.scrollLeft + list.clientWidth >= list.scrollWidth - 1);
			if (count) {
				// 「いま何枚目か」。収まりきっているときは出さない（送る必要が無いため）
				count.hidden = !overflow;
				if (overflow && now) {
					now.textContent = Math.round(list.scrollLeft / itemStep()) + 1;
				}
			}
			if (dots.length) {
				var at = Math.round(list.scrollLeft / itemStep());
				dots.forEach(function (dot, i) {
					// aria-current は「いまここ」を読み上げにも伝える。
					// クラスで塗るだけだと、見えている人にしか伝わらない
					if (i === at) { dot.setAttribute('aria-current', 'true'); } else { dot.removeAttribute('aria-current'); }
				});
			}
		}
		// 送り先を「何枚目か」で持つ（2026-10-03。BUGS #15）。以前は scrollBy で「いまの位置＋1枚」を送っていたため、
		// 動いている途中に押すと途中の位置からの1枚になり、吸着（scroll-snap）が近いほうの写真へ引き戻した
		// （PC で60ms間隔に3回押すと1枚しか進まない）。止まったら実際の位置に合わせ直す
		var target = null;
		function step(dir) {
			var max = Math.ceil((list.scrollWidth - list.clientWidth) / itemStep() - 0.01);
			var from = (target === null) ? Math.round(list.scrollLeft / itemStep()) : target;
			var to = Math.max(0, Math.min(max, from + dir));
			if (to === from) { return; } // 端では何もしない（ボタンは aria-disabled）
			target = to;
			list.scrollTo({ left: to * itemStep(), behavior: 'smooth' });
		}
		var settle = null;
		var settled = function () { target = null; update(); };
		prev.addEventListener('click', function () { step(-1); });
		next.addEventListener('click', function () { step(1); });
		dots.forEach(function (dot, i) {
			dot.addEventListener('click', function () { target = i; list.scrollTo({ left: i * itemStep(), behavior: 'smooth' }); });
		});
		list.addEventListener('scroll', function () {
			update();
			// scrollend の無いブラウザ（古い Safari）では、スクロールが止まって少し経ったら止まったとみなす
			if (!('onscrollend' in window)) {
				clearTimeout(settle);
				settle = setTimeout(settled, 160);
			}
		}, { passive: true });
		list.addEventListener('scrollend', settled);
		window.addEventListener('resize', update);
		window.addEventListener('load', update);
		update();
	});
})();

/**
 * トップの「地図から探す」：地図が入りきらない幅（スマホ）では横にずらして見る。
 * 左端から始めると西の外れ（嵐山）しか見えないので、最初は真ん中（街なか）を見せる。
 */
(function () {
	'use strict';
	document.querySelectorAll('.bm-scroll').forEach(function (box) {
		var center = function () {
			var over = box.scrollWidth - box.clientWidth;
			if (over > 0) {
				box.scrollLeft = over / 2;
			}
		};
		center();
		window.addEventListener('load', center, { once: true });
	});
})();

/**
 * トップのヒーロー：写真を選んでいないときは同梱の3枚を3秒ごとに入れ替える（2026-10-07。もとは Figma「ヒーローの動き」の4秒・1.6秒だったが、遅いという指示で同日に半分にした。Figmaのその絵は同日に削除したので、既定の秒数の正はここ）。
 * 編集部が管理画面で写真を2枚以上選んだときも、同じ動きでその順に入れ替える。切り替わる間隔も管理画面で選べる（2026-10-08。.hero-ctl の data-hold に秒で入る。書かれていなければ既定の2秒）。
 * 見た目（重なり方・0.8秒の動き）は style.css の .hero-slide。ここは順番と止める条件だけを持つ。
 * 動きを減らす設定の端末では始めない（1枚目のまま・ボタンも出さない）。止めるボタンはキーボードで選んだときだけ見える（style.css .hero-pause）。
 * 画面の外にあるとき・タブが裏にあるときは止める（見ていないのに次の写真を読み込ませない）。
 */
(function () {
	'use strict';
	var hero = document.querySelector('.hero');
	var slides = hero ? hero.querySelectorAll('.hero-slide') : [];
	var ctl = hero ? hero.querySelector('.hero-ctl') : null;
	if (slides.length < 2 || !ctl || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
		return;
	}
	// 写真が切り替わる間隔。管理画面で選んだ秒数（inc/hero-media.php が data-hold に書く）。無い・数字でないときは既定の3秒。
	// 選んだ秒数は「切り替わりから次の切り替わりまで」なので、重なる動き（ENTER）のぶんを引いて待つ
	// （引かないと「4秒」を選んで 4.8秒ごとになる）
	var ENTER = 800;   // 次の写真が重なりきるまで（style.css の ep-hero-enter と同じ）
	var holdSec = parseFloat(ctl.getAttribute('data-hold'));
	var HOLD = Math.max(1000, (holdSec > 0 ? holdSec : 3) * 1000 - ENTER);   // 1枚が止まって見える時間
	var btn = ctl.querySelector('.hero-pause');
	var cur = 0;
	var timer = null;
	var paused = false;   // ボタンで止めた
	var visible = true;   // 画面に入っている
	ctl.hidden = false;

	var ready = function (img) { return img.complete && img.naturalWidth > 0; };

	var schedule = function () {
		clearTimeout(timer);
		if (!paused && visible && !document.hidden) {
			timer = setTimeout(next, HOLD);
		}
	};

	function next() {
		var from = slides[cur];
		var to = slides[(cur + 1) % slides.length];
		if (!ready(to)) {
			// まだ届いていなければ、届いてから入れ替える（真っ黒な枠が重なってこないように）
			to.loading = 'eager';
			to.addEventListener('load', schedule, { once: true });
			return;
		}
		cur = (cur + 1) % slides.length;
		to.classList.add('is-enter');
		setTimeout(function () {
			// 重なりきってから前の写真を下ろす。先に下ろすと一瞬地が見える
			from.classList.remove('is-on');
			to.classList.add('is-on');
			to.classList.remove('is-enter');
			schedule();
		}, ENTER);
	}

	btn.addEventListener('click', function () {
		paused = !paused;
		btn.setAttribute('aria-pressed', paused ? 'true' : 'false');
		btn.setAttribute('aria-label', btn.getAttribute(paused ? 'data-label-play' : 'data-label-pause'));
		schedule();
	});
	document.addEventListener('visibilitychange', schedule);
	if ('IntersectionObserver' in window) {
		new IntersectionObserver(function (entries) {
			visible = entries[0].isIntersecting;
			schedule();
		}).observe(hero);
	}
	schedule();
})();
