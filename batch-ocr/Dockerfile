# Workflow service image for batch-ocr: Node.js plus the OCR tools.
FROM node:24.22.3-trixie-slim

# Tesseract reads text from page images. Poppler's pdftoppm and pdfinfo turn
# PDF pages into images and count pages. tesseract-ocr includes English data.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# ocrDocument runs one Tesseract process per CPU, so keep each one to a
# single thread.
ENV OMP_THREAD_LIMIT=1

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# Docker-based workflow services still need a Start Command in the Dashboard
# (node dist/main.js), even with this CMD.
CMD ["node", "dist/main.js"]
