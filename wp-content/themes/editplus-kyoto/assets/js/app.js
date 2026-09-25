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
	});

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
				+ (h.address ? '<span class="hl-sub">' + escG(h.address) + '</span>' : '')
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
				if (meters < 1000) {
					return String(tg('distM', '現在地から約%dm')).replace('%d', Math.round(meters / 10) * 10);
				}
				return String(tg('distKm', '現在地から約%skm')).replace('%s', (meters / 1000).toFixed(1));
			};

			nearBtn.addEventListener('click', function () {
				nearBtn.disabled = true;
				say(tg('geoLocating', '位置情報を取得しています…'));

				navigator.geolocation.getCurrentPosition(
					function (pos) {
						var url = endpoint(nearBtn, 'lat=' + encodeURIComponent(pos.coords.latitude)
							+ '&lng=' + encodeURIComponent(pos.coords.longitude));
						fetch(url)
							.then(function (r) { return r.json(); })
							.then(function (d) {
								nearBtn.disabled = false;
								if (!d.hotels || !d.hotels.length) {
									say(tg('geoNone', '近くに提携ホテルが見つかりませんでした。'));
									return;
								}
								// 飛び先はRESTが返すパーマリンク。表示言語の版に差し替え済みのものが来る
								var items = d.hotels.map(function (h) {
									return rowHtml(h, distanceLabel(h.distance));
								}).join('');
								var count = String(tg('geoTop', '現在地から近い順・上位%s件'))
									.replace('%s', d.hotels.length);
								results.innerHTML = '<p class="hotel-count">' + escG(count) + '</p>'
									+ '<ul class="hlist" id="hotelList">' + items + '</ul>';
								if (resultsTitle) { resultsTitle.textContent = tg('nearTitle', '現在地から近いホテル'); }
								if (resultsSec) { resultsSec.hidden = false; }
								// 見出しを詰めて（S1と同じ見え方）、結果の位置まで送る。
								// ボタンはヒーローの中、結果はその下なので、描いただけだと画面外で気付けない
								if (hero) { hero.classList.add('hotel-fv--compact'); }
								say(tg('geoSorted', '現在地から近い順に並べました。'));
								(resultsSec || results).scrollIntoView({ behavior: 'smooth', block: 'start' });
							})
							.catch(function () {
								nearBtn.disabled = false;
								say(tg('loadFailed', '読み込みに失敗しました。'));
							});
					},
					function () {
						// 拒否・タイムアウトのどちらも、次の一手（名前で探す）を添えて出す
						nearBtn.disabled = false;
						say(tg('geoDenied', '位置情報を使えませんでした。ホテル名で探してください。'));
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
			// 同じ軸（エリア/ジャンル）内で開けるのは一つだけ
			var axis = btn.closest('.axis') || document;
			axis.querySelectorAll('.chips-subwrap.open').forEach(closeSubPanel);
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
			document.body.style.overflow = 'hidden';
			var first = langSheet.querySelector('a');
			if (first) { first.focus(); }
		};
		var closeSheet = function () {
			langSheet.classList.remove('open');
			langSheet.setAttribute('aria-hidden', 'true');
			langBtn.setAttribute('aria-expanded', 'false');
			document.body.style.overflow = '';
		};
		langBtn.addEventListener('click', function () {
			if (langSheet.classList.contains('open')) { closeSheet(); } else { openSheet(); }
		});
		var sheetScrim = document.getElementById('langSheetScrim');
		if (sheetScrim) { sheetScrim.addEventListener('click', closeSheet); }
		document.addEventListener('keydown', function (e) {
			if (e.key === 'Escape' && langSheet.classList.contains('open')) {
				closeSheet();
				langBtn.focus();
			}
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
			document.body.style.overflow = 'hidden'; // 背景のスクロールを止める
			if (sw > 0) {
				document.body.style.paddingRight = sw + 'px';
				if (header) {
					header.style.paddingRight = sw + 'px';
				}
			}
			if (mclose) { mclose.focus(); }
		};
		var closeMenu = function () {
			mnav.classList.remove('open');
			mnav.setAttribute('aria-hidden', 'true');
			menuBtn.setAttribute('aria-expanded', 'false');
			document.body.style.overflow = '';
			document.body.style.paddingRight = '';
			if (header) {
				header.style.paddingRight = '';
			}
		};
		menuBtn.addEventListener('click', openMenu);
		if (mclose) {
			mclose.addEventListener('click', closeMenu);
		}
		if (mscrim) {
			mscrim.addEventListener('click', closeMenu); // 暗幕（ページ側）を押しても閉じる
		}
		document.addEventListener('keydown', function (e) {
			if (e.key === 'Escape' && mnav.classList.contains('open')) {
				closeMenu();
				menuBtn.focus();
			}
		});
		// メニュー内リンクを押したら閉じる（同一ページ内アンカー対策）
		mnav.addEventListener('click', function (e) {
			if (e.target.closest('a')) {
				closeMenu();
			}
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
		function update() {
			var overflow = list.scrollWidth > list.clientWidth + 1;
			prev.hidden = !overflow;
			next.hidden = !overflow;
			prev.disabled = list.scrollLeft <= 1;
			next.disabled = list.scrollLeft + list.clientWidth >= list.scrollWidth - 1;
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
		function step(dir) {
			list.scrollBy({ left: dir * itemStep(), behavior: 'smooth' });
		}
		prev.addEventListener('click', function () { step(-1); });
		next.addEventListener('click', function () { step(1); });
		dots.forEach(function (dot, i) {
			dot.addEventListener('click', function () { list.scrollTo({ left: i * itemStep(), behavior: 'smooth' }); });
		});
		list.addEventListener('scroll', update, { passive: true });
		window.addEventListener('resize', update);
		window.addEventListener('load', update);
		update();
	});
})();
