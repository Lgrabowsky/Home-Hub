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
Szenen), Zeitschaltuhren, Wetterwerte, der Zustand der Alarmanlage – jeweils mit den Namen und
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
  Garagentor-Taster), legst du am myGEKKO besser als Aktion an und startest diese aus der App.
- **Gesperrte Jalousien** (z. B. Windalarm) zeigt die App als gesperrt; Befehle lehnt der myGEKKO dann ab.
- **Stockwerke:** Unter **Geräte & Dienste › Allgemein › Stockwerke** legst du fest, welcher Raum auf
  welchem Stockwerk liegt; die App gruppiert Räume und Menüs danach. Ohne diese Angabe erkennt sie
  Stockwerke an Raumnamen wie „EG Küche“ oder „OG Bad“. Kontakte, die am myGEKKO auf einer eigenen
  Seite liegen („Türen und Fenster“), erscheinen in dem Raum, der in ihrem Namen vorkommt
  („Fenster Küche“ → Küche).

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

**Wenn die Kontakte nur in der Alarmanlage hängen** und sonst nirgends einzeln vorkommen, kann der Hub
sie nicht einzeln zeigen – die App meldet dann ehrlich „mindestens ein Kontakt ist offen“. Abhilfe am
myGEKKO (reine Konfiguration, keine neue Verdrahtung): den Eingang des Kontakts zusätzlich einer
**Logik** zuführen, die nach dem Fenster benannt ist (z. B. „Fenster Küche“), oder ihn als
Fensterkontakt des **Raumreglers** eintragen. Danach erscheint er in der App von selbst.

**Nur falls nötig: von Hand zuordnen.** Unter Gebäude (myGEKKO) › Fenster- & Türkontakte › „Von Hand
zuordnen“ kannst du einen Kontakt umbenennen, einem Raum zuweisen oder mit **Kontakt suchen** ergänzen
(Fenster öffnen, der Hub zeigt, welcher Wert reagiert). Für den Normalfall ist das nicht nötig.

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

**In der App:** Kameras (Reolink) › Kamera hinzufügen › Name, Adresse, Benutzer, Passwort ›
Verbindung testen › Übernehmen › einschalten › Speichern.

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
