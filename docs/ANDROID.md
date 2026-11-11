# Android-App

Die Android-App ist dieselbe Oberfläche wie im Browser, verpackt als eigenständige App – mit sicherem
Schlüsselspeicher, optionaler Sperre per Fingerabdruck und Mikrofon-Zugriff fürs Gegensprechen.

Sie wird nicht über den Play Store verteilt, sondern von GitHub für dich gebaut. Das ist gewollt:
Deine App, dein Schlüssel, kein Dritter dazwischen.

## App herunterladen und installieren

1. Auf GitHub im Projekt den Reiter **Actions** öffnen und links **Android-App** wählen.
2. Den neuesten erfolgreichen Lauf (grüner Haken) anklicken.
3. Unten unter **Artifacts** `home-hub-android` herunterladen und die ZIP-Datei entpacken – darin
   liegt die `.apk`-Datei.
4. Die APK aufs Handy bringen (z. B. per USB, eigener Cloud oder Messenger an dich selbst) und
   antippen. Android fragt einmalig, ob diese Quelle Apps installieren darf – erlauben.

Einen neuen Lauf startest du jederzeit über **Run workflow**; außerdem baut GitHub die App bei jeder
Änderung am Projekt neu.

## Erster Start

1. Die App fragt nach der **Adresse deines Hubs**: `https://` gefolgt von deinem Namen aus
   [FERNZUGRIFF.md](FERNZUGRIFF.md), z. B. `https://rechner.mein-netz.ts.net`.
2. Anmelden mit Benutzername, Passwort und Code aus der Authenticator-App.
3. Empfohlen: unter **Mehr › Konto & Sicherheit** die **App-Sperre** einschalten. Dann verlangt die
   App nach einer Minute im Hintergrund Fingerabdruck, Gesicht oder Geräte-PIN.
4. Beim ersten Gegensprechen fragt Android nach dem Mikrofon – erlauben.

Die App bleibt angemeldet, bis du dich abmeldest oder das Gerät 30 Tage nicht benutzt wurde.

## Eigener Signaturschlüssel (empfohlen)

Ohne weitere Einrichtung baut GitHub eine sogenannte Debug-Version. Sie funktioniert vollständig, hat
aber zwei Nachteile: Android zeigt beim Installieren deutlichere Warnungen, und eine neue Version
lässt sich nur dann einfach „drüber installieren“, wenn sie mit demselben Schlüssel signiert wurde –
bei Debug-Versionen ist das nicht garantiert.

Mit einem eigenen Schlüssel baut GitHub stattdessen eine signierte Release-Version:

1. Schlüssel erzeugen (einmalig, auf deinem Rechner; `keytool` gehört zu Java):

   ```bash
   keytool -genkeypair -v -keystore home-hub.keystore -alias homehub \
     -keyalg RSA -keysize 4096 -validity 10000
   ```

   Passwort merken und die Datei **sicher aufbewahren** – ohne sie kannst du später keine Updates
   mehr über die vorhandene App installieren.

2. Die Datei in Text umwandeln:

   ```bash
   base64 -w0 home-hub.keystore
   ```

3. Auf GitHub unter **Settings › Secrets and variables › Actions** vier „Repository secrets“ anlegen:

   | Name | Inhalt |
   | --- | --- |
   | `ANDROID_KEYSTORE_BASE64` | die Ausgabe aus Schritt 2 |
   | `ANDROID_KEYSTORE_PASSWORD` | das Passwort des Schlüsselspeichers |
   | `ANDROID_KEY_ALIAS` | `homehub` |
   | `ANDROID_KEY_PASSWORD` | das Passwort des Schlüssels (meist dasselbe) |

4. Den Lauf **Android-App** neu starten. Das Ergebnis ist jetzt eine signierte Release-APK. Wer
   vorher die Debug-Version installiert hatte, muss sie einmalig deinstallieren.

## Aktualisieren

Neue APK wie oben herunterladen und installieren – Anmeldung und Einstellungen bleiben erhalten
(bei signierten Versionen mit gleichem Schlüssel).

Die App prüft beim Start, ob sie zum Hub passt. Ist der Hub neuer, als die App versteht, sagt sie das
und bittet um ein Update.

## Web-App statt APK

Wer nichts installieren möchte: `https://<dein Hub>` in Chrome öffnen und im Menü **„Zum
Startbildschirm hinzufügen“** bzw. **„App installieren“** wählen. Das ergibt ein App-Symbol und eine
Vollbild-Ansicht. Unterschiede zur APK: keine App-Sperre per Fingerabdruck, und die Anmeldung liegt
im Browser statt im Android-Schlüsselspeicher.

## Selbst bauen

Voraussetzungen: Node.js ab 22.13, JDK 21, Android SDK (am einfachsten über Android Studio).

```bash
npm ci
npm run android:sync -w web        # baut die Oberfläche und kopiert sie ins Android-Projekt
cd web/android
./gradlew assembleDebug            # Ergebnis: app/build/outputs/apk/debug/app-debug.apk
```

`npm run android:open -w web` öffnet das Projekt in Android Studio.
