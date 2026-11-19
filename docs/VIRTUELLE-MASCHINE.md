# Hub in einer virtuellen Maschine (Windows 7 und neuer)

Diese Anleitung bringt den Hub auf einen Windows-PC, **ohne Windows anzutasten**. Der Hub läuft in
einer virtuellen Maschine (VM): einem kleinen Linux in einem Fenster, das Windows nur dann
Arbeitsspeicher und Rechenzeit kostet, wenn du es gestartet hast.

Geschrieben für Windows 7 (64-Bit). Unter Windows 10/11 geht es genauso – dort nimmst du die
aktuelle VirtualBox-Version statt 6.1.

**Zeitbedarf:** etwa eine Stunde, davon viel Warten.

## Was sich am PC ändert – und was nicht

|                              | VM aus                                     | VM läuft                                         |
| ---------------------------- | ------------------------------------------ | ------------------------------------------------ |
| Arbeitsspeicher              | vollständig frei                           | 2 GB für die VM, der Rest bleibt für Windows     |
| Prozessor                    | nichts                                     | im Leerlauf kaum messbar                         |
| Programme im Hintergrund     | keine                                      | VirtualBox und ein minimiertes Fenster           |
| Energiesparmodus             | wie bisher                                 | ausgesetzt, damit der Hub erreichbar bleibt      |
| Festplatte                   | ein Ordner mit der VM (etwa 5–10 GB)       | –                                                |

Einmalig installiert wird nur **VirtualBox**. Es trägt sich nicht in den Autostart ein und ändert
keine Windows-Einstellung; nur seine Treiber bleiben geladen und belegen wenige Megabyte. Die
Start- und Stopp-Dateien aus Schritt 9 schalten den Energiesparmodus nicht um – sie halten den PC
nur wach, solange ihr Fenster offen ist. Wie du alles wieder entfernst, steht ganz unten.

## Was du brauchst

- Den PC **per Netzwerkkabel** am Router. Über WLAN funktioniert die „Netzwerkbrücke“, die die VM
  braucht, oft nicht zuverlässig.
- Etwa **15 GB** freien Platz auf der Festplatte.
- Ein **Handy** für die Tailscale-App (kostenlos; das Konto legst du in Schritt 7 an).
- Drei Downloads (Schritt 2, 3 und 9). Läuft auf dem Windows-7-PC kein aktueller Browser mehr: auf
  einem anderen Rechner herunterladen und per USB-Stick hinüberkopieren.

---

## Schritt 1 – Windows 7 prüfen (einmalig)

1. **64-Bit?** Startmenü › Rechtsklick auf „Computer“ › Eigenschaften › „Systemtyp“ muss
   **64-Bit-Betriebssystem** lauten. (Mit 8 GB Arbeitsspeicher ist das praktisch immer so.)
2. **Updates für die Treibersignatur:** Systemsteuerung › Programme und Funktionen › links
   „Installierte Updates anzeigen“ › oben rechts im Suchfeld nacheinander `KB4490628` und
   `KB4474419` eingeben. Fehlt eines davon, lade es aus dem Microsoft-Update-Katalog
   (<https://www.catalog.update.microsoft.com/Search.aspx?q=KB4490628> und
   <https://www.catalog.update.microsoft.com/Search.aspx?q=KB4474419>), jeweils die Zeile
   **„für x64-basierte Systeme“** – erst KB4490628, dann KB4474419 installieren und neu starten.
   Ohne diese Updates bricht die VirtualBox-Installation mit einem Signaturfehler ab.

## Schritt 2 – VirtualBox installieren

1. Öffne <https://www.virtualbox.org/wiki/Download_Old_Builds_6_1> und lade bei
   **VirtualBox 6.1.50** den Eintrag **„Windows hosts“** herunter. (Die neueren 7.x-Versionen laufen
   auf Windows 7 nicht zuverlässig.)
   Lädt die Seite nicht (z. B. „402 Payment Required“), hol die Datei direkt vom Download-Server:
   <https://download.virtualbox.org/virtualbox/6.1.50/> › **`VirtualBox-6.1.50-161033-Win.exe`**.
   Nimm sie nur von dort, nicht von Download-Portalen. Beim Start muss Windows als verifizierten
   Herausgeber **Oracle** anzeigen.
2. Starte die Datei › **Next**.
3. Seite **„Custom Setup“** – hier nur das Nötige auswählen. Klicke jeweils auf das Symbol vor dem
   Eintrag und wähle **„Entire feature will be unavailable“** für:
   - **VirtualBox USB Support**
   - **VirtualBox Host-Only Networking**
   - **VirtualBox Python 2.x Support** (bzw. „Python Support“)

   Ausgewählt bleiben **VirtualBox Application** und **VirtualBox Bridged Networking**. › **Next**
4. Nächste Seite: nur **„Create start menu entries“** angehakt lassen, die anderen drei Haken
   (Desktop-Verknüpfung, Schnellstartleiste, Dateizuordnungen) entfernen. › **Next**
5. Hinweis **„Network Interfaces“**: Die Netzwerkverbindung ist gleich für ein paar Sekunden weg. ›
   **Yes** › **Install**.
6. Fragt Windows, ob Gerätesoftware von **„Oracle Corporation“** installiert werden soll: jeweils
   **Installieren**.
7. **Finish** – VirtualBox öffnet sich.

## Schritt 3 – Debian herunterladen

Öffne <https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/> und lade die Datei
**`debian-13.…-amd64-netinst.iso`** herunter (rund 700 MB, die Nummern hinter „13“ ändern sich mit
jedem Update). Speichere sie z. B. unter „Downloads“.

## Schritt 4 – VM anlegen

In VirtualBox oben auf **„Neu“**:

1. **Name: `HomeHub`** – genau so, ohne Leerzeichen. Die Start- und Stopp-Dateien suchen diesen
   Namen.
   **Typ:** Linux · **Version:** Debian (64-bit)
   Bietet die Liste nur „32-bit“-Versionen an, ist die Virtualisierung im BIOS ausgeschaltet – siehe
   [Fehlerbehebung](#fehlerbehebung). › **Weiter**
2. **Speichergröße: 2048 MB** › **Weiter**
   (Der Hub selbst braucht unter 200 MB; der Rest ist Luft für Linux.)
3. **„Festplatte erzeugen“** › **Erzeugen** › **VDI** › **dynamisch alloziert** › Größe **32 GB** ›
   **Erzeugen**.
   Die Datei ist anfangs nur etwa 2 GB groß und wächst nach Bedarf.

## Schritt 5 – VM einstellen

Die VM „HomeHub“ links markieren › oben **„Ändern“**:

1. **System › Prozessor:** **2** Prozessoren.
2. **Audio:** Haken bei „Audio aktivieren“ entfernen.
3. **Netzwerk › Adapter 1:** „Angeschlossen an“ **Netzwerkbrücke**; bei „Name“ die
   **kabelgebundene** Netzwerkkarte wählen (z. B. „Intel(R) Ethernet …“ oder „Realtek PCIe GbE …“),
   nicht WLAN.
   *Warum:* So bekommt die VM eine eigene Adresse im Heimnetz wie jedes andere Gerät. Nur dann
   findet der Hub Sonos, Kameras und Türstationen.
4. **USB:** Haken bei „USB-Controller aktivieren“ entfernen.
5. **OK**.

## Schritt 6 – Debian installieren

1. Oben auf **„Starten“**. Beim ersten Start fragt VirtualBox nach einem **Startmedium**: auf das
   Ordnersymbol › **Hinzufügen** › die `debian-13…-netinst.iso` aus Schritt 3 › **Auswählen** ›
   **Starten**.
   *Kommt eine Meldung mit „VT-x“:* siehe [Fehlerbehebung](#fehlerbehebung).
2. Ein Klick ins VM-Fenster gibt Tastatur und Maus an die VM; **zurück zu Windows mit der rechten
   Strg-Taste**.
3. Im Startmenü von Debian mit den Pfeiltasten **„Install“** wählen (nicht „Graphical install“) ›
   Enter. Bedienung ab jetzt: Pfeiltasten, **Leertaste** zum Ankreuzen, **Tab** zum Wechseln auf
   „Weiter“, **Enter**.
4. Sprache **German – Deutsch** · Standort **Deutschland** · Tastatur **Deutsch**.
5. **Rechnername:** `homehub` · **Domainname:** leer lassen.
6. **Root-Passwort: leer lassen** (zweimal einfach Enter). Dann bekommt dein Benutzer im nächsten
   Schritt die Administratorrechte (`sudo`).
7. Vollständiger Name, **Benutzername** (z. B. `hub`) und ein **Passwort** – aufschreiben, du
   brauchst es gleich.
8. Partitionierung: **„Geführt – vollständige Festplatte verwenden“** › die einzige angebotene
   Platte **„VBOX HARDDISK“** (das ist die virtuelle 32-GB-Platte – deine echte Festplatte sieht die
   VM gar nicht) › **„Alle Dateien auf eine Partition“** › **„Partitionierung beenden und
   Änderungen übernehmen“** › **Ja**.
9. „Weitere Installationsmedien einlesen?“ **Nein** · Spiegel: **Deutschland** ›
   **deb.debian.org** · HTTP-Proxy: leer lassen.
10. Paketverwendungserfassung: **Nein**.
11. **Softwareauswahl – wichtig:** Sternchen **entfernen** bei „Debian desktop environment“ und
    „GNOME“; Sternchen **setzen** bei **„SSH server“** und **„Standard-Systemwerkzeuge“**. › Weiter
12. GRUB-Bootloader installieren: **Ja** › **/dev/sda**.
13. „Installation abgeschlossen“ › **Weiter**. Die VM startet neu.

Das dauert etwa 10–20 Minuten.

## Schritt 7 – Hub einrichten (zwei Befehle)

1. Nach dem Neustart bei `homehub login:` deinen **Benutzernamen** eingeben, dann das
   **Passwort** (beim Tippen erscheinen keine Zeichen – das ist normal).
2. Tippe genau diese zwei Zeilen, jeweils mit Enter:

   ```bash
   wget -O hub.sh https://raw.githubusercontent.com/lgrabowsky/home-hub/HEAD/deploy/linux/install.sh
   sudo bash hub.sh
   ```

   Auf der deutschen Tastatur: `/` = Umschalt + 7, `:` = Umschalt + Punkt. `sudo` fragt nach
   deinem Passwort.

Das Skript arbeitet jetzt etwa 5–10 Minuten (Docker, Tailscale, Sicherheitsupdates, Hub). An zwei
Stellen braucht es dich:

- **Tailscale-Anmeldung:** Es erscheinen ein Link `https://login.tailscale.com/a/…` und ein QR-Code.
  Scanne den QR-Code mit der Handykamera (oder tippe den Link im Handy-Browser ab) und melde dich
  an – mit Google, Microsoft, Apple oder GitHub; neu bei Tailscale legst du dabei kostenlos ein Konto
  an. Bestätige mit **Connect**. Das Skript läuft von selbst weiter.
- **https erlauben** (nur beim allerersten Mal): Erscheint ein zweiter Link, öffne ihn ebenso und
  bestätige **Enable**. Das Skript wartet so lange.

Am Ende zeigt es:

```text
Fertig – der Hub läuft.

  Adresse:  https://homehub.dein-netz.ts.net
  Einrichtungscode:  XXXX-XXXX-XXXX
```

**Fotografiere beides.**

## Schritt 8 – Handy verbinden und Konto anlegen

1. **Tailscale-App** aus dem Play Store installieren, mit **demselben Konto** anmelden, Schalter auf
   „verbunden“. Lass sie eingeschaltet – auch zu Hause, der Hub ist nur darüber erreichbar.
2. Im Browser oder in der Home-Hub-App die **Adresse** aus Schritt 7 öffnen. Der allererste Aufruf
   kann ein paar Sekunden dauern, weil das Zertifikat erst ausgestellt wird.
3. **Einrichtungscode** eingeben, Konto anlegen, zweiten Faktor einrichten – wie in
   [INSTALLATION.md, Abschnitt 3](INSTALLATION.md#3-erstes-konto-anlegen) beschrieben.
4. Geräte verbinden: [GERAETE.md](GERAETE.md).

Den Hub öffnest du vom Handy oder von einem anderen Rechner mit Tailscale – nicht vom
Windows-7-PC selbst, denn für Windows 7 gibt es kein Tailscale.

## Schritt 9 – Start- und Stopp-Dateien einrichten

1. Lade die drei Dateien aus dem Projekt unter
   [`deploy/windows-vm`](../deploy/windows-vm) (bzw. das ZIP „Hub-VM“) und lege sie **zusammen in
   einen Ordner**, z. B. `Dokumente\Home Hub`:
   - `Hub-VM starten.cmd`
   - `Hub-VM beenden.cmd`
   - `hub-vm.ps1`
2. Optional: Rechtsklick auf die beiden `.cmd`-Dateien › Senden an › Desktop (Verknüpfung
   erstellen).
3. Die VM aus Schritt 6 läuft noch in ihrem Fenster. Fahre sie einmal herunter: im VM-Fenster
   `sudo poweroff` eintippen, Enter. Das Fenster schließt sich.

**Ab jetzt gilt:**

- **„Hub-VM starten“** doppelklicken. Die VM startet unsichtbar im Hintergrund, nach etwa einer
  Minute ist der Hub erreichbar. Ein Fenster legt sich nach ein paar Sekunden **minimiert in die
  Taskleiste** und hält den PC wach, solange der Hub läuft. Bitte nicht schließen.
- **„Hub-VM beenden“** doppelklicken. Die VM fährt sauber herunter, das Fenster in der Taskleiste
  schließt sich von selbst, der **Arbeitsspeicher ist wieder vollständig frei**.
- **Vor dem Herunterfahren, Neustarten oder Abmelden von Windows immer zuerst „Hub-VM beenden“.**
  Sonst wird die VM hart ausgeschaltet – wie Stecker ziehen. Den Bildschirm sperren (Windows-Taste
  + L) ist dagegen in Ordnung.

## Schritt 10 – Prüfen, dass nichts übrig bleibt

Nach „Hub-VM beenden“: Task-Manager öffnen (Strg + Umschalt + Esc) › Registerkarte **Prozesse** ›
„Prozesse aller Benutzer anzeigen“. **`VBoxHeadless.exe`** ist weg, **`VBoxSVC.exe`** verschwindet
nach wenigen Sekunden. Unter **Leistung** siehst du, dass der Arbeitsspeicher wieder frei ist. Ein
kleiner VirtualBox-Systemdienst (`VBoxSDS.exe`) kann bis zum nächsten Neustart geöffnet bleiben; er
braucht nur wenige Megabyte.

---

## Im Alltag

**Zustand nachsehen:** VirtualBox öffnen – „HomeHub“ steht auf „Läuft“ oder „Ausgeschaltet“.

**In die laufende VM schauen** (für die Befehle unten): VirtualBox › „HomeHub“ markieren ›
**„Anzeigen“**. Das Fenster wieder schließen mit **„Die VM im Hintergrund weiterlaufen lassen“**
(nicht ausschalten!). Bequemer mit Kopieren und Einfügen geht es über SSH, z. B. mit dem
Programm PuTTY (ohne Installation lauffähig) und der Adresse der VM aus deinem Router.

**Aktualisieren:**

```bash
sudo bash /opt/home-hub/deploy/linux/install.sh
```

Holt die neueste Version des Hubs; Einstellungen und Daten bleiben erhalten. Linux selbst
installiert Sicherheitsupdates täglich von allein.

**Sichern:** wie in [INSTALLATION.md, „Sichern und wiederherstellen“](INSTALLATION.md#sichern-und-wiederherstellen)
beschrieben, die Befehle im Ordner `/opt/home-hub/deploy` ausführen. Die Sicherungsdatei holst du
z. B. per WinSCP oder PuTTY-`pscp` auf den PC.

**Protokoll ansehen:**

```bash
cd /opt/home-hub/deploy && sudo docker compose logs --tail 100 hub
```

**Sicherheit:** Windows 7 bekommt keine Sicherheitsupdates mehr. Nutze den PC deshalb möglichst
nicht zum Surfen oder für E-Mails, und öffne am Router keine Ports – der Zugriff von unterwegs läuft
ausschließlich über Tailscale.

**Immer an?** Soll der Hub dauerhaft laufen, lass den PC einfach mit gestartetem Hub an. Wer ihn bei
jeder Windows-Anmeldung starten möchte, legt eine Verknüpfung zu „Hub-VM starten“ in den Ordner
`shell:startup` (Windows-Taste + R, `shell:startup` eingeben, Enter). Das ist eine bewusste
Änderung an Windows und jederzeit wieder löschbar.

## Fehlerbehebung

**„VT-x is disabled in the BIOS“, „VERR_VMX_…“ oder nur 32-Bit-Versionen wählbar**
Die Virtualisierung ist im BIOS ausgeschaltet. PC neu starten, beim Start **Entf** oder **F2**
drücken (steht kurz auf dem Bildschirm), unter „Advanced“ › „CPU Configuration“ (je nach
Hersteller ähnlich) **„Intel Virtualization Technology“** auf **Enabled** stellen, mit **F10**
speichern. Sonst ändert sich dadurch nichts am PC.

**Signaturfehler beim Installieren von VirtualBox**
Die Updates aus Schritt 1 fehlen.

**Das Skript meldet „Temporärer Fehler bei der Namensauflösung“ oder findet kein Netzwerk**
In den VM-Einstellungen (Schritt 5) die Netzwerkbrücke auf die richtige, kabelgebundene
Netzwerkkarte stellen. In der VM zeigt `ip -4 addr` eine Adresse wie `192.168.178.x`, wenn alles
stimmt.

**Sonos-Lautsprecher werden nicht gefunden**
Netzwerkbrücke statt „NAT“ eingestellt? PC per Kabel verbunden? Notfalls trägst du die Adressen der
Lautsprecher in den Hub-Einstellungen von Hand ein.

**„Hub-VM starten“ meldet „keine VM mit dem Namen HomeHub“**
Der Name in VirtualBox weicht ab: Rechtsklick auf die VM › Ändern › Allgemein › Name: `HomeHub`.

**Der Code des zweiten Faktors wird abgelehnt**
Die Uhr der VM geht falsch. In der VM `timedatectl` eingeben – „System clock synchronized: yes“
muss dastehen; sonst einmal neu starten (`sudo reboot`).

**Das Skript bricht bei Tailscale ab**
Einfach `sudo bash hub.sh` noch einmal ausführen – es macht dort weiter, wo es aufgehört hat.

## Wieder entfernen

1. **„Hub-VM beenden“**.
2. VirtualBox › Rechtsklick auf „HomeHub“ › **Entfernen** › **„Alle Dateien löschen“**.
3. Systemsteuerung › Programme und Funktionen › **Oracle VM VirtualBox** deinstallieren.
4. Optional: in der Tailscale-Verwaltung (<https://login.tailscale.com>) das Gerät „homehub“
   entfernen; den Ordner mit den Start- und Stopp-Dateien löschen.

Danach ist der PC wie vorher. Die BIOS-Einstellung aus der Fehlerbehebung darf bleiben, sie stört
nicht.

## Später umziehen

Auf einem Mini-PC oder Raspberry Pi läuft dasselbe Skript aus Schritt 7. Deine Daten nimmst du mit
einer Sicherung mit (siehe oben). Bekommt der neue Rechner in Tailscale einen anderen Namen,
entferne vorher das alte Gerät „homehub“ in der Tailscale-Verwaltung – dann bleibt die Adresse
gleich.
