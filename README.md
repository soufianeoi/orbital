# Orbital — Real-Time Satellite & Space Debris Tracker

A 3D web application that tracks the International Space Station, Starlink constellation, active satellites, and space debris in real-time on an interactive globe.

![screenshot](https://user-images.githubusercontent.com/placeholder.png)

## Features

- **Real-Time ISS Tracking** — Live position with orbit trail
- **Starlink Constellation** — All 5,000+ satellites rendered as a swarm
- **Space Debris Layer** — 30,000+ tracked debris pieces (spent rockets, dead satellites)
- **Orbit Trails** — Fading path showing last 90 minutes of orbit
- **Pass Predictor** — Click your location to see when satellites will fly overhead
- **Collision Awareness** — Visualize how crowded Earth's orbit really is
- **Dark Space Aesthetic** — NASA Black Marble Earth, glowing orbit lines, atmospheric halo

## Data Sources

- [Celestrak](https://celestrak.org/) — TLE (orbit) data for 20,000+ objects
- [N2YO](https://www.n2yo.com/) — Real-time satellite positions
- [satellite.js](https://github.com/shashwatak/satellite-js) — Orbit propagation (client-side)

## Tech Stack

- Vite + vanilla JS (no React/Tailwind)
- [globe.gl](https://globe.gl/) — 3D WebGL globe
- [satellite.js](https://github.com/shashwatak/satellite-js) — SGP4 orbit propagation
- Hand-written CSS, Inter font, dark space theme

## Getting Started

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

The app fetches TLE data from Celestrak on startup and propagates orbits client-side using SGP4. No API keys needed.

## Build

```bash
npm run build
```

Output goes to `dist/`.

## Deploy

### GitHub Pages

1. Push this repo to GitHub
2. Go to **Settings → Pages**
3. Set **Source** to "GitHub Actions"
4. The included workflow auto-deploys

### Netlify Drop

Drag the `dist/` folder to [netlify.com/drop](https://netlify.com/drop).

## License

MIT
