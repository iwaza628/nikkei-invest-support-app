# 各分析コードを統合した完全版(テクニカル分析＋個別株分析)
import os
import sqlite3
import pandas as pd
import yfinance as yf
import feedparser
import urllib.parse
import time
import markdown
from flask import Flask, render_template, request, jsonify, send_file
from io import BytesIO
import pdfkit
from datetime import datetime
from dotenv import load_dotenv

# 最新のGeminiライブラリをインポート
from google import genai
from google.genai import types

# .envからAPIキー(GOOGLE_API_KEY)を読み込み
load_dotenv()

app = Flask(__name__)

# --- Gemini クライアントの初期化 (最新SDK方式) ---
try:
    client = genai.Client(api_key=os.getenv("GOOGLE_API_KEY"))
except Exception as e:
    print(f"Gemini Client Init Error: {e}")
    client = None

# 使用するGeminiモデルの設定
MODEL_NAME = "gemini-3-flash-preview"
MODEL_LITE = "gemini-2.5-flash-lite" # 会社説明用

# --- パス設定 ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CSV_PATH = os.path.join(BASE_DIR, 'stocks.csv')  # 銘柄リストCSV
DB_PATH = os.path.join(BASE_DIR, 'stocks.db')    # 株価保存用DB

# 銘柄リストCSVからデータを読み込む関数
def load_stock_data():
    if not os.path.exists(CSV_PATH):
        # CSVがない場合のデフォルトデータ
        default_data = [{"ticker": "^N225", "name": "日経平均株価", "industry": "全体指数"}]
        return ["全体指数"], default_data
    df = pd.read_csv(CSV_PATH, encoding='utf-8-sig')
    
    # 指定された業種の順番
    industry_order = [
        "全体指数", "製造業(完成品)", "製造業(素材)", "商業・サービス", 
        "金融・情報通信", "化学・医薬品", "不動産・建設", "運輸・物流", "食品"
    ]
    
    # CSVに存在する業種を取得
    existing_industries = df['industry'].unique().tolist()
    
    # 指定順序に基づいてソート（指定リストにないものは最後に追加）
    industries = sorted(existing_industries, key=lambda x: industry_order.index(x) if x in industry_order else 999)
    
    stocks = df.to_dict(orient='records')                 # 全銘柄リスト
    return industries, stocks

# --- Google News RSS 取得関数 ---
def fetch_rss_news(topics, limit=150):
    if not topics:
        return None, "トピックが選択されていません。", None

    max_total_limit = int(limit)
    news_items = []
    pub_dates = []

    for topic in topics:
        if len(news_items) >= max_total_limit:
            break

        encoded_topic = urllib.parse.quote(topic)
        rss_url = f"https://news.google.com/rss/search?q={encoded_topic}&hl=ja&gl=JP&ceid=JP:ja"
        feed = feedparser.parse(rss_url)

        if not feed.entries:
            continue

        for entry in feed.entries:
            if len(news_items) >= max_total_limit:
                break

            pub_date = None
            if "published_parsed" in entry:
                pub_date = datetime.fromtimestamp(time.mktime(entry.published_parsed))
                pub_dates.append(pub_date)

            summary = entry.summary if "summary" in entry else "(要約なし)"
            pub_str = pub_date.strftime("%Y-%m-%d %H:%M") if pub_date else "日付情報なし"
            news_items.append(f"【{entry.title}】 ({pub_str})\n{summary}")

    if not news_items:
        return None, "最新のニュースが見つかりませんでした。", None

    date_range_str = "日付情報なし"
    if pub_dates:
        min_date = min(pub_dates).strftime("%Y-%m-%d %H:%M")
        max_date = max(pub_dates).strftime("%Y-%m-%d %H:%M")
        date_range_str = f"{min_date} ~ {max_date}"

    return "\n\n".join(news_items), None, date_range_str

# 取得した株価データをSQLite3データベースに保存する関数
def store_to_db(ticker_symbol, df):
    if df.empty: return
    conn = sqlite3.connect(DB_PATH)
    # 記号を除去してテーブル名を作成 (例: ^N225 -> N225_prices)
    table_name = ticker_symbol.replace("^", "").replace(".", "_") + "_prices"
    df_to_save = df.reset_index()
    df_to_save.to_sql(table_name, conn, if_exists="replace", index=False)
    conn.close()

# メイン画面の表示
@app.route("/")
def index():
    industries, stocks = load_stock_data()
    return render_template("index.html", industries=industries, stocks=stocks)

# 銘柄が選択された際に株価データと統計情報を取得するAPI
@app.route("/get_data", methods=["POST"])
def get_data():
    req = request.get_json()
    ticker = req.get("ticker")
    if not ticker: return jsonify({"error": "ticker not provided"}), 400

    try:
        # yfinanceで過去1年間のデータをダウンロード
        df = yf.download(ticker, period="1y", interval="1d")
        if df.empty: return jsonify({"error": "no data found"}), 404

        # マルチインデックス対策
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)

        # 欠損値（空データ）を削除
        df = df.dropna(subset=['Open', 'High', 'Low', 'Close'])

        # --- 📊 統計データの計算 ---
        max_price = float(df['High'].max())
        max_date = df['High'].idxmax().strftime("%Y-%m-%d")
        min_price = float(df['Low'].min())
        min_date = df['Low'].idxmin().strftime("%Y-%m-%d")
        # 出来高TOP10の抽出
        top10_vol = df.sort_values(by='Volume', ascending=False).head(10)
        volume_ranking = [{"date": idx.strftime("%Y-%m-%d"), "volume": int(row["Volume"])} for idx, row in top10_vol.iterrows()]

        # --- 🏦 ファンダメンタルズ情報の取得 ---
        market_cap_str, div_yield_str, payout_ratio_str, ex_div_date_str, roe_str, roa_str, per_str, pbr_str = "N/A", "N/A", "N/A", "N/A", "N/A", "N/A", "N/A", "N/A"
        
        try:
            stock_obj = yf.Ticker(ticker)
            info = stock_obj.info

            if info:
                # PER/PBRの取得
                per = info.get("forwardPE") or info.get("trailingPE")
                if per: per_str = f"{per:.2f}"
                pbr = info.get("priceToBook")
                if pbr: pbr_str = f"{pbr:.2f}"

                # 時価総額の単位調整
                mcap = info.get("marketCap")
                if mcap:
                    market_cap_str = f"{mcap / 1e12:.2f} 兆円" if mcap >= 1e12 else f"{mcap / 1e8:.0f} 億円"
                
                # 配当利回りの計算
                current_price = info.get("currentPrice") or info.get("regularMarketPrice") or (df['Close'].iloc[-1] if not df.empty else None)
                d_rate = info.get("dividendRate") 
                
                if d_rate and current_price:
                    calculated_yield = (d_rate / current_price) * 100
                    div_yield_str = f"{calculated_yield:.2f} %"
                else:
                    dy = info.get("dividendYield") or info.get("trailingAnnualDividendYield")
                    if dy:
                        display_dy = dy * 100 if dy < 0.5 else dy 
                        div_yield_str = f"{display_dy:.2f} %"
                
                payout = info.get("payoutRatio")
                if payout is not None: payout_ratio_str = f"{payout * 100:.2f} %"
                
                ex_div = info.get("exDividendDate")
                if ex_div: ex_div_date_str = datetime.fromtimestamp(ex_div).strftime('%m-%d')
                
                roe = info.get("returnOnEquity")
                if roe: roe_str = f"{roe * 100:.2f} %"
                
                roa = info.get("returnOnAssets")
                if roa: roa_str = f"{roa * 100:.2f} %"
        except Exception as e:
            print(f"Info fetch error: {e}")
            # エラーが出ても株価データがあれば続行
        
        # テクニカル指標（5, 25, 75日移動平均、25日乖離率）の計算
        df['sma5'] = df['Close'].rolling(5).mean()
        df['sma25'] = df['Close'].rolling(25).mean()
        df['sma75'] = df['Close'].rolling(75).mean()
        df['kairi25'] = (df['Close'] - df['sma25']) / df['sma25'] * 100

        # データをDBに保存
        store_to_db(ticker, df)

        # フロントエンド（JavaScript）に送る形式に変換
        def to_list(series):
            return [{"time": idx.strftime("%Y-%m-%d"), "value": float(v)} for idx, v in series.items() if pd.notna(v)]

        return jsonify({
            "candles": [{"time": idx.strftime("%Y-%m-%d"), "open": float(r["Open"]), "high": float(r["High"]), "low": float(r["Low"]), "close": float(r["Close"])} for idx, r in df.iterrows()],
            "sma5": to_list(df['sma5']),
            "sma25": to_list(df['sma25']),
            "sma75": to_list(df['sma75']),
            "kairi25": to_list(df['kairi25']),
            "stats": {
                "max_price": max_price, "max_date": max_date, "min_price": min_price, "min_date": min_date,
                "volume_ranking": volume_ranking, "market_cap": market_cap_str,
                "dividend_yield": div_yield_str, "payout_ratio": payout_ratio_str, "ex_div_date": ex_div_date_str, 
                "roe": roe_str, "roa": roa_str, "per": per_str, "pbr": pbr_str
            }
        })
    except Exception as e:
        print(f"Data fetch error: {e}")
        return jsonify({"error": str(e)}), 500

# --- AI テクニカル分析ルート (チャートデータに基づきAIが解説) ---
@app.route("/analyze", methods=["POST"])
def analyze():
    req = request.get_json()
    ticker = req.get("ticker", "不明")
    recent_candles = [{"t": c["time"], "c": c["close"]} for c in req.get("candles", [])] 
    recent_kairi = [{"t": k["time"], "v": round(k["value"], 2)} for k in req.get("kairi25", [])]

    if not client: return jsonify({"error": "AI Client not initialized"}), 500

    prompt = f"""
    # 役割
    あなたは金融市場を分析するプロの投資アナリストです。
    
    # 目的
    投資判断のために、以下の図データ、出力ルール、指示内容に従って
    銘柄「{ticker}」のテクニカル指標に基づく分析をする。

    # 図データ
    直近1年間の終値推移: {recent_candles}
    直近1年間の25日移動平均線乖離率: {recent_kairi}
    
    # 出力ルール
    - 分析結果はMarkdown形式で出力すること。
    - 分析結果が不明瞭な箇所は、不明瞭な箇所を記述した上で、「判断材料不足」としてもよい。
    
    # 指示内容
    1. トレンド分析：5日(短期), 25日(中期), 75日(長期)の各移動平均線の向きから現在のトレンドを分析。
    2. 移動平均線分析：25日と75日のクロス状況(ゴールデンクロスまたはデッドクロス)と、移動平均線3本が収束することによるオーバーシュートの予兆を考察。
    3. ライン分析：明確な支持線・抵抗線が見える日付範囲と価格帯を分析。
    4. 乖離率考察：現在の25日乖離率と、過去の乖離率の推移を比較することで、売られすぎ・買われすぎの目安となる値を極値を基に考察。異常値と思われる値は異常値である旨を記載すること。
    5. 結論：1～4の内容を基に、今後の展望と、戦略アドバイスを出力。
    """
    try:
        response = client.models.generate_content(
            model=MODEL_NAME,
            contents=prompt,
            config=types.GenerateContentConfig(
                thinking_config=types.ThinkingConfig(include_thoughts=True, thinking_level="low"),
            )
        )
        return jsonify({"analysis": response.text})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# --- AI 個別株詳細調査ルート (Google検索を用いて最新ニュースや業績を分析) ---
@app.route("/analyze_full", methods=["POST"])
def analyze_full():
    req = request.get_json()
    ticker = req.get("ticker", "不明")
    
    if not client: return jsonify({"error": "AI Client not initialized"}), 500

    prompt = f"""
    # 役割
    あなたは金融市場を分析するプロの投資アナリストです。

    # 目的
    投資判断のために、以下の出力ルールと指示内容に従って
    Google Searchを用いて最新情報を取得することで
    銘柄「{ticker}」を分析する。
    
    # 出力ルール
    - 分析結果はMarkdown形式で出力すること。
    - 各項目の最後に、根拠となる出典URLを必ず明記すること。
    - 分析結果が不明瞭な箇所は、不明瞭な箇所を記述した上で、「判断材料不足」としてもよい。
    
    # 指示内容
    1. 業績抽出：最新決算の売上・利益、キャッシュフロー、業績変動要因、および今後の株主還元策（配当・自社株買い等）を抽出。
    2. 動向考察：直近1年の株価推移を分析し、上昇・下落の主因を考察。
    3. 需給分析：現在の信用倍率と推移から、個人・機関の売買動向を分析。
    4. 評価抽出：目標株価・コンセンサス情報を抽出。
    5. 結論：今後の注目イベントとリスク要因を整理。
    """
    
    try:
        # Google検索(Grounding)機能を有効化して回答を生成
        response = client.models.generate_content(
            model=MODEL_NAME,
            contents=prompt,
            config=types.GenerateContentConfig(
                tools=[types.Tool(google_search=types.GoogleSearch())],
                thinking_config=types.ThinkingConfig(include_thoughts=True, thinking_level="low"),
            )
        )
        return jsonify({"analysis": response.text})
        
    except Exception as e:
        print(f"Detailed Analysis Error: {str(e)}")
        return jsonify({"error": str(e)}), 500

# --- AI 出来高急増日背景分析ルート (特定の日の出来高急増要因を調査) ---
@app.route("/analyze_volume", methods=["POST"])
def analyze_volume():
    req = request.get_json()
    ticker = req.get("ticker", "不明")
    volume_ranking = req.get("volume_ranking", [])

    if not client: return jsonify({"error": "AI Client not initialized"}), 500

    # 日付が近い(前後1日以内)出来高急増日をグループ化
    grouped_dates = []
    if volume_ranking:
        sorted_ranking = sorted(volume_ranking, key=lambda x: x['date'])
        if sorted_ranking:
            current_group = [sorted_ranking[0]['date']]
            for i in range(1, len(sorted_ranking)):
                prev_date = datetime.strptime(sorted_ranking[i-1]['date'], '%Y-%m-%d')
                curr_date = datetime.strptime(sorted_ranking[i]['date'], '%Y-%m-%d')
                if (curr_date - prev_date).days <= 2: # 中1日(2日差)までをグループ化
                    current_group.append(sorted_ranking[i]['date'])
                else:
                    grouped_dates.append(current_group)
                    current_group = [sorted_ranking[i]['date']]
            grouped_dates.append(current_group)

    if not grouped_dates:
        return jsonify({"error": "出来高急増日のデータが見つかりません。"}), 400

    date_groups_str = "\n".join([f"- {', '.join(group)}" for group in grouped_dates])

    prompt = f"""
    # 役割
    あなたは金融市場を分析するプロの投資アナリストです。
    
    # 目的
    投資判断のために、以下の出来高データ、出力ルール、指示内容に従って
    銘柄「{ticker}」の出来高数1位～10位の日に市場で何が起きたのかを、
    Google Searchを用いて調査する。

    # 出来高データ
    {date_groups_str}
    
    # 出力ルール
    - 分析結果はMarkdown形式で出力すること。
    - 分析結果が不明瞭な箇所は、不明瞭な箇所を記述した上で、「判断材料不足」としてもよい。
    - 調査対象は、個別株そのものの調査と、日経平均・S&P500といったマクロ指標の調査を行なうこと。ただし、マクロ指標が±2%以上変動している場合は経済的なニュースだけでなく、政治的なニュースも調査すること。
    - 対象日・発生イベント・投資家心理の部分は、表形式でまとめること。
    - 各項目の最後に、根拠となる出典URLを最後に明記すること。
    - 個別株による要因は個別要因とし、マクロ指標による要因は市況要因とすることで、分けて記述すること。また、どちらの要因も影響が大きい場合は共通要因として一緒に記述すること。
    
    # 指示内容
    1. 発生イベント：決算発表、マクロ指標、経済ニュースなど、原因となった事象を調査。
    2. 投資家心理：市場がそのニュースをどう受け止め、なぜ出来高が急増したかを考察。
    3. 横断的考察：複数の日付がある場合、それらが「下落と反発」などどのような一連のストーリーを形成しているかを考察。
    """
    
    try:
        response = client.models.generate_content(
            model=MODEL_NAME,
            contents=prompt,
            config=types.GenerateContentConfig(
                tools=[types.Tool(google_search=types.GoogleSearch())],
                thinking_config=types.ThinkingConfig(include_thoughts=True, thinking_level="low"),
            )
        )
        return jsonify({"analysis": response.text})
        
    except Exception as e:
        print(f"Volume Analysis Error: {str(e)}")
        return jsonify({"error": str(e)}), 500

# --- 市況分析ルート (RSSニュースに基づきAIが解説) ---
@app.route("/analyze_market", methods=["POST"])
def analyze_market():
    req = request.get_json()
    selected_topics = req.get("topics", [])
    free_keyword = req.get("free_keyword", "")
    
    # オプション設定
    beginner_mode = req.get("beginner_mode", False)
    deep_analysis = req.get("deep_analysis", False)
    technical_mode = req.get("technical_mode", False)
    short_term = req.get("short_term", False)
    mid_term = req.get("mid_term", False)
    sector_view = req.get("sector_view", False)

    if not client: return jsonify({"error": "AI Client not initialized"}), 500

    query_parts = selected_topics[:]
    if free_keyword:
        query_parts.append(free_keyword)

    if not query_parts:
        return jsonify({"error": "分析対象のキーワードを選択または入力してください。"}), 400

    # ニュース取得
    news_text, error, date_range = fetch_rss_news(query_parts, 150)
    if error:
        return jsonify({"error": error}), 404

    # Geminiへの指示作成
    extra_instructions = ""
    if beginner_mode:
        extra_instructions += "\n- 初学者向け説明：説明の際に使用する専門用語に「※」で注釈を追加して投資初学者でも分かりやすい説明をすること。"
    if deep_analysis:
        extra_instructions += "\n- 詳細分析：市場が抱えるリスクとその影響について分析すること。市場心理とボラティリティについても分析すること。"
    if technical_mode:
        extra_instructions += "\n- テクニカル分析：トレンド(上昇または下降)、支持・抵抗、出来高について分析してください。"     
    if short_term:
        extra_instructions += "\n- 短期分析：直近1週間の短期的な目線の分析をすること。特に、信用取引の状況について分析すること。"   
    if mid_term:
        extra_instructions += "\n- 中期分析：直近1ヶ月の中期的な目線の分析をすること。特に、月間の主要な経済指標やトレンドの変化について分析すること。"   
    if sector_view:
        extra_instructions += "\n- 業種別分析：ニュース上で話題になっている各業種の状況について分析すること。"

    prompt = f"""
    # 役割
    あなたは金融市場を分析するプロの投資アナリストです。
    
    # 目的
    投資判断のために、以下のニュースデータ、出力ルール、指示内容に従って
    取得ニュースに基づく市場の分析をする。
    
    # ニュースデータ
    ニュース数と期間：{date_range}
    ニュース本文：{news_text}
    
    # 出力ルール
    - 分析結果はMarkdown形式で出力すること。
    - 分析結果が不明瞭な箇所は、不明瞭な箇所を記述した上で、「判断材料不足」としてもよい。
    - 出力結果の冒頭に、ニュース数と期間を記載すること。
    - 今後の予測は行わなくてもよい。
    
    # 指示内容
    - 分類抽出：トピックごとに見出しを分け、関連するニュースの要点を抽出。
    - 影響考察：各トピックが市場へ与える影響を考察。
    
    ## 追加の指示内容
    {extra_instructions}
    """

    try:
        response = client.models.generate_content(
            model=MODEL_NAME,
            contents=prompt,
            config=types.GenerateContentConfig(
                thinking_config=types.ThinkingConfig(include_thoughts=True, thinking_level="high"),
            )
        )
        return jsonify({
            "analysis": response.text,
            "date_range": date_range
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# --- 総合分析ルート (蓄積された複数の分析結果を統合) ---
@app.route("/analyze_total", methods=["POST"])
def analyze_total():
    req = request.get_json()
    selected_results = req.get("selected_results", [])
    
    if not selected_results:
        return jsonify({"error": "分析対象の結果が選択されていません。"}), 400

    if not client: return jsonify({"error": "AI Client not initialized"}), 500

    # 過去の分析結果を結合
    combined_texts = []
    for res in selected_results:
        text = f"【{res['title']}】\n{res['content']}"
        combined_texts.append(text)
    
    context_text = "\n\n---\n\n".join(combined_texts)

    prompt = f"""
    # 役割
    あなたは金融市場のレポートを分析するプロの投資戦略家です。

    # 目的
    最終的な投資判断をするために、以下のレポートデータ、出力ルール、指示内容に従って
    各分析結果から得られた情報を整理・分析する。
    
    # レポートデータ
    {context_text}

    # 出力ルール
    - 分析結果はMarkdown形式で出力すること。
    - 分析結果が不明瞭な箇所は、不明瞭な箇所を記述した上で、「判断材料不足」としてもよい。
    
    # 指示内容
    1. 各分析結果の要点を統合し、現在の市場環境におけるリスクとチャンスを整理。
    2. データの中に同じ業種の異なる銘柄が含まれている場合は銘柄比較をしてもよい。例えば、相対的な強みと弱み、業績推移、株主還元姿勢の違い等を解説。
    3. 短期的(1カ月以内)・中期的(1カ月～3カ月以内)・長期的(3カ月～1年以内)な視点で、総合的な投資戦略及び、その戦略の根拠を提供。
    4. 最終的な投資判断材料としての総括と、としてのアドバイスを、その金融商品を保有している人向け、保有していない人向けそれぞれに提供。
    """

    try:
        response = client.models.generate_content(
            model=MODEL_NAME,
            contents=prompt,
            config=types.GenerateContentConfig(
                thinking_config=types.ThinkingConfig(include_thoughts=True, thinking_level="high"),
            )
        )
        return jsonify({"analysis": response.text})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# --- AI 会社説明取得ルート (Google Searchを活用) ---
@app.route("/get_company_info", methods=["POST"])
def get_company_info():
    req = request.get_json()
    ticker = req.get("ticker", "不明")
    name = req.get("name", "不明")
    
    if not client: return jsonify({"error": "AI Client not initialized"}), 500

    # 現在の株価等の補助データを取得してAIに渡す
    price_info = ""
    try:
        stock_obj = yf.Ticker(ticker)
        # infoから最新価格を取得（currentPrice または regularMarketPrice）
        current_price = stock_obj.info.get("currentPrice") or stock_obj.info.get("regularMarketPrice")
        if current_price:
            currency = stock_obj.info.get("currency", "JPY")
            price_info = f"現在の株価: {current_price} {currency}"
    except Exception as e:
        print(f"Price fetch error in company info: {e}")

    prompt = f"""
    # 役割
    あなたは特定の企業の情報を調査することを得意とする企業アナリストです。
    
    # 目的
    簡潔な企業情報を知るために、
    以下の出力ルールと指示内容に従って
    日本株銘柄「{name} ({ticker})」について、
    Google Searchを用いて最新情報を調査する。
    
    # 出力ルール
    - 回答はMarkdown形式で出力すること。
    - 各項目のタイトルの後に改行すること。
    - 各項目1〜4行程度で簡潔にまとめること。
    - 出力結果の最後の部分に、「会社URL:」として、会社の公式サイトURLを必ず記載すること。
    - 分析結果が不明瞭な箇所は、不明瞭な箇所を記述した上で、「判断材料不足」としてもよい。
    
    # 指示内容
    1. 事業内容と優位性: 主要な事業を記述し、その後に直近1年の中で力を入れている事業を記述。その後に、競合他社に対する優位性を記述。
    2. 活動拠点: 売上高構成比率の大きさの観点から、売上高の順に国内または海外の拠点記述。
    3. 配当実績と優待: 過去10年間の配当実績を調査して取得して配当実績の推移(増加・減少・横ばい等)を評価。加えて、現在から一年前までの期間で、株主優待制度の実施状況・優待の内容を記述。
    """
    
    try:
        response = client.models.generate_content(
            model=MODEL_LITE,
            contents=prompt,
            config=types.GenerateContentConfig(
                tools=[types.Tool(google_search=types.GoogleSearch())]
            )
        )
        return jsonify({"info": response.text})
    except Exception as e:
        print(f"Company Info Error: {str(e)}")
        return jsonify({"error": str(e)}), 500

# --- PDF出力ルート (pdfkit使用) ---
@app.route("/export_pdf", methods=["POST"])
def export_pdf():
    try:
        req = request.get_json()
        title = req.get("title", "分析レポート")
        content_md = req.get("content", "")
        ticker = req.get("ticker", "")

        # MarkdownをHTMLに変換
        content_html = markdown.markdown(content_md, extensions=['tables', 'fenced_code'])

        # PDF用のHTMLテンプレート
        # CSSを大幅に強化してPDFのレイアウトを整える
        full_html = f"""
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                @page {{
                    size: A4;
                    margin: 20mm;
                }}
                body {{
                    font-family: "Meiryo", "MS Gothic", "IPAexGothic", "IPAGothic", sans-serif;
                    line-height: 1.6;
                    color: #333;
                    font-size: 11pt;
                }}
                h1 {{
                    color: #1a237e;
                    border-bottom: 3px solid #1a237e;
                    padding-bottom: 10px;
                    font-size: 24pt;
                    margin-bottom: 20pt;
                }}
                h2 {{
                    color: #0d47a1;
                    border-left: 8px solid #0d47a1;
                    padding-left: 15px;
                    margin-top: 25pt;
                    margin-bottom: 15pt;
                    font-size: 18pt;
                    background-color: #f5f5f5;
                    padding-top: 5px;
                    padding-bottom: 5px;
                }}
                h3 {{
                    color: #1565c0;
                    font-size: 14pt;
                    border-bottom: 1px solid #ddd;
                    margin-top: 15pt;
                }}
                p {{
                    margin-bottom: 10pt;
                    word-wrap: break-word;
                }}
                table {{
                    width: 100%;
                    border-collapse: collapse;
                    margin: 20pt 0;
                    table-layout: fixed;
                }}
                th, td {{
                    border: 1px solid #999;
                    padding: 10px;
                    text-align: left;
                    word-wrap: break-word;
                }}
                th {{
                    background-color: #e3f2fd;
                    font-weight: bold;
                }}
                tr:nth-child(even) {{
                    background-color: #fafafa;
                }}
                .header {{
                    text-align: right;
                    font-size: 9pt;
                    color: #666;
                    margin-bottom: 20pt;
                    border-bottom: 1px solid #eee;
                }}
                .footer {{
                    text-align: center;
                    font-size: 8pt;
                    color: #999;
                    margin-top: 30pt;
                    border-top: 1px solid #eee;
                    padding-top: 10pt;
                }}
                blockquote {{
                    margin: 15pt 0;
                    padding: 10pt 20pt;
                    background-color: #f9f9f9;
                    border-left: 5px solid #ccc;
                    font-style: italic;
                }}
                ul, ol {{
                    margin-bottom: 15pt;
                    padding-left: 25pt;
                }}
                li {{
                    margin-bottom: 5pt;
                }}
            </style>
        </head>
        <body>
            <div class="header">発行日: {datetime.now().strftime('%Y-%m-%d %H:%M')}</div>
            <h1>{title} {'(' + ticker + ')' if ticker else ''}</h1>
            <div class="content">
                {content_html}
            </div>
            <div class="footer">Generated by 日経225スマートAI分析</div>
        </body>
        </html>
        """

        # wkhtmltopdfのパス設定
        # WindowsとLinux(Render)の両方に対応
        path_wkhtmltopdf_win = r'C:\Program Files\wkhtmltopdf\bin\wkhtmltopdf.exe'
        path_wkhtmltopdf_linux = '/usr/bin/wkhtmltopdf'
        
        config = None
        if os.path.exists(path_wkhtmltopdf_linux):
            # Linux (Render) 環境
            config = pdfkit.configuration(wkhtmltopdf=path_wkhtmltopdf_linux)
        elif os.path.exists(path_wkhtmltopdf_win):
            # Windows ローカル環境
            config = pdfkit.configuration(wkhtmltopdf=path_wkhtmltopdf_win)
        
        # オプション設定
        options = {
            'encoding': "UTF-8",
            'enable-local-file-access': None,
            'quiet': '',
            'no-outline': None,
            'margin-top': '20mm',
            'margin-right': '20mm',
            'margin-bottom': '20mm',
            'margin-left': '20mm',
            'page-size': 'A4',
            'disable-smart-shrinking': None,
            'print-media-type': None
        }
        
        # PDF生成
        try:
            pdf_bytes = pdfkit.from_string(full_html, False, options=options, configuration=config)
        except OSError as e:
            if "No wkhtmltopdf executable found" in str(e):
                return jsonify({"error": "サーバーに wkhtmltopdf がインストールされていません。公式サイトからインストールするか、wkhtmltopdf.exeを配置してください。"}), 500
            raise e
        except Exception as e:
            print(f"wkhtmltopdf runtime error: {e}")
            return jsonify({"error": f"PDF Generation Error: {str(e)}"}), 500

        pdf_io = BytesIO(pdf_bytes)
        filename = f"{title}_{datetime.now().strftime('%Y%m%d%H%M%S')}.pdf"
        
        return send_file(
            pdf_io,
            mimetype='application/pdf',
            as_attachment=True,
            download_name=filename
        )
    except Exception as e:
        print(f"PDF Export Error: {e}")
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    # 開発用サーバーの起動
    # Renderの環境変数PORTがある場合はそれを使用し、なければ5000を使う
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
