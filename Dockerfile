# 1. ベースとなるOS（Pythonが入った軽量Linux）を指定
FROM python:3.11-slim

# 2. 日本語フォントとPDF作成に必要なソフト(wkhtmltopdf)をインストール
# 画像処理やフォント管理に必要なライブラリを追加
RUN apt-get update && apt-get install -y \
    wkhtmltopdf \
    fonts-ipafont-gothic \
    fonts-ipafont-mincho \
    fontconfig \
    libjpeg62-turbo \
    libx11-6 \
    libxext6 \
    libxrender1 \
    xfonts-75dpi \
    xfonts-base \
    && fc-cache -fv \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 3. 作業するフォルダを決定
WORKDIR /app

# 4. 必要なライブラリのリストをコピーしてインストール
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 5. プログラムのファイルを全部コピー
COPY . .

# 6. アプリを起動するコマンド（gunicornを使用）
# シェル経由で環境変数を確実に展開させ、かつシグナルハンドリングを適切に行う
CMD ["sh", "-c", "gunicorn --bind 0.0.0.0:${PORT:-5000} --timeout 120 app:app"]
