# ── Stage 1: Build React frontend ────────────────────────────────────────────
FROM node:20-slim AS frontend-build

WORKDIR /build/frontend
COPY frontend/package*.json ./
RUN npm ci --legacy-peer-deps
COPY frontend/ ./

ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL

RUN npm run build


# ── Stage 2: Python backend + bundled frontend ────────────────────────────────
FROM python:3.12-slim

# System dependencies: Tesseract OCR, Poppler (pdf2image), Playwright deps
# Note: build-essential removed — not needed since rapidocr-onnxruntime is disabled
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-eng \
    poppler-utils \
    wget \
    curl \
    ca-certificates \
    fonts-liberation \
    libfontconfig1 \
    libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install Playwright + Chromium
RUN pip install --no-cache-dir playwright==1.58.0
RUN playwright install chromium --with-deps

# Copy backend source
COPY backend/ /app/

# Copy built frontend from Stage 1
COPY --from=frontend-build /build/frontend/dist /app/static/

# Runtime directories
RUN mkdir -p /app/uploads /app/data/keka_input /app/data/keka_output

EXPOSE 8003

ENV PYTHONUNBUFFERED=1

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8003"]
