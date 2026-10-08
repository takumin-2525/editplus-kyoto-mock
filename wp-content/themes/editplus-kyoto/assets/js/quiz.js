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
 *   3. ホテル／いまいる場所から（/nearby/）: nearby.js が出発点を決めてから
 *      window.epQuizMount(el, { origin: { lat, lng } }) か { hotel: <ID> }（提携していない宿のIDも）か
 *      { station: <駅のキー> } で起動する（4問）
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
 * 値が無いときは、無いなりに今までどおり描く（区切りもリンクも足さない）。手段・要約・ラベルの訳はここ（画面）でやる。
 *
 * 送る条件には設問の版（qv）と、ページの言語（lang）を付ける。
 *   qv   … 回答は番号で送るので、選択肢を途中に足すと古い画面の番号が別の条件として読まれる。版があればサーバーが読み替えられる
 *   lang … サーバーは店名・エリア・ジャンル・営業時間・AIの理由文・コース名・紹介文を、この言語で返す（2026-10-03〜）。
 *          返事の lang がその言語。共有されたコースは作った言語で残る（/en/plan/<合言葉>/）。
 *          lang を持たない古いコース（それ以前のもの）は、中身が日本語
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

	// エリアの境目（画面の「次のエリアへ」と罫、紙の余白）を、このカードの上に出すか。
	// サーバーの zone は候補を束ねたときの番号で、番号が替わっても、歩いてすぐの隣のことがある
	// （実測 2026-10-04: 天龍寺 → eX cafe は徒歩6分・340m、カードのエリアはどちらも「嵐山」なのに「次のエリアへ」と出た）。
	// 境目は「ここで乗り物に乗って、別のエリアへ移る」の合図なので、歩く区間と、カードのエリア名が前と同じ所には出さない。
	// エリアの番号を持たない古いコースには何も足さない。手段を持たないコースは、番号とエリア名だけで決める
	var zoneBreak = function (s, prev) {
		if (!s || !prev || typeof s.zone !== 'number' || typeof prev.zone !== 'number' || s.zone === prev.zone) { return false; }
		if (modeCode(s.leg_mode, s.travel_by) === 'walk') { return false; }
		return !(s.area && prev.area && String(s.area) === String(prev.area));
	};

	// 小さなアイコン（2026-10-03）。形の正は inc/icons.php で、functions.php が epIcons として渡す（ここに形を写さない）。
	// 届かなかったときは何も出さない ―― 意味は隣の文字が持っているので、文字だけで読める
	var ICONS = window.epIcons || {};
	var icon = function (name) { return own(ICONS, name) || ''; };
	// 区間の手段のアイコン。電車・バスの区間は、サーバーの見積もり（leg_kind: rail / bus）で電車かバスかを分ける。
	// leg_kind を持たない古いコース（共有済み・キャッシュ）は電車の形にする（「電車・バス」の汎用の印）
	var modeIcon = function (mode, kind) {
		if (mode === 'walk') { return icon('walk'); }
		if (mode === 'car') { return icon('car'); }
		if (mode === 'transit') { return icon(kind === 'bus' ? 'bus' : 'train'); }
		return '';
	};
	// アイコンと続く語を1つに結ぶ（折り返したときに、アイコンだけが行末に残らない）
	var withIcon = function (svg, html) { return svg ? '<span class="ep-nb">' + svg + html + '</span>' : html; };

	// サーバーのエラー文は日本語なので、そのまま出さずに合図（code）で訳を選ぶ。
	// ここに無い合図のときの扱いは、すぐ下の errorText
	var ERRORS = {
		no_candidates:     ['errNoCandidates', 'この条件に合うスポットが見つかりませんでした。時間や移動の手段を変えてお試しください。'],
		walk_out_of_reach: ['errWalkOutOfReach', '歩いて行ける範囲に、この時間帯にご案内できる場所が見つかりませんでした。移動の手段を「電車・バス」か「タクシー・車」に変えてお試しください。'],
		rate_limited:      ['errRateLimited', '混み合っています。少し待ってからお試しください。'],
		invalid_answer:    ['errInvalidAnswer', '回答を読み取れませんでした。お手数ですが、最初からやり直してください。'],
		geo_out_of_region: ['errGeoOutOfRegion', '現在地が対象エリアから離れているため、コースを作れません。'],
		geo_invalid:       ['errGeoInvalid', '位置情報を読み取れませんでした。'],
		empty_plan:        ['errEmptyPlan', 'コースを組み立てられませんでした。時間をおいて、もう一度お試しください。'],
		// 出発点にしたホテルが消えた・座標が無い（/nearby/?hotel= を古いリンクから開いたときなど）。サーバーの文は日本語なので訳を当てる
		hotel_not_found:   ['errHotelNotFound', 'ホテルが見つかりませんでした。ホテル名か最寄り駅で探してください。'],
		hotel_no_coords:   ['errHotelNoCoords', 'このホテルは位置情報がまだ登録されていないため、ここからは巡れません。ほかのホテルを選ぶか、下の探し方をお使いください。'],
		hotel_out_of_region: ['errHotelOutOfRegion', 'この宿は対象エリアの外にあるため、コースを作れません。ほかの宿か駅を選んでください。'],
		station_not_found: ['errStationNotFound', '駅が見つかりませんでした。駅の名前で探し直してください。']
	};
	// サーバーの文から、文字だけを取り出す。WordPress が致命的エラーのときに返す文は HTML
	// （「<p>サイトに重大なエラーが発生しました。</p><p><a href="…">…こちらをご覧ください。</a></p>」）で、
	// そのまま出すとタグが文字として見える。リンクは押せなくなるので、リンクの文ごと外す。
	// 読み取りは DOMParser の別の文書でやる（画面の文書に入れないので、中の img や script は動かない）
	var plainText = function (html) {
		var s = String(html || '');
		if (s.indexOf('<') === -1 && s.indexOf('&') === -1) { return s.replace(/\s+/g, ' ').trim(); }
		try {
			var doc = new DOMParser().parseFromString(s, 'text/html');
			Array.prototype.forEach.call(doc.querySelectorAll('a, script, style'), function (n) { n.parentNode.removeChild(n); });
			return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
		} catch (e) {
			return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
		}
	};
	// 表に無い合図は2通りある: 運用側の不備（no_start_points＝出発地が未設定。サーバーの文に頼む先が書いてある）と、
	// WordPress 自身のエラー（致命的エラーの internal_server_error・rest_invalid_param など）。どちらも文は日本語なので、
	// **外国語の画面には出さず**、その言語の汎用の文にする（2026-10-04。/en/ の画面に
	// 「<p>サイトに重大なエラーが発生しました。</p>」とタグごと日本語が出た）。サーバーの文を出すのは日本語の画面だけで、タグは外す
	var errorText = function (json) {
		var known = json && own(ERRORS, json.code);
		if (known) { return t(known[0], known[1]); }
		var generic = t('errUnknown', 'うまくいきませんでした。時間をおいて、もう一度お試しください。');
		if (!/^ja/i.test(document.documentElement.lang || '')) { return generic; }
		return plainText(json && json.message) || generic;
	};

	// リンク先に使ってよいのは http(s) だけ。コースの中身はサーバーが組んだものだが、
	// href にそのまま入れるので、ここでも形を確かめる（javascript: などを通さない）。
	// 地図・行き方だけでなく、スポットのページ（s.url）と診断の入口（makeUrl）も同じ扱いにする
	var httpUrl = function (url) { return /^https?:\/\//i.test(String(url || '')) ? String(url) : ''; };

	// コース名・紹介文・店名・理由文は、2026-10-03 からページの言語で返る。それでも日本語のまま出るものがある
	// （訳の無い宿・ホテルの名前、数字の確かめに落ちて原文のまま出す営業時間、lang を持たない古い共有コースの中身）。
	// 外国語のページは html の lang が en-US などなので、そのままだと文節で折る指定（style.css の :lang(ja)）が掛からず、
	// 「定番名／所巡り」「コー／ス」と語の途中で折れる。日本語の中身にだけ lang="ja" を付ける。
	// 日本語のページでは何も足さない（html がすでに ja。見た目もHTMLも変えない）。
	// 仮名・漢字を含まない名前（「CAFE&GALLERY WAKU」）には付けない ―― 読み上げが英語の店名を日本語として読んでしまう。
	// 中国語のページでは、漢字だけの文は中国語として読む（仮名があるときだけ日本語）。漢字で判定したままだと、
	// 中国語の中身が返るようになったいま、中国語の文にまで lang="ja" が付いて日本語の字形で出てしまう。
	// 仮名から中黒（・）と長音（ー）は外す（中国語の「电车・巴士」にも出る記号）
	var PAGE_JA = /^ja/i.test(document.documentElement.lang || '');
	var PAGE_ZH = /^zh/i.test(document.documentElement.lang || '') || /^zh/.test(String(T.lang || ''));
	// 韓国語の時間の幅は「~」（スポットの営業時間・設問の選択肢「9시 반~17시경」と同じ記号。2026-10-04）
	var PAGE_KO = /^ko/i.test(document.documentElement.lang || '') || /^ko/.test(String(T.lang || ''));
	var jaAttr = function (text) {
		var s = String(text || '');
		if (PAGE_JA) { return ''; }
		if (/[\u3040-\u309f\u30a0-\u30fa\u30fd-\u30ff]/.test(s)) { return ' lang="ja"'; }
		return (!PAGE_ZH && /[\u3400-\u9fff]/.test(s)) ? ' lang="ja"' : '';
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
		// ホテル・宿・駅の名前など。サーバーが結果の言語での名前（start_name）を持たせていればそれ、無ければ日本語の名前のまま。
		// raw の印は「日本語かもしれない」の意味（外国語のページでは、仮名・漢字があれば lang="ja" を付ける）
		return named(plan.start_name || plan.start_label, true);
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
 * @param {Object}      options { hotel: ホテルID } を渡すと、そのホテルが出発地になる（提携していない宿のIDも受ける）。
 *                              { station: 駅のキー } を渡すと、その駅が出発地になる（/nearby/ で駅を選んだとき）。
 *                              { origin: { lat, lng } } を渡すと、その座標（現在地）が出発地になる。
 *                              { plan: コース, makeUrl: 診断のURL } を渡すと、設問を出さずにそのコースを描く
 *                              （共有されたコースのページ）。
 *                              restore（true / false）で、保存した結果を復元するかを呼び出し側が決められる。
 *                              省略時は「戻る/進む」でページを開いたときだけ復元する。/nearby/ は1枚のページの中で
 *                              出発点を何度も変える（「戻る」も同じページの中で起きる）ので、ページの開き方では決められない
 */
function mount(el, options) {
	options = options || {};
	var endpoint = el.getAttribute('data-endpoint');
	// 共有されたコースを見ているとき。設問・やり直し・予算の調整は出さない（条件を持っていないので組み直せない）
	var shared = options.plan || null;
	var hotelId = options.hotel ? String(options.hotel) : '';
	// 駅のキーは英小文字・数字・ハイフンだけ（サーバーの表のキー）。ほかの形は送らない
	var stationKey = (!hotelId && /^[a-z0-9-]{1,64}$/.test(String(options.station || ''))) ? String(options.station) : '';
	var origin = (!hotelId && !stationKey && options.origin) ? options.origin : null;

	// ホテル・駅・現在地起点のときは出発地が決まっているので、その設問だけ落とす。
	// key で送るので、設問を減らしてもサーバー側は既定値で補完してくれる
	var QUESTIONS = (hotelId || stationKey || origin)
		? ALL_QUESTIONS.filter(function (q) { return q.key !== 'start'; })
		: ALL_QUESTIONS.slice();

	var answers = QUESTIONS.map(function () { return null; });
	var step = 0;
	var busy = false;
	var advance = null;  // 選んでから次の設問へ進むまでのタイマー。「← 戻る」で取り消す
	var sending = false; // 送信中。予算チップの二度押しを止める（ボタンは disabled にしない ―― フォーカスが body に落ちる）
	var lastReq = null; // 直前に送った条件。予算チップはこれを予算だけ変えて送り直す

	// この起動の印。/nearby/ は同じ要素で出発点を変えるたびに起動し直す（innerHTML を空にしてから epQuizMount）。
	// 前の起動の送信が後から届くと、新しい出発点の設問を前の出発点のコースで上書きしていた（BUGS #21）。
	// 届いた返事は、印が今の起動のものと同じで、要素がまだ中身を持っているときだけ描く
	// （nearby.js の「出発点を選ぶ前に戻す」は起動し直さずに中身だけ空にする）
	var token = {};
	el._epQuizMount = token;
	function alive() { return el._epQuizMount === token && !!el.firstChild; }

	/*
	 * 描き直したあとの「見える位置」と「フォーカス」（2026-10-03）。
	 * 以前は quiz.js のどこにも scrollTo・focus が無かった。予算チップを押すと結果の高さが消えて
	 * 「おすすめの場所」より下が映り、結果が出てもコース名は画面の外（PC -981px、スマホ -4756px）に残った（BUGS #1）。
	 * フォーカスも押したボタンごと消えて body に落ち、読み上げは新しい設問も結果も読まなかった（#27）。
	 * 着地の高さは html の scroll-padding-top（固定ヘッダー＋16px。style.css）と同じ値を使う。アンカー・Tab と揃えるため
	 */
	// 文書の上端からの位置。getBoundingClientRect をそのまま使わないのは、結果が出るときに下から浮き上がる動き
	// （.q-res の fadeup の translateY）があり、描いた直後に測ると10pxずれるため。
	// el（動かない）の位置に、el の中での位置（offsetTop の和。transform を含まない）を足す
	function pageY(node) {
		var sum = function (n) { var y = 0; for (; n; n = n.offsetParent) { y += n.offsetTop; } return y; };
		return el.getBoundingClientRect().top + window.pageYOffset + (sum(node) - sum(el));
	}
	function landOffset() {
		var pad = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop);
		if (pad > 0) { return pad; }
		var hdr = document.querySelector('.site-header');
		return (hdr ? hdr.getBoundingClientRect().bottom : 0) + 16;
	}
	/**
	 * node が固定ヘッダーのすぐ下に来るよう動かす。
	 * @param {boolean} force false なら、頭がヘッダーより下・画面の下4分の1より上に見えているときは動かさない
	 *                        （設問を1つ進めるたびに数pxずつ動くと、かえって落ち着かない）
	 */
	function reveal(node, force) {
		if (!node) { return; }
		var off = landOffset();
		var y = pageY(node);
		var top = window.pageYOffset;
		if (!force && y >= top + off && y <= top + window.innerHeight * 0.75) { return; }
		window.scrollTo(0, Math.max(0, Math.round(y - off)));
	}
	// 見出しにフォーカスを移す（読み上げが新しい設問・結果を読む。次の Tab はその続きから）。
	// 位置は reveal が決めるので、フォーカスでは動かさない
	function focusOn(node) {
		if (!node) { return; }
		node.setAttribute('tabindex', '-1');
		try { node.focus({ preventScroll: true }); } catch (e) { node.focus(); }
	}

	// 診断結果はsessionStorageに保存し、スポット閲覧から戻ってきても復元する
	// （タブを閉じると自動で消える）。ホテルごとに別の保存先にする
	// 現在地は1つの保存先。/nearby/ はページの中の「戻る」で、別々の場所の現在地を履歴に2つ持てる
	// （現在地A → ホテル → 現在地B）。Bで作ったコースが、Aに戻ったときに出ないよう、
	// 復元するときに作ったときの出発座標（保存した request の lat/lng）と比べる（→ 下の初期表示）
	// 言語ごとに別の保存先にする（sessionStorage は /en/ と / で共有される。英語のページで作ったコースを、
	// 日本語のページに「戻る」で英語のまま出さない）。日本語は今までの名前のまま
	var STORAGE_KEY = (hotelId ? 'epQuizResult_h' + hotelId : (stationKey ? 'epQuizResult_s' + stationKey : (origin ? 'epQuizResult_geo' : 'epQuizResult')))
		+ (T.lang && T.lang !== 'ja' ? '_' + T.lang : '');

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

	/** @param {boolean} [user] 利用者の操作で描き直したとき true（ページを開いたときの1問目は位置もフォーカスも動かさない） */
	function renderQuestion(user) {
		el.classList.remove('is-result', 'is-busy');
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
				advance = setTimeout(function () {
					advance = null;
					busy = false;
					step++;
					if (step < QUESTIONS.length) {
						renderQuestion(true);
					} else {
						submit();
					}
				}, 200);
			});
		});
		var back = el.querySelector('.q-back');
		if (back) {
			back.addEventListener('click', function () {
				// 選んだ直後（次へ進むまでの0.2秒）に押されたら、予約した「次へ」を取り消してから戻る。
				// 取り消さないと、いったん戻ったあとで予約が走り、元の設問へ進み直した（BUGS #29）
				if (advance) { clearTimeout(advance); advance = null; busy = false; }
				if (step > 0) { step--; renderQuestion(true); }
			});
		}
		// スマホは選択肢が縦に5つ並ぶので、下の選択肢を押すと次の設問の頭が画面の上に出ていることがある
		if (user) {
			reveal(el.querySelector('.q-step'), false);
			focusOn(el.querySelector('.q-title'));
		}
	}

	function renderLoading() {
		el.classList.remove('is-result', 'is-busy');
		el.innerHTML = '<div class="q-step">'
			+ '<h3 class="q-title">' + esc(t('building', 'あなたのコースを組み立てています…')) + '</h3>'
			+ '<div class="q-loading"><span></span><span></span><span></span></div>'
			+ '<p class="q-note">' + esc(t('buildingNote', '京都観光コンシェルジュが厳選したスポットから、移動時間まで含めて選んでいます（10秒ほどかかることがあります）')) + '</p>'
			+ '</div>';
		// 押した選択肢は消えたので、フォーカスは見出しへ（読み上げが「組み立てています」を読む）
		reveal(el.querySelector('.q-step'), false);
		focusOn(el.querySelector('.q-title'));
	}

	/**
	 * 失敗したときに「次の一手」として何をさせるか（BUGS #11）。
	 * 以前は何が起きても「もう一度試す」＝最初からやり直し（answers・条件・保存した結果を全部捨てる）だった。
	 *   resend … 同じ条件で送り直す（混雑・通信の失敗・サーバーの一時的な失敗。条件は悪くない）
	 *   change … 該当する設問へ戻す（条件を変えてほしいエラー。ほかの答えは残す）
	 *   reset  … 最初から（答えを読めなかった・現在地が使えない など、送り直しても同じ結果になるもの）
	 */
	var RETRY = {
		rate_limited: 'resend', empty_plan: 'resend', net: 'resend',
		walk_out_of_reach: 'change:transport', no_candidates: 'change:time'
	};
	function retryHow(code, status) {
		var how = own(RETRY, code);
		if (how) { return how; }
		// 合図の無い失敗（中身が HTML の 500・504 など）は、サーバー側の一時的な不具合として送り直す
		if (!code && (!status || status >= 500)) { return 'resend'; }
		return 'reset';
	}

	function renderError(message, how) {
		el.classList.remove('is-result', 'is-busy');
		how = how || 'reset';
		var change = how.indexOf('change:') === 0 ? how.slice(7) : '';
		var at = -1;
		QUESTIONS.forEach(function (q, i) { if (q.key === change) { at = i; } });
		if (change && at < 0) { how = 'reset'; } // その設問を出していないページ（ありえないが、出せない設問へは戻さない）
		var label = how === 'resend' ? t('retry', 'もう一度試す')
			: (at >= 0 ? t('retryChange', '条件を変える') : t('startOver', 'もう一度診断する'));
		el.innerHTML = '<div class="q-step">'
			+ '<h3 class="q-title">' + esc(message || t('failed', '診断に失敗しました。')) + '</h3>'
			+ '<div class="q-nav"><button type="button" class="q-next" id="qRetry">' + esc(label) + '</button></div>'
			+ '</div>';
		el.querySelector('#qRetry').addEventListener('click', function () {
			if (how === 'resend' && lastReq) { submit(lastReq.budget, true); return; }
			if (at >= 0) { step = at; renderQuestion(true); return; }
			reset();
		});
		reveal(el.querySelector('.q-step'), false);
		focusOn(el.querySelector('.q-title'));
	}

	/**
	 * 予算チップを押してから返事が来るまで。今のコースは消さずに薄くし、押したチップの隣に「組み立てています」を出す。
	 *
	 * 以前は読み込み表示（短い1枚）で結果を置き換えていた。結果の高さ（PC 1,800px・スマホ 3,000px）がその場で消え、
	 * チップのあたりを見ていた人の画面には「おすすめの場所」や誌面・フッターが映った（BUGS #1）。
	 * 置き換えなければページの高さは変わらず、目の前のチップの隣で待てる。失敗したときも今のコースが残る（#11）。
	 * チップは disabled にしない（押したチップにあるフォーカスが body に落ちる）。二度押しは sending で止める
	 */
	function chipBusy(on, budget) {
		el.classList.toggle('is-busy', on);
		var box = el.querySelector('.r-budget');
		if (!box) { return; }
		// 失敗の文の「もう一度試す」から来たときは、押したボタンごと文を消すので、フォーカスをその予算のチップへ移す
		var ae = document.activeElement;
		var refocus = !!(ae && ae.closest && ae.closest('.b-err'));
		Array.prototype.forEach.call(box.querySelectorAll('.b-status, .b-err'), function (n) { n.parentNode.removeChild(n); });
		if (refocus) {
			var chip = box.querySelector('.b-chip[data-budget="' + parseInt(budget, 10) + '"]') || box.querySelector('.b-chip');
			if (chip) { chip.focus({ preventScroll: true }); }
		}
		Array.prototype.forEach.call(box.querySelectorAll('.b-chip'), function (b) {
			if (on) { b.setAttribute('aria-disabled', 'true'); } else { b.removeAttribute('aria-disabled'); }
		});
		if (on) {
			// フォーカスは押したチップに残るので、読み上げには role=status で知らせる
			box.insertAdjacentHTML('beforeend', '<p class="b-status" role="status"><span class="q-loading" aria-hidden="true"><span></span><span></span><span></span></span>'
				+ esc(t('building', 'あなたのコースを組み立てています…')) + '</p>');
		}
	}
	/** 予算チップからの送信が失敗した。今のコースは残したまま、チップのすぐ下に理由と次の一手を出す */
	function chipError(message, how) {
		chipBusy(false);
		var box = el.querySelector('.r-budget');
		if (!box) { renderError(message, how); return; }
		box.insertAdjacentHTML('beforeend', '<p class="b-err" role="alert">' + esc(message || t('failed', '診断に失敗しました。'))
			+ (how === 'resend' ? ' <button type="button" class="b-retry">' + esc(t('retry', 'もう一度試す')) + '</button>' : '') + '</p>');
		var again = box.querySelector('.b-retry');
		if (again) {
			again.addEventListener('click', function () {
				if (lastReq) { submit(lastReq.budget, true); }
			});
		}
	}

	/** 「1.2km」のような表記に丸める（1km未満はm） */
	function distLabel(m) {
		if (!m && m !== 0) return '';
		return m < 1000 ? m + 'm' : (Math.round(m / 100) / 10) + 'km';
	}

	/*
	 * ---- 紙・PDFの行程表に載せる写真（2026-10-08） ----
	 * 紙にも、画面のカードと同じ写真を載せる（写真の出どころは loadPhotos が取ってくる一覧だけ。紙のために API を足さない）。
	 * 印刷は押した瞬間に同期で組む（共有ページの beforeprint も同じ）ので、**その時点で読み終えている写真しか載せられない**。
	 * 一覧が届いた時点で紙用の写真を読み始め、読み終えた img をスポットのIDで持っておく。紙を組むときは、その img をそのまま紙へ移す
	 * （同じ URL で img を作り直すと、読み込み済みかどうかがブラウザのキャッシュ任せになる）。
	 */
	// 紙の写真の枠（mm）。print.css の --ps-ph-w・--ps-ph-h と同じ値（変えるときは両方）。
	// 10/8 の手直しまで 42×28 と書いてあり、枠（44×29.33）より約5%小さく見積もっていた（細かさを甘く数えていた）
	var PAPER_PH = { w: 44, h: 29.33 };
	var paperPhotos = {};   // スポットのID → img（読み込み中のものも入る。使うのは読み終えたものだけ → paperPhoto）
	var photosAsked = null; // 写真の一覧を取りに行っている最中だけ、その Promise
	// 枠いっぱいに敷いたときの細かさ（dpi）。足りないほうの辺で決まる
	function paperDpi(w, h) {
		return Math.min(w * 25.4 / PAPER_PH.w, h * 25.4 / PAPER_PH.h);
	}
	/**
	 * 紙に使う写真のURL。枠に敷いて 220dpi を超える中で、いちばん小さいものを選ぶ。
	 *
	 * 画面のカードは medium_large → large → medium の順で選ぶが、元の写真が幅768px より小さいスポットは
	 * medium（幅300px）しか当たらない（誌面から起こした写真の多くは幅680px前後で、medium_large が作られない）。
	 * 300px を紙の枠（44mm）に敷くと 170dpi 前後で、PDF を画面で開くと甘く見える。そういう写真は元の大きさ（full）を使う。
	 * どれも 220dpi に届かないとき（元が小さい写真）は、いちばん大きいもの。それでも粗い写真は、引き伸ばさずに小さく置く（→ placePaperPhotos）
	 */
	function paperSource(media) {
		var sizes = (media.media_details && media.media_details.sizes) || {};
		var list = [];
		['medium', 'medium_large', 'large', 'full'].forEach(function (key) {
			var s = own(sizes, key);
			if (s && s.source_url && s.width > 0 && s.height > 0) { list.push(s); }
		});
		if (!list.length) { return media.source_url || ''; }
		list.sort(function (a, b) { return a.width - b.width; });
		// 元の写真（full）が大きすぎるときは候補から外す（数MBの写真を、44mm の枠のために読ませない）。
		// 幅1600px を超える元には必ず large までの縮小版があるので、外しても候補は残る
		var fit = list.filter(function (s) { return s.width <= 1600; });
		if (fit.length) { list = fit; }
		var pick = list[list.length - 1];
		list.some(function (s) {
			if (paperDpi(s.width, s.height) >= 220) { pick = s; return true; }
			return false;
		});
		return pick.source_url;
	}
	function keepForPaper(id, media) {
		var src = paperSource(media);
		var had = own(paperPhotos, String(id));
		// 予算チップで組み直したとき、同じスポットの写真を読み直さない
		if (!src || (had && had.getAttribute('data-src') === src)) { return; }
		var img = new Image();
		img.alt = '';
		img.decoding = 'sync'; // 紙に移したその場で描かせる（後から描くと、印刷に間に合わない）
		img.setAttribute('data-src', src);
		img.src = src;
		paperPhotos[String(id)] = img;
	}
	/** そのスポットの、読み終えた写真（まだ・無い・読めなかったときは null）。 */
	function paperPhoto(id) {
		var img = own(paperPhotos, String(id));
		return (img && img.complete && img.naturalWidth > 0) ? img : null;
	}
	/** 紙に載せる写真が出そろったか（一覧が届いていて、どの写真も読み終えたか・読めなかったかが決まっている）。 */
	function paperReady() {
		if (photosAsked) { return false; }
		return Object.keys(paperPhotos).every(function (id) { return paperPhotos[id].complete; });
	}

	// 行程のカードに写真を載せる。診断の API は写真を返さないので、WP の公開 API（スポットの一覧）から取る。
	// 診断の組み立てには触らない。取れなかったカードは「名前の面」のまま
	function loadPhotos(ids) {
		if (!ids.length || !window.fetch) { return; }
		var url = endpoint.replace('editplus/v1/concierge', 'wp/v2/spot');
		url += (url.indexOf('?') === -1 ? '?' : '&') + 'include=' + ids.join(',') + '&per_page=' + ids.length
			+ '&_embed=wp:featuredmedia&_fields=id,_links,_embedded';
		var asked = fetch(url).then(function (r) { return r.ok ? r.json() : []; }).then(function (list) {
			if (!alive()) { return; }
			// 写真が載ると見出しが現れ、カードが1枚あたり46〜73px伸びる。読んでいるカードがその分だけ下へずれていた
			// （スマホで3枚目を読んでいると119px。BUGS #8）。Chrome の「位置を保つ機能」は、伸びるのが読んでいるカードの中だと効かず、
			// iPhone（WebKit）にはそもそも無い。載せる前に画面の上端にある要素の位置を覚え、載せたあとに同じ位置へ戻す
			var hb = landOffset() - 16;
			var mark = null;
			var markTop = 0;
			Array.prototype.some.call(el.querySelectorAll('.res-head, .rs-when, .rs-ph, .spot .in > *, .r-foot'), function (n) {
				var r = n.getBoundingClientRect();
				if (r.bottom > hb) { mark = n; markTop = r.top; return true; }
				return false;
			});
			(list || []).forEach(function (p) {
				var m = p._embedded && p._embedded['wp:featuredmedia'] && p._embedded['wp:featuredmedia'][0];
				if (!m || !m.source_url) { return; }
				keepForPaper(p.id, m); // 紙・PDF用にも読んでおく（画面のカードには触らない）
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
			// 覚えた要素が画面の中にあったときだけ戻す。結果より上を見ているとき（覚えた要素が画面の下の外）は、伸びるのも画面の外
			if (mark && markTop < window.innerHeight) {
				var moved = mark.getBoundingClientRect().top - markTop;
				if (Math.abs(moved) >= 1) { window.scrollBy(0, moved); }
			}
		}).catch(function () { /* 写真が無くても行程は読める */ }).then(function () {
			// 一覧が届いた（か、取れなかった）。組み直しで後から出した依頼が走っているときは、そちらが終わるまで「途中」のまま
			if (photosAsked === asked) { photosAsked = null; }
		});
		photosAsked = asked;
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

	/*
	 * ---- 紙・PDFの行程表（2026-10-03 作り直し → 2026-10-08 写真つきの「旅のしおり」に） ----
	 * 以前は画面のカード（3列の箱・写真・「乗換案内を見る」のリンク・丸い札）をそのまま紙に流していた。
	 * 紙では押せないリンクが並び、ウェブの部品が箱のまま残って「画面を印刷しただけ」に見えた。
	 * 紙のためだけの組みを印刷の直前に組んで body の末尾に置き、終わったら消す。
	 * 画面のカードを組み替えないのは、画面の描画（renderResult）に紙の都合を混ぜないため。
	 * 見た目は assets/css/print.css（media="print"）。画面では hidden のままなので、画面の見た目は変わらない。
	 *
	 * 10/3 の紙は文字だけ（左に時刻、右に立ち寄り先）で、「AIがつくる書類」に見えた（2026-10-08 野口さん）。
	 * 冊子の1ページのように組み直した: 題字 → 表題 → 立ち寄り先（左に時刻・中に名前と文・右に写真）→ 末尾にQR。
	 * 写真は画面のカードと同じもの（→ 上の「紙・PDFの行程表に載せる写真」）。書体は先に読んでおく（→ warmPaper）
	 */

	/**
	 * このコースのページを開くQRを、SVG で返す（作れないときは空）。
	 *
	 * URLには合言葉が入っているので、外のサービス（QRの画像を返すAPI）には送らず手元で作る
	 * （assets/js/vendor/qrcode.min.js。許諾と作り方は同じフォルダの README.md）。
	 * 画像ではなく SVG にするのは、PDF にしても印刷しても角がにじまないため（読み取りの確実さに効く）。
	 * 訂正の強さは M（約15%）。紙の折れ・汚れに耐え、62文字までのURL（/zh-tw/plan/… を含む今のドメイン）なら 33×33 に収まる
	 * （2026-10-03 実測。72dpi に落とした画像からも読めた）。
	 */
	function qrSvg(text) {
		if (!text || !window.epQRCode) { return ''; }
		var qr;
		try { qr = window.epQRCode.create(text, { errorCorrectionLevel: 'M' }); } catch (e) { return ''; }
		var n = qr.modules.size;
		var cells = qr.modules.data;
		var quiet = 4; // 周りの余白（読み取りに必要な白。規格で4マス）
		var d = '';
		for (var y = 0; y < n; y++) {
			// 横に続く黒は1本の矩形にまとめる（マスごとに書くと、PDFの中で数百の小さな図形になる）
			for (var x = 0; x < n; x++) {
				if (!cells[y * n + x]) { continue; }
				var run = 1;
				while (x + run < n && cells[y * n + x + run]) { run++; }
				d += 'M' + (x + quiet) + ' ' + (y + quiet) + 'h' + run + 'v1h-' + run + 'z';
				x += run - 1;
			}
		}
		var size = n + quiet * 2;
		return '<svg class="ps-qr" viewBox="0 0 ' + size + ' ' + size + '" shape-rendering="crispEdges" aria-hidden="true"><path d="' + d + '"/></svg>';
	}

	/**
	 * 紙・PDFの行程表のHTML。
	 *
	 * 中身は画面と同じ値だけを使う（時刻・移動・営業時間はサーバーが決めた値。紙のために足さない）。
	 * 画面と違うのは、押せないもの（行き方のリンク・予算・共有）を出さないことと、
	 * 代わりにこのコースのページを開くQRを末尾に置くこと（地図と乗換案内はスマートフォンで開いてもらう）。
	 * 写真は枠だけを書いておき、紙を置くときに読み終えた img を移す（placePaperPhotos）。
	 * 文字列で img を書かないのは、warmPaper が同じHTMLを書体の下調べに使うため（そこで写真を読み直させない）。
	 * 店名・コース名・営業時間は、サーバーが返した言語のまま（2026-10-03〜ページの言語で返る）。
	 * 日本語のまま来た部分（訳の無い宿の名前・確かめに落ちた営業時間・古い共有コース）にだけ、外国語のページで lang="ja" を付ける。
	 */
	function printSheet(data) {
		var plan = data.plan || {};
		var spots = data.spots || [];
		var ja = PAGE_JA;
		var gap = ja ? '' : ' ';
		var dot = ja ? '・' : ' · ';
		// 中国語の時間の幅は全角の「～」（スポットの営業時間の表示と同じ。2026-10-03 手直し 2巡目）
		var range = ja ? '〜' : (PAGE_ZH ? '～' : (PAGE_KO ? '~' : '–'));
		var start = startName(plan);
		// 「%s発」に出発地の名前を入れる。訳の無い名前（ホテル名）は名前だけを lang="ja" で包む（renderResult と同じ扱い）
		var withOrigin = function (template) {
			var name = esc(start.text);
			var attr = start.raw ? jaAttr(start.text) : '';
			if (attr) { name = '<span' + attr + '>' + name + '</span>'; }
			return esc(template).replace(/%[ds]/, function () { return name; });
		};
		// 日本語のまま来た中身（営業時間の原文・古い共有コースなど）を、外国語のページでも日本語として組ませる（それ以外は何も付かない）
		var jaText = function (text) { return '<span' + jaAttr(text) + '>' + esc(text) + '</span>'; };

		// 紹介文の右に置く3行（「四条河原町発」「10:00〜13:55」「歩いて回れるコース」）。出発地・時間・回り方。
		// 出発の行は立てない ―― 出発地と出る時刻はここにあり、1件目の移動の罫が「四条河原町から 徒歩6分」と受ける（画面のカードと同じ）。
		// 乗り物の数え方と印は renderResult の要約と同じ決め方（選んだ答えではなく、コースの中身を書く）。変えるときは両方
		var sum = [];
		if (start.text) { sum.push(withOrigin(t('fromLabel', '%s発'))); }
		if (plan.begin) { sum.push(esc(plan.begin) + (plan.end ? range + esc(plan.end) : '')); }
		var rides = (typeof plan.ride_legs === 'number') ? plan.ride_legs : null;
		if (rides !== null) {
			var walks = parseInt(plan.walk_legs, 10) || 0;
			if (rides > 0) {
				var rideMode = plan.transport === 'car' ? 'car' : 'transit';
				spots.some(function (s) {
					var m = modeCode(s.leg_mode, s.travel_by);
					if (m && m !== 'walk') { rideMode = m; return true; }
					return false;
				});
				var sumKey = rideMode === 'car' ? 'sumCar' : 'sumTransit';
				var rideName = MODES[rideMode].label[1];
				// 実際に乗る区間の印を、出てきた順に（電車とバスの両方に乗るなら両方）。歩く区間があれば最後に歩く人
				var seen = {};
				var sumIcons = '';
				spots.forEach(function (s) {
					var m = modeCode(s.leg_mode, s.travel_by);
					if (!m || m === 'walk') { return; }
					var key = m === 'transit' ? (s.leg_kind === 'bus' ? 'bus' : 'train') : m;
					if (!seen[key]) { seen[key] = true; sumIcons += modeIcon(m, s.leg_kind); }
				});
				if (walks > 0) { sumIcons += icon('walk'); }
				sum.push(withIcon(sumIcons, esc(walks > 0
					? fmt2(t(sumKey, rideName + '%1$d回＋徒歩%2$d区間'), rides, walks)
					: fmt(t(sumKey + 'Only', rideName + '%d回'), rides))));
			} else {
				sum.push(withIcon(icon('walk'), esc(t('sumWalk', '歩いて回れるコース'))));
			}
		} else if (plan.transport_label) {
			var chosen = modeCode(plan.transport, plan.transport_label);
			sum.push(withIcon(modeIcon(chosen, ''), esc(chosen ? modeLabel(chosen) : plan.transport_label)));
		}

		// 満たせなかった条件のうち、当日の予定に響くもの（食事が無い・営業時間の外かもしれない）。画面と同じく紙にも出す
		var relaxed = Array.isArray(data.relaxed) ? data.relaxed : [];
		var flags = [];
		if (relaxed.indexOf('eat') !== -1) { flags.push(t('noMealNote', '※ この条件では合う食事処が見つからず、このコースに食事は入っていません')); }
		if (relaxed.indexOf('hours') !== -1) { flags.push(t('hoursNote', '※ 営業時間の合う店が少なく、着く時刻が営業時間の外になる場所があるかもしれません')); }

		// 末尾: このコースのページを開くQR。URLの文字はQRが読めないとき用に小さく1行だけ。
		// 合言葉の無い古い結果（URLを作れない）では、QRもURLも出さない
		var url = planUrl(data);
		var qr = qrSvg(url);
		// 作成日は印刷した日（この紙がいつの情報かを示す）。書き方はページの言語に任せる
		var made = '';
		try {
			made = new Date().toLocaleDateString(document.documentElement.lang || 'ja', { year: 'numeric', month: 'long', day: 'numeric' });
		} catch (e) { made = ''; }
		var foot = '<div class="ps-foot' + (qr ? '' : ' ps-foot--noqr') + '">'
			+ '<div class="ps-foot-text">'
			+ (qr ? '<p class="ps-qr-lead">' + esc(t('printQrLead', 'スマートフォンで地図と乗換案内を開けます')) + '</p>'
				+ '<p class="ps-url">' + esc(url) + '</p>' : '')
			+ (flags.length ? '<p class="ps-flag">' + flags.map(esc).join('<br>') + '</p>' : '')
			+ '<p class="ps-note">' + esc(t('printNote', '時刻は移動時間からの目安です。営業時間・定休日は公式情報でご確認ください。')) + '</p>'
			+ (made ? '<p class="ps-made">' + esc(fmt(t('printMade', '%s 作成'), made)) + '</p>' : '')
			+ '</div>'
			+ qr
			+ '</div>';

		var rows = spots.map(function (s, i) {
			// ひとつ前の場所からの移動（「徒歩9分・553m」「電車・バス16分・2.4km」）と、開店を待つ時間。
			// 立ち寄り先どうしを区切る罫の上に置く（print.css の .ps-leg。罫の途中に文字が入る）。手段の印は画面と同じ形
			var mode = modeCode(s.leg_mode, s.travel_by);
			var by = mode ? modeLabel(mode) : (s.travel_by || t('travel', '移動'));
			var leg = [];
			if (s.travel_min) {
				var from = (i === 0 && start.text) ? withOrigin(t('legFrom', '%sから')) + (ja ? '<span class="ps-gap"></span>' : ' ') : '';
				leg.push(from + withIcon(modeIcon(mode, s.leg_kind), esc(by)) + gap + esc(fmt(t('minutes', '%d分'), s.travel_min))
					+ (s.distance_m ? dot + esc(distLabel(s.distance_m)) : ''));
			}
			var wait = waitMinutes(s.wait_min);
			if (wait) { leg.push(withIcon(icon('clock'), esc(fmt(t('waitOpen', '開くまで約%d分'), wait)))); }
			// 乗る区間（電車・バス、車）は、歩く区間より墨を濃くする（画面と同じ。札は立てない）
			var ride = !!(s.travel_min && mode && mode !== 'walk');
			var time = s.arrive
				? '<b>' + esc(s.arrive) + '</b>' + (s.leave ? '<small>' + range + esc(s.leave) + '</small>' : '')
				: '<b>' + (i + 1) + '</b>';
			// 「エリア｜ジャンル」は画面のカードと同じ1行。区切りは言語ごと（catSep）
			var place = [s.area, s.cat].filter(Boolean).map(jaText).join(esc(t('catSep', '｜')));
			var meta = place ? [place] : [];
			if (s.stay_min) { meta.push(esc(fmt(t('stayMin', '滞在%d分'), s.stay_min))); }
			// 営業時間・定休日・最寄り駅（画面と同じ値・同じ印。判断材料は隠さない。外国語では数字を確かめた訳、落ちたものは原文）
			var facts = [];
			var fact = function (svg, key, label, value) {
				if (value) { facts.push('<span class="ps-fact"><span class="ps-label">' + withIcon(svg, esc(t(key, label))) + '</span>' + jaText(value) + '</span>'); }
			};
			fact(icon('clock'), 'hoursLabel', '営業時間', s.hours);
			fact(icon('calendar'), 'holidayLabel', '定休日', s.holiday);
			fact(icon('train'), 'stationLabel', '最寄り駅', s.station);

			// 写真の枠。読み終えた写真があるスポットは、紙を置くときに写真を移す（placePaperPhotos）。
			// 写真の無いスポット（と、まだ読み終えていない写真）は、画面のカードと同じ「名前の面」。空の箱にしない
			var sid = s.id ? String(parseInt(s.id, 10)) : '';
			var photo = (sid && paperPhoto(sid))
				? '<div class="ps-ph" data-ph="' + esc(sid) + '"></div>'
				: '<div class="ps-ph ps-ph--plate"><span class="ps-ph-name"' + jaAttr(s.title) + '>' + nameHtml(s.title) + '</span></div>';

			return '<li class="ps-row">'
				+ '<p class="ps-leg' + (ride ? ' ps-leg--ride' : '') + (leg.length ? '' : ' ps-leg--none') + '">'
				+ (leg.length ? '<span class="ps-leg-in">' + leg.map(function (x) { return '<span>' + x + '</span>'; }).join('') + '</span>' : '')
				+ '</p>'
				+ '<div class="ps-stop">'
				+ '<p class="ps-time">' + time + '</p>'
				+ '<div class="ps-body">'
				+ '<h2 class="ps-name"' + jaAttr(s.title) + '>' + nameHtml(s.title) + '</h2>'
				+ (s.reason ? '<p class="ps-reason"' + jaAttr(s.reason) + '>' + esc(s.reason) + '</p>' : '')
				+ (meta.length ? '<p class="ps-meta">' + meta.map(function (m) { return '<span>' + m + '</span>'; }).join('') + '</p>' : '')
				+ (facts.length ? '<p class="ps-facts">' + facts.join('') + '</p>' : '')
				+ '</div>'
				+ photo
				+ '</div>'
				+ (i === spots.length - 1 ? foot : '')
				+ '</li>';
		});

		// 末尾の塊（QR・URL・注記）は、最後の立ち寄り先の li の中に置く。外に置くと、2ページ目以降でページの境目に掛かったとき、
		// 塊の途中で切れる（QRと作成日だけが次のページ）か、QRの塊だけが次のページに落ちた。break-before: avoid は1ページ目でしか
		// 効かなかった（2026-10-08 実測: 9件のコース22通りのうち9通りで、3ページ目がQRと注記だけ）。
		// 「割らない塊」（.ps-row の break-inside: avoid）に入れておけば、入らないときは最後の1件ごと次のページへ送られる
		return '<div class="ps-head">'
			+ (T.siteName ? '<p class="ps-site">' + esc(T.siteName) + '</p>' : '')
			+ '<p class="ps-kind">' + esc(t('printKind', 'モデルコース')) + '</p>'
			+ '</div>'
			+ '<div class="ps-lead">'
			+ '<h1 class="ps-title"' + jaAttr(data.title) + '>' + esc(data.title) + '</h1>'
			// 紹介文は左（時刻と文の柱の幅）、要約は右（写真の柱の幅）。下の立ち寄り先と同じ柱に揃える
			+ '<div class="ps-intro">'
			+ '<p class="ps-desc"' + jaAttr(data.description) + '>' + esc(data.description || '') + '</p>'
			+ (sum.length ? '<p class="ps-sum">' + sum.map(function (x) { return '<span>' + x + '</span>'; }).join('') + '</p>' : '')
			+ '</div>'
			+ '</div>'
			+ '<ol class="ps-list">' + rows.join('') + '</ol>'
			// 立ち寄り先が1件も無い紙は組まない（preparePrint が先に帰る）が、塊の置き場が無くなって消えるよりは外に出す
			+ (rows.length ? '' : foot);
	}

	/**
	 * 紙の写真の枠に、読み終えた写真を移す。
	 *
	 * 粗い写真は引き伸ばさない。枠いっぱいに敷くと 110dpi に届かない写真（元が幅130px しかないものがある）は、
	 * 名前の面と同じ和紙の面の中央に、粗く見えない大きさで置く（130dpi より粗くしない。面の縁から3mm 空ける）。
	 * 画面のカードは同じ写真を枠いっぱいに伸ばしているが、紙は手元でじっと見られるので、ぼけた写真を大きく刷らない
	 */
	function placePaperPhotos(sheet) {
		Array.prototype.forEach.call(sheet.querySelectorAll('.ps-ph[data-ph]'), function (box) {
			var img = paperPhoto(box.getAttribute('data-ph'));
			if (!img) { return; }
			var w = img.naturalWidth;
			var h = img.naturalHeight;
			img.removeAttribute('style');
			if (paperDpi(w, h) < 110) {
				var pad = 3;
				var mm = Math.min(25.4 / 130, (PAPER_PH.w - pad * 2) / w, (PAPER_PH.h - pad * 2) / h);
				img.style.width = (w * mm).toFixed(2) + 'mm';
				img.style.height = (h * mm).toFixed(2) + 'mm';
				box.classList.add('ps-ph--plate', 'ps-ph--small');
			}
			box.appendChild(img);
		});
	}

	/**
	 * 紙で使う書体を、先に読んでおく。
	 *
	 * 紙にだけ出る字（題字の横の「モデルコース」・注記・作成日）や、紙だけの組み合わせ（店名の明朝 600 など）は、
	 * 画面で同じ書体・太さの字が使われていないと、印刷の時点でフォントが届いていない
	 * （Google Fonts は字の範囲ごとのファイルを、画面に出た字の分だけ読む。印刷は押した瞬間に組んで始まる）。
	 * 届いていない字は端末の別の明朝・ゴシックで刷られ、1行の中で書体が混ざる。
	 * 紙のHTMLを一度組んで、そこに出る字を書体ごとに頼んでおく。書体と太さの組み合わせは print.css と同じ（変えるときは両方）。
	 * 中国語・韓国語の面は Web フォントを使わないので、何も読まない
	 */
	function warmPaper(data) {
		if (!document.fonts || !document.fonts.load) { return; }
		var box = document.createElement('div');
		try { box.innerHTML = printSheet(data); } catch (e) { return; }
		var root = getComputedStyle(document.documentElement);
		var textOf = function (sel) {
			return Array.prototype.map.call(box.querySelectorAll(sel), function (n) { return n.textContent; }).join('');
		};
		[
			['500', '--mincho', textOf('.ps-title, .ps-name')],        // 表題と、写真の無いスポットの名前の面
			['600', '--mincho', textOf('.ps-site, .ps-name')],         // 題字と店名
			['500', '--serif', textOf('.ps-time b') + '0123456789:/'], // 着く時刻と、ページ番号
			['400', '--gothic', box.textContent]                       // そのほか全部
		].forEach(function (f) {
			var family = root.getPropertyValue(f[1]).trim();
			if (!family || !f[2]) { return; }
			// 届かなくても端末の書体で刷れるので、失敗は黙って流す
			try { document.fonts.load(f[0] + ' 12px ' + family, f[2]).catch(function () {}); } catch (e) { /* 無視 */ }
		});
	}

	/**
	 * 印刷・PDFの直前に、行程表を組んで置く。
	 *
	 * 置き場所は body の末尾。print.css が html.ep-print-plan のあいだだけ「body の直下でこれ以外」を消す。
	 * 画面ではずっと hidden（印刷のダイアログが開いているあいだも、画面の見た目は変わらない）。
	 */
	var printScrollY = null; // 印刷の直前に見ていた位置。afterPrint で戻す
	var printWaiting = null; // 「PDFで保存・印刷」を押してから、写真が出そろうのを待っているあいだのタイマー（→ bindKeep）
	function preparePrint(data) {
		clearPrint();
		// 紙のときは本文を消すので、文書が1〜2ページ分の高さになる。PC の Chrome はスクロール位置をその高さまで縮め、
		// 印刷が終わっても戻さない（結果の下の方で押すと、トップのヒーローまで飛んでいた）。縮められる前の位置を覚えておく。
		// beforeprint ではなくここで覚えるのは、ボタン（ここ → window.print）と共有ページの beforeprint の両方を1か所で通すため
		printScrollY = window.pageYOffset;
		if (!data || !data.spots || !data.spots.length) { return; }
		var sheet = document.createElement('div');
		sheet.className = 'ep-sheet';
		sheet.hidden = true;
		sheet.innerHTML = printSheet(data);
		placePaperPhotos(sheet);
		document.body.appendChild(sheet);
		document.documentElement.classList.add('ep-print-plan');
	}
	// 紙ごと外す。中の写真（img）は paperPhotos が持ったままなので、次の印刷でも読み直さずに使える
	function clearPrint() {
		document.documentElement.classList.remove('ep-print-plan');
		Array.prototype.forEach.call(document.querySelectorAll('.ep-sheet'), function (node) {
			node.parentNode.removeChild(node);
		});
	}
	/**
	 * 印刷が終わったあとの後始末。行程表を外し、印刷の前に見ていた位置と見た目へ戻す。
	 *
	 * 戻す処理を clearPrint に入れないのは、clearPrint が preparePrint の冒頭でも呼ばれるため（印刷の前に位置を動かしてしまう）。
	 * スマホは位置が縮められないので、同じ位置への空振りになる。
	 */
	function afterPrint() {
		clearPrint();
		if (printScrollY === null) { return; }
		var y = printScrollY;
		printScrollY = null;
		// 紙のときに display:none にした結果は、画面に戻ると入場の動き（style.css の fadeup）を最初からやり直す。
		// 印刷のたびにカードが透けて出直すので、終わった形にそろえる（読み込み中の点 qdot は終わりの無い動きなので触らない）
		if (document.getAnimations) {
			document.getAnimations().forEach(function (anim) {
				if (anim.animationName === 'fadeup') { anim.finish(); }
			});
		}
		if (Math.round(window.pageYOffset) !== Math.round(y)) { window.scrollTo(window.pageXOffset, y); }
	}
	window.addEventListener('afterprint', afterPrint);
	// 共有されたコースのページは、ブラウザのメニューから印刷しても同じ行程表にする（このページの中身はコースだけ）。
	// 診断のあるトップページなどでは、ボタンを押したときだけ
	if (shared) { window.addEventListener('beforeprint', function () { preparePrint(shared); }); }

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
					// 紙・PDFには、このコースのページを開くQRを載せる（printSheet）。載せる以上、開けるように残しておく。
					// 返事は待たずに開く。待ってから開くと「このページが印刷しようとしています」と確認が出る端末がある
					if (planUrl(data)) {
						persist(data).catch(function () { /* 残せなくても印刷は止めない */ });
					}
					// 写真が出そろっていれば（ふつうはそう。ボタンは結果のいちばん下にある）、押したその場で開く。
					// 出そろう前に押されたときだけ、そろうのを待ってから開く。待つのは最長2秒 ――
					// それ以上は待たせず、間に合わなかった写真は名前の面で刷る（待つほど、上の「確認が出る端末」に当たりやすくなる）
					if (printWaiting) { return; }
					var open = function () {
						printWaiting = null;
						if (!alive()) { return; } // 待つあいだに起動し直された（/nearby/ で出発点を変えた）
						preparePrint(data);
						window.print();
					};
					if (paperReady()) { open(); return; }
					var since = Date.now();
					printWaiting = setInterval(function () {
						if (!paperReady() && Date.now() - since < 2000) { return; }
						clearInterval(printWaiting);
						open();
					}, 60);
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

	/**
	 * @param {Object}  data 診断の返事（または保存・共有されたコース）。
	 * @param {boolean} [user] 利用者の操作（回答・予算チップ・送り直し）で出したとき true。
	 *                         コース名を固定ヘッダーのすぐ下へ着地させ、フォーカスも移す。
	 *                         「戻る」での復元・共有されたコースでは、ブラウザが戻す位置を動かさない
	 */
	function renderResult(data, user) {
		// 'cache' で返ってくる場合もあるので「ai以外は編集部セレクト」で判定する。
		// source === 'fallback' だけを見ると、キャッシュ済みのフォールバックに
		// 「Your Route」のバッジが付き、本文の「編集部の定番スポットで組みました」と矛盾する
		// バッジは「誰が選んだか」（made_by）で決める。source はキャッシュから返すと 'cache' になり、共有したコースでは外れるため、
		// 同じAIのコースが2回目から「編集部のおすすめ」になっていた（2026-10-03 テスト）。made_by の無い古い結果は source で見る
		var by = data.made_by || data.source;
		var badge = by === 'ai' ? t('badgeRoute', 'コンシェルジュの提案') : t('badgePick', '編集部のおすすめ');
		var plan = data.plan || {};
		// 数字まわりの約物は言語で変える。日本語は「徒歩8分」「4スポット」と詰め、区切りは「・」、時間の幅は「〜」。
		// 間に半角の空白や「–」を入れると、欧文の作法で機械が組んだ表記に見える
		var ja = PAGE_JA;
		var gap = ja ? '' : ' ';
		var dot = ja ? '・' : ' · ';
		var dotEnd = ja ? '・' : ' ·'; // 項目の末尾に付けるとき（後ろの空白は項目の間に置く）
		// 中国語の時間の幅は全角の「～」（スポットの営業時間の表示と同じ。2026-10-03 手直し 2巡目）
		var range = ja ? '〜' : (PAGE_ZH ? '～' : (PAGE_KO ? '~' : '–'));

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
				? '<span class="rs-wait">' + withIcon(icon('clock'), esc(fmt(t('waitOpen', '開くまで約%d分'), wait))) + '</span>'
				: '';
			var leg = '';
			if (s.travel_min) {
				// 手段の名前の前に、手段のアイコン（徒歩＝歩く人、電車・バス＝電車かバス、タクシー・車＝車）。文字は今のまま
				leg = '<span class="rs-leg' + (mode && mode !== 'walk' ? ' rs-leg--ride' : '') + '">' + from
					+ '<span class="rs-by">' + withIcon(modeIcon(mode, s.leg_kind), esc(by)) + gap + esc(fmt(t('minutes', '%d分'), s.travel_min))
					+ (s.distance_m ? dot + esc(distLabel(s.distance_m)) : '') + '</span>' + waitNote + '</span>';
			} else if (waitNote) {
				leg = '<span class="rs-leg rs-leg--wait">' + waitNote + '</span>';
			}
			// 乗り物に乗って別のエリアへ移る所に、区切りを入れる（歩く区間・エリア名が前と同じ所には出さない → zoneBreak）。
			// エリアの番号を持たない古いコースには何も足さない
			var newZone = i > 0 && zoneBreak(s, spots[i - 1]);
			var zoneMark = newZone ? '<span class="rs-zone">' + esc(t('nextZone', '次のエリアへ')) + '</span>' : '';
			// 着く時刻を大きく、出る時刻を小さく（誌面のモデルコースと同じ）。時刻が無いときだけ順番の数字
			var when = s.arrive
				? '<b>' + esc(s.arrive) + '</b>' + (s.leave ? '<small>' + range + esc(s.leave) + '</small>' : '')
				: '<b>' + (i + 1) + '</b>';
			// トップのカードと同じ「エリア｜ジャンル」の1行
			// 区切りは言語ごと（全角の ｜ は日本語・中国語だけ。欧文・韓国語は「 | 」。2026-10-03）
			var cat = [s.area, s.cat].filter(Boolean).map(esc).join(esc(t('catSep', '｜')));

			// 営業時間・定休日は誌面の原文をそのまま出す。
			// 診断は日付を聞いていないので「その日開いているか」は保証できない。
			// 保証しないと決めた以上、判断材料は隠さずに出す
			// 行の頭に小さなアイコン（営業時間＝時計、定休日＝暦、最寄り駅＝電車）。ラベルの文字は残す（読み上げと意味のため）
			var facts = [];
			// 値は結果の言語の訳（数字を確かめたもの）。確かめに落ちた欄は日本語の原文のまま来るので、そこにだけ lang="ja" が付く
			var factText = function (v) { return '<span' + jaAttr(v) + '>' + esc(v) + '</span>'; };
			if (s.hours) facts.push(withIcon(icon('clock'), esc(t('hoursLabel', '営業時間'))) + ' ' + factText(s.hours));
			if (s.holiday) facts.push(withIcon(icon('calendar'), esc(t('holidayLabel', '定休日'))) + ' ' + factText(s.holiday));
			// 最寄りの駅・バス停も誌面の原文。どの駅で降りるかの手掛かりになる
			if (s.station) facts.push(withIcon(icon('train'), esc(t('stationLabel', '最寄り駅'))) + ' ' + factText(s.station));
			// スマホでは営業時間などを畳む（4枚とも開いたままだと、カードの半分が同じ形の行になる）。PCでは開いたまま（ボタンは出さない）
			var factsTg = facts.length
				? '<button type="button" class="ts-tg" aria-expanded="false">' + esc(t('factsMore', '営業時間など')) + '</button>'
				: '';

			// カードの下のリンクは1つだけ。ひとつ前の場所からここまでの行き方（乗る区間は乗換案内、歩く区間は道順）を開く。
			// 行き方の画面には行き先のピンも出るので、「地図で見る」（ピンだけ）とは並べない
			// （3列のカードは中が190pxしかなく、2つ並べると折れる）。行き方のURLを持たない古いコースは、今までどおり地図
			var acts = [];
			var legUrl = mode ? httpUrl(s.leg_url) : '';
			var pinUrl = httpUrl(s.map_url);
			if (legUrl) {
				var linkText = t(MODES[mode].link[0], MODES[mode].link[1]);
				// 同じ文言のリンクがカードの数だけ並ぶので、読み上げでは行き先の名前を添える
				// 行き方のリンクは地図のピン。開くのは地図（Googleマップ）で、手段はすぐ上の区間の行がアイコンで示している
				acts.push('<a href="' + esc(legUrl) + '" target="_blank" rel="noopener" aria-label="' + esc(linkText + ' — ' + s.title) + '">' + withIcon(icon('pin'), esc(linkText)) + '</a>');
			} else if (pinUrl) {
				acts.push('<a href="' + esc(pinUrl) + '" target="_blank" rel="noopener">' + withIcon(icon('pin'), esc(t('viewMap', '地図で見る'))) + '</a>');
			}
			if (s.stay_min) acts.push('<span>' + esc(fmt(t('stayMin', '滞在%d分'), s.stay_min)) + '</span>');
			// スポットのページへのリンク。http(s) でなければ href を付けない（名前は出すが、押せない）
			var spotUrl = httpUrl(s.url);
			var spotHref = spotUrl ? ' href="' + esc(spotUrl) + '"' : '';
			var nameLang = jaAttr(s.title);

			return '<li class="rs-step' + (newZone ? ' rs-step--zone' : '') + '" data-i="' + i + '" style="animation-delay:' + (i * 90) + 'ms">'
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
				+ (acts.length || factsTg ? '<div class="actions">' + acts.join('') + factsTg + '</div>' : '')
				+ '</div></article></li>';
		}).join('');

		// その日の流れ（スマホだけ。2026-10-07 案B）。カードを横にすべらせる形にしたので、何時にどこへ行くかを先に1枚で見せる。
		// /nearby/ の「その日のコース」と同じ組み（時刻・名前・滞在、あいだに移動）。行を押すと、そのカードへ移る
		var flow = '';
		if (spots.length) {
			var rows = '';
			if (origin) {
				rows += '<li class="rf-row"><span class="rf-in"><span class="rf-t">' + esc(plan.begin || '') + '</span>'
					+ '<span class="rf-n">' + withOrigin('%s') + '</span><span class="rf-r">' + esc(t('depart', '出発')) + '</span></span></li>';
			}
			spots.forEach(function (s, i) {
				var mode = modeCode(s.leg_mode, s.travel_by);
				if (s.travel_min) {
					var by = mode ? modeLabel(mode) : (s.travel_by || t('travel', '移動'));
					rows += '<li class="rf-leg' + (mode && mode !== 'walk' ? ' rf-leg--ride' : '') + '">'
						+ withIcon(modeIcon(mode, s.leg_kind), esc(by)) + gap + esc(fmt(t('minutes', '%d分'), s.travel_min))
						+ (s.distance_m ? dot + esc(distLabel(s.distance_m)) : '') + '</li>';
				}
				rows += '<li class="rf-row"><a class="rf-in" href="#" data-go="' + i + '"><span class="rf-t">' + esc(s.arrive || String(i + 1)) + '</span>'
					+ '<span class="rf-n"' + jaAttr(s.title) + '>' + esc(s.title) + '</span>'
					+ '<span class="rf-r">' + (s.stay_min ? esc(fmt(t('stayMin', '滞在%d分'), s.stay_min)) : '') + '</span></a></li>';
			});
			flow = '<div class="rs-flow"><h4 class="rs-sub">' + esc(t('flowTitle', 'その日の流れ')) + '</h4><ol class="rf-list">' + rows + '</ol></div>'
				// 行き先の見出しと、何枚目かの数・前後のボタン（スマホだけ）
				+ '<div class="rs-nav"><h4 class="rs-sub">' + esc(t('spotsTitle', '行き先')) + '</h4>'
				+ '<span class="rs-count" aria-hidden="true">1 / ' + spots.length + '</span>'
				+ '<button type="button" class="rs-prev" aria-label="' + esc(t('prevSpot', '前の行き先')) + '">←</button>'
				+ '<button type="button" class="rs-next" aria-label="' + esc(t('nextSpot', '次の行き先')) + '">→</button></div>';
		}

		var stats = [];
		if (origin) stats.push('<span>' + withOrigin(t('fromLabel', '%s発')) + '</span>');
		// 交通は「選んだ答え」ではなく「コースの中身」を書く。電車・バスを選んでも、近い所だけで組めたコースは
		// 乗る区間が無い。そこに「電車・バス」と出すと、下の行程（徒歩ばかり）と食い違う
		var rides = (typeof plan.ride_legs === 'number') ? plan.ride_legs : null;
		if (rides !== null) {
			var walks = parseInt(plan.walk_legs, 10) || 0;
			var summary;
			var sumIcons = ''; // 要約の頭に、使う手段のアイコンを乗る順に（電車・バス・車 → 徒歩）
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
				// 電車・バスのコースは、実際に乗る区間の見積もり（電車・バス）を出てきた順に。両方あれば両方
				var seen = {};
				spots.forEach(function (s) {
					var m = modeCode(s.leg_mode, s.travel_by);
					if (!m || m === 'walk') { return; }
					var svg = modeIcon(m, s.leg_kind);
					var key = m === 'transit' ? (s.leg_kind === 'bus' ? 'bus' : 'train') : m;
					if (svg && !seen[key]) { seen[key] = true; sumIcons += svg; }
				});
				if (walks > 0) { sumIcons += icon('walk'); }
			} else {
				summary = t('sumWalk', '歩いて回れるコース');
				sumIcons = icon('walk');
			}
			stats.push('<span class="res-sum">' + withIcon(sumIcons, esc(summary)) + '</span>');
			if (plan.travel_min) stats.push('<span>' + esc(fmt(t('travelTotal', '移動は計%d分'), plan.travel_min)) + '</span>');
		} else if (plan.transport_label) {
			// 乗る区間の数を持たない古いコース。選んだ手段の名前を（訳せるものは訳して）そのまま出す
			var chosen = modeCode(plan.transport, plan.transport_label);
			stats.push('<span class="res-sum">' + withIcon(modeIcon(chosen, ''), esc(chosen ? modeLabel(chosen) : plan.transport_label)) + '</span>');
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
		// 画面の下に固定するボタン（スマホだけ）に入れる、短い名前とURL
		var dockUrl = '';
		var dockText = '';
		if (plan.map_kind === 'legs') {
			var first = spots[0] || {};
			var firstMode = modeCode(first.leg_mode, first.travel_by);
			var firstUrl = firstMode ? httpUrl(first.leg_url) : '';
			if (firstUrl) {
				var firstText = firstMode === 'transit' ? t('openFirstTransit', '最初の行き先までの乗換案内を開く')
					: (firstMode === 'car' ? t('dirCar', '車のルートを見る') : t('openFirstWalk', '最初の行き先までの道順を開く'));
				route = '<a class="r-map" href="' + esc(firstUrl) + '" target="_blank" rel="noopener">' + esc(firstText) + '</a>';
				dockUrl = firstUrl;
				dockText = t(MODES[firstMode].link[0], MODES[firstMode].link[1]);
			}
			// 乗換案内はカードごとに開く、と一言添える（全体のルートを探す人が迷わないように）
			var hasTransit = spots.some(function (s) { return modeCode(s.leg_mode, s.travel_by) === 'transit' && httpUrl(s.leg_url); });
			if (hasTransit) {
				routeHint = '<p class="res-note res-note--hint">' + esc(t('legsHint', '電車・バスに乗る区間は、各カードの「乗換案内を見る」から調べられます。')) + '</p>';
			}
		} else if (httpUrl(plan.map_url)) {
			route = '<a class="r-map" href="' + esc(plan.map_url) + '" target="_blank" rel="noopener">' + esc(t('openRoute', 'Googleマップでルートを開く')) + '</a>';
			dockUrl = plan.map_url;
			dockText = t('openRouteShort', 'Googleマップで開く');
		}
		// 地図と共有は、一番下まで読まないと押せなかった（4か所のコースで約4,300px下）。スマホでは画面の下に固定する
		var dock = '<div class="r-dock">'
			+ (dockUrl ? '<a class="r-dock-map" href="' + esc(dockUrl) + '" target="_blank" rel="noopener">' + esc(dockText) + '</a>' : '')
			+ '<button type="button" class="r-dock-keep">' + esc(t('shareShort', '共有')) + '</button></div>';

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
			: '<button type="button" class="r-reset" data-reset>' + esc(t('startOver', 'もう一度診断する')) + '</button>';
		// スマホではコース名と紹介文のあいだに浮いて見えたので、共有の欄の下に1行で置く（PCはコース名の横のまま）
		var againEnd = '<p class="r-again">' + again.replace('class="r-reset"', 'class="r-reset r-reset--end"') + '</p>';

		el.classList.remove('is-busy');
		el.classList.add('is-result');
		el.innerHTML = '<div class="q-res">'
			+ (T.siteName ? '<p class="res-print-site">' + esc(T.siteName) + '</p>' : '')
			+ '<div class="res-head">'
			+ '<div class="res-h"><h3 class="res-title"' + jaAttr(data.title) + '>' + esc(data.title) + '</h3>'
			+ again + '</div>'
			+ (data.description ? '<p class="res-desc"' + jaAttr(data.description) + '>' + esc(data.description) + '</p>' : '')
			+ '<div class="res-stats">' + stats.join('') + '<span class="res-badge">' + badge + '</span></div>'
			+ '</div>'
			+ flow
			+ '<ol class="rs-grid">' + steps + '</ol>'
			+ '<div class="r-foot">' + route + chips + '</div>'
			+ routeHint + flagNote
			+ '<p class="res-note">' + esc(t('timeNote', '時刻は移動時間からの目安です。営業時間・定休日は各スポットのページと公式情報でご確認ください。')) + '</p>'
			+ keep
			+ againEnd
			+ dock
			// 紙・PDFからコースに戻れるように（中身は印刷のときに入れる。空のあいだは出ない）
			+ '<p class="res-print-url">' + esc(data.share_url || '') + '</p>'
			+ '</div>';
		loadPhotos(ids);
		bindKeep(data);
		// 紙・PDFで使う書体を先に読んでおく（印刷は押した瞬間に組むので、その場では間に合わない → warmPaper）。
		// 少し遅らせるのは、結果を描いた直後の描画と、画面の書体・写真の読み込みを先に通すため
		setTimeout(function () { if (alive()) { warmPaper(data); } }, 400);

		Array.prototype.forEach.call(el.querySelectorAll('.r-reset[data-reset]'), function (b) { b.addEventListener('click', reset); });
		bindPhone();
		Array.prototype.forEach.call(el.querySelectorAll('.b-chip'), function (btn) {
			btn.addEventListener('click', function () {
				if (sending) { return; }
				submit(parseInt(btn.getAttribute('data-budget'), 10));
			});
		});

		// 新しいコースはコース名から読む。予算チップのときは押した位置（結果の下端）から、1,000〜4,000px 上へ戻ることになる。
		// 描き直した瞬間に一度で動かす（なめらかに流すと、入れ替わった中身の上を滑っていくだけで何も読めない）
		if (user) {
			reveal(el.querySelector('.res-head'), true);
			focusOn(el.querySelector('.res-title'));
		}
	}

	/*
	 * スマホの結果画面の動き（2026-10-07 案B → 60_デザイン/2026-10-07_プランのスマホと帯の案.md）。
	 * 形は CSS が決める（600px 以下だけ、カードを横にすべらせる・流れの表・下に固定するボタンを出す）。
	 * ここは押したときの動きだけ。PC では流れの表もボタンも見えないので、何も起きない
	 */
	function bindPhone() {
		var grid = el.querySelector('.rs-grid');
		var count = el.querySelector('.rs-count');
		if (!grid) { return; }
		var cards = grid.children;
		var sliding = function () { return grid.scrollWidth > grid.clientWidth + 4; };
		// 1枚ぶんの送り幅（カードの幅＋間）。2枚目の位置から測る（間は CSS が持っている）
		var pitch = function () { return cards.length > 1 ? cards[1].offsetLeft - cards[0].offsetLeft : grid.clientWidth; };
		var current = function () { return Math.max(0, Math.min(cards.length - 1, Math.round(grid.scrollLeft / pitch()))); };
		var go = function (i) {
			i = Math.max(0, Math.min(cards.length - 1, i));
			grid.scrollTo({ left: i * pitch(), behavior: 'smooth' });
		};
		var shown = -1;
		var sync = function () {
			var i = current();
			if (i === shown) { return; }
			shown = i;
			if (count) { count.textContent = (i + 1) + ' / ' + cards.length; }
			var prev = el.querySelector('.rs-prev');
			var next = el.querySelector('.rs-next');
			if (prev) { prev.disabled = i === 0; }
			if (next) { next.disabled = i === cards.length - 1; }
		};
		grid.addEventListener('scroll', function () { window.requestAnimationFrame(sync); }, { passive: true });
		sync();
		var prevBtn = el.querySelector('.rs-prev');
		var nextBtn = el.querySelector('.rs-next');
		if (prevBtn) { prevBtn.addEventListener('click', function () { go(current() - 1); }); }
		if (nextBtn) { nextBtn.addEventListener('click', function () { go(current() + 1); }); }
		// 流れの行を押したら、そのカードへ。カードの列が見える所までページも動かす
		Array.prototype.forEach.call(el.querySelectorAll('.rf-in[data-go]'), function (a) {
			a.addEventListener('click', function (e) {
				e.preventDefault();
				var i = parseInt(a.getAttribute('data-go'), 10) || 0;
				if (sliding()) {
					reveal(el.querySelector('.rs-nav'), true);
					go(i);
				} else {
					reveal(cards[i], true);
				}
				var link = cards[i] && cards[i].querySelector('.rs-ph[href], .actions a');
				if (link) { link.focus({ preventScroll: true }); }
			});
		});
		// 営業時間など（スマホだけ畳んである）
		Array.prototype.forEach.call(el.querySelectorAll('.ts-tg'), function (b) {
			b.addEventListener('click', function () {
				var step = b.closest('.rs-step');
				var open = !step.classList.contains('is-facts');
				step.classList.toggle('is-facts', open);
				b.setAttribute('aria-expanded', open ? 'true' : 'false');
			});
		});
		// 紹介文は3行で畳む（スマホだけ）。3行に収まる文には「続きを読む」を出さない
		var desc = el.querySelector('.res-desc');
		if (desc && window.matchMedia('(max-width: 600px)').matches) {
			desc.classList.add('is-clamp');
			if (desc.scrollHeight > desc.clientHeight + 2) {
				var more = document.createElement('button');
				more.type = 'button';
				more.className = 'res-more';
				more.setAttribute('aria-expanded', 'false');
				more.textContent = t('readMore', '続きを読む');
				desc.insertAdjacentElement('afterend', more);
				more.addEventListener('click', function () {
					var open = desc.classList.contains('is-clamp');
					desc.classList.toggle('is-clamp', !open);
					more.setAttribute('aria-expanded', open ? 'true' : 'false');
					more.textContent = open ? t('readLess', '閉じる') : t('readMore', '続きを読む');
				});
			} else {
				desc.classList.remove('is-clamp');
			}
		}
		// カードの下の「ルートを開く」が見えているあいだは、下に固定したボタンを隠す（同じボタンを2つ並べない）
		var dock = el.querySelector('.r-dock');
		var inPlace = el.querySelector('.r-foot .r-map');
		if (dock && inPlace && 'IntersectionObserver' in window) {
			new IntersectionObserver(function (entries) {
				dock.classList.toggle('is-off', entries[0].isIntersecting);
			}).observe(inPlace);
		}
		// 下に固定した「共有」は、共有の欄へ移るだけ（LINE・コピー・PDF から選ぶ）
		var keepBtn = el.querySelector('.r-dock-keep');
		if (keepBtn) {
			keepBtn.addEventListener('click', function () {
				var box = el.querySelector('.r-keep');
				reveal(box, true);
				var first = box && box.querySelector('.r-keep-btn');
				if (first) { first.focus({ preventScroll: true }); }
			});
		}
	}

	function reset() {
		try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) { /* プライベートモード等では無視 */ }
		answers = QUESTIONS.map(function () { return null; });
		lastReq = null;
		step = 0;
		renderQuestion(true);
	}

	/**
	 * @param {number}  [budget] 予算の帯（1〜3）。結果画面の調整チップから渡される。
	 *                           設問では聞かない（→ 30_要件定義/食事と予算_プラン設計 §5.5）
	 * @param {boolean} [again]  直前の条件（lastReq）をそのまま送り直す（失敗したあとの「もう一度試す」）
	 */
	function submit(budget, again) {
		// 結果を出している最中の予算チップ（と、その失敗からの送り直し）は、結果を消さずに待つ（→ chipBusy）
		var onResult = !!(budget && lastReq && el.querySelector('.q-res'));
		if (onResult) { chipBusy(true, budget); } else { renderLoading(); }
		sending = true;
		var payload;
		if (again && lastReq) {
			payload = JSON.parse(JSON.stringify(lastReq));
		} else if (budget && lastReq) {
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
			if (stationKey) { payload.station = stationKey; }
			if (origin) { payload.lat = origin.lat; payload.lng = origin.lng; }
		}
		delete payload.budget;
		if (budget) { payload.budget = budget; }
		// ページの言語。サーバーは店名・エリア・営業時間・AIの文をこの言語で返す（送らない古い画面には日本語で返る）。
		// 予算チップ・送り直し（直前の条件の写し）にも、いまのページの言語を付け直す
		if (T.lang) { payload.lang = T.lang; } else { delete payload.lang; }
		lastReq = payload;

		fetch(endpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload)
		})
			.then(function (res) {
				return res.json().then(function (json) { return { ok: res.ok, status: res.status, json: json }; });
			})
			.then(function (r) {
				// 待つあいだに起動し直された（/nearby/ で出発点を変えた）なら、前の出発点の返事は描かない・残さない
				if (!alive()) { return; }
				sending = false;
				if (!r.ok) {
					var how = retryHow(r.json && r.json.code, r.status);
					if (onResult) { chipError(errorText(r.json), how); } else { renderError(errorText(r.json), how); }
					return;
				}
				// 送った条件も一緒に残す。「戻る」で復元した結果から予算チップを押したときに使う
				r.json.request = payload;
				try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(r.json)); } catch (e) { /* 容量超過等では無視 */ }
				renderResult(r.json, true);
			})
			.catch(function () {
				if (!alive()) { return; }
				sending = false;
				var text = t('netFailed', '通信に失敗しました。時間をおいてお試しください。');
				if (onResult) { chipError(text, 'resend'); } else { renderError(text, 'resend'); }
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
	var restore = (typeof options.restore === 'boolean') ? options.restore : (navType === 'back_forward');
	if (restore) {
		try { saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { /* 壊れた保存値は無視 */ }
		// 現在地のコースは、いまの出発座標で作ったものだけを出す（別の場所で作ったコースを出さない）。
		// 保存は消さない ―― 「進む」でその場所に戻ったときに使う
		var req = saved && saved.request;
		if (origin && !(req && req.lat === origin.lat && req.lng === origin.lng)) { saved = null; }
	} else {
		var hadResult = false;
		try { hadResult = !!sessionStorage.getItem(STORAGE_KEY); } catch (e) { /* 無視 */ }
		try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) { /* 無視 */ }
		// 結果を出したまま再読み込みした。診断は1問目に戻るのに、ブラウザは結果があったときのスクロール位置を戻すので、
		// 短くなったページの別の欄（「おすすめの場所」・フッター）に着いていた（BUGS #28）。
		// このときだけブラウザの位置の復元を止め、診断の欄へ着地させる。止めるのはこの1回だけ ――
		// ページを離れるときに auto へ戻し、スポットから「戻る」で帰ってきたときの復元は今までどおりにする。
		// 復元するかを呼び出し側が決めるページ（/nearby/）は、位置も nearby.js が決めるので触らない
		if (hadResult && navType === 'reload' && typeof options.restore !== 'boolean' && 'scrollRestoration' in history && !shared) {
			history.scrollRestoration = 'manual';
			var land = function () { reveal(el.closest('section') || el, true); };
			if (document.readyState === 'complete') { land(); } else { window.addEventListener('load', land); }
			window.addEventListener('pagehide', function () { history.scrollRestoration = 'auto'; });
		}
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
