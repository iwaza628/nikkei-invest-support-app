document.addEventListener("DOMContentLoaded", () => {
  // DOM要素の取得
  const industrySelect = document.getElementById("industrySelect");
  const stockSelect = document.getElementById("stockSelect");
  const stockSearch = document.getElementById("stockSearch"); // 🌟 追加
  const recentList = document.getElementById("recentList");
  const analysisResult = document.getElementById("analysisResult");
  const loadingSpinner = document.getElementById("loading-spinner");
  const loadingIndicator = document.getElementById("loading-indicator");
  const ohlcDisplay = document.getElementById("ohlc-display");
  // --- 🌟 追加：新UI要素 ---
  const runAnalysisTriggers = document.querySelectorAll(".run-analysis-trigger");
  const exportPdfBtn = document.getElementById("exportPdfBtn");
  const tabBtns = document.querySelectorAll(".tab-btn");
  const marketFormArea = document.getElementById("market-form-area");
  const reresearchFormArea = document.getElementById("reresearch-form-area"); // 🌟 追加
  const cancelAnalysisBtn = document.getElementById("cancelAnalysisBtn"); // 🌟 追加

  // アプリケーションの状態管理
  let selectedMode = "full"; // デフォルトは個別株分析
  let currentChartData = { ticker: "", candles: [], kairi25: [] };
  let isSyncing = false; // チャート間の同期ループ防止フラグ
  let currentAbortController = null; // 🌟 追加: ロードキャンセル用

  // --- 1. メインチャート(株価・SMA)の初期化 ---
  const chartContainer = document.getElementById("chart");
  const chart = LightweightCharts.createChart(chartContainer, { 
    width: chartContainer.clientWidth, 
    height: 400,
    localization: {
      locale: 'ja-JP',
      dateFormat: 'yyyy/MM/dd',
    },
    layout: {
      padding: {
        right: 50,
      },
    },
    timeScale: { 
      borderVisible: true, 
      timeVisible: false,
      rightOffset: 5,
      barSpacing: 10, 
    },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal }
  });

  // シリーズ（線やロウソク足）の追加
  const candleSeries = chart.addCandlestickSeries({
    priceFormat: {
      type: 'price',
      precision: 0,
      minMove: 1,
    },
  });
  // 終値追跡用（不可視、クロスヘア用）
  const closeTrackerSeries = chart.addLineSeries({
    color: "rgba(0, 0, 0, 0)",
    lineWidth: 0,
    lineVisible: false,
    lastValueVisible: false,
    priceLineVisible: false,
    crosshairMarkerVisible: true,
    crosshairMarkerRadius: 3,
    crosshairMarkerBorderColor: "black",
    crosshairMarkerBackgroundColor: "black",
  });

  // 移動平均線(SMA)の設定
  const smaOptions = { 
    lineWidth: 1, 
    title: "", 
    lastValueVisible: false, 
    priceLineVisible: false, 
    crosshairMarkerVisible: false,
    priceFormat: {
      type: 'price',
      precision: 0,
      minMove: 1,
    },
  };
  const sma5Series = chart.addLineSeries({ ...smaOptions, color: "green" });
  const sma25Series = chart.addLineSeries({ ...smaOptions, color: "red" });
  const sma75Series = chart.addLineSeries({ ...smaOptions, color: "blue" });

  // --- 2. サブチャート(25日乖離率)の初期化 ---
  const kairiContainer = document.getElementById("kairiChart");
  const kairiChart = LightweightCharts.createChart(kairiContainer, { 
    width: kairiContainer.clientWidth, 
    height: 150,
    localization: {
      locale: 'ja-JP',
      dateFormat: 'yyyy/MM/dd',
    },
    layout: {
      padding: {
        right: 50,
      },
    },
    timeScale: { 
      borderVisible: true, 
      timeVisible: false,
      rightOffset: 0, 
    }
  });
  const kairiSeries = kairiChart.addLineSeries({ 
    color: "purple", lineWidth: 2, title: "", lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false 
  });
  const volumeSeries = kairiChart.addHistogramSeries({
    color: '#26a69a',
    priceFormat: { type: 'volume' },
    // priceScaleId は指定せず、デフォルト(右側)を共有する
    visible: false,
  });

  // サブチャートの切り替えイベント
  document.querySelectorAll('input[name="subChartToggle"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      const isVol = e.target.id === 'toggleVol';
      
      // シリーズの表示・非表示
      kairiSeries.applyOptions({ visible: !isVol });
      volumeSeries.applyOptions({ visible: isVol });
      
      // スケールを自動調整して、表示されているシリーズに合わせる
      kairiChart.priceScale('').applyOptions({
        autoScale: true
      });
    });
  });

  // --- 3. マウス移動時の株価詳細表示 (OHLC) ---
  chart.subscribeCrosshairMove(param => {
    if (!param.time || param.point === undefined || param.point.x < 0 || param.point.y < 0) {
      ohlcDisplay.innerHTML = "日付: -- 始値: -- 高値: -- 安値: -- 終値: --";
      return;
    }
    const data = param.seriesData.get(candleSeries);
    if (data) {
      const { time, open, high, low, close } = data;
      
      // 騰落率の計算：(当日終値 - 前日終値) / 前日終値
      const currentIndex = currentChartData.candles.findIndex(c => c.time === time);
      let change = 0;
      if (currentIndex > 0) {
        const prevClose = currentChartData.candles[currentIndex - 1].close;
        change = ((close - prevClose) / prevClose) * 100;
      } else {
        // データ初日の場合は便宜上、当日始値と比較
        change = ((close - open) / open) * 100;
      }

      const color = change >= 0 ? "red" : "blue";

      // 業種判定: 全体指数なら小数点2桁、それ以外は整数
      const currentStock = allStocks.find(s => s.ticker === currentChartData.ticker);
      const isIndex = currentStock && currentStock.industry === "全体指数";
      
      const fmt = (val) => isIndex ? val.toFixed(2) : Math.floor(val).toLocaleString();

      // 出来高の取得
      const currentCandle = currentChartData.candles.find(c => c.time === time);
      const volume = currentCandle ? (currentCandle.volume || 0) : 0;

      ohlcDisplay.innerHTML = `
        <div style="display: flex; flex-wrap: wrap; gap: 10px;">
          <span><b>日付:</b> ${time}</span>
          <span><b>始値:</b> ${fmt(open)}</span>
          <span><b>高値:</b> ${fmt(high)}</span>
          <span><b>安値:</b> ${fmt(low)}</span>
          <span><b>終値:</b> ${fmt(close)}</span>
          <span><b>出来高:</b> ${volume.toLocaleString()}</span>
        </div>
        <div style="margin-top: 4px;">
          <b>騰落率(前日比):</b> <span style="color:${color}; font-weight:bold;">${change >= 0 ? "+" : ""}${change.toFixed(2)}%</span>
        </div>
      `;
    }
  });

  // --- 4. 2つのチャートのズーム・スクロールを同期 ---
  chart.timeScale().subscribeVisibleTimeRangeChange(range => {
    if (isSyncing || !range || currentChartData.candles.length === 0) return;
    isSyncing = true;
    try { kairiChart.timeScale().setVisibleRange(range); } catch (e) {}
    isSyncing = false;
  });

  kairiChart.timeScale().subscribeVisibleTimeRangeChange(range => {
    if (isSyncing || !range || currentChartData.candles.length === 0) return;
    isSyncing = true;
    try { chart.timeScale().setVisibleRange(range); } catch (e) {}
    isSyncing = false;
  });

  // --- 5. 業種フィルタ・閲覧履歴の管理 ---
  function updateStockList() {
    const selected = industrySelect.value;
    stockSelect.innerHTML = '<option value="">銘柄を選択してください</option>';
    if (typeof allStocks === 'undefined') return;
    const filtered = selected === "all" ? allStocks : allStocks.filter(s => s.industry === selected);
    filtered.forEach(s => {
      const opt = document.createElement("option");
      opt.value = s.ticker; opt.textContent = `${s.ticker} | ${s.name}`;
      stockSelect.appendChild(opt);
    });
  }

  function saveToHistory(ticker, name) {
    let history = JSON.parse(localStorage.getItem("stock_history") || "[]");
    history = history.filter(h => h.ticker !== ticker);
    history.unshift({ ticker, name });
    // 履歴を10件まで保存
    localStorage.setItem("stock_history", JSON.stringify(history.slice(0, 10)));
    renderRecent();
  }

  function renderRecent() {
    const history = JSON.parse(localStorage.getItem("stock_history") || "[]");
    recentList.innerHTML = "";
    history.forEach(h => {
      const btn = document.createElement("button");
      btn.textContent = `${h.ticker} ${h.name}`;
      btn.onclick = () => { 
        if (industrySelect.value !== "all") {
          industrySelect.value = "all";
          updateStockList();
        }
        stockSelect.value = h.ticker; 
        stockSelect.dispatchEvent(new Event('change')); 
      };
      recentList.appendChild(btn);
    });
  }

  industrySelect.addEventListener("change", updateStockList);
  updateStockList(); renderRecent();

  // --- 🌟 銘柄検索機能 (オートコンプリート) ---
  const searchResults = document.getElementById("searchResults");
  if (stockSearch && searchResults) {
      stockSearch.addEventListener("input", (e) => {
          const keyword = e.target.value.trim().toLowerCase();
          if (!keyword) {
              searchResults.style.display = "none";
              return;
          }
          
          const filtered = allStocks.filter(s => 
              s.ticker.toLowerCase().includes(keyword) || 
              s.name.toLowerCase().includes(keyword)
          );
          
          searchResults.innerHTML = "";
          if (filtered.length > 0) {
              filtered.slice(0, 10).forEach(s => {
                  const item = document.createElement("button");
                  item.className = "list-group-item list-group-item-action text-start";
                  item.innerHTML = `<span class="fw-bold">${s.ticker}</span> <span class="small ms-2">${s.name}</span>`;
                  item.onclick = () => {
                      stockSearch.value = ""; // 入力クリア
                      searchResults.style.display = "none";
                      
                      // 業種フィルタをリセット
                      if (industrySelect.value !== "all") {
                          industrySelect.value = "all";
                          updateStockList();
                      }
                      
                      stockSelect.value = s.ticker;
                      stockSelect.dispatchEvent(new Event('change'));
                  };
                  searchResults.appendChild(item);
              });
              searchResults.style.display = "block";
          } else {
              searchResults.innerHTML = '<div class="list-group-item text-muted small">候補が見つかりません</div>';
              searchResults.style.display = "block";
          }
      });
      
      // 検索ボックス以外をクリックしたら候補を閉じる
      document.addEventListener("click", (e) => {
          if (!stockSearch.contains(e.target) && !searchResults.contains(e.target)) {
              searchResults.style.display = "none";
          }
      });
  }

  // --- 6. サーバーからデータ取得とチャートへの反映 ---
  stockSelect.addEventListener("change", async function() {
    if (!this.value) return;
    const stockInfo = allStocks.find(s => s.ticker === this.value);
    if (stockInfo) {
        saveToHistory(stockInfo.ticker, stockInfo.name);
        // AI会社説明の取得開始
        fetchCompanyInfo(stockInfo.ticker, stockInfo.name);
    }

    try {
      const res = await fetch("/get_data", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ticker: this.value}) });
      const data = await res.json();
      if (data.error) return;

      currentChartData = { ticker: this.value, candles: data.candles, kairi25: data.kairi25 };
      isSyncing = true;
      
      // 業種に応じてチャートの価格スケール精度を変更
      const isIndex = stockInfo && stockInfo.industry === "全体指数";
      const precision = isIndex ? 2 : 0;
      const minMove = isIndex ? 0.01 : 1;

      candleSeries.applyOptions({
        priceFormat: { type: 'price', precision: precision, minMove: minMove }
      });
      sma5Series.applyOptions({
        priceFormat: { type: 'price', precision: precision, minMove: minMove }
      });
      sma25Series.applyOptions({
        priceFormat: { type: 'price', precision: precision, minMove: minMove }
      });
      sma75Series.applyOptions({
        priceFormat: { type: 'price', precision: precision, minMove: minMove }
      });

      // チャートデータのセット
      candleSeries.setData(data.candles);
      const closeData = data.candles.map(d => ({ time: d.time, value: d.close }));
      closeTrackerSeries.setData(closeData);
      sma5Series.setData(data.sma5); 
      sma25Series.setData(data.sma25); 
      sma75Series.setData(data.sma75);
      kairiSeries.setData(data.kairi25);
      
      // 出来高データのセット (サブチャート用)
      const volData = data.candles.map(c => ({
        time: c.time,
        value: c.volume,
        color: c.close >= c.open ? 'rgba(38, 166, 154, 0.5)' : 'rgba(255, 82, 82, 0.5)',
      }));
      volumeSeries.setData(volData);

      // 表示範囲の調整（直近120日分をデフォルト表示）
      const totalPoints = data.candles.length;
      const showBars = 120;
      chart.timeScale().setVisibleLogicalRange({ from: totalPoints - showBars, to: totalPoints });
      kairiChart.timeScale().setVisibleLogicalRange({ from: totalPoints - showBars, to: totalPoints });
      isSyncing = false;
      
      // 統計情報の表示更新
      const fmtPrice = (val) => isIndex ? val.toFixed(2) : Math.floor(val).toLocaleString();

      document.getElementById("stockStats").style.display = "flex";
      document.getElementById("statCap").textContent = data.stats.market_cap;
      document.getElementById("statPER").textContent = data.stats.per;
      document.getElementById("statPBR").textContent = data.stats.pbr;
      document.getElementById("statROE").textContent = data.stats.roe;
      document.getElementById("statROA").textContent = data.stats.roa;
      document.getElementById("statMax").textContent = `${fmtPrice(data.stats.max_price)} (${data.stats.max_date})`;
      document.getElementById("statMin").textContent = `${fmtPrice(data.stats.min_price)} (${data.stats.min_date})`;
      // 出来高データは隠しリストに保持（分析機能用）
      document.getElementById("statVolRanking").innerHTML = data.stats.volume_ranking.map((v, i) => `<li>${i+1}. ${v.date}: <b>${v.volume.toLocaleString()}</b></li>`).join("");
      document.getElementById("statDiv").textContent = data.stats.dividend_yield;
      document.getElementById("statPayout").textContent = data.stats.payout_ratio;
      document.getElementById("statExDiv").textContent = data.stats.ex_div_date;

    } catch (e) { console.error(e); isSyncing = false; }
  });

  // --- 7. AI分析モード切り替えと実行 ---
  
  // タブ切り替えイベント
  tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      // 全タブからactiveを消してクリックされたものに付与
      tabBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      
      // 選択されたモードを更新
      selectedMode = btn.dataset.mode;

      // 各フォーム・案内文の表示制御
      marketFormArea.style.display = (selectedMode === "market") ? "block" : "none";
      if (reresearchFormArea) {
          reresearchFormArea.style.display = (selectedMode === "reresearch") ? "block" : "none";
      }
      
      // 全ての案内文を一度非表示にする
      document.querySelectorAll(".analysis-guide").forEach(el => el.style.display = "none");
      // 選択されたモードに対応する案内文を表示
      const guideId = `${selectedMode}-analysis-guide`;
      const guideEl = document.getElementById(guideId);
      if (guideEl) guideEl.style.display = "block";
      
      // タブを切り替えたら、前の結果をクリアして非表示にする
      analysisResult.innerHTML = "";
      document.getElementById("analysis-container").style.display = "none";
    });
  });

  // 統合された分析実行処理
  async function runAnalysis(e) {
      // 既存の処理があればキャンセルする
      if (currentAbortController) {
          currentAbortController.abort();
      }
      currentAbortController = new AbortController(); // 新しいコントローラーを作成

      // クリックされたボタンからサブモードを取得 (再調査のauto/manual判定用)
      const btn = e.currentTarget;
      const subMode = btn.dataset.mode; // reresearch_auto or reresearch_manual

      // 市況分析・総合分析・再調査以外は銘柄選択が必須
      if (selectedMode !== "market" && selectedMode !== "total" && selectedMode !== "reresearch" && !currentChartData.ticker) {
          alert("銘柄を選択してください。");
          return;
      }

      // 新しい分析を開始する前に、前の結果をクリアして非表示にする
      analysisResult.innerHTML = "";
      document.getElementById("analysis-container").style.display = "none";

      let endpoint, bodyData, msg, title;
      // 高速モード使用フラグ (ローディング表示用)
      let isFastMode = false;

      if (selectedMode === "total" || selectedMode === "reresearch") {
          // チェックされた履歴アイテムを取得
          const selectedCheckboxes = document.querySelectorAll('.history-select:checked');
          if (selectedCheckboxes.length === 0) {
              alert("分析対象のレポートを履歴から選択してください。");
              return;
          }

          const selectedResults = Array.from(selectedCheckboxes).map(cb => {
              const item = cb.closest('.history-item');
              return {
                  title: item.dataset.title,
                  content: item.dataset.rawContent
              };
          });

          if (selectedMode === "total") {
              endpoint = "/analyze_total";
              bodyData = { selected_results: selectedResults };
              msg = "複数のレポートを統合して総合分析中...";
              title = "## 総合分析レポート\n\n";
          } else {
              // 再調査モード (reresearch)
              endpoint = "/re_research";
              
              if (subMode === "reresearch_manual") {
                  const userQ = document.getElementById("user_question").value;
                  if (!userQ) {
                      alert("質問内容を入力してください。");
                      return;
                  }
                  isFastMode = document.getElementById("re_manual_fast").checked;
                  bodyData = { 
                      selected_results: selectedResults,
                      user_question: userQ,
                      mode: "manual",
                      beginner_mode: document.getElementById("re_manual_beginner").checked,
                      deep_analysis: document.getElementById("re_manual_deep").checked,
                      use_lite_model: isFastMode
                  };
                  msg = "あなたの質問について調査中...";
                  title = "## 再調査レポート (Q&A)\n\n";
              } else {
                  // reresearch_auto
                  bodyData = { 
                      selected_results: selectedResults,
                      mode: "auto",
                      beginner_mode: document.getElementById("re_auto_beginner").checked,
                      deep_analysis: document.getElementById("re_auto_deep").checked,
                      short_term: document.getElementById("re_auto_short").checked,
                      mid_term: document.getElementById("re_auto_mid").checked
                  };
                  msg = "AIが深掘り調査中...";
                  title = "## 再調査レポート (深掘り調査)\n\n";
              }
          }

      } else if (selectedMode === "market") {
          endpoint = "/analyze_market";
          
          // チェックされたトピックを取得
          const topics = Array.from(document.querySelectorAll('input[name="market_topic"]:checked')).map(cb => cb.value);
          const freeKeyword = document.getElementById("market_free_keyword").value;
          
          if (topics.length === 0 && !freeKeyword) {
              alert("分析対象のキーワードを選択または入力してください。");
              return;
          }

          bodyData = {
              topics: topics,
              free_keyword: freeKeyword,
              beginner_mode: document.getElementById("m_beginner").checked,
              deep_analysis: document.getElementById("m_deep").checked,
              technical_mode: document.getElementById("m_tech").checked,
              short_term: document.getElementById("m_short").checked,
              mid_term: document.getElementById("m_mid").checked,
              sector_view: document.getElementById("m_sector").checked
          };
          msg = "最新ニュースを取得して市況を分析中...";
          title = "## 市況分析レポート\n\n";
      } else {
          // 出来高ランキングデータの抽出
          const volumeRanking = [];
          const rankingListItems = document.querySelectorAll("#statVolRanking li");
          rankingListItems.forEach(item => {
              const text = item.textContent;
              const dateMatch = text.match(/(\d{4}-\d{2}-\d{2}):/);
              if (dateMatch) {
                  volumeRanking.push({ date: dateMatch[1] });
              }
          });

          if (selectedMode === "volume") {
              endpoint = "/analyze_volume";
              bodyData = { ...currentChartData, volume_ranking: volumeRanking };
              msg = "出来高急増日の背景を調査中...";
              title = "## 出来高分析レポート\n\n";
          } else if (selectedMode === "tech") {
              endpoint = "/analyze";
              isFastMode = document.getElementById("tech_fast").checked;
              // テクニカル分析には全データを送信（バックエンドで1年分として処理）
              bodyData = {
                  ...currentChartData,
                  beginner_mode: document.getElementById("tech_beginner").checked,
                  deep_analysis: document.getElementById("tech_deep").checked,
                  use_lite_model: isFastMode
              };
              msg = "チャート形状を分析中...";
              title = "## テクニカル分析レポート\n\n";
          } else {
              endpoint = "/analyze_full";
              isFastMode = document.getElementById("full_fast").checked;
              bodyData = {
                  ...currentChartData,
                  beginner_mode: document.getElementById("full_beginner").checked,
                  deep_analysis: document.getElementById("full_deep").checked,
                  use_lite_model: isFastMode
              };
              msg = "Google検索で最新情報を調査中...";
              title = "## 個別株分析レポート\n\n";
          }
      }

      // UI状態の更新
      runAnalysisTriggers.forEach(b => b.disabled = true);
      document.getElementById("loading-container").style.display = "block";
      cancelAnalysisBtn.style.display = "inline-block"; // キャンセルボタンを表示
      loadingIndicator.textContent = msg + (isFastMode ? " (高速モード)" : "");
      
      // 分析開始時に結果コンテナを表示
      document.getElementById("analysis-container").style.display = "block";
      analysisResult.style.opacity = "0.5";

      try {
          const res = await fetch(endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(bodyData),
              signal: currentAbortController.signal // AbortSignalを渡す
          });
          const data = await res.json();
          
          if (data.error) {
              analysisResult.innerHTML = `<span style="color:red;">エラー: ${data.error}</span>`;
          } else {
              let content = title;
              if (data.date_range) {
                  content += `> **取得ニュース期間:** ${data.date_range}\n\n`;
              }
              content += (data.analysis || "分析結果が得られませんでした。");
              const htmlResult = marked.parse(content);
              analysisResult.innerHTML = htmlResult;
              
              // PDF保存ボタンを表示
              exportPdfBtn.style.display = "block";
              // 現在表示中の生テキストをボタンに保持させる
              exportPdfBtn.dataset.rawContent = content;
              
              // 銘柄名を取得
              const currentStock = allStocks.find(s => s.ticker === currentChartData.ticker);
              const stockName = currentStock ? currentStock.name : "";
              const modeName = title.replace(/## |💎 |🌍 |📊 |📈 |🔍 |レポート|結果/g, "").trim();
              const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, "");
              
              // 銘柄コード + 銘柄名 + 分析種別 + 日付
              exportPdfBtn.dataset.title = `${stockName}${modeName}${dateStr}`;

              // --- 🌟 追加：履歴への追加処理 ---
              addHistoryItem(selectedMode, bodyData, data.date_range, htmlResult, data.analysis || "");

              // --- 🌟 追加：結果表示エリアへスクロール ---
              document.getElementById('analysis-container').scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          
      } catch (error) {
          if (error.name === 'AbortError') {
              console.log('Fetch aborted');
              analysisResult.innerHTML = `<span style="color:orange;">分析がキャンセルされました。</span>`;
          } else {
              console.error(error);
              analysisResult.innerHTML = "エラーが発生しました。サーバーとの通信に失敗しました。";
          }
      } finally {
          runAnalysisTriggers.forEach(b => b.disabled = false);
          document.getElementById("loading-container").style.display = "none";
          cancelAnalysisBtn.style.display = "none"; // ボタンを隠す
          analysisResult.style.opacity = "1.0";
          currentAbortController = null;
      }
  }

  // キャンセルボタンのイベントリスナー
  if (cancelAnalysisBtn) {
      cancelAnalysisBtn.addEventListener("click", () => {
          if (currentAbortController) {
              currentAbortController.abort();
              loadingIndicator.textContent = "キャンセル中...";
          }
      });
  }

  // --- 8. AI会社説明の取得 ---
  async function fetchCompanyInfo(ticker, name) {
      const display = document.getElementById("companyInfoContent");
      display.innerHTML = '<div style="display:flex; align-items:center; gap:10px;"><div class="loader"></div> 調査中...</div>';
      
      try {
          const res = await fetch("/get_company_info", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ticker, name })
          });
          const data = await res.json();
          if (data.error) {
              display.innerHTML = `<span style="color:red;">取得エラー: ${data.error}</span>`;
          } else {
              display.innerHTML = marked.parse(data.info);
          }
      } catch (e) {
          console.error(e);
          display.innerHTML = "情報の取得に失敗しました。";
      }
  }

  // --- 9. 分析履歴の管理機能 ---
  function addHistoryItem(mode, inputData, dateRange, htmlContent, rawContent) {
      const historyList = document.getElementById("history-list");
      
      if (historyList.innerHTML.includes("まだ履歴はありません")) {
          historyList.innerHTML = "";
      }

      const item = document.createElement("div");
      item.className = "history-item";
      item.style.marginBottom = "10px";
      item.style.border = "1px solid #ddd";
      item.style.borderRadius = "8px";
      item.style.overflow = "hidden";
      item.style.display = "flex";

      let titleText = "";
      if (mode === "market") {
          const topics = (inputData.topics && inputData.topics.length > 0) ? inputData.topics.join(", ") : (inputData.free_keyword || "自由キーワード");
          titleText = `🌍 市況分析: ${topics}`;
      } else if (mode === "total") {
          titleText = `💎 総合分析レポート`;
      } else if (mode === "reresearch") {
          const subType = (inputData.mode === "manual") ? "Q&A" : "自律深掘り";
          titleText = `🕵️ 再調査 (${subType})`;
      } else if (mode === "volume") {
          titleText = `📊 出来高分析: ${inputData.ticker}`;
      } else {
          const modeName = (mode === "full") ? "個別株分析" : "テクニカル分析";
          titleText = `${(mode === 'full') ? '🔍' : '📈'} ${modeName}: ${inputData.ticker}`;
      }

      item.dataset.title = titleText;
      item.dataset.rawContent = rawContent;
      item.dataset.htmlContent = htmlContent;

      const timestamp = new Date().toLocaleTimeString();
      const dateRangeTag = dateRange ? `<span style="margin-left:8px; color:#666; font-size:0.85em; font-weight:normal;">[${dateRange}]</span>` : "";

      item.innerHTML = `
          <div class="history-select-container">
              <input type="checkbox" class="history-select" style="width: 18px; height: 18px; cursor: pointer;" title="総合分析に含める" onclick="event.stopPropagation();">
          </div>
          <div class="history-content-link">
              <span style="font-weight: bold; color: #333;">${titleText} ${dateRangeTag}</span>
              <span style="font-size: 0.8em; color: #999;">${timestamp}</span>
          </div>
      `;

      // 履歴クリック時の挙動：メインの分析結果エリアに反映
      item.addEventListener("click", () => {
          // 他のアイテムの active クラスを解除
          document.querySelectorAll('.history-item').forEach(el => el.classList.remove('active'));
          item.classList.add('active');

          // 結果エリアを表示して更新
          document.getElementById("analysis-container").style.display = "block";
          analysisResult.innerHTML = htmlContent;
          
          // PDF保存ボタンの更新
          exportPdfBtn.style.display = "block";
          exportPdfBtn.dataset.rawContent = rawContent;
          
          // 履歴から復元する場合もファイル名を再構成
          const modeName = titleText.replace(/💎 |🌍 |📊 |📈 |🔍 |🕵️ |レポート|結果|分析: |個別株分析: |テクニカル分析: |再調査/g, "").trim();
          const tickerMatch = titleText.match(/([A-Z0-9.^]+)$/);
          const ticker = tickerMatch ? tickerMatch[1] : (currentChartData.ticker || "");
          const currentStock = allStocks.find(s => s.ticker === ticker);
          const stockName = currentStock ? currentStock.name : "";
          const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, "");
          
          exportPdfBtn.dataset.title = `${ticker}${stockName}${modeName}${dateStr}`;

          // スムーズに分析結果エリアへスクロール
          document.getElementById('analysis-container').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });

      historyList.insertBefore(item, historyList.firstChild);
  }

  // --- 10. PDFエクスポート実行 (Server-Side) ---
  exportPdfBtn.addEventListener("click", async () => {
      const content = exportPdfBtn.dataset.rawContent;
      const title = exportPdfBtn.dataset.title;
      const ticker = currentChartData.ticker;

      if (!content) {
          alert("分析結果がありません。先に分析を行ってください。");
          return;
      }

      exportPdfBtn.disabled = true;
      exportPdfBtn.textContent = "PDF作成中...";

      try {
          const res = await fetch("/export_pdf", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ title, content, ticker })
          });

          if (res.ok) {
              const blob = await res.blob();
              const url = window.URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              // ファイル名を強制的に指定してダウンロードさせる
              a.download = `${title}.pdf`; 
              document.body.appendChild(a);
              a.click();
              window.URL.revokeObjectURL(url);
              a.remove();
          } else {
              const err = await res.json();
              alert("PDFの生成に失敗しました: " + (err.error || "Unknown error"));
          }
      } catch (e) {
          console.error(e);
          alert("エラーが発生しました。");
      } finally {
          exportPdfBtn.disabled = false;
          exportPdfBtn.textContent = "PDF保存";
      }
  });

  // 実行ボタンにイベント登録 (複数のトリガーに対応)
  runAnalysisTriggers.forEach(btn => {
      btn.addEventListener("click", runAnalysis);
  });

  // --- 11. ウィンドウリサイズ対応 ---
  window.addEventListener("resize", () => {
    chart.applyOptions({ width: chartContainer.clientWidth });
    kairiChart.applyOptions({ width: kairiContainer.clientWidth });
  });

  // --- 12. トップへ戻るボタン ---
  const scrollTopBtn = document.getElementById("scrollTopBtn");
  if (scrollTopBtn) {
      scrollTopBtn.addEventListener("click", () => {
          const container = document.getElementById("analysis-container");
          if (container) {
              container.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
      });
  }

  // --- 13. チャートリセットボタン ---
  const resetChartBtn = document.getElementById("resetChartBtn");
  if (resetChartBtn) {
    resetChartBtn.addEventListener("click", () => {
      chart.timeScale().fitContent();
      // 乖離率チャートも同期させるため、少し遅らせて同期処理を走らせるか、
      // 単純に両方をfitContentする
      kairiChart.timeScale().fitContent();
    });
  }
});
