# Geräte verbinden

Alle Geräte richtest du in der App unter **Mehr › Geräte & Dienste** ein. Dort steht bei jedem Gerät
in Kurzform, was vorzubereiten ist; hier die ausführliche Fassung. Mit **Verbindung testen** prüfst du
jede Eingabe, bevor du speicherst – der Test sagt in Klartext, was nicht stimmt.

Grundregel: **Lege an jedem Gerät einen eigenen Benutzer für den Hub an.** Dann kann der Hub nur, was
er soll, und du kannst ihm den Zugang jederzeit entziehen, ohne dein eigenes Passwort zu ändern.

---

## myGEKKO

**Am myGEKKO vorbereiten (empfohlen: direkte Verbindung im Heimnetz)**

1. In den Einstellungen des myGEKKO unter „Netzwerk“ die **lokale QueryAPI** einschalten.
2. Dort einen **Benutzer mit Passwort** anlegen, der lesen und schalten darf.
3. Dem myGEKKO im Router eine **feste IP-Adresse** zuweisen.

**In der App:** Gebäude (myGEKKO) › „Im Heimnetz“ › Adresse, Benutzer, Passwort › Verbindung testen ›
einschalten › Speichern.

Alternativ geht die Verbindung **über myGEKKO Plus** (Benutzername, API-Schlüssel und myGEKKO-ID aus
dem Portal live.my-gekko.com). Sie läuft über die Server von myGEKKO, reagiert langsamer und ist in
der Zahl der Abfragen begrenzt – nimm sie nur, wenn die lokale Abfrage nicht möglich ist.

**Was erscheint:** Lichter, Jalousien/Rollläden, Raumregler, Lasten/Steckdosen, Aktionen (als
Szenen), Zeitschaltuhren, Türen und Tore der Zutrittskontrolle, Wetterwerte, der Zustand der
Alarmanlage – jeweils mit den Namen und
Seiten/Räumen, die am myGEKKO vergeben sind. Benennst du am myGEKKO etwas um, übernimmt die App das.

Gut zu wissen:

- **Falsches Passwort = elf Minuten Pause.** Der myGEKKO sperrt ein Konto nach mehreren falschen
  Anmeldungen. Damit das nie passiert, wartet der Hub nach einer abgelehnten Anmeldung elf Minuten,
  bevor er es wieder versucht – auch der Knopf „Verbindung testen“ hält sich daran. Die App zeigt an,
  wann der nächste Versuch stattfindet.
- **Verschlüsselung im Heimnetz.** Der Hub spricht verschlüsselt (https) mit dem myGEKKO, wenn dieser
  das anbietet, sonst unverschlüsselt (http). Im zweiten Fall gehen die Zugangsdaten innerhalb deines
  Heimnetzes im Klartext über die Leitung; der Verbindungstest sagt, welcher Weg benutzt wird.
- **Lasten werden dauerhaft eingeschaltet.** Was nur einen kurzen Impuls bekommen darf (Türöffner,
  Garagentor-Taster), legst du am myGEKKO besser als Zutrittstür bzw. Tor der Zutrittskontrolle an
  (dann erscheint es unter **Zutritt**) oder als Aktion, die du aus der App startest.
- **Zutritt:** Türen und Tore der myGEKKO-Zutrittskontrolle stehen unter **Räume › Zutritt** – mit
  Zustand (offen, zu, wie weit ein Tor offen ist) und den Befehlen, die der myGEKKO dafür kennt:
  öffnen (per Schieberegler), dauerhaft öffnen (mit Rückfrage), anhalten (Tore), schließen, sperren.
  Bedienen darf das nur, wer das Recht **„Türen öffnen“** hat (Verwaltung › Benutzer); sehen nur, wer
  „Fenster-/Türkontakte und Alarmstatus einsehen“ darf. Jede Bedienung steht im Protokoll. Was ein Befehl am Tor genau bewirkt
  (z. B. ob „Schließen“ sofort zufährt), bestimmt die Einstellung am myGEKKO – probier es einmal
  vor Ort aus.
- **Zeitschaltuhren des myGEKKO:** Ihre Schaltzeiten lassen sich über die Schnittstelle des myGEKKO
  nicht ändern, nur ihr Modus: **Aus**, **Ein** (dauerhaft) oder **Automatik** (nach den am myGEKKO
  eingestellten Zeiten). Prüfe nach dem ersten Umschalten am myGEKKO, ob er den Modus so anzeigt.
- **Zeitschaltuhren des Hubs:** Unter **Räume › Uhren › Neu** legst du eigene
  Uhren an: zu einer Uhrzeit oder zum Sonnenauf-/-untergang (± Minuten), an gewählten Wochentagen,
  mit einer oder mehreren Aktionen (Licht, Jalousien, Heizung, Geräte, Szenen, myGEKKO-Uhren).
  Sie schalten, **solange der Hub läuft** – bei der virtuellen Maschine also nur, wenn sie gestartet
  ist. War der Hub kurz weg (bis 10 Minuten), holt er eine verpasste Schaltung nach. Für Sonnenauf-
  und -untergang trägst du unter **Geräte & Dienste › Allgemein › Ort & Zeit** die Zeitzone und den
  Standort des Hauses ein (Breiten- und Längengrad, z. B. aus einer Karten-App; zwei Nachkommastellen
  genügen). Der Standort bleibt auf dem Hub.
- **Zonen der Alarmanlage:** Der Hub erkennt am Namen, was eine Zone überwacht: Fenster und Türen
  („Hülle“, „Erdgeschoss“ …), Licht („Status Beleuchtung“), Rauch („Rauchmelder“), Bewegung. Nur die
  Zonen der Fenster und Türen zählen für „offen/geschlossen“ unter Sicherheit. Die Licht-Zone zeigt die
  eingeschalteten Lichter und schaltet sie aus; welche Lichter dabei nicht zählen, legst du unter
  **Einstellungen › Licht-Überwachung** fest. „Unscharf“ heißt: Die Zone löst keinen Alarm aus –
  scharf geschaltet wird sie am myGEKKO.
- **Gesperrte Jalousien** (z. B. Windalarm) zeigt die App als gesperrt; Befehle lehnt der myGEKKO dann ab.
- **Räume und Stockwerke erkennt der Hub selbst:** Räume aus den Seiten des myGEKKO (und den Räumen
  von Kameras und Lautsprechern), Stockwerke an Raumnamen wie „EG Küche“ oder „OG Bad“. Kontakte, die
  am myGEKKO auf einer eigenen Seite liegen („Türen und Fenster“), erscheinen in dem Raum, der in
  ihrem Namen vorkommt („Fenster Küche“ → Küche).
- **Selbst anordnen** (Administratoren, gilt für alle im Haushalt): **Räume › Bearbeiten**.
  - Eigene **Bereiche** anlegen (z. B. Dachgeschoss, Treppenhaus), umbenennen, sortieren, entfernen.
  - **Räume** antippen: umbenennen, einem Bereich zuordnen, mit einem anderen Raum zusammenführen,
    Geräte aus anderen Räumen hierher holen und die Geräte sortieren. „+ Raum“ legt einen neuen,
    leeren Raum an.
  - **Reihenfolge je Seite:** Auf Licht, Jalousien, Klima und Geräte lassen sich unter **Bearbeiten**
    auch die Räume am Griff verschieben – nur für diese Seite. Auf **Zutritt › Bearbeiten** ordnest du
    Türen, Tore, Türstationen und Türkontakte. „Reihenfolge zurücksetzen“ stellt die Ordnung des Hauses
    wieder her.
  - **Geräte** umbenennen, in einen anderen Raum legen oder ausblenden – im Raum, im Fenster eines
    Geräts („Name, Raum, Sichtbarkeit“) oder in den Menüs **Licht, Jalousien, Klima, Geräte,
    Aktionen › Bearbeiten** (dort auch sortieren und mit dem Auge aus- und einblenden). Ausgeblendete
    Geräte schalten Zeitschaltuhren weiterhin.
  - **Zurücksetzen** geht für ein Gerät, für einen Raum (Name, Geräte, Reihenfolge – ein selbst
    angelegter Raum verschwindet, seine Geräte kehren zurück) oder für alles. Was du nicht geändert
    hast, ordnet der Hub weiter automatisch ein – auch neue Geräte.
- **Fenster & Türen einem Raum zuordnen:** In der Raumansicht unter **Fenster & Türen › Zuordnen**
  stehen alle Fenster- und Türkontakte des Hauses mit ihrem Zustand – das zuletzt geöffnete ganz
  oben. Fenster öffnen, es springt auf „offen“, Schalter „gehört zu …“ einschalten. Der Raum zeigt
  dann seinen Zustand (auch auf der Raumkachel: „1 offen“). Ausschalten gibt den Kontakt dem Raum
  zurück, in dem der Hub ihn erkannt hatte. Geht auch im Raum-Editor (Räume › Bearbeiten).
- **Lichter für Kameras:** Auf der Seite einer Kamera oder Türstation ordnest du unter **Licht ›
  Lichter zuordnen** Lampen zu; sie erscheinen dort als normale Lichtschalter, damit die Kamera Licht hat.

### Fenster- und Türkontakte

**Kurz:** Anlernen ist nicht nötig. Der Hub erkennt die Kontakte selbst; was du sofort siehst und was
erst nach und nach erscheint, hängt davon ab, wie dein myGEKKO die Kontakte führt.

**Was der myGEKKO nach außen gibt.** Über seine Schnittstelle (Query API) meldet der myGEKKO die
Alarmüberwachung (bei dir „Hülle“) je Zone nur als Ganzes: scharf/unscharf, Alarm ja/nein und
„mindestens ein Melder ist offen“. **Welcher** Melder offen ist, steht für die Alarmanlage nirgends in
der Schnittstelle – das bestätigen die offizielle Variablenliste von myGEKKO und die Daten mehrerer
echter Anlagen. Den Gesamtzustand zeigt die App unter **Sicherheit** immer sofort.

**Wie die App trotzdem jedes Fenster einzeln zeigt.** Viele Anlagen führen die Kontakte zusätzlich an
anderer Stelle einzeln. Das findet der Hub von selbst (Schalter „Kontakte automatisch erkennen“, ab Werk
an):

| Am myGEKKO | Wird in der App zu | Ab wann |
| --- | --- | --- |
| Raumregler mit angeschlossenem Fensterkontakt | „Fenster ‹Raum›“ | sobald das Fenster einmal als offen gemeldet wurde |
| Zutrittstür (Zutrittskontrolle) | Tür mit ihrem Namen | sofort |
| Logik, deren Name oder Seite ein Stichwort enthält (Fenster, Tür, Tor, Kontakt, Terrasse, Balkon, Hülle …) | Fenster bzw. Tür mit dem Namen der Logik | sofort |
| Ein Wert ohne sprechenden Namen (z. B. ein Eingang einer Logik oder ein mitgeschriebener Eingang in einem Trend), der genau mit der Hülle auf- und zugeht | „‹Logik› · Kontakt 1.1“ bzw. Name aus dem Trend | nachdem das Fenster zweimal geöffnet und wieder geschlossen wurde |

Für die letzte Zeile beobachtet der Hub still im Hintergrund: Ein Wert wird nur dann zum Kontakt, wenn
er bei geschlossener Hülle **immer** „zu“ zeigt und bei zwei getrennten Öffnungen mit der Hülle
umspringt. Zeigt ein so gefundener Kontakt später „offen“, während die Hülle „alles zu“ meldet,
verwirft der Hub ihn wieder. Sammel-Ausgänge einer Logik („irgendein Fenster offen“) blendet er aus.
Wie die Alarmzone mit den Kontakten heißt, steht in den Einstellungen („Alarmzone der Kontakte“,
ab Werk „Hülle“).

**Und die myGEKKO-App?** Sie zeigt die offenen Melder, weil sie über den Dienst „myGEKKO Viewer“
die Bedienoberfläche des Gebäudereglers selbst anzeigt – eine Fernanzeige des Bildschirms, keine
Datenschnittstelle. Dieser Dienst ist laut myGEKKO unverschlüsselt, nur fürs geschützte Heimnetz
gedacht und nicht für andere Programme dokumentiert; der Hub nutzt ihn deshalb nicht.

**Nachsehen, was dein myGEKKO meldet:** Unter Gebäude (myGEKKO) › Fenster- & Türkontakte › „Was meldet
mein myGEKKO?“ lädst du alle Werte herunter, die er über die Schnittstelle preisgibt (ohne
Passwörter). Daran siehst du – oder wer dir hilft –, ob die Kontakte irgendwo einzeln vorkommen.

**Wenn die Kontakte nur in der Alarmanlage hängen** und sonst nirgends einzeln vorkommen, kann der Hub
sie nicht einzeln zeigen – die App meldet dann ehrlich „mindestens ein Kontakt ist offen“. Abhilfe am
myGEKKO (reine Konfiguration, keine neue Verdrahtung): den Eingang des Kontakts zusätzlich einer
**Logik** zuführen, die nach dem Fenster benannt ist (z. B. „Fenster Küche“), oder ihn als
Fensterkontakt des **Raumreglers** eintragen. Danach erscheint er in der App von selbst.

**Nur falls nötig: von Hand zuordnen.** Unter Gebäude (myGEKKO) › Fenster- & Türkontakte › „Von Hand
zuordnen“ kannst du einen Kontakt umbenennen, einem Raum zuweisen oder mit **Kontakt suchen** ergänzen
(Fenster öffnen, der Hub zeigt, welcher Wert reagiert). Für den Normalfall ist das nicht nötig.

---

## KNX-Bus (Fenster- und Türkontakte)

> Sind am KNX-Bus Kontakte eingerichtet, kommen **alle** Fenster- und Türkontakte von dort: Der
> myGEKKO sucht dann keine Kontakte mehr und zeigt keine an. Von ihm bleiben die Alarmanlage
> („Hülle“) und die Türen und Tore der Zutrittskontrolle.

**Wozu:** Hängen die Magnetkontakte an KNX-Binäreingängen, meldet der myGEKKO sie über seine
Schnittstelle oft nicht einzeln (siehe oben). Der Hub kann sie dann **direkt am KNX-Bus mithören** –
am myGEKKO vorbei, ohne dort etwas zu ändern.

**Was es braucht:** eine **KNX IP-Schnittstelle** oder einen **KNX IP-Router** im Heimnetz (oft schon
vorhanden, z. B. für die ETS oder den myGEKKO). Der Hub hört nur mit und fragt Zustände ab
(GroupValue_Read); er **schaltet nichts** auf dem Bus. Mit KNX Secure verschlüsselte Telegramme kann
er nicht lesen.

**In der App:** Einstellungen › Geräte & Dienste › **KNX-Bus**

1. „KNX verwenden“ einschalten.
2. **Verbindungsart:**
   - **IP-Schnittstelle (Tunnel)** – geht mit jeder Schnittstelle und jedem Router. Adresse eintragen
     oder **Im Netz suchen**. Der Hub belegt eine der Verbindungen („Tunnel“) der Schnittstelle; sind
     alle belegt (z. B. durch myGEKKO und ETS), meldet er das.
   - **IP-Router (Routing)** – nur mit einem KNX IP-Router: Der Hub hört die Telegramme im Netz mit,
     ohne eine Verbindung zu belegen.
3. **Verbindung testen**, **Speichern**.
4. **Kontakt suchen:** Fenster öffnen und offen lassen – die Gruppenadresse, die dabei umspringt,
   erscheint. „Das ist es“ antippen, den **Raum** wählen – einen bestehenden oder „Neuer Raum …“
   (mit Bereich, z. B. Erdgeschoss; er erscheint dann unter Räume) –, **Übernehmen**, **Speichern**.
   Ein **Name** ist freiwillig: ohne heißt der Kontakt nach Art und Raum, z. B. „Fenster Küche“
   (bei mehreren „Fenster Küche 2“ …).
   Kennst du die Gruppenadressen (aus der ETS oder der Konfiguration des myGEKKO), geht es auch
   **von Hand**.

**Gut zu wissen:**

- Beim Verbinden fragt der Hub jeden Kontakt nach seinem Zustand. Antwortet einer nicht (im
  Binäreingang ist das „Lesen“-Flag nicht gesetzt), zeigt die App ihn erst nach der ersten Änderung.
- **Umgekehrt:** Manche Binäreingänge senden 0 für offen. „Kontakt suchen“ erkennt das, wenn das
  Fenster beim Antippen offen steht; sonst den Schalter „Umgekehrt“ setzen.
- Die KNX-Kontakte erscheinen wie alle anderen unter **Sicherheit**, in ihren Räumen und unter
  **Zutritt** (Türen); im Raum-Editor lassen sie sich umbenennen und verschieben.
- Die mitgehörten Telegramme sieht nur, wer Administrator ist, und sie bleiben nur im Speicher des
  Hubs (die letzten 400).

---

## DoorBird-Türstationen

**In der DoorBird-App vorbereiten**

1. **Einstellungen › Administration** (mit den Administrator-Zugangsdaten vom „Digital Passport“
   anmelden) › **Benutzer › Hinzufügen**.
2. Dem neuen Benutzer diese **Berechtigungen** geben: „Immer ansehen“, „Verlauf“, „Bewegung“ und
   **„API-Operator“**. Ohne „API-Operator“ kann der Hub nicht auf die Türstation zugreifen.
3. Benutzername (z. B. `abcdef0001`) und Passwort notieren.
4. Der Türstation im Router eine **feste IP-Adresse** zuweisen.

**In der App:** Türstationen (DoorBird) › Türstation hinzufügen › Name, Adresse, Benutzer, Passwort ›
Verbindung testen › Übernehmen › einschalten › Speichern. Für die zweite Türstation genauso.

Sobald die Türstation verbunden ist, kannst du in ihren Einstellungen die **Türöffner benennen**
(„Haustür“, „Garagentor“) und einzelne **ausblenden**, die niemand aus der App schalten soll.

**Was du bekommst:** Live-Video, Gegensprechen, Türöffner mit Schiebe-Bestätigung, Licht,
Klingel-Meldung in der geöffneten App und der **Verlauf**: Der Hub hält jedes Klingeln, jede
Bewegung und jede Türöffnung mit Bild fest und ergänzt beim Start, was die Türstation selbst noch im
Speicher hat. Die Bilder liegen verschlüsselt auf dem Hub und werden nach 90 Tagen gelöscht
(einstellbar).

Gut zu wissen: Eine Türstation erlaubt nur **ein Gespräch zur selben Zeit**. Spricht gerade jemand
über die DoorBird-App, kann der Hub nicht sprechen – und umgekehrt.

---

## Reolink-Kameras

**In der Reolink-App (oder im Browser auf der Kamera) vorbereiten**

1. **Einstellungen › Netzwerk › Erweitert › Server-Einstellungen:** „HTTPS“ (oder „HTTP“) und
   **„RTSP“** einschalten. Bei neueren Kameras sind sie ab Werk aus.
2. Empfohlen: unter **Benutzerverwaltung** einen eigenen Benutzer für den Hub anlegen. Zum
   Schwenken, für Licht und Sirene braucht er Administratorrechte.
3. Der Kamera im Router eine **feste IP-Adresse** zuweisen.

**In der App:** Kameras › Kamera hinzufügen › Name, Adresse, Benutzer, Passwort, Verbindungsart
„Reolink“ › Verbindung testen › Übernehmen › einschalten › Speichern.

- **Rekorder (NVR) oder Home Hub von Reolink:** dessen Adresse eintragen und unter „Erweitert“ je
  Kamera den **Kanal** wählen (beginnend bei 0) – also pro Kamera ein Eintrag mit derselben Adresse.
- **Akku-Kameras** ohne dauerhafte Netzwerkverbindung (Argus-Reihe u. ä.) bieten keinen Live-Zugriff
  im Heimnetz und funktionieren nur über einen Reolink Home Hub/NVR.

**Was du bekommst:** Live-Video in zwei Qualitäten (HD/SD – unterwegs spart SD Datenvolumen),
Schwenken/Neigen/Zoom und gespeicherte Positionen (bei Kameras, die das können), Mithören,
Scheinwerfer, Sirene.

**Gegensprechen** funktioniert bei Kameras mit Lautsprecher, die Zwei-Wege-Audio über RTSP anbieten
(das sind die meisten aktuellen Modelle mit Lautsprecher). Die App zeigt die Sprechtaste nur, wenn
die Kamera einen Lautsprecher meldet. Bleibt es trotz Taste stumm, unterstützt das Modell diesen Weg
nicht – der Rest funktioniert davon unabhängig.

Bei Bildaussetzern: in den Einstellungen der Kamera unter „Erweitert“ die Videoübertragung von RTSP
auf **FLV** umstellen (dann ohne Gegensprechen).

### Kameras ohne HTTP/HTTPS (E1 Pro und andere E1-Modelle)

Manche Modelle zeigen unter **Server-Einstellungen** nur „Basisdienste“, „RTSP“ und „ONVIF“ – ohne
HTTP oder HTTPS. Für sie gibt es die Verbindungsart **„ONVIF + RTSP“**:

1. In der Reolink-App unter **Einstellungen › Netzwerk › Erweitert › Server-Einstellungen**
   **„RTSP“** (Port 554) und **„ONVIF“** (Port 8000) einschalten.
2. Unter **Einstellungen › System › Datum & Uhrzeit** die automatische Zeit (NTP) eingeschaltet
   lassen – ONVIF-Anmeldungen enthalten einen Zeitstempel. (Der Hub gleicht Abweichungen selbst aus,
   eine richtig gehende Uhr schadet trotzdem nicht.)
3. In der App beim Hinzufügen der Kamera die Verbindungsart **„ONVIF + RTSP“** wählen, Adresse,
   Benutzer (z. B. admin) und Passwort eintragen, **Verbindung testen**. Andere Ports trägst du
   unter „Erweitert“ ein.

**Was dann geht:** Live-Video in HD/SD, Mithören, Schwenken/Neigen (und Zoom, wo vorhanden),
gespeicherte Positionen. Die Video-Adressen fragt der Hub per ONVIF bei der Kamera ab.

**Was so nicht geht:** Licht und Sirene (ONVIF kennt keinen Befehl dafür). **Gegensprechen** nur,
wenn die Kamera über RTSP einen Rückkanal für ihren Lautsprecher anbietet – der Verbindungstest
sagt, ob das der Fall ist. Die E1-Modelle tun das nach unserem Kenntnisstand nicht; Sprechen geht
dann weiterhin nur in der Reolink-App.

Den Port „Basisdienste“ (9000) braucht der Hub nicht; er gehört zum herstellereigenen Protokoll der
Reolink-App.

---

## Hikvision-Kameras

Hikvision-Kameras (und Kameras an einem Hikvision-Rekorder) steuert der Hub über **ISAPI** – die
Schnittstelle hinter der Weboberfläche der Kamera, mit Digest-Anmeldung – und holt das Bild über
**RTSP**. Beides ist ab Werk eingeschaltet.

**In der Weboberfläche der Kamera vorbereiten** (im Browser die IP-Adresse der Kamera öffnen;
die Menünamen können je nach Firmware leicht abweichen)

1. **Konfiguration › System › Benutzerverwaltung:** einen eigenen Benutzer für den Hub anlegen,
   z. B. als „Bediener“ mit den Rechten **Live-Ansicht**, **PTZ-Steuerung** und **Zweiwege-Audio**.
   Den Administrator brauchst du dafür nicht.
2. **Video/Audio › Video:** für Ton im Live-Bild beim Haupt- **und** beim Substream den Stream-Typ
   **„Video&Audio“** wählen. Wer H.265 im Hauptstream hat: Die App weicht in Browsern, die H.265 nicht
   können, auf den Substream (H.264) aus. H.264+/H.265+ besser ausschalten.
3. **Video/Audio › Audio:** für das Gegensprechen die Audiokodierung **„G.711ulaw“** (oder
   „G.711alaw“) einstellen – nur diese Kodierung kommt aus der App bis zum Lautsprecher.
4. **Netzwerk › Grundeinstellungen › Port:** HTTP 80, RTSP 554 (Standard). Gegensprechen braucht HTTP,
   auch wenn die Steuerung über HTTPS läuft.
5. Der Kamera im Router eine **feste IP-Adresse** zuweisen.

> **Achtung, Anmeldesperre:** Hikvision sperrt nach einigen falschen Passwörtern die Anmeldung von
> dieser Adresse für bis zu 30 Minuten – dann geht auch das Live-Bild nicht. Der Hub probiert es nach
> einer Ablehnung deshalb erst nach einer Pause wieder (5 Minuten, danach jeweils doppelt so lange,
> höchstens eine Stunde) und wartet eine gemeldete Sperre ab. Speichern mit neuem Passwort probiert
> sofort.

**In der App:** Kameras › Kamera hinzufügen › Name, Adresse, Benutzer, Passwort, Verbindungsart
**„Hikvision“** › Verbindung testen › Übernehmen › einschalten › Speichern. Der Test sagt, was die
Kamera kann und was ggf. noch umzustellen ist (Ton, Audiokodierung, RTSP).

- **Rekorder (NVR):** dessen Adresse eintragen und unter „Erweitert“ die **Kamera am Rekorder**
  wählen (D1 = 1, D2 = 2 …) – pro Kamera ein Eintrag mit derselben Adresse. Gegensprechen geht über
  den Rekorder nicht; dafür die Kamera direkt mit ihrer eigenen Adresse eintragen.
- **HTTPS:** unter „Erweitert“ einschaltbar; andere Ports ebenfalls dort.

**Was du bekommst:** Live-Video in HD/SD, Mithören, Schwenken/Neigen/Zoom (auch das Motorobjektiv
fester Kameras) und gespeicherte Positionen bei Kameras, die das können, Standbilder direkt von der
Kamera, Gegensprechen bei Kameras mit Lautsprecher (G.711).

**Was so nicht geht:** Weißlicht und Sirene/Blinklicht. Das Weißlicht der ColorVu-Kameras leuchtet
nur bei Dunkelheit und lässt sich nicht gezielt einschalten; die Abschreckung (Sirene, Rot-Blau-Licht)
ist je Modell anders gelöst. Lichter des Hauses kannst du der Kamera aber auf ihrer Seite in der App
zuordnen und dort schalten.

### Funktionen je Kamera ein- und ausschalten (alle Kameras)

Im Formular jeder Kamera stehen unter **Funktionen in der App** zwei Schalter: **Schwenken & Zoom**
(Steuerkreuz, Zoom und gespeicherte Positionen) und **Gegensprechen**. Ausgeschaltet verschwinden die
Bedienelemente auf der Kameraseite, und der Hub lehnt solche Befehle auch selbst ab.

Darunter steht, ob die Kamera das überhaupt kann. Das prüft der Hub bei **Verbindung testen** – und
beim **Hinzufügen** einer neuen Kamera von selbst, sobald du **Übernehmen** tippst. Was die Kamera nicht
kann, wird ausgeschaltet und lässt sich nicht einschalten (warum, sagt der Verbindungstest, z. B.
„Audiokodierung auf G.711 stellen“). Ist die Kamera beim Hinzufügen nicht erreichbar, bleibt das
Formular mit dem Ergebnis offen; **Trotzdem übernehmen** trägt sie dennoch ein.

---

## Govee-Lichter (LED-Streifen und Lampen)

Govee-Lichter steuert der Hub auf zwei Wegen, die sich ergänzen:

- **Im Heimnetz (LAN)** – für Lichter, bei denen in der Govee-App die **LAN-Steuerung** eingeschaltet
  ist. Der Hub spricht sie direkt an (UDP, Ports 4001–4003): schnell, ohne Cloud, ohne Limit.
- **Über die Govee-Cloud** mit deinem **API-Key** – für alle übrigen Lichter, und damit die Namen aus
  der Govee-App erscheinen.

**In der Govee Home App vorbereiten**

1. Beim Licht oben rechts das **Zahnrad** öffnen und **„LAN-Steuerung“** einschalten (sofern das Modell
   es anbietet – viele LED-Streifen können es).
2. Für die Cloud: **Profil › Einstellungen (Zahnrad) › API-Key beantragen**. Govee schickt den Key per
   E-Mail.
3. Tipp: Den Raum in den Namen schreiben („Wohnzimmer LED-Streifen“) – dann ordnet der Hub das Licht
   dem Raum zu. Sonst unter **Räume › Bearbeiten**.

**In der App:** Lichtstreifen (Govee) › einschalten › API-Key eintragen › **Testen** › Speichern. Der Test
zeigt jedes Licht und ob es im Heimnetz oder nur über die Cloud erreicht wird.

- **Ohne API-Key** erscheinen nur Lichter mit LAN-Steuerung, mit der Modellnummer als Namen
  (umbenennen unter Räume › Bearbeiten).
- **Andere Netze (VLAN):** Die Suche erreicht nur Lichter im selben Netz. Lichter anderswo trägst du
  unter „Adressen der Lichter“ mit ihrer IP-Adresse ein (feste IP im Router vergeben).
- **Docker:** Der Hub braucht dafür `network_mode: host` (so ist die mitgelieferte
  `docker-compose.yml` eingestellt) und Port 4002 auf dem Hub für sich – läuft dort schon eine andere
  Govee-Steuerung (z. B. Home Assistant), meldet der Hub das und nimmt für alle Lichter die Cloud.

**Was du bekommst:** Ein/Aus, Helligkeit, Farbe und Weißton (Farbtemperatur) – in der Licht-Übersicht,
in den Räumen, in Zeitschaltuhren, in der Licht-Überwachung und als Licht an einer Kamera.

**Datenschutz und Limit:** Befehle an Lichter ohne LAN-Steuerung gehen über die Server von Govee.
Govee erlaubt 10 000 Anfragen pro Tag; der Hub fragt den Zustand solcher Lichter deshalb nur alle paar
Minuten ab (öfter, solange eine App offen ist), fasst schnelle Änderungen am Farbrad zusammen und
pausiert, wenn Govee ablehnt. Lichter im Heimnetz kosten keine Anfrage.

**Nicht enthalten:** Szenen/Effekte und einzelne Segmente eines Streifens.

---

## Sonos-Lautsprecher

**In der Sonos-App vorbereiten**

1. **Konto › Datenschutz & Sicherheit › UPnP** muss eingeschaltet sein (ist es ab Werk). Darüber
   steuert der Hub die Lautsprecher im Heimnetz.
2. Für Musik von Spotify: Spotify in der Sonos-App als Musikdienst hinzufügen (falls noch nicht geschehen).

**In der App:** Lautsprecher (Sonos) › einschalten › Speichern. Der Hub findet die Lautsprecher von
selbst, wenn er im selben Netz hängt. Findet er nichts (getrennte Netze/VLANs), trägst du die
IP-Adresse **eines** Lautsprechers ein – die übrigen ergeben sich daraus.

**Was du bekommst:** alle Räume mit dem, was gerade läuft; Play/Pause/Weiter, Lautstärke je Raum und
je Gruppe, Räume gruppieren und trennen, deine Sonos-Favoriten.

---

## Spotify

Spotify verlangt, dass jede Anwendung als „App“ registriert ist. Das machst du einmalig selbst –
kostenlos, in fünf Minuten. Voraussetzung ist ein **Spotify-Premium-Konto** und dass der Hub über
**https** erreichbar ist (siehe [FERNZUGRIFF.md](FERNZUGRIFF.md)).

1. In der App **Geräte & Dienste › Spotify** öffnen. Dort steht die **Redirect-Adresse** deines Hubs
   zum Kopieren.
2. Auf <https://developer.spotify.com/dashboard> mit deinem Spotify-Konto anmelden › **Create app**.
   - Name und Beschreibung: beliebig (z. B. „Home Hub“)
   - **Redirect URIs:** die kopierte Adresse einfügen
   - **Which API/SDKs are you planning to use:** „Web API“
3. In der neuen App unter **Settings** die **Client ID** kopieren und in Home Hub einfügen
   (ein „Client Secret“ wird nicht gebraucht) › einschalten › Speichern.
4. **Mit Spotify verbinden** antippen, bei Spotify anmelden und zustimmen.

Sollen weitere Spotify-Konten (Familienmitglieder) verknüpft werden können, müssen sie im
Spotify-Dashboard unter **User Management** eingetragen sein. Für den Normalfall – ein Konto für das
Haus – ist nichts weiter nötig.

**Was du bekommst:** Suche, deine Playlists, Alben, Lieblingssongs, zuletzt Gehörtes und Podcasts –
abspielbar auf jedem Lautsprecher bzw. jeder Gruppe. Die Musik selbst läuft direkt vom Lautsprecher
über dessen eigene Spotify-Anbindung; der Hub sagt ihm nur, was er spielen soll.

Gut zu wissen: Spotify verlangt etwa **alle sechs Monate**, die Verbindung zu erneuern. Die App
meldet das rechtzeitig unter Geräte & Dienste; ein Tipp auf „Mit Spotify verbinden“ genügt.

---

## Checkliste für den ersten Einsatz an echten Geräten

Die App wurde gegen Simulatoren entwickelt, die das dokumentierte Verhalten der Geräte nachbilden.
Echte Geräte halten sich nicht immer an ihre Dokumentation. Prüfe deshalb beim ersten Einsatz Schritt
für Schritt – und schau bei Abweichungen unter **Mehr › Diagnose** nach, dort steht je Gerät, was der
Hub sieht:

**myGEKKO**
- [ ] Verbindung testen meldet die erwartete Zahl an Lichtern, Jalousien, Raumreglern.
- [ ] Ein Licht schalten und dimmen; eine Jalousie auf eine Position fahren und stoppen.
- [ ] Sollwert eines Raumreglers ändern; prüfen, ob er am myGEKKO ankommt.
- [ ] Eine Aktion/Szene starten.
- [ ] Fensterkontakte: Zeigt **Sicherheit** „alles zu“ bzw. „offen“ passend zur Hülle? Erscheinen die einzelnen Kontakte (ggf. nach zweimaligem Öffnen), und stimmt „offen/geschlossen“?
- [ ] Wird der Zustand der Alarmanlage („Hülle“) richtig angezeigt (scharf/unscharf, etwas offen)?

**KNX**
- [ ] Verbindung testen meldet „Verbunden“ (Tunnel) bzw. hört Telegramme (Routing).
- [ ] Kontakt suchen: Beim Öffnen eines Fensters erscheint genau eine Gruppenadresse mit 0 → 1 (oder 1 → 0).
- [ ] Nach dem Speichern: Stimmt „offen/zu“ für jeden Kontakt, auch nach einem Neustart des Hubs
      (Zustand wird abgefragt)? Erscheint ein Kontakt erst nach der ersten Änderung, fehlt im
      Binäreingang das „Lesen“-Flag.

**DoorBird**
- [ ] Live-Bild erscheint; Gegensprechen in beide Richtungen verständlich.
- [ ] Türöffner: Öffnet das **richtige** Relais? (Zuerst mit einem Relais testen, an dem nichts hängt,
      oder bei offener Tür.)
- [ ] Klingeln: Erscheint die Meldung in der geöffneten App? Steht das Ereignis mit Bild im Verlauf?

**Reolink**
- [ ] Live-Bild in HD und SD; Schwenken stoppt beim Loslassen.
- [ ] Gespeicherte Positionen, Scheinwerfer, Sirene (kurz!).
- [ ] Gegensprechen, sofern die Kamera einen Lautsprecher hat.
- [ ] Kameras über „ONVIF + RTSP“ (E1 Pro): Schwenkrichtungen stimmen (links ist links, oben ist oben),
      Bewegung stoppt beim Loslassen, Positionen werden angefahren, Standbild in der Übersicht erscheint.

**Hikvision**
- [ ] Verbindung testen nennt Modell und Firmware und keine offenen Hinweise (Ton, Audiokodierung).
- [ ] Live-Bild in HD und SD, mit Ton.
- [ ] Schwenken/Zoomen: Richtungen stimmen, Bewegung stoppt beim Loslassen; Positionen werden angefahren.
- [ ] Gegensprechen, sofern die Kamera einen Lautsprecher hat.
- [ ] Standbild in der Übersicht erscheint.

**Govee**
- [ ] Testen zeigt alle Lichter; die mit LAN-Steuerung stehen als „im Heimnetz“ da.
- [ ] Ein/Aus, Helligkeit, Farbe und Weißton wirken – auch bei einem Licht nur über die Cloud.
- [ ] Nach einem Neustart des Hubs stimmen die Zustände (an/aus, Farbe).

**Sonos & Spotify**
- [ ] Alle Lautsprecher erscheinen; Lautstärke und Play/Pause wirken.
- [ ] Zwei Räume gruppieren und wieder trennen.
- [ ] Einen Sonos-Favoriten starten.
- [ ] Einen Titel, ein Album und eine Playlist aus Spotify starten. (Der Hub probiert selbst aus,
      unter welcher Region dein Spotify-Konto bei Sonos geführt wird, und merkt sich das.) Startet
      trotzdem nichts: Ist Spotify in der Sonos-App als Musikdienst verbunden?

**Von unterwegs** (Mobilfunk statt WLAN)
- [ ] Anmelden, Licht schalten, Live-Bild, Gegensprechen.

### Was nur echte Geräte beantworten können

Diese Punkte ließen sich aus Dokumentation und Fremdsoftware nicht sicher ableiten. Der Hub ist so
gebaut, dass er mit den plausiblen Varianten zurechtkommt – ob es bei dir stimmt, zeigt der Test.

**myGEKKO**
- Ob dein myGEKKO https anbietet oder nur http (der Hub erkennt es selbst).
- Kontakte über Logiken: Angenommen wird „Ausgang ≠ 0 = offen“. Ist ein Kontakt verkehrt herum,
  stellst du ihn um (siehe oben).
- Raumregler melden ihren Fensterkontakt erst sinnvoll, wenn wirklich einer angeschlossen ist; der
  Hub zeigt „Fenster ‹Raum›“ deshalb erst, nachdem es einmal offen war.
- Über myGEKKO Plus (Cloud): wie viele Abfragen pro Minute erlaubt sind. Bremst der Dienst, pausiert
  der Hub jeweils einige Minuten.
- Sehr alte Firmware: Die Solltemperatur lässt sich dort nicht verstellen.

**DoorBird**
- Anmeldeverfahren: Der Hub versucht das sicherere Verfahren (Digest) und weicht einmalig auf das
  einfache (Basic) aus, wenn die Türstation das erste ablehnt. Welches benutzt wird, steht in der Diagnose.
- Ab wie vielen Fehlversuchen die Türstation ein Konto sperrt, ist nicht dokumentiert; der Hub macht
  nach einer Ablehnung fünf bis dreißig Minuten Pause.
- Die Uhr der Türstation sollte stimmen (Internetzeit), sonst erscheint ein Klingeln im Verlauf doppelt.
- Sonderzeichen im Passwort können beim Gegensprechen Probleme machen; mit Buchstaben und Ziffern
  bist du auf der sicheren Seite.

**Reolink**
- Manche neuere Firmware verlangt eine verschlüsselte Anmeldung, die der Hub nicht beherrscht. Der
  Verbindungstest meldet das als abgelehnte Anmeldung trotz richtigem Passwort.
- Gegensprechen hängt vom Modell ab (siehe oben).
- Nach einer abgelehnten Anmeldung wartet der Hub fünf Minuten, damit die Kamera das Konto nicht sperrt.

**Sonos**
- Heimkino-Sets, Stereopaare und Geräte der älteren S1-Generation sollten wie ein Raum erscheinen –
  bitte prüfen, ob jeder Raum genau einmal auftaucht.
- Fernseher-Ton, Line-In und AirPlay werden angezeigt; steuern lässt sich dort nur Lautstärke und Stopp.

**Spotify**
- Titellisten fremder Playlists gibt Spotify neuen Apps nicht mehr preis; abspielen lassen sie sich
  trotzdem als Ganzes.
