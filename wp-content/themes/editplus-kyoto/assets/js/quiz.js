/**
 * AIコンシェルジュ診断
 * 質問に答える → REST API（サーバー経由でGemini）→ 時刻つきのモデルコースを表示。
 * 設問と選択肢はサーバー側 editplus_ai_concierge_questions() が正で、
 * wp_localize_script（epQuizI18n.questions）経由で受け取る。ここには写さない
 * （インデックスで送るため、順番がずれると別の条件で提案されてしまう）。
 *
 * 使い方は2通り:
 *   1. トップページ: #epQuiz があれば自動で起動する（5問）
 *   2. ホテルから探すページ: window.epQuizMount(el, { hotel: <ID> }) で起動する。
 *      出発地はそのホテルに決まっているので「どこから出発しますか？」は出さない（4問）
 *   3. 現在地から探すページ（/nearby/）: nearby.js が位置情報を取ってから
 *      window.epQuizMount(el, { origin: { lat, lng } }) で起動する（4問）
 */
(function () {
	'use strict';

	// 文言は functions.php の wp_localize_script（epQuizI18n）から来る。
	// 未定義でも動くよう、日本語をフォールバックとして持たせている
	var T = window.epQuizI18n || {};
	var t = function (key, fallback) { return T[key] || fallback; };
	var fmt = function (str, value) { return String(str).replace(/%[ds]/, value); };
	// 所要時間は移動時間からの目安でしかない（結果画面でもそう断っている）。
	// 「約4.1時間」は人が言わないうえ、持っていない精度を主張してしまう。30分刻みで丸める
	var roughHours = function (min) {
		var half = Math.max(1, Math.round(min / 30));      // 30分単位
		var h = Math.floor(half / 2);
		if (half % 2) { return h ? fmt(t('aboutHoursHalf', '約%d時間半'), h) : t('aboutHalfHour', '約30分'); }
		return fmt(t('aboutHours', '約%s時間'), h);
	};

	// 設問はサーバー（epQuizI18n.questions ← editplus_ai_concierge_questions()）から来る。
	// **並びも個数もサーバーが正。**回答はインデックスで送るので、ここで写して1つでも
	// ずれると、利用者は別の条件で提案を受けることになる。
	// 出発地の選択肢は地域プロファイル由来（大阪版では中身が変わる）なので、なおさら写さない。
	var ALL_QUESTIONS = (T.questions || []).filter(function (q) {
		return q && q.key && q.options && q.options.length;
	}).map(function (q) {
		return { key: q.key, title: q.title || '', options: q.options };
	});

	// 文言が届かなかったときの最小限のフォールバック。
	// **地域で変わる設問（出発地）はあえて持たない。**京都の選択肢を焼き込むと、
	// コピーして作ったサイトで「嵐山から」が出たまま誰も気づかない。
	// 訊かなければサーバーが「おまかせ」で補完するので、コースは出る
	if (!ALL_QUESTIONS.length) {
		ALL_QUESTIONS = [
			{ key: 'companion', title: 'どなたと巡りますか？', options: ['ひとり旅', 'ふたりで', '家族・友人と'] },
			{ key: 'mood', title: 'どんな時間を過ごしたいですか？', options: ['静かに、ゆっくり', '食べ歩きたい', '歴史と文化にふれる', '絶景を見たい'] },
			{ key: 'time', title: '使える時間は？', options: ['半日（3〜4時間）', '一日（6〜8時間）', '夜だけ（3時間）'] },
			{ key: 'transport', title: '移動の手段は？', options: ['徒歩でゆっくり', '電車・バス', 'タクシー・車'] }
		];
	}

/**
 * 診断UIを指定要素にマウントする。
 *
 * @param {HTMLElement} el      描画先。data-endpoint に REST の URL を持つこと。
 * @param {Object}      options { hotel: ホテルID } を渡すと、そのホテルが出発地になる。
 *                              { origin: { lat, lng } } を渡すと、その座標（現在地）が出発地になる。
 */
function mount(el, options) {
	options = options || {};
	var endpoint = el.getAttribute('data-endpoint');
	var hotelId = options.hotel ? String(options.hotel) : '';
	var origin = (!hotelId && options.origin) ? options.origin : null;

	// ホテル・現在地起点のときは出発地が決まっているので、その設問だけ落とす。
	// key で送るので、設問を減らしてもサーバー側は既定値で補完してくれる
	var QUESTIONS = (hotelId || origin)
		? ALL_QUESTIONS.filter(function (q) { return q.key !== 'start'; })
		: ALL_QUESTIONS.slice();

	var answers = QUESTIONS.map(function () { return null; });
	var step = 0;
	var busy = false;
	var lastReq = null; // 直前に送った条件。予算チップはこれを予算だけ変えて送り直す

	// 診断結果はsessionStorageに保存し、スポット閲覧から戻ってきても復元する
	// （タブを閉じると自動で消える）。ホテルごとに別の保存先にする
	// 現在地は1つの保存先。「戻る」以外で開き直したら下の初期表示で捨てるので、別の場所の結果は出ない
	var STORAGE_KEY = hotelId ? 'epQuizResult_h' + hotelId : (origin ? 'epQuizResult_geo' : 'epQuizResult');

	// XSS対策: 動的な文字列は必ずこれを通してHTMLに入れる
	function esc(s) {
		var d = document.createElement('div');
		d.textContent = String(s == null ? '' : s);
		return d.innerHTML;
	}

	function renderQuestion() {
		el.classList.remove('is-result');
		var q = QUESTIONS[step];
		var opts = q.options.map(function (label, i) {
			var sel = answers[step] === i ? ' sel' : '';
			return '<button type="button" class="q-opt' + sel + '" data-i="' + i + '">' + esc(label) + '</button>';
		}).join('');

		el.innerHTML = '<div class="q-step">'
			+ (step > 0 ? '<button type="button" class="q-back">' + esc(t('back', '← 戻る')) + '</button>' : '')
			+ '<div class="q-prog">' + esc(t('questionLabel', '質問')) + ' ' + (step + 1) + ' / ' + QUESTIONS.length + '</div>'
			+ '<h3 class="q-title">' + esc(q.title) + '</h3>'
			+ '<div class="q-opts">' + opts + '</div>'
			+ '</div>';

		el.querySelectorAll('.q-opt').forEach(function (btn) {
			btn.addEventListener('click', function () {
				if (busy) return;
				busy = true;
				answers[step] = parseInt(btn.getAttribute('data-i'), 10);
				btn.classList.add('sel');
				setTimeout(function () {
					busy = false;
					step++;
					if (step < QUESTIONS.length) {
						renderQuestion();
					} else {
						submit();
					}
				}, 200);
			});
		});
		var back = el.querySelector('.q-back');
		if (back) {
			back.addEventListener('click', function () {
				if (step > 0) { step--; renderQuestion(); }
			});
		}
	}

	function renderLoading() {
		el.classList.remove('is-result');
		el.innerHTML = '<div class="q-step">'
			+ '<h3 class="q-title">' + esc(t('building', 'あなたのコースを組み立てています…')) + '</h3>'
			+ '<div class="q-loading"><span></span><span></span><span></span></div>'
			+ '<p class="q-note">' + esc(t('buildingNote', '京都観光コンシェルジュが厳選したスポットから、移動時間まで含めて選んでいます（10秒ほどかかることがあります）')) + '</p>'
			+ '</div>';
	}

	function renderError(message) {
		el.classList.remove('is-result');
		el.innerHTML = '<div class="q-step">'
			+ '<h3 class="q-title">' + esc(message || t('failed', '診断に失敗しました。')) + '</h3>'
			+ '<div class="q-nav"><button type="button" class="q-next" id="qRetry">' + esc(t('retry', 'もう一度試す')) + '</button></div>'
			+ '</div>';
		el.querySelector('#qRetry').addEventListener('click', reset);
	}

	/** 「1.2km」のような表記に丸める（1km未満はm） */
	function distLabel(m) {
		if (!m && m !== 0) return '';
		return m < 1000 ? m + 'm' : (Math.round(m / 100) / 10) + 'km';
	}

	// 行程のカードに写真を載せる。診断の API は写真を返さないので、WP の公開 API（スポットの一覧）から取る。
	// 診断の組み立てには触らない。取れなかったカードは「名前の面」のまま
	function loadPhotos(ids) {
		if (!ids.length || !window.fetch) { return; }
		var url = endpoint.replace('editplus/v1/concierge', 'wp/v2/spot');
		url += (url.indexOf('?') === -1 ? '?' : '&') + 'include=' + ids.join(',') + '&per_page=' + ids.length
			+ '&_embed=wp:featuredmedia&_fields=id,_links,_embedded';
		fetch(url).then(function (r) { return r.ok ? r.json() : []; }).then(function (list) {
			(list || []).forEach(function (p) {
				var m = p._embedded && p._embedded['wp:featuredmedia'] && p._embedded['wp:featuredmedia'][0];
				if (!m || !m.source_url) { return; }
				var sizes = (m.media_details && m.media_details.sizes) || {};
				var src = (sizes.medium_large || sizes.large || sizes.medium || m).source_url;
				var card = el.querySelector('.spot[data-spot="' + p.id + '"]');
				if (!card) { return; }
				// 写真が載ったら見出しを見せ、フォーカス先も見出しのリンクに移す（写真のリンクは同じ行き先の重複）
				var ph = card.querySelector('.rs-ph');
				ph.innerHTML = '<div class="imgwrap"><img src="' + esc(src) + '" alt="" loading="lazy"></div>';
				ph.setAttribute('tabindex', '-1');
				ph.setAttribute('aria-hidden', 'true');
				card.classList.remove('spot--text');
				var h = card.querySelector('h4');
				if (h) {
					h.classList.remove('screen-reader-text');
					h.querySelector('a').removeAttribute('tabindex');
				}
			});
		}).catch(function () { /* 写真が無くても行程は読める */ });
	}

	function renderResult(data) {
		// 'cache' で返ってくる場合もあるので「ai以外は編集部セレクト」で判定する。
		// source === 'fallback' だけを見ると、キャッシュ済みのフォールバックに
		// 「Your Route」のバッジが付き、本文の「編集部の定番スポットで組みました」と矛盾する
		var badge = data.source === 'ai' ? t('badgeRoute', 'コンシェルジュの提案') : t('badgePick', '編集部のおすすめ');
		var plan = data.plan || {};
		// 数字まわりの約物は言語で変える。日本語は「徒歩8分」「4スポット」と詰め、区切りは「・」、時間の幅は「〜」。
		// 間に半角の空白や「–」を入れると、欧文の作法で機械が組んだ表記に見える
		var ja = /^ja/i.test(document.documentElement.lang || '');
		var gap = ja ? '' : ' ';
		var dot = ja ? '・' : ' · ';
		var dotEnd = ja ? '・' : ' ·'; // 項目の末尾に付けるとき（後ろの空白は項目の間に置く）
		var range = ja ? '〜' : '–';

		// トップページの棚と同じ組み：時刻を上に置いた、トップと同じスポットのカード（.spot）の列。
		// 写真は後から載せる（loadPhotos）。載るまでは、トップと同じ「名前の面」で受ける
		var ids = [];
		var steps = (data.spots || []).map(function (s, i) {
			if (s.id) { ids.push(parseInt(s.id, 10)); }
			// ひとつ前の場所（1件目は出発地）からの移動。1件目も必ず出す
			var leg = s.travel_min
				? '<span class="rs-leg">' + esc(s.travel_by || t('travel', '移動')) + gap + esc(fmt(t('minutes', '%d分'), s.travel_min))
					+ (s.distance_m ? dot + distLabel(s.distance_m) : '') + '</span>'
				: '';
			// 着く時刻を大きく、出る時刻を小さく（誌面のモデルコースと同じ）。時刻が無いときだけ順番の数字
			var when = s.arrive
				? '<b>' + esc(s.arrive) + '</b>' + (s.leave ? '<small>' + range + esc(s.leave) + '</small>' : '')
				: '<b>' + (i + 1) + '</b>';
			// トップのカードと同じ「エリア｜ジャンル」の1行
			var cat = [s.area, s.cat].filter(Boolean).map(esc).join('｜');

			// 営業時間・定休日は誌面の原文をそのまま出す。
			// 診断は日付を聞いていないので「その日開いているか」は保証できない。
			// 保証しないと決めた以上、判断材料は隠さずに出す
			var facts = [];
			if (s.hours) facts.push(esc(t('hoursLabel', '営業時間')) + ' ' + esc(s.hours));
			if (s.holiday) facts.push(esc(t('holidayLabel', '定休日')) + ' ' + esc(s.holiday));

			var acts = [];
			if (s.map_url) acts.push('<a href="' + esc(s.map_url) + '" target="_blank" rel="noopener">' + esc(t('viewMap', '地図で見る')) + '</a>');
			if (s.stay_min) acts.push('<span>' + esc(fmt(t('stayMin', '滞在%d分'), s.stay_min)) + '</span>');

			return '<li class="rs-step" style="animation-delay:' + (i * 90) + 'ms">'
				+ '<p class="rs-when">' + leg + when + '</p>'
				+ '<article class="spot spot--text" data-spot="' + (s.id ? parseInt(s.id, 10) : '') + '">'
				+ '<a class="rs-ph" href="' + esc(s.url) + '"><div class="noimg"><span class="noimg-name">' + esc(s.title) + '</span></div></a>'
				+ '<div class="in">'
				+ (cat ? '<span class="cat">' + cat + '</span>' : '')
				// 写真が無いあいだは上の面が見出しを兼ねる（トップのカードと同じ扱い）。読み上げ用に見出しは残すが、
				// 見えないリンクにタブが止まらないようにする（フォーカスが画面から消える）
				+ '<h4 class="screen-reader-text"><a href="' + esc(s.url) + '" tabindex="-1">' + esc(s.title) + '</a></h4>'
				+ '<p class="rs-reason">' + esc(s.reason) + '</p>'
				+ (facts.length ? '<p class="ts-facts">' + facts.join('<br>') + '</p>' : '')
				+ (acts.length ? '<div class="actions">' + acts.join('') + '</div>' : '')
				+ '</div></article></li>';
		}).join('');

		var stats = [];
		// 現在地の起点名はサーバが日本語で返すので、ここで訳す
		var startLabel = plan.start_kind === 'geo' ? t('hereLabel', '現在地') : plan.start_label;
		if (startLabel) stats.push('<span>' + esc(fmt(t('fromLabel', '%s発'), startLabel)) + '</span>');
		if (plan.transport_label) stats.push('<span>' + esc(plan.transport_label) + '</span>');
		if (plan.begin) stats.push('<span>' + esc(plan.begin) + range + esc(plan.end) + '</span>');
		if (plan.total_min) stats.push('<span>' + esc(roughHours(plan.total_min)) + '</span>');
		stats.push('<span>' + esc(fmt(t('spotCount', '%dスポット'), (data.spots || []).length)) + '</span>');

		var route = plan.map_url
			? '<a class="r-map" href="' + esc(plan.map_url) + '" target="_blank" rel="noopener">' + esc(t('openRoute', 'Googleマップでルートを開く')) + '</a>'
			: '';

		// 予算の調整チップ。plan.price_band が空＝食事の値段が分からないコースでは出さない。
		// 「押しても何も変わらない」ボタンを置かないための条件（データが無いことを隠さない）
		var band = parseInt(plan.price_band, 10);
		var chips = '';
		if (band >= 1 && band <= 3) {
			if (band > 1) {
				chips += '<button type="button" class="b-chip" data-budget="' + (band - 1) + '">'
					+ esc(t('cheaper', 'もう少し手頃に')) + '</button>';
			}
			if (band < 3) {
				chips += '<button type="button" class="b-chip" data-budget="' + (band + 1) + '">'
					+ esc(t('pricier', 'ちょっと贅沢に')) + '</button>';
			}
		}
		// 予算どおりに組めなかった回は、そう書く。黙って違う値段の店を出さない
		var relaxed = data.relaxed || [];
		if (relaxed.indexOf('budget') !== -1) {
			chips += '<span class="b-note">' + esc(t('budgetApprox', '※ この条件では候補が少なく、予算は目安になっています')) + '</span>';
		}
		if (chips) { chips = '<div class="r-budget">' + chips + '</div>'; }

		el.classList.add('is-result');
		el.innerHTML = '<div class="q-res">'
			+ '<div class="res-head">'
			+ '<div class="res-h"><h3 class="res-title">' + esc(data.title) + '</h3>'
			+ '<button type="button" class="r-reset" id="qReset">' + esc(t('startOver', 'もう一度診断する')) + '</button></div>'
			+ (data.description ? '<p class="res-desc">' + esc(data.description) + '</p>' : '')
			+ '<div class="res-stats">' + stats.join('') + '<span class="res-badge">' + badge + '</span></div>'
			+ '</div>'
			+ '<ol class="rs-grid">' + steps + '</ol>'
			+ '<div class="r-foot">' + route + chips + '</div>'
			+ '<p class="res-note">' + esc(t('timeNote', '時刻は移動時間からの目安です。営業時間・定休日は各スポットのページと公式情報でご確認ください。')) + '</p>'
			+ '</div>';
		loadPhotos(ids);

		el.querySelector('#qReset').addEventListener('click', reset);
		Array.prototype.forEach.call(el.querySelectorAll('.b-chip'), function (btn) {
			btn.addEventListener('click', function () {
				submit(parseInt(btn.getAttribute('data-budget'), 10));
			});
		});
	}

	function reset() {
		try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) { /* プライベートモード等では無視 */ }
		answers = QUESTIONS.map(function () { return null; });
		lastReq = null;
		step = 0;
		renderQuestion();
	}

	/**
	 * @param {number} [budget] 予算の帯（1〜3）。結果画面の調整チップから渡される。
	 *                          設問では聞かない（→ 30_要件定義/食事と予算_プラン設計 §5.5）
	 */
	function submit(budget) {
		renderLoading();
		var payload;
		if (budget && lastReq) {
			// 予算チップ: 条件は直前のまま、予算だけ変える。
			// answers から組み直すと、「戻る」で結果を復元したとき（answers は空）に条件が消える
			payload = JSON.parse(JSON.stringify(lastReq));
		} else {
			payload = {};
			QUESTIONS.forEach(function (q, i) { payload[q.key] = answers[i]; });
			// 出発地はホテル・現在地の座標で決まる（start の設問は出していない）
			if (hotelId) { payload.hotel = parseInt(hotelId, 10); }
			if (origin) { payload.lat = origin.lat; payload.lng = origin.lng; }
		}
		delete payload.budget;
		if (budget) { payload.budget = budget; }
		lastReq = payload;

		fetch(endpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload)
		})
			.then(function (res) {
				return res.json().then(function (json) { return { ok: res.ok, json: json }; });
			})
			.then(function (r) {
				if (!r.ok) {
					renderError(r.json && r.json.message);
					return;
				}
				// 送った条件も一緒に残す。「戻る」で復元した結果から予算チップを押したときに使う
				r.json.request = payload;
				try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(r.json)); } catch (e) { /* 容量超過等では無視 */ }
				renderResult(r.json);
			})
			.catch(function () {
				renderError(t('netFailed', '通信に失敗しました。時間をおいてお試しください。'));
			});
	}

	// 初期表示: 「戻る/進む」で来た時だけ結果を復元する。
	// リロードや通常アクセスでは保存を捨てて1問目から
	// （＝スポット閲覧から戻った時は残り、F5では消える、という直感に合わせる）
	var navType = '';
	try {
		var navEntries = performance.getEntriesByType('navigation');
		navType = (navEntries && navEntries[0]) ? navEntries[0].type : '';
	} catch (e) { /* 未対応ブラウザは通常扱い */ }

	var saved = null;
	if (navType === 'back_forward') {
		try { saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { /* 壊れた保存値は無視 */ }
	} else {
		try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) { /* 無視 */ }
	}

	if (saved && saved.spots && saved.spots.length) {
		lastReq = saved.request || null;
		renderResult(saved);
	} else {
		renderQuestion();
	}
}

	// 他のスクリプトからも起動できるように公開しておく
	window.epQuizMount = mount;

	// トップページ: 5問（従来どおり）
	var autoEl = document.getElementById('epQuiz');
	if (autoEl) {
		mount(autoEl, {});
	}

	// ホテルから探すページ: そのホテルを出発地にして4問。
	// app.js からではなくここで起動する（app.js のほうが先に読み込まれるため）
	var hotelEl = document.getElementById('epHotelQuiz');
	if (hotelEl) {
		mount(hotelEl, { hotel: hotelEl.getAttribute('data-hotel') });
	}
})();
