# Änderungen

Neue Versionen der Android-App erscheinen unter **Releases** auf GitHub, sobald hier eine neue
Versionsnummer steht. Hub und App sollten dieselbe Version haben: den Hub aktualisierst du wie in
[docs/INSTALLATION.md](docs/INSTALLATION.md) bzw. [docs/VIRTUELLE-MASCHINE.md](docs/VIRTUELLE-MASCHINE.md)
beschrieben.

## 0.5.1

- **KNX-Kontakte Räumen zuordnen:** Beim Anlegen oder Bearbeiten eines Kontakts wählst du einen
  bestehenden Raum oder legst mit „Neuer Raum …“ gleich einen an (mit Bereich, z. B. Erdgeschoss).
- **Name freiwillig:** Ohne eigenen Namen heißt ein Kontakt nach Art und Raum, z. B. „Fenster Küche“
  (mehrere werden durchnummeriert).

## 0.5.0

- **KNX-Bus:** Fenster- und Türkontakte direkt am KNX-Bus mithören – über eine KNX IP-Schnittstelle
  (Tunnel) oder einen KNX IP-Router (Routing), am myGEKKO vorbei. Beim Verbinden fragt der Hub jeden
  Kontakt nach seinem Zustand; danach kommt jede Änderung sofort. Einrichten unter
  **Einstellungen › Geräte & Dienste › KNX-Bus**: Schnittstelle im Netz suchen, Verbindung testen,
  mit **Kontakt suchen** (Fenster öffnen → Gruppenadresse erscheint → „Das ist es“) zuordnen.
  Der Hub schaltet nichts auf dem Bus. Anleitung: [docs/GERAETE.md](docs/GERAETE.md).
  Braucht einen Hub ab Version 0.5.0.

## 0.4.1

- Ist der Hub älter als die App, sagt die App das jetzt oben auf der Seite – statt dass neue
  Funktionen (z. B. Lichter für Kameras, Räume bearbeiten) beim Speichern nur „Nicht gefunden.“
  melden. Abhilfe: den Hub aktualisieren (in der VM:
  `cd /opt/home-hub && sudo git pull && sudo bash deploy/linux/install.sh`).
- Die installierte App weist auf eine neuere App-Version hin, wenn der Hub schon weiter ist.

## 0.4.0

- **Räume selbst anordnen:** **Räume › Bearbeiten** (Administratoren, gilt für alle im Haushalt) –
  eigene Bereiche wie Dachgeschoss oder Treppenhaus anlegen, Räume umbenennen, zusammenführen, neu
  anlegen, einem Bereich zuordnen und sortieren, Geräte einzeln in andere Räume legen.
- **Geräte umbenennen und ausblenden** – im Raum, im Fenster jedes Geräts oder in den Menüs
  Licht, Jalousien, Klima, Geräte und Aktionen (**Bearbeiten**: sortieren, mit dem Auge aus- und
  einblenden, umbenennen, verschieben).
- **Zurücksetzen** für ein Gerät, einen Raum oder alles: die automatische Erkennung bleibt erhalten
  und ordnet alles, was du nicht geändert hast, weiter selbst ein.
- **Aktionen und Uhren** sind jetzt getrennte Menüs.
- **Lichter für Kameras:** einer Kamera oder Türstation Lichter zuordnen und sie direkt unter dem
  Kamerabild schalten.
- Die Stockwerk-Einstellung unter Allgemein entfällt; die dort eingetragenen Stockwerke bleiben die
  Grundeinteilung. Braucht einen Hub ab Version 0.4.0.

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
