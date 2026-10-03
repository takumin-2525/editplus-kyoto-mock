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
 *   4. 共有されたコース（/plan/<合言葉>/）: #epPlan の data-plan に入っているコースを
 *      そのまま描く（設問は出さない）。結果の組みを2つ持たないため、同じ renderResult を使う
 *
 * 結果には「このコースを残す」（共有・LINE・リンクをコピー・PDFで保存）が付く。
 * コースの保存とURLの発行はサーバー側（plugins/editplus-ai/plan-share.php）。
 *
 * 結果の画面は「何に乗って、どこを歩くか」を出す。使うのはサーバーが決めた値だけ（距離・時間・手段は機械が決める）:
 *   区間ごと … leg_mode（walk / transit / car）・leg_url（ひとつ前の場所からの行き方）・station（最寄り駅）・zone（歩いて回れるひとかたまり）
 *              wait_min（開店を待つ分数。15分以上のときだけ「開くまで約N分」と出す）
 *   コース全体 … ride_legs / walk_legs / travel_min（乗る区間・歩く区間の数、移動の合計）・map_kind（全体のルートを開けるか）
 * **これらが付く前に作られたコースも描けること。**共有されたコースは180日残り、診断のキャッシュにも古い形が残る。
 * 値が無いときは、無いなりに今までどおり描く（区切りもリンクも足さない）。訳はすべてここ（画面）でやる
 * ―― 共有されたコースは言語を持たないので、サーバーは言語に依らないコードで返す。
 *
 * 送る条件には設問の版（qv）を付ける。回答は番号で送るので、選択肢を途中に足すと、
 * 古い画面の番号が別の条件として読まれる。版を付けておけば、サーバーが古い番号を読み替えられる。
 */
(function () {
	'use strict';

	// 文言は functions.php の wp_localize_script（epQuizI18n）から来る。
	// 未定義でも動くよう、日本語をフォールバックとして持たせている
	var T = window.epQuizI18n || {};
	var t = function (key, fallback) { return T[key] || fallback; };
	var fmt = function (str, value) { return String(str).replace(/%[ds]/, value); };
	// 数を2つ入れる文言（「電車・バス%1$d回＋徒歩%2$d区間」）。語順は言語で変わるので、番号つきで受ける
	var fmt2 = function (str, a, b) { return String(str).replace('%1$d', a).replace('%2$d', b); };

	// 移動の手段。サーバーは言語に依らないコード（walk / transit / car）で返し、ここで訳す。
	// 共有されたコースは言語を持たずに180日残るので、サーバー側では訳せない。
	// label＝区間の行と要約行に出す名前、link＝カードの下の「行き方」のリンク
	var MODES = {
		walk:    { label: ['legWalk', '徒歩'],          link: ['dirWalk', '道順を見る'] },
		transit: { label: ['legTransit', '電車・バス'],   link: ['dirTransit', '乗換案内を見る'] },
		car:     { label: ['legCar', 'タクシー・車'],     link: ['dirCar', '車のルートを見る'] }
	};
	// コードが付く前に作られたコース（共有済み・キャッシュ）は、手段を日本語の名前でしか持っていない。
	// サーバーが書いていた3つの名前をコードに読み替えて、新しいコースと同じ道を通す
	var LEGACY_MODES = { '徒歩': 'walk', '電車・バス': 'transit', 'タクシー・車': 'car' };
	// 表は「自分で書いたキー」だけで引く。素の obj[key] は、どのオブジェクトにも元からある名前
	// （constructor・toString など）でも値を返す。それを手段のコードとして通すと、その先で結果の画面ごと落ちる
	var own = function (table, key) {
		return (typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key)) ? table[key] : null;
	};
	var modeCode = function (code, legacyLabel) {
		if (own(MODES, code)) { return code; }
		return own(LEGACY_MODES, legacyLabel) || '';
	};
	var modeLabel = function (code) { return t(MODES[code].label[0], MODES[code].label[1]); };

	// サーバーのエラー文は日本語なので、そのまま出さずに合図（code）で訳を選ぶ。
	// ここに無い合図（ホテルの座標が未設定、など運用側の不備）のときだけ、サーバーの文を出す
	var ERRORS = {
		no_candidates:     ['errNoCandidates', 'この条件に合うスポットが見つかりませんでした。時間や移動の手段を変えてお試しください。'],
		walk_out_of_reach: ['errWalkOutOfReach', '歩いて行ける範囲に、この時間帯にご案内できる場所が見つかりませんでした。移動の手段を「電車・バス」か「タクシー・車」に変えてお試しください。'],
		rate_limited:      ['errRateLimited', '混み合っています。少し待ってからお試しください。'],
		invalid_answer:    ['errInvalidAnswer', '回答を読み取れませんでした。お手数ですが、最初からやり直してください。'],
		geo_out_of_region: ['errGeoOutOfRegion', '現在地が対象エリアから離れているため、コースを作れません。'],
		geo_invalid:       ['errGeoInvalid', '位置情報を読み取れませんでした。'],
		empty_plan:        ['errEmptyPlan', 'コースを組み立てられませんでした。時間をおいて、もう一度お試しください。']
	};
	var errorText = function (json) {
		var known = json && own(ERRORS, json.code);
		return known ? t(known[0], known[1]) : ((json && json.message) || '');
	};

	// リンク先に使ってよいのは http(s) だけ。コースの中身はサーバーが組んだものだが、
	// href にそのまま入れるので、ここでも形を確かめる（javascript: などを通さない）。
	// 地図・行き方だけでなく、スポットのページ（s.url）と診断の入口（makeUrl）も同じ扱いにする
	var httpUrl = function (url) { return /^https?:\/\//i.test(String(url || '')) ? String(url) : ''; };

	// コース名・紹介文・店名・理由文は、どの言語のページでも日本語で返る（中身は訳さない設計）。
	// 外国語のページは html の lang が en-US などなので、そのままだと文節で折る指定（style.css の :lang(ja)）が掛からず、
	// 「定番名／所巡り」「コー／ス」と語の途中で折れる。日本語の中身にだけ lang="ja" を付ける。
	// 日本語のページでは何も足さない（html がすでに ja。見た目もHTMLも変えない）。
	// 仮名・漢字を含まない名前（「CAFE&GALLERY WAKU」）には付けない ―― 読み上げが英語の店名を日本語として読んでしまう
	var PAGE_JA = /^ja/i.test(document.documentElement.lang || '');
	var jaAttr = function (text) {
		return (!PAGE_JA && /[\u3040-\u30ff\u3400-\u9fff]/.test(String(text || ''))) ? ' lang="ja"' : '';
	};

	/**
	 * 出発地の名前を、いまの言語で返す（出せないときは空）。
	 *
	 * サーバーが返す名前は日本語。地域プロファイルの出発地なら、名前（日本語）か番号で訳を引く。
	 * 先に名前で引くのは、共有されたコースが残っているあいだに出発地の並びが変わっても、別の場所の名前を出さないため。
	 * 「おまかせ」は場所の名前ではないので出さない（「おまかせ発」は何も伝えていない）。
	 *
	 * @return {{text: string, raw: boolean}} raw は「訳が無く、サーバーの名前（日本語）をそのまま出している」の印。
	 *                                        外国語のページでは、この名前にだけ lang="ja" を付ける。
	 */
	var startName = function (plan) {
		var named = function (text, raw) { return { text: text || '', raw: !!raw }; };
		// 現在地の起点名はサーバが日本語で返すので、ここで訳す
		if (plan.start_kind === 'geo') { return named(t('hereLabel', '現在地')); }
		var list = T.startLabels || [];
		var byName = null;
		list.forEach(function (p) { if (p && p.ja && p.ja === plan.start_label) { byName = p; } });
		if (byName && !byName.loose) { return named(byName.label || byName.ja); }
		var byIndex = (typeof plan.start_index === 'number') ? list[plan.start_index] : null;
		if (byIndex && !byIndex.loose) { return named(byIndex.label || byIndex.ja); }
		if (byName) { return named(''); } // 名前が「おまかせ」で、番号からも場所が分からない
		// ホテルの名前など。訳は無いので、そのまま出す
		return named(plan.start_label, true);
	};

	/**
	 * 開店を待つ分数を、画面に出す数にして返す（出さないときは 0）。
	 *
	 * 着く時刻（arrive）には待ちが入っている。移動の分数だけ見ると、前の場所を出た時刻と合わない
	 * （10:53 に出て徒歩7分なのに、着くのは 11:30）。その空白を一言で断るための値。
	 * 出すのは15分以上だけ ―― 数分の待ちまで書くと、どのカードにも注記が付いて読まれなくなる。
	 * 「約」と書くので5分刻みに丸める（「約37分」は、持っていない精度を主張している）。
	 * 値を返さない古いコース（共有済み・キャッシュ）と、数として読めない値では何も出さない。
	 */
	var waitMinutes = function (value) {
		var n = (typeof value === 'number' || typeof value === 'string') ? parseInt(value, 10) : NaN;
		return n >= 15 ? Math.round(n / 5) * 5 : 0;
	};

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

	// 設問の版。**並びと一緒にサーバーから来る値をそのまま送り返す**（ここで数字を決めない）。
	// time に「午後から半日」を途中へ足したとき、古い画面（お客さん向けのモックなど）の「夜だけ」(2) が
	// 「一日」として読まれた。版を付けて送れば、サーバーは版の無いリクエストを古い並びとして読み替えられる。
	// 版を知らない古いサーバーに送っても害は無い（REST は知らない引数を読まない）
	var QUESTIONS_V = parseInt(T.qv, 10) || 0;

	// 文言が届かなかったときの最小限のフォールバック。
	// **地域で変わる設問（出発地）はあえて持たない。**京都の選択肢を焼き込むと、
	// コピーして作ったサイトで「嵐山から」が出たまま誰も気づかない。
	// 訊かなければサーバーが「おまかせ」で補完するので、コースは出る
	if (!ALL_QUESTIONS.length) {
		// 下の並びは版2（time が4択）。並びを変えたら、この数字も一緒に変える
		QUESTIONS_V = 2;
		ALL_QUESTIONS = [
			{ key: 'companion', title: 'どなたと巡りますか？', options: ['ひとり旅', 'ふたりで', '友人・グループと', '子ども連れで'] },
			{ key: 'mood', title: 'どんな時間を過ごしたいですか？', options: ['静かに、ゆっくり', '食べ歩きたい', '歴史と文化にふれる', '絶景を見たい', '定番の名所をめぐる'] },
			{ key: 'time', title: 'いつ巡りますか？', options: ['午前から半日（10時〜14時ごろ）', '午後から半日（13時半〜17時半ごろ）', '一日（9時半〜17時ごろ）', '夜だけ（18時〜21時ごろ）'] },
			{ key: 'transport', title: '移動の手段は？', options: ['徒歩でゆっくり', '電車・バス', 'タクシー・車'] }
		];
	}

/**
 * 診断UIを指定要素にマウントする。
 *
 * @param {HTMLElement} el      描画先。data-endpoint に REST の URL を持つこと。
 * @param {Object}      options { hotel: ホテルID } を渡すと、そのホテルが出発地になる。
 *                              { origin: { lat, lng } } を渡すと、その座標（現在地）が出発地になる。
 *                              { plan: コース, makeUrl: 診断のURL } を渡すと、設問を出さずにそのコースを描く
 *                              （共有されたコースのページ）。
 */
function mount(el, options) {
	options = options || {};
	var endpoint = el.getAttribute('data-endpoint');
	// 共有されたコースを見ているとき。設問・やり直し・予算の調整は出さない（条件を持っていないので組み直せない）
	var shared = options.plan || null;
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

	// XSS対策: 動的な文字列は必ずこれを通してHTMLに入れる。
	// 属性の値（href・aria-label）にも入れるので、引用符も逃がす。textContent → innerHTML が逃がすのは < > & だけで、
	// 店名に " が1つあるだけで属性がそこで切れ、残りが別の属性（onmouseover など）として読まれてしまう
	function esc(s) {
		var d = document.createElement('div');
		d.textContent = String(s == null ? '' : s);
		return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	}

	/**
	 * 店名をHTMLにする（エスケープ込み）。
	 *
	 * 空白の無い英字だけの名前（「WAKASA&CO.STYLE」）は、ブラウザから見ると折る所の無い1語になる。
	 * 幅に入らないときは CSS（.rs-step の overflow-wrap:anywhere）が途中で折るが、任せきりだと
	 * 「WAKASA&CO.STY／LE」と語の中で切れる。「&」「.」「/」の後ろに「ここなら折ってよい」の印（wbr）を置いておく。
	 * 1行に入るあいだは何も変わらない。空白や和文を含む名前には手を出さない
	 * （もともと折る所があり、印を足すと行の長さを揃える処理が別の所で折り直す）。
	 */
	function nameHtml(title) {
		var text = String(title == null ? '' : title);
		if (!/^[\x21-\x7e]+$/.test(text)) { return esc(text); }
		return text.split(/([&.\/])/).map(function (part, i, parts) {
			// 記号の直後に英数字が続く所だけ（末尾の「.」や「...」の間には置かない）
			var hint = (i % 2 === 1 && /^[A-Za-z0-9]/.test(parts[i + 1] || '')) ? '<wbr>' : '';
			return esc(part) + hint;
		}).join('');
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
				// loading="lazy" は付けない。画面の外でまだ読み込まれていない写真が、PDF・印刷で抜ける（多くても6枚）
				ph.innerHTML = '<div class="imgwrap"><img src="' + esc(src) + '" alt=""></div>';
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

	/**
	 * このコースのURL。サーバーに聞かずに、合言葉から組む。
	 *
	 * サーバーの返事を待ってから共有・コピーすると、iPhone（Safari）が断る
	 * ―― 共有シートもクリップボードも「押した、その瞬間」にしか開けない。
	 * だからURLは先に分かるようにしておき、残す処理（persist）は裏で走らせる。
	 */
	function planUrl(data) {
		if (data.share_url) { return data.share_url; }
		return (T.planBase && data.share_token) ? T.planBase + data.share_token + '/' : '';
	}

	/**
	 * コースをサーバーに残してもらう（1回だけ）。
	 *
	 * 送るのは合言葉だけ（コースの中身は送らない）。中身を端末から送れる作りにすると、
	 * 店名や説明を書き換えたコースを、このサイトのURLで配れてしまう。
	 * 届かなくても、作ってから24時間以内なら、リンクを開いた時点でサーバーが残す（plan-share.php）。
	 */
	function persist(data) {
		if (data.share_url) { return Promise.resolve(data.share_url); }
		if (data._saving) { return data._saving; }
		var url = endpoint.replace('editplus/v1/concierge', 'editplus/v1/plan');
		data._saving = fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			keepalive: true, // LINE を開いてページが裏に回っても、送信を最後まで行かせる
			body: JSON.stringify({ token: data.share_token, lang: T.lang || '' })
		}).then(function (res) {
			return res.json().then(function (json) { return { ok: res.ok, json: json }; });
		}).then(function (r) {
			if (!r.ok || !r.json || !r.json.url) {
				// サーバーの文言は日本語なので、そのまま出さずに合図（code）で訳を選ぶ
				throw new Error(r.json && r.json.code === 'plan_expired'
					? t('shareExpired', 'コースを作ってから時間が経ったため、リンクを作れません。もう一度コースを作ってください。')
					: t('shareFail', '共有用のリンクを作れませんでした。時間をおいてお試しください。'));
			}
			data.share_url = r.json.url;
			delete data._saving;
			// 「戻る」で復元したときに作り直さないよう、保存してある結果にも書いておく
			if (!shared) {
				try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) { /* 無視 */ }
			}
			return data.share_url;
		}).catch(function (err) {
			delete data._saving;
			throw err;
		});
		return data._saving;
	}

	/**
	 * 印刷・PDFではコースだけを出す。
	 *
	 * コースから body までの親に印を付け、style.css の @media print が「印の付いていない兄弟」を消す。
	 * コースを複製して別の場所に置く作りにしないのは、複製した写真が読み込み終わる前に印刷が始まると抜けるため。
	 */
	function preparePrint() {
		clearPrint();
		var res = el.querySelector('.q-res');
		if (!res) { return; }
		res.classList.add('ep-print-target');
		for (var node = el; node && node !== document.documentElement; node = node.parentNode) {
			node.classList.add('ep-print-path');
		}
		document.documentElement.classList.add('ep-print-plan');
	}
	function clearPrint() {
		document.documentElement.classList.remove('ep-print-plan');
		Array.prototype.forEach.call(document.querySelectorAll('.ep-print-path, .ep-print-target'), function (node) {
			node.classList.remove('ep-print-path', 'ep-print-target');
		});
	}
	window.addEventListener('afterprint', clearPrint);
	// 共有されたコースのページは、ブラウザのメニューから印刷してもコースだけにする（このページの中身はコースだけ）。
	// 診断のあるトップページなどでは、ボタンを押したときだけ
	if (shared) { window.addEventListener('beforeprint', preparePrint); }

	/** 「このコースを残す」のボタンに動きを付ける。 */
	function bindKeep(data) {
		var box = el.querySelector('.r-keep');
		if (!box) { return; }
		var msg = box.querySelector('.r-keep-msg');
		var urlRow = box.querySelector('.r-keep-url');
		var urlField = urlRow.querySelector('input');
		var say = function (text) { msg.textContent = text || ''; };
		// URLは一度用意したら見える所に出しておく。コピーや共有が端末に断られても、手で写せる
		var showUrl = function (url) {
			urlField.value = url;
			urlRow.hidden = false;
			var printed = el.querySelector('.res-print-url');
			if (printed) { printed.textContent = url; }
		};
		if (data.share_url) { showUrl(data.share_url); }

		Array.prototype.forEach.call(box.querySelectorAll('.r-keep-btn'), function (btn) {
			btn.addEventListener('click', function () {
				var act = btn.getAttribute('data-act');
				if (act === 'print') {
					// 紙・PDFにもコースのURLを載せる（そこからコースに戻れる）。載せる以上、開けるように残しておく。
					// 返事は待たずに開く。待ってから開くと「このページが印刷しようとしています」と確認が出る端末がある
					var printUrl = planUrl(data);
					if (printUrl) {
						el.querySelector('.res-print-url').textContent = printUrl;
						persist(data).catch(function () { /* 残せなくても印刷は止めない */ });
					}
					preparePrint();
					window.print();
					return;
				}
				// URLは待たずに組めるので、押したその場で共有・コピーする。残す処理は裏で走らせる
				var url = planUrl(data);
				if (!url) {
					say(t('shareFail', '共有用のリンクを作れませんでした。時間をおいてお試しください。'));
					return;
				}
				showUrl(url);
				// 残せなかったときだけ、あとから知らせる（期限切れ＝作ってから24時間以上たったコース など）
				var failed = false;
				persist(data).then(showUrl).catch(function (err) {
					failed = true;
					urlRow.hidden = true;
					say((err && err.message) || t('shareFail', '共有用のリンクを作れませんでした。時間をおいてお試しください。'));
				});
				var tell = function (text) { if (!failed) { say(text); } };

				if (act === 'line') {
					window.open('https://line.me/R/share?text=' + encodeURIComponent(data.title + '\n' + url), '_blank', 'noopener');
					return;
				}
				if (act === 'share' && navigator.share) {
					navigator.share({ title: data.title, text: data.title, url: url }).catch(function () { /* 閉じただけ。何も言わない */ });
					return;
				}
				// リンクをコピー
				var done = function () { tell(t('copied', 'リンクをコピーしました。')); };
				var manual = function () {
					urlField.focus();
					urlField.select();
					try { if (document.execCommand('copy')) { done(); return; } } catch (e) { /* 下へ */ }
					tell(t('copyManual', '上のURLを長押し（または選択）してコピーしてください。'));
				};
				if (navigator.clipboard && navigator.clipboard.writeText) {
					navigator.clipboard.writeText(url).then(done).catch(manual);
				} else {
					manual();
				}
			});
		});
	}

	function renderResult(data) {
		// 'cache' で返ってくる場合もあるので「ai以外は編集部セレクト」で判定する。
		// source === 'fallback' だけを見ると、キャッシュ済みのフォールバックに
		// 「Your Route」のバッジが付き、本文の「編集部の定番スポットで組みました」と矛盾する
		var badge = data.source === 'ai' ? t('badgeRoute', 'コンシェルジュの提案') : t('badgePick', '編集部のおすすめ');
		var plan = data.plan || {};
		// 数字まわりの約物は言語で変える。日本語は「徒歩8分」「4スポット」と詰め、区切りは「・」、時間の幅は「〜」。
		// 間に半角の空白や「–」を入れると、欧文の作法で機械が組んだ表記に見える
		var ja = PAGE_JA;
		var gap = ja ? '' : ' ';
		var dot = ja ? '・' : ' · ';
		var dotEnd = ja ? '・' : ' ·'; // 項目の末尾に付けるとき（後ろの空白は項目の間に置く）
		var range = ja ? '〜' : '–';

		// トップページの棚と同じ組み：時刻を上に置いた、トップと同じスポットのカード（.spot）の列。
		// 写真は後から載せる（loadPhotos）。載るまでは、トップと同じ「名前の面」で受ける
		var ids = [];
		var spots = data.spots || [];
		var start = startName(plan);
		var origin = start.text;
		// 「%sから」「%s発」に出発地の名前を入れる。訳の無い名前（ホテル名）は外国語のページでも日本語のまま出るので、
		// 文（From …）ではなく名前だけを lang="ja" で包む。置き換えを関数で渡すのは、名前に「$&」などがあっても
		// そのまま出すため（文字列で渡すと、置き換えの記号として読まれる）
		var withOrigin = function (template) {
			var name = esc(origin);
			var attr = start.raw ? jaAttr(origin) : '';
			if (attr) { name = '<span' + attr + '>' + name + '</span>'; }
			return esc(template).replace(/%[ds]/, function () { return name; });
		};
		var prevZone = null;
		var steps = spots.map(function (s, i) {
			if (s.id) { ids.push(parseInt(s.id, 10)); }
			// ひとつ前の場所（1件目は出発地）からの移動。1件目も必ず出す。
			// 手段は区間ごとにサーバーが決めている（電車を選んでいても、近い区間は徒歩）
			var mode = modeCode(s.leg_mode, s.travel_by);
			var by = mode ? modeLabel(mode) : (s.travel_by || t('travel', '移動'));
			// 1件目は「どこから」を添える。添えないと、出発地からの移動なのか分からない。
			// 長い名前（ホテル名）や欧文では1行に入らないので、「◯◯から」と「徒歩8分・451m」の間で折れるように分けておく
			var from = (i === 0 && origin)
				? '<span class="rs-from">' + withOrigin(t('legFrom', '%sから')) + '</span>'
				: '';
			// 開店を待つ時間は、移動のすぐ下に置く（「歩いて7分、そこから開くまで約30分」の順に読める）。
			// 移動の無いカード（同じ建物の次の店）でも、待ちだけは出す
			var wait = waitMinutes(s.wait_min);
			var waitNote = wait
				? '<span class="rs-wait">' + esc(fmt(t('waitOpen', '開くまで約%d分'), wait)) + '</span>'
				: '';
			var leg = '';
			if (s.travel_min) {
				leg = '<span class="rs-leg' + (mode && mode !== 'walk' ? ' rs-leg--ride' : '') + '">' + from
					+ '<span class="rs-by">' + esc(by) + gap + esc(fmt(t('minutes', '%d分'), s.travel_min))
					+ (s.distance_m ? dot + esc(distLabel(s.distance_m)) : '') + '</span>' + waitNote + '</span>';
			} else if (waitNote) {
				leg = '<span class="rs-leg rs-leg--wait">' + waitNote + '</span>';
			}
			// 歩いて回れるひとかたまり（エリア）が替わる所。ここで乗り物に乗る、という境目なので、区切りを入れる。
			// エリアの番号を持たない古いコースには何も足さない
			var zone = (typeof s.zone === 'number') ? s.zone : null;
			var newZone = i > 0 && zone !== null && prevZone !== null && zone !== prevZone;
			prevZone = zone;
			var zoneMark = newZone ? '<span class="rs-zone">' + esc(t('nextZone', '次のエリアへ')) + '</span>' : '';
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
			// 最寄りの駅・バス停も誌面の原文。どの駅で降りるかの手掛かりになる
			if (s.station) facts.push(esc(t('stationLabel', '最寄り駅')) + ' ' + esc(s.station));

			// カードの下のリンクは1つだけ。ひとつ前の場所からここまでの行き方（乗る区間は乗換案内、歩く区間は道順）を開く。
			// 行き方の画面には行き先のピンも出るので、「地図で見る」（ピンだけ）とは並べない
			// （3列のカードは中が190pxしかなく、2つ並べると折れる）。行き方のURLを持たない古いコースは、今までどおり地図
			var acts = [];
			var legUrl = mode ? httpUrl(s.leg_url) : '';
			var pinUrl = httpUrl(s.map_url);
			if (legUrl) {
				var linkText = t(MODES[mode].link[0], MODES[mode].link[1]);
				// 同じ文言のリンクがカードの数だけ並ぶので、読み上げでは行き先の名前を添える
				acts.push('<a href="' + esc(legUrl) + '" target="_blank" rel="noopener" aria-label="' + esc(linkText + ' — ' + s.title) + '">' + esc(linkText) + '</a>');
			} else if (pinUrl) {
				acts.push('<a href="' + esc(pinUrl) + '" target="_blank" rel="noopener">' + esc(t('viewMap', '地図で見る')) + '</a>');
			}
			if (s.stay_min) acts.push('<span>' + esc(fmt(t('stayMin', '滞在%d分'), s.stay_min)) + '</span>');
			// スポットのページへのリンク。http(s) でなければ href を付けない（名前は出すが、押せない）
			var spotUrl = httpUrl(s.url);
			var spotHref = spotUrl ? ' href="' + esc(spotUrl) + '"' : '';
			var nameLang = jaAttr(s.title);

			return '<li class="rs-step' + (newZone ? ' rs-step--zone' : '') + '" style="animation-delay:' + (i * 90) + 'ms">'
				+ '<p class="rs-when">' + zoneMark + leg + when + '</p>'
				+ '<article class="spot spot--text" data-spot="' + (s.id ? parseInt(s.id, 10) : '') + '">'
				+ '<a class="rs-ph"' + spotHref + '><div class="noimg"><span class="noimg-name"' + nameLang + '>' + nameHtml(s.title) + '</span></div></a>'
				+ '<div class="in">'
				+ (cat ? '<span class="cat">' + cat + '</span>' : '')
				// 写真が無いあいだは上の面が見出しを兼ねる（トップのカードと同じ扱い）。読み上げ用に見出しは残すが、
				// 見えないリンクにタブが止まらないようにする（フォーカスが画面から消える）
				+ '<h4 class="screen-reader-text"' + nameLang + '><a' + spotHref + ' tabindex="-1">' + nameHtml(s.title) + '</a></h4>'
				+ '<p class="rs-reason"' + jaAttr(s.reason) + '>' + esc(s.reason) + '</p>'
				+ (facts.length ? '<p class="ts-facts">' + facts.join('<br>') + '</p>' : '')
				+ (acts.length ? '<div class="actions">' + acts.join('') + '</div>' : '')
				+ '</div></article></li>';
		}).join('');

		var stats = [];
		if (origin) stats.push('<span>' + withOrigin(t('fromLabel', '%s発')) + '</span>');
		// 交通は「選んだ答え」ではなく「コースの中身」を書く。電車・バスを選んでも、近い所だけで組めたコースは
		// 乗る区間が無い。そこに「電車・バス」と出すと、下の行程（徒歩ばかり）と食い違う
		var rides = (typeof plan.ride_legs === 'number') ? plan.ride_legs : null;
		if (rides !== null) {
			var walks = parseInt(plan.walk_legs, 10) || 0;
			var summary;
			if (rides > 0) {
				// 乗り物の名前は、選んだ手段ではなく実際に乗る区間から決める
				var rideMode = plan.transport === 'car' ? 'car' : 'transit';
				spots.some(function (s) {
					var m = modeCode(s.leg_mode, s.travel_by);
					if (m && m !== 'walk') { rideMode = m; return true; }
					return false;
				});
				var sumKey = rideMode === 'car' ? 'sumCar' : 'sumTransit';
				var rideName = MODES[rideMode].label[1]; // 文言が届かなかったとき用の日本語
				summary = walks > 0
					? fmt2(t(sumKey, rideName + '%1$d回＋徒歩%2$d区間'), rides, walks)
					: fmt(t(sumKey + 'Only', rideName + '%d回'), rides);
			} else {
				summary = t('sumWalk', '歩いて回れるコース');
			}
			stats.push('<span>' + esc(summary) + '</span>');
			if (plan.travel_min) stats.push('<span>' + esc(fmt(t('travelTotal', '移動は計%d分'), plan.travel_min)) + '</span>');
		} else if (plan.transport_label) {
			// 乗る区間の数を持たない古いコース。選んだ手段の名前を（訳せるものは訳して）そのまま出す
			var chosen = modeCode(plan.transport, plan.transport_label);
			stats.push('<span>' + esc(chosen ? modeLabel(chosen) : plan.transport_label) + '</span>');
		}
		if (plan.begin) stats.push('<span>' + esc(plan.begin) + range + esc(plan.end) + '</span>');
		if (plan.total_min) stats.push('<span>' + esc(roughHours(plan.total_min)) + '</span>');
		stats.push('<span>' + esc(fmt(t('spotCount', '%dスポット'), spots.length)) + '</span>');

		// 下のボタン。徒歩・車は全体をひと続きのルートで開く。
		// 電車・バスのコース（map_kind が 'legs'）は、ひと続きでは開けない
		// ―― Google マップは経由地つきの乗換検索ができず、押しても「計算できませんでした」に着く。
		// 代わりに1区間目だけを開き、続きは各カードのリンクに任せる
		var route = '';
		var routeHint = '';
		if (plan.map_kind === 'legs') {
			var first = spots[0] || {};
			var firstMode = modeCode(first.leg_mode, first.travel_by);
			var firstUrl = firstMode ? httpUrl(first.leg_url) : '';
			if (firstUrl) {
				var firstText = firstMode === 'transit' ? t('openFirstTransit', '最初の行き先までの乗換案内を開く')
					: (firstMode === 'car' ? t('dirCar', '車のルートを見る') : t('openFirstWalk', '最初の行き先までの道順を開く'));
				route = '<a class="r-map" href="' + esc(firstUrl) + '" target="_blank" rel="noopener">' + esc(firstText) + '</a>';
			}
			// 乗換案内はカードごとに開く、と一言添える（全体のルートを探す人が迷わないように）
			var hasTransit = spots.some(function (s) { return modeCode(s.leg_mode, s.travel_by) === 'transit' && httpUrl(s.leg_url); });
			if (hasTransit) {
				routeHint = '<p class="res-note res-note--hint">' + esc(t('legsHint', '電車・バスに乗る区間は、各カードの「乗換案内を見る」から調べられます。')) + '</p>';
			}
		} else if (httpUrl(plan.map_url)) {
			route = '<a class="r-map" href="' + esc(plan.map_url) + '" target="_blank" rel="noopener">' + esc(t('openRoute', 'Googleマップでルートを開く')) + '</a>';
		}

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
		var relaxed = Array.isArray(data.relaxed) ? data.relaxed : [];
		if (relaxed.indexOf('budget') !== -1) {
			chips += '<span class="b-note">' + esc(t('budgetApprox', '※ この条件では候補が少なく、予算は目安になっています')) + '</span>';
		}
		if (chips) { chips = '<div class="r-budget">' + chips + '</div>'; }
		// 共有されたコースには条件が無いので、予算だけ変えて組み直すことはできない
		if (shared) { chips = ''; }
		// 満たせなかった条件のうち、当日の予定に響くもの（食事が入っていない／着く時刻が営業時間の外かもしれない）。
		// 予算と違ってコースそのものの話なので、共有されたコースと紙・PDFにも出す
		var flags = [];
		if (relaxed.indexOf('eat') !== -1) { flags.push(t('noMealNote', '※ この条件では合う食事処が見つからず、このコースに食事は入っていません')); }
		if (relaxed.indexOf('hours') !== -1) { flags.push(t('hoursNote', '※ 営業時間の合う店が少なく、着く時刻が営業時間の外になる場所があるかもしれません')); }
		var flagNote = flags.length ? '<p class="res-note res-note--flag">' + flags.map(esc).join('<br>') + '</p>' : '';

		// このコースを残す。URLの発行には合言葉（share_token）が要る。
		// 古い結果（合言葉が付く前に「戻る」で復元したもの）には共有を出さず、PDFだけ出す
		var canShare = !!planUrl(data);
		var keepBtns = '';
		if (canShare) {
			// navigator.share は端末の共有シート（LINE・メモ・AirDrop など）を開く。無い環境（多くのPC）では出さない
			if (navigator.share) {
				keepBtns += '<button type="button" class="r-keep-btn" data-act="share">' + esc(t('share', '共有する')) + '</button>';
			}
			keepBtns += '<button type="button" class="r-keep-btn" data-act="line">' + esc(t('shareLine', 'LINEで送る')) + '</button>'
				+ '<button type="button" class="r-keep-btn" data-act="copy">' + esc(t('copyLink', 'リンクをコピー')) + '</button>';
		}
		keepBtns += '<button type="button" class="r-keep-btn" data-act="print">' + esc(t('savePdf', 'PDFで保存・印刷')) + '</button>';
		var keep = '<div class="r-keep">'
			+ '<p class="r-keep-ttl">' + esc(t('keepTitle', 'このコースを残す')) + '</p>'
			+ '<div class="r-keep-btns">' + keepBtns + '</div>'
			// 現在地から作ったコースは、ルートのURLに出発点（約100mに丸めた座標）が入っている。
			// 共有すると相手にも分かるので、押す前に書いておく（黙って渡さない）
			+ (canShare && !shared && plan.start_kind === 'geo'
				? '<p class="r-keep-note">' + esc(t('shareGeoNote', 'このコースは現在地を出発点にしています。共有すると、リンクを開いた人にも出発点のおおよその場所が分かります。')) + '</p>'
				: '')
			+ '<p class="r-keep-url" hidden><input type="text" readonly aria-label="' + esc(t('planUrl', 'このコースのURL')) + '">'
			+ (T.keepNote ? '<small>' + esc(T.keepNote) + '</small>' : '') + '</p>'
			+ '<p class="r-keep-msg" role="status"></p>'
			+ '</div>';

		// 共有されたコースでは「もう一度診断する」ではなく、自分のコースを作る入口にする
		var again = shared
			? '<a class="r-reset" href="' + esc(httpUrl(options.makeUrl) || '/') + '">' + esc(t('makeOwn', '自分のコースを作る')) + '</a>'
			: '<button type="button" class="r-reset" id="qReset">' + esc(t('startOver', 'もう一度診断する')) + '</button>';

		el.classList.add('is-result');
		el.innerHTML = '<div class="q-res">'
			+ (T.siteName ? '<p class="res-print-site">' + esc(T.siteName) + '</p>' : '')
			+ '<div class="res-head">'
			+ '<div class="res-h"><h3 class="res-title"' + jaAttr(data.title) + '>' + esc(data.title) + '</h3>'
			+ again + '</div>'
			+ (data.description ? '<p class="res-desc"' + jaAttr(data.description) + '>' + esc(data.description) + '</p>' : '')
			+ '<div class="res-stats">' + stats.join('') + '<span class="res-badge">' + badge + '</span></div>'
			+ '</div>'
			+ '<ol class="rs-grid">' + steps + '</ol>'
			+ '<div class="r-foot">' + route + chips + '</div>'
			+ routeHint + flagNote
			+ '<p class="res-note">' + esc(t('timeNote', '時刻は移動時間からの目安です。営業時間・定休日は各スポットのページと公式情報でご確認ください。')) + '</p>'
			+ keep
			// 紙・PDFからコースに戻れるように（中身は印刷のときに入れる。空のあいだは出ない）
			+ '<p class="res-print-url">' + esc(data.share_url || '') + '</p>'
			+ '</div>';
		loadPhotos(ids);
		bindKeep(data);

		var resetBtn = el.querySelector('#qReset');
		if (resetBtn) { resetBtn.addEventListener('click', reset); }
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
			// いま出している設問の版を付ける。予算チップ（上）は直前の条件を写すので、版もそのまま引き継がれる。
			// 「戻る」で復元した古い条件には版が無い ―― 付け足さない。その番号は古い並びで選ばれたものなので、
			// 版が無いまま送って、サーバーに古い並びとして読んでもらうのが正しい
			if (QUESTIONS_V) { payload.qv = QUESTIONS_V; }
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
					renderError(errorText(r.json));
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

	if (shared && shared.spots && shared.spots.length) {
		// 共有されたコース。URLはこのページそのもの
		if (options.shareUrl) { shared.share_url = options.shareUrl; }
		renderResult(shared);
	} else if (saved && saved.spots && saved.spots.length) {
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

	// 共有されたコース（/plan/<合言葉>/）: サーバーが data-plan に入れたコースをそのまま描く
	var planEl = document.getElementById('epPlan');
	if (planEl) {
		var planData = null;
		try { planData = JSON.parse(planEl.getAttribute('data-plan') || 'null'); } catch (e) { /* 壊れていたら何も描かない */ }
		if (planData) {
			mount(planEl, {
				plan: planData,
				makeUrl: planEl.getAttribute('data-make-url'),
				shareUrl: planEl.getAttribute('data-share-url') || window.location.href.split('#')[0]
			});
		}
	}

	// ホテルから探すページ: そのホテルを出発地にして4問。
	// app.js からではなくここで起動する（app.js のほうが先に読み込まれるため）
	var hotelEl = document.getElementById('epHotelQuiz');
	if (hotelEl) {
		mount(hotelEl, { hotel: hotelEl.getAttribute('data-hotel') });
	}
})();
