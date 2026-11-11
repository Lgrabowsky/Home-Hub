# Entwicklung

Für alle, die am Projekt weiterbauen möchten.

## Aufbau

```
shared/   Typen, die Hub und App teilen (Geräte-Modell, Nachrichten, Einstellungen) – der Vertrag
hub/      Node.js-Server (TypeScript, Fastify, SQLite über node:sqlite)
  src/auth, src/security   Anmeldung, Sitzungen, Verschlüsselung, Protokoll
  src/http                 Server, Schutzmaßnahmen, REST- und WebSocket-Routen
  src/integrations         je Hersteller eine Anbindung + der Video-Dienst (go2rtc)
  src/sim                  Simulatoren der Geräte (für Tests und den Demo-Modus)
  test/                    Tests (vitest)
web/      Die App (React, Vite, Tailwind, zustand, TanStack Query)
  src/pages, src/components  Oberfläche
  src/store, src/lib         Zustand, Verbindung zum Hub, Live-Video
  android/                   Android-Hülle (Capacitor)
deploy/   Docker Compose, Caddy
```

**Grundidee:** Jede Anbindung übersetzt ihr Gerät in ein herstellerneutrales Modell (`Entity` in
`shared/src/index.ts`: Licht, Jalousie, Kontakt, Kamera, Tür …) und schreibt es in den Zustandsspeicher
des Hubs. Die App kennt nur dieses Modell – deshalb fühlt sich alles wie ein Produkt an. Änderungen
gehen als WebSocket-Nachrichten an alle angemeldeten Apps, gefiltert nach deren Rechten.

Live-Video: Der Hub startet [go2rtc](https://github.com/AlexxIT/go2rtc) als eigenen, nach außen
verschlossenen Prozess, gibt ihm die Kamera-Adressen und vermittelt authentifiziert zwischen App und
go2rtc (WebRTC, ersatzweise MP4 über den WebSocket).

## Voraussetzungen

- Node.js ab 22.13
- für Live-Video: `go2rtc` (1.9.x) und `ffmpeg` im Pfad – oder `GO2RTC_BIN`/`FFMPEG_BIN` setzen.
  Ohne sie läuft alles außer Video.

## Befehle

```bash
npm ci                 # Abhängigkeiten
npm run dev            # Hub (:8080, lädt bei Änderungen neu) + App (http://localhost:5173)
HUB_DEMO=1 npm run dev # dasselbe mit simulierten Geräten; Einrichtungscode DEMO-DEMO-DEMO
npm run typecheck      # Typprüfung aller Teile
npm test               # Tests des Hubs (Anmeldung/Sicherheit und jede Anbindung gegen ihren Simulator)
npm run build          # App und Hub bauen (hub/dist, web/dist)
npm run demo           # bauen und im Demo-Modus starten
```

## Demo-Modus und Simulatoren

`HUB_DEMO=1` startet für jedes Gerät einen Simulator im selben Prozess (`hub/src/sim`) und richtet die
Anbindungen darauf ein. Die Simulatoren sprechen das dokumentierte Protokoll der echten Geräte
(gleiche Pfade, Anmeldeverfahren, Fehlercodes); die Anbindungen merken keinen Unterschied. Die Tests
nutzen dieselben Simulatoren.

Im Demo-Modus lassen sich die Geräte-Einstellungen nicht ändern, und die Zwei-Faktor-Pflicht ist aus.

## Eine Anbindung ändern oder ergänzen

1. Vertrag in `hub/src/integrations/types.ts` lesen (`start`, `stop`, `setActive`, `diagnostics`).
2. Geräte als `Entity` in den `StateStore` schreiben (`replace`, `patch`, `setService` für den Zustand).
3. Befehle kommen über `IntegrationManager` (`hub/src/integrations/manager.ts`) bzw. die Routen in
   `hub/src/http/routes`.
4. Simulator und Tests mitziehen – ein Test gegen den Simulator ist die Messlatte.

Regeln, die sich bewährt haben: `start()` kehrt sofort zurück und wirft nie, weil ein Gerät fehlt;
jeder Netzaufruf hat eine Zeitgrenze; ein Gerät, das nicht antwortet, wird als „nicht erreichbar“
markiert statt entfernt; Meldungen an Menschen sind deutsch und ohne Fachbegriffe; Zugangsdaten
erscheinen nie in Protokoll, Diagnose oder Fehlermeldung.

## Sicherheit beim Entwickeln

- Neue Routen sind automatisch geschützt (Anmeldung nötig). Öffentliche Routen müssen ausdrücklich
  `config: { access: 'public' }` tragen – davon gibt es bewusst nur eine Handvoll.
- Rechte je Route über `config: { permission: '…' }`.
- Einstellungen mit Geheimnissen laufen über `SettingsStore` (verschlüsselt, maskiert beim Lesen).

## Veröffentlichen

- **Abbild:** Der CI-Lauf baut bei jedem Push das Docker-Abbild; für den Hauptzweig und für
  Versions-Tags (`v1.2.3`) wird es nach `ghcr.io/lgrabowsky/home-hub` veröffentlicht.
- **Android:** Der Lauf „Android-App“ baut die APK (siehe [ANDROID.md](ANDROID.md)).
