FROM python:3.12-slim-bookworm
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
RUN useradd --create-home appuser && mkdir -p uploads && chown -R appuser:appuser /app
USER appuser
EXPOSE 8000
CMD ["python", "main.py"]
