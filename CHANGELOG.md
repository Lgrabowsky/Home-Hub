# Änderungen

Neue Versionen der Android-App erscheinen unter **Releases** auf GitHub, sobald hier eine neue
Versionsnummer steht. Hub und App sollten dieselbe Version haben: den Hub aktualisierst du wie in
[docs/INSTALLATION.md](docs/INSTALLATION.md) bzw. [docs/VIRTUELLE-MASCHINE.md](docs/VIRTUELLE-MASCHINE.md)
beschrieben.

## 0.3.0

- **Startseite selbst gestalten:** Stift oben rechts auf der Übersicht › Kacheln gedrückt halten und
  verschieben, Größe wählen (Klein, Breit, Groß), entfernen oder mit **+ Kachel** hinzufügen – Bereiche,
  Räume, Kameras und Türstationen, einzelne Geräte, Szenen, Favoriten, Wetter, nächste Zeitschaltuhren.
  Die Anordnung gilt für dich auf allen deinen Geräten; „Standard“ stellt die ursprüngliche wieder her.
- **Stockwerk wählen:** Räume, die Funktions-Menüs und Zutritt lassen sich auf ein Stockwerk eingrenzen
  (die Wahl merkt sich jedes Gerät).
- **Zutritt:** neuer Bereich mit allen Türen und Toren – Türöffner und Tore der myGEKKO-Zutrittskontrolle
  öffnen (Schiebe-Bestätigung), dauerhaft öffnen, anhalten, schließen, sperren; dazu Türstationen und
  Türkontakte. Nur mit dem Recht „Türen öffnen“; jede Bedienung steht im Protokoll.
- **Zeitschaltuhren bearbeiten:** eigene Zeitschaltuhren des Hubs (Uhrzeit oder Sonnenauf-/-untergang,
  Wochentage, mehrere Aktionen; pausieren, sofort ausführen) unter **Räume › Aktionen**, und die
  Uhren des myGEKKO auf Aus / Ein / Automatik stellen. Standort und Zeitzone unter
  **Einstellungen › Geräte & Dienste › Allgemein › Ort & Zeit**.
  Details: [docs/GERAETE.md](docs/GERAETE.md). Braucht einen Hub ab Version 0.3.0.

## 0.2.0

- **3D-Haus (Labs):** das eigene Haus als 3D-Modell aus einer IFC-Datei – drehen, Geschosse öffnen,
  Geräte an ihrer Stelle bedienen, Licht und Schatten nach der echten Tageszeit. Einschalten unter
  **Einstellungen › Labs**, Modell hochladen unter **Einstellungen › Verwaltung › 3D-Haus**.
  Anleitung: [docs/3D-HAUS.md](docs/3D-HAUS.md). Braucht einen Hub ab Version 0.2.0.
- **Server neu starten** aus der App (Einstellungen › Diagnose), wo der Linux-Hub mit dem
  Einrichtungsskript installiert wurde.
- myGEKKO-Cloud: Leerzeichen um den eingefügten API-Schlüssel stören nicht mehr.
- Linux/VM: Der Hub findet seine Namensserver nach einem Neustart zuverlässig.

## 0.1.0

Erste Version: Räume und Geräte (myGEKKO), Sicherheit, Türstationen (DoorBird), Kameras (Reolink),
Musik (Sonos und Spotify), Benutzer und Rechte, Protokoll, Diagnose, Android-App, Windows-Paket und
Einrichtung als virtuelle Maschine.
