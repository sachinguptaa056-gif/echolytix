# EcholytiX — Assistive Communication AI

> *"No voice should go unheard."*

[![CI](https://github.com/sachinguptaa056-gif/echolytix/actions/workflows/ci.yml/badge.svg)](https://github.com/sachinguptaa056-gif/echolytix/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19.0-61dafb.svg)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-6.2-646cff.svg)](https://vitejs.dev/)
[![Node](https://img.shields.io/badge/Node->=22.5-green.svg)](https://nodejs.org/)

**EcholytiX** is a production-ready, browser-based assistive communication platform designed for individuals with speech, neurological, or motor impairments (including ALS, stroke, cerebral palsy, and locked-in syndrome).

It translates **eye blinks (Morse code)**, **hand sign gestures**, **manual Morse taps**, and **wireless smartphone camera inputs** into audible speech and text in real time — using fully on-device computer vision (MediaPipe) and lightweight neural classifiers.

Repository: **[https://github.com/sachinguptaa056-gif/echolytix](https://github.com/sachinguptaa056-gif/echolytix)**

---

## Key Features

1. **Blink-to-Morse Communication**:
   - Real-time facial landmark eye tracking with adaptive Eye Aspect Ratio (EAR) calibration and moving average smoothing.
   - Dual-eye distinction: short blinks for dots (`.`), prolonged blinks for dashes (`-`), and sustained single-eye winks for backspace/delete.
   - Zero camera hardware leakage on tab switches or component unmounts.

2. **Sign Language Recognition**:
   - MediaPipe Hand Landmarker tracking with geometric 3D vector and joint-angle classification.
   - Real-time finger state indicators (Thumb, Index, Middle, Ring, Pinky status) and dynamic confidence scoring.
   - Interactive SVG skeleton rendering with custom camera viewport.

3. **Morse Code Translator**:
   - Manual tap input, keyboard spacebar trigger, and Bluetooth assistive switch compatibility.
   - Dynamic duration classification (dots vs. dashes) with live auditory sidetone feedback.

4. **Remote Camera Receiver & Sender**:
   - Wirelessly connect a smartphone to act as an external camera sensor.
   - Instant local QR code generation (100% offline, zero third-party dependencies).
   - Real-time Server-Sent Events (SSE) stream transmitting Morse symbols, spelled words, audio beeps, and active mode synchronization (`Blink`, `Sign`, `Morse`, `TTS`).
   - Clean disconnect lifecycle detection and configurable network interfaces (Local Wi-Fi, Ethernet, or custom HTTPS tunnels like `ngrok`).

5. **Text-to-Speech & Smart Phrase Expansion**:
   - Web Speech Synthesis with volume, pitch, and rate customization.
   - Categorized phrase boards for quick emergency and medical requests.
   - Optional AI phrase completion powered by Google Gemini API.

6. **Caregiver Dashboard & Emergency SOS**:
   - High-priority audible and visual distress beacon.
   - SQLite persistence for phrase logs, calibration profiles, and caregiver contact alerts.

---

## Tech Stack

| Domain | Technology |
|---|---|
| **Frontend UI** | React 19, TypeScript, Tailwind CSS 4, Motion |
| **Client Bundler** | Vite 6 |
| **Computer Vision** | Google MediaPipe Tasks Vision (Face & Hand Landmarkers, WASM) |
| **Backend Server** | Express 4, Server-Sent Events (SSE), Node.js >= 22.5 |
| **Database** | SQLite with WAL mode (`better-sqlite3` compatible queries) |
| **DevOps & CI** | Docker, GitHub Actions, esbuild, Netlify & Render configs |

---

## Getting Started

### Prerequisites
- **Node.js**: `>= 22.5.0`
- **npm**: `>= 10.0.0`

### Installation & Local Development

```bash
# Clone the repository
git clone https://github.com/sachinguptaa056-gif/echolytix.git
cd echolytix

# Install dependencies
npm install

# Start development server
npm run dev
```

Open **[http://localhost:3000](http://localhost:3000)** in your browser.

> [!TIP]
> To enable AI phrase prediction, copy `.env.example` to `.env` and supply your `GEMINI_API_KEY`. The core application and all vision models function completely offline without any API keys.

---

## Available Scripts

| Command | Description |
|---|---|
| `npm run dev` | Starts the Express server with Vite middleware on port 3000 |
| `npm run lint` | Runs TypeScript type verification (`tsc --noEmit`) |
| `npm run build` | Builds production client assets and bundles server to `dist/server.cjs` |
| `npm start` | Runs the compiled production bundle (`node dist/server.cjs`) |
| `npm run clean` | Removes `dist/` and build caches |

---

## Docker Deployment

Build and run EcholytiX using the included multi-stage `Dockerfile`:

```bash
# Build Docker image
docker build -t echolytix .

# Run container
docker run -p 3000:3000 echolytix
```

---

## Project Structure

```
├── .github/workflows/ci.yml       # GitHub Actions CI pipeline
├── public/
│   ├── favicon.svg               # Application icon
│   ├── models/                   # MediaPipe vision models (.task)
│   └── wasm/                     # MediaPipe WASM runtime binaries
├── scripts/
│   ├── generate-redirects.js     # SPA redirect rule generator
│   └── train_*.ts                # Neural model training scripts
├── src/
│   ├── components/               # UI & feature modules
│   │   ├── BlinkToText.tsx       # Eye-blink tracking & Morse decoding
│   │   ├── SignLanguage.tsx      # MediaPipe hand tracking & gestures
│   │   ├── MorseTranslator.tsx   # Manual tap Morse input
│   │   ├── RemoteReceiver.tsx    # Laptop receiver with QR & SSE stream
│   │   ├── RemoteSender.tsx      # Mobile camera sensor client
│   │   ├── TextToSpeech.tsx      # TTS phraseboard
│   │   ├── Dashboard.tsx         # Patient calibration & phrase logs
│   │   ├── SosModal.tsx          # Emergency distress beacon
│   │   └── AuthPortal.tsx        # Secure authentication & profiles
│   ├── data/                     # Offline model weights (JSON)
│   ├── utils/                    # Vision, sound, Morse, and remote helpers
│   ├── App.tsx                   # App shell & routing
│   ├── main.tsx                  # React DOM mount point
│   └── index.css                 # Theme & camera graphic styling
├── server.ts                     # Express API & SSE streaming
├── database.ts                   # SQLite database interface
├── index.html                    # HTML entry point
├── render.yaml                   # Render deployment configuration
├── netlify.toml                  # Netlify deployment configuration
└── Dockerfile                    # Container configuration
```

---

## License & Contributing

Contributions and issue reports are welcome! Please review [CONTRIBUTING.md](CONTRIBUTING.md) and [ARCHITECTURE.md](ARCHITECTURE.md) before submitting pull requests.
