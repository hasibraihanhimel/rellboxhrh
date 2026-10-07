FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir --disable-pip-version-check -r requirements.txt \
    && useradd --create-home --uid 10001 reelbox

COPY . .
RUN chown -R reelbox:reelbox /app
USER reelbox

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.getenv('PORT','3000') + '/healthz', timeout=3)"

CMD ["sh", "-c", "exec uvicorn api:app --host ${HOST:-0.0.0.0} --port ${PORT:-3000}"]
