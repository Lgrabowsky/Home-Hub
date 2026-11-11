# Sicherheit & Datenschutz

Home Hub steuert Türöffner und zeigt Kamerabilder. Entsprechend streng ist es gebaut. Dieses Dokument
beschreibt, **was geschützt wird, wie – und was du selbst beitragen musst.**

## Grundsätze

1. **Alles bleibt bei dir.** Der Hub läuft in deinem Zuhause. Es gibt keinen Server des Herstellers
   dieser App, kein Benutzerkonto bei einem Dritten, keine Statistik, keine Fernwartung.
2. **Ein einziger Zugang.** Die Apps sprechen nur mit dem Hub. Türstationen, Kameras, myGEKKO und
   Lautsprecher bleiben im Heimnetz und werden nie direkt ins Internet gestellt.
3. **Standardmäßig verboten.** Jede Funktion des Hubs verlangt eine gültige Anmeldung und das
   passende Recht – erlaubt ist nur, was ausdrücklich freigegeben wurde.

## Anmeldung

- **Passwort** (mindestens 10 Zeichen), gespeichert als scrypt-Hash – selbst wer die Datenbank stiehlt,
  kennt die Passwörter nicht.
- **Zweiter Faktor** (Code aus einer Authenticator-App, TOTP) ist für alle Pflicht, solange du es in
  **Geräte & Dienste › Allgemein** nicht abschaltest. Ein Code lässt sich kein zweites Mal verwenden.
  Acht **Wiederherstellungscodes** helfen, wenn das Telefon weg ist; jeder gilt genau einmal.
- **Bremse gegen Erraten:** Nach wenigen Fehlversuchen wird die Kombination aus Konto und Absender
  gesperrt, zunächst für eine Minute, dann länger. Wer viele Konten durchprobiert, wird als Absender
  gesperrt. Alles landet im Protokoll.
- **Ersteinrichtung nur mit Code:** Das erste Konto lässt sich nur mit dem Einrichtungscode anlegen,
  den der Hub auf seiner Konsole ausgibt. Wer den Hub „zuerst findet“, kann ihn also nicht übernehmen.
- **Sitzungen:** Nach der Anmeldung erhält das Gerät ein zufälliges Sitzungsgeheimnis (256 Bit). Der
  Hub speichert davon nur einen Fingerabdruck. Im Browser liegt es in einem Cookie, das Skripte nicht
  lesen können und das der Browser nur an den Hub selbst schickt; in der Android-App im
  hardwaregeschützten Schlüsselspeicher. Sitzungen enden nach 30 Tagen ohne Nutzung (einstellbar).
  Unter **Konto & Sicherheit** siehst du alle angemeldeten Geräte und kannst jedes einzeln abmelden.
  Passwortwechsel und das Zurücksetzen durch einen Administrator melden alle anderen Geräte ab.

## Rechte

| Recht | Bedeutung |
| --- | --- |
| Haus bedienen | Licht, Jalousien, Heizung, Geräte, Szenen |
| Musik steuern | Lautsprecher und Spotify |
| Kameras ansehen / steuern | Live-Bild bzw. Schwenken, Licht, Sirene, Gegensprechen |
| Türstationen ansehen | Live-Bild, Verlauf, Gegensprechen |
| **Türen öffnen** | eigenes Recht, getrennt vergeben |
| Fenster & Alarm ansehen | Kontakte und Alarmzustand |

Administratoren dürfen alles. Mitglieder dürfen alles bedienen. Gäste nur, was du ankreuzst. Wem ein
Recht fehlt, dem schickt der Hub die zugehörigen Daten gar nicht erst – die App blendet sie nicht
bloß aus.

Türöffnungen brauchen in der App eine bewusste Schiebe-Geste und werden mit Person, Zeit und
Absender protokolliert.

## Was auf dem Hub gespeichert wird

| Daten | Schutz | Aufbewahrung |
| --- | --- | --- |
| Zugangsdaten der Geräte, Adressen, Einstellungen | AES-256-GCM-verschlüsselt, Passwörter werden nie an eine App zurückgegeben | bis du sie löschst |
| Benutzer: Name, Passwort-Hash, zweiter Faktor | Passwort als scrypt-Hash, TOTP-Geheimnis verschlüsselt, Wiederherstellungscodes gehasht | bis das Konto gelöscht wird |
| Sitzungen: Gerätename, letzte Nutzung, letzte Adresse | nur Fingerabdruck des Sitzungsgeheimnisses | bis Abmeldung/Ablauf |
| Protokoll: Anmeldungen, Türöffnungen, Änderungen | – | 1 Jahr |
| Verlauf der Türstationen (Bilder von Klingeln/Bewegung) | Bilder AES-256-GCM-verschlüsselt | 90 Tage (einstellbar) |
| Spotify-Verknüpfung | verschlüsselt | bis „Trennen“ |

Live-Video wird **nicht** aufgezeichnet. Die App selbst speichert auf dem Handy nichts außer der
Anmeldung, der Hub-Adresse und Kleinigkeiten wie dem gewählten Farbschema.

### Der Hauptschlüssel

Alle Verschlüsselung auf dem Hub hängt an einem Hauptschlüssel:

- **Standard:** Der Hub erzeugt ihn beim ersten Start und legt ihn als `master.key` ins
  Datenverzeichnis (nur für den Hub lesbar). Das schützt gegen versehentliches Preisgeben einzelner
  Dateien, aber nicht gegen jemanden, der das ganze Datenverzeichnis kopiert.
- **Strenger:** Setze `HUB_MASTER_KEY` in `deploy/.env` (`openssl rand -base64 32`). Dann liegt der
  Schlüssel nicht bei den Daten; eine gestohlene Sicherung des Datenverzeichnisses ist ohne ihn
  wertlos. Bewahre den Wert getrennt auf – ohne ihn sind die gespeicherten Geräte-Zugangsdaten und
  der Bildverlauf nicht mehr lesbar.

## Schutz der Verbindung

- Ausschließlich **https**; der Hub sendet strenge Sicherheitsvorgaben an den Browser (u. a. eine
  Content-Security-Policy, die das Nachladen fremder Inhalte unterbindet).
- **Schutz vor fremden Webseiten:** Anfragen, die etwas verändern, werden nur von der App selbst
  angenommen (Herkunftsprüfung, eigener Anfrage-Kopf, Cookie nur für direkte Aufrufe).
- **Live-Video:** Der Video-Dienst ist von außen nicht ansprechbar. Eine App erhält nach der Anmeldung
  ein Einmal-Ticket für genau eine Kamera, über das die verschlüsselte Videoverbindung ausgehandelt
  wird. Endet eine Sitzung (Abmelden, Sperren), werden laufende Videoverbindungen getrennt.
  In Richtung Kamera darf eine App nur über den eigens dafür vorgesehenen Sprechkanal senden.
- **Bilder** (Albumcover, Schnappschüsse) holt der Hub stellvertretend und reicht sie durch; die App
  ruft nie selbst fremde Adressen auf.

## Die Android-App

- Anmeldung im Android-Schlüsselspeicher, nicht in einer lesbaren Datei.
- Optionale **App-Sperre** per Fingerabdruck/Gesicht/Geräte-PIN (unter Konto & Sicherheit); sie greift
  nach kurzer Zeit im Hintergrund.
- Kein Inhalt in der „Zuletzt verwendet“-Übersicht und keine Bildschirmfotos (Schutz vor neugierigen
  Blicken und anderen Apps).
- Vom Cloud-Backup und von der Geräteübertragung ausgeschlossen.
- Keine unverschlüsselten Verbindungen.
- Berechtigungen: Mikrofon (nur beim Gegensprechen), Biometrie. Kein Standort, keine Kontakte,
  keine Werbe-ID, keine Google-Dienste.

## Dein Teil

- **Zwei-Faktor-Pflicht eingeschaltet lassen**, erst recht bei Zugriff aus dem Internet.
- **Jeder Person ein eigenes Konto** geben – nie eines teilen. Nur so sind Rechte und Protokoll etwas wert.
- **Den Hub-Rechner pflegen:** Betriebssystem und Hub aktuell halten, den Rechner selbst mit einem
  guten Passwort schützen. Wer den Rechner kontrolliert, kontrolliert den Hub.
- **Für die Geräte eigene Benutzer anlegen** (siehe [GERAETE.md](GERAETE.md)) statt der
  Hauptzugänge – dann kann der Hub nur, was er soll.
- **Sicherungen** wie einen Schlüssel behandeln.
- Ein verlorenes Handy unter **Konto & Sicherheit › Angemeldete Geräte** sofort abmelden.
- Wenn möglich, den Zugriff über ein privates Netz (VPN) statt über eine öffentliche Adresse
  einrichten – siehe [FERNZUGRIFF.md](FERNZUGRIFF.md).

## Grenzen – ehrlich benannt

- Der Hub schützt den Zugang **zu** deinen Geräten, nicht die Geräte selbst. Schwächen in der
  Firmware von Kameras, Türstationen oder Lautsprechern kann er nicht beheben; halte sie aktuell und
  stelle sie nicht direkt ins Internet.
- Wer Administrator-Zugriff auf den Hub-Rechner hat, kann alles lesen, was der Hub lesen kann.
- Bei Zugriff über eine öffentliche Adresse (Weg B) ist die Anmeldeseite aus dem Internet erreichbar.
  Sie ist dafür gebaut, aber „unsichtbar“ (Weg A) ist immer sicherer als „gut verschlossen“.
- Spotify erfährt naturgemäß, was du dort suchst und abspielst; Sonos-Lautsprecher sprechen wie
  gewohnt mit den Sonos-Diensten. Home Hub fügt dem nichts hinzu.
- Die Software wurde sorgfältig entwickelt und automatisiert getestet, aber **nicht von unabhängigen
  Sicherheitsfachleuten geprüft**.
