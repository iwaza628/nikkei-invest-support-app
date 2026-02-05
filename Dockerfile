# 1. ベースとなるOS（Pythonが入った軽量Linux）を指定
FROM python:3.11-slim

# 2. 必要なツールをインストール (wget, fontconfig, xfonts等)
RUN apt-get update && apt-get install -y \
    wget \
    fontconfig \
    libjpeg62-turbo \
    libx11-6 \
    libxcb1 \
    libxext6 \
    libxrender1 \
    xfonts-75dpi \
    xfonts-base \
    fonts-ipafont-gothic \
    fonts-ipafont-mincho \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 3. wkhtmltopdf を公式サイトから直接ダウンロードしてインストール
# Debian Bookworm (Python 3.11-slim) 用のパッケージを取得
RUN wget https://github.com/wkhtmltopdf/packaging/releases/download/0.12.6.1-3/wkhtmltox_0.12.6.1-3.bookworm_amd64.deb \
    && apt-get update \
    && apt-get install -y ./wkhtmltox_0.12.6.1-3.bookworm_amd64.deb \
    && rm wkhtmltox_0.12.6.1-3.bookworm_amd64.deb

# 4. フォントキャッシュの更新
RUN fc-cache -fv

# 5. 作業するフォルダを決定
WORKDIR /app

# 6. 必要なライブラリのリストをコピーしてインストール
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 7. プログラムのファイルを全部コピー
COPY . .

# 8. アプリを起動するコマンド（gunicornを使用）
CMD ["sh", "-c", "gunicorn --bind 0.0.0.0:${PORT:-5000} --timeout 120 app:app"]
